// Public API for the data-layer package.
// Consumers typically: import { DataLayerModule } from '@your-org/data-layer';

// Core data-layer module + service
export { DataLayerModule } from './data-layer/data-layer.module';
export { DataLayerService } from './data-layer/data-layer.service';
export { DataLayerController } from './data-layer/data-layer.controller';
export type {
  ConnectorSection,
  DataLayerQueryInput,
  DataLayerQueryResult,
} from './data-layer/dtos/data-layer.dto';

// Embeddings
export { EmbeddingsModule } from './embeddings/embeddings.module';
export { EmbeddingsService } from './embeddings/embeddings.service';
export { EmbeddingsController } from './embeddings/embeddings.controller';
export type { SyncWithEmbeddingsInput } from './embeddings/embeddings.service';
export type {
  EmbeddingItem,
  SearchInput,
  SearchMatch,
  StoreEmbeddingsInput,
} from './embeddings/dtos/embeddings.dto';

// Connector base — subclass this to build your own connector
export {
  ConnectorInterface,
  type ConnectorCredentialValue,
  type ConnectorCredentials,
  type ConnectorSyncPayload,
} from './connectors/connector.interface';

// Built-in connectors
export { GmailConnectorModule } from './connectors/gmail.connector/gmail.connector.module';
export { GmailConnectorService } from './connectors/gmail.connector/gmail.connector.service';
export { GmailConnectorController } from './connectors/gmail.connector/gmail.connector.controller';

export { GoogleCalendarConnectorModule } from './connectors/google-calendar.connector/google-calendar.connector.module';
export { GoogleCalendarConnectorService } from './connectors/google-calendar.connector/google-calendar.connector.service';
export { GoogleCalendarConnectorController } from './connectors/google-calendar.connector/google-calendar.connector.controller';

export { GoogleDriveConnectorModule } from './connectors/googledrive.connector/googledrive.connector.module';
export { GoogleDriveConnectorService } from './connectors/googledrive.connector/googledrive.connector.service';
export { GoogleDriveConnectorController } from './connectors/googledrive.connector/googledrive.connector.controller';

export { OneDriveConnectorModule } from './connectors/onedrive.connector/onedrive.connector.module';
export { OneDriveConnectorService } from './connectors/onedrive.connector/onedrive.connector.service';
export { OneDriveConnectorController } from './connectors/onedrive.connector/onedrive.connector.controller';

export { SlackConnectorModule } from './connectors/slack.connector/slack.connector.module';
export { SlackConnectorService } from './connectors/slack.connector/slack.connector.service';
export { SlackConnectorController } from './connectors/slack.connector/slack.connector.controller';

// Supabase helpers — exposed so consumers can share the same lazy client
export {
  supabase,
  supabaseAdmin,
  createSupabaseAuthedClient,
  getSupabaseProjectUrl,
} from './supabase-client';
