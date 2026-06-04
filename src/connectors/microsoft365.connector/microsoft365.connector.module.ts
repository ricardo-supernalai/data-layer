import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Microsoft365ConnectorService } from './microsoft365.connector.service';
import { Microsoft365ConnectorController } from './microsoft365.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [Microsoft365ConnectorController],
  providers: [Microsoft365ConnectorService],
})
export class Microsoft365ConnectorModule {}
