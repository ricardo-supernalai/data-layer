import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { ConnectorInterface } from '../connectors/connector.interface';
import type {
  ConnectorSection,
  DataLayerQueryResult,
} from './dtos/data-layer.dto';

const DEFAULT_LIMIT_PER_CONNECTOR = 10;

@Injectable()
export class DataLayerService {
  private readonly logger = new Logger(DataLayerService.name);

  constructor(private readonly discovery: DiscoveryService) {}

  /**
   * Build a master system prompt from the user's question. For every connected
   * connector, runs getRelevantData(text, limit) and stitches the results
   * together into one prompt.
   */
  async query(
    text: string,
    limitPerConnector: number = DEFAULT_LIMIT_PER_CONNECTOR,
  ): Promise<DataLayerQueryResult> {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
      throw new Error('query: `text` is required and must be non-empty.');
    }

    const safeLimit =
      Number.isFinite(limitPerConnector) && limitPerConnector > 0
        ? Math.min(Math.floor(limitPerConnector), 50)
        : DEFAULT_LIMIT_PER_CONNECTOR;

    const connectors = this.discoverConnectors();
    if (connectors.length === 0) {
      this.logger.warn('No ConnectorInterface providers discovered.');
      return {
        system_prompt: this.buildSystemPrompt(trimmed, [], []),
        sources: [],
        connectors_used: [],
      };
    }

    // Probe connected state in parallel; a failing probe means "not connected".
    const probes = await Promise.all(
      connectors.map(async (c) => {
        try {
          return { c, connected: await c.isConnected() };
        } catch (err) {
          this.logger.warn(
            `isConnected() failed for ${c.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { c, connected: false };
        }
      }),
    );
    const active = probes.filter((p) => p.connected).map((p) => p.c);

    // Fan out getRelevantData. Per-connector failures are logged but don't
    // sink the whole query — other connectors still contribute.
    const sections = await Promise.all(
      active.map<Promise<ConnectorSection | null>>(async (c) => {
        try {
          const rows = await c.getRelevantData(trimmed, safeLimit);
          if (rows.length === 0) return null;
          return { connector: c.name, rows };
        } catch (err) {
          this.logger.warn(
            `getRelevantData failed for ${c.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
      }),
    );

    const sources = sections.filter(
      (s): s is ConnectorSection => s !== null,
    );
    const systemPrompt = this.buildSystemPrompt(trimmed, sources, active);

    return {
      system_prompt: systemPrompt,
      sources,
      connectors_used: active.map((c) => c.name),
    };
  }

  /**
   * Find all ConnectorInterface instances registered anywhere in the Nest DI
   * tree. New connectors plug in automatically — DataLayerService doesn't need
   * to be touched when adding one.
   */
  private discoverConnectors(): ConnectorInterface[] {
    return this.discovery
      .getProviders()
      .map((p) => p.instance)
      .filter(
        (i): i is ConnectorInterface => i instanceof ConnectorInterface,
      );
  }

  private buildSystemPrompt(
    text: string,
    sources: ConnectorSection[],
    activeConnectors: ConnectorInterface[],
  ): string {
    const formatterByName = new Map<string, ConnectorInterface>(
      activeConnectors.map((c) => [c.name, c]),
    );

    const parts: string[] = [];

    parts.push(
      "You are an assistant with access to the user's personal data layer.",
      'The sections below contain the most relevant items from each connected data source for the user\'s question.',
      'Use this material to answer. Cite which source(s) you used.',
      "If the answer isn't present in the sources, say so honestly instead of guessing.",
      '',
    );

    if (sources.length === 0) {
      parts.push(
        activeConnectors.length === 0
          ? '(No connectors are connected yet — there is no data to draw from.)'
          : '(No relevant data was found across the connected sources for this question.)',
      );
    } else {
      for (const section of sources) {
        parts.push(
          `# Source: ${section.connector} (top ${section.rows.length})`,
        );
        const formatter = formatterByName.get(section.connector);
        section.rows.forEach((row, i) => {
          parts.push(`Item ${i + 1}:`);
          parts.push(
            formatter
              ? formatter.formatRowForPrompt(row)
              : JSON.stringify(row),
          );
          parts.push('');
        });
      }
    }

    parts.push('---');
    parts.push('User question:');
    parts.push(text);

    return parts.join('\n');
  }
}
