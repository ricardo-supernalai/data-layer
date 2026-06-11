import { SupabaseClient } from '@supabase/supabase-js';
import {
  createSupabaseAuthedClient,
  executeSupabaseManagementSql,
  supabaseAdmin,
} from '../supabase-client';
import type { EmbeddingItem } from '../embeddings/dtos/embeddings.dto';
import { EmbeddingsService } from '../embeddings/embeddings.service';

const CONNECTOR_CREDENTIALS_TABLE = 'connector_credentials';
const MISSING_TABLE_ERROR_CODES = new Set(['42P01', 'PGRST205']);
// PGRST002: PostgREST is up but can't query the DB for its schema cache yet
// (typically still reloading after a `notify pgrst, 'reload schema'`, or a cold
// start). Transient — retry rather than fail.
const SCHEMA_CACHE_RELOADING_ERROR_CODE = 'PGRST002';
const SCHEMA_RELOAD_DELAY_MS = 1_000;
const SCHEMA_RELOAD_MAX_DELAY_MS = 8_000;
const SAVE_CREDENTIALS_MAX_ATTEMPTS = 5;

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
  /**
   * Backend data-plane client. Defaults to the service-role client so the
   * trusted backend can read/write its tables regardless of row-level security
   * (RLS bypasses for service_role). RLS + role policies still govern any
   * direct access made with the anon/publishable key or a user JWT. Call
   * {@link authSupabase} to swap in a user-scoped client when you want a read
   * to be subject to the caller's RLS policies instead.
   */
  protected supabase: SupabaseClient = supabaseAdmin;
  protected abstract readonly connectorName: string;
  /** Connector-owned raw table (e.g. 'gmail_messages'). */
  protected abstract readonly rawTableName: string;
  /** PK column of the raw table used to join back from embedding matches. */
  protected readonly rawIdColumn: string = 'id';

  constructor(protected readonly embeddings: EmbeddingsService) {}

  /** Public identifier of this connector (e.g. 'gmail'). Mirrors connectorName. */
  get name(): string {
    return this.connectorName;
  }

  /**
   * Public name of the Supabase table this connector reads from (e.g.
   * 'gmail_messages'). Used by role-based access control to decide whether a
   * caller may pull data from this connector.
   */
  get table(): string {
    return this.rawTableName;
  }

  /**
   * Whether the connector currently has usable credentials saved.
   * Default rule:
   *   - access_token must be present
   *   - if expires_at is set and in the past, only "connected" if a refresh_token exists
   *   - if expires_at is absent, treat token as long-lived (e.g. Slack bot tokens)
   * Subclasses can override for stricter checks.
   */
  async isConnected(): Promise<boolean> {
    const creds = await this.loadCredentials<
      ConnectorCredentials & {
        access_token?: string;
        refresh_token?: string;
        expires_at?: number;
      }
    >();
    if (!creds?.access_token) return false;

    if (
      typeof creds.expires_at === 'number' &&
      Date.now() >= creds.expires_at
    ) {
      return Boolean(creds.refresh_token);
    }
    return true;
  }

  /**
   * Render a single raw-table row for inclusion in a system prompt. Default
   * dumps non-empty key:value pairs, skipping internal bookkeeping columns.
   * Subclasses can override to strip noise (e.g. HTML email bodies).
   */
  formatRowForPrompt(row: Record<string, unknown>): string {
    const skip = new Set(['synced_at', 'embedding']);
    return Object.entries(row)
      .filter(([k, v]) => !skip.has(k) && v != null && v !== '')
      .map(
        ([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
      )
      .join('\n');
  }

  abstract dataToPrompt(): Promise<string>;

  /**
   * Fetch the top-k raw rows most relevant to the query, using the connector's
   * embeddings table for semantic search.
   *
   * Process: search the embeddings table for the best matches, dedupe by
   * `data_id` (so multiple chunks of the same source row collapse to one
   * result), then look up the matching rows in the raw table and return them
   * in similarity order.
   */
  async getRelevantData(
    query: string,
    limit = 5,
  ): Promise<Record<string, unknown>[]> {
    if (limit <= 0) return [];

    // Oversample: a single source row can produce multiple embedding chunks,
    // so we need to fetch more matches than `limit` to end up with `limit`
    // distinct data_ids in the worst case.
    const matches = await this.embeddings.search(
      query,
      this.embeddingsTableName,
      limit * 4,
    );

    // Take the best (first-seen) match per data_id, preserving similarity order.
    const order: string[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      if (seen.has(m.data_id)) continue;
      seen.add(m.data_id);
      order.push(m.data_id);
      if (order.length >= limit) break;
    }

    if (order.length === 0) return [];

    const { data, error } = await this.supabase
      .from(this.rawTableName)
      .select('*')
      .in(this.rawIdColumn, order);

    if (error) {
      throw new Error(
        `Failed to fetch relevant rows from ${this.rawTableName}: ${error.message}`,
      );
    }

    // .in() doesn't preserve input order, so re-sort by similarity rank.
    const byId = new Map<string, Record<string, unknown>>(
      (data ?? []).map((row: Record<string, unknown>) => [
        String(row[this.rawIdColumn]),
        row,
      ]),
    );
    return order
      .map((id) => byId.get(id))
      .filter((row): row is Record<string, unknown> => row !== undefined);
  }

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
    for (
      let attempt = 0;
      attempt < SAVE_CREDENTIALS_MAX_ATTEMPTS;
      attempt += 1
    ) {
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
        await this.waitForSchemaReload(attempt);
        continue;
      }

      // The table exists but PostgREST is still reloading its schema cache
      // (common immediately after we create the table above). Back off and
      // retry instead of failing the request.
      if (this.isSchemaCacheReloadingError(error)) {
        await this.waitForSchemaReload(attempt);
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

  protected isSchemaCacheReloadingError(error: {
    code?: string;
    message?: string;
  }): boolean {
    return (
      error.code === SCHEMA_CACHE_RELOADING_ERROR_CODE ||
      error.message?.includes(
        'Could not query the database for the schema cache',
      ) === true
    );
  }

  protected async executeSupabaseSql(
    label: string,
    query: string,
  ): Promise<void> {
    // Shared helper handles token validation plus retry/backoff on transient
    // Management API failures (network errors, 429/5xx).
    await executeSupabaseManagementSql(label, query);
  }

  protected waitForSchemaReload(attempt = 0): Promise<void> {
    const delay = Math.min(
      SCHEMA_RELOAD_DELAY_MS * 2 ** attempt,
      SCHEMA_RELOAD_MAX_DELAY_MS,
    );
    return new Promise((resolve) => setTimeout(resolve, delay));
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
}
