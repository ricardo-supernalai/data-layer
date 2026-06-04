import type { ConnectorCredentials } from '../../connector.interface';

/**
 * The Microsoft 365 surfaces this connector pulls into the Vault. Outlook
 * covers email, calendar covers events, drive covers OneDrive + SharePoint
 * files, and teams_recording covers meeting recordings.
 */
export type Microsoft365Source =
  | 'outlook'
  | 'calendar'
  | 'onedrive'
  | 'sharepoint'
  | 'teams_recording';

export type GraphIdentity = {
  user?: { displayName?: string; email?: string };
  application?: { displayName?: string };
};

export type GraphEmailAddress = {
  emailAddress?: { name?: string; address?: string };
};

export type GraphMessage = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphEmailAddress;
  toRecipients?: GraphEmailAddress[];
  receivedDateTime?: string;
  webLink?: string;
};

export type GraphDateTimeZone = { dateTime?: string; timeZone?: string };

export type GraphEvent = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  organizer?: GraphEmailAddress;
  attendees?: GraphEmailAddress[];
  start?: GraphDateTimeZone;
  end?: GraphDateTimeZone;
  location?: { displayName?: string };
  webLink?: string;
  isOnlineMeeting?: boolean;
};

export type GraphDriveItem = {
  id: string;
  name?: string;
  webUrl?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string; driveId?: string; siteId?: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  createdBy?: GraphIdentity;
  lastModifiedBy?: GraphIdentity;
};

export type GraphCallRecording = {
  id: string;
  meetingId?: string;
  meetingOrganizer?: GraphIdentity;
  recordingContentUrl?: string;
  createdDateTime?: string;
  content?: string;
};

export type GraphListResponse<T> = {
  value?: T[];
  '@odata.nextLink'?: string;
};

/** One row of the unified microsoft365_items table. */
export type StoredM365Item = {
  /** Composite key, e.g. "outlook:AAMk...", unique across sources. */
  id: string;
  source: Microsoft365Source;
  /** Email subject, event subject, file name or meeting title. */
  title: string | null;
  /** Email/event body, transcript snippet, or path text — used for embedding. */
  body: string | null;
  web_url: string | null;
  /** Sender, organizer, or last-modifier display name. */
  author: string | null;
  /** Recipients / attendees, comma-joined. */
  participants: string | null;
  /** Sent, start, or last-modified time. */
  occurred_at: string | null;
  /** Source-specific extras (mime type, size, location, etc.). */
  metadata: Record<string, unknown> | null;
  synced_at: string;
};

export type MicrosoftTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

export type Microsoft365Credentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  tenant?: string;
  scope?: string;
  token_type?: string;
};

export type Microsoft365Session = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};
