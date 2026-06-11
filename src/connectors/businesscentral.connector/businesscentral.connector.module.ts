import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BusinessCentralConnectorService } from './businesscentral.connector.service';
import { BusinessCentralConnectorController } from './businesscentral.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [BusinessCentralConnectorController],
  providers: [BusinessCentralConnectorService],
})
export class BusinessCentralConnectorModule {}
