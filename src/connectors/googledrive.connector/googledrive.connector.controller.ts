import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { GoogleDriveConnectorService } from './googledrive.connector.service';

type CodeExchangePayload = {
  code: string;
  redirect_uri: string;
};

@Controller('googledrive.connector')
export class GoogleDriveConnectorController {
  constructor(
    private readonly googleDriveConnectorService: GoogleDriveConnectorService,
  ) {}

  @Get('session')
  async getSession() {
    return this.googleDriveConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() body: CodeExchangePayload,
  ): Promise<{ success: boolean }> {
    const success = await this.googleDriveConnectorService.exchangeAndSaveCode(
      body.code,
      body.redirect_uri,
    );

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.googleDriveConnectorService.syncData();
    return { success: true };
  }

  @Get('files')
  async listFiles(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const files = await this.googleDriveConnectorService.listFiles(safeLimit);
    return { files };
  }
}
