import type { ConnectorCredentials } from '../../connector.interface';

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export type DriveUser = {
  displayName?: string;
  emailAddress?: string;
};

export type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  iconLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  parents?: string[];
  owners?: DriveUser[];
  lastModifyingUser?: DriveUser;
  trashed?: boolean;
};

export type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
};

export type StoredFile = {
  id: string;
  name: string | null;
  web_url: string | null;
  icon_url: string | null;
  mime_type: string | null;
  size: number | null;
  is_folder: boolean;
  parent_id: string | null;
  created_at: string | null;
  modified_at: string | null;
  owner: string | null;
  modified_by: string | null;
  synced_at: string;
};

export type GoogleDriveCredentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_type?: string;
};

export type GoogleDriveSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};
