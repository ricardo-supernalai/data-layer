import type { Session, User } from '@supabase/supabase-js';

/** Wildcard meaning "every table" inside a role's table-access list. */
export const ALL_TABLES = '*';

/**
 * Configuration for {@link AuthModule.forRoot}. Controls how roles map to the
 * Supabase tables they may read.
 */
export type AuthModuleOptions = {
  /**
   * Role → tables it may read. Use `['*']` (or {@link ALL_TABLES}) to grant a
   * role access to every table. Roles absent from this map grant nothing.
   * @example { admin: ['*'], sales: ['hubspot_records'] }
   */
  tableAccess?: Record<string, string[]>;
  /**
   * Roles that bypass every table check (full read access). Defaults to
   * `['admin']`.
   */
  superRoles?: string[];
  /**
   * Whether a table not granted to any of the caller's roles is allowed
   * anyway. Defaults to `false` (deny-by-default — the secure choice).
   */
  defaultAllow?: boolean;
};

/** Email + password credentials for sign-up / sign-in. */
export type AuthCredentials = {
  email: string;
  password: string;
};

/** Request a passwordless one-time code by email. */
export type OtpRequestPayload = {
  email: string;
  /** Register the email if it doesn't exist yet (sign-up). Defaults to true. */
  create_user?: boolean;
};

/** Verify a passwordless one-time code to complete sign-in. */
export type OtpVerifyPayload = {
  email: string;
  token: string;
};

/** Admin payload to (re)assign a user's application roles. */
export type SetRolesPayload = {
  roles: string[];
};

export type RefreshPayload = {
  refresh_token: string;
};

/** Normalized session returned to clients — a trimmed view of Supabase's Session. */
export type AuthSession = {
  access_token: string;
  refresh_token: string;
  /** Unix epoch (seconds) when the access token expires, if known. */
  expires_at: number | null;
  /** Seconds until the access token expires, if known. */
  expires_in: number | null;
  token_type: string;
};

/** Normalized authenticated user — a trimmed view of Supabase's User. */
export type AuthUser = {
  id: string;
  email: string | null;
  /** Whether the email has been confirmed. */
  email_confirmed: boolean;
  /**
   * Application roles assigned to this user, read from Supabase
   * `app_metadata.roles`/`role` (falling back to `user_metadata`). Empty when
   * the user has no roles assigned. Drives table-level access control.
   */
  roles: string[];
  created_at: string | null;
  last_sign_in_at: string | null;
};

export type AuthResult = {
  user: AuthUser | null;
  /**
   * Null when sign-up requires email confirmation before a session is issued —
   * the caller should prompt the user to confirm their email.
   */
  session: AuthSession | null;
};

export function toAuthUser(user: User | null | undefined): AuthUser | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    email_confirmed: Boolean(user.email_confirmed_at ?? user.confirmed_at),
    roles: extractRoles(user),
    created_at: user.created_at ?? null,
    last_sign_in_at: user.last_sign_in_at ?? null,
  };
}

/**
 * Pull application roles out of a Supabase user. We trust `app_metadata` first
 * (server/admin-controlled, so users can't escalate themselves) and fall back
 * to `user_metadata`. Both a `roles: string[]` and a single `role: string`
 * shape are accepted. The top-level Postgres `role` ('authenticated') is
 * deliberately ignored — it is not an application role.
 */
export function extractRoles(user: User | null | undefined): string[] {
  if (!user) return [];
  const sources = [user.app_metadata, user.user_metadata];
  const collected = new Set<string>();

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const bag = source as Record<string, unknown>;
    const raw = bag.roles ?? bag.role;
    if (typeof raw === 'string') {
      if (raw.trim()) collected.add(raw.trim());
    } else if (Array.isArray(raw)) {
      for (const r of raw) {
        if (typeof r === 'string' && r.trim()) collected.add(r.trim());
      }
    }
  }

  return [...collected];
}

export function toAuthSession(
  session: Session | null | undefined,
): AuthSession | null {
  if (!session) return null;
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
    expires_in: session.expires_in ?? null,
    token_type: session.token_type ?? 'bearer',
  };
}
