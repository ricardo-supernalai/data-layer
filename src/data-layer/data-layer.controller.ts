import { Body, Controller, Post } from '@nestjs/common';
import { DataLayerService } from './data-layer.service';
import type {
  DataLayerQueryInput,
  DataLayerQueryOptions,
  DataLayerQueryResult,
} from './dtos/data-layer.dto';

@Controller('data-layer')
export class DataLayerController {
  constructor(private readonly dataLayer: DataLayerService) {}

  @Post('query')
  async query(
    @Body() body: DataLayerQueryInput,
  ): Promise<DataLayerQueryResult> {
    // The HTTP surface exposes the JSON-serializable knobs. The `build`
    // function form of prompt customization is in-process only (see
    // DataLayerService.query / DataLayerModule.forRoot).
    const options: DataLayerQueryOptions = {
      limitPerConnector: body.limit_per_connector,
      limits: body.limits_by_connector,
      prompt: body.instructions ? { instructions: body.instructions } : undefined,
    };
    return this.dataLayer.query(body.text, options);
  }
}
