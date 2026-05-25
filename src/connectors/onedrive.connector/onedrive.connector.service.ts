import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorCredentials,
  ConnectorInterface,
} from '../connector.interface';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const MICROSOFT_TOKEN_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const TABLE = 'onedrive_files';

type GraphIdentity = {
  user?: { displayName?: string; email?: string };
  application?: { displayName?: string };
};

type GraphDriveItem = {
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

type GraphListResponse<T> = {
  value?: T[];
  '@odata.nextLink'?: string;
};

type StoredFile = {
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

type OneDriveCredentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_type?: string;
};

type OneDriveSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
};

@Injectable()
export class OneDriveConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'onedrive';
  private readonly logger = new Logger(OneDriveConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(private readonly config: ConfigService) {
    super();
  }

  async saveOAuthCredentials(
    credentials: OneDriveCredentials,
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

  async getSession(): Promise<OneDriveSession> {
    const credentials = await this.loadCredentials<OneDriveCredentials>();
    const expiresAt =
      typeof credentials?.expires_at === 'number'
        ? credentials.expires_at
        : null;
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
      this.config.get<string>('ONEDRIVE_SYNC_BATCH') ?? '50',
    );

    const existingIds = await this.getExistingFileIds();
    const list = await this.graphFetch<GraphListResponse<GraphDriveItem>>(
      `${GRAPH_API}/me/drive/recent?$top=${maxResults}`,
      token,
    );

    const items = list.value ?? [];
    const newItems = items.filter((item) => !existingIds.has(item.id));
    if (newItems.length === 0) {
      this.logger.log('No new OneDrive files to sync.');
      return;
    }

    const rows = newItems.map((item) => this.toRow(item));
    await this.upsertFiles(rows);
    this.logger.log(`Synced ${rows.length} new OneDrive file(s).`);
  }

  async listFiles(limit = 100): Promise<StoredFile[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'id, name, web_url, mime_type, size, is_folder, parent_path, created_at, modified_at, created_by, modified_by, synced_at',
        )
        .order('modified_at', { ascending: false })
        .limit(limit);

      if (!error) {
        return (data ?? []) as StoredFile[];
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createOneDriveFilesTable();
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
      this.config.get<string>('ONEDRIVE_PROMPT_LIMIT') ?? '20',
    );
    await this.getAccessToken();
    let files: Pick<
      StoredFile,
      | 'name'
      | 'web_url'
      | 'mime_type'
      | 'size'
      | 'is_folder'
      | 'parent_path'
      | 'modified_at'
      | 'modified_by'
    >[] = [];
    let readSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'name, web_url, mime_type, size, is_folder, parent_path, modified_at, modified_by',
        )
        .order('modified_at', { ascending: false })
        .limit(limit);

      if (!error) {
        files = (data ?? []) as typeof files;
        readSucceeded = true;
        break;
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createOneDriveFilesTable();
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
      return 'No OneDrive files available.';
    }

    const blocks = files.map((f, i) => {
      const kind = f.is_folder ? 'Folder' : 'File';
      return [
        `${kind} ${i + 1}:`,
        `  Name: ${f.name ?? '(unnamed)'}`,
        `  Path: ${f.parent_path ?? 'unknown'}`,
        `  Modified: ${f.modified_at ?? 'unknown'}`,
        `  Modified by: ${f.modified_by ?? 'unknown'}`,
        `  Mime type: ${f.mime_type ?? 'n/a'}`,
        `  Size: ${f.size ?? 'n/a'}`,
        `  URL: ${f.web_url ?? 'n/a'}`,
      ].join('\n');
    });

    return [
      'The following are the most recent OneDrive files for this user.',
      'Each entry includes name, path, modification metadata and a link.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const credentials = await this.loadCredentials<OneDriveCredentials>();

    if (!credentials?.access_token) {
      throw new Error(
        'No saved OneDrive access token was found. Connect OneDrive in the frontend first.',
      );
    }

    if (credentials.expires_at && Date.now() >= credentials.expires_at) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      throw new Error(
        'Saved OneDrive access token has expired. Reconnect OneDrive in the frontend.',
      );
    }

    this.accessToken = credentials.access_token;
    this.accessTokenExpiresAt =
      credentials.expires_at ?? Number.MAX_SAFE_INTEGER;
    return this.accessToken;
  }

  private async getExistingFileIds(): Promise<Set<string>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase.from(TABLE).select('id');

      if (!error) {
        return new Set((data ?? []).map((r: { id: string }) => r.id));
      }

      if (this.isMissingTableError(error, TABLE)) {
        await this.createOneDriveFilesTable();
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
        await this.createOneDriveFilesTable();
        await this.waitForSchemaReload();
        continue;
      }

      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    throw new Error(
      `Supabase upsert failed: ${TABLE} was created but is not available in the schema cache yet.`,
    );
  }

  private async createOneDriveFilesTable(): Promise<void> {
    await this.executeSupabaseSql(
      TABLE,
      `
create table if not exists public.${TABLE} (
  id text primary key,
  name text,
  web_url text,
  mime_type text,
  size bigint,
  is_folder boolean not null default false,
  parent_path text,
  created_at timestamptz,
  modified_at timestamptz,
  created_by text,
  modified_by text,
  synced_at timestamptz not null default now()
);

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

  private toRow(item: GraphDriveItem): StoredFile {
    return {
      id: item.id,
      name: item.name ?? null,
      web_url: item.webUrl ?? null,
      mime_type: item.file?.mimeType ?? null,
      size: typeof item.size === 'number' ? item.size : null,
      is_folder: Boolean(item.folder),
      parent_path: item.parentReference?.path ?? null,
      created_at: item.createdDateTime ?? null,
      modified_at: item.lastModifiedDateTime ?? null,
      created_by: this.identityName(item.createdBy),
      modified_by: this.identityName(item.lastModifiedBy),
      synced_at: new Date().toISOString(),
    };
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
}
