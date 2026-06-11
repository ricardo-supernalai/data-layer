import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseProjectUrl, supabaseAdmin } from '../supabase-client';
import type { EmbeddingItem, SearchMatch } from './dtos/embeddings.dto';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 3072;
const MISSING_TABLE_ERROR_CODES = new Set(['42P01', 'PGRST205', '42704']);
const MISSING_FUNCTION_ERROR_CODES = new Set(['42883', 'PGRST202']);
// PGRST002: PostgREST is up but can't query the DB for its schema cache yet
// (typically still reloading after a `notify pgrst, 'reload schema'`, or a cold
// start). Transient — retry rather than fail.
const SCHEMA_CACHE_RELOADING_ERROR_CODE = 'PGRST002';
const SCHEMA_RELOAD_DELAY_MS = 1_000;
const SCHEMA_RELOAD_MAX_DELAY_MS = 8_000;
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const SYNC_FN_NAME = 'sync_with_embeddings';
/**
 * Target chunk size in characters. text-embedding-3-large caps each input at
 * 8192 tokens. Char-per-token varies wildly by content:
 *   - English prose:  ~4   chars/token
 *   - Code:           ~3   chars/token
 *   - HTML markup:    ~2   chars/token  (lots of single-char tokens: < > / =)
 *   - CJK:            ~1   chars/token
 * We size for ~1.5 chars/token to stay safe across all but pure CJK content:
 * 12000 chars ≈ 8000 tokens worst-case (HTML), ≈ 3000 tokens prose.
 * For best behavior on HTML, callers should strip tags before passing text in.
 */
const MAX_CHARS_PER_CHUNK = 12_000;
const CHUNK_OVERLAP_CHARS = 300;

type OpenAIEmbeddingResponse = {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
};

export type SyncWithEmbeddingsInput = {
  /** Connector-owned raw table (e.g. 'gmail_messages'). */
  rawTable: string;
  /** Rows to upsert into the raw table. Empty array allowed. */
  rawRows: Record<string, unknown>[];
  /** Conflict column on the raw table (typically 'id'). */
  conflictColumn: string;
  /** Per-connector embeddings table (e.g. 'gmail_embeddings'). */
  embeddingsTable: string;
  /** Items to embed and upsert into the embeddings table. Empty array allowed. */
  items: EmbeddingItem[];
  /** Subclass-provided callback to create the raw table if it doesn't exist. */
  ensureRawTable: () => Promise<void>;
};

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  // Service-role client: embedding writes (sync_with_embeddings) and vector
  // search run as the trusted backend, bypassing RLS. RLS + role policies still
  // protect the embeddings tables against direct anon/JWT access.
  private readonly supabase: SupabaseClient = supabaseAdmin;

  constructor(private readonly config: ConfigService) {}

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedMany([text]);
    return vector;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error(
        'Missing OPENAI_API_KEY. Add it to .env (or .ENV) in the project root.',
      );
    }

    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text();
      const isTokenOverflow =
        res.status === 400 && bodyText.includes('max_tokens_per_request');

      if (isTokenOverflow && texts.length > 1) {
        const mid = Math.floor(texts.length / 2);
        this.logger.warn(
          `OpenAI embeddings token overflow with ${texts.length} inputs; splitting into ${mid} + ${texts.length - mid} and retrying.`,
        );
        const left = await this.embedMany(texts.slice(0, mid));
        const right = await this.embedMany(texts.slice(mid));
        return [...left, ...right];
      }

      if (isTokenOverflow && texts.length === 1) {
        throw new Error(
          `OpenAI embeddings request failed: a single input exceeds the 300k-token per-request limit (length=${texts[0].length} chars). Reduce upstream content cap or split the source text further. Original: ${bodyText}`,
        );
      }

      throw new Error(
        `OpenAI embeddings request failed: ${res.status} ${bodyText}`,
      );
    }

    const body = (await res.json()) as OpenAIEmbeddingResponse;
    return body.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  async storeEmbeddings(
    items: EmbeddingItem[],
    tableName: string,
  ): Promise<void> {
    this.logger.log(`Storing ${items.length} embeddings in table "${tableName}"...`);
    if (items.length === 0) return;

    const table = this.requireTableName(tableName);
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.data_id)) {
        throw new Error(
          `storeEmbeddings: duplicate data_id "${it.data_id}" in the same batch. Deduplicate before calling.`,
        );
      }
      seen.add(it.data_id);
    }

    const expanded = this.expandIntoChunks(items);
    const vectors = await this.embedMany(expanded.map((e) => e.text));
    const now = new Date().toISOString();
    const rows = expanded.map((e, i) => ({
      data_id: e.data_id,
      chunk_index: e.chunk_index,
      content: e.text,
      embedding: this.toPgVector(vectors[i]),
      updated_at: now,
    }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { error } = await this.supabase
        .from(table)
        .upsert(rows, { onConflict: 'data_id,chunk_index' });

      if (!error) {
        return;
      }

      if (this.isMissingTableError(error, table)) {
        await this.createEmbeddingsArtifacts(table);
        await this.waitForSchemaReload(attempt);
        continue;
      }

      if (this.isSchemaCacheReloadingError(error)) {
        await this.waitForSchemaReload(attempt);
        continue;
      }

      throw new Error(`Supabase upsert failed for ${table}: ${error.message}`);
    }

    throw new Error(
      `Supabase upsert failed: ${table} was created but is not available in the schema cache yet.`,
    );
  }

  async search(
    query: string,
    tableName: string,
    matchCount = 10,
  ): Promise<SearchMatch[]> {
    const table = this.requireTableName(tableName);
    const [vector] = await this.embedMany([query]);
    const fn = this.matchFnName(table);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data, error } = await this.supabase.rpc(fn, {
        query_embedding: this.toPgVector(vector),
        match_count: matchCount,
      });

      if (!error) {
        return (data ?? []) as SearchMatch[];
      }

      if (
        this.isMissingTableError(error, table) ||
        this.isMissingFunctionError(error, fn)
      ) {
        await this.createEmbeddingsArtifacts(table);
        await this.waitForSchemaReload(attempt);
        continue;
      }

      if (this.isSchemaCacheReloadingError(error)) {
        await this.waitForSchemaReload(attempt);
        continue;
      }

      throw new Error(`Supabase search failed for ${fn}: ${error.message}`);
    }

    throw new Error(
      `Supabase search failed: ${fn} was created but is not available in the schema cache yet.`,
    );
  }

  /**
   * Atomic equivalent of "raw upsert + embedding upsert" wrapped in a single
   * Postgres transaction (via the sync_with_embeddings plpgsql function).
   * Either both writes succeed or neither does — the Mongoose-session analogue.
   *
   * Note: the OpenAI call happens BEFORE the transaction. If OpenAI fails,
   * nothing is written. If OpenAI succeeds but the DB transaction fails, you
   * pay for the embeddings but no rows land in either table.
   */
  async syncWithEmbeddings(input: SyncWithEmbeddingsInput): Promise<void> {
    if (input.rawRows.length === 0 && input.items.length === 0) return;

    const rawTable = this.requireTableName(input.rawTable);
    const embeddingsTable = this.requireTableName(input.embeddingsTable);
    if (!TABLE_NAME_PATTERN.test(input.conflictColumn)) {
      throw new Error(
        `Invalid conflictColumn "${input.conflictColumn}". Use lowercase letters, digits, and underscores.`,
      );
    }

    const seen = new Set<string>();
    for (const it of input.items) {
      if (seen.has(it.data_id)) {
        throw new Error(
          `syncWithEmbeddings: duplicate data_id "${it.data_id}" in the same batch. Deduplicate before calling.`,
        );
      }
      seen.add(it.data_id);
    }

    const expanded = this.expandIntoChunks(input.items);
    const vectors = await this.embedMany(expanded.map((e) => e.text));
    const now = new Date().toISOString();
    const embeddingRows = expanded.map((e, i) => ({
      data_id: e.data_id,
      chunk_index: e.chunk_index,
      content: e.text,
      embedding: this.toPgVector(vectors[i]),
      updated_at: now,
    }));

    this.logger.log(
      `Atomic sync: ${input.rawRows.length} row(s) → ${rawTable}, ` +
        `${input.items.length} item(s) → ${embeddingRows.length} chunk(s) → ${embeddingsTable}`,
    );

    let ensuredSyncFn = false;
    let ensuredEmbeddings = false;
    let ensuredRaw = false;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { error } = await this.supabase.rpc(SYNC_FN_NAME, {
        p_raw_table: rawTable,
        p_raw_rows: input.rawRows,
        p_raw_conflict: input.conflictColumn,
        p_embeddings_table: embeddingsTable,
        p_embedding_rows: embeddingRows,
      });

      if (!error) return;

      if (!ensuredSyncFn && this.isMissingFunctionError(error, SYNC_FN_NAME)) {
        await this.createSyncFunction();
        await this.waitForSchemaReload(attempt);
        ensuredSyncFn = true;
        continue;
      }

      if (
        !ensuredEmbeddings &&
        this.isMissingNamedTableError(error, embeddingsTable)
      ) {
        await this.createEmbeddingsArtifacts(embeddingsTable);
        await this.waitForSchemaReload(attempt);
        ensuredEmbeddings = true;
        continue;
      }

      if (!ensuredRaw && this.isMissingNamedTableError(error, rawTable)) {
        await input.ensureRawTable();
        await this.waitForSchemaReload(attempt);
        ensuredRaw = true;
        continue;
      }

      // Artifacts exist but PostgREST is still reloading its schema cache after
      // one of the create steps above. Back off and retry.
      if (this.isSchemaCacheReloadingError(error)) {
        await this.waitForSchemaReload(attempt);
        continue;
      }

      throw new Error(`Atomic sync failed: ${error.message}`);
    }

    throw new Error(
      'Atomic sync failed after creating missing artifacts. Check Supabase logs.',
    );
  }

  /**
   * Returns the subset of `candidateIds` that already have an embedding row in
   * `embeddingsTable`. Used by connectors to skip work for items they've already
   * embedded (so a failed sync retries cleanly on the next run).
   */
  async getExistingEmbeddedIds(
    embeddingsTable: string,
    candidateIds: string[],
  ): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const table = this.requireTableName(embeddingsTable);

    // PostgREST encodes `.in()` as a query string (`?data_id=in.(...)`), so a
    // single call with thousands of ids exceeds the server's URL length limit
    // and is rejected before reaching Postgres. Chunk the lookup to stay well
    // under that limit.
    const CHUNK = 200;
    const found = new Set<string>();

    for (let i = 0; i < candidateIds.length; i += CHUNK) {
      const chunk = candidateIds.slice(i, i + CHUNK);
      const { data, error } = await this.supabase
        .from(table)
        .select('data_id')
        .in('data_id', chunk);

      if (error) {
        if (this.isMissingTableError(error, table)) {
          return new Set();
        }
        const detail =
          [error.message, error.code, error.details, error.hint]
            .filter(Boolean)
            .join(' | ') || JSON.stringify(error);
        throw new Error(
          `Failed to read existing embedding ids from ${table}: ${detail}`,
        );
      }

      for (const r of (data ?? []) as { data_id: string }[]) {
        found.add(r.data_id);
      }
    }

    return found;
  }

  private async createSyncFunction(): Promise<void> {
    this.logger.log(`Creating ${SYNC_FN_NAME} plpgsql function...`);
    await this.executeSupabaseSql(
      `${SYNC_FN_NAME} function`,
      `
create or replace function public.${SYNC_FN_NAME}(
  p_raw_table text,
  p_raw_rows jsonb,
  p_raw_conflict text,
  p_embeddings_table text,
  p_embedding_rows jsonb
) returns void
language plpgsql
as $fn$
declare
  raw_cols text;
  raw_update text;
begin
  if jsonb_array_length(p_raw_rows) > 0 then
    select string_agg(quote_ident(k), ', ')
      into raw_cols
      from jsonb_object_keys(p_raw_rows->0) k;

    select string_agg(format('%I = excluded.%I', k, k), ', ')
      into raw_update
      from jsonb_object_keys(p_raw_rows->0) k
      where k <> p_raw_conflict;

    if raw_update is null then
      execute format(
        'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict (%I) do nothing',
        p_raw_table, raw_cols, raw_cols, p_raw_table, p_raw_conflict
      ) using p_raw_rows;
    else
      execute format(
        'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict (%I) do update set %s',
        p_raw_table, raw_cols, raw_cols, p_raw_table, p_raw_conflict, raw_update
      ) using p_raw_rows;
    end if;
  end if;

  if jsonb_array_length(p_embedding_rows) > 0 then
    execute format(
      'insert into public.%I (data_id, chunk_index, content, embedding, updated_at) ' ||
      'select data_id, chunk_index, content, embedding::vector, coalesce(updated_at::timestamptz, now()) ' ||
      'from jsonb_to_recordset($1) as r(data_id text, chunk_index int, content text, embedding text, updated_at text) ' ||
      'on conflict (data_id, chunk_index) do update set content = excluded.content, embedding = excluded.embedding, updated_at = excluded.updated_at',
      p_embeddings_table
    ) using p_embedding_rows;
  end if;
end;
$fn$;

grant execute on function public.${SYNC_FN_NAME}(text, jsonb, text, text, jsonb)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private isMissingNamedTableError(
    error: { code?: string; message?: string },
    tableName: string,
  ): boolean {
    if (!this.isMissingTableError(error, tableName)) return false;
    return error.message?.includes(tableName) === true;
  }

  private async createEmbeddingsArtifacts(table: string): Promise<void> {
    const fn = this.matchFnName(table);

    this.logger.log(`Creating pgvector artifacts for table "${table}"...`);

    await this.executeSupabaseSql(
      `${table} setup`,
      `
create extension if not exists vector;

create table if not exists public.${table} (
  data_id text not null,
  chunk_index int not null default 0,
  content text not null,
  embedding vector(${EMBEDDING_DIMENSIONS}),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (data_id, chunk_index)
);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${table} to anon, authenticated, service_role;

create or replace function public.${fn}(
  query_embedding vector(${EMBEDDING_DIMENSIONS}),
  match_count int default 10
) returns table (
  data_id text,
  chunk_index int,
  content text,
  similarity float
) language sql stable as $$
  select
    e.data_id,
    e.chunk_index,
    e.content,
    1 - (e.embedding <=> query_embedding) as similarity
  from public.${table} e
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.${fn}(vector, int) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private toPgVector(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }

  /**
   * Expand each EmbeddingItem into one or more `(data_id, chunk_index, text)`
   * triplets so long texts are split into multiple embedding rows. Texts at or
   * below MAX_CHARS_PER_CHUNK produce a single chunk with index 0.
   */
  private expandIntoChunks(
    items: EmbeddingItem[],
  ): { data_id: string; chunk_index: number; text: string }[] {
    const out: { data_id: string; chunk_index: number; text: string }[] = [];
    for (const item of items) {
      const chunks = this.chunkText(item.text);
      chunks.forEach((text, chunk_index) => {
        out.push({ data_id: item.data_id, chunk_index, text });
      });
    }
    return out;
  }

  /**
   * Character-heuristic chunker. Slides a MAX_CHARS_PER_CHUNK-sized window
   * with CHUNK_OVERLAP_CHARS of overlap so semantic boundaries aren't lost
   * at chunk edges. Doesn't try to break on sentence/paragraph boundaries
   * — keep it simple; revisit if retrieval quality is poor.
   */
  private chunkText(text: string): string[] {
    if (text.length <= MAX_CHARS_PER_CHUNK) return [text];
    const stride = MAX_CHARS_PER_CHUNK - CHUNK_OVERLAP_CHARS;
    const chunks: string[] = [];
    for (let start = 0; start < text.length; start += stride) {
      const end = Math.min(start + MAX_CHARS_PER_CHUNK, text.length);
      chunks.push(text.slice(start, end));
      if (end === text.length) break;
    }
    return chunks;
  }

  private matchFnName(table: string): string {
    return `match_${table}`;
  }

  private requireTableName(table: string): string {
    if (!TABLE_NAME_PATTERN.test(table)) {
      throw new Error(
        `Invalid table name "${table}". Use lowercase letters, digits, and underscores (must start with a letter or underscore).`,
      );
    }
    return table;
  }

  private isMissingTableError(
    error: { code?: string; message?: string },
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

  private isMissingFunctionError(
    error: { code?: string; message?: string },
    fnName: string,
  ): boolean {
    return (
      (typeof error.code === 'string' &&
        MISSING_FUNCTION_ERROR_CODES.has(error.code)) ||
      error.message?.includes(`function public.${fnName}`) === true ||
      error.message?.includes(`Could not find the function`) === true
    );
  }

  private isSchemaCacheReloadingError(error: {
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

  private waitForSchemaReload(attempt = 0): Promise<void> {
    const delay = Math.min(
      SCHEMA_RELOAD_DELAY_MS * 2 ** attempt,
      SCHEMA_RELOAD_MAX_DELAY_MS,
    );
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async executeSupabaseSql(
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

  private getSupabaseProjectRef(): string {
    const configuredRef = process.env.SUPABASE_PROJECT_REF;
    if (configuredRef) {
      return configuredRef;
    }

    const host = new URL(getSupabaseProjectUrl()).hostname;
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
