import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NetSuiteConnectorService } from './netsuite.connector.service';
import { NetSuiteConnectorController } from './netsuite.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [NetSuiteConnectorController],
  providers: [NetSuiteConnectorService],
})
export class NetSuiteConnectorModule {}
