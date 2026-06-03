import { BaseScraper } from './base.js';
import { ContentItem } from '../types/content.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { hasLocalBrowserProfile, launchLocalBrowser } from './local-browser.js';
import { RecoverableFailure } from '../utils/failure.js';
import type { RateLimiter } from '../utils/rate-limiter.js';
import type { KeywordCookieSourceRuntimeConfig } from '../types/runtime-config.js';

interface WeiboSearchItem {
  title: string;
  url: string;
  author?: string;
  likes?: number;
  comments?: number;
  shares?: number;
}

export class WeiboScraper extends BaseScraper {
  protected source = 'weibo';
  protected baseUrl = 'https://s.weibo.com';
  protected healthCheckKeywords = ['Sina Visitor System', '微博', 'weibo'];

  protected healthCheckUrl(): string {
    return `${this.baseUrl}/weibo?q=AI`;
  }
  private sourceConfig: KeywordCookieSourceRuntimeConfig;
  private keywords: string[];

  constructor(rateLimiter: RateLimiter, sourceConfig?: KeywordCookieSourceRuntimeConfig) {
    super(rateLimiter);
    this.sourceConfig = sourceConfig || {
      userId: process.env.USER_ID || 'local',
      enabled: true,
      keywords: config.chineseSources.weiboKeywords,
      cookie: config.chineseSources.weiboCookie,
    };
    this.keywords = this.sourceConfig.keywords;
  }

  async scrape(): Promise<ContentItem[]> {
    try {
      logger.info('Starting Weibo scrape...');
      const keywords = this.keywords.length > 0 ? this.keywords : config.chineseSources.keywords;
      if (keywords.length === 0) {
        logger.warn('Weibo search requires keywords');
        return [];
      }

      const allItems: ContentItem[] = [];
      for (const keyword of keywords) {
        try {
          await this.rateLimiter.execute(async () => {
            const items = await this.searchByBrowser(keyword);
            allItems.push(...items.map((item) => this.convertToContentItem(item, keyword)));
          });
          await this.randomDelay(1000, 1800);
        } catch (error) {
          if (error instanceof RecoverableFailure) {
            throw error;
          }
          logger.error(`Failed to search Weibo keyword "${keyword}":`, error as Error);
        }
      }

      const dedupedItems = this.deduplicateByUrl(
        allItems.filter((item) => this.validateItem(item))
      );
      logger.info(`Weibo scrape completed: ${dedupedItems.length} items collected`);
      return dedupedItems;
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.error('Weibo scrape failed:', error as Error);
      return [];
    }
  }

  private async searchByBrowser(keyword: string): Promise<WeiboSearchItem[]> {
    if (!hasLocalBrowserProfile('weibo', this.sourceConfig.userId)) {
      throw new RecoverableFailure('auth_required', '微博需要先完成本地登录', true, '重新登录');
    }

    let browser;
    try {
      browser = await launchLocalBrowser('weibo', this.sourceConfig.userId, this.sourceConfig.browserHeadless);
      const page = await browser.newPage();
      await page.goto(
        `${this.baseUrl}/weibo?q=${encodeURIComponent(keyword)}&xsort=hot&suball=1`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      );
      await this.randomDelay(5000, 7000);
      await page.mouse.wheel({ deltaY: 1800 }).catch(() => undefined);
      await this.randomDelay(1200, 1800);

      const needsLogin = await page
        .evaluate(() => /登录|扫码登录|账号登录/.test(document.body.innerText || ''))
        .catch(() => false);
      const items = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[action-type="feed_list_item"], .card-wrap, .vue-recycle-scroller__item-view'));
        return cards
          .map((card) => {
            const textNode =
              card.querySelector<HTMLElement>('[node-type="feed_list_content_full"]') ||
              card.querySelector<HTMLElement>('[node-type="feed_list_content"]') ||
              card.querySelector<HTMLElement>('.txt') ||
              card.querySelector<HTMLElement>('[class*="content"]');
            const authorNode =
              card.querySelector<HTMLElement>('.name') ||
              card.querySelector<HTMLElement>('a[nick-name]') ||
              card.querySelector<HTMLElement>('a[href*="/u/"]');
            const link =
              Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
                .find((anchor) => /\/\d+\/[A-Za-z0-9]+(?:\?|$)|\/detail\/\d+/.test(anchor.href)) ||
              Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))
                .find((anchor) => /weibo\.com/.test(anchor.href));
            const toolbarText = card.textContent || '';

            return {
              title: (textNode?.innerText || '').replace(/\s+/g, ' ').trim(),
              url: link?.href || '',
              author: (authorNode?.innerText || authorNode?.getAttribute('nick-name') || '').trim(),
              likes: parseChineseCount(toolbarText.match(/赞\s*([\d.万]+)/)?.[1]),
              comments: parseChineseCount(toolbarText.match(/评论\s*([\d.万]+)/)?.[1]),
              shares: parseChineseCount(toolbarText.match(/转发\s*([\d.万]+)/)?.[1]),
            };
          })
          .filter((item) => item.title && item.url)
          .slice(0, 20);

        function parseChineseCount(value: string | undefined): number | undefined {
          if (!value) return undefined;
          const parsed = parseFloat(value.replace(/[^\d.]/g, ''));
          if (Number.isNaN(parsed)) return undefined;
          return value.includes('万') ? Math.round(parsed * 10000) : Math.round(parsed);
        }
      });

      if (items.length === 0 && needsLogin) {
        throw new RecoverableFailure('auth_required', '微博登录态失效，需要重新登录', true, '重新登录');
      }

      return items;
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.warn(`Weibo browser search failed for "${keyword}": ${(error as Error).message}`);
      return [];
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private convertToContentItem(item: WeiboSearchItem, keyword: string): ContentItem {
    return {
      source: 'weibo',
      title: `[微博搜索:${keyword}] ${item.title}`,
      content: this.cleanContent(item.title),
      url: item.url,
      author: item.author,
      publishedAt: new Date(),
      metrics: {
        likes: item.likes,
        comments: item.comments,
        shares: item.shares,
      },
      collectedAt: new Date(),
    };
  }
}
