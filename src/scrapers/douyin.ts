import { BaseScraper, ScraperPreflightResult } from './base.js';
import { ContentItem } from '../types/content.js';
import { logger } from '../utils/logger.js';
import { retry, retryStrategies } from '../utils/retry.js';
import { config } from '../config.js';
import { hasLocalBrowserProfile, launchLocalBrowser } from './local-browser.js';
import { RecoverableFailure } from '../utils/failure.js';
import { probeCookieSession } from './session-probes.js';
import type { RateLimiter } from '../utils/rate-limiter.js';
import type { DouyinSourceRuntimeConfig } from '../types/runtime-config.js';
import type { Page } from 'puppeteer';

interface DouyinHotResponse {
  data?: {
    word_list?: DouyinHotWord[];
  };
}

interface DouyinHotWord {
  word?: string;
  position?: number;
  hot_value?: number;
  video_count?: number;
  event_time?: number;
}

interface DouyinSearchResponse {
  status_code?: number;
  status_msg?: string;
  data?: DouyinSearchData[];
  aweme_list?: DouyinAweme[] | null;
}

interface DouyinSearchData {
  aweme_info?: DouyinAweme;
}

interface DouyinAweme {
  aweme_id?: string;
  desc?: string;
  create_time?: number;
  share_url?: string;
  author?: {
    nickname?: string;
    unique_id?: string;
    short_id?: string;
  };
  statistics?: {
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
  };
}

interface TikTokDownloaderResponse {
  message?: string;
  data?: unknown;
}

/**
 * 抖音爬虫
 * 默认抓热榜；配置关键词后改用搜索结果
 */
export class DouyinScraper extends BaseScraper {
  protected source = 'douyin';
  protected baseUrl = 'https://www.douyin.com';
  protected healthCheckKeywords = [];
  private sourceConfig: DouyinSourceRuntimeConfig;
  private keywords: string[];

  constructor(rateLimiter: RateLimiter, sourceConfig?: DouyinSourceRuntimeConfig) {
    super(rateLimiter);
    this.sourceConfig = sourceConfig || {
      userId: process.env.USER_ID || 'local',
      enabled: true,
      keywords: config.chineseSources.douyinKeywords,
      cookie: config.chineseSources.douyinCookie,
      tiktokDownloaderApiUrl: config.chineseSources.douyinTikTokDownloaderApiUrl,
      tiktokDownloaderToken: config.chineseSources.douyinTikTokDownloaderToken,
    };
    this.keywords = this.sourceConfig.keywords;
  }

  protected healthCheckUrl(): string {
    return '';
  }

  async preflight(): Promise<ScraperPreflightResult> {
    return await probeCookieSession('douyin', this.sourceConfig.cookie) || { ok: true };
  }

  async scrape(): Promise<ContentItem[]> {
    try {
      logger.info('Starting Douyin scrape...');

      if (this.keywords.length > 0) {
        await this.ensureAuthenticatedSession();
        return await this.scrapeKeywords();
      }

      const response = await this.fetchHotSearchList();
      const words = response.data?.word_list || [];

      const items = words
        .map((word) => this.convertToContentItem(word))
        .filter((item): item is ContentItem => Boolean(item))
        .filter((item) => this.validateItem(item));

      const dedupedItems = this.deduplicateByUrl(items);
      logger.info(`Douyin scrape completed: ${dedupedItems.length} items collected`);

      return dedupedItems;
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.error('Douyin scrape failed:', error as Error);
      return [];
    }
  }

  private async scrapeKeywords(): Promise<ContentItem[]> {
    const allItems: ContentItem[] = [];

    for (const keyword of this.keywords) {
      try {
        await this.rateLimiter.execute(async () => {
          const items = await this.searchContentItems(keyword);
          allItems.push(...items);
        });
        await this.randomDelay(800, 1500);
      } catch (error) {
        if (error instanceof RecoverableFailure) {
          throw error;
        }
        logger.error(`Failed to search Douyin keyword "${keyword}":`, error as Error);
      }
    }

    const dedupedItems = this.deduplicateByUrl(allItems);
    logger.info(`Douyin keyword scrape completed: ${dedupedItems.length} items collected`);
    return dedupedItems;
  }

  private async searchContentItems(keyword: string): Promise<ContentItem[]> {
    if (this.sourceConfig.browserHeadless === false && hasLocalBrowserProfile('douyin', this.sourceConfig.userId)) {
      return this.searchByBrowser(keyword);
    }

    if (this.sourceConfig.tiktokDownloaderApiUrl) {
      const items = await this.searchByTikTokDownloader(keyword);
      if (items.length > 0) {
        return items;
      }
    }

    let response: DouyinSearchResponse;
    try {
      response = await this.searchByKeyword(keyword);
    } catch (error) {
      if (
        error instanceof RecoverableFailure &&
        hasLocalBrowserProfile('douyin', this.sourceConfig.userId)
      ) {
        return this.searchByBrowser(keyword);
      }
      throw error;
    }
    const awemes = this.extractAwemes(response);
    const items = awemes
      .map((aweme) => this.convertSearchItemToContentItem(aweme, keyword))
      .filter((item): item is ContentItem => Boolean(item))
      .filter((item) => this.validateItem(item));

    if (items.length > 0) {
      return items;
    }

    return this.searchByBrowser(keyword);
  }

  private async searchByTikTokDownloader(keyword: string): Promise<ContentItem[]> {
    const endpoint = new URL(
      '/douyin/search/general',
      this.sourceConfig.tiktokDownloaderApiUrl
    ).toString();

    try {
      const response = await this.axiosInstance.post<TikTokDownloaderResponse>(
        endpoint,
        {
          keyword,
          pages: 1,
          count: 20,
          sort_type: 1,
          publish_time: 0,
          duration: 0,
          search_range: 0,
          content_type: 0,
          cookie: this.sourceConfig.cookie,
        },
        {
          headers: this.buildTikTokDownloaderHeaders(),
        }
      );

      const rows = Array.isArray(response.data.data) ? response.data.data : [];
      return rows
        .map((row) => this.convertTikTokDownloaderItem(row, keyword))
        .filter((item): item is ContentItem => Boolean(item))
        .filter((item) => this.validateItem(item));
    } catch (error) {
      logger.warn(`TikTokDownloader Douyin search failed for "${keyword}": ${(error as Error).message}`);
      return [];
    }
  }

  private async searchByKeyword(keyword: string): Promise<DouyinSearchResponse> {
    const params = new URLSearchParams({
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      app_name: 'douyin_web',
      keyword,
      search_channel: 'aweme_general',
      sort_type: '1',
      publish_time: '0',
      count: '20',
      offset: '0',
    });
    const url = `${this.baseUrl}/aweme/v1/web/search/item/?${params.toString()}`;

    return retry(
      async () => {
        logger.debug(`Fetching: ${url}`);
        const response = await this.axiosInstance.get<DouyinSearchResponse>(url, {
          headers: this.buildJsonHeaders(`${this.baseUrl}/search/${encodeURIComponent(keyword)}?type=general`),
        });

        if (response.data.status_code === 2483) {
          throw new RecoverableFailure('auth_required', '抖音登录态失效，需要重新登录', true, '重新登录');
        }

        return response.data;
      },
      {
        maxAttempts: 3,
        initialDelay: 1000,
        shouldRetry: (error: Error) => (
          retryStrategies.networkError(error) ||
          retryStrategies.serverError(error) ||
          retryStrategies.rateLimitError(error)
        ),
      }
    );
  }

  private extractAwemes(response: DouyinSearchResponse): DouyinAweme[] {
    if (Array.isArray(response.aweme_list)) {
      return response.aweme_list;
    }

    return (response.data || [])
      .map((item) => item.aweme_info)
      .filter((item): item is DouyinAweme => Boolean(item));
  }

  private async searchByBrowser(keyword: string): Promise<ContentItem[]> {
    if (!hasLocalBrowserProfile('douyin', this.sourceConfig.userId)) {
      throw new RecoverableFailure('auth_required', '抖音需要先完成本地登录', true, '重新登录');
    }

    let browser;
    try {
      browser = await launchLocalBrowser('douyin', this.sourceConfig.userId, this.sourceConfig.browserHeadless);
      const page = await browser.newPage();
      const responsePromise = this.waitForBrowserSearchResponse(page, keyword);

      await page.goto(
        `${this.baseUrl}/search/${encodeURIComponent(keyword)}?type=general`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      );
      await this.randomDelay(5000, 7000);
      await page.mouse.wheel({ deltaY: 1600 }).catch(() => undefined);
      await this.randomDelay(1200, 1800);

      const initialDomItems = await this.extractBrowserSearchItems(page, keyword);
      if (initialDomItems.length > 0) {
        logger.info(`Douyin browser DOM collected ${initialDomItems.length} items for "${keyword}"`);
        return initialDomItems;
      }
      if (this.sourceConfig.browserHeadless === false && await this.hasBrowserChallenge(page)) {
        logger.info(`Douyin verification required for "${keyword}", waiting for user to finish it`);
        const verifiedItems = await this.waitForBrowserSearchItems(page, keyword);
        if (verifiedItems.length > 0) {
          return verifiedItems;
        }
      }

      const response = await this.withTimeout(responsePromise, 12000, null);
      if (!response) {
        const domItems = await this.extractBrowserSearchItems(page, keyword);
        if (domItems.length > 0) {
          logger.info(`Douyin browser DOM fallback collected ${domItems.length} items for "${keyword}"`);
          return domItems;
        }

        const pageState = await page
          .evaluate(() => ({
            text: document.body.innerText || '',
            hasCaptcha: Boolean(document.querySelector(
              '[class*="captcha"], iframe[src*="captcha"], iframe[src*="verify"], iframe[src*="verifycenter"]'
            )),
          }))
          .catch(() => ({ text: '', hasCaptcha: false }));
        if (pageState.hasCaptcha || /验证码|安全验证|滑块|请完成验证|风控|captcha/i.test(pageState.text)) {
          throw new RecoverableFailure('captcha_required', '抖音触发滑块验证码或风控，需要在登录窗口完成验证后重试', true, '处理验证');
        }
        const needsLogin = /登录|扫码|手机号/.test(pageState.text);
        if (needsLogin) {
          throw new RecoverableFailure('auth_required', '抖音登录态失效，需要重新登录', true, '重新登录');
        }
        throw new RecoverableFailure('platform_changed', '抖音搜索接口未返回结果，可能是反爬或页面改版', false, '等待适配');
      }

      if (response.status_code === 8 || response.status_code === 2483) {
        throw new RecoverableFailure('auth_required', '抖音登录态失效，需要重新登录', true, '重新登录');
      }

      const items = this.extractAwemes(response)
        .map((aweme) => this.convertSearchItemToContentItem(aweme, keyword))
        .filter((item): item is ContentItem => Boolean(item))
        .filter((item) => this.validateItem(item));
      if (items.length === 0) {
        throw new RecoverableFailure('platform_changed', '抖音登录有效，但搜索接口未返回内容，可能是反爬或页面改版', false, '等待适配');
      }
      return items;
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.warn(`Douyin browser search failed for "${keyword}": ${(error as Error).message}`);
      return [];
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async ensureAuthenticatedSession(): Promise<void> {
    const probe = await this.preflight();
    if (!probe.ok && probe.failure) {
      logger.warn(`Douyin session preflight warning: ${probe.failure.userMessage}; continuing with browser search validation`);
    }
  }

  private async extractBrowserSearchItems(page: Page, keyword: string): Promise<ContentItem[]> {
    const rows = await page.evaluate(() => {
      const seen = new Set<string>();
      const output: Array<{ id: string; url: string; title: string }> = [];

      for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"], a[href*="/note/"], a[href*="/user/"]'))) {
        const url = anchor.href;
        const id = url.match(/\/(?:video|note)\/([^/?#]+)/)?.[1] || '';
        if (!id || seen.has(id)) {
          continue;
        }

        const card = anchor.closest('li, article, [class*="search-result"], [class*="card"], [class*="item"]');
        const title = (
          anchor.getAttribute('aria-label') ||
          anchor.getAttribute('title') ||
          anchor.textContent ||
          card?.textContent ||
          ''
        ).replace(/\s+/g, ' ').trim();
        if (!title) {
          continue;
        }

        seen.add(id);
        output.push({ id, url, title: title.slice(0, 280) });
      }

      return output;
    });

    return rows
      .map((row) => ({
        id: `douyin-search-${row.id}`,
        source: 'douyin' as const,
        title: `[抖音搜索:${keyword}] ${row.title}`,
        content: row.title,
        url: row.url,
        publishedAt: new Date(),
        collectedAt: new Date(),
      }))
      .filter((item) => this.validateItem(item));
  }

  private async hasBrowserChallenge(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const text = `${document.title}\n${document.body.innerText || ''}`;
      return /验证码|安全验证|滑块|请完成验证|风控|captcha/i.test(text) ||
        Boolean(document.querySelector(
          '[class*="captcha"], iframe[src*="captcha"], iframe[src*="verify"], iframe[src*="verifycenter"]'
        ));
    }).catch(() => false);
  }

  private async waitForBrowserSearchItems(page: Page, keyword: string, timeoutMs = 180_000): Promise<ContentItem[]> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await this.randomDelay(2000, 3000);
      await page.mouse.wheel({ deltaY: 1200 }).catch(() => undefined);
      const items = await this.extractBrowserSearchItems(page, keyword);
      if (items.length > 0) {
        logger.info(`Douyin browser collected ${items.length} items after verification for "${keyword}"`);
        return items;
      }
    }

    return [];
  }

  private waitForBrowserSearchResponse(
    page: Page,
    keyword: string
  ): Promise<DouyinSearchResponse | null> {
    const encodedKeyword = encodeURIComponent(keyword);

    return new Promise((resolve) => {
      const handler = (response: Awaited<ReturnType<Page['waitForResponse']>>) => {
        void this.handleBrowserSearchResponse(response, encodedKeyword, () => {
          page.off('response', handler);
        }, resolve);
      };

      page.on('response', handler);
    });
  }

  private async handleBrowserSearchResponse(
    response: Awaited<ReturnType<Page['waitForResponse']>>,
    encodedKeyword: string,
    removeListener: () => void,
    resolve: (value: DouyinSearchResponse | null) => void
  ): Promise<void> {
    const url = response.url();
    if (!this.isBrowserSearchResponseUrl(url, encodedKeyword)) {
      return;
    }

    removeListener();
    const text = await response.text().catch(() => '');
    resolve(this.parseBrowserSearchResponse(text));
  }

  private isBrowserSearchResponseUrl(url: string, encodedKeyword: string): boolean {
    const isSearchApi =
      url.includes('/aweme/v1/web/general/search/stream/') ||
      url.includes('/aweme/v1/web/general/search/single/');
    if (!isSearchApi) {
      return false;
    }

    return url.includes(`keyword=${encodedKeyword}`) ||
      url.includes(`keyword=${encodedKeyword.toLowerCase()}`) ||
      url.includes(`keyword=${decodeURIComponent(encodedKeyword)}`);
  }

  private parseBrowserSearchResponse(text: string): DouyinSearchResponse | null {
    const direct = this.parseJsonObject(text);
    if (direct) {
      return direct;
    }

    const data: DouyinSearchData[] = [];
    for (const line of text.split('\n')) {
      const parsed = this.parseJsonObject(line);
      if (parsed?.data) {
        data.push(...parsed.data);
      }
      if (parsed?.aweme_list) {
        data.push(...parsed.aweme_list.map((aweme) => ({ aweme_info: aweme })));
      }
    }

    return data.length > 0 ? { status_code: 0, data } : null;
  }

  private parseJsonObject(text: string): DouyinSearchResponse | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(text.slice(start, end + 1)) as DouyinSearchResponse;
    } catch {
      return null;
    }
  }

  private async fetchHotSearchList(): Promise<DouyinHotResponse> {
    const url = `${this.baseUrl}/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web`;

    return retry(
      async () => {
        logger.debug(`Fetching: ${url}`);
        const response = await this.axiosInstance.get<DouyinHotResponse>(url, {
          headers: this.buildJsonHeaders(`${this.baseUrl}/`),
        });
        return response.data;
      },
      {
        maxAttempts: 3,
        initialDelay: 1000,
        shouldRetry: (error: Error) => (
          retryStrategies.networkError(error) ||
          retryStrategies.serverError(error) ||
          retryStrategies.rateLimitError(error)
        ),
      }
    );
  }

  private buildJsonHeaders(referer: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.getRandomUserAgent(),
      'Accept': 'application/json,text/plain,*/*',
      'Referer': referer,
    };

    if (this.sourceConfig.cookie) {
      headers.Cookie = this.sourceConfig.cookie;
    }

    return headers;
  }

  private buildTikTokDownloaderHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.sourceConfig.tiktokDownloaderToken) {
      headers.token = this.sourceConfig.tiktokDownloaderToken;
    }

    return headers;
  }

  private convertToContentItem(item: DouyinHotWord): ContentItem | null {
    const word = item.word?.trim();
    if (!word) {
      return null;
    }

    const position = item.position ? `#${item.position}` : '热榜';
    const hotValue = item.hot_value ? `热度 ${item.hot_value}` : '热度未知';
    const videoCount = item.video_count ? `相关视频 ${item.video_count}` : '';

    return {
      source: 'douyin',
      title: `[抖音热榜 ${position}] ${word}`,
      content: this.cleanContent([word, hotValue, videoCount].filter(Boolean).join('，')),
      url: `${this.baseUrl}/search/${encodeURIComponent(word)}?type=general`,
      author: '抖音热榜',
      publishedAt: item.event_time ? new Date(item.event_time * 1000) : new Date(),
      metrics: {
        points: item.hot_value,
        comments: item.video_count,
      },
      collectedAt: new Date(),
    };
  }

  private convertSearchItemToContentItem(item: DouyinAweme, keyword: string): ContentItem | null {
    const title = item.desc?.trim();
    const id = item.aweme_id;
    if (!title || !id) {
      return null;
    }

    return {
      source: 'douyin',
      title: `[抖音搜索:${keyword}] ${title}`,
      content: this.cleanContent(title),
      url: item.share_url || `${this.baseUrl}/video/${id}`,
      author: item.author?.nickname || item.author?.unique_id || item.author?.short_id,
      publishedAt: item.create_time ? new Date(item.create_time * 1000) : new Date(),
      metrics: {
        likes: item.statistics?.digg_count,
        comments: item.statistics?.comment_count,
        shares: item.statistics?.share_count,
      },
      collectedAt: new Date(),
    };
  }

  private convertTikTokDownloaderItem(item: unknown, keyword: string): ContentItem | null {
    const row = this.asRecord(item);
    const aweme = this.asRecord(row?.aweme_info) || row;
    if (!aweme) {
      return null;
    }

    const id = this.stringValue(aweme.aweme_id) || this.stringValue(row?.id);
    const title = this.stringValue(aweme.desc) || this.stringValue(row?.desc);
    if (!id || !title) {
      return null;
    }

    const statistics = this.asRecord(aweme.statistics);
    const author = this.asRecord(aweme.author);
    const timestamp = this.numberValue(aweme.create_time) || this.numberValue(row?.create_timestamp);

    return {
      source: 'douyin',
      title: `[抖音搜索:${keyword}] ${title}`,
      content: this.cleanContent(title),
      url: this.stringValue(row?.share_url) || this.stringValue(aweme.share_url) || `${this.baseUrl}/video/${id}`,
      author:
        this.stringValue(row?.nickname) ||
        this.stringValue(author?.nickname) ||
        this.stringValue(author?.unique_id) ||
        this.stringValue(author?.short_id),
      publishedAt: timestamp ? new Date(timestamp * 1000) : new Date(),
      metrics: {
        likes: this.numberValue(row?.digg_count) || this.numberValue(statistics?.digg_count),
        comments: this.numberValue(row?.comment_count) || this.numberValue(statistics?.comment_count),
        shares: this.numberValue(row?.share_count) || this.numberValue(statistics?.share_count),
      },
      collectedAt: new Date(),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  }

  private stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private numberValue(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }

    return undefined;
  }
}
