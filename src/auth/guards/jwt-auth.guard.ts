import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { AuthService, type AuthenticatableRequest } from '../auth.service';

/**
 * Requires a valid Supabase bearer token. On success the authenticated
 * {@link AuthUser} is attached to `req.user` (retrievable via `@CurrentUser()`).
 * Throws 401 otherwise.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<AuthenticatableRequest>();
    await this.authService.resolveUserFromRequest(req);
    return true;
  }
}
