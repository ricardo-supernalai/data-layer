import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SlackConnectorService } from './slack.connector.service';

type CodeExchangePayload = {
  code: string;
  redirect_uri: string;
};

@Controller('slack.connector')
export class SlackConnectorController {
  constructor(private readonly slackConnectorService: SlackConnectorService) {}

  @Get('session')
  async getSession() {
    return this.slackConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() body: CodeExchangePayload,
  ): Promise<{ success: boolean }> {
    const success = await this.slackConnectorService.exchangeAndSaveCode(
      body.code,
      body.redirect_uri,
    );
    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.slackConnectorService.syncData();
    return { success: true };
  }

  @Get('messages')
  async listMessages(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const messages = await this.slackConnectorService.listMessages(safeLimit);
    return { messages };
  }

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
    const messages = await this.slackConnectorService.getRelevantData(
      query,
      limit,
    );
    return { messages };
  }
}
