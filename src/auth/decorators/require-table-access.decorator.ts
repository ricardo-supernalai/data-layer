import { SetMetadata } from '@nestjs/common';

export const TABLE_ACCESS_KEY = 'auth:table-access';

/**
 * Declare which Supabase table a route reads from. {@link TableAccessGuard}
 * uses this to enforce that the authenticated user's role(s) grant read access
 * to that table.
 * @example
 * \@UseGuards(TableAccessGuard)
 * \@RequireTableAccess('gmail_messages')
 * \@Get('messages') ...
 */
export const RequireTableAccess = (table: string) =>
  SetMetadata(TABLE_ACCESS_KEY, table);
