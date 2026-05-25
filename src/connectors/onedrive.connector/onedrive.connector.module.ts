import { Module } from '@nestjs/common';
import { OneDriveConnectorService } from './onedrive.connector.service';
import { OneDriveConnectorController } from './onedrive.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [EmbeddingsModule],
  controllers: [OneDriveConnectorController],
  providers: [OneDriveConnectorService],
})
export class OneDriveConnectorModule {}
