import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { RequireTableAccess } from '../../auth/decorators/require-table-access.decorator';
import { TableAccessGuard } from '../../auth/guards/table-access.guard';
import { GmailConnectorService } from './gmail.connector.service';

type CodeExchangePayload = {
  code: string;
  redirect_uri: string;
};

@Controller('gmail.connector')
export class GmailConnectorController {
  constructor(private readonly gmailConnectorService: GmailConnectorService) {}

  @Get('session')
  async getSession() {
    return this.gmailConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() body: CodeExchangePayload,
  ): Promise<{ success: boolean }> {
    const success = await this.gmailConnectorService.exchangeAndSaveCode(
      body.code,
      body.redirect_uri,
    );

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.gmailConnectorService.syncData();
    return { success: true };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('gmail_messages')
  @Get('messages')
  async listMessages(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const messages = await this.gmailConnectorService.listMessages(safeLimit);
    return { messages };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('gmail_messages')
  @Post('search')
  async search(
    @Body() body: { query: string; limit?: number },
  ): Promise<{ messages: unknown[] }> {
    const query = (body?.query ?? '').trim();
    if (!query) return { messages: [] };
    const limit =
      typeof body.limit === 'number' && body.limit > 0
        ? Math.min(body.limit, 50)
        : 10;
    const messages = await this.gmailConnectorService.getRelevantData(
      query,
      limit,
    );
    return { messages };
  }
}
