import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, type AuthenticatableRequest } from '../auth.service';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Authenticates the request, then requires the user to hold at least one of the
 * roles declared via `@Roles(...)`. A route with no `@Roles` only needs a valid
 * token (authentication without a specific role).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<AuthenticatableRequest>();
    const user = await this.authService.resolveUserFromRequest(req);

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const has = user.roles.some((r) => required.includes(r));
    if (!has) {
      throw new ForbiddenException(
        `This action requires one of the following roles: ${required.join(', ')}.`,
      );
    }
    return true;
  }
}
