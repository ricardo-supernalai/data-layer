import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  BcApiRow,
  BcCompany,
  BcListResponse,
  BusinessCentralCredentials,
  BusinessCentralEntity,
  BusinessCentralSession,
  MicrosoftTokenResponse,
  StoredBusinessCentralRecord,
} from './dtos/businesscentral.connector.dto';

const TABLE = 'businesscentral_records';

/**
 * Read-only mirror of Dynamics 365 Business Central (on-prem or cloud) into
 * the Vault — customers, vendors, items and sales invoices over the standard
 * API v2.0 / OData surface. On-prem deployments authenticate with a service
 * account + Web Service Access Key (basic auth); OAuth-enabled deployments
 * use an Entra ID app via the client-credentials grant. Each entity is
 * fetched independently so a permission gap on one doesn't sink the sync.
 */
@Injectable()
export class BusinessCentralConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'businesscentral';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(BusinessCentralConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  /** Entity endpoints and how their rows map onto the unified table. */
  private static readonly ENTITIES: ReadonlyArray<{
    entity: BusinessCentralEntity;
    path: string;
    title: (row: BcApiRow) => string | null;
    amount: (row: BcApiRow) => number | null;
  }> = [
    {
      entity: 'customer',
      path: 'customers',
      title: (r) => (r.displayName as string) ?? null,
      amount: () => null,
    },
    {
      entity: 'vendor',
      path: 'vendors',
      title: (r) => (r.displayName as string) ?? null,
      amount: () => null,
    },
    {
      entity: 'item',
      path: 'items',
      title: (r) => (r.displayName as string) ?? null,
      amount: (r) => toNumber(r.unitPrice),
    },
    {
      entity: 'sales_invoice',
      path: 'salesInvoices',
      title: (r) => (r.customerName as string) ?? (r.number as string) ?? null,
      amount: (r) => toNumber(r.totalAmountIncludingTax),
    },
  ];

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
  }

  async saveOAuthCredentials(
    credentials: BusinessCentralCredentials,
  ): Promise<boolean> {
    return this.saveCredentials(credentials);
  }

  async getSession(): Promise<BusinessCentralSession> {
    const credentials =
      await this.loadCredentials<BusinessCentralCredentials>();
    const hasBasic = Boolean(
      credentials?.username && credentials?.web_service_access_key,
    );
    const hasOAuth = Boolean(
      credentials?.client_id &&
      credentials?.client_secret &&
      credentials?.tenant_id,
    );
    const connected = Boolean(credentials?.base_url) && (hasBasic || hasOAuth);

    return {
      connected,
      // Web Service Access Keys don't expire; client-credentials tokens are
      // re-minted on demand, so a saved connection never goes stale.
      expired: false,
      expires_at: null,
      scope: null,
      token_type: connected ? (hasBasic ? 'Basic' : 'Bearer') : null,
      has_refresh_token: false,
    };
  }

  protected async fetchPayload(): Promise<ConnectorSyncPayload> {
    const credentials = await this.requireCredentials();
    const batch = Number(
      this.config.get<string>('BUSINESSCENTRAL_SYNC_BATCH') ?? '50',
    );

    const baseUrl = credentials.base_url!.replace(/\/+$/, '');
    const companyId = await this.resolveCompanyId(baseUrl, credentials);

    const fetched: StoredBusinessCentralRecord[] = [];

    for (const spec of BusinessCentralConnectorService.ENTITIES) {
      try {
        const url = `${baseUrl}/companies(${companyId})/${spec.path}?$top=${batch}`;
        const list = await this.bcFetch<BcListResponse<BcApiRow>>(
          url,
          credentials,
        );
        const rows = (list.value ?? []).map((row) =>
          this.toStoredRecord(spec, row),
        );
        fetched.push(...rows);
        this.logger.log(`Fetched ${rows.length} ${spec.path} row(s).`);
      } catch (err) {
        this.logger.warn(
          `Skipping ${spec.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      fetched.map((r) => r.id),
    );
    const newRows = fetched.filter((r) => !alreadyEmbedded.has(r.id));

    if (newRows.length === 0) {
      this.logger.log('No new Business Central records to sync.');
      return { rawTable: TABLE, rawRows: [], conflictColumn: 'id', items: [] };
    }

    const items = newRows
      .map((r) => ({ text: this.embedText(r), data_id: r.id }))
      .filter((item) => item.text.length > 0);

    this.logger.log(
      `Prepared ${newRows.length} Business Central record(s) (${items.length} embeddable) for atomic sync.`,
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
    entity?: BusinessCentralEntity,
  ): Promise<StoredBusinessCentralRecord[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let queryBuilder = this.supabase
        .from(TABLE)
        .select(
          'id, entity, title, number, amount, status, properties, updated_at, synced_at',
        )
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (entity) {
        queryBuilder = queryBuilder.eq('entity', entity);
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
      this.config.get<string>('BUSINESSCENTRAL_PROMPT_LIMIT') ?? '20',
    );
    await this.requireCredentials();
    const records = await this.listRecords(limit);

    if (records.length === 0) {
      return 'No Business Central records available.';
    }

    const blocks = records.map((r, i) => {
      const lines = [
        `${this.entityLabel(r.entity)} ${i + 1}:`,
        `  Name: ${r.title ?? '(unnamed)'}`,
      ];
      if (r.number) lines.push(`  Number: ${r.number}`);
      if (r.amount != null) lines.push(`  Amount: ${r.amount}`);
      if (r.status) lines.push(`  Status: ${r.status}`);
      lines.push(`  Updated: ${r.updated_at ?? 'unknown'}`);
      return lines.join('\n');
    });

    return [
      'The following are the most recently updated Business Central records for this user.',
      'Entries cover customers, vendors, items and sales invoices.',
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
  entity text not null,
  title text,
  number text,
  amount numeric,
  status text,
  properties jsonb,
  updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists ${TABLE}_entity_idx on public.${TABLE} (entity);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async requireCredentials(): Promise<BusinessCentralCredentials> {
    const credentials =
      await this.loadCredentials<BusinessCentralCredentials>();
    const hasBasic = Boolean(
      credentials?.username && credentials?.web_service_access_key,
    );
    const hasOAuth = Boolean(
      credentials?.client_id &&
      credentials?.client_secret &&
      credentials?.tenant_id,
    );

    if (!credentials?.base_url || (!hasBasic && !hasOAuth)) {
      throw new Error(
        'No saved Business Central credentials were found. Connect Business Central in the frontend first.',
      );
    }

    return credentials;
  }

  private async resolveCompanyId(
    baseUrl: string,
    credentials: BusinessCentralCredentials,
  ): Promise<string> {
    const configured = credentials.company_id?.trim();
    // A GUID can be used directly in companies(...) without a lookup.
    if (configured && /^[0-9a-f-]{36}$/i.test(configured)) {
      return configured;
    }

    const list = await this.bcFetch<BcListResponse<BcCompany>>(
      `${baseUrl}/companies`,
      credentials,
    );
    const companies = list.value ?? [];
    if (companies.length === 0) {
      throw new Error('Business Central returned no companies.');
    }

    if (configured) {
      const match = companies.find(
        (c) =>
          c.name?.toLowerCase() === configured.toLowerCase() ||
          c.displayName?.toLowerCase() === configured.toLowerCase(),
      );
      if (!match) {
        throw new Error(
          `Business Central company "${configured}" was not found.`,
        );
      }
      return match.id;
    }

    return companies[0].id;
  }

  private async bcFetch<T>(
    url: string,
    credentials: BusinessCentralCredentials,
  ): Promise<T> {
    const res = await fetch(url, {
      headers: {
        Authorization: await this.authHeader(credentials),
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(
        `Business Central API ${res.status} for ${url}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  private async authHeader(
    credentials: BusinessCentralCredentials,
  ): Promise<string> {
    if (credentials.username && credentials.web_service_access_key) {
      const basic = Buffer.from(
        `${credentials.username}:${credentials.web_service_access_key}`,
      ).toString('base64');
      return `Basic ${basic}`;
    }
    return `Bearer ${await this.getAccessToken(credentials)}`;
  }

  private async getAccessToken(
    credentials: BusinessCentralCredentials,
  ): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.client_id!,
      client_secret: credentials.client_secret!,
      scope: 'https://api.businesscentral.dynamics.com/.default',
    });

    const res = await fetch(
      `https://login.microsoftonline.com/${credentials.tenant_id}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );

    if (!res.ok) {
      throw new Error(
        `Business Central token request failed: ${res.status} ${await res.text()}`,
      );
    }

    const tokens = (await res.json()) as MicrosoftTokenResponse;
    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = Date.now() + (tokens.expires_in - 60) * 1000;
    return this.accessToken;
  }

  private toStoredRecord(
    spec: (typeof BusinessCentralConnectorService.ENTITIES)[number],
    row: BcApiRow,
  ): StoredBusinessCentralRecord {
    const rawId = row.id ?? row.number ?? JSON.stringify(row).slice(0, 64);
    return {
      id: `${spec.entity}:${String(rawId)}`,
      entity: spec.entity,
      title: spec.title(row),
      number: (row.number as string) ?? null,
      amount: spec.amount(row),
      status: (row.status as string) ?? null,
      properties: row,
      updated_at: row.lastModifiedDateTime ?? null,
      synced_at: new Date().toISOString(),
    };
  }

  private embedText(r: StoredBusinessCentralRecord): string {
    const lines: string[] = [
      `${this.entityLabel(r.entity)}: ${r.title ?? '(unnamed)'}`,
    ];
    if (r.number) lines.push(`number: ${r.number}`);
    if (r.amount != null) lines.push(`amount: ${r.amount}`);
    if (r.status) lines.push(`status: ${r.status}`);

    const props = r.properties ?? {};
    for (const [k, v] of Object.entries(props)) {
      if (
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
      ) {
        continue;
      }
      if (v === '') continue;
      if (['id', 'number', 'status', 'displayName'].includes(k)) continue;
      lines.push(`${k}: ${String(v)}`);
    }

    return lines.join('\n').trim();
  }

  private entityLabel(entity: BusinessCentralEntity): string {
    switch (entity) {
      case 'customer':
        return 'Customer';
      case 'vendor':
        return 'Vendor';
      case 'item':
        return 'Item';
      case 'sales_invoice':
        return 'Sales invoice';
      default:
        return 'Record';
    }
  }
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
