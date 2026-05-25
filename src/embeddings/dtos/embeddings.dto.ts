export type StoreEmbeddingsInput = {
  texts: string[];
  tableName: string;
};

export type SearchInput = {
  query: string;
  tableName: string;
  matchCount?: number;
};

export type SearchMatch = {
  id: number;
  content: string;
  similarity: number;
};
