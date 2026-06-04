import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { ConnectorCredentials } from '../connector.interface';
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
    const success =
      await this.microsoft365ConnectorService.saveOAuthCredentials(credentials);

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.microsoft365ConnectorService.syncData();
    return { success: true };
  }

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
