import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { AccessControlService } from './access-control.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_OPTIONS } from './auth.tokens';
import { RlsService } from './rls.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { TableAccessGuard } from './guards/table-access.guard';
import type { AuthModuleOptions } from './dtos/auth.dto';

/**
 * Supabase-backed authentication + role-based access control.
 *
 * Marked `@Global()` so its providers (AuthService, AccessControlService, the
 * guards) are injectable anywhere — including connector controllers and the
 * data layer — without each module re-importing AuthModule.
 *
 * Configure the role → table policy with {@link AuthModule.forRoot}:
 * @example
 * AuthModule.forRoot({
 *   superRoles: ['admin'],
 *   tableAccess: { sales: ['hubspot_records'], support: ['gmail_messages'] },
 *   defaultAllow: false,
 * })
 */
@Global()
@Module({
  imports: [ConfigModule.forRoot(), DiscoveryModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessControlService,
    RlsService,
    JwtAuthGuard,
    RolesGuard,
    TableAccessGuard,
  ],
  exports: [
    AuthService,
    AccessControlService,
    RlsService,
    JwtAuthGuard,
    RolesGuard,
    TableAccessGuard,
  ],
})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      providers: [{ provide: AUTH_OPTIONS, useValue: options }],
      exports: [AUTH_OPTIONS],
    };
  }
}
