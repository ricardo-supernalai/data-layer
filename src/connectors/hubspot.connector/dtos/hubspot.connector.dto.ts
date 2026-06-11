import type { ConnectorCredentials } from '../../connector.interface';

/** The four CRM object kinds this connector mirrors into the Vault. */
export type HubSpotObjectType = 'account' | 'deal' | 'contact' | 'pipeline';

/** Generic shape of a CRM v3 object record (companies, deals, contacts). */
export type HubSpotCrmObject = {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
};

export type HubSpotPipelineStage = {
  id: string;
  label: string;
  displayOrder?: number;
  metadata?: Record<string, string>;
};

export type HubSpotPipeline = {
  id: string;
  label: string;
  displayOrder?: number;
  stages?: HubSpotPipelineStage[];
  createdAt?: string;
  updatedAt?: string;
};

export type HubSpotListResponse<T> = {
  results?: T[];
  paging?: { next?: { after?: string; link?: string } };
};

/** Response of POST /crm/v3/objects/{type}/search. */
export type HubSpotSearchResponse<T> = {
  total?: number;
  results?: T[];
  paging?: { next?: { after?: string } };
};

/** One row of the unified hubspot_records table. */
export type StoredHubSpotRecord = {
  /** Composite key, e.g. "deal:12345" — unique across object types. */
  id: string;
  object_type: HubSpotObjectType;
  /** The raw HubSpot object id (without the type prefix). */
  hs_object_id: string;
  /** Display name: company name, deal name, full contact name, or pipeline label. */
  title: string | null;
  /** Contact email, when the record is a contact. */
  email: string | null;
  /** Deal amount, when the record is a deal. */
  amount: number | null;
  /** Deal stage label/id, when the record is a deal. */
  stage: string | null;
  /** Pipeline label/id this record belongs to, when applicable. */
  pipeline: string | null;
  /** Full property bag (or pipeline stage list) as returned by HubSpot. */
  properties: Record<string, unknown> | null;
  updated_at: string | null;
  synced_at: string;
};

export type HubSpotTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
};

export type HubSpotCredentials = ConnectorCredentials & {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  token_type?: string;
};

export type HubSpotSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};
