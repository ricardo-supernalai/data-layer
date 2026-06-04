import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GmailConnectorModule } from './connectors/gmail.connector/gmail.connector.module';
import { GoogleCalendarConnectorModule } from './connectors/google-calendar.connector/google-calendar.connector.module';
import { GoogleDriveConnectorModule } from './connectors/googledrive.connector/googledrive.connector.module';
import { HubSpotConnectorModule } from './connectors/hubspot.connector/hubspot.connector.module';
import { Microsoft365ConnectorModule } from './connectors/microsoft365.connector/microsoft365.connector.module';
import { OneDriveConnectorModule } from './connectors/onedrive.connector/onedrive.connector.module';
import { SlackConnectorModule } from './connectors/slack.connector/slack.connector.module';
import { EmbeddingsModule } from './embeddings/embeddings.module';
import { DataLayerModule } from './data-layer/data-layer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    GmailConnectorModule,
    GoogleCalendarConnectorModule,
    GoogleDriveConnectorModule,
    HubSpotConnectorModule,
    Microsoft365ConnectorModule,
    OneDriveConnectorModule,
    SlackConnectorModule,
    EmbeddingsModule,
    DataLayerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
