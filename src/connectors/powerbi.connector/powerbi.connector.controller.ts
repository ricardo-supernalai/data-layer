import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { ConnectorCredentials } from '../connector.interface';
import { RequireTableAccess } from '../../auth/decorators/require-table-access.decorator';
import { TableAccessGuard } from '../../auth/guards/table-access.guard';
import { PowerBIConnectorService } from './powerbi.connector.service';
import type { PowerBIItemType } from './dtos/powerbi.connector.dto';

const ITEM_TYPES: PowerBIItemType[] = ['report', 'dataset', 'dashboard'];

@Controller('powerbi.connector')
export class PowerBIConnectorController {
  constructor(
    private readonly powerBIConnectorService: PowerBIConnectorService,
  ) {}

  @Get('session')
  async getSession() {
    return this.powerBIConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() credentials: ConnectorCredentials,
  ): Promise<{ success: boolean }> {
    const success =
      await this.powerBIConnectorService.saveOAuthCredentials(credentials);

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.powerBIConnectorService.syncData();
    return { success: true };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('powerbi_items')
  @Get('items')
  async listItems(
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const itemType = ITEM_TYPES.includes(type as PowerBIItemType)
      ? (type as PowerBIItemType)
      : undefined;
    const items = await this.powerBIConnectorService.listItems(
      safeLimit,
      itemType,
    );
    return { items };
  }
}
