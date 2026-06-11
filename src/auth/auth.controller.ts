import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RlsService } from './rls.service';
import { Roles } from './decorators/roles.decorator';
import { RolesGuard } from './guards/roles.guard';
import type {
  AuthCredentials,
  AuthResult,
  AuthUser,
  OtpRequestPayload,
  OtpVerifyPayload,
  RefreshPayload,
  SetRolesPayload,
} from './dtos/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rlsService: RlsService,
  ) {}

  @Post('signup')
  async signUp(@Body() body: AuthCredentials): Promise<AuthResult> {
    return this.authService.signUp(body?.email, body?.password);
  }

  @Post('signin')
  async signIn(@Body() body: AuthCredentials): Promise<AuthResult> {
    return this.authService.signIn(body?.email, body?.password);
  }

  /** Passwordless: email the user a one-time sign-in code. */
  @Post('otp')
  async requestOtp(
    @Body() body: OtpRequestPayload,
  ): Promise<{ success: boolean }> {
    await this.authService.requestOtp(body?.email, body?.create_user ?? true);
    return { success: true };
  }

  /** Passwordless: verify the one-time code and return a session. */
  @Post('verify')
  async verifyOtp(@Body() body: OtpVerifyPayload): Promise<AuthResult> {
    return this.authService.verifyOtp(body?.email, body?.token);
  }

  @Post('signout')
  async signOut(
    @Headers('authorization') authorization?: string,
  ): Promise<{ success: boolean }> {
    await this.authService.signOut(this.bearer(authorization));
    return { success: true };
  }

  @Post('refresh')
  async refresh(@Body() body: RefreshPayload): Promise<AuthResult> {
    return this.authService.refresh(body?.refresh_token);
  }

  @Get('me')
  async me(
    @Headers('authorization') authorization?: string,
  ): Promise<{ user: AuthUser }> {
    const user = await this.authService.getUser(this.bearer(authorization));
    return { user };
  }

  /**
   * Assign a user's application roles. Admin-only: the caller must hold the
   * `admin` role. Roles are stored in the target user's `app_metadata`.
   */
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post('users/:id/roles')
  async setRoles(
    @Param('id') id: string,
    @Body() body: SetRolesPayload,
  ): Promise<{ user: AuthUser }> {
    const user = await this.authService.setUserRoles(id, body?.roles ?? []);
    return { user };
  }

  /**
   * (Re)apply role-based RLS across all data tables from the current policy.
   * Admin-only. Use after changing the role → table mapping or adding a
   * connector so its new tables get secured.
   */
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post('rls/apply')
  async applyRls(): Promise<{ applied: string[] }> {
    const applied = await this.rlsService.provision();
    return { applied };
  }

  /** Inspect the role → table policy currently seeded into the database. Admin-only. */
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Get('rls/policy')
  async rlsPolicy(): Promise<{ policy: { role: string; table: string }[] }> {
    return { policy: this.rlsService.describePolicy() };
  }

  /** Pull the bearer token out of an `Authorization: Bearer <jwt>` header. */
  private bearer(authorization?: string): string {
    const [scheme, token] = (authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException(
        'Missing or malformed Authorization header. Expected "Bearer <token>".',
      );
    }
    return token;
  }
}
