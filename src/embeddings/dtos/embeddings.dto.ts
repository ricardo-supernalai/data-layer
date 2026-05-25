export type EmbeddingItem = {
  text: string;
  data_id: string;
};

export type StoreEmbeddingsInput = {
  items: EmbeddingItem[];
  tableName: string;
};

export type SearchInput = {
  query: string;
  tableName: string;
  matchCount?: number;
};

export type SearchMatch = {
  data_id: string;
  content: string;
  similarity: number;
};
