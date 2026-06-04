import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { SourceName, UserRuntimeConfig } from './types/runtime-config.js';

// 加载环境变量
dotenv.config();

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isSourceEnabled(source: SourceName): boolean {
  const enabledSources = parseList(process.env.ENABLED_SOURCES || '') as SourceName[];
  const disabledSources = parseList(process.env.DISABLED_SOURCES || '') as SourceName[];

  if (enabledSources.length > 0) {
    return enabledSources.includes(source);
  }

  return !disabledSources.includes(source);
}

/**
 * 应用配置
 */
export const config = {
  // 数据库配置
  dbPath: process.env.DB_PATH || './data/scout.db',

  // 日志配置
  logLevel: process.env.LOG_LEVEL || 'info',
  logFile: process.env.LOG_FILE || './logs/app.log',

  // 私有画像配置
  profile: {
    path: process.env.PROFILE_PATH || '',
  },

  // OpenAI 配置（保留兼容旧配置）
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
  },

  // Embedding 配置（默认使用阿里云百炼 OpenAI 兼容接口）
  embedding: {
    apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
    baseURL:
      process.env.EMBEDDING_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: process.env.EMBEDDING_MODEL || 'text-embedding-v4',
  },

  // DeepSeek 配置（可选）
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  },

  cloud: {
    aiMode: process.env.SPARK_AI_MODE === 'cloud' ? 'cloud' : 'local',
    baseURL: process.env.SPARK_CLOUD_URL || 'http://127.0.0.1:8787',
    token: process.env.SPARK_CLOUD_TOKEN || '',
    email: process.env.SPARK_CLOUD_EMAIL || '',
  },

  // 创作者账号配置
  xAccount: {
    handle: process.env.X_ACCOUNT_HANDLE || 'example_creator',
  },

  // Reddit 配置：API 审批前使用 RSS 抓取公开 subreddit
  reddit: {
    subreddits: (process.env.REDDIT_SUBREDDITS || 'LocalLLaMA,OpenAI,ChatGPT,artificial,MachineLearning,programming,startups,technology')
      .split(',')
      .map((subreddit) => subreddit.trim().replace(/^r\//i, ''))
      .filter(Boolean),
  },

  // 中文平台搜索配置：配置关键词后，抖音/小红书会从热榜模式切到搜索模式
  chineseSources: {
    keywords: parseList(process.env.CONTENT_SEARCH_KEYWORDS || ''),
    zhihuKeywords: parseList(process.env.ZHIHU_SEARCH_KEYWORDS || process.env.CONTENT_SEARCH_KEYWORDS || ''),
    douyinKeywords: parseList(process.env.DOUYIN_SEARCH_KEYWORDS || process.env.CONTENT_SEARCH_KEYWORDS || ''),
    xiaohongshuKeywords: parseList(process.env.XIAOHONGSHU_SEARCH_KEYWORDS || process.env.CONTENT_SEARCH_KEYWORDS || ''),
    weiboKeywords: parseList(process.env.WEIBO_SEARCH_KEYWORDS || process.env.CONTENT_SEARCH_KEYWORDS || ''),
    zhihuCookie: process.env.ZHIHU_COOKIE || '',
    douyinCookie: process.env.DOUYIN_COOKIE || '',
    douyinTikTokDownloaderApiUrl: process.env.DOUYIN_TIKTOKDOWNLOADER_API_URL || '',
    douyinTikTokDownloaderToken: process.env.DOUYIN_TIKTOKDOWNLOADER_TOKEN || '',
    xiaohongshuCookie: process.env.XIAOHONGSHU_COOKIE || '',
    weiboCookie: process.env.WEIBO_COOKIE || '',
    xiaohongshuAdapter: process.env.XIAOHONGSHU_ADAPTER || 'redbook',
    xiaohongshuCookieSource: process.env.XIAOHONGSHU_COOKIE_SOURCE || 'chrome',
    xiaohongshuChromeProfile: process.env.XIAOHONGSHU_CHROME_PROFILE || '',
  },

  // 飞书配置
  lark: {
    appId: process.env.LARK_APP_ID || '',
    appSecret: process.env.LARK_APP_SECRET || '',
    baseId: process.env.LARK_BASE_ID || '',
    defaultReceiverId: process.env.FEISHU_DEFAULT_RECEIVER_ID || '',
  },

  // 速率限制配置
  rateLimit: {
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_REQUESTS || '3', 10),
    requestDelayMs: parseInt(process.env.REQUEST_DELAY_MS || '1000', 10),
  },

  // 定时任务配置
  cronSchedule: process.env.CRON_SCHEDULE || '0 9 * * *',
} as const;

export function createLocalRuntimeConfig(): UserRuntimeConfig {
  return {
    userId: process.env.USER_ID || 'local',
    accountHandle: config.xAccount.handle,
    profilePath: config.profile.path,
    sources: {
      x: {
        enabled: isSourceEnabled('x'),
      },
      hackernews: {
        enabled: isSourceEnabled('hackernews'),
      },
      github: {
        enabled: isSourceEnabled('github'),
      },
      zhihu: {
        enabled: isSourceEnabled('zhihu'),
        keywords: config.chineseSources.zhihuKeywords,
        cookie: config.chineseSources.zhihuCookie,
      },
      producthunt: {
        enabled: isSourceEnabled('producthunt'),
      },
      reddit: {
        enabled: isSourceEnabled('reddit'),
        subreddits: config.reddit.subreddits,
      },
      v2ex: {
        enabled: isSourceEnabled('v2ex'),
      },
      douyin: {
        enabled: isSourceEnabled('douyin'),
        keywords: config.chineseSources.douyinKeywords,
        cookie: config.chineseSources.douyinCookie,
        tiktokDownloaderApiUrl: config.chineseSources.douyinTikTokDownloaderApiUrl,
        tiktokDownloaderToken: config.chineseSources.douyinTikTokDownloaderToken,
      },
      xiaohongshu: {
        enabled: isSourceEnabled('xiaohongshu'),
        keywords: config.chineseSources.xiaohongshuKeywords,
        cookie: config.chineseSources.xiaohongshuCookie,
        adapter: config.chineseSources.xiaohongshuAdapter === 'native' ? 'native' : 'redbook',
        cookieSource: (
          config.chineseSources.xiaohongshuCookieSource === 'safari' ||
          config.chineseSources.xiaohongshuCookieSource === 'firefox'
        )
          ? config.chineseSources.xiaohongshuCookieSource
          : 'chrome',
        chromeProfile: config.chineseSources.xiaohongshuChromeProfile,
      },
      weibo: {
        enabled: isSourceEnabled('weibo'),
        keywords: config.chineseSources.weiboKeywords,
        cookie: config.chineseSources.weiboCookie,
      },
    },
    lark: {
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
      baseId: config.lark.baseId,
      defaultReceiverId: config.lark.defaultReceiverId,
    },
    ai: {
      mode: config.cloud.aiMode,
      cloud: {
        baseURL: config.cloud.baseURL,
        token: config.cloud.token,
        email: config.cloud.email,
        expiresAt: '',
      },
      embedding: {
        apiKey: config.embedding.apiKey,
        baseURL: config.embedding.baseURL,
        model: config.embedding.model,
      },
      deepseek: {
        apiKey: config.deepseek.apiKey,
        baseURL: config.deepseek.baseURL,
      },
    },
    schedule: {
      cronSchedule: config.cronSchedule,
      timezone: process.env.TZ || 'Asia/Shanghai',
    },
    rateLimit: {
      maxConcurrent: config.rateLimit.maxConcurrent,
      requestDelayMs: config.rateLimit.requestDelayMs,
    },
  };
}

export const localRuntimeConfig = createLocalRuntimeConfig();

/**
 * 验证必需的配置项
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.embedding.apiKey) {
    errors.push('EMBEDDING_API_KEY is required');
  }

  if (!config.lark.appId || !config.lark.appSecret) {
    errors.push('LARK_APP_ID and LARK_APP_SECRET are required');
  }

  // LARK_BASE_ID 暂时不做强制校验
  // if (!config.lark.baseId) {
  //   errors.push('LARK_BASE_ID is required');
  // }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

/**
 * 确保必要的目录存在
 */
export function ensureDirectories(): void {
  const dirs = [
    dirname(resolve(config.dbPath)),
    dirname(resolve(config.logFile)),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
