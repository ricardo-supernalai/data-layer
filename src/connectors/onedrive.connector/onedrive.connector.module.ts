import { Module } from '@nestjs/common';
import { OneDriveConnectorService } from './onedrive.connector.service';
import { OneDriveConnectorController } from './onedrive.connector.controller';

@Module({
  controllers: [OneDriveConnectorController],
  providers: [OneDriveConnectorService],
})
export class OneDriveConnectorModule {}
