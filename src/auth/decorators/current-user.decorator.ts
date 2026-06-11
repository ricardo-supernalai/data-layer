import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../dtos/auth.dto';

/**
 * Inject the authenticated {@link AuthUser} that a guard attached to the
 * request (`req.user`). Returns `undefined` if no guard ran. Pass a property
 * name to pluck a single field, e.g. `@CurrentUser('roles') roles: string[]`.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
