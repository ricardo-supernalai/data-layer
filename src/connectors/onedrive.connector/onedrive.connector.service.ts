import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  GraphDriveItem,
  GraphIdentity,
  GraphListResponse,
  OneDriveCredentials,
  OneDriveSession,
  StoredFile,
} from './dtos/onedrive.connector.dto';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const MICROSOFT_TOKEN_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const TABLE = 'onedrive_files';

@Injectable()
export class OneDriveConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'onedrive';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(OneDriveConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
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

  protected async fetchPayload(): Promise<ConnectorSyncPayload> {
    const token = await this.getAccessToken();

    const maxResults = Number(
      this.config.get<string>('ONEDRIVE_SYNC_BATCH') ?? '50',
    );

    const list = await this.graphFetch<GraphListResponse<GraphDriveItem>>(
      `${GRAPH_API}/me/drive/recent?$top=${maxResults}`,
      token,
    );

    const fetched = list.value ?? [];
    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      fetched.map((f) => f.id),
    );
    const newItems = fetched.filter((item) => !alreadyEmbedded.has(item.id));

    if (newItems.length === 0) {
      this.logger.log('No new OneDrive files to sync.');
      return {
        rawTable: TABLE,
        rawRows: [],
        conflictColumn: 'id',
        items: [],
      };
    }

    const rows = newItems.map((item) => this.toRow(item));
    const items = rows.map((r) => ({
      text: [
        r.name ?? '(unnamed)',
        `kind: ${r.is_folder ? 'folder' : 'file'}`,
        `mime: ${r.mime_type ?? 'n/a'}`,
        `path: ${r.parent_path ?? 'unknown'}`,
        `modified: ${r.modified_at ?? 'unknown'}`,
        `modified_by: ${r.modified_by ?? 'unknown'}`,
      ].join('\n'),
      data_id: r.id,
    }));

    this.logger.log(
      `Prepared ${rows.length} OneDrive file(s) for atomic sync.`,
    );

    return {
      rawTable: TABLE,
      rawRows: rows as unknown as Record<string, unknown>[],
      conflictColumn: 'id',
      items,
    };
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

  protected async ensureRawTable(): Promise<void> {
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
