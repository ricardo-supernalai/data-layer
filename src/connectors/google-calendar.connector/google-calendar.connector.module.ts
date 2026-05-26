import { Module } from '@nestjs/common';
import { GoogleCalendarConnectorService } from './google-calendar.connector.service';
import { GoogleCalendarConnectorController } from './google-calendar.connector.controller';
import { EmbeddingsModule } from '../../embeddings/embeddings.module';

@Module({
  imports: [EmbeddingsModule],
  controllers: [GoogleCalendarConnectorController],
  providers: [GoogleCalendarConnectorService],
})
export class GoogleCalendarConnectorModule {}
