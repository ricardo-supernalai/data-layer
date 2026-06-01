import { Module, type DynamicModule } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DataLayerController } from './data-layer.controller';
import { DataLayerService } from './data-layer.service';
import { DATA_LAYER_OPTIONS } from './data-layer.tokens';
import type { DataLayerModuleOptions } from './dtos/data-layer.dto';

@Module({
  imports: [DiscoveryModule],
  controllers: [DataLayerController],
  providers: [DataLayerService],
  exports: [DataLayerService],
})
export class DataLayerModule {
  /**
   * Register the data layer with app-wide defaults (row limits, system-prompt
   * customization). Every `query()` call inherits these unless it passes its
   * own overrides.
   *
   * @example
   * DataLayerModule.forRoot({
   *   limitPerConnector: 8,
   *   limits: { gmail: 20, slack: 5 },
   *   prompt: { instructions: 'You are Acme Corp's internal assistant…' },
   * })
   */
  static forRoot(options: DataLayerModuleOptions = {}): DynamicModule {
    return {
      module: DataLayerModule,
      providers: [
        {
          provide: DATA_LAYER_OPTIONS,
          useValue: options,
        },
      ],
    };
  }
}
