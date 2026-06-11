import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthError } from '@supabase/supabase-js';
import {
  createSupabaseAuthedClient,
  supabase,
  supabaseAdmin,
} from '../supabase-client';
import {
  toAuthSession,
  toAuthUser,
  type AuthResult,
  type AuthUser,
} from './dtos/auth.dto';

/** Minimal shape of the parts of an HTTP request the auth layer reads. */
export type AuthenticatableRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
};

/**
 * Authentication backed by Supabase Auth (GoTrue). Sign-up / sign-in / refresh
 * go through the anon client; per-request operations (sign-out, token
 * validation) use a client that forwards the caller's JWT so Supabase scopes
 * the action to that user.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  async signUp(email: string, password: string): Promise<AuthResult> {
    this.assertCredentials(email, password);

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      // A duplicate / invalid sign-up is a client error, not an auth failure.
      throw new BadRequestException(this.message(error, 'Sign-up failed'));
    }

    return {
      user: toAuthUser(data.user),
      session: toAuthSession(data.session),
    };
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    this.assertCredentials(email, password);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      throw new UnauthorizedException(
        this.message(error, 'Invalid email or password'),
      );
    }

    return {
      user: toAuthUser(data.user),
      session: toAuthSession(data.session),
    };
  }

  /**
   * Start a passwordless email sign-in: Supabase emails the user a one-time
   * code (and/or magic link). `createUser` controls whether an unknown email
   * is registered on the fly (true for sign-up, false for sign-in only).
   * Returns nothing sensitive — the session is only issued once the code is
   * verified via {@link verifyOtp}.
   */
  async requestOtp(email: string, createUser = true): Promise<void> {
    const trimmed = (email ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException('An email is required.');
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { shouldCreateUser: createUser },
    });
    if (error) {
      throw new BadRequestException(
        this.message(error, 'Could not send the sign-in code'),
      );
    }
  }

  /**
   * Complete a passwordless sign-in by verifying the one-time code the user
   * received by email. Returns a full session on success.
   */
  async verifyOtp(email: string, token: string): Promise<AuthResult> {
    const trimmedEmail = (email ?? '').trim();
    const trimmedToken = (token ?? '').trim();
    if (!trimmedEmail || !trimmedToken) {
      throw new BadRequestException('Both email and code are required.');
    }

    const { data, error } = await supabase.auth.verifyOtp({
      email: trimmedEmail,
      token: trimmedToken,
      type: 'email',
    });
    if (error || !data.session) {
      throw new UnauthorizedException(
        this.message(error, 'Invalid or expired code'),
      );
    }

    return {
      user: toAuthUser(data.user),
      session: toAuthSession(data.session),
    };
  }

  /**
   * Revoke the session tied to `accessToken`. Idempotent from the caller's
   * perspective: an already-invalid token still resolves successfully.
   */
  async signOut(accessToken: string): Promise<void> {
    if (!accessToken) {
      throw new UnauthorizedException('Missing access token.');
    }

    const client = createSupabaseAuthedClient(accessToken);
    const { error } = await client.auth.signOut();
    if (error) {
      this.logger.warn(`Sign-out reported an error: ${error.message}`);
    }
  }

  /** Exchange a refresh token for a fresh access/refresh pair. */
  async refresh(refreshToken: string): Promise<AuthResult> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token.');
    }

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      throw new UnauthorizedException(
        this.message(error, 'Could not refresh session'),
      );
    }

    return {
      user: toAuthUser(data.user),
      session: toAuthSession(data.session),
    };
  }

  /**
   * Validate `accessToken` against Supabase and return the user it belongs to.
   * Throws 401 if the token is missing, expired, or otherwise invalid. Useful
   * as the basis for a guard protecting other routes.
   */
  async getUser(accessToken: string): Promise<AuthUser> {
    if (!accessToken) {
      throw new UnauthorizedException('Missing access token.');
    }

    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException(
        this.message(error, 'Invalid or expired access token'),
      );
    }

    const user = toAuthUser(data.user);
    if (!user) {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    return user;
  }

  /**
   * (Re)assign a user's application roles. Roles are written to the user's
   * `app_metadata` via the Supabase admin API, so they are server-controlled
   * and can't be self-escalated. Requires SUPABASE_SERVICE_ROLE_KEY.
   */
  async setUserRoles(userId: string, roles: string[]): Promise<AuthUser> {
    if (!userId) {
      throw new BadRequestException('A user id is required.');
    }
    const normalized = [
      ...new Set(
        (roles ?? [])
          .filter((r): r is string => typeof r === 'string')
          .map((r) => r.trim())
          .filter(Boolean),
      ),
    ];

    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      { app_metadata: { roles: normalized } },
    );
    if (error || !data.user) {
      throw new BadRequestException(
        this.message(error, 'Failed to update user roles'),
      );
    }

    const user = toAuthUser(data.user);
    if (!user) {
      throw new BadRequestException('Failed to update user roles');
    }
    return user;
  }

  /**
   * Validate the bearer token on an incoming request, returning (and caching on
   * `req.user`) the authenticated user. Guards call this so authentication runs
   * at most once per request even when several guards are stacked.
   */
  async resolveUserFromRequest(
    req: AuthenticatableRequest,
  ): Promise<AuthUser> {
    if (req.user) return req.user;
    const user = await this.getUser(this.bearerFromRequest(req));
    req.user = user;
    return user;
  }

  /** Extract the JWT from an `Authorization: Bearer <token>` request header. */
  bearerFromRequest(req: AuthenticatableRequest): string {
    const header = req.headers?.['authorization'] ?? req.headers?.['Authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const [scheme, token] = (value ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException(
        'Missing or malformed Authorization header. Expected "Bearer <token>".',
      );
    }
    return token;
  }

  private assertCredentials(email: string, password: string): void {
    if (!email || !password) {
      throw new BadRequestException('Both email and password are required.');
    }
  }

  private message(error: AuthError | null, fallback: string): string {
    return error?.message ? `${fallback}: ${error.message}` : fallback;
  }
}
