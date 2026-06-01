export type ConnectorSection = {
  /** Connector name (e.g. 'gmail', 'slack'). */
  connector: string;
  /** Raw rows returned by the connector's getRelevantData, in similarity order. */
  rows: Record<string, unknown>[];
};

export type DataLayerQueryResult = {
  /** Fully-assembled master system prompt ready to hand to an AI agent. */
  system_prompt: string;
  /** Raw per-connector sections used to build the prompt — useful for the UI. */
  sources: ConnectorSection[];
  /** Names of connectors that were probed and found connected. */
  connectors_used: string[];
};

/**
 * Structured view of a query's results, handed to a custom prompt builder so
 * consumers can assemble the system prompt however they like.
 */
export type PromptBuildContext = {
  /** The user's (trimmed) question. */
  text: string;
  /** Per-connector sections that produced data, in connector order. */
  sources: ConnectorSection[];
  /** Names of connectors that were connected and queried. */
  connectorsUsed: string[];
  /**
   * Render a single raw row exactly as the default prompt would — honors the
   * connector's own `formatRowForPrompt`. Handy when writing a custom builder
   * that still wants the per-connector formatting.
   */
  formatRow: (connector: string, row: Record<string, unknown>) => string;
  /** The fully-assembled default prompt — convenient to wrap, prepend, or append to. */
  defaultPrompt: string;
};

/** Controls how the master system prompt is assembled. */
export type PromptOptions = {
  /**
   * Replace the leading instruction block (the default "You are an assistant…"
   * lines) while keeping the standard section/row layout. Ignored when `build`
   * is provided.
   */
  instructions?: string;
  /**
   * Full override. Given the structured context (including the rendered
   * `defaultPrompt`), return the final system prompt string. Takes precedence
   * over `instructions`.
   */
  build?: (ctx: PromptBuildContext) => string;
};

/**
 * Per-query knobs — also usable as module-wide defaults via
 * `DataLayerModule.forRoot(...)`. Per-query values win over module defaults.
 */
export type DataLayerQueryOptions = {
  /** Default max rows per connector. Defaults to 10, capped at 50. */
  limitPerConnector?: number;
  /**
   * Per-connector overrides keyed by connector name, e.g. `{ gmail: 20, slack: 5 }`.
   * Takes precedence over `limitPerConnector` for the named connectors. Set a
   * connector to `0` to skip retrieving from it for this query.
   */
  limits?: Record<string, number>;
  /** System prompt customization. */
  prompt?: PromptOptions;
};

/** Module-level defaults applied to every query unless overridden per call. */
export type DataLayerModuleOptions = DataLayerQueryOptions;

export type DataLayerQueryInput = {
  text: string;
  /** Max rows per connector to include. Defaults to 10. */
  limit_per_connector?: number;
  /** Per-connector row-limit overrides, e.g. `{ "gmail": 20, "slack": 5 }`. */
  limits_by_connector?: Record<string, number>;
  /** Replace the leading instruction block of the assembled system prompt. */
  instructions?: string;
};
