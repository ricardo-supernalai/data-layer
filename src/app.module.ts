import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GmailConnectorModule } from './connectors/gmail.connector/gmail.connector.module';
import { GoogleDriveConnectorModule } from './connectors/googledrive.connector/googledrive.connector.module';
import { OneDriveConnectorModule } from './connectors/onedrive.connector/onedrive.connector.module';
import { EmbeddingsModule } from './embeddings/embeddings.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    GmailConnectorModule,
    GoogleDriveConnectorModule,
    OneDriveConnectorModule,
    EmbeddingsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
