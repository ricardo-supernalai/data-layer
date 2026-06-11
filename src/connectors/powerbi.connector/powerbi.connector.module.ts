import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PowerBIConnectorService } from './powerbi.connector.service';
import { PowerBIConnectorController } from './powerbi.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [PowerBIConnectorController],
  providers: [PowerBIConnectorService],
})
export class PowerBIConnectorModule {}
