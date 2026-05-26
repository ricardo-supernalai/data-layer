import type { ConnectorCredentials } from '../../connector.interface';

export type GraphIdentity = {
  user?: { displayName?: string; email?: string };
  application?: { displayName?: string };
};

export type GraphDriveItem = {
  id: string;
  name?: string;
  webUrl?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string; driveId?: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  createdBy?: GraphIdentity;
  lastModifiedBy?: GraphIdentity;
};

export type GraphListResponse<T> = {
  value?: T[];
  '@odata.nextLink'?: string;
};

export type StoredFile = {
  id: string;
  name: string | null;
  web_url: string | null;
  mime_type: string | null;
  size: number | null;
  is_folder: boolean;
  parent_path: string | null;
  created_at: string | null;
  modified_at: string | null;
  created_by: string | null;
  modified_by: string | null;
  synced_at: string;
};

export type OneDriveCredentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_type?: string;
};

export type OneDriveSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
};
