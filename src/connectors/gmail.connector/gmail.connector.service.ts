import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectorInterface } from '../connector.interface';
import { SupabaseService } from '../../supabase/supabase.service';

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

@Injectable()
export class GmailConnectorService extends ConnectorInterface {
  private readonly logger = new Logger(GmailConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    super();
  }

  async oauthConnect(): Promise<boolean> {
    const clientId = this.config.get<string>('GMAIL_CLIENT_ID');
    const clientSecret = this.config.get<string>('GMAIL_CLIENT_SECRET');
    const refreshToken = this.config.get<string>('GMAIL_REFRESH_TOKEN');

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        'GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN must be set in the environment.',
      );
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      this.logger.error(
        `OAuth refresh failed: ${res.status} ${await res.text()}`,
      );
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      return false;
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + (json.expires_in - 60) * 1000;
    this.logger.log('Gmail OAuth access token refreshed.');
    return true;
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

    const { error } = await this.supabase
      .getClient()
      .from(TABLE)
      .upsert(rows, { onConflict: 'id' });
    if (error) {
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }
    this.logger.log(`Synced ${rows.length} new Gmail message(s).`);
  }

  async dataToPrompt(): Promise<string> {
    const limit = Number(
      this.config.get<string>('GMAIL_PROMPT_LIMIT') ?? '20',
    );
    const { data, error } = await this.supabase
      .getClient()
      .from(TABLE)
      .select('subject, from_addr, to_addr, sent_at, snippet, body')
      .order('sent_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Supabase read failed: ${error.message}`);
    }
    if (!data || data.length === 0) {
      return 'No Gmail messages available.';
    }

    const blocks = data.map((m, i) => {
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
    const ok = await this.oauthConnect();
    if (!ok || !this.accessToken) {
      throw new Error('Gmail OAuth connection failed.');
    }
    return this.accessToken;
  }

  private async getExistingMessageIds(): Promise<Set<string>> {
    const { data, error } = await this.supabase
      .getClient()
      .from(TABLE)
      .select('id');
    if (error) {
      throw new Error(`Supabase read failed: ${error.message}`);
    }
    return new Set((data ?? []).map((r: { id: string }) => r.id));
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
