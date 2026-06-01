import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  DriveFile,
  DriveListResponse,
  DriveUser,
  GoogleDriveCredentials,
  GoogleDriveSession,
  GoogleTokenResponse,
  StoredFile,
} from './dtos/googledrive.connector.dto';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TABLE = 'googledrive_files';

const FILE_FIELDS =
  'id,name,mimeType,size,webViewLink,iconLink,createdTime,modifiedTime,parents,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),trashed';

const MAX_CONTENT_BYTES = 100_000;

const GOOGLE_EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
};

@Injectable()
export class GoogleDriveConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'googledrive';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(GoogleDriveConnectorService.name);
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
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

  /**
   * Not used by this connector. Google Drive's sync can produce thousands of
   * files, which is too much to fetch content for, embed, and write in a single
   * pass without hanging. We override syncData() below to chunk the work; each
   * chunk is still atomic on its own and a failed run resumes cleanly because
   * already-embedded ids are skipped on the next run.
   */
  protected fetchPayload(): Promise<ConnectorSyncPayload> {
    return Promise.reject(
      new Error(
        'GoogleDriveConnectorService.fetchPayload is not used; call syncData() (chunked).',
      ),
    );
  }

  async syncData(): Promise<void> {
    const token = await this.getAccessToken();

    const fetched = await this.listAllDriveFiles(token);
    if (fetched.length === 0) return;

    const alreadyEmbedded = await this.getExistingEmbeddedIds(
      fetched.map((f) => f.id),
    );
    const todo = fetched.filter((item) => !alreadyEmbedded.has(item.id));

    if (todo.length === 0) {
      this.logger.log('No new Google Drive files to sync.');
      return;
    }

    const chunkSize = Math.max(
      1,
      Number(this.config.get<string>('GOOGLEDRIVE_SYNC_CHUNK') ?? '5'),
    );
    const totalChunks = Math.ceil(todo.length / chunkSize);
    this.logger.log(
      `Syncing ${todo.length} new Google Drive file(s) in ${totalChunks} chunk(s) of up to ${chunkSize}.`,
    );

    let processed = 0;
    for (let i = 0; i < todo.length; i += chunkSize) {
      const chunk = todo.slice(i, i + chunkSize);
      const chunkIndex = Math.floor(i / chunkSize) + 1;

      console.log(
        `[googledrive] Chunking ${chunkIndex}/${totalChunks}: files ${i + 1}-${i + chunk.length} of ${todo.length} (${chunk.length} file(s) in this chunk)`,
      );

      const rows: StoredFile[] = [];
      for (const file of chunk) {
        const content = await this.fetchFileContent(file, token);
        rows.push(this.toRow(file, content));
      }

      const items = rows.map((r) => ({
        text: [
          r.name ?? '(unnamed)',
          `kind: ${r.is_folder ? 'folder' : 'file'}`,
          `mime: ${r.mime_type ?? 'n/a'}`,
          `owner: ${r.owner ?? 'unknown'}`,
          `modified: ${r.modified_at ?? 'unknown'}`,
          ...(r.content ? ['', 'content:', r.content] : []),
        ].join('\n'),
        data_id: r.id,
      }));

      await this.embeddings.syncWithEmbeddings({
        rawTable: TABLE,
        rawRows: rows as unknown as Record<string, unknown>[],
        conflictColumn: 'id',
        embeddingsTable: this.embeddingsTableName,
        items,
        ensureRawTable: () => this.ensureRawTable(),
      });

      processed += chunk.length;
      this.logger.log(
        `Synced chunk ${chunkIndex}/${totalChunks} (${processed}/${todo.length} files).`,
      );
    }

    this.logger.log(
      `Google Drive sync complete: ${processed} new file(s) embedded.`,
    );
  }

  private async listAllDriveFiles(token: string): Promise<DriveFile[]> {
    const pageSize = Math.min(
      Number(this.config.get<string>('GOOGLEDRIVE_SYNC_BATCH') ?? '1000'),
      1000,
    );

    const baseUrl =
      `${DRIVE_API}/files` +
      `?pageSize=${pageSize}` +
      `&orderBy=modifiedTime desc` +
      `&corpora=allDrives` +
      `&includeItemsFromAllDrives=true` +
      `&supportsAllDrives=true` +
      `&q=${encodeURIComponent('trashed = false')}` +
      `&fields=${encodeURIComponent(`files(${FILE_FIELDS}),nextPageToken`)}`;

    const fetched: DriveFile[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const pageUrl = pageToken
        ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}`
        : baseUrl;
      const list = await this.driveFetch<DriveListResponse>(pageUrl, token);
      fetched.push(...(list.files ?? []));
      pageToken = list.nextPageToken;
      pages += 1;
    } while (pageToken);

    this.logger.log(
      `Fetched ${fetched.length} Google Drive file(s) across ${pages} page(s) (My Drive + shared drives).`,
    );
    return fetched;
  }

  async listFiles(limit = 100): Promise<StoredFile[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'id, name, web_url, icon_url, mime_type, size, is_folder, parent_id, created_at, modified_at, owner, modified_by, content, synced_at',
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
      | 'content'
    >[] = [];
    let readSucceeded = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'name, web_url, mime_type, size, is_folder, modified_at, owner, modified_by, content',
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
      return 'No Google Drive files available.';
    }

    const blocks = files.map((f, i) => {
      const kind = f.is_folder ? 'Folder' : 'File';
      const content = (f.content ?? '').trim();
      return [
        `${kind} ${i + 1}:`,
        `  Name: ${f.name ?? '(unnamed)'}`,
        `  Owner: ${f.owner ?? 'unknown'}`,
        `  Modified: ${f.modified_at ?? 'unknown'}`,
        `  Modified by: ${f.modified_by ?? 'unknown'}`,
        `  Mime type: ${f.mime_type ?? 'n/a'}`,
        `  Size: ${f.size ?? 'n/a'}`,
        `  URL: ${f.web_url ?? 'n/a'}`,
        `  Content: ${content || '(unavailable)'}`,
      ].join('\n');
    });

    return [
      'The following are the most recent Google Drive files for this user.',
      'Each entry includes name, owner, modification metadata, a link, and the extracted document content when available.',
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

  protected async ensureRawTable(): Promise<void> {
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
  content text,
  synced_at timestamptz not null default now()
);

alter table public.${TABLE} add column if not exists content text;

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

  private toRow(file: DriveFile, content: string | null): StoredFile {
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
      content,
      synced_at: new Date().toISOString(),
    };
  }

  private async fetchFileContent(
    file: DriveFile,
    token: string,
  ): Promise<string | null> {
    const mime = file.mimeType;
    if (!mime || mime === 'application/vnd.google-apps.folder') return null;

    let url: string;
    if (mime.startsWith('application/vnd.google-apps.')) {
      const exportMime = GOOGLE_EXPORT_MIME[mime];
      if (!exportMime) return null;
      url =
        `${DRIVE_API}/files/${encodeURIComponent(file.id)}/export` +
        `?mimeType=${encodeURIComponent(exportMime)}` +
        `&supportsAllDrives=true`;
    } else if (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      mime === 'application/xml'
    ) {
      url =
        `${DRIVE_API}/files/${encodeURIComponent(file.id)}` +
        `?alt=media&supportsAllDrives=true`;
    } else {
      return null;
    }

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        this.logger.warn(
          `Google Drive content fetch ${res.status} for ${file.id} (${file.name ?? 'unnamed'})`,
        );
        return null;
      }
      const text = await res.text();
      if (text.length > MAX_CONTENT_BYTES) {
        return text.slice(0, MAX_CONTENT_BYTES);
      }
      return text;
    } catch (err) {
      this.logger.warn(
        `Google Drive content fetch failed for ${file.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private userName(user: DriveUser | undefined): string | null {
    if (!user) return null;
    return user.displayName ?? user.emailAddress ?? null;
  }
}
