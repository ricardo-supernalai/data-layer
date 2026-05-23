import { Module } from '@nestjs/common';
import { GmailConnectorService } from './gmail.connector.service';
import { GmailConnectorController } from './gmail.connector.controller';

@Module({
  controllers: [GmailConnectorController],
  providers: [GmailConnectorService],
})
export class GmailConnectorModule {}
