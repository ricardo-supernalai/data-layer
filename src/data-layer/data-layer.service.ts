import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { AccessControlService } from '../auth/access-control.service';
import { ConnectorInterface } from '../connectors/connector.interface';
import type {
  ConnectorSection,
  DataLayerModuleOptions,
  DataLayerQueryOptions,
  DataLayerQueryResult,
  PromptOptions,
} from './dtos/data-layer.dto';
import { DATA_LAYER_OPTIONS } from './data-layer.tokens';

const DEFAULT_LIMIT_PER_CONNECTOR = 10;
const MAX_LIMIT_PER_CONNECTOR = 50;

const DEFAULT_INSTRUCTIONS = [
  "You are an assistant with access to the user's personal data layer.",
  "The sections below contain the most relevant items from each connected data source for the user's question.",
  'Use this material to answer. Cite which source(s) you used.',
  "If the answer isn't present in the sources, say so honestly instead of guessing.",
].join('\n');

type RowFormatter = (
  connector: string,
  row: Record<string, unknown>,
) => string;

@Injectable()
export class DataLayerService {
  private readonly logger = new Logger(DataLayerService.name);
  private readonly defaults: DataLayerModuleOptions;

  constructor(
    private readonly discovery: DiscoveryService,
    @Optional()
    @Inject(DATA_LAYER_OPTIONS)
    defaults?: DataLayerModuleOptions,
    @Optional()
    private readonly accessControl?: AccessControlService,
  ) {
    this.defaults = defaults ?? {};
  }

  /**
   * Build a master system prompt from the user's question. For every connected
   * connector, runs getRelevantData(text, limit) and stitches the results
   * together into one prompt.
   *
   * The second argument accepts either a plain row limit (legacy) or a
   * {@link DataLayerQueryOptions} object that controls per-connector limits and
   * the assembled system prompt. Per-query options are merged over any module
   * defaults configured via `DataLayerModule.forRoot(...)`.
   */
  async query(
    text: string,
    options?: number | DataLayerQueryOptions,
  ): Promise<DataLayerQueryResult> {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
      throw new Error('query: `text` is required and must be non-empty.');
    }

    const resolved = this.resolveOptions(options);
    const globalLimit = this.resolveLimit(
      resolved.limitPerConnector,
      DEFAULT_LIMIT_PER_CONNECTOR,
    );
    const promptOptions = resolved.prompt ?? {};

    const connectors = this.applyAccessControl(
      this.discoverConnectors(),
      resolved.roles,
    );
    if (connectors.length === 0) {
      this.logger.warn('No ConnectorInterface providers discovered.');
      return {
        system_prompt: this.assemblePrompt(trimmed, [], [], promptOptions),
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
    // sink the whole query — other connectors still contribute. Each connector
    // gets its own limit: a per-connector override if present, else the global.
    const sections = await Promise.all(
      active.map<Promise<ConnectorSection | null>>(async (c) => {
        const limit = this.resolveLimit(resolved.limits?.[c.name], globalLimit);
        if (limit <= 0) return null;
        try {
          const rows = await c.getRelevantData(trimmed, limit);
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
    const systemPrompt = this.assemblePrompt(
      trimmed,
      sources,
      active,
      promptOptions,
    );

    return {
      system_prompt: systemPrompt,
      sources,
      connectors_used: active.map((c) => c.name),
    };
  }

  /**
   * Merge per-query options over the module-level defaults. A bare number is
   * treated as `limitPerConnector` for backwards compatibility.
   */
  private resolveOptions(
    options?: number | DataLayerQueryOptions,
  ): DataLayerQueryOptions {
    const perQuery: DataLayerQueryOptions =
      typeof options === 'number'
        ? { limitPerConnector: options }
        : (options ?? {});

    return {
      limitPerConnector:
        perQuery.limitPerConnector ?? this.defaults.limitPerConnector,
      limits: { ...this.defaults.limits, ...perQuery.limits },
      prompt: {
        instructions:
          perQuery.prompt?.instructions ?? this.defaults.prompt?.instructions,
        build: perQuery.prompt?.build ?? this.defaults.prompt?.build,
      },
      // Roles are a per-call security context, never inherited from module
      // defaults.
      roles: perQuery.roles,
    };
  }

  /**
   * Drop connectors whose Supabase table the caller's roles may not read.
   *
   * Skipped entirely when no AccessControlService is configured, or when
   * `roles` is `undefined` (a trusted in-process call). An authenticated caller
   * with no roles should pass `[]`, which is subject to the deny-by-default
   * policy.
   */
  private applyAccessControl(
    connectors: ConnectorInterface[],
    roles: string[] | undefined,
  ): ConnectorInterface[] {
    if (!this.accessControl || roles === undefined) return connectors;

    return connectors.filter((c) => {
      const allowed = this.accessControl!.canReadTable(roles, c.table);
      if (!allowed) {
        this.logger.warn(
          `Access denied: role(s) [${roles.join(', ') || 'none'}] cannot read "${c.table}" (${c.name}); excluded from query.`,
        );
      }
      return allowed;
    });
  }

  /**
   * Clamp a requested limit into [0, MAX]. `undefined` or invalid values fall
   * back to `fallback`; an explicit `0` is honored (skip that connector).
   */
  private resolveLimit(value: number | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0) return fallback;
    return Math.min(Math.floor(value), MAX_LIMIT_PER_CONNECTOR);
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

  /**
   * Render the default prompt, then hand off to a consumer-supplied `build`
   * function if one was provided.
   */
  private assemblePrompt(
    text: string,
    sources: ConnectorSection[],
    activeConnectors: ConnectorInterface[],
    promptOptions: PromptOptions,
  ): string {
    const formatterByName = new Map<string, ConnectorInterface>(
      activeConnectors.map((c) => [c.name, c]),
    );
    const formatRow: RowFormatter = (connector, row) => {
      const formatter = formatterByName.get(connector);
      return formatter ? formatter.formatRowForPrompt(row) : JSON.stringify(row);
    };

    const defaultPrompt = this.renderDefaultPrompt(
      text,
      sources,
      activeConnectors,
      promptOptions.instructions ?? DEFAULT_INSTRUCTIONS,
      formatRow,
    );

    if (promptOptions.build) {
      return promptOptions.build({
        text,
        sources,
        connectorsUsed: activeConnectors.map((c) => c.name),
        formatRow,
        defaultPrompt,
      });
    }

    return defaultPrompt;
  }

  private renderDefaultPrompt(
    text: string,
    sources: ConnectorSection[],
    activeConnectors: ConnectorInterface[],
    instructions: string,
    formatRow: RowFormatter,
  ): string {
    const parts: string[] = [instructions, ''];

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
        section.rows.forEach((row, i) => {
          parts.push(`Item ${i + 1}:`);
          parts.push(formatRow(section.connector, row));
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
