import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessControlService } from '../access-control.service';
import { AuthService, type AuthenticatableRequest } from '../auth.service';
import { TABLE_ACCESS_KEY } from '../decorators/require-table-access.decorator';

/**
 * Authenticates the request, then enforces that the user's role(s) grant read
 * access to the table declared via `@RequireTableAccess('<table>')`. Routes
 * without that decorator pass through (authentication only). Throws 403 when
 * the role policy denies the table.
 */
@Injectable()
export class TableAccessGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly accessControl: AccessControlService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<AuthenticatableRequest>();
    const user = await this.authService.resolveUserFromRequest(req);

    const table = this.reflector.getAllAndOverride<string | undefined>(
      TABLE_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!table) return true;

    this.accessControl.assertCanReadTable(user.roles, table);
    return true;
  }
}
