import type { ChatClient, ChatOptions, EmbeddingProvider } from './types.js';
import { logger } from '../utils/logger.js';

interface CloudAiClientOptions {
  baseURL: string;
  token: string;
}

interface CloudEmbeddingResponse {
  embeddings?: number[][];
  error?: string;
}

interface CloudChatResponse {
  text?: string;
  error?: string;
}

export class CloudAiClient implements ChatClient, EmbeddingProvider {
  private baseURL: string;
  private token: string;

  constructor(options: CloudAiClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.token = options.token;
    logger.info(`CloudAiClient initialized: ${this.baseURL}`);
  }

  async getEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.getBatchEmbeddings([text]);
    return embeddings[0] || [];
  }

  async getBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const response = await this.requestJson<CloudEmbeddingResponse>('/api/ai/embeddings', {
      input: texts,
    });
    if (!Array.isArray(response.embeddings)) {
      throw new Error(response.error || 'Spark Cloud 没有返回向量');
    }
    return response.embeddings;
  }

  async getEmbeddingWithRetry(text: string, maxRetries = 3): Promise<number[]> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.getEmbedding(text);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }
    throw lastError || new Error('Spark Cloud 向量生成失败');
  }

  async chat(prompt: string, options?: ChatOptions): Promise<string> {
    const response = await this.requestJson<CloudChatResponse>('/api/ai/chat', {
      prompt,
      systemPrompt: options?.systemPrompt,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      responseFormat: options?.responseFormat,
    });
    if (typeof response.text !== 'string') {
      throw new Error(response.error || 'Spark Cloud 没有返回内容');
    }
    return response.text;
  }

  private async requestJson<T>(path: string, body: unknown): Promise<T> {
    if (!this.baseURL || !this.token) {
      throw new Error('Spark Cloud 未登录');
    }

    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Spark Cloud 请求失败：${response.status}`);
    }
    return data;
  }
}
