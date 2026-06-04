import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HubSpotConnectorService } from './hubspot.connector.service';
import { HubSpotConnectorController } from './hubspot.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [HubSpotConnectorController],
  providers: [HubSpotConnectorService],
})
export class HubSpotConnectorModule {}
