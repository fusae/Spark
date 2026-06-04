import { BaseScraper, ScraperPreflightResult } from './base.js';
import { ContentItem } from '../types/content.js';
import { logger } from '../utils/logger.js';
import { retry, retryStrategies } from '../utils/retry.js';
import { config } from '../config.js';
import { hasLocalBrowserProfile, launchLocalBrowser } from './local-browser.js';
import { RecoverableFailure } from '../utils/failure.js';
import { asRecoverableFailure, probeCookieSession } from './session-probes.js';
import type { RateLimiter } from '../utils/rate-limiter.js';
import type { XiaohongshuSourceRuntimeConfig } from '../types/runtime-config.js';
import {
  compileRuleRegex,
  PlatformScraperRulePayload,
  renderRuleTemplate,
  ruleNumber,
  ruleNumberList,
  ruleRecord,
  ruleString,
  ruleStringList,
} from './rules.js';
import type { Page } from 'puppeteer';

type CookieSource = 'chrome' | 'safari' | 'firefox';
type RedbookClient = {
  searchNotes(
    keyword: string,
    page?: number,
    pageSize?: number,
    sort?: 'general' | 'popularity_descending' | 'time_descending',
    noteType?: 0 | 1 | 2
  ): Promise<unknown>;
};

interface XiaohongshuNote {
  id: string;
  title: string;
  url: string;
  author?: string;
  likes?: number;
  comments?: number;
  shares?: number;
}

interface XiaohongshuSearchResponse {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: {
    items?: XiaohongshuSearchItem[];
  };
}

interface XiaohongshuSearchItem {
  id?: string;
  xsec_token?: string;
  note_card?: {
    note_id?: string;
    display_title?: string;
    desc?: string;
    title?: string;
    user?: {
      nickname?: string;
    };
    interact_info?: {
      liked_count?: string | number;
      comment_count?: string | number;
      share_count?: string | number;
    };
  };
}

/**
 * 小红书爬虫
 * 默认抓 Explore；配置关键词后改用搜索结果
 */
export class XiaohongshuScraper extends BaseScraper {
  protected source = 'xiaohongshu';
  protected baseUrl = 'https://www.xiaohongshu.com';
  protected healthCheckKeywords = ['小红书', 'xiaohongshu'];

  protected healthCheckUrl(): string {
    return `${this.baseUrl}/explore`;
  }

  async preflight(): Promise<ScraperPreflightResult> {
    return await probeCookieSession('xiaohongshu', this.sourceConfig.cookie) || { ok: true };
  }

  private sourceConfig: XiaohongshuSourceRuntimeConfig;
  private keywords: string[];
  private scraperRule: PlatformScraperRulePayload;

  constructor(
    rateLimiter: RateLimiter,
    sourceConfig?: XiaohongshuSourceRuntimeConfig,
    scraperRule: PlatformScraperRulePayload = {}
  ) {
    super(rateLimiter);
    this.sourceConfig = sourceConfig || {
      userId: process.env.USER_ID || 'local',
      enabled: true,
      keywords: config.chineseSources.xiaohongshuKeywords,
      cookie: config.chineseSources.xiaohongshuCookie,
      adapter: config.chineseSources.xiaohongshuAdapter === 'native' ? 'native' : 'redbook',
      cookieSource: this.getCookieSource(config.chineseSources.xiaohongshuCookieSource),
      chromeProfile: config.chineseSources.xiaohongshuChromeProfile,
    };
    this.keywords = this.sourceConfig.keywords;
    this.scraperRule = scraperRule;
  }

  async scrape(): Promise<ContentItem[]> {
    try {
      logger.info('Starting Xiaohongshu scrape...');

      if (this.keywords.length > 0) {
        await this.ensureAuthenticatedSession();
        return await this.scrapeKeywords();
      }

      const html = await this.fetchWithRetry<string>(`${this.baseUrl}/explore`);
      const notes = this.parseNotes(html);

      const items = notes
        .map((note) => this.convertToContentItem(note))
        .filter((item) => this.validateItem(item));

      const dedupedItems = this.deduplicateByUrl(items);
      logger.info(`Xiaohongshu scrape completed: ${dedupedItems.length} items collected`);

      return dedupedItems;
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.error('Xiaohongshu scrape failed:', error as Error);
      return [];
    }
  }

  private async scrapeKeywords(): Promise<ContentItem[]> {
    const allItems: ContentItem[] = [];
    const redbookClient = await this.createRedbookClient();

    for (const keyword of this.keywords) {
      try {
        await this.rateLimiter.execute(async () => {
          const notes = redbookClient
            ? await this.searchByRedbook(redbookClient, keyword)
            : await this.searchByKeyword(keyword);
          const items = notes
            .map((note) => this.convertToContentItem(note, keyword))
            .filter((item) => this.validateItem(item));
          allItems.push(...items);
        });
        await this.randomDelay(800, 1500);
      } catch (error) {
        if (error instanceof RecoverableFailure) {
          throw error;
        }
        logger.error(`Failed to search Xiaohongshu keyword "${keyword}":`, error as Error);
      }
    }

    const dedupedItems = this.deduplicateByUrl(allItems);
    logger.info(`Xiaohongshu keyword scrape completed: ${dedupedItems.length} items collected`);
    return dedupedItems;
  }

  private async createRedbookClient(): Promise<RedbookClient | null> {
    if (this.sourceConfig.adapter !== 'redbook') {
      return null;
    }

    try {
      const { XhsClient } = await import('@lucasygu/redbook');
      const { extractCookies, parseCookieString } = await import('@lucasygu/redbook/cookies');
      const cookies = this.sourceConfig.cookie
        ? parseCookieString(this.sourceConfig.cookie)
        : await extractCookies(
          this.sourceConfig.cookieSource,
          this.sourceConfig.chromeProfile || undefined
        );

      return new XhsClient(cookies);
    } catch (error) {
      logger.warn(`Redbook adapter unavailable: ${(error as Error).message}`);
      return null;
    }
  }

  private async searchByRedbook(client: RedbookClient, keyword: string): Promise<XiaohongshuNote[]> {
    try {
      const response = await client.searchNotes(keyword, 1, 20, 'popularity_descending', 0);
      return this.parseSearchItems(response);
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.warn(`Redbook Xiaohongshu search failed for "${keyword}": ${(error as Error).message}`);
      if (this.isCaptchaFailure(error)) {
        try {
          return await this.searchByKeyword(keyword);
        } catch (fallbackError) {
          if (
            fallbackError instanceof RecoverableFailure &&
            fallbackError.failureType === 'platform_changed'
          ) {
            throw this.captchaFailure();
          }
          throw fallbackError;
        }
      }
      return this.searchByKeyword(keyword);
    }
  }

  private async searchByKeyword(keyword: string): Promise<XiaohongshuNote[]> {
    const html = await this.fetchSearchPage(keyword);
    const pageNotes = [
      ...this.parseNotes(html),
      ...this.parseInitialStateNotes(html),
    ];
    if (pageNotes.length > 0) {
      return pageNotes;
    }

    const response = await this.fetchSearchApi(keyword);
    if (this.isCaptchaResponse(response)) {
      return this.searchByBrowser(keyword);
    }

    if (response.success === false || response.code === -101) {
      return this.searchByBrowser(keyword);
    }

    const apiNotes = (response.data?.items || [])
      .map((item) => this.convertSearchItem(item))
      .filter((item): item is XiaohongshuNote => Boolean(item));

    if (apiNotes.length > 0) {
      return apiNotes;
    }

    return this.searchByBrowser(keyword);
  }

  private async searchByBrowser(keyword: string): Promise<XiaohongshuNote[]> {
    if (!hasLocalBrowserProfile('xiaohongshu', this.sourceConfig.userId)) {
      throw new RecoverableFailure('auth_required', '小红书需要先完成本地登录', true, '重新登录');
    }

    let browser;
    try {
      const browserRule = ruleRecord(this.scraperRule.browser);
      browser = await launchLocalBrowser('xiaohongshu', this.sourceConfig.userId, this.sourceConfig.browserHeadless);
      const page = await browser.newPage();
      const responsePromise = this.waitForBrowserSearchResponse(page);
      const searchUrl = renderRuleTemplate(
        ruleString(browserRule.searchUrlTemplate, `${this.baseUrl}/search_result?keyword={{keyword}}&source=web_search_result_notes`),
        { keyword }
      );
      await page.goto(
        searchUrl,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      );

      const response = await this.withTimeout(responsePromise, ruleNumber(browserRule.responseTimeoutMs, 30000), null);
      if (!response) {
        const pageText = await page
          .evaluate(() => document.body.innerText || '')
          .catch(() => '');
        const needsCaptcha = compileRuleRegex(
          browserRule.challengeTextRegex,
          /验证码|安全验证|滑块|请完成验证|captcha|verify/i
        ).test(pageText);
        const needsLogin = compileRuleRegex(
          browserRule.loginTextRegex,
          /登录后查看搜索结果|手机号登录|扫码/i
        ).test(pageText);
        if (needsCaptcha) {
          throw this.captchaFailure();
        }
        if (needsLogin) {
          throw new RecoverableFailure('auth_required', '小红书登录态失效，需要重新登录', true, '重新登录');
        }
        throw new RecoverableFailure('platform_changed', '小红书搜索接口未返回结果，可能是页面改版', false, '等待适配');
      }

      if (this.isCaptchaResponse(response)) {
        throw this.captchaFailure();
      }

      if (response.success === false || response.code === -101) {
        throw new RecoverableFailure('auth_required', '小红书登录态失效，需要重新登录', true, '重新登录');
      }

      const notes = (response.data?.items || [])
        .map((item) => this.convertSearchItem(item))
        .filter((item): item is XiaohongshuNote => Boolean(item));
      if (notes.length === 0) {
        throw new RecoverableFailure(
          'platform_changed',
          '小红书登录有效，但搜索接口未返回内容，可能是签名失效或页面改版',
          false,
          '等待适配'
        );
      }
      return notes;
    } catch (error) {
      if (error instanceof RecoverableFailure) {
        throw error;
      }
      logger.warn(`Xiaohongshu browser search failed for "${keyword}": ${(error as Error).message}`);
      return [];
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async ensureAuthenticatedSession(): Promise<void> {
    const probe = await this.preflight();
    if (
      !probe.ok &&
      probe.failure &&
      (probe.failure.failureType === 'auth_required' || probe.failure.failureType === 'captcha_required')
    ) {
      throw asRecoverableFailure(probe.failure);
    }
  }

  private captchaFailure(): RecoverableFailure {
    return new RecoverableFailure('captcha_required', '小红书触发验证码或风控，需要在登录窗口完成验证后重试', true, '处理验证');
  }

  private isCaptchaFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    return /captcha|验证码|安全验证|滑块|风控|risk control|risk_control|type=216|verify/i.test(message);
  }

  private isCaptchaResponse(response: XiaohongshuSearchResponse): boolean {
    const message = response.msg || '';
    const apiRule = ruleRecord(this.scraperRule.api);
    const captchaCodes = ruleNumberList(apiRule.captchaStatusCodes, [216]);
    const captchaRegex = compileRuleRegex(
      apiRule.captchaMessageRegex,
      /captcha|验证码|安全验证|滑块|风控|risk control|risk_control|type=216|verify/i
    );
    return (typeof response.code === 'number' && captchaCodes.includes(response.code)) || captchaRegex.test(message);
  }

  private waitForBrowserSearchResponse(page: Page): Promise<XiaohongshuSearchResponse | null> {
    return new Promise((resolve) => {
      const handler = (response: Awaited<ReturnType<Page['waitForResponse']>>) => {
        void this.handleBrowserSearchResponse(response, () => {
          page.off('response', handler);
        }, resolve);
      };

      page.on('response', handler);
    });
  }

  private async handleBrowserSearchResponse(
    response: Awaited<ReturnType<Page['waitForResponse']>>,
    removeListener: () => void,
    resolve: (value: XiaohongshuSearchResponse | null) => void
  ): Promise<void> {
    const browserRule = ruleRecord(this.scraperRule.browser);
    const responseUrlIncludes = ruleStringList(browserRule.responseUrlIncludes, ['/api/sns/web/v1/search/']);
    if (!responseUrlIncludes.some((pattern) => response.url().includes(pattern))) {
      return;
    }

    removeListener();
    const data = await (response.json() as Promise<unknown>).catch((): unknown => null);
    resolve(data as XiaohongshuSearchResponse | null);
  }

  private async fetchSearchPage(keyword: string): Promise<string> {
    const browserRule = ruleRecord(this.scraperRule.browser);
    const url = renderRuleTemplate(
      ruleString(browserRule.searchUrlTemplate, `${this.baseUrl}/search_result?keyword={{keyword}}&source=web_search_result_notes`),
      { keyword }
    );

    return retry(
      async () => {
        logger.debug(`Fetching: ${url}`);
        const response = await this.axiosInstance.get<string>(url, {
          headers: this.buildHtmlHeaders(`${this.baseUrl}/explore`),
        });
        return response.data;
      },
      {
        maxAttempts: 2,
        initialDelay: 1000,
        shouldRetry: (error: Error) => (
          retryStrategies.networkError(error) ||
          retryStrategies.serverError(error) ||
          retryStrategies.rateLimitError(error)
        ),
      }
    );
  }

  private async fetchSearchApi(keyword: string): Promise<XiaohongshuSearchResponse> {
    const apiRule = ruleRecord(this.scraperRule.api);
    const url = ruleString(apiRule.searchUrl, 'https://edith.xiaohongshu.com/api/sns/web/v1/search/notes');
    const body = {
      keyword,
      page: 1,
      page_size: 20,
      search_id: '',
      sort: 'popularity_descending',
      note_type: 0,
      ext_flags: [],
      filters: [],
      geo: '',
      ...ruleRecord(apiRule.body),
    };
    body.keyword = keyword;

    return retry(
      async () => {
        logger.debug(`Fetching: ${url}`);
        const response = await this.axiosInstance.post<XiaohongshuSearchResponse>(
          url,
          body,
          {
            headers: this.buildJsonHeaders(`${this.baseUrl}/search_result?keyword=${encodeURIComponent(keyword)}`),
          }
        );
        return response.data;
      },
      {
        maxAttempts: 2,
        initialDelay: 1000,
        shouldRetry: (error: Error) => (
          retryStrategies.networkError(error) ||
          retryStrategies.serverError(error) ||
          retryStrategies.rateLimitError(error)
        ),
      }
    );
  }

  private parseNotes(html: string): XiaohongshuNote[] {
    const notes: XiaohongshuNote[] = [];
    const sections = html.match(/<section class="note-item"[\s\S]*?<\/section>/g) || [];

    for (const section of sections) {
      const id = section.match(/href="\/explore\/([^"?]+)(?:\?[^"]*)?"/)?.[1];
      const titleHtml = section.match(/class="title"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/)?.[1] ||
        section.match(/class="title"[\s\S]*?>([\s\S]*?)<\/a>/)?.[1] ||
        '';
      const authorHtml = section.match(/class="name"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '';
      const likesText = section.match(/class="count"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '';

      const title = this.cleanText(titleHtml);
      if (!id || !title) {
        continue;
      }

      notes.push({
        id,
        title,
        url: `${this.baseUrl}/explore/${id}`,
        author: this.cleanText(authorHtml),
        likes: this.parseCount(this.cleanText(likesText)),
      });
    }

    return notes;
  }

  private parseInitialStateNotes(html: string): XiaohongshuNote[] {
    const stateText = html.match(/window\.__INITIAL_STATE__=([\s\S]*?)<\/script>/)?.[1];
    if (!stateText) {
      return [];
    }

    try {
      const normalizedState = stateText
        .replace(/:undefined/g, ':null')
        .replace(/,undefined/g, ',null')
        .replace(/\[undefined/g, '[null');
      const state = JSON.parse(normalizedState) as unknown;
      const search = this.asRecord(this.asRecord(state)?.search);
      const feeds = search?.feeds;
      if (!Array.isArray(feeds)) {
        return [];
      }

      return feeds
        .map((feed) => this.convertStateFeed(feed))
        .filter((feed): feed is XiaohongshuNote => Boolean(feed));
    } catch {
      return [];
    }
  }

  private convertToContentItem(note: XiaohongshuNote, keyword?: string): ContentItem {
    return {
      source: 'xiaohongshu',
      title: keyword ? `[小红书搜索:${keyword}] ${note.title}` : note.title,
      content: note.title,
      url: note.url,
      author: note.author,
      publishedAt: new Date(),
      metrics: {
        likes: note.likes,
        comments: note.comments,
        shares: note.shares,
      },
      collectedAt: new Date(),
    };
  }

  private convertSearchItem(item: XiaohongshuSearchItem): XiaohongshuNote | null {
    const card = item.note_card;
    const id = card?.note_id || item.id;
    const title = this.cleanText(card?.display_title || card?.title || card?.desc || '');
    if (!id || !title) {
      return null;
    }

    const xsecToken = item.xsec_token ? `?xsec_token=${encodeURIComponent(item.xsec_token)}&xsec_source=pc_search` : '';

    return {
      id,
      title,
      url: `${this.baseUrl}/explore/${id}${xsecToken}`,
      author: card?.user?.nickname,
      likes: this.parseCount(card?.interact_info?.liked_count),
      comments: this.parseCount(card?.interact_info?.comment_count),
      shares: this.parseCount(card?.interact_info?.share_count),
    };
  }

  private parseSearchItems(response: unknown): XiaohongshuNote[] {
    const result = this.asRecord(response);
    const items = result?.items;
    if (!Array.isArray(items)) {
      return [];
    }

    return items
      .map((item) => this.convertSearchItem(item as XiaohongshuSearchItem))
      .filter((item): item is XiaohongshuNote => Boolean(item));
  }

  private convertStateFeed(feed: unknown): XiaohongshuNote | null {
    const item = this.asRecord(feed);
    const card = this.asRecord(item?.note_card || item?.noteCard || item);
    const id = this.stringValue(card?.note_id) || this.stringValue(item?.id);
    const title = this.cleanText(
      this.stringValue(card?.display_title) ||
      this.stringValue(card?.title) ||
      this.stringValue(card?.desc)
    );
    if (!id || !title) {
      return null;
    }

    const user = this.asRecord(card?.user);
    const interactInfo = this.asRecord(card?.interact_info || card?.interactInfo);
    const xsecToken = this.stringValue(item?.xsec_token);
    const xsecQuery = xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_search` : '';

    return {
      id,
      title,
      url: `${this.baseUrl}/explore/${id}${xsecQuery}`,
      author: this.stringValue(user?.nickname),
      likes: this.parseCount(this.stringValue(interactInfo?.liked_count)),
      comments: this.parseCount(this.stringValue(interactInfo?.comment_count)),
      shares: this.parseCount(this.stringValue(interactInfo?.share_count)),
    };
  }

  private getCookieSource(source: string): CookieSource {
    if (source === 'safari' || source === 'firefox') {
      return source;
    }

    return 'chrome';
  }

  private buildJsonHeaders(referer: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.getRandomUserAgent(),
      'Accept': 'application/json,text/plain,*/*',
      'Content-Type': 'application/json',
      'Origin': this.baseUrl,
      'Referer': referer,
    };

    if (this.sourceConfig.cookie) {
      headers.Cookie = this.sourceConfig.cookie;
    }

    return headers;
  }

  private buildHtmlHeaders(referer: string): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': referer,
    };

    if (this.sourceConfig.cookie) {
      headers.Cookie = this.sourceConfig.cookie;
    }

    return headers;
  }

  private cleanText(text: string): string {
    return this.cleanContent(this.stripHtml(this.decodeHtml(text)));
  }

  private decodeHtml(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  }

  private parseCount(value: string | number | undefined): number | undefined {
    if (typeof value === 'number') {
      return value;
    }

    if (!value) {
      return undefined;
    }

    const normalized = value.trim();
    const count = parseFloat(normalized.replace(/[^\d.]/g, ''));
    if (Number.isNaN(count)) {
      return undefined;
    }

    if (normalized.includes('万')) {
      return Math.round(count * 10000);
    }

    return Math.round(count);
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  }

  private stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
