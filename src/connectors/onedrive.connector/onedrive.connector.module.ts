import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OneDriveConnectorService } from './onedrive.connector.service';
import { OneDriveConnectorController } from './onedrive.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [OneDriveConnectorController],
  providers: [OneDriveConnectorService],
})
export class OneDriveConnectorModule {}
