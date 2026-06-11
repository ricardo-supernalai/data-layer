import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DataLayerService } from './data-layer.service';
import type {
  DataLayerQueryInput,
  DataLayerQueryOptions,
  DataLayerQueryResult,
} from './dtos/data-layer.dto';

@Controller('data-layer')
export class DataLayerController {
  constructor(private readonly dataLayer: DataLayerService) {}

  @UseGuards(JwtAuthGuard)
  @Post('query')
  async query(
    @Body() body: DataLayerQueryInput,
    @CurrentUser('roles') roles: string[] | undefined,
  ): Promise<DataLayerQueryResult> {
    // The HTTP surface exposes the JSON-serializable knobs. The `build`
    // function form of prompt customization is in-process only (see
    // DataLayerService.query / DataLayerModule.forRoot).
    //
    // `roles` come from the authenticated user (never the request body), so the
    // query only pulls from tables the caller's role(s) are allowed to read.
    const options: DataLayerQueryOptions = {
      limitPerConnector: body.limit_per_connector,
      limits: body.limits_by_connector,
      prompt: body.instructions ? { instructions: body.instructions } : undefined,
      roles: roles ?? [],
    };
    return this.dataLayer.query(body.text, options);
  }
}
