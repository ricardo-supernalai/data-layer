import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'auth:roles';

/**
 * Require the authenticated user to hold at least one of `roles`. Use together
 * with {@link RolesGuard}.
 * @example
 * \@UseGuards(RolesGuard)
 * \@Roles('admin')
 * \@Post('users/:id/roles') ...
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
