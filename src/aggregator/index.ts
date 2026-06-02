import { ContentItem, ScraperStats } from '../types/content.js';
import { DatabaseManager, ContentPool } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import {
  HackerNewsScraper,
  GitHubTrendingScraper,
  XScraper,
  ZhihuScraper,
  ProductHuntScraper,
  RedditScraper,
  V2EXScraper,
  DouyinScraper,
  XiaohongshuScraper,
  WeiboScraper,
  BaseScraper,
} from '../scrapers/index.js';
import { localRuntimeConfig } from '../config.js';
import type { SourceName, UserRuntimeConfig } from '../types/runtime-config.js';
import { classifyFailure, FailureInfo } from '../utils/failure.js';
import crypto from 'crypto';

export interface AggregationProgressEvent {
  source: string;
  stats: ScraperStats;
}

export type AggregationProgressCallback = (event: AggregationProgressEvent) => void;

/**
 * 内容聚合器 - 协调所有爬虫并管理内容存储
 */
export class ContentAggregator {
  private db: DatabaseManager;
  private scrapers: Map<string, BaseScraper>;
  private rateLimiter: RateLimiter;
  private userId: string;

  constructor(
    db: DatabaseManager,
    runtimeConfig: UserRuntimeConfig = localRuntimeConfig,
    private onProgress?: AggregationProgressCallback
  ) {
    this.db = db;
    this.userId = runtimeConfig.userId;
    this.rateLimiter = new RateLimiter({
      maxConcurrent: runtimeConfig.rateLimit.maxConcurrent,
      minDelay: runtimeConfig.rateLimit.requestDelayMs,
    });

    const sourceConfig = runtimeConfig.sources;
    const scraperEntries: Array<[SourceName, BaseScraper] | null> = [
      sourceConfig.hackernews.enabled ? ['hackernews', new HackerNewsScraper(this.rateLimiter)] : null,
      sourceConfig.github.enabled ? ['github', new GitHubTrendingScraper(this.rateLimiter)] : null,
      sourceConfig.x.enabled ? ['x', new XScraper(this.rateLimiter)] : null,
      sourceConfig.zhihu.enabled
        ? ['zhihu', new ZhihuScraper(this.rateLimiter, {
          ...sourceConfig.zhihu,
          userId: runtimeConfig.userId,
        })]
        : null,
      sourceConfig.producthunt.enabled ? ['producthunt', new ProductHuntScraper(this.rateLimiter)] : null,
      sourceConfig.reddit.enabled ? ['reddit', new RedditScraper(this.rateLimiter, sourceConfig.reddit)] : null,
      sourceConfig.v2ex.enabled ? ['v2ex', new V2EXScraper(this.rateLimiter)] : null,
      sourceConfig.douyin.enabled
        ? ['douyin', new DouyinScraper(this.rateLimiter, {
          ...sourceConfig.douyin,
          userId: runtimeConfig.userId,
        })]
        : null,
      sourceConfig.xiaohongshu.enabled
        ? ['xiaohongshu', new XiaohongshuScraper(this.rateLimiter, {
          ...sourceConfig.xiaohongshu,
          userId: runtimeConfig.userId,
        })]
        : null,
      sourceConfig.weibo.enabled
        ? ['weibo', new WeiboScraper(this.rateLimiter, {
          ...sourceConfig.weibo,
          userId: runtimeConfig.userId,
        })]
        : null,
    ];

    this.scrapers = new Map<string, BaseScraper>(
      scraperEntries.filter((entry): entry is [SourceName, BaseScraper] => entry !== null)
    );

    logger.info(
      `ContentAggregator initialized for ${runtimeConfig.userId} with ${this.scrapers.size} scrapers`
    );
  }

  /**
   * 运行所有爬虫
   */
  async aggregateAll(): Promise<ScraperStats[]> {
    logger.info('Starting content aggregation from all sources...');
    const startTime = Date.now();

    const stats: ScraperStats[] = [];

    // 并发运行所有爬虫
    const promises = Array.from(this.scrapers.entries()).map(async ([source, scraper]) => {
      const statsForSource = await this.runScraper(source, scraper);
      this.onProgress?.({ source, stats: statsForSource });
      return statsForSource;
    });

    const results = await Promise.allSettled(promises);

    // 收集统计信息
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        stats.push(result.value);
      } else {
        const source = Array.from(this.scrapers.keys())[index];
        const failure = classifyFailure(result.reason, source);
        logger.error(`Scraper ${source} failed:`, result.reason);
        stats.push({
          source,
          itemsCollected: 0,
          itemsDeduped: 0,
          itemsSaved: 0,
          errors: 1,
          duration: 0,
          ...failure,
        });
      }
    });

    const totalDuration = Date.now() - startTime;
    logger.info(`Content aggregation completed in ${totalDuration}ms`);
    this.logStats(stats);

    return stats;
  }

  /**
   * 运行指定的爬虫
   */
  async aggregateFrom(sources: string[]): Promise<ScraperStats[]> {
    logger.info(`Starting content aggregation from: ${sources.join(', ')}`);

    const stats: ScraperStats[] = [];

    for (const source of sources) {
      const scraper = this.scrapers.get(source);
      if (!scraper) {
        logger.warn(`Unknown scraper: ${source}`);
        continue;
      }

      try {
        const stat = await this.runScraper(source, scraper);
        stats.push(stat);
        this.onProgress?.({ source, stats: stat });
      } catch (error) {
        const failure = classifyFailure(error, source);
        logger.error(`Scraper ${source} failed:`, error as Error);
        const stat = {
          source,
          itemsCollected: 0,
          itemsDeduped: 0,
          itemsSaved: 0,
          errors: 1,
          duration: 0,
          ...failure,
        };
        stats.push(stat);
        this.onProgress?.({ source, stats: stat });
      }
    }

    this.logStats(stats);
    return stats;
  }

  /**
   * 运行单个爬虫
   */
  private async runScraper(source: string, scraper: BaseScraper): Promise<ScraperStats> {
    const startTime = Date.now();
    let itemsCollected = 0;
    let itemsDeduped = 0;
    let itemsSaved = 0;
    let errors = 0;
    let failure: FailureInfo | undefined;

    try {
      logger.info(`Running scraper: ${source}`);
      const preflight = await scraper.preflight();
      let preflightFailure: FailureInfo | undefined;
      if (!preflight.ok) {
        preflightFailure = preflight.failure;
        logger.warn(
          `Scraper ${source} preflight failed, trying scrape anyway: ${preflightFailure?.userMessage || 'unknown failure'}`
        );
      }

      // 执行爬取
      const items = await scraper.scrape();
      itemsCollected = items.length;

      if (items.length === 0) {
        logger.warn(`No items collected from ${source}`);
        return {
          source,
          itemsCollected: 0,
          itemsDeduped: 0,
          itemsSaved: 0,
          errors: preflightFailure ? 1 : 0,
          duration: Date.now() - startTime,
          ...preflightFailure,
        };
      }

      // 去重（与数据库中已有内容对比）
      const dedupedItems = this.deduplicateWithDatabase(items);
      itemsDeduped = items.length - dedupedItems.length;

      // 保存到数据库
      itemsSaved = this.saveItems(dedupedItems);

      logger.info(
        `Scraper ${source} completed: ${itemsCollected} collected, ${itemsDeduped} duplicates, ${itemsSaved} saved`
      );
    } catch (error) {
      failure = classifyFailure(error, source);
      logger.error(`Scraper ${source} encountered an error:`, error as Error);
      errors = 1;
    }

    return {
      source,
      itemsCollected,
      itemsDeduped,
      itemsSaved,
      errors,
      duration: Date.now() - startTime,
      ...failure,
    };
  }

  /**
   * 与数据库中的内容去重
   */
  private deduplicateWithDatabase(items: ContentItem[]): ContentItem[] {
    const uniqueItems: ContentItem[] = [];

    for (const item of items) {
      // 检查 URL 是否已存在
      if (item.url && this.isUrlExists(item.url)) {
        logger.debug(`Duplicate URL found: ${item.url}`);
        continue;
      }

      // 检查内容哈希是否已存在
      const contentHash = this.generateContentHash(item);
      if (this.isContentHashExists(contentHash)) {
        logger.debug(`Duplicate content hash found for: ${item.title}`);
        continue;
      }

      uniqueItems.push(item);
    }

    return uniqueItems;
  }

  /**
   * 检查 URL 是否已存在
   */
  private isUrlExists(url: string): boolean {
    try {
      const existing = this.db.getContentByUrl(url, this.userId);
      return !!existing;
    } catch (error) {
      logger.error('Error checking URL existence:', error as Error);
      return false;
    }
  }

  /**
   * 检查内容哈希是否已存在
   */
  private isContentHashExists(hash: string): boolean {
    try {
      const existing = this.db.getContentByHash(hash);
      return !!existing;
    } catch (error) {
      logger.error('Error checking content hash:', error as Error);
      return false;
    }
  }

  /**
   * 生成内容哈希（用于去重）
   */
  private generateContentHash(item: ContentItem): string {
    const content = `${item.title}|${item.url}`;
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * 保存内容到数据库
   */
  private saveItems(items: ContentItem[]): number {
    let savedCount = 0;

    for (const item of items) {
      try {
        const contentPool: ContentPool = {
          user_id: this.userId,
          source: item.source,
          title: item.title,
          content: item.content,
          url: item.url,
          author: item.author,
          published_at: item.publishedAt.toISOString(),
          metrics: item.metrics ? JSON.stringify(item.metrics) : undefined,
          collected_at: item.collectedAt.toISOString(),
        };

        this.db.insertContent(contentPool);
        savedCount++;
      } catch (error) {
        logger.error(`Failed to save item: ${item.title}`, error as Error);
      }
    }

    return savedCount;
  }

  /**
   * 清理过期内容（7天前）
   */
  async cleanupOldContent(daysOld: number = 7): Promise<number> {
    logger.info(`Cleaning up content older than ${daysOld} days...`);
    await Promise.resolve();

    try {
      const deletedCount = this.db.deleteOldContent(daysOld);
      logger.info(`Deleted ${deletedCount} old content items`);
      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup old content:', error as Error);
      return 0;
    }
  }

  /**
   * 记录统计信息
   */
  private logStats(stats: ScraperStats[]): void {
    const totalCollected = stats.reduce((sum, s) => sum + s.itemsCollected, 0);
    const totalDeduped = stats.reduce((sum, s) => sum + s.itemsDeduped, 0);
    const totalSaved = stats.reduce((sum, s) => sum + s.itemsSaved, 0);
    const totalErrors = stats.reduce((sum, s) => sum + s.errors, 0);

    logger.info('=== Aggregation Summary ===');
    logger.info(`Total collected: ${totalCollected}`);
    logger.info(`Total duplicates: ${totalDeduped}`);
    logger.info(`Total saved: ${totalSaved}`);
    logger.info(`Total errors: ${totalErrors}`);

    stats.forEach((stat) => {
      logger.info(
        `  ${stat.source}: ${stat.itemsCollected} collected, ${stat.itemsSaved} saved (${stat.duration}ms)`
      );
    });
  }
}
