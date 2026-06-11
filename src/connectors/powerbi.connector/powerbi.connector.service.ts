import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  MicrosoftTokenResponse,
  PowerBICredentials,
  PowerBIDashboard,
  PowerBIDataset,
  PowerBIItemType,
  PowerBIListResponse,
  PowerBIReport,
  PowerBISession,
  StoredPowerBIItem,
} from './dtos/powerbi.connector.dto';

const POWERBI_API = 'https://api.powerbi.com/v1.0/myorg';
const POWERBI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
const TABLE = 'powerbi_items';

/**
 * Read-only mirror of Power BI workspace contents — reports, datasets and
 * dashboards — into the Vault, so leadership dashboards are discoverable as
 * agent context. Authenticates as an Entra ID service principal (client
 * credentials); the principal must be a Viewer on each configured workspace.
 * Each workspace and item kind is fetched independently so a permission gap
 * on one doesn't sink the sync.
 */
@Injectable()
export class PowerBIConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'powerbi';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(PowerBIConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
  }

  async saveOAuthCredentials(
    credentials: PowerBICredentials,
  ): Promise<boolean> {
    return this.saveCredentials(credentials);
  }

  async getSession(): Promise<PowerBISession> {
    const credentials = await this.loadCredentials<PowerBICredentials>();
    const connected = Boolean(
      credentials?.client_id &&
      credentials?.client_secret &&
      credentials?.tenant_id &&
      credentials?.workspace_ids,
    );

    return {
      connected,
      // Client-credentials tokens are re-minted on demand, so a saved
      // connection never goes stale.
      expired: false,
      expires_at: null,
      scope: connected ? POWERBI_SCOPE : null,
      token_type: connected ? 'Bearer' : null,
      has_refresh_token: false,
    };
  }

  protected async fetchPayload(): Promise<ConnectorSyncPayload> {
    const credentials = await this.requireCredentials();
    const token = await this.getAccessToken(credentials);

    const workspaceIds = credentials
      .workspace_ids!.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const fetched: StoredPowerBIItem[] = [];

    for (const workspaceId of workspaceIds) {
      await this.collect(`reports in ${workspaceId}`, fetched, async () => {
        const list = await this.pbiFetch<PowerBIListResponse<PowerBIReport>>(
          `${POWERBI_API}/groups/${workspaceId}/reports`,
          token,
        );
        return (list.value ?? []).map((r) => ({
          id: `report:${r.id}`,
          workspace_id: workspaceId,
          item_type: 'report' as const,
          name: r.name ?? null,
          web_url: r.webUrl ?? null,
          dataset_id: r.datasetId ?? null,
          properties: r,
          synced_at: new Date().toISOString(),
        }));
      });

      await this.collect(`datasets in ${workspaceId}`, fetched, async () => {
        const list = await this.pbiFetch<PowerBIListResponse<PowerBIDataset>>(
          `${POWERBI_API}/groups/${workspaceId}/datasets`,
          token,
        );
        return (list.value ?? []).map((d) => ({
          id: `dataset:${d.id}`,
          workspace_id: workspaceId,
          item_type: 'dataset' as const,
          name: d.name ?? null,
          web_url: d.webUrl ?? null,
          dataset_id: null,
          properties: d,
          synced_at: new Date().toISOString(),
        }));
      });

      await this.collect(`dashboards in ${workspaceId}`, fetched, async () => {
        const list = await this.pbiFetch<PowerBIListResponse<PowerBIDashboard>>(
          `${POWERBI_API}/groups/${workspaceId}/dashboards`,
          token,
        );
        return (list.value ?? []).map((d) => ({
          id: `dashboard:${d.id}`,
          workspace_id: workspaceId,
          item_type: 'dashboard' as const,
          name: d.displayName ?? null,
          web_url: d.webUrl ?? null,
          dataset_id: null,
          properties: d,
          synced_at: new Date().toISOString(),
        }));
      });
    }

    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      fetched.map((r) => r.id),
    );
    const newRows = fetched.filter((r) => !alreadyEmbedded.has(r.id));

    if (newRows.length === 0) {
      this.logger.log('No new Power BI items to sync.');
      return { rawTable: TABLE, rawRows: [], conflictColumn: 'id', items: [] };
    }

    const items = newRows
      .map((r) => ({ text: this.embedText(r), data_id: r.id }))
      .filter((item) => item.text.length > 0);

    this.logger.log(
      `Prepared ${newRows.length} Power BI item(s) (${items.length} embeddable) for atomic sync.`,
    );

    return {
      rawTable: TABLE,
      rawRows: newRows as unknown as Record<string, unknown>[],
      conflictColumn: 'id',
      items,
    };
  }

  async listItems(
    limit = 100,
    itemType?: PowerBIItemType,
  ): Promise<StoredPowerBIItem[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let queryBuilder = this.supabase
        .from(TABLE)
        .select(
          'id, workspace_id, item_type, name, web_url, dataset_id, properties, synced_at',
        )
        .order('synced_at', { ascending: false })
        .limit(limit);

      if (itemType) {
        queryBuilder = queryBuilder.eq('item_type', itemType);
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
      this.config.get<string>('POWERBI_PROMPT_LIMIT') ?? '20',
    );
    await this.requireCredentials();
    const items = await this.listItems(limit);

    if (items.length === 0) {
      return 'No Power BI items available.';
    }

    const blocks = items.map((item, i) => {
      const lines = [
        `${this.itemLabel(item.item_type)} ${i + 1}:`,
        `  Name: ${item.name ?? '(unnamed)'}`,
        `  Workspace: ${item.workspace_id}`,
      ];
      if (item.web_url) lines.push(`  URL: ${item.web_url}`);
      return lines.join('\n');
    });

    return [
      'The following are the Power BI reports, datasets and dashboards available to this user.',
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
  workspace_id text not null,
  item_type text not null,
  name text,
  web_url text,
  dataset_id text,
  properties jsonb,
  synced_at timestamptz not null default now()
);

create index if not exists ${TABLE}_item_type_idx on public.${TABLE} (item_type);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async collect(
    label: string,
    sink: StoredPowerBIItem[],
    fetcher: () => Promise<StoredPowerBIItem[]>,
  ): Promise<void> {
    try {
      const rows = await fetcher();
      sink.push(...rows);
      this.logger.log(`Fetched ${rows.length} ${label}.`);
    } catch (err) {
      this.logger.warn(
        `Skipping ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async requireCredentials(): Promise<PowerBICredentials> {
    const credentials = await this.loadCredentials<PowerBICredentials>();
    if (
      !credentials?.client_id ||
      !credentials.client_secret ||
      !credentials.tenant_id ||
      !credentials.workspace_ids
    ) {
      throw new Error(
        'No saved Power BI credentials were found. Connect Power BI in the frontend first.',
      );
    }
    return credentials;
  }

  private async getAccessToken(
    credentials: PowerBICredentials,
  ): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.client_id!,
      client_secret: credentials.client_secret!,
      scope: POWERBI_SCOPE,
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
        `Power BI token request failed: ${res.status} ${await res.text()}`,
      );
    }

    const tokens = (await res.json()) as MicrosoftTokenResponse;
    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = Date.now() + (tokens.expires_in - 60) * 1000;
    return this.accessToken;
  }

  private async pbiFetch<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Power BI API ${res.status} for ${url}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  private embedText(item: StoredPowerBIItem): string {
    const lines: string[] = [
      `${this.itemLabel(item.item_type)}: ${item.name ?? '(unnamed)'}`,
      `workspace: ${item.workspace_id}`,
    ];
    if (item.web_url) lines.push(`url: ${item.web_url}`);
    return lines.join('\n').trim();
  }

  private itemLabel(itemType: PowerBIItemType): string {
    switch (itemType) {
      case 'report':
        return 'Report';
      case 'dataset':
        return 'Dataset';
      case 'dashboard':
        return 'Dashboard';
      default:
        return 'Item';
    }
  }
}
