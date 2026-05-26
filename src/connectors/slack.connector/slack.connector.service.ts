import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectorInterface,
  ConnectorSyncPayload,
} from '../connector.interface';
import { EmbeddingsService } from '../../embeddings/embeddings.service';
import type {
  SlackConversation,
  SlackCredentials,
  SlackHistoryResponse,
  SlackListChannelsResponse,
  SlackMessageItem,
  SlackOAuthV2Response,
  SlackSession,
  SlackUser,
  SlackUsersInfoResponse,
  StoredSlackMessage,
} from './dtos/slack.connector.dto';

const SLACK_API = 'https://slack.com/api';
const TABLE = 'slack_messages';

type MessageWithConversation = SlackMessageItem & {
  __channel: SlackConversation;
};

@Injectable()
export class SlackConnectorService extends ConnectorInterface {
  protected readonly connectorName = 'slack';
  protected readonly rawTableName = TABLE;
  private readonly logger = new Logger(SlackConnectorService.name);
  /** Cache user lookups for the lifetime of the process. */
  private readonly userCache = new Map<string, SlackUser>();

  constructor(
    private readonly config: ConfigService,
    embeddings: EmbeddingsService,
  ) {
    super(embeddings);
  }

  async exchangeAndSaveCode(
    code: string,
    redirectUri: string,
  ): Promise<boolean> {
    const clientId = this.config.get<string>('SLACK_CLIENT_ID');
    const clientSecret = this.config.get<string>('SLACK_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET in the backend env.',
      );
    }

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(
        `Slack OAuth exchange failed: ${res.status} ${await res.text()}`,
      );
    }

    const data = (await res.json()) as SlackOAuthV2Response;
    if (!data.ok || !data.access_token) {
      throw new Error(
        `Slack OAuth returned error: ${data.error ?? 'unknown_error'}`,
      );
    }

    return this.saveCredentials({
      access_token: data.access_token,
      token_type: data.token_type ?? 'bot',
      scope: data.scope,
      bot_user_id: data.bot_user_id,
      app_id: data.app_id,
      team_id: data.team?.id,
      team_name: data.team?.name,
    });
  }

  async getSession(): Promise<SlackSession> {
    const credentials = await this.loadCredentials<SlackCredentials>();
    const connected = Boolean(credentials?.access_token);
    // Slack bot tokens issued by oauth.v2.access don't have a built-in expiry
    // (token rotation is opt-in per app). Treat them as long-lived.
    return {
      connected,
      expired: false,
      expires_at: null,
      scope: credentials?.scope ?? null,
      token_type: credentials?.token_type ?? null,
      team_id: credentials?.team_id ?? null,
      team_name: credentials?.team_name ?? null,
    };
  }

  protected async fetchPayload(): Promise<ConnectorSyncPayload> {
    const credentials = await this.loadCredentials<SlackCredentials>();
    if (!credentials?.access_token) {
      throw new Error(
        'No saved Slack bot token. Connect Slack in the frontend first.',
      );
    }
    const token = credentials.access_token;

    const perChannel = Number(
      this.config.get<string>('SLACK_PER_CHANNEL_LIMIT') ?? '20',
    );
    const maxChannels = Number(
      this.config.get<string>('SLACK_MAX_CHANNELS') ?? '20',
    );

    // 1. Discover conversations the bot can read (public, private it joined,
    //    DMs to the bot, group DMs the bot is in).
    const conversations = (await this.listConversations(token)).slice(
      0,
      maxChannels,
    );

    // 2. Fetch recent history for each conversation.
    const all: MessageWithConversation[] = [];
    for (const conv of conversations) {
      if (conv.is_archived) continue;
      try {
        const history = await this.slackFetch<SlackHistoryResponse>(
          `${SLACK_API}/conversations.history?channel=${encodeURIComponent(conv.id)}&limit=${perChannel}`,
          token,
        );
        if (!history.ok) {
          this.logger.warn(
            `Slack conversations.history failed for ${conv.id}: ${history.error}`,
          );
          continue;
        }
        for (const m of history.messages ?? []) {
          all.push({ ...m, __channel: conv });
        }
      } catch (err) {
        this.logger.warn(
          `Skipping channel ${conv.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (all.length === 0) {
      this.logger.log(
        'No Slack messages available. Invite the bot to channels you want synced.',
      );
      return { rawTable: TABLE, rawRows: [], conflictColumn: 'id', items: [] };
    }

    // 3. Skip messages already embedded.
    const candidateIds = all.map((m) => `${m.__channel.id}:${m.ts}`);
    const already = await this.getExistingEmbeddedIds(candidateIds);
    const newMessages = all.filter(
      (m) => !already.has(`${m.__channel.id}:${m.ts}`),
    );

    if (newMessages.length === 0) {
      this.logger.log('No new Slack messages to sync.');
      return { rawTable: TABLE, rawRows: [], conflictColumn: 'id', items: [] };
    }

    // 4. Resolve user names for nicer embedding text (cached across calls).
    const userIds = Array.from(
      new Set(
        newMessages
          .map((m) => m.user)
          .filter(
            (u): u is string =>
              typeof u === 'string' && !this.userCache.has(u),
          ),
      ),
    );
    for (const uid of userIds) {
      try {
        const u = await this.slackFetch<SlackUsersInfoResponse>(
          `${SLACK_API}/users.info?user=${encodeURIComponent(uid)}`,
          token,
        );
        if (u.ok && u.user) this.userCache.set(uid, u.user);
      } catch {
        // Ignore user lookup failures — we'll fall back to the raw user id.
      }
    }

    // 5. Build raw rows + embedding items.
    const rows = newMessages.map((m) => this.toRow(m));
    const items = rows
      .map((r) => {
        const channelLabel = r.channel_name
          ? `#${r.channel_name}`
          : r.channel_type;
        const author = r.user_name ?? r.user_id ?? '(unknown)';
        const text = (r.text ?? '').trim();
        return {
          text: text ? `[${channelLabel}] ${author}: ${text}` : '',
          data_id: r.id,
        };
      })
      .filter((it) => it.text.length > 0);

    this.logger.log(
      `Prepared ${rows.length} Slack message(s) (${items.length} embeddable) for atomic sync.`,
    );

    return {
      rawTable: TABLE,
      rawRows: rows as unknown as Record<string, unknown>[],
      conflictColumn: 'id',
      items,
    };
  }

  async listMessages(limit = 100): Promise<StoredSlackMessage[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await this.supabase
        .from(TABLE)
        .select(
          'id, channel_id, channel_name, channel_type, ts, thread_ts, user_id, user_name, text, sent_at, synced_at',
        )
        .order('sent_at', { ascending: false })
        .limit(limit);

      if (!error) return (data ?? []) as StoredSlackMessage[];

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
      this.config.get<string>('SLACK_PROMPT_LIMIT') ?? '20',
    );
    const rows = await this.listMessages(limit);
    if (rows.length === 0) return 'No Slack messages available.';

    const blocks = rows.map((r, i) => {
      const channelLabel = r.channel_name
        ? `#${r.channel_name}`
        : r.channel_type;
      return [
        `Message ${i + 1}:`,
        `  Channel: ${channelLabel}`,
        `  From: ${r.user_name ?? r.user_id ?? '(unknown)'}`,
        `  Sent: ${r.sent_at ?? 'unknown'}`,
        `  Text: ${r.text ?? ''}`,
      ].join('\n');
    });

    return [
      'The following are recent Slack messages for this user.',
      'Each entry includes channel, sender, and the message text.',
      '',
      blocks.join('\n\n'),
    ].join('\n');
  }

  protected async ensureRawTable(): Promise<void> {
    await this.executeSupabaseSql(
      TABLE,
      `
create table if not exists public.${TABLE} (
  id text primary key,
  channel_id text not null,
  channel_name text,
  channel_type text not null,
  ts text not null,
  thread_ts text,
  user_id text,
  user_name text,
  text text,
  sent_at timestamptz,
  synced_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.${TABLE} to anon, authenticated, service_role;

notify pgrst, 'reload schema';
      `.trim(),
    );
  }

  private async listConversations(
    token: string,
  ): Promise<SlackConversation[]> {
    const types = 'public_channel,private_channel,im,mpim';
    const res = await this.slackFetch<SlackListChannelsResponse>(
      `${SLACK_API}/conversations.list?types=${types}&exclude_archived=true&limit=200`,
      token,
    );
    if (!res.ok) {
      throw new Error(`Slack conversations.list failed: ${res.error}`);
    }
    return res.channels ?? [];
  }

  private async slackFetch<T>(url: string, token: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(
        `Slack API ${res.status} for ${url}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  private toRow(m: MessageWithConversation): StoredSlackMessage {
    const tsNum = Number(m.ts);
    const sentAt = Number.isFinite(tsNum)
      ? new Date(tsNum * 1000).toISOString()
      : null;

    return {
      id: `${m.__channel.id}:${m.ts}`,
      channel_id: m.__channel.id,
      channel_name: this.channelLabel(m.__channel),
      channel_type: this.channelType(m.__channel),
      ts: m.ts,
      thread_ts: m.thread_ts ?? null,
      user_id: m.user ?? m.bot_id ?? null,
      user_name: this.userLabel(m.user),
      text: m.text ?? null,
      sent_at: sentAt,
      synced_at: new Date().toISOString(),
    };
  }

  private channelLabel(c: SlackConversation): string | null {
    if (c.name) return c.name;
    if (c.is_im) return 'DM';
    if (c.is_mpim) return 'group-DM';
    return null;
  }

  private channelType(c: SlackConversation): StoredSlackMessage['channel_type'] {
    if (c.is_im) return 'im';
    if (c.is_mpim) return 'mpim';
    if (c.is_private || c.is_group) return 'private';
    return 'channel';
  }

  private userLabel(uid: string | undefined): string | null {
    if (!uid) return null;
    const u = this.userCache.get(uid);
    if (!u) return uid;
    return (
      u.profile?.display_name ||
      u.profile?.real_name ||
      u.real_name ||
      u.name ||
      uid
    );
  }
}
