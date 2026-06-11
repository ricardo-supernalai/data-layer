import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { ConnectorCredentials } from '../connector.interface';
import { RequireTableAccess } from '../../auth/decorators/require-table-access.decorator';
import { TableAccessGuard } from '../../auth/guards/table-access.guard';
import { OneDriveConnectorService } from './onedrive.connector.service';

@Controller('onedrive.connector')
export class OneDriveConnectorController {
  constructor(
    private readonly oneDriveConnectorService: OneDriveConnectorService,
  ) {}

  @Get('session')
  async getSession() {
    return this.oneDriveConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() credentials: ConnectorCredentials,
  ): Promise<{ success: boolean }> {
    const success =
      await this.oneDriveConnectorService.saveOAuthCredentials(credentials);

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.oneDriveConnectorService.syncData();
    return { success: true };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('onedrive_files')
  @Get('files')
  async listFiles(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const files = await this.oneDriveConnectorService.listFiles(safeLimit);
    return { files };
  }
}
