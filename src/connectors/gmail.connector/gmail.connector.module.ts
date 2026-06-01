import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GmailConnectorService } from './gmail.connector.service';
import { GmailConnectorController } from './gmail.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [GmailConnectorController],
  providers: [GmailConnectorService],
})
export class GmailConnectorModule {}
