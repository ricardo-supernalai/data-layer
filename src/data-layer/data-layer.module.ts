import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DataLayerController } from './data-layer.controller';
import { DataLayerService } from './data-layer.service';

@Module({
  imports: [DiscoveryModule],
  controllers: [DataLayerController],
  providers: [DataLayerService],
})
export class DataLayerModule {}
