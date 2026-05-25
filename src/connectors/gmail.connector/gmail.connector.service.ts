import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorCredentials,
  ConnectorInterface,
} from '../connector.interface';

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
};

@Injectable()
export class GmailConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'gmail';
  private readonly logger = new Logger(GmailConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(private readonly config: ConfigService) {
    super();
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

  async getSession(): Promise<GmailSession> {
    const credentials = await this.loadCredentials<GmailCredentials>();
    const expiresAt =
      typeof credentials?.expires_at === 'number' ? credentials.expires_at : null;
    const connected = Boolean(credentials?.access_token);
    const expired = Boolean(expiresAt && Date.now() >= expiresAt);

    return {
      connected,
      expired,
      expires_at: expiresAt,
      scope: credentials?.scope ?? null,
      token_type: credentials?.token_type ?? null,
    };
  }

  async syncData(): Promise<void> {
    const token = await this.getAccessToken();

    const maxResults = Number(
      this.config.get<string>('GMAIL_SYNC_BATCH') ?? '50',
    );

    const existingIds = await this.getExistingMessageIds();
    const list = await this.gmailFetch<GmailListResponse>(
      `${GMAIL_API}/messages?maxResults=${maxResults}`,
      token,
    );

    const newRefs = (list.messages ?? []).filter((m) => !existingIds.has(m.id));
    if (newRefs.length === 0) {
      this.logger.log('No new Gmail messages to sync.');
      return;
    }

    const rows: StoredMessage[] = [];
    for (const ref of newRefs) {
      const full = await this.gmailFetch<GmailMessage>(
        `${GMAIL_API}/messages/${ref.id}?format=full`,
        token,
      );
      rows.push(this.toRow(full));
    }

    await this.upsertMessages(rows);
    this.logger.log(`Synced ${rows.length} new Gmail message(s).`);
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
        await this.createGmailMessagesTable();
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
        await this.createGmailMessagesTable();
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

    if (!credentials?.access_token) {
      throw new Error(
        'No saved Gmail access token was found. Connect Gmail in the frontend first.',
      );
    }

    if (credentials.expires_at && Date.now() >= credentials.expires_at) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      throw new Error(
        'Saved Gmail access token has expired. Reconnect Gmail in the frontend.',
      );
    }

    this.accessToken = credentials.access_token;
    this.accessTokenExpiresAt = credentials.expires_at ?? Number.MAX_SAFE_INTEGER;
    return this.accessToken;
  }

  private async getExistingMessageIds(): Promise<Set<string>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase.from(TABLE).select('id');

      if (!error) {
        return new Set((data ?? []).map((r: { id: string }) => r.id));
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createGmailMessagesTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase read failed: ${error.message}`);
    }

    throw new Error(
      `Supabase read failed: ${TABLE} was created but is not available in the schema cache yet.`,
    );
  }

  private async upsertMessages(rows: StoredMessage[]): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error } = await this.supabase
        .from(TABLE)
        .upsert(rows, { onConflict: 'id' });

      if (!error) {
        return;
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createGmailMessagesTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    throw new Error(
      `Supabase upsert failed: ${TABLE} was created but is not available in the schema cache yet.`,
    );
  }

  private async createGmailMessagesTable(): Promise<void> {
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
}
