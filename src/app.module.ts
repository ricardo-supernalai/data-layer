import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BusinessCentralConnectorModule } from './connectors/businesscentral.connector/businesscentral.connector.module';
import { GmailConnectorModule } from './connectors/gmail.connector/gmail.connector.module';
import { GoogleCalendarConnectorModule } from './connectors/google-calendar.connector/google-calendar.connector.module';
import { GoogleDriveConnectorModule } from './connectors/googledrive.connector/googledrive.connector.module';
import { HubSpotConnectorModule } from './connectors/hubspot.connector/hubspot.connector.module';
import { Microsoft365ConnectorModule } from './connectors/microsoft365.connector/microsoft365.connector.module';
import { NetSuiteConnectorModule } from './connectors/netsuite.connector/netsuite.connector.module';
import { OneDriveConnectorModule } from './connectors/onedrive.connector/onedrive.connector.module';
import { PowerBIConnectorModule } from './connectors/powerbi.connector/powerbi.connector.module';
import { SlackConnectorModule } from './connectors/slack.connector/slack.connector.module';
import { EmbeddingsModule } from './embeddings/embeddings.module';
import { DataLayerModule } from './data-layer/data-layer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Role-based access control: which roles may read which Supabase tables.
    // `admin` (a super role) reads everything; deny-by-default for the rest.
    // Adjust this policy to your org's roles.
    AuthModule.forRoot({
      superRoles: ['admin'],
      defaultAllow: false,
      tableAccess: {
        sales: ['hubspot_records'],
        client_services: [
          'hubspot_records',
          'microsoft365_items',
          'gmail_messages',
        ],
        support: ['gmail_messages', 'slack_messages', 'googlecalendar_events'],
        analyst: ['*'],
        // Read every Gmail message, and nothing else.
        gmail_reader: ['gmail_messages'],
      },
    }),
    GmailConnectorModule,
    GoogleCalendarConnectorModule,
    GoogleDriveConnectorModule,
    BusinessCentralConnectorModule,
    HubSpotConnectorModule,
    Microsoft365ConnectorModule,
    NetSuiteConnectorModule,
    OneDriveConnectorModule,
    PowerBIConnectorModule,
    SlackConnectorModule,
    EmbeddingsModule,
    DataLayerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
