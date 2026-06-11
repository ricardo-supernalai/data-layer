import type { ConnectorCredentials } from '../../connector.interface';

/** The Power BI item kinds this connector mirrors into the Vault. */
export type PowerBIItemType = 'report' | 'dataset' | 'dashboard';

export type PowerBIReport = {
  id: string;
  name?: string;
  webUrl?: string;
  embedUrl?: string;
  datasetId?: string;
  reportType?: string;
};

export type PowerBIDataset = {
  id: string;
  name?: string;
  webUrl?: string;
  configuredBy?: string;
  isRefreshable?: boolean;
  createdDate?: string;
};

export type PowerBIDashboard = {
  id: string;
  displayName?: string;
  webUrl?: string;
  embedUrl?: string;
};

export type PowerBIListResponse<T> = {
  value?: T[];
};

/** One row of the unified powerbi_items table. */
export type StoredPowerBIItem = {
  /** Composite key, e.g. "report:guid" — unique across item kinds. */
  id: string;
  workspace_id: string;
  item_type: PowerBIItemType;
  name: string | null;
  web_url: string | null;
  /** Backing dataset id, when the item is a report. */
  dataset_id: string | null;
  /** Full item as returned by the Power BI REST API. */
  properties: Record<string, unknown> | null;
  synced_at: string;
};

export type MicrosoftTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type?: string;
};

/**
 * Entra ID service principal with the client-credentials grant. The principal
 * must be added as Viewer on each workspace, and "Allow service principals to
 * use Power BI APIs" must be enabled in the Power BI admin portal.
 */
export type PowerBICredentials = ConnectorCredentials & {
  client_id?: string;
  client_secret?: string;
  tenant_id?: string;
  /** Comma-separated workspace (group) IDs to read from. */
  workspace_ids?: string;
};

export type PowerBISession = {
  connected: boolean;
  expired: boolean;
  expires_at: number | null;
  scope: string | null;
  token_type: string | null;
  has_refresh_token: boolean;
};
