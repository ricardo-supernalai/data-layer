// Public API for the data-layer package.
// Consumers typically: import { DataLayerModule } from '@your-org/data-layer';

// Core data-layer module + service
export { DataLayerModule } from './data-layer/data-layer.module';
export { DataLayerService } from './data-layer/data-layer.service';
export { DataLayerController } from './data-layer/data-layer.controller';
export { DATA_LAYER_OPTIONS } from './data-layer/data-layer.tokens';
export type {
  ConnectorSection,
  DataLayerModuleOptions,
  DataLayerQueryInput,
  DataLayerQueryOptions,
  DataLayerQueryResult,
  PromptBuildContext,
  PromptOptions,
} from './data-layer/dtos/data-layer.dto';

// Auth (Supabase-backed) + role-based access control
export { AuthModule } from './auth/auth.module';
export { AuthService } from './auth/auth.service';
export { AuthController } from './auth/auth.controller';
export { AccessControlService } from './auth/access-control.service';
export { RlsService } from './auth/rls.service';
export { AUTH_OPTIONS } from './auth/auth.tokens';
export { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
export { RolesGuard } from './auth/guards/roles.guard';
export { TableAccessGuard } from './auth/guards/table-access.guard';
export { Roles, ROLES_KEY } from './auth/decorators/roles.decorator';
export {
  RequireTableAccess,
  TABLE_ACCESS_KEY,
} from './auth/decorators/require-table-access.decorator';
export { CurrentUser } from './auth/decorators/current-user.decorator';
export {
  ALL_TABLES,
  extractRoles,
  toAuthSession,
  toAuthUser,
} from './auth/dtos/auth.dto';
export type {
  AuthCredentials,
  AuthModuleOptions,
  AuthResult,
  AuthSession,
  AuthUser,
  OtpRequestPayload,
  OtpVerifyPayload,
  RefreshPayload,
  SetRolesPayload,
} from './auth/dtos/auth.dto';

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
export { BusinessCentralConnectorModule } from './connectors/businesscentral.connector/businesscentral.connector.module';
export { BusinessCentralConnectorService } from './connectors/businesscentral.connector/businesscentral.connector.service';
export { BusinessCentralConnectorController } from './connectors/businesscentral.connector/businesscentral.connector.controller';

export { GmailConnectorModule } from './connectors/gmail.connector/gmail.connector.module';
export { GmailConnectorService } from './connectors/gmail.connector/gmail.connector.service';
export { GmailConnectorController } from './connectors/gmail.connector/gmail.connector.controller';

export { GoogleCalendarConnectorModule } from './connectors/google-calendar.connector/google-calendar.connector.module';
export { GoogleCalendarConnectorService } from './connectors/google-calendar.connector/google-calendar.connector.service';
export { GoogleCalendarConnectorController } from './connectors/google-calendar.connector/google-calendar.connector.controller';

export { GoogleDriveConnectorModule } from './connectors/googledrive.connector/googledrive.connector.module';
export { GoogleDriveConnectorService } from './connectors/googledrive.connector/googledrive.connector.service';
export { GoogleDriveConnectorController } from './connectors/googledrive.connector/googledrive.connector.controller';

export { HubSpotConnectorModule } from './connectors/hubspot.connector/hubspot.connector.module';
export { HubSpotConnectorService } from './connectors/hubspot.connector/hubspot.connector.service';
export { HubSpotConnectorController } from './connectors/hubspot.connector/hubspot.connector.controller';

export { Microsoft365ConnectorModule } from './connectors/microsoft365.connector/microsoft365.connector.module';
export { Microsoft365ConnectorService } from './connectors/microsoft365.connector/microsoft365.connector.service';
export { Microsoft365ConnectorController } from './connectors/microsoft365.connector/microsoft365.connector.controller';

export { NetSuiteConnectorModule } from './connectors/netsuite.connector/netsuite.connector.module';
export { NetSuiteConnectorService } from './connectors/netsuite.connector/netsuite.connector.service';
export { NetSuiteConnectorController } from './connectors/netsuite.connector/netsuite.connector.controller';

export { OneDriveConnectorModule } from './connectors/onedrive.connector/onedrive.connector.module';
export { OneDriveConnectorService } from './connectors/onedrive.connector/onedrive.connector.service';
export { OneDriveConnectorController } from './connectors/onedrive.connector/onedrive.connector.controller';

export { PowerBIConnectorModule } from './connectors/powerbi.connector/powerbi.connector.module';
export { PowerBIConnectorService } from './connectors/powerbi.connector/powerbi.connector.service';
export { PowerBIConnectorController } from './connectors/powerbi.connector/powerbi.connector.controller';

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
