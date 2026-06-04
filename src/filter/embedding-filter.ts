import type { EmbeddingProvider } from '../ai/types.js';
import { ContentPool } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { FilteredContent } from './types.js';
import { ContentItem } from '../types/content.js';

/**
 * 余弦相似度计算
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error(`Vector dimensions mismatch: ${vecA.length} vs ${vecB.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embedding 初筛器
 * 使用向量相似度从大量内容中筛选出候选集
 */
export class EmbeddingFilter {
  constructor(private embeddingClient: EmbeddingProvider) {}

  /**
   * 执行 Embedding 初筛
   * @param contents 内容池数据（来自数据库）
   * @param profileVector 账号画像向量
   * @param topK 保留前 K 个结果
   * @returns 筛选后的内容列表
   */
  async filter(
    contents: ContentPool[],
    profileVector: number[],
    topK: number = 20
  ): Promise<FilteredContent[]> {
    logger.info(`Starting embedding filter: ${contents.length} contents -> top ${topK}`);
    const startTime = Date.now();

    // 1. 分离有向量和无向量的内容
    const withVector: ContentPool[] = [];
    const withoutVector: ContentPool[] = [];

    for (const content of contents) {
      if (content.embedding_vector) {
        withVector.push(content);
      } else {
        withoutVector.push(content);
      }
    }

    logger.info(`Contents: ${withVector.length} with vectors, ${withoutVector.length} without`);

    // 2. 为没有向量的内容生成向量
    if (withoutVector.length > 0) {
      await this.generateMissingEmbeddings(withoutVector);
      withVector.push(...withoutVector);
    }

    // 3. 计算相似度
    const similarities: Array<{ content: ContentPool; similarity: number }> = [];

    for (const content of withVector) {
      try {
        const contentVector = this.deserializeVector(content.embedding_vector!);
        const similarity = cosineSimilarity(profileVector, contentVector);
        similarities.push({ content, similarity });
      } catch (error) {
        logger.warn(`Failed to calculate similarity for content ${content.id}:`, error);
      }
    }

    // 4. 排序并取 Top K
    similarities.sort((a, b) => b.similarity - a.similarity);
    const topResults = similarities.slice(0, topK);

    // 5. 转换为 FilteredContent 格式
    const filtered: FilteredContent[] = topResults.map((item, index) => ({
      content: this.convertToContentItem(item.content),
      contentId: item.content.id!,
      embeddingSimilarity: item.similarity,
      rank: index + 1,
    }));

    const duration = Date.now() - startTime;
    logger.info(`Embedding filter completed: ${filtered.length} results (${duration}ms)`);
    logger.debug(`Similarity range: ${filtered[0]?.embeddingSimilarity.toFixed(3)} - ${filtered[filtered.length - 1]?.embeddingSimilarity.toFixed(3)}`);

    return filtered;
  }

  /**
   * 批量生成缺失的 embedding 向量
   */
  private async generateMissingEmbeddings(contents: ContentPool[]): Promise<void> {
    logger.info(`Generating embeddings for ${contents.length} contents`);

    // 批量处理，每次最多 100 条
    const batchSize = 100;
    for (let i = 0; i < contents.length; i += batchSize) {
      const batch = contents.slice(i, i + batchSize);
      const texts = batch.map(c => this.prepareTextForEmbedding(c));

      try {
        const embeddings = await this.embeddingClient.getBatchEmbeddings(texts);

        // 将向量序列化并存储到对象中
        for (let j = 0; j < batch.length; j++) {
          batch[j].embedding_vector = this.serializeVector(embeddings[j]);
        }

        logger.debug(`Batch ${Math.floor(i / batchSize) + 1} completed: ${batch.length} embeddings`);
      } catch (error) {
        logger.error(`Failed to generate embeddings for batch ${Math.floor(i / batchSize) + 1}:`, error);
        throw error;
      }
    }
  }

  /**
   * 准备用于 embedding 的文本
   * 组合标题和内容，限制长度
   */
  private prepareTextForEmbedding(content: ContentPool): string {
    const title = content.title || '';
    const text = content.content || '';
    const combined = title ? `${title}\n\n${text}` : text;

    // 限制长度（OpenAI embedding 最大 8191 tokens，约 32000 字符）
    const maxLength = 8000;
    return combined.length > maxLength ? combined.slice(0, maxLength) : combined;
  }

  /**
   * 序列化向量为字符串（用于存储）
   */
  private serializeVector(vector: number[]): string {
    return JSON.stringify(vector);
  }

  /**
   * 反序列化向量字符串
   */
  private deserializeVector(vectorStr: string): number[] {
    return JSON.parse(vectorStr);
  }

  /**
   * 将 ContentPool 转换为 ContentItem
   */
  private convertToContentItem(pool: ContentPool): ContentItem {
    return {
      source: pool.source as any,
      title: pool.title || '',
      content: pool.content,
      url: pool.url || '',
      author: pool.author,
      publishedAt: pool.published_at ? new Date(pool.published_at) : new Date(),
      metrics: pool.metrics ? JSON.parse(pool.metrics) : undefined,
      collectedAt: pool.collected_at ? new Date(pool.collected_at) : new Date(),
    };
  }
}
