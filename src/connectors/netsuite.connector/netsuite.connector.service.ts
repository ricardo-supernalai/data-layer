import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  NetSuiteCredentials,
  NetSuiteRecordType,
  NetSuiteSession,
  StoredNetSuiteRecord,
  SuiteQlResponse,
  SuiteQlRow,
} from './dtos/netsuite.connector.dto';

const TABLE = 'netsuite_records';

/**
 * Read bridge into NetSuite over SuiteQL (REST), authenticated with
 * Token-Based Authentication (OAuth 1.0a, HMAC-SHA256). Transactions,
 * customers and items are mirrored into the Vault under the read-only role
 * assigned to the token. Each query runs independently — a permission gap on
 * one record family is logged and skipped rather than sinking the sync.
 */
@Injectable()
export class NetSuiteConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'netsuite';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(NetSuiteConnectorService.name);

  /** SuiteQL per record family and how rows map onto the unified table. */
  private static readonly QUERIES: ReadonlyArray<{
    recordType: NetSuiteRecordType;
    sql: string;
    title: (row: SuiteQlRow) => string | null;
    amount: (row: SuiteQlRow) => number | null;
    status: (row: SuiteQlRow) => string | null;
    updatedAt: (row: SuiteQlRow) => string | null;
  }> = [
    {
      recordType: 'transaction',
      sql: 'SELECT id, tranid, type, trandate, foreigntotal, status FROM transaction ORDER BY id DESC',
      title: (r) => [r.type, r.tranid].filter(Boolean).join(' ') || null,
      amount: (r) => toNumber(r.foreigntotal),
      status: (r) => toText(r.status),
      updatedAt: (r) => toText(r.trandate),
    },
    {
      recordType: 'customer',
      sql: 'SELECT id, entityid, companyname, email FROM customer ORDER BY id DESC',
      title: (r) => toText(r.companyname) ?? toText(r.entityid),
      amount: () => null,
      status: () => null,
      updatedAt: () => null,
    },
    {
      recordType: 'item',
      sql: 'SELECT id, itemid, displayname, itemtype FROM item ORDER BY id DESC',
      title: (r) => toText(r.displayname) ?? toText(r.itemid),
      amount: () => null,
      status: () => null,
      updatedAt: () => null,
    },
  ];

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
  }

  async saveOAuthCredentials(
    credentials: NetSuiteCredentials,
  ): Promise<boolean> {
    return this.saveCredentials(credentials);
  }

  async getSession(): Promise<NetSuiteSession> {
    const credentials = await this.loadCredentials<NetSuiteCredentials>();
    const connected = Boolean(
      credentials?.account_id &&
      credentials?.consumer_key &&
      credentials?.consumer_secret &&
      credentials?.token_id &&
      credentials?.token_secret,
    );

    return {
      connected,
      // TBA tokens don't expire; each request is signed fresh.
      expired: false,
      expires_at: null,
      scope: null,
      token_type: connected ? 'OAuth 1.0' : null,
      has_refresh_token: false,
    };
  }

  protected async fetchPayload(): Promise<ConnectorSyncPayload> {
    const credentials = await this.requireCredentials();
    const batch = Number(
      this.config.get<string>('NETSUITE_SYNC_BATCH') ?? '50',
    );

    const fetched: StoredNetSuiteRecord[] = [];

    for (const spec of NetSuiteConnectorService.QUERIES) {
      try {
        const rows = await this.suiteQl(credentials, spec.sql, batch);
        const mapped = rows.map((row) => this.toStoredRecord(spec, row));
        fetched.push(...mapped);
        this.logger.log(
          `Fetched ${mapped.length} ${spec.recordType} row(s) from NetSuite.`,
        );
      } catch (err) {
        this.logger.warn(
          `Skipping ${spec.recordType}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      fetched.map((r) => r.id),
    );
    const newRows = fetched.filter((r) => !alreadyEmbedded.has(r.id));

    if (newRows.length === 0) {
      this.logger.log('No new NetSuite records to sync.');
      return { rawTable: TABLE, rawRows: [], conflictColumn: 'id', items: [] };
    }

    const items = newRows
      .map((r) => ({ text: this.embedText(r), data_id: r.id }))
      .filter((item) => item.text.length > 0);

    this.logger.log(
      `Prepared ${newRows.length} NetSuite record(s) (${items.length} embeddable) for atomic sync.`,
    );

    return {
      rawTable: TABLE,
      rawRows: newRows as unknown as Record<string, unknown>[],
      conflictColumn: 'id',
      items,
    };
  }

  async listRecords(
    limit = 100,
    recordType?: NetSuiteRecordType,
  ): Promise<StoredNetSuiteRecord[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let queryBuilder = this.supabase
        .from(TABLE)
        .select(
          'id, record_type, title, amount, status, properties, updated_at, synced_at',
        )
        .order('synced_at', { ascending: false })
        .limit(limit);

      if (recordType) {
        queryBuilder = queryBuilder.eq('record_type', recordType);
      }

      const { data, error } = await queryBuilder;

      if (!error) {
        return data ?? [];
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.ensureRawTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase read failed: ${error.message}`);
    }

    throw new Error(
      `Supabase read failed: ${TABLE} was created but is not available in the schema cache yet.`,
    );
  }

  async dataToPrompt(): Promise<string> {
    const limit = Number(
      this.config.get<string>('NETSUITE_PROMPT_LIMIT') ?? '20',
    );
    await this.requireCredentials();
    const records = await this.listRecords(limit);

    if (records.length === 0) {
      return 'No NetSuite records available.';
    }

    const blocks = records.map((r, i) => {
      const lines = [
        `${this.recordLabel(r.record_type)} ${i + 1}:`,
        `  Name: ${r.title ?? '(unnamed)'}`,
      ];
      if (r.amount != null) lines.push(`  Amount: ${r.amount}`);
      if (r.status) lines.push(`  Status: ${r.status}`);
      if (r.updated_at) lines.push(`  Date: ${r.updated_at}`);
      return lines.join('\n');
    });

    return [
      'The following are the most recently synced NetSuite records for this user.',
      'Entries cover transactions, customers and items.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  protected async ensureRawTable(): Promise<void> {
    await this.executeSupabaseSql(
      TABLE,
      `
create table if not exists public.${TABLE} (
  id text primary key,
  record_type text not null,
  title text,
  amount numeric,
  status text,
  properties jsonb,
  updated_at text,
  synced_at timestamptz not null default now()
);

create index if not exists ${TABLE}_record_type_idx on public.${TABLE} (record_type);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async requireCredentials(): Promise<NetSuiteCredentials> {
    const credentials = await this.loadCredentials<NetSuiteCredentials>();
    if (
      !credentials?.account_id ||
      !credentials.consumer_key ||
      !credentials.consumer_secret ||
      !credentials.token_id ||
      !credentials.token_secret
    ) {
      throw new Error(
        'No saved NetSuite credentials were found. Connect NetSuite in the frontend first.',
      );
    }
    return credentials;
  }

  private async suiteQl(
    credentials: NetSuiteCredentials,
    sql: string,
    limit: number,
  ): Promise<SuiteQlRow[]> {
    // Sandbox account ids use an underscore ("1234567_SB1") but the REST host
    // wants a hyphenated lowercase form ("1234567-sb1").
    const host = `${credentials.account_id!.toLowerCase().replace(/_/g, '-')}.suitetalk.api.netsuite.com`;
    const url = `https://${host}/services/rest/query/v1/suiteql?limit=${limit}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.oauth1Header('POST', url, credentials),
        'Content-Type': 'application/json',
        // SuiteQL requires this header on every request.
        Prefer: 'transient',
      },
      body: JSON.stringify({ q: sql }),
    });

    if (!res.ok) {
      throw new Error(
        `NetSuite SuiteQL ${res.status} for ${url}: ${await res.text()}`,
      );
    }

    const data = (await res.json()) as SuiteQlResponse;
    return data.items ?? [];
  }

  /**
   * Build the OAuth 1.0a Authorization header (HMAC-SHA256) NetSuite TBA
   * expects. JSON bodies are not part of the signature base string — only the
   * oauth_* parameters and the URL query string are signed.
   */
  private oauth1Header(
    method: string,
    url: string,
    credentials: NetSuiteCredentials,
  ): string {
    const parsed = new URL(url);
    const baseUrl = `${parsed.origin}${parsed.pathname}`;

    const oauthParams: Record<string, string> = {
      oauth_consumer_key: credentials.consumer_key!,
      oauth_nonce: randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA256',
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_token: credentials.token_id!,
      oauth_version: '1.0',
    };

    const allParams: [string, string][] = [
      ...Object.entries(oauthParams),
      ...Array.from(parsed.searchParams.entries()),
    ];
    const paramString = allParams
      .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
      .sort(([a, av], [b, bv]) =>
        a === b ? av.localeCompare(bv) : a.localeCompare(b),
      )
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const baseString = [
      method.toUpperCase(),
      percentEncode(baseUrl),
      percentEncode(paramString),
    ].join('&');

    const signingKey = `${percentEncode(credentials.consumer_secret!)}&${percentEncode(credentials.token_secret!)}`;
    const signature = createHmac('sha256', signingKey)
      .update(baseString)
      .digest('base64');

    const realm = credentials.account_id!.toUpperCase();
    const headerParams = {
      realm,
      ...oauthParams,
      oauth_signature: signature,
    };

    return (
      'OAuth ' +
      Object.entries(headerParams)
        .map(([k, v]) => `${k}="${percentEncode(v)}"`)
        .join(', ')
    );
  }

  private toStoredRecord(
    spec: (typeof NetSuiteConnectorService.QUERIES)[number],
    row: SuiteQlRow,
  ): StoredNetSuiteRecord {
    return {
      id: `${spec.recordType}:${String(row.id)}`,
      record_type: spec.recordType,
      title: spec.title(row),
      amount: spec.amount(row),
      status: spec.status(row),
      properties: row,
      updated_at: spec.updatedAt(row),
      synced_at: new Date().toISOString(),
    };
  }

  private embedText(r: StoredNetSuiteRecord): string {
    const lines: string[] = [
      `${this.recordLabel(r.record_type)}: ${r.title ?? '(unnamed)'}`,
    ];
    if (r.amount != null) lines.push(`amount: ${r.amount}`);
    if (r.status) lines.push(`status: ${r.status}`);
    if (r.updated_at) lines.push(`date: ${r.updated_at}`);

    const props = r.properties ?? {};
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === '') continue;
      if (['id', 'links', 'tranid', 'status', 'foreigntotal'].includes(k))
        continue;
      lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }

    return lines.join('\n').trim();
  }

  private recordLabel(recordType: NetSuiteRecordType): string {
    switch (recordType) {
      case 'transaction':
        return 'Transaction';
      case 'customer':
        return 'Customer';
      case 'item':
        return 'Item';
      default:
        return 'Record';
    }
  }
}

/** RFC 3986 percent-encoding, as required by the OAuth 1.0 signature spec. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toText(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null;
  return String(value);
}
