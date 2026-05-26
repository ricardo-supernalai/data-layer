import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorCredentials,
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TABLE = 'gmail_messages';

type GmailListResponse = {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
};

type GmailHeader = { name: string; value: string };

type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailMessage['payload'][];
  };
};

type StoredMessage = {
  id: string;
  thread_id: string;
  subject: string | null;
  from_addr: string | null;
  to_addr: string | null;
  sent_at: string | null;
  snippet: string | null;
  body: string | null;
  synced_at: string;
};

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

type GmailCredentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_type?: string;
};

type GmailSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};

@Injectable()
export class GmailConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'gmail';
  private readonly logger = new Logger(GmailConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
  }

  async saveOAuthCredentials(credentials: GmailCredentials): Promise<boolean> {
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

  async getSession(): Promise<GmailSession> {
    const credentials = await this.loadCredentials<GmailCredentials>();
    const expiresAt =
      typeof credentials?.expires_at === 'number' ? credentials.expires_at : null;
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

    const maxResults = Number(
      this.config.get<string>('GMAIL_SYNC_BATCH') ?? '50',
    );

    const list = await this.gmailFetch<GmailListResponse>(
      `${GMAIL_API}/messages?maxResults=${maxResults}`,
      token,
    );

    const listed = list.messages ?? [];
    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      listed.map((m) => m.id),
    );
    const newRefs = listed.filter((m) => !alreadyEmbedded.has(m.id));

    if (newRefs.length === 0) {
      this.logger.log('No new Gmail messages to sync.');
      return {
        rawTable: TABLE,
        rawRows: [],
        conflictColumn: 'id',
        items: [],
      };
    }

    const rows: StoredMessage[] = [];
    for (const ref of newRefs) {
      const full = await this.gmailFetch<GmailMessage>(
        `${GMAIL_API}/messages/${ref.id}?format=full`,
        token,
      );
      rows.push(this.toRow(full));
    }

    const items = rows
      .map((r) => {
        const bodyText = this.toPlainText(r.body) || r.snippet || '';
        return {
          text: [r.subject, bodyText]
            .filter((s): s is string => Boolean(s))
            .join('\n\n')
            .trim(),
          data_id: r.id,
        };
      })
      .filter((item) => item.text.length > 0);

    this.logger.log(
      `Prepared ${rows.length} Gmail message(s) (${items.length} embeddable) for atomic sync.`,
    );

    return {
      rawTable: TABLE,
      rawRows: rows as unknown as Record<string, unknown>[],
      conflictColumn: 'id',
      items,
    };
  }

  async listMessages(limit = 100): Promise<StoredMessage[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'id, thread_id, subject, from_addr, to_addr, sent_at, snippet, body, synced_at',
        )
        .order('sent_at', { ascending: false })
        .limit(limit);

      if (!error) {
        return (data ?? []) as StoredMessage[];
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
      this.config.get<string>('GMAIL_PROMPT_LIMIT') ?? '20',
    );
    await this.getAccessToken();
    let messages: Pick<
      StoredMessage,
      'subject' | 'from_addr' | 'to_addr' | 'sent_at' | 'snippet' | 'body'
    >[] = [];
    let readSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select('subject, from_addr, to_addr, sent_at, snippet, body')
        .order('sent_at', { ascending: false })
        .limit(limit);

      if (!error) {
        messages = (data ?? []) as typeof messages;
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

    if (messages.length === 0) {
      return 'No Gmail messages available.';
    }

    const blocks = messages.map((m, i) => {
      const body = (m.body ?? m.snippet ?? '').trim();
      return [
        `Email ${i + 1}:`,
        `  Date: ${m.sent_at ?? 'unknown'}`,
        `  From: ${m.from_addr ?? 'unknown'}`,
        `  To: ${m.to_addr ?? 'unknown'}`,
        `  Subject: ${m.subject ?? '(no subject)'}`,
        `  Body: ${body}`,
      ].join('\n');
    });

    return [
      'The following are the most recent Gmail messages for this user.',
      'Each entry includes sender, recipient, date, subject and body.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const credentials = await this.loadCredentials<GmailCredentials>();

    if (!credentials?.access_token && !credentials?.refresh_token) {
      throw new Error(
        'No saved Gmail credentials were found. Connect Gmail in the frontend first.',
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
        'Saved Gmail access token has expired and no refresh token is stored. Reconnect Gmail in the frontend.',
      );
    }

    return this.refreshAccessToken(credentials);
  }

  private async refreshAccessToken(
    credentials: GmailCredentials,
  ): Promise<string> {
    const clientId =
      credentials.client_id ?? this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret =
      credentials.client_secret ??
      this.config.get<string>('GOOGLE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET to refresh Gmail token.',
      );
    }

    if (!credentials.refresh_token) {
      throw new Error('Cannot refresh Gmail token: no refresh_token saved.');
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
        `Gmail token refresh failed: ${res.status} ${await res.text()}`,
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
    this.logger.log('Refreshed Gmail access token using stored refresh_token.');
    return tokens.access_token;
  }

  protected async ensureRawTable(): Promise<void> {
    await this.executeSupabaseSql(
      TABLE,
      `
create table if not exists public.${TABLE} (
  id text primary key,
  thread_id text not null,
  subject text,
  from_addr text,
  to_addr text,
  sent_at timestamptz,
  snippet text,
  body text,
  synced_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async gmailFetch<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Gmail API ${res.status} for ${url}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  private toRow(msg: GmailMessage): StoredMessage {
    const headers = msg.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
      null;

    const sentAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : null;

    return {
      id: msg.id,
      thread_id: msg.threadId,
      subject: header('Subject'),
      from_addr: header('From'),
      to_addr: header('To'),
      sent_at: sentAt,
      snippet: msg.snippet ?? null,
      body: this.extractBody(msg.payload),
      synced_at: new Date().toISOString(),
    };
  }

  private extractBody(payload: GmailMessage['payload']): string | null {
    if (!payload) return null;
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return this.decodeBase64Url(payload.body.data);
    }
    for (const part of payload.parts ?? []) {
      const found = this.extractBody(part);
      if (found) return found;
    }
    if (payload.body?.data) {
      return this.decodeBase64Url(payload.body.data);
    }
    return null;
  }

  private decodeBase64Url(data: string): string {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  }

  /**
   * Strip HTML tags + decode common entities so the embedding model sees the
   * actual prose, not markup. HTML tokenizes very densely (~2 chars/token),
   * so even moderate-sized HTML emails blow past the 8192-token cap; stripping
   * tags also produces materially better embeddings.
   *
   * Naive regex strip — handles ~all real Gmail bodies; doesn't try to
   * preserve formatting or handle malformed nesting.
   */
  private toPlainText(input: string | null): string {
    if (!input) return '';
    let s = input;
    // Drop <script> and <style> blocks entirely (content is not prose).
    s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    // Drop HTML comments.
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    // Replace block-level closes with newlines so paragraphs stay readable.
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|br)\s*\/?>/gi, '\n');
    // Strip all remaining tags.
    s = s.replace(/<[^>]+>/g, ' ');
    // Decode the handful of entities that actually show up in Gmail bodies.
    s = s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
    // Collapse runs of whitespace.
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }
}
