import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleDriveConnectorService } from './googledrive.connector.service';
import { GoogleDriveConnectorController } from './googledrive.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [GoogleDriveConnectorController],
  providers: [GoogleDriveConnectorService],
})
export class GoogleDriveConnectorModule {}
