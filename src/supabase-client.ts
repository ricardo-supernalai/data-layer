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
export function createSupabaseAuthedClient(accessToken: string): SupabaseClient {
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
