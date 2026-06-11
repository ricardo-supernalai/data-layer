import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { RequireTableAccess } from '../../auth/decorators/require-table-access.decorator';
import { TableAccessGuard } from '../../auth/guards/table-access.guard';
import { GoogleCalendarConnectorService } from './google-calendar.connector.service';

type CodeExchangePayload = {
  code: string;
  redirect_uri: string;
};

@Controller('google-calendar.connector')
export class GoogleCalendarConnectorController {
  constructor(
    private readonly googleCalendarConnectorService: GoogleCalendarConnectorService,
  ) {}

  @Get('session')
  async getSession() {
    return this.googleCalendarConnectorService.getSession();
  }

  @Post('credentials')
  async saveCredentials(
    @Body() body: CodeExchangePayload,
  ): Promise<{ success: boolean }> {
    const success =
      await this.googleCalendarConnectorService.exchangeAndSaveCode(
        body.code,
        body.redirect_uri,
      );

    return { success };
  }

  @Post('sync')
  async sync(): Promise<{ success: boolean }> {
    await this.googleCalendarConnectorService.syncData();
    return { success: true };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('googlecalendar_events')
  @Get('events')
  async listEvents(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 100;
    const safeLimit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
    const events =
      await this.googleCalendarConnectorService.listEvents(safeLimit);
    return { events };
  }

  @UseGuards(TableAccessGuard)
  @RequireTableAccess('googlecalendar_events')
  @Post('search')
  async search(
    @Body() body: { query: string; limit?: number },
  ): Promise<{ events: unknown[] }> {
    const query = (body?.query ?? '').trim();
    if (!query) return { events: [] };
    const limit =
      typeof body.limit === 'number' && body.limit > 0
        ? Math.min(body.limit, 50)
        : 10;
    const events = await this.googleCalendarConnectorService.getRelevantData(
      query,
      limit,
    );
    return { events };
  }
}
