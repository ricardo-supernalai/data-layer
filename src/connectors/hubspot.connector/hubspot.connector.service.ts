import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  HubSpotCredentials,
  HubSpotCrmObject,
  HubSpotListResponse,
  HubSpotObjectType,
  HubSpotPipeline,
  HubSpotSession,
  HubSpotTokenResponse,
  StoredHubSpotRecord,
} from './dtos/hubspot.connector.dto';

const HUBSPOT_API = 'https://api.hubapi.com';
const HUBSPOT_TOKEN_URL = `${HUBSPOT_API}/oauth/v1/token`;
const TABLE = 'hubspot_records';

/**
 * Live read access to HubSpot CRM data — accounts (companies), deals, contacts
 * and deal pipelines. The mirrored records land in the shared Vault so this
 * data layer and the AI Client Services build both draw from one source of
 * truth instead of each integrating HubSpot independently.
 */
@Injectable()
export class HubSpotConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'hubspot';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(HubSpotConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  /**
   * CRM v3 object endpoints and the properties we read for each. Pipelines are
   * fetched separately because they use a different API shape.
   */
  private static readonly CRM_OBJECTS: ReadonlyArray<{
    objectType: Exclude<HubSpotObjectType, 'pipeline'>;
    path: string;
    properties: string[];
  }> = [
    {
      objectType: 'account',
      path: 'companies',
      properties: [
        'name',
        'domain',
        'industry',
        'numberofemployees',
        'annualrevenue',
        'city',
        'country',
        'lifecyclestage',
      ],
    },
    {
      objectType: 'deal',
      path: 'deals',
      properties: [
        'dealname',
        'amount',
        'dealstage',
        'pipeline',
        'closedate',
        'hs_deal_stage_probability',
        'hs_forecast_amount',
      ],
    },
    {
      objectType: 'contact',
      path: 'contacts',
      properties: [
        'firstname',
        'lastname',
        'email',
        'company',
        'jobtitle',
        'phone',
        'lifecyclestage',
      ],
    },
  ];

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
  }

  async saveOAuthCredentials(
    credentials: HubSpotCredentials,
  ): Promise<boolean> {
    const expiresAt =
      credentials.expires_at ??
      (credentials.expires_in
        ? Date.now() + (credentials.expires_in - 60) * 1000
        : undefined);

    return this.saveCredentials({
      ...credentials,
      expires_at: expiresAt,
    });
  }

  async exchangeAndSaveCode(
    code: string,
    redirectUri: string,
  ): Promise<boolean> {
    const clientId = this.config.get<string>('HUBSPOT_CLIENT_ID');
    const clientSecret = this.config.get<string>('HUBSPOT_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing HUBSPOT_CLIENT_ID or HUBSPOT_CLIENT_SECRET in the backend env.',
      );
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });

    const res = await fetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(
        `HubSpot token exchange failed: ${res.status} ${await res.text()}`,
      );
    }

    const tokens = (await res.json()) as HubSpotTokenResponse;

    return this.saveOAuthCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      client_id: clientId,
      client_secret: clientSecret,
    });
  }

  async getSession(): Promise<HubSpotSession> {
    const credentials = await this.loadCredentials<HubSpotCredentials>();
    const expiresAt =
      typeof credentials?.expires_at === 'number'
        ? credentials.expires_at
        : null;
    const hasRefresh = Boolean(credentials?.refresh_token);
    const connected = Boolean(credentials?.access_token || hasRefresh);
    const accessExpired = Boolean(expiresAt && Date.now() >= expiresAt);
    const expired = accessExpired && !hasRefresh;

    return {
      connected,
      expired,
      expires_at: expiresAt,
      scope: credentials?.scope ?? null,
      token_type: credentials?.token_type ?? null,
      has_refresh_token: hasRefresh,
    };
  }

  protected async fetchPayload(): Promise<ConnectorSyncPayload> {
    const token = await this.getAccessToken();
    const limit = Number(this.config.get<string>('HUBSPOT_SYNC_BATCH') ?? '50');

    const fetched: StoredHubSpotRecord[] = [];

    for (const spec of HubSpotConnectorService.CRM_OBJECTS) {
      const query = new URLSearchParams({
        limit: String(limit),
        properties: spec.properties.join(','),
        archived: 'false',
      });
      const list = await this.hubspotFetch<HubSpotListResponse<HubSpotCrmObject>>(
        `${HUBSPOT_API}/crm/v3/objects/${spec.path}?${query.toString()}`,
        token,
      );
      for (const obj of list.results ?? []) {
        fetched.push(this.crmObjectToRow(spec.objectType, obj));
      }
    }

    const pipelines = await this.hubspotFetch<
      HubSpotListResponse<HubSpotPipeline>
    >(`${HUBSPOT_API}/crm/v3/pipelines/deals`, token);
    for (const pipeline of pipelines.results ?? []) {
      fetched.push(this.pipelineToRow(pipeline));
    }

    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      fetched.map((r) => r.id),
    );
    const newRows = fetched.filter((r) => !alreadyEmbedded.has(r.id));

    if (newRows.length === 0) {
      this.logger.log('No new HubSpot records to sync.');
      return { rawTable: TABLE, rawRows: [], conflictColumn: 'id', items: [] };
    }

    const items = newRows
      .map((r) => ({ text: this.embedText(r), data_id: r.id }))
      .filter((item) => item.text.length > 0);

    this.logger.log(
      `Prepared ${newRows.length} HubSpot record(s) (${items.length} embeddable) for atomic sync.`,
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
    objectType?: HubSpotObjectType,
  ): Promise<StoredHubSpotRecord[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let queryBuilder = this.supabase
        .from(TABLE)
        .select(
          'id, object_type, hs_object_id, title, email, amount, stage, pipeline, properties, updated_at, synced_at',
        )
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (objectType) {
        queryBuilder = queryBuilder.eq('object_type', objectType);
      }

      const { data, error } = await queryBuilder;

      if (!error) {
        return (data ?? []) as StoredHubSpotRecord[];
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
      this.config.get<string>('HUBSPOT_PROMPT_LIMIT') ?? '20',
    );
    await this.getAccessToken();
    let records: StoredHubSpotRecord[] = [];
    let readSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'id, object_type, hs_object_id, title, email, amount, stage, pipeline, properties, updated_at, synced_at',
        )
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (!error) {
        records = (data ?? []) as StoredHubSpotRecord[];
        readSucceeded = true;
        break;
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.ensureRawTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase read failed: ${error.message}`);
    }

    if (!readSucceeded) {
      throw new Error(
        `Supabase read failed: ${TABLE} was created but is not available in the schema cache yet.`,
      );
    }

    if (records.length === 0) {
      return 'No HubSpot CRM records available.';
    }

    const blocks = records.map((r, i) => {
      const lines = [
        `${this.objectLabel(r.object_type)} ${i + 1}:`,
        `  Name: ${r.title ?? '(unnamed)'}`,
      ];
      if (r.email) lines.push(`  Email: ${r.email}`);
      if (r.amount != null) lines.push(`  Amount: ${r.amount}`);
      if (r.stage) lines.push(`  Stage: ${r.stage}`);
      if (r.pipeline) lines.push(`  Pipeline: ${r.pipeline}`);
      lines.push(`  Updated: ${r.updated_at ?? 'unknown'}`);
      return lines.join('\n');
    });

    return [
      'The following are the most recently updated HubSpot CRM records for this user.',
      'Entries cover accounts (companies), deals, contacts and deal pipelines.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const credentials = await this.loadCredentials<HubSpotCredentials>();

    if (!credentials?.access_token && !credentials?.refresh_token) {
      throw new Error(
        'No saved HubSpot credentials were found. Connect HubSpot in the frontend first.',
      );
    }

    const isExpired =
      credentials.expires_at && Date.now() >= credentials.expires_at;

    if (!isExpired && credentials.access_token) {
      this.accessToken = credentials.access_token;
      this.accessTokenExpiresAt =
        credentials.expires_at ?? Number.MAX_SAFE_INTEGER;
      return this.accessToken;
    }

    if (!credentials.refresh_token) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      throw new Error(
        'Saved HubSpot access token has expired and no refresh token is stored. Reconnect HubSpot in the frontend.',
      );
    }

    return this.refreshAccessToken(credentials);
  }

  private async refreshAccessToken(
    credentials: HubSpotCredentials,
  ): Promise<string> {
    const clientId =
      credentials.client_id ?? this.config.get<string>('HUBSPOT_CLIENT_ID');
    const clientSecret =
      credentials.client_secret ??
      this.config.get<string>('HUBSPOT_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing HUBSPOT_CLIENT_ID or HUBSPOT_CLIENT_SECRET to refresh HubSpot token.',
      );
    }

    if (!credentials.refresh_token) {
      throw new Error('Cannot refresh HubSpot token: no refresh_token saved.');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credentials.refresh_token,
    });

    const res = await fetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(
        `HubSpot token refresh failed: ${res.status} ${await res.text()}`,
      );
    }

    const tokens = (await res.json()) as HubSpotTokenResponse;
    const expiresAt = Date.now() + (tokens.expires_in - 60) * 1000;

    await this.saveCredentials({
      ...credentials,
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      expires_at: expiresAt,
      token_type: tokens.token_type ?? credentials.token_type,
      refresh_token: tokens.refresh_token ?? credentials.refresh_token,
    });

    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = expiresAt;
    this.logger.log(
      'Refreshed HubSpot access token using stored refresh_token.',
    );
    return tokens.access_token;
  }

  protected async ensureRawTable(): Promise<void> {
    await this.executeSupabaseSql(
      TABLE,
      `
create table if not exists public.${TABLE} (
  id text primary key,
  object_type text not null,
  hs_object_id text not null,
  title text,
  email text,
  amount numeric,
  stage text,
  pipeline text,
  properties jsonb,
  updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists ${TABLE}_object_type_idx on public.${TABLE} (object_type);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async hubspotFetch<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(
        `HubSpot API ${res.status} for ${url}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  private crmObjectToRow(
    objectType: Exclude<HubSpotObjectType, 'pipeline'>,
    obj: HubSpotCrmObject,
  ): StoredHubSpotRecord {
    const props = obj.properties ?? {};
    const amountRaw = props.amount;
    const amount =
      amountRaw != null && amountRaw !== '' && !Number.isNaN(Number(amountRaw))
        ? Number(amountRaw)
        : null;

    return {
      id: `${objectType}:${obj.id}`,
      object_type: objectType,
      hs_object_id: obj.id,
      title: this.crmTitle(objectType, props),
      email: objectType === 'contact' ? (props.email ?? null) : null,
      amount: objectType === 'deal' ? amount : null,
      stage: objectType === 'deal' ? (props.dealstage ?? null) : null,
      pipeline: objectType === 'deal' ? (props.pipeline ?? null) : null,
      properties: props as Record<string, unknown>,
      updated_at: obj.updatedAt ?? null,
      synced_at: new Date().toISOString(),
    };
  }

  private pipelineToRow(pipeline: HubSpotPipeline): StoredHubSpotRecord {
    return {
      id: `pipeline:${pipeline.id}`,
      object_type: 'pipeline',
      hs_object_id: pipeline.id,
      title: pipeline.label ?? null,
      email: null,
      amount: null,
      stage: null,
      pipeline: pipeline.label ?? pipeline.id,
      properties: {
        stages: (pipeline.stages ?? [])
          .slice()
          .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
          .map((s) => ({
            id: s.id,
            label: s.label,
            displayOrder: s.displayOrder,
          })),
      },
      updated_at: pipeline.updatedAt ?? null,
      synced_at: new Date().toISOString(),
    };
  }

  private crmTitle(
    objectType: Exclude<HubSpotObjectType, 'pipeline'>,
    props: Record<string, string | null>,
  ): string | null {
    switch (objectType) {
      case 'account':
        return props.name ?? props.domain ?? null;
      case 'deal':
        return props.dealname ?? null;
      case 'contact': {
        const name = [props.firstname, props.lastname]
          .filter((s): s is string => Boolean(s && s.trim()))
          .join(' ')
          .trim();
        return name || props.email || null;
      }
      default:
        return null;
    }
  }

  private embedText(r: StoredHubSpotRecord): string {
    const lines: string[] = [
      `${this.objectLabel(r.object_type)}: ${r.title ?? '(unnamed)'}`,
    ];
    if (r.email) lines.push(`email: ${r.email}`);
    if (r.amount != null) lines.push(`amount: ${r.amount}`);
    if (r.stage) lines.push(`stage: ${r.stage}`);
    if (r.pipeline) lines.push(`pipeline: ${r.pipeline}`);

    const props = r.properties ?? {};
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === '') continue;
      // amount/stage/pipeline are already surfaced above.
      if (['amount', 'dealstage', 'pipeline', 'email'].includes(k)) continue;
      lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }

    return lines.join('\n').trim();
  }

  private objectLabel(objectType: HubSpotObjectType): string {
    switch (objectType) {
      case 'account':
        return 'Account';
      case 'deal':
        return 'Deal';
      case 'contact':
        return 'Contact';
      case 'pipeline':
        return 'Pipeline';
      default:
        return 'Record';
    }
  }
}
