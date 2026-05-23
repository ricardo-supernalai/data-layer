import { Controller } from '@nestjs/common';
import { GmailConnectorService } from './gmail.connector.service';

@Controller('gmail.connector')
export class GmailConnectorController {
  constructor(private readonly gmailConnectorService: GmailConnectorService) {}
}
