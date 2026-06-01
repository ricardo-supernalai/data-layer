import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SlackConnectorService } from './slack.connector.service';
import { SlackConnectorController } from './slack.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [ConfigModule.forRoot(), EmbeddingsModule],
  controllers: [SlackConnectorController],
  providers: [SlackConnectorService],
})
export class SlackConnectorModule {}
