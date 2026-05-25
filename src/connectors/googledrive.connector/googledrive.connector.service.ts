import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorCredentials,
  ConnectorInterface,
} from '../connector.interface';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TABLE = 'googledrive_files';

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

const FILE_FIELDS =
  'id,name,mimeType,size,webViewLink,iconLink,createdTime,modifiedTime,parents,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),trashed';

type DriveUser = {
  displayName?: string;
  emailAddress?: string;
};

type DriveFile = {
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

type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
};

type StoredFile = {
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

type GoogleDriveCredentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_type?: string;
};

type GoogleDriveSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};

@Injectable()
export class GoogleDriveConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'googledrive';
  private readonly logger = new Logger(GoogleDriveConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(private readonly config: ConfigService) {
    super();
  }

  async saveOAuthCredentials(
    credentials: GoogleDriveCredentials,
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

  async getSession(): Promise<GoogleDriveSession> {
    const credentials = await this.loadCredentials<GoogleDriveCredentials>();
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

  async syncData(): Promise<void> {
    const token = await this.getAccessToken();

    const maxResults = Number(
      this.config.get<string>('GOOGLEDRIVE_SYNC_BATCH') ?? '50',
    );

    const existingIds = await this.getExistingFileIds();
    const url =
      `${DRIVE_API}/files` +
      `?pageSize=${maxResults}` +
      `&orderBy=modifiedTime desc` +
      `&q=${encodeURIComponent('trashed = false')}` +
      `&fields=${encodeURIComponent(`files(${FILE_FIELDS}),nextPageToken`)}`;

    const list = await this.driveFetch<DriveListResponse>(url, token);
    const items = list.files ?? [];
    const newItems = items.filter((item) => !existingIds.has(item.id));
    if (newItems.length === 0) {
      this.logger.log('No new Google Drive files to sync.');
      return;
    }

    const rows = newItems.map((item) => this.toRow(item));
    await this.upsertFiles(rows);
    this.logger.log(`Synced ${rows.length} new Google Drive file(s).`);
  }

  async listFiles(limit = 100): Promise<StoredFile[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'id, name, web_url, icon_url, mime_type, size, is_folder, parent_id, created_at, modified_at, owner, modified_by, synced_at',
        )
        .order('modified_at', { ascending: false })
        .limit(limit);

      if (!error) {
        return (data ?? []) as StoredFile[];
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createGoogleDriveFilesTable();
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
      this.config.get<string>('GOOGLEDRIVE_PROMPT_LIMIT') ?? '20',
    );
    await this.getAccessToken();
    let files: Pick<
      StoredFile,
      | 'name'
      | 'web_url'
      | 'mime_type'
      | 'size'
      | 'is_folder'
      | 'modified_at'
      | 'owner'
      | 'modified_by'
    >[] = [];
    let readSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'name, web_url, mime_type, size, is_folder, modified_at, owner, modified_by',
        )
        .order('modified_at', { ascending: false })
        .limit(limit);

      if (!error) {
        files = (data ?? []) as typeof files;
        readSucceeded = true;
        break;
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createGoogleDriveFilesTable();
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

    if (files.length === 0) {
      return 'No Google Drive files available.';
    }

    const blocks = files.map((f, i) => {
      const kind = f.is_folder ? 'Folder' : 'File';
      return [
        `${kind} ${i + 1}:`,
        `  Name: ${f.name ?? '(unnamed)'}`,
        `  Owner: ${f.owner ?? 'unknown'}`,
        `  Modified: ${f.modified_at ?? 'unknown'}`,
        `  Modified by: ${f.modified_by ?? 'unknown'}`,
        `  Mime type: ${f.mime_type ?? 'n/a'}`,
        `  Size: ${f.size ?? 'n/a'}`,
        `  URL: ${f.web_url ?? 'n/a'}`,
      ].join('\n');
    });

    return [
      'The following are the most recent Google Drive files for this user.',
      'Each entry includes name, owner, modification metadata and a link.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const credentials = await this.loadCredentials<GoogleDriveCredentials>();

    if (!credentials?.access_token && !credentials?.refresh_token) {
      throw new Error(
        'No saved Google Drive credentials were found. Connect Google Drive in the frontend first.',
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
        'Saved Google Drive access token has expired and no refresh token is stored. Reconnect Google Drive in the frontend.',
      );
    }

    return this.refreshAccessToken(credentials);
  }

  private async refreshAccessToken(
    credentials: GoogleDriveCredentials,
  ): Promise<string> {
    const clientId =
      credentials.client_id ?? this.config.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret =
      credentials.client_secret ??
      this.config.get<string>('GOOGLE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET to refresh Google Drive token.',
      );
    }

    if (!credentials.refresh_token) {
      throw new Error(
        'Cannot refresh Google Drive token: no refresh_token saved.',
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
        `Google Drive token refresh failed: ${res.status} ${await res.text()}`,
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
      'Refreshed Google Drive access token using stored refresh_token.',
    );
    return tokens.access_token;
  }

  private async getExistingFileIds(): Promise<Set<string>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase.from(TABLE).select('id');

      if (!error) {
        return new Set((data ?? []).map((r: { id: string }) => r.id));
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createGoogleDriveFilesTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase read failed: ${error.message}`);
    }

    throw new Error(
      `Supabase read failed: ${TABLE} was created but is not available in the schema cache yet.`,
    );
  }

  private async upsertFiles(rows: StoredFile[]): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error } = await this.supabase
        .from(TABLE)
        .upsert(rows, { onConflict: 'id' });

      if (!error) {
        return;
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createGoogleDriveFilesTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    throw new Error(
      `Supabase upsert failed: ${TABLE} was created but is not available in the schema cache yet.`,
    );
  }

  private async createGoogleDriveFilesTable(): Promise<void> {
    await this.executeSupabaseSql(
      TABLE,
      `
create table if not exists public.${TABLE} (
  id text primary key,
  name text,
  web_url text,
  icon_url text,
  mime_type text,
  size bigint,
  is_folder boolean not null default false,
  parent_id text,
  created_at timestamptz,
  modified_at timestamptz,
  owner text,
  modified_by text,
  synced_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async driveFetch<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Google Drive API ${res.status} for ${url}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  private toRow(file: DriveFile): StoredFile {
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    const size = file.size ? Number(file.size) : null;

    return {
      id: file.id,
      name: file.name ?? null,
      web_url: file.webViewLink ?? null,
      icon_url: file.iconLink ?? null,
      mime_type: file.mimeType ?? null,
      size: Number.isFinite(size as number) ? size : null,
      is_folder: isFolder,
      parent_id: file.parents?.[0] ?? null,
      created_at: file.createdTime ?? null,
      modified_at: file.modifiedTime ?? null,
      owner: this.userName(file.owners?.[0]),
      modified_by: this.userName(file.lastModifyingUser),
      synced_at: new Date().toISOString(),
    };
  }

  private userName(user: DriveUser | undefined): string | null {
    if (!user) return null;
    return user.displayName ?? user.emailAddress ?? null;
  }
}
