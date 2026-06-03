import { BaseScraper } from './base.js';
import { ContentItem } from '../types/content.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { hasLocalBrowserProfile, launchLocalBrowser } from './local-browser.js';
import { RecoverableFailure } from '../utils/failure.js';
import type { RateLimiter } from '../utils/rate-limiter.js';
import type { KeywordCookieSourceRuntimeConfig } from '../types/runtime-config.js';
import type { Page } from 'puppeteer';

interface ZhihuHotItem {
  title: string;
  url: string;
  excerpt: string;
  heat: string;
  author?: string;
}

interface ZhihuDailyResponse {
  stories?: Array<{
    title: string;
    url: string;
    hint?: string;
  }>;
}

/**
 * 知乎内容爬虫
 * 配置关键词后走登录浏览器搜索；未配置关键词时使用知乎日报公开 API 作为 fallback
 */
export class ZhihuScraper extends BaseScraper {
  protected source = 'zhihu';
  protected baseUrl = 'https://www.zhihu.com';
  protected healthCheckKeywords = ['知乎'];
  private sourceConfig: KeywordCookieSourceRuntimeConfig;
  private keywords: string[];

  constructor(rateLimiter: RateLimiter, sourceConfig?: KeywordCookieSourceRuntimeConfig) {
    super(rateLimiter);
    this.sourceConfig = sourceConfig || {
      userId: process.env.USER_ID || 'local',
      enabled: true,
      keywords: config.chineseSources.zhihuKeywords,
      cookie: config.chineseSources.zhihuCookie,
    };
    this.keywords = this.sourceConfig.keywords;
  }

  async scrape(): Promise<ContentItem[]> {
    try {
      logger.info('Starting Zhihu scrape...');

      if (this.keywords.length > 0) {
        return await this.scrapeKeywords();
      }

      return await this.scrapeDailyFallback();
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.error('Zhihu scrape failed:', error as Error);
      return [];
    }
  }

  private async scrapeKeywords(): Promise<ContentItem[]> {
    const allItems: ContentItem[] = [];

    for (const keyword of this.keywords) {
      try {
        await this.rateLimiter.execute(async () => {
          const rows = await this.searchByBrowser(keyword);
          allItems.push(...rows.map((row) => this.convertToContentItem(row, keyword)));
        });
        await this.randomDelay(800, 1500);
      } catch (error) {
        if (error instanceof RecoverableFailure) {
          throw error;
        }
        logger.error(`Failed to search Zhihu keyword "${keyword}":`, error as Error);
      }
    }

    const dedupedItems = this.deduplicateByUrl(
      allItems.filter((item) => this.validateItem(item))
    );
    logger.info(`Zhihu keyword scrape completed: ${dedupedItems.length} items collected`);
    return dedupedItems;
  }

  private async searchByBrowser(keyword: string): Promise<ZhihuHotItem[]> {
    if (!hasLocalBrowserProfile('zhihu', this.sourceConfig.userId)) {
      throw new RecoverableFailure('auth_required', '知乎需要先完成本地登录', true, '重新登录');
    }

    let browser;
    try {
      browser = await launchLocalBrowser('zhihu', this.sourceConfig.userId, this.sourceConfig.browserHeadless);
      const page = await browser.newPage();
      await page.goto(
        `${this.baseUrl}/search?type=content&q=${encodeURIComponent(keyword)}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      );
      await this.randomDelay(5000, 7000);
      await page.mouse.wheel({ deltaY: 1600 }).catch(() => undefined);
      await this.randomDelay(1200, 1800);

      const needsLogin = await page
        .evaluate(() => /登录|注册|扫码登录/.test(document.body.innerText || ''))
        .catch(() => false);
      const needsVerification = await page
        .evaluate(() => {
          const text = `${document.title}\n${location.href}\n${document.body.innerText || ''}`;
          return /account\/unhuman|安全验证|系统监测到.*网络环境|开始验证|访问异常|verify|captcha/i.test(text);
        })
        .catch(() => false);
      const fallbackItems = await this.extractBrowserItems(page);

      if (fallbackItems.length === 0 && needsLogin) {
        throw new RecoverableFailure('auth_required', '知乎登录态失效，需要重新登录', true, '重新登录');
      }

      if (fallbackItems.length === 0 && needsVerification && this.sourceConfig.browserHeadless === false) {
        logger.info(`Zhihu verification required for "${keyword}", waiting for user to finish it`);
        const verifiedItems = await this.waitForBrowserSearchItems(page, keyword);
        if (verifiedItems.length > 0) {
          return verifiedItems;
        }
      }

      if (fallbackItems.length === 0 && needsVerification) {
        throw new RecoverableFailure('captcha_required', '知乎触发安全验证，需要在登录窗口完成验证后重试', true, '处理验证');
      }

      return fallbackItems;
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.warn(`Zhihu browser search failed for "${keyword}": ${(error as Error).message}`);
      return [];
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async waitForBrowserSearchItems(page: Page, keyword: string, timeoutMs = 180_000): Promise<ZhihuHotItem[]> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await this.randomDelay(2000, 3000);
      await page.mouse.wheel({ deltaY: 1200 }).catch(() => undefined);
      const items = await this.extractBrowserItems(page);
      if (items.length > 0) {
        logger.info(`Zhihu browser collected ${items.length} items after verification for "${keyword}"`);
        return items;
      }
    }

    return [];
  }

  private async extractBrowserItems(page: Page): Promise<ZhihuHotItem[]> {
    return page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.SearchResult-Card, .List-item, .ContentItem, [data-za-detail-view-path-module], [class*="SearchItem"]'));
      const items = cards
        .map((card) => {
          const link = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
            .find((anchor) => /\/question\/|\/answer\/|\/p\//.test(anchor.href));
          const titleNode =
            card.querySelector<HTMLElement>('.ContentItem-title') ||
            card.querySelector<HTMLElement>('h2') ||
            link;
          const excerptNode =
            card.querySelector<HTMLElement>('.RichContent-inner') ||
            card.querySelector<HTMLElement>('.SearchResult-CardSummary') ||
            card.querySelector<HTMLElement>('.RichText');
          const authorNode =
            card.querySelector<HTMLElement>('.AuthorInfo-name') ||
            card.querySelector<HTMLElement>('.UserLink-link');
          const heatNode =
            card.querySelector<HTMLElement>('.VoteButton') ||
            card.querySelector<HTMLElement>('[class*="vote"]');

          return {
            title: (titleNode?.innerText || link?.innerText || '').trim(),
            url: link?.href || '',
            excerpt: (excerptNode?.innerText || card.textContent || '').trim(),
            author: (authorNode?.innerText || '').trim(),
            heat: (heatNode?.textContent || '').trim(),
          };
        })
        .filter((item) => item.title && item.url);
      if (items.length > 0) {
        return items.slice(0, 20);
      }

      const seen = new Set<string>();
      const output: ZhihuHotItem[] = [];
      for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/question/"], a[href*="/answer/"], a[href*="/p/"]'))) {
        const url = anchor.href;
        if (seen.has(url)) continue;
        const title = (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (!title || title.length < 4) continue;
        seen.add(url);
        const card = anchor.closest('.SearchResult-Card, .List-item, .ContentItem, [data-za-detail-view-path-module], div');
        output.push({
          title,
          url,
          excerpt: (card?.textContent || title).replace(/\s+/g, ' ').trim(),
          author: '',
          heat: '',
        });
        if (output.length >= 20) break;
      }
      return output;
    });
  }

  private async scrapeDailyFallback(): Promise<ContentItem[]> {
    const response = await this.fetchWithRetry<ZhihuDailyResponse>(
      'https://daily.zhihu.com/api/4/news/latest'
    );
    const hotItems = (response.stories || []).map((story) => ({
      title: story.title,
      url: story.url,
      excerpt: story.hint || story.title,
      heat: '',
    }));
    const items = hotItems.map((item) => this.convertToContentItem(item));
    const dedupedItems = this.deduplicateByUrl(items.filter((item) => this.validateItem(item)));

    logger.info(`Zhihu scrape completed: ${dedupedItems.length} items collected`);
    return dedupedItems;
  }

  private convertToContentItem(item: ZhihuHotItem, keyword?: string): ContentItem {
    const content = item.excerpt || item.title;

    return {
      source: 'zhihu',
      title: keyword ? `[知乎搜索:${keyword}] ${item.title}` : item.title,
      content: this.cleanContent(content),
      url: item.url,
      author: item.author,
      publishedAt: new Date(),
      metrics: {
        points: this.parseHeat(item.heat),
      },
      collectedAt: new Date(),
    };
  }

  private parseHeat(heat: string): number | undefined {
    if (!heat) return undefined;

    const match = heat.match(/([\d.]+)\s*万/);
    if (match) {
      return Math.floor(parseFloat(match[1]) * 10000);
    }

    const numMatch = heat.match(/[\d,]+/);
    if (numMatch) {
      return parseInt(numMatch[0].replace(/,/g, ''), 10);
    }

    return undefined;
  }
}
