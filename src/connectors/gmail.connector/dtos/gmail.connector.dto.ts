import type { ConnectorCredentials } from '../../connector.interface';

export type GmailListResponse = {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
};

export type GmailHeader = { name: string; value: string };

export type GmailMessage = {
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

export type StoredMessage = {
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

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export type GmailCredentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_type?: string;
};

export type GmailSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};
