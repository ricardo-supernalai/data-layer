import { Module } from '@nestjs/common';
import { GoogleDriveConnectorService } from './googledrive.connector.service';
import { GoogleDriveConnectorController } from './googledrive.connector.controller';

@Module({
  controllers: [GoogleDriveConnectorController],
  providers: [GoogleDriveConnectorService],
})
export class GoogleDriveConnectorModule {}
