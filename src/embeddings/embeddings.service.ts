import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase, supabaseProjectUrl } from '../supabase-client';
import type { EmbeddingItem, SearchMatch } from './dtos/embeddings.dto';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 3072;
const MISSING_TABLE_ERROR_CODES = new Set(['42P01', 'PGRST205']);
const MISSING_FUNCTION_ERROR_CODES = new Set(['42883', 'PGRST202']);
const SCHEMA_RELOAD_DELAY_MS = 1_000;
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

type OpenAIEmbeddingResponse = {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
};

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly supabase: SupabaseClient = supabase;

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
      throw new Error(
        `OpenAI embeddings request failed: ${res.status} ${await res.text()}`,
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

    const vectors = await this.embedMany(items.map((it) => it.text));
    const now = new Date().toISOString();
    const rows = items.map((it, i) => ({
      data_id: it.data_id,
      content: it.text,
      embedding: this.toPgVector(vectors[i]),
      updated_at: now,
    }));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error } = await this.supabase
        .from(table)
        .upsert(rows, { onConflict: 'data_id' });

      if (!error) {
        return;
      }

      if (this.isMissingTableError(error, table)) {
        await this.createEmbeddingsArtifacts(table);
        await this.waitForSchemaReload();
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

    for (let attempt = 0; attempt < 3; attempt += 1) {
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
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase search failed for ${fn}: ${error.message}`);
    }

    throw new Error(
      `Supabase search failed: ${fn} was created but is not available in the schema cache yet.`,
    );
  }

  private async createEmbeddingsArtifacts(table: string): Promise<void> {
    const fn = this.matchFnName(table);

    this.logger.log(`Creating pgvector artifacts for table "${table}"...`);

    await this.executeSupabaseSql(
      `${table} setup`,
      `
create extension if not exists vector;

create table if not exists public.${table} (
  data_id text primary key,
  content text not null,
  embedding vector(${EMBEDDING_DIMENSIONS}),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${table} to anon, authenticated, service_role;

create or replace function public.${fn}(
  query_embedding vector(${EMBEDDING_DIMENSIONS}),
  match_count int default 10
) returns table (
  data_id text,
  content text,
  similarity float
) language sql stable as $$
  select
    e.data_id,
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

  private waitForSchemaReload(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, SCHEMA_RELOAD_DELAY_MS));
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
