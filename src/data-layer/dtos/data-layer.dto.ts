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

export type DataLayerQueryInput = {
  text: string;
  /** Max rows per connector to include. Defaults to 10. */
  limit_per_connector?: number;
};
