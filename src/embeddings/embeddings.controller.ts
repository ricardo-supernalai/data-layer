import { Body, Controller, Post } from '@nestjs/common';
import type { EmbeddingItem, SearchMatch } from './dtos/embeddings.dto';
import { EmbeddingsService } from './embeddings.service';

type EmbedPayload = {
  text: string;
};

type StorePayload = {
  items: EmbeddingItem[];
  table_name: string;
};

type SearchPayload = {
  query: string;
  table_name: string;
  match_count?: number;
};

@Controller('embeddings')
export class EmbeddingsController {
  constructor(private readonly embeddings: EmbeddingsService) {}

  @Post('embed')
  async embed(@Body() body: EmbedPayload): Promise<{ embedding: number[] }> {
    const embedding = await this.embeddings.embed(body.text);
    return { embedding };
  }

  @Post('store')
  async store(@Body() body: StorePayload): Promise<{ success: boolean }> {
    await this.embeddings.storeEmbeddings(body.items, body.table_name);
    return { success: true };
  }

  @Post('search')
  async search(
    @Body() body: SearchPayload,
  ): Promise<{ results: SearchMatch[] }> {
    const results = await this.embeddings.search(
      body.query,
      body.table_name,
      body.match_count,
    );
    return { results };
  }
}
