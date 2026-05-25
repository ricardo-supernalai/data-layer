import { Module } from '@nestjs/common';
import { GmailConnectorService } from './gmail.connector.service';
import { GmailConnectorController } from './gmail.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [EmbeddingsModule],
  controllers: [GmailConnectorController],
  providers: [GmailConnectorService],
})
export class GmailConnectorModule {}
