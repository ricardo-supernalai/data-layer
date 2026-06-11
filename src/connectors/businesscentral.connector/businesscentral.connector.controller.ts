import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { ConnectorCredentials } from '../connector.interface';
import { RequireTableAccess } from '../../auth/decorators/require-table-access.decorator';
import { TableAccessGuard } from '../../auth/guards/table-access.guard';
import { BusinessCentralConnectorService } from './businesscentral.connector.service';
import type { BusinessCentralEntity } from './dtos/businesscentral.connector.dto';

const ENTITIES: BusinessCentralEntity[] = [
  'customer',
  'vendor',
  'item',
  'sales_invoice',
];

@Controller('businesscentral.connector')
export class BusinessCentralConnectorController {
  constructor(
    private readonly businessCentralConnectorService: BusinessCentralConnectorService,
  ) {}

  @Get('session')
  async getSession() {
    return this.businessCentralConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() credentials: ConnectorCredentials,
  ): Promise<{ success: boolean }> {
    const success =
      await this.businessCentralConnectorService.saveOAuthCredentials(
        credentials,
      );

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.businessCentralConnectorService.syncData();
    return { success: true };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('businesscentral_records')
  @Get('records')
  async listRecords(
    @Query('limit') limit?: string,
    @Query('entity') entity?: string,
  ) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const entityFilter = ENTITIES.includes(entity as BusinessCentralEntity)
      ? (entity as BusinessCentralEntity)
      : undefined;
    const records = await this.businessCentralConnectorService.listRecords(
      safeLimit,
      entityFilter,
    );
    return { records };
  }
}
