import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { AUTH_OPTIONS } from './auth.tokens';
import { ALL_TABLES, type AuthModuleOptions } from './dtos/auth.dto';

const DEFAULT_SUPER_ROLES = ['admin'];

/**
 * Decides whether a set of roles may read a given Supabase table, based on the
 * policy supplied to {@link AuthModule.forRoot}. The policy is deny-by-default:
 * a table is only readable if one of the caller's roles is a super role, or the
 * table is explicitly listed for one of their roles (or `defaultAllow` is set).
 */
@Injectable()
export class AccessControlService {
  private readonly tableAccess: Record<string, string[]>;
  private readonly superRoles: Set<string>;
  private readonly defaultAllow: boolean;

  constructor(
    @Optional()
    @Inject(AUTH_OPTIONS)
    options?: AuthModuleOptions,
  ) {
    this.tableAccess = options?.tableAccess ?? {};
    this.superRoles = new Set(options?.superRoles ?? DEFAULT_SUPER_ROLES);
    this.defaultAllow = options?.defaultAllow ?? false;
  }

  /** Whether any of `roles` may read `table`. */
  canReadTable(roles: string[], table: string): boolean {
    if (this.hasSuperRole(roles)) return true;

    for (const role of roles) {
      const grants = this.tableAccess[role];
      if (!grants) continue;
      if (grants.includes(ALL_TABLES) || grants.includes(table)) return true;
    }

    return this.defaultAllow;
  }

  /** Throw 403 unless `roles` may read `table`. */
  assertCanReadTable(roles: string[], table: string): void {
    if (!this.canReadTable(roles, table)) {
      throw new ForbiddenException(
        `Your role(s) [${roles.join(', ') || 'none'}] do not grant read access to "${table}".`,
      );
    }
  }

  /** Subset of `tables` that `roles` may read. */
  filterTablesByAccess(roles: string[], tables: string[]): string[] {
    return tables.filter((t) => this.canReadTable(roles, t));
  }

  /**
   * Tables `roles` may read: the {@link ALL_TABLES} wildcard if they have full
   * access, otherwise the explicit union across their roles.
   */
  allowedTables(roles: string[]): string[] | typeof ALL_TABLES {
    if (this.hasSuperRole(roles)) return ALL_TABLES;

    const allowed = new Set<string>();
    for (const role of roles) {
      const grants = this.tableAccess[role] ?? [];
      if (grants.includes(ALL_TABLES)) return ALL_TABLES;
      for (const t of grants) allowed.add(t);
    }
    return [...allowed];
  }

  private hasSuperRole(roles: string[]): boolean {
    return roles.some((r) => this.superRoles.has(r));
  }
}
