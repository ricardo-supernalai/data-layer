import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { ConnectorCredentials } from '../connector.interface';
import { RequireTableAccess } from '../../auth/decorators/require-table-access.decorator';
import { TableAccessGuard } from '../../auth/guards/table-access.guard';
import { NetSuiteConnectorService } from './netsuite.connector.service';
import type { NetSuiteRecordType } from './dtos/netsuite.connector.dto';

const RECORD_TYPES: NetSuiteRecordType[] = ['transaction', 'customer', 'item'];

@Controller('netsuite.connector')
export class NetSuiteConnectorController {
  constructor(
    private readonly netSuiteConnectorService: NetSuiteConnectorService,
  ) {}

  @Get('session')
  async getSession() {
    return this.netSuiteConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() credentials: ConnectorCredentials,
  ): Promise<{ success: boolean }> {
    const success =
      await this.netSuiteConnectorService.saveOAuthCredentials(credentials);

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.netSuiteConnectorService.syncData();
    return { success: true };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('netsuite_records')
  @Get('records')
  async listRecords(
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const recordType = RECORD_TYPES.includes(type as NetSuiteRecordType)
      ? (type as NetSuiteRecordType)
      : undefined;
    const records = await this.netSuiteConnectorService.listRecords(
      safeLimit,
      recordType,
    );
    return { records };
  }
}
