import type { ConnectorCredentials } from '../../connector.interface';

/** The Business Central entity kinds this connector mirrors into the Vault. */
export type BusinessCentralEntity =
  | 'customer'
  | 'vendor'
  | 'item'
  | 'sales_invoice';

/** Generic shape of a Business Central API v2.0 entity row. */
export type BcApiRow = Record<string, unknown> & {
  id?: string;
  number?: string;
  displayName?: string;
  status?: string;
  lastModifiedDateTime?: string;
};

export type BcCompany = {
  id: string;
  name?: string;
  displayName?: string;
};

export type BcListResponse<T> = {
  value?: T[];
};

/** One row of the unified businesscentral_records table. */
export type StoredBusinessCentralRecord = {
  /** Composite key, e.g. "customer:guid" — unique across entity kinds. */
  id: string;
  entity: BusinessCentralEntity;
  /** Display name: customer/vendor/item name or invoice number. */
  title: string | null;
  /** Business Central document/record number. */
  number: string | null;
  /** Invoice total or item unit price, when applicable. */
  amount: number | null;
  /** Document status (e.g. Draft, Open, Paid), when applicable. */
  status: string | null;
  /** Full row as returned by the Business Central API. */
  properties: Record<string, unknown> | null;
  updated_at: string | null;
  synced_at: string;
};

export type MicrosoftTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type?: string;
};

/**
 * On-prem connections use a service account + Web Service Access Key (basic
 * auth); cloud/OAuth-enabled deployments use an Entra ID app with the client
 * credentials grant instead.
 */
export type BusinessCentralCredentials = ConnectorCredentials & {
  /** API base URL up to and including /api/v2.0 (OData web services). */
  base_url?: string;
  /** Company id (GUID) or name; first company is used when omitted. */
  company_id?: string;
  username?: string;
  web_service_access_key?: string;
  client_id?: string;
  client_secret?: string;
  tenant_id?: string;
};

export type BusinessCentralSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};
