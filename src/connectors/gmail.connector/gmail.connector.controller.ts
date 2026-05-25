import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { ConnectorCredentials } from '../connector.interface';
import { GmailConnectorService } from './gmail.connector.service';

@Controller('gmail.connector')
export class GmailConnectorController {
  constructor(private readonly gmailConnectorService: GmailConnectorService) {}

  @Get('session')
  async getSession() {
    return this.gmailConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() credentials: ConnectorCredentials,
  ): Promise<{ success: boolean }> {
    const success =
      await this.gmailConnectorService.saveOAuthCredentials(credentials);

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.gmailConnectorService.syncData();
    return { success: true };
  }

  @Get('messages')
  async listMessages(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const messages = await this.gmailConnectorService.listMessages(safeLimit);
    return { messages };
  }
}
