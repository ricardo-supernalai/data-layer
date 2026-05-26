import { Body, Controller, Post } from '@nestjs/common';
import { DataLayerService } from './data-layer.service';
import type {
  DataLayerQueryInput,
  DataLayerQueryResult,
} from './dtos/data-layer.dto';

@Controller('data-layer')
export class DataLayerController {
  constructor(private readonly dataLayer: DataLayerService) {}

  @Post('query')
  async query(
    @Body() body: DataLayerQueryInput,
  ): Promise<DataLayerQueryResult> {
    return this.dataLayer.query(body.text, body.limit_per_connector);
  }
}
