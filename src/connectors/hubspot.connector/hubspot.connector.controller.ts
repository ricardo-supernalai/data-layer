import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { ConnectorCredentials } from '../connector.interface';
import { RequireTableAccess } from '../../auth/decorators/require-table-access.decorator';
import { TableAccessGuard } from '../../auth/guards/table-access.guard';
import { HubSpotConnectorService } from './hubspot.connector.service';
import type { HubSpotObjectType } from './dtos/hubspot.connector.dto';

const OBJECT_TYPES: HubSpotObjectType[] = [
  'account',
  'deal',
  'contact',
  'pipeline',
];

@Controller('hubspot.connector')
export class HubSpotConnectorController {
  constructor(
    private readonly hubSpotConnectorService: HubSpotConnectorService,
  ) {}

  @Get('session')
  async getSession() {
    return this.hubSpotConnectorService.getSession();
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
      const success = await this.hubSpotConnectorService.exchangeAndSaveCode(
        credentials.code,
        credentials.redirect_uri,
      );
      return { success };
    }

    const success =
      await this.hubSpotConnectorService.saveOAuthCredentials(credentials);

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.hubSpotConnectorService.syncData();
    return { success: true };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('hubspot_records')
  @Get('records')
  async listRecords(
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const objectType = OBJECT_TYPES.includes(type as HubSpotObjectType)
      ? (type as HubSpotObjectType)
      : undefined;
    const records = await this.hubSpotConnectorService.listRecords(
      safeLimit,
      objectType,
    );
    return { records };
  }
}
