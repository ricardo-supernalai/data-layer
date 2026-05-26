import type { ConnectorCredentials } from '../../connector.interface';

/** Response shape from POST https://slack.com/api/oauth.v2.access. */
export type SlackOAuthV2Response = {
  ok: boolean;
  error?: string;
  access_token?: string; // xoxb-…
  token_type?: string; // 'bot'
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name: string };
  enterprise?: { id?: string; name?: string } | null;
  authed_user?: { id: string };
};

export type SlackCredentials = ConnectorCredentials & {
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team_id?: string;
  team_name?: string;
};

export type SlackSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  team_id: string | null;
  team_name: string | null;
};

/** Slack `conversations.list` entry — channel, DM, group DM, or private channel. */
export type SlackConversation = {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  is_archived?: boolean;
  /** For IMs: the other user's id. */
  user?: string;
};

export type SlackMessageItem = {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
};

export type SlackUser = {
  id: string;
  name?: string;
  real_name?: string;
  profile?: {
    real_name?: string;
    display_name?: string;
    email?: string;
  };
};

export type SlackListChannelsResponse = {
  ok: boolean;
  error?: string;
  channels?: SlackConversation[];
  response_metadata?: { next_cursor?: string };
};

export type SlackHistoryResponse = {
  ok: boolean;
  error?: string;
  messages?: SlackMessageItem[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

export type SlackUsersInfoResponse = {
  ok: boolean;
  error?: string;
  user?: SlackUser;
};

/**
 * Raw row stored in `slack_messages`. The PK is the composite `channel:ts`
 * because a Slack message's `ts` is only unique within a channel.
 */
export type StoredSlackMessage = {
  id: string; // `${channel_id}:${ts}`
  channel_id: string;
  channel_name: string | null;
  channel_type: 'channel' | 'private' | 'im' | 'mpim';
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  user_name: string | null;
  text: string | null;
  sent_at: string | null;
  synced_at: string;
};
