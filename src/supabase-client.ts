import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Resolved = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string | undefined;
};

let cached: Resolved | null = null;
let dotenvLoaded = false;

function loadDotenvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  for (const file of ['.env', '.ENV']) {
    const path = resolve(process.cwd(), file);
    if (existsSync(path)) {
      config({ path });
      break;
    }
  }
}

function resolveConfig(): Resolved {
  if (cached) return cached;
  loadDotenvOnce();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (typeof url !== 'string' || typeof key !== 'string') {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_ANON_KEY. Set them in your environment or .env before using the data layer.',
    );
  }
  cached = {
    supabaseUrl: url,
    supabaseAnonKey: key,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  return cached;
}

let _supabase: SupabaseClient | null = null;
let _supabaseAdmin: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;
  const { supabaseUrl, supabaseAnonKey } = resolveConfig();
  _supabase = createClient(supabaseUrl, supabaseAnonKey);
  return _supabase;
}

function getSupabaseAdmin(): SupabaseClient {
  if (_supabaseAdmin) return _supabaseAdmin;
  const { supabaseUrl, supabaseServiceRoleKey } = resolveConfig();
  _supabaseAdmin = supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      })
    : getSupabase();
  return _supabaseAdmin;
}

/**
 * Lazy proxy: behaves like a SupabaseClient, but the underlying client is
 * created on first property access. Lets the package be imported in
 * environments where env vars aren't set yet (e.g. type-only imports, tests,
 * IDE indexing) — the throw only happens on actual use.
 */
function lazyClient(resolver: () => SupabaseClient): SupabaseClient {
  return new Proxy({} as SupabaseClient, {
    get(_target, prop, receiver) {
      const client = resolver() as unknown as Record<PropertyKey, unknown>;
      const value = Reflect.get(client, prop, receiver);
      return typeof value === 'function' ? value.bind(client) : value;
    },
    has(_target, prop) {
      return prop in (resolver() as unknown as object);
    },
  });
}

export const supabase: SupabaseClient = lazyClient(getSupabase);
export const supabaseAdmin: SupabaseClient = lazyClient(getSupabaseAdmin);

export function getSupabaseProjectUrl(): string {
  return resolveConfig().supabaseUrl;
}

/** Supabase client that forwards the user's JWT so PostgREST / RLS sees `auth.uid()`. */
export function createSupabaseAuthedClient(
  accessToken: string,
): SupabaseClient {
  const { supabaseUrl, supabaseAnonKey } = resolveConfig();
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/** The project ref (subdomain of the Supabase URL, or SUPABASE_PROJECT_REF). */
export function getSupabaseProjectRef(): string {
  const configuredRef = process.env.SUPABASE_PROJECT_REF;
  if (configuredRef) return configuredRef;

  const host = new URL(getSupabaseProjectUrl()).hostname;
  const [projectRef] = host.split('.');
  if (!projectRef) {
    throw new Error(
      'Failed to detect Supabase project ref. Set SUPABASE_PROJECT_REF in the environment.',
    );
  }
  return projectRef;
}

function isSupabaseApiKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

const MANAGEMENT_SQL_MAX_ATTEMPTS = 4;
const MANAGEMENT_SQL_RETRY_BASE_MS = 1_500;
/** Gateway/transient statuses worth retrying; 4xx config errors are not. */
const MANAGEMENT_SQL_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Condense an API error body for logs: Cloudflare 5xx responses are full HTML
 * pages, so strip markup and cap the length instead of dumping the page.
 */
function errorBodySnippet(body: string): string {
  const text = body.startsWith('<')
    ? body
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    : body;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}

/**
 * Run arbitrary SQL/DDL against the project's database via the Supabase
 * Management API. Used for one-off schema operations (creating tables,
 * functions, enabling RLS) that the regular data-plane clients can't perform.
 * Requires SUPABASE_ACCESS_TOKEN (a Supabase *account* access token — not the
 * project anon/publishable key).
 *
 * Transient failures (network errors, 429/5xx) are retried with exponential
 * backoff before giving up — api.supabase.com occasionally returns gateway
 * errors that resolve within seconds.
 */
export async function executeSupabaseManagementSql(
  label: string,
  query: string,
): Promise<void> {
  const projectRef = getSupabaseProjectRef();
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error(
      `Failed to run ${label}: missing SUPABASE_ACCESS_TOKEN for the Supabase Management API.`,
    );
  }
  if (isSupabaseApiKey(accessToken)) {
    throw new Error(
      `Failed to run ${label}: SUPABASE_ACCESS_TOKEN must be a Supabase account access token, not the project anon/publishable API key.`,
    );
  }

  let lastError = '';
  for (let attempt = 1; attempt <= MANAGEMENT_SQL_MAX_ATTEMPTS; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(
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
    } catch (err) {
      lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (response) {
      if (response.ok) return;

      lastError = `${response.status} ${errorBodySnippet(await response.text())}`;
      if (!MANAGEMENT_SQL_RETRYABLE_STATUSES.has(response.status)) {
        throw new Error(
          `Failed to run ${label}: Supabase SQL API returned ${lastError}`,
        );
      }
    }

    if (attempt < MANAGEMENT_SQL_MAX_ATTEMPTS) {
      await new Promise((r) =>
        setTimeout(r, MANAGEMENT_SQL_RETRY_BASE_MS * 2 ** (attempt - 1)),
      );
    }
  }

  throw new Error(
    `Failed to run ${label} after ${MANAGEMENT_SQL_MAX_ATTEMPTS} attempts: Supabase SQL API returned ${lastError}`,
  );
}
