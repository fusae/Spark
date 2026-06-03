import { ContentItem } from './content.js';

export type SourceName = ContentItem['source'];

export const sourceNames: SourceName[] = [
  'x',
  'hackernews',
  'github',
  'zhihu',
  'producthunt',
  'reddit',
  'v2ex',
  'douyin',
  'xiaohongshu',
  'weibo',
];

export interface SourceRuntimeConfig {
  enabled: boolean;
}

export interface RedditSourceRuntimeConfig extends SourceRuntimeConfig {
  subreddits: string[];
}

export interface KeywordCookieSourceRuntimeConfig extends SourceRuntimeConfig {
  userId?: string;
  browserHeadless?: boolean;
  keywords: string[];
  cookie: string;
}

export interface DouyinSourceRuntimeConfig extends SourceRuntimeConfig {
  userId?: string;
  browserHeadless?: boolean;
  keywords: string[];
  cookie: string;
  tiktokDownloaderApiUrl: string;
  tiktokDownloaderToken: string;
}

export interface XiaohongshuSourceRuntimeConfig extends SourceRuntimeConfig {
  userId?: string;
  browserHeadless?: boolean;
  keywords: string[];
  cookie: string;
  adapter: 'redbook' | 'native';
  cookieSource: 'chrome' | 'safari' | 'firefox';
  chromeProfile: string;
}

export interface SourcesRuntimeConfig {
  x: SourceRuntimeConfig;
  hackernews: SourceRuntimeConfig;
  github: SourceRuntimeConfig;
  zhihu: KeywordCookieSourceRuntimeConfig;
  producthunt: SourceRuntimeConfig;
  reddit: RedditSourceRuntimeConfig;
  v2ex: SourceRuntimeConfig;
  douyin: DouyinSourceRuntimeConfig;
  xiaohongshu: XiaohongshuSourceRuntimeConfig;
  weibo: KeywordCookieSourceRuntimeConfig;
}

export interface UserRuntimeConfig {
  userId: string;
  accountHandle: string;
  profilePath: string;
  sources: SourcesRuntimeConfig;
  ai: {
    embedding: {
      apiKey: string;
      baseURL: string;
      model: string;
    };
    deepseek: {
      apiKey: string;
      baseURL: string;
    };
  };
  lark: {
    appId: string;
    appSecret: string;
    baseId: string;
    defaultReceiverId: string;
  };
  schedule: {
    cronSchedule: string;
    timezone: string;
  };
  rateLimit: {
    maxConcurrent: number;
    requestDelayMs: number;
  };
}
