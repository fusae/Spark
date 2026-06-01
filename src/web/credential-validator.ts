import { DouyinScraper, XiaohongshuScraper, WeiboScraper, ZhihuScraper } from '../scrapers/index.js';
import { DeepSeekClient } from '../ai/deepseek.js';
import { EmbeddingClient } from '../ai/embedding.js';
import type { ContentItem } from '../types/content.js';
import type { UserRuntimeConfig } from '../types/runtime-config.js';
import { classifyFailure, RecoverableFailure } from '../utils/failure.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { probeCookieSession } from '../scrapers/session-probes.js';
import type { CookiePlatform } from './cookie-helper.js';

export interface CredentialValidationResult {
  platform: string;
  status: 'valid' | 'invalid' | 'unknown';
  message: string;
  checkedAt: string;
}

export async function validateCredential(
  platform: CookiePlatform,
  config: UserRuntimeConfig
): Promise<CredentialValidationResult> {
  const cookie = cookieForPlatform(platform, config);
  if (!cookie) {
    return result(platform, 'invalid', '还没有保存登录 Cookie');
  }

  try {
    const probe = await probeCookieSession(platform, cookie);
    if (
      probe &&
      !probe.ok &&
      probe.failure &&
      (probe.failure.failureType === 'auth_required' || probe.failure.failureType === 'captcha_required')
    ) {
      return result(platform, 'invalid', probe.failure.userMessage);
    }

    const items = await withTimeout(runScraperValidation(platform, config), 90000);
    if (items.length > 0) {
      return result(platform, 'valid', `验证通过，抓到 ${items.length} 条内容`);
    }

    return result(platform, 'unknown', '已保存 Cookie，但这次没有抓到内容，暂时无法确认是否有效');
  } catch (error) {
    const failure = classifyFailure(error, platform);
    if (failure.failureType === 'auth_required') {
      return result(platform, 'invalid', failure.userMessage);
    }

    return result(platform, 'unknown', failure.userMessage);
  }
}

export type AiCredential = 'embedding' | 'deepseek';

export function isAiCredential(value: string): value is AiCredential {
  return value === 'embedding' || value === 'deepseek';
}

export async function validateAiCredential(
  credential: AiCredential,
  config: UserRuntimeConfig
): Promise<CredentialValidationResult> {
  try {
    if (credential === 'embedding') {
      const { apiKey, baseURL, model } = config.ai.embedding;
      if (!apiKey) {
        return result(credential, 'invalid', '还没有填写内容筛选 API Key');
      }

      const vector = await withTimeout(
        new EmbeddingClient(apiKey, baseURL, model).getEmbedding('Spark credential check'),
        30000
      );
      return vector.length > 0
        ? result(credential, 'valid', `内容筛选 API 可用，向量维度 ${vector.length}`)
        : result(credential, 'unknown', '内容筛选 API 有响应，但没有返回向量');
    }

    const { apiKey, baseURL } = config.ai.deepseek;
    if (!apiKey) {
      return result(credential, 'invalid', '还没有填写内容创作 API Key');
    }

    const text = await withTimeout(
      new DeepSeekClient(apiKey, baseURL).chat('只回复 OK', { maxTokens: 8, temperature: 0 }),
      30000
    );
    return text.trim()
      ? result(credential, 'valid', '内容创作 API 可用')
      : result(credential, 'unknown', '内容创作 API 有响应，但没有返回内容');
  } catch (error) {
    const failure = classifyFailure(error, credential === 'embedding' ? 'Embedding' : 'DeepSeek');
    const invalid = failure.failureType === 'api_unavailable' || failure.failureType === 'api_quota';
    return result(credential, invalid ? 'invalid' : 'unknown', failure.userMessage);
  }
}

async function runScraperValidation(
  platform: CookiePlatform,
  config: UserRuntimeConfig
): Promise<ContentItem[]> {
  const rateLimiter = new RateLimiter({ maxConcurrent: 1, minDelay: 0 });
  const keyword = validationKeyword(config);

  switch (platform) {
    case 'douyin':
      return new DouyinScraper(rateLimiter, {
        ...config.sources.douyin,
        userId: config.userId,
        keywords: [keyword],
      }).scrape();
    case 'xiaohongshu':
      return new XiaohongshuScraper(rateLimiter, {
        ...config.sources.xiaohongshu,
        userId: config.userId,
        keywords: [keyword],
      }).scrape();
    case 'zhihu':
      return new ZhihuScraper(rateLimiter, {
        ...config.sources.zhihu,
        userId: config.userId,
        keywords: [keyword],
      }).scrape();
    case 'weibo':
      return new WeiboScraper(rateLimiter, {
        ...config.sources.weibo,
        userId: config.userId,
        keywords: [keyword],
      }).scrape();
  }
}

function validationKeyword(config: UserRuntimeConfig): string {
  return [
    ...config.sources.douyin.keywords,
    ...config.sources.xiaohongshu.keywords,
    ...config.sources.zhihu.keywords,
    ...config.sources.weibo.keywords,
  ].find(Boolean) || 'AI';
}

function cookieForPlatform(platform: CookiePlatform, config: UserRuntimeConfig): string {
  switch (platform) {
    case 'douyin':
      return config.sources.douyin.cookie;
    case 'xiaohongshu':
      return config.sources.xiaohongshu.cookie;
    case 'zhihu':
      return config.sources.zhihu.cookie;
    case 'weibo':
      return config.sources.weibo.cookie;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RecoverableFailure('network', '登录态验证超时，稍后再试', true));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function result(
  platform: string,
  status: CredentialValidationResult['status'],
  message: string
): CredentialValidationResult {
  return {
    platform,
    status,
    message,
    checkedAt: new Date().toISOString(),
  };
}
