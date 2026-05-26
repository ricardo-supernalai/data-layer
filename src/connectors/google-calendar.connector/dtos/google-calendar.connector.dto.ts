import type { ConnectorCredentials } from '../../connector.interface';

export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

export type CalendarEventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type CalendarUser = {
  id?: string;
  email?: string;
  displayName?: string;
  self?: boolean;
};

export type CalendarAttendee = CalendarUser & {
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
};

export type CalendarEvent = {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  created?: string;
  updated?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  organizer?: CalendarUser;
  creator?: CalendarUser;
  attendees?: CalendarAttendee[];
  hangoutLink?: string;
  recurringEventId?: string;
  iCalUID?: string;
};

export type CalendarEventListResponse = {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export type StoredEvent = {
  id: string;
  calendar_id: string;
  status: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  html_link: string | null;
  hangout_link: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  organizer: string | null;
  creator: string | null;
  attendees: string | null;
  recurring_event_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string;
};

export type GoogleCalendarCredentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_type?: string;
};

export type GoogleCalendarSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};
