import { SupabaseClient } from '@supabase/supabase-js';
import {
  createSupabaseAuthedClient,
  supabase,
  supabaseAdmin,
  supabaseProjectUrl,
} from '../supabase-client';
import type { EmbeddingItem } from '../embeddings/dtos/embeddings.dto';
import { EmbeddingsService } from '../embeddings/embeddings.service';

const CONNECTOR_CREDENTIALS_TABLE = 'connector_credentials';
const MISSING_TABLE_ERROR_CODES = new Set(['42P01', 'PGRST205']);
const SCHEMA_RELOAD_DELAY_MS = 1_000;

export type ConnectorCredentialValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type ConnectorCredentials = Record<string, ConnectorCredentialValue>;

export type ConnectorSyncPayload = {
  /** Raw table the connector owns (e.g. 'gmail_messages'). */
  rawTable: string;
  /** Rows to upsert into the raw table. */
  rawRows: Record<string, unknown>[];
  /** Conflict column on the raw table (typically 'id'). */
  conflictColumn: string;
  /** Items to embed and upsert into <connector>_embeddings. */
  items: EmbeddingItem[];
};

export abstract class ConnectorInterface {
  protected supabase: SupabaseClient = supabase;
  protected abstract readonly connectorName: string;

  constructor(protected readonly embeddings: EmbeddingsService) {}

  abstract dataToPrompt(): Promise<string>;

  /**
   * Subclass hook for syncData. Fetch from the external API and BUILD the
   * payload — but do NOT write to the database here. The base passes the
   * payload to EmbeddingsService.syncWithEmbeddings, which embeds via OpenAI
   * and then writes raw rows + embeddings in a single Postgres transaction.
   *
   * Use this.getExistingEmbeddedIds(candidateIds) to skip items already
   * embedded so a previously-failed sync retries cleanly on the next run.
   *
   * Do NOT override syncData() directly — the base orchestrates the atomic
   * write and overriding it bypasses the transactional guarantee.
   */
  protected abstract fetchPayload(): Promise<ConnectorSyncPayload>;

  /** Create the connector-owned raw table if it doesn't exist. */
  protected abstract ensureRawTable(): Promise<void>;

  async syncData(): Promise<void> {
    const payload = await this.fetchPayload();
    if (payload.rawRows.length === 0 && payload.items.length === 0) return;

    await this.embeddings.syncWithEmbeddings({
      rawTable: payload.rawTable,
      rawRows: payload.rawRows,
      conflictColumn: payload.conflictColumn,
      embeddingsTable: this.embeddingsTableName,
      items: payload.items,
      ensureRawTable: () => this.ensureRawTable(),
    });
  }

  protected get embeddingsTableName(): string {
    return `${this.connectorName}_embeddings`;
  }

  /**
   * Subset of `candidateIds` that already have embeddings in this connector's
   * embeddings table. Connectors use this to skip work for items they've
   * already embedded.
   */
  protected async getExistingEmbeddedIds(
    candidateIds: string[],
  ): Promise<Set<string>> {
    return this.embeddings.getExistingEmbeddedIds(
      this.embeddingsTableName,
      candidateIds,
    );
  }

  protected authSupabase(accessToken: string): void {
    this.supabase = createSupabaseAuthedClient(accessToken);
  }

  async saveCredentials(credentials: ConnectorCredentials): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error } = await supabaseAdmin
        .from(CONNECTOR_CREDENTIALS_TABLE)
        .upsert(
          {
            connector: this.connectorName,
            credentials,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'connector' },
        );

      if (!error) {
        return true;
      }

      if (this.isMissingTableError(error, CONNECTOR_CREDENTIALS_TABLE)) {
        await this.createConnectorCredentialsTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(
        `Failed to save ${this.connectorName} credentials: ${error.message}`,
      );
    }

    throw new Error(
      `Failed to save ${this.connectorName} credentials: ${CONNECTOR_CREDENTIALS_TABLE} was created but is not available in the schema cache yet.`,
    );
  }

  protected async loadCredentials<
    TCredentials extends ConnectorCredentials,
  >(): Promise<TCredentials | null> {
    const { data, error } = await supabaseAdmin
      .from(CONNECTOR_CREDENTIALS_TABLE)
      .select('credentials')
      .eq('connector', this.connectorName)
      .maybeSingle();

    if (error) {
      if (this.isMissingTableError(error, CONNECTOR_CREDENTIALS_TABLE)) {
        return null;
      }

      throw new Error(
        `Failed to load ${this.connectorName} credentials: ${error.message}`,
      );
    }

    return (data?.credentials as TCredentials | undefined) ?? null;
  }

  protected isMissingTableError(
    error: {
      code?: string;
      message?: string;
    },
    tableName: string,
  ): boolean {
    return (
      (typeof error.code === 'string' &&
        MISSING_TABLE_ERROR_CODES.has(error.code)) ||
      error.message?.includes(
        `Could not find the table 'public.${tableName}'`,
      ) === true
    );
  }

  protected async executeSupabaseSql(
    label: string,
    query: string,
  ): Promise<void> {
    const projectRef = this.getSupabaseProjectRef();
    const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

    if (!accessToken) {
      throw new Error(
        `Failed to create ${label}: missing SUPABASE_ACCESS_TOKEN for the Supabase Management API.`,
      );
    }

    if (this.isSupabaseApiKey(accessToken)) {
      throw new Error(
        `Failed to create ${label}: SUPABASE_ACCESS_TOKEN must be a Supabase account access token, not the project anon/publishable API key.`,
      );
    }

    const response = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to create ${label}: Supabase SQL API returned ${response.status} ${await response.text()}`,
      );
    }
  }

  protected waitForSchemaReload(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, SCHEMA_RELOAD_DELAY_MS));
  }

  private async createConnectorCredentialsTable(): Promise<void> {
    await this.executeSupabaseSql(
      CONNECTOR_CREDENTIALS_TABLE,
      `
create table if not exists public.${CONNECTOR_CREDENTIALS_TABLE} (
  connector text primary key,
  credentials jsonb not null,
  updated_at timestamptz not null default now()
);

grant usage on schema public to service_role;
grant select, insert, update, delete on public.${CONNECTOR_CREDENTIALS_TABLE} to service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private getSupabaseProjectRef(): string {
    const configuredRef = process.env.SUPABASE_PROJECT_REF;
    if (configuredRef) {
      return configuredRef;
    }

    const host = new URL(supabaseProjectUrl).hostname;
    const [projectRef] = host.split('.');
    if (!projectRef) {
      throw new Error(
        'Failed to detect Supabase project ref. Set SUPABASE_PROJECT_REF in the environment.',
      );
    }

    return projectRef;
  }

  private isSupabaseApiKey(value: string): boolean {
    return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
  }
}
