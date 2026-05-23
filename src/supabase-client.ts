import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

for (const file of ['.env', '.ENV']) {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) {
    config({ path });
    break;
  }
}

const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = (() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (typeof url !== 'string' || typeof key !== 'string') {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_ANON_KEY. Add them to .env (or .ENV) in the project root, or export them in your environment.',
    );
  }
  return {
    supabaseUrl: url,
    supabaseAnonKey: key,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
})();

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export const supabaseAdmin = supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : supabase;
export const supabaseProjectUrl = supabaseUrl;

/** Supabase client that forwards the user's JWT so PostgREST / RLS sees `auth.uid()`. */
export function createSupabaseAuthedClient(accessToken: string) {
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
