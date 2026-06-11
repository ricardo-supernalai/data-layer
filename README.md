# data-layer

Pluggable NestJS data layer — connector framework + Supabase-backed embeddings for
assembling AI system prompts from multiple data sources.

## Install

```bash
npm install data-layer
```

This package ships compiled JS + type declarations in `dist/`. It declares the
following **peer dependencies**, which the host app must provide:

- `@nestjs/common` `^11`
- `@nestjs/config` `^4`
- `@nestjs/core` `^11`
- `reflect-metadata` `^0.2`
- `rxjs` `^7`

## Usage

```ts
import { DataLayerModule } from 'data-layer';

@Module({
  imports: [
    DataLayerModule.forRoot({
      /* options */
    }),
  ],
})
export class AppModule {}
```

See `src/index.ts` for the full list of exported modules, services, guards,
decorators, connectors, and embeddings helpers.
