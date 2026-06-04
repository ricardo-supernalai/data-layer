import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  GraphCallRecording,
  GraphDriveItem,
  GraphEmailAddress,
  GraphEvent,
  GraphIdentity,
  GraphListResponse,
  GraphMessage,
  Microsoft365Credentials,
  Microsoft365Session,
  Microsoft365Source,
  MicrosoftTokenResponse,
  StoredM365Item,
} from './dtos/microsoft365.connector.dto';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA_API = 'https://graph.microsoft.com/beta';
const TABLE = 'microsoft365_items';

/**
 * Microsoft 365 integration over the Microsoft Graph API. Teams, Outlook,
 * OneDrive and SharePoint are connected through a single OAuth grant so that
 * email, calendar events, files and meeting recordings all flow into the Vault
 * as agent context. Each surface is fetched independently — a permission gap or
 * transient failure on one (e.g. Teams recordings) is logged and skipped rather
 * than sinking the whole sync.
 */
@Injectable()
export class Microsoft365ConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'microsoft365';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(Microsoft365ConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
  }

  private tokenUrl(tenant?: string | null): string {
    const t =
      tenant ?? this.config.get<string>('MICROSOFT_TENANT') ?? 'common';
    return `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`;
  }

  async saveOAuthCredentials(
    credentials: Microsoft365Credentials,
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
    const clientId = this.config.get<string>('MICROSOFT_CLIENT_ID');
    const clientSecret = this.config.get<string>('MICROSOFT_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET in the backend env.',
      );
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });

    const res = await fetch(this.tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(
        `Microsoft token exchange failed: ${res.status} ${await res.text()}`,
      );
    }

    const tokens = (await res.json()) as MicrosoftTokenResponse;

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

  async getSession(): Promise<Microsoft365Session> {
    const credentials = await this.loadCredentials<Microsoft365Credentials>();
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
    const batch = Number(
      this.config.get<string>('MICROSOFT365_SYNC_BATCH') ?? '50',
    );

    const fetched: StoredM365Item[] = [];

    // Each surface is fetched independently; a failure on one is logged and the
    // rest still contribute to the sync.
    await this.collect('Outlook mail', fetched, () =>
      this.fetchMail(token, batch),
    );
    await this.collect('calendar events', fetched, () =>
      this.fetchEvents(token, batch),
    );
    await this.collect('OneDrive/SharePoint files', fetched, () =>
      this.fetchFiles(token, batch),
    );
    await this.collect('Teams meeting recordings', fetched, () =>
      this.fetchRecordings(token, batch),
    );

    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      fetched.map((r) => r.id),
    );
    const newRows = fetched.filter((r) => !alreadyEmbedded.has(r.id));

    if (newRows.length === 0) {
      this.logger.log('No new Microsoft 365 items to sync.');
      return { rawTable: TABLE, rawRows: [], conflictColumn: 'id', items: [] };
    }

    const items = newRows
      .map((r) => ({ text: this.embedText(r), data_id: r.id }))
      .filter((item) => item.text.length > 0);

    this.logger.log(
      `Prepared ${newRows.length} Microsoft 365 item(s) (${items.length} embeddable) for atomic sync.`,
    );

    return {
      rawTable: TABLE,
      rawRows: newRows as unknown as Record<string, unknown>[],
      conflictColumn: 'id',
      items,
    };
  }

  async listItems(
    limit = 100,
    source?: Microsoft365Source,
  ): Promise<StoredM365Item[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let queryBuilder = this.supabase
        .from(TABLE)
        .select(
          'id, source, title, body, web_url, author, participants, occurred_at, metadata, synced_at',
        )
        .order('occurred_at', { ascending: false })
        .limit(limit);

      if (source) {
        queryBuilder = queryBuilder.eq('source', source);
      }

      const { data, error } = await queryBuilder;

      if (!error) {
        return (data ?? []) as StoredM365Item[];
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
      this.config.get<string>('MICROSOFT365_PROMPT_LIMIT') ?? '20',
    );
    await this.getAccessToken();
    let items: StoredM365Item[] = [];
    let readSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'id, source, title, body, web_url, author, participants, occurred_at, metadata, synced_at',
        )
        .order('occurred_at', { ascending: false })
        .limit(limit);

      if (!error) {
        items = (data ?? []) as StoredM365Item[];
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

    if (items.length === 0) {
      return 'No Microsoft 365 items available.';
    }

    const blocks = items.map((item, i) => {
      const lines = [
        `${this.sourceLabel(item.source)} ${i + 1}:`,
        `  Title: ${item.title ?? '(untitled)'}`,
      ];
      if (item.author) lines.push(`  From/Organizer: ${item.author}`);
      if (item.participants) lines.push(`  Participants: ${item.participants}`);
      lines.push(`  When: ${item.occurred_at ?? 'unknown'}`);
      const body = this.toPlainText(item.body);
      if (body) lines.push(`  Body: ${body}`);
      if (item.web_url) lines.push(`  URL: ${item.web_url}`);
      return lines.join('\n');
    });

    return [
      'The following are the most recent Microsoft 365 items for this user,',
      'drawn from Outlook email, calendar, OneDrive/SharePoint files and Teams meeting recordings.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  /** Override so HTML email/event bodies are stripped before prompting. */
  formatRowForPrompt(row: Record<string, unknown>): string {
    const skip = new Set(['synced_at', 'embedding', 'body', 'metadata']);
    const lines = Object.entries(row)
      .filter(([k, v]) => !skip.has(k) && v != null && v !== '')
      .map(
        ([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
      );
    const body = this.toPlainText(
      typeof row.body === 'string' ? row.body : null,
    );
    if (body) lines.push(`  body: ${body}`);
    return lines.join('\n');
  }

  private async collect(
    label: string,
    sink: StoredM365Item[],
    fetcher: () => Promise<StoredM365Item[]>,
  ): Promise<void> {
    try {
      const rows = await fetcher();
      sink.push(...rows);
      this.logger.log(`Fetched ${rows.length} item(s) from ${label}.`);
    } catch (err) {
      this.logger.warn(
        `Skipping ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fetchMail(
    token: string,
    batch: number,
  ): Promise<StoredM365Item[]> {
    const url =
      `${GRAPH_API}/me/messages?$top=${batch}` +
      `&$select=id,subject,bodyPreview,body,from,toRecipients,receivedDateTime,webLink` +
      `&$orderby=receivedDateTime desc`;
    const list = await this.graphFetch<GraphListResponse<GraphMessage>>(
      url,
      token,
    );
    return (list.value ?? []).map((m) => ({
      id: `outlook:${m.id}`,
      source: 'outlook' as const,
      title: m.subject ?? null,
      body: m.body?.content ?? m.bodyPreview ?? null,
      web_url: m.webLink ?? null,
      author: this.addressName(m.from),
      participants: (m.toRecipients ?? [])
        .map((r) => this.addressName(r))
        .filter((s): s is string => Boolean(s))
        .join(', '),
      occurred_at: m.receivedDateTime ?? null,
      metadata: { contentType: m.body?.contentType ?? 'text' },
      synced_at: new Date().toISOString(),
    }));
  }

  private async fetchEvents(
    token: string,
    batch: number,
  ): Promise<StoredM365Item[]> {
    const url =
      `${GRAPH_API}/me/events?$top=${batch}` +
      `&$select=id,subject,bodyPreview,body,organizer,attendees,start,end,location,webLink,isOnlineMeeting` +
      `&$orderby=start/dateTime desc`;
    const list = await this.graphFetch<GraphListResponse<GraphEvent>>(
      url,
      token,
    );
    return (list.value ?? []).map((e) => ({
      id: `calendar:${e.id}`,
      source: 'calendar' as const,
      title: e.subject ?? null,
      body: e.body?.content ?? e.bodyPreview ?? null,
      web_url: e.webLink ?? null,
      author: this.addressName(e.organizer),
      participants: (e.attendees ?? [])
        .map((a) => this.addressName(a))
        .filter((s): s is string => Boolean(s))
        .join(', '),
      occurred_at: e.start?.dateTime ?? null,
      metadata: {
        contentType: e.body?.contentType ?? 'text',
        end: e.end?.dateTime ?? null,
        location: e.location?.displayName ?? null,
        isOnlineMeeting: Boolean(e.isOnlineMeeting),
      },
      synced_at: new Date().toISOString(),
    }));
  }

  private async fetchFiles(
    token: string,
    batch: number,
  ): Promise<StoredM365Item[]> {
    const list = await this.graphFetch<GraphListResponse<GraphDriveItem>>(
      `${GRAPH_API}/me/drive/recent?$top=${batch}`,
      token,
    );
    return (list.value ?? []).map((item) => {
      // A SharePoint-backed item carries a siteId on its parent reference;
      // anything else is treated as personal OneDrive.
      const isSharePoint = Boolean(item.parentReference?.siteId);
      return {
        id: `${isSharePoint ? 'sharepoint' : 'onedrive'}:${item.id}`,
        source: (isSharePoint ? 'sharepoint' : 'onedrive') as Microsoft365Source,
        title: item.name ?? null,
        body: null,
        web_url: item.webUrl ?? null,
        author: this.identityName(item.lastModifiedBy ?? item.createdBy),
        participants: null,
        occurred_at: item.lastModifiedDateTime ?? item.createdDateTime ?? null,
        metadata: {
          mimeType: item.file?.mimeType ?? null,
          size: typeof item.size === 'number' ? item.size : null,
          isFolder: Boolean(item.folder),
          path: item.parentReference?.path ?? null,
        },
        synced_at: new Date().toISOString(),
      };
    });
  }

  private async fetchRecordings(
    token: string,
    batch: number,
  ): Promise<StoredM365Item[]> {
    // Meeting recordings live on the beta surface via getAllRecordings.
    const url = `${GRAPH_BETA_API}/me/onlineMeetings/getAllRecordings?$top=${batch}`;
    const list = await this.graphFetch<GraphListResponse<GraphCallRecording>>(
      url,
      token,
    );
    return (list.value ?? []).map((rec) => ({
      id: `teams_recording:${rec.id}`,
      source: 'teams_recording' as const,
      title: rec.meetingId ? `Teams meeting ${rec.meetingId}` : 'Teams meeting recording',
      body: rec.content ?? null,
      web_url: rec.recordingContentUrl ?? null,
      author: this.identityName(rec.meetingOrganizer),
      participants: null,
      occurred_at: rec.createdDateTime ?? null,
      metadata: { meetingId: rec.meetingId ?? null },
      synced_at: new Date().toISOString(),
    }));
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const credentials = await this.loadCredentials<Microsoft365Credentials>();

    if (!credentials?.access_token && !credentials?.refresh_token) {
      throw new Error(
        'No saved Microsoft 365 credentials were found. Connect Microsoft 365 in the frontend first.',
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
        'Saved Microsoft 365 access token has expired and no refresh token is stored. Reconnect Microsoft 365 in the frontend.',
      );
    }

    return this.refreshAccessToken(credentials);
  }

  private async refreshAccessToken(
    credentials: Microsoft365Credentials,
  ): Promise<string> {
    const clientId =
      credentials.client_id ?? this.config.get<string>('MICROSOFT_CLIENT_ID');
    const clientSecret =
      credentials.client_secret ??
      this.config.get<string>('MICROSOFT_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET to refresh Microsoft 365 token.',
      );
    }

    if (!credentials.refresh_token) {
      throw new Error(
        'Cannot refresh Microsoft 365 token: no refresh_token saved.',
      );
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credentials.refresh_token,
    });
    if (credentials.scope) body.set('scope', credentials.scope);

    const res = await fetch(this.tokenUrl(credentials.tenant), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(
        `Microsoft 365 token refresh failed: ${res.status} ${await res.text()}`,
      );
    }

    const tokens = (await res.json()) as MicrosoftTokenResponse;
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
      'Refreshed Microsoft 365 access token using stored refresh_token.',
    );
    return tokens.access_token;
  }

  protected async ensureRawTable(): Promise<void> {
    await this.executeSupabaseSql(
      TABLE,
      `
create table if not exists public.${TABLE} (
  id text primary key,
  source text not null,
  title text,
  body text,
  web_url text,
  author text,
  participants text,
  occurred_at timestamptz,
  metadata jsonb,
  synced_at timestamptz not null default now()
);

create index if not exists ${TABLE}_source_idx on public.${TABLE} (source);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async graphFetch<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Microsoft Graph API ${res.status} for ${url}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  private addressName(addr: GraphEmailAddress | undefined): string | null {
    if (!addr?.emailAddress) return null;
    return addr.emailAddress.name ?? addr.emailAddress.address ?? null;
  }

  private identityName(identity: GraphIdentity | undefined): string | null {
    if (!identity) return null;
    return (
      identity.user?.displayName ??
      identity.user?.email ??
      identity.application?.displayName ??
      null
    );
  }

  private embedText(item: StoredM365Item): string {
    const lines: string[] = [
      `${this.sourceLabel(item.source)}: ${item.title ?? '(untitled)'}`,
    ];
    if (item.author) lines.push(`from: ${item.author}`);
    if (item.participants) lines.push(`participants: ${item.participants}`);
    const body = this.toPlainText(item.body);
    if (body) lines.push(body);
    if (item.source === 'onedrive' || item.source === 'sharepoint') {
      const path = (item.metadata?.path as string | undefined) ?? null;
      if (path) lines.push(`path: ${path}`);
    }
    return lines.join('\n').trim();
  }

  private sourceLabel(source: Microsoft365Source): string {
    switch (source) {
      case 'outlook':
        return 'Email';
      case 'calendar':
        return 'Calendar event';
      case 'onedrive':
        return 'OneDrive file';
      case 'sharepoint':
        return 'SharePoint file';
      case 'teams_recording':
        return 'Teams recording';
      default:
        return 'Item';
    }
  }

  /**
   * Strip HTML tags + decode common entities so the embedding model and prompt
   * see prose rather than markup. Outlook bodies are frequently HTML.
   */
  protected toPlainText(input: string | null | undefined): string {
    if (!input) return '';
    let s = input;
    s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|br)\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }
}
