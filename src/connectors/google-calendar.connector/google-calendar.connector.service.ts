import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  CalendarAttendee,
  CalendarEvent,
  CalendarEventDateTime,
  CalendarEventListResponse,
  CalendarUser,
  GoogleCalendarCredentials,
  GoogleCalendarSession,
  GoogleTokenResponse,
  StoredEvent,
} from './dtos/google-calendar.connector.dto';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TABLE = 'googlecalendar_events';
const DEFAULT_CALENDAR_ID = 'primary';
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class GoogleCalendarConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'googlecalendar';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(GoogleCalendarConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
  }

  async saveOAuthCredentials(
    credentials: GoogleCalendarCredentials,
  ): Promise<boolean> {
    const expiresAt =
      credentials.expires_at ??
      (credentials.expires_in
        ? Date.now() + (credentials.expires_in - 60) * 1000
        : undefined);

    return this.saveCredentials({
      ...credentials,
      expires_at: expiresAt,
    });
  }

  async exchangeAndSaveCode(
    code: string,
    redirectUri: string,
  ): Promise<boolean> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in the backend env.',
      );
    }

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(
        `Google token exchange failed: ${res.status} ${await res.text()}`,
      );
    }

    const tokens = (await res.json()) as GoogleTokenResponse;

    if (!tokens.refresh_token) {
      this.logger.warn(
        'Google did not return a refresh_token. The user may have already granted consent; reconnect with prompt=consent to force one.',
      );
    }

    return this.saveOAuthCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      token_type: tokens.token_type,
      client_id: clientId,
      client_secret: clientSecret,
    });
  }

  async getSession(): Promise<GoogleCalendarSession> {
    const credentials =
      await this.loadCredentials<GoogleCalendarCredentials>();
    const expiresAt =
      typeof credentials?.expires_at === 'number'
        ? credentials.expires_at
        : null;
    const hasRefresh = Boolean(credentials?.refresh_token);
    const connected = Boolean(credentials?.access_token || hasRefresh);
    const accessExpired = Boolean(expiresAt && Date.now() >= expiresAt);
    const expired = accessExpired && !hasRefresh;

    return {
      connected,
      expired,
      expires_at: expiresAt,
      scope: credentials?.scope ?? null,
      token_type: credentials?.token_type ?? null,
      has_refresh_token: hasRefresh,
    };
  }

  protected async fetchPayload(): Promise<ConnectorSyncPayload> {
    const token = await this.getAccessToken();

    const calendarId =
      this.config.get<string>('GOOGLECALENDAR_CALENDAR_ID') ??
      DEFAULT_CALENDAR_ID;
    const maxResults = Number(
      this.config.get<string>('GOOGLECALENDAR_SYNC_BATCH') ?? '50',
    );
    const lookbackDays = Number(
      this.config.get<string>('GOOGLECALENDAR_LOOKBACK_DAYS') ?? '30',
    );
    const lookaheadDays = Number(
      this.config.get<string>('GOOGLECALENDAR_LOOKAHEAD_DAYS') ?? '90',
    );

    const timeMin = new Date(Date.now() - lookbackDays * DAY_MS).toISOString();
    const timeMax = new Date(
      Date.now() + lookaheadDays * DAY_MS,
    ).toISOString();

    const url =
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events` +
      `?maxResults=${maxResults}` +
      `&singleEvents=true` +
      `&orderBy=startTime` +
      `&timeMin=${encodeURIComponent(timeMin)}` +
      `&timeMax=${encodeURIComponent(timeMax)}`;

    const list = await this.calendarFetch<CalendarEventListResponse>(
      url,
      token,
    );
    const fetched = list.items ?? [];
    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      fetched.map((e) => e.id),
    );
    const newEvents = fetched.filter((e) => !alreadyEmbedded.has(e.id));

    if (newEvents.length === 0) {
      this.logger.log('No new Google Calendar events to sync.');
      return {
        rawTable: TABLE,
        rawRows: [],
        conflictColumn: 'id',
        items: [],
      };
    }

    const rows = newEvents.map((e) => this.toRow(e, calendarId));
    const items = rows
      .map((r) => {
        const parts = [
          r.summary ?? '(no title)',
          r.start_at ? `when: ${r.start_at}` : null,
          r.end_at ? `until: ${r.end_at}` : null,
          r.location ? `where: ${r.location}` : null,
          r.organizer ? `organizer: ${r.organizer}` : null,
          r.attendees ? `attendees: ${r.attendees}` : null,
          r.description ? `description: ${r.description}` : null,
        ].filter((s): s is string => Boolean(s));
        return {
          text: parts.join('\n').trim(),
          data_id: r.id,
        };
      })
      .filter((item) => item.text.length > 0);

    this.logger.log(
      `Prepared ${rows.length} Google Calendar event(s) (${items.length} embeddable) for atomic sync.`,
    );

    return {
      rawTable: TABLE,
      rawRows: rows as unknown as Record<string, unknown>[],
      conflictColumn: 'id',
      items,
    };
  }

  async listEvents(limit = 100): Promise<StoredEvent[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'id, calendar_id, status, summary, description, location, html_link, hangout_link, start_at, end_at, all_day, organizer, creator, attendees, recurring_event_id, created_at, updated_at, synced_at',
        )
        .order('start_at', { ascending: false })
        .limit(limit);

      if (!error) {
        return (data ?? []) as StoredEvent[];
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.ensureRawTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase read failed: ${error.message}`);
    }

    throw new Error(
      `Supabase read failed: ${TABLE} was created but is not available in the schema cache yet.`,
    );
  }

  async dataToPrompt(): Promise<string> {
    const limit = Number(
      this.config.get<string>('GOOGLECALENDAR_PROMPT_LIMIT') ?? '20',
    );
    await this.getAccessToken();
    let events: Pick<
      StoredEvent,
      | 'summary'
      | 'description'
      | 'location'
      | 'start_at'
      | 'end_at'
      | 'organizer'
      | 'attendees'
      | 'html_link'
    >[] = [];
    let readSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'summary, description, location, start_at, end_at, organizer, attendees, html_link',
        )
        .order('start_at', { ascending: false })
        .limit(limit);

      if (!error) {
        events = (data ?? []) as typeof events;
        readSucceeded = true;
        break;
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.ensureRawTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase read failed: ${error.message}`);
    }

    if (!readSucceeded) {
      throw new Error(
        `Supabase read failed: ${TABLE} was created but is not available in the schema cache yet.`,
      );
    }

    if (events.length === 0) {
      return 'No Google Calendar events available.';
    }

    const blocks = events.map((e, i) => {
      return [
        `Event ${i + 1}:`,
        `  Title: ${e.summary ?? '(no title)'}`,
        `  Start: ${e.start_at ?? 'unknown'}`,
        `  End: ${e.end_at ?? 'unknown'}`,
        `  Location: ${e.location ?? 'n/a'}`,
        `  Organizer: ${e.organizer ?? 'unknown'}`,
        `  Attendees: ${e.attendees ?? 'none'}`,
        `  Description: ${(e.description ?? '').trim() || 'n/a'}`,
        `  URL: ${e.html_link ?? 'n/a'}`,
      ].join('\n');
    });

    return [
      'The following are the most recent Google Calendar events for this user.',
      'Each entry includes title, time window, location, organizer, attendees and description.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const credentials =
      await this.loadCredentials<GoogleCalendarCredentials>();

    if (!credentials?.access_token && !credentials?.refresh_token) {
      throw new Error(
        'No saved Google Calendar credentials were found. Connect Google Calendar in the frontend first.',
      );
    }

    const isExpired =
      credentials.expires_at && Date.now() >= credentials.expires_at;

    if (!isExpired && credentials.access_token) {
      this.accessToken = credentials.access_token;
      this.accessTokenExpiresAt =
        credentials.expires_at ?? Number.MAX_SAFE_INTEGER;
      return this.accessToken;
    }

    if (!credentials.refresh_token) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      throw new Error(
        'Saved Google Calendar access token has expired and no refresh token is stored. Reconnect Google Calendar in the frontend.',
      );
    }

    return this.refreshAccessToken(credentials);
  }

  private async refreshAccessToken(
    credentials: GoogleCalendarCredentials,
  ): Promise<string> {
    const clientId =
      credentials.client_id ?? this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret =
      credentials.client_secret ??
      this.config.get<string>('GOOGLE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET to refresh Google Calendar token.',
      );
    }

    if (!credentials.refresh_token) {
      throw new Error(
        'Cannot refresh Google Calendar token: no refresh_token saved.',
      );
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credentials.refresh_token,
      grant_type: 'refresh_token',
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(
        `Google Calendar token refresh failed: ${res.status} ${await res.text()}`,
      );
    }

    const tokens = (await res.json()) as GoogleTokenResponse;
    const expiresAt = Date.now() + (tokens.expires_in - 60) * 1000;

    await this.saveCredentials({
      ...credentials,
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      expires_at: expiresAt,
      scope: tokens.scope ?? credentials.scope,
      token_type: tokens.token_type ?? credentials.token_type,
      refresh_token: tokens.refresh_token ?? credentials.refresh_token,
    });

    this.accessToken = tokens.access_token;
    this.accessTokenExpiresAt = expiresAt;
    this.logger.log(
      'Refreshed Google Calendar access token using stored refresh_token.',
    );
    return tokens.access_token;
  }

  protected async ensureRawTable(): Promise<void> {
    await this.executeSupabaseSql(
      TABLE,
      `
create table if not exists public.${TABLE} (
  id text primary key,
  calendar_id text not null,
  status text,
  summary text,
  description text,
  location text,
  html_link text,
  hangout_link text,
  start_at timestamptz,
  end_at timestamptz,
  all_day boolean not null default false,
  organizer text,
  creator text,
  attendees text,
  recurring_event_id text,
  created_at timestamptz,
  updated_at timestamptz,
  synced_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async calendarFetch<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Google Calendar API ${res.status} for ${url}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  private toRow(event: CalendarEvent, calendarId: string): StoredEvent {
    const allDay = Boolean(event.start?.date && !event.start?.dateTime);
    return {
      id: event.id,
      calendar_id: calendarId,
      status: event.status ?? null,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      html_link: event.htmlLink ?? null,
      hangout_link: event.hangoutLink ?? null,
      start_at: this.toIsoTimestamp(event.start),
      end_at: this.toIsoTimestamp(event.end),
      all_day: allDay,
      organizer: this.userName(event.organizer),
      creator: this.userName(event.creator),
      attendees: this.attendeesSummary(event.attendees),
      recurring_event_id: event.recurringEventId ?? null,
      created_at: event.created ?? null,
      updated_at: event.updated ?? null,
      synced_at: new Date().toISOString(),
    };
  }

  private toIsoTimestamp(slot: CalendarEventDateTime | undefined): string | null {
    if (!slot) return null;
    if (slot.dateTime) return slot.dateTime;
    if (slot.date) return `${slot.date}T00:00:00Z`;
    return null;
  }

  private userName(user: CalendarUser | undefined): string | null {
    if (!user) return null;
    return user.displayName ?? user.email ?? null;
  }

  private attendeesSummary(
    attendees: CalendarAttendee[] | undefined,
  ): string | null {
    if (!attendees || attendees.length === 0) return null;
    const names = attendees
      .map((a) => a.displayName ?? a.email)
      .filter((s): s is string => Boolean(s));
    return names.length > 0 ? names.join(', ') : null;
  }
}
