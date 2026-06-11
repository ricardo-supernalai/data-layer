import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { ConnectorCredentials } from '../connector.interface';
import { RequireTableAccess } from '../../auth/decorators/require-table-access.decorator';
import { TableAccessGuard } from '../../auth/guards/table-access.guard';
import { Microsoft365ConnectorService } from './microsoft365.connector.service';
import type { Microsoft365Source } from './dtos/microsoft365.connector.dto';

const SOURCES: Microsoft365Source[] = [
  'outlook',
  'calendar',
  'onedrive',
  'sharepoint',
  'teams_recording',
];

@Controller('microsoft365.connector')
export class Microsoft365ConnectorController {
  constructor(
    private readonly microsoft365ConnectorService: Microsoft365ConnectorService,
  ) {}

  @Get('session')
  async getSession() {
    return this.microsoft365ConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() credentials: ConnectorCredentials,
  ): Promise<{ success: boolean }> {
    // OAuth code payloads are exchanged server-side (keeps client_secret out
    // of the browser and yields a refresh token); raw token payloads are
    // saved as-is.
    if (
      typeof credentials.code === 'string' &&
      typeof credentials.redirect_uri === 'string'
    ) {
      const success = await this.microsoft365ConnectorService.exchangeAndSaveCode(
        credentials.code,
        credentials.redirect_uri,
      );
      return { success };
    }

    const success =
      await this.microsoft365ConnectorService.saveOAuthCredentials(credentials);

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.microsoft365ConnectorService.syncData();
    return { success: true };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('microsoft365_items')
  @Get('items')
  async listItems(
    @Query('limit') limit?: string,
    @Query('source') source?: string,
  ) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const sourceFilter = SOURCES.includes(source as Microsoft365Source)
      ? (source as Microsoft365Source)
      : undefined;
    const items = await this.microsoft365ConnectorService.listItems(
      safeLimit,
      sourceFilter,
    );
    return { items };
  }
}
