import type { ConnectorCredentials } from '../../connector.interface';

/** The NetSuite record kinds this connector mirrors into the Vault. */
export type NetSuiteRecordType = 'transaction' | 'customer' | 'item';

/** One row returned by a SuiteQL query (column keys are lowercase). */
export type SuiteQlRow = Record<string, string | number | null>;

export type SuiteQlResponse = {
  items?: SuiteQlRow[];
  hasMore?: boolean;
  count?: number;
};

/** One row of the unified netsuite_records table. */
export type StoredNetSuiteRecord = {
  /** Composite key, e.g. "transaction:12345" — unique across record types. */
  id: string;
  record_type: NetSuiteRecordType;
  /** Display name: transaction id, customer/company name, or item name. */
  title: string | null;
  /** Transaction total, when the record is a transaction. */
  amount: number | null;
  /** Transaction status, when applicable. */
  status: string | null;
  /** Full SuiteQL row as returned by NetSuite. */
  properties: Record<string, unknown> | null;
  updated_at: string | null;
  synced_at: string;
};

/**
 * Token-Based Authentication (OAuth 1.0a): every request is signed with the
 * consumer pair (from the Integration record) and the token pair (from the
 * service user's access token), so nothing expires or refreshes.
 */
export type NetSuiteCredentials = ConnectorCredentials & {
  /** Account ID, e.g. "1234567" or "1234567_SB1" for sandboxes. */
  account_id?: string;
  consumer_key?: string;
  consumer_secret?: string;
  token_id?: string;
  token_secret?: string;
};

export type NetSuiteSession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};
