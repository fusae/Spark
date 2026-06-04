export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  responseFormat?: 'json_object';
}

export interface ChatClient {
  chat(prompt: string, options?: ChatOptions): Promise<string>;
}

export interface EmbeddingProvider {
  getEmbedding(text: string): Promise<number[]>;
  getBatchEmbeddings(texts: string[]): Promise<number[][]>;
  getEmbeddingWithRetry?(text: string, maxRetries?: number): Promise<number[]>;
}
