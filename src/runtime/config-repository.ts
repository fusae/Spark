import {
  DatabaseManager,
  RuntimeCredentialRecord,
  RuntimeSourceConfigRecord,
} from '../db/index.js';
import {
  sourceNames,
  SourceName,
  SourcesRuntimeConfig,
  UserRuntimeConfig,
} from '../types/runtime-config.js';
import {
  createCredentialCodec,
  type CredentialCodec,
} from './credential-codec.js';

type SourceConfigJson = Record<string, unknown>;

export class RuntimeConfigRepository {
  constructor(
    private db: DatabaseManager,
    private credentialCodec: CredentialCodec = createCredentialCodec()
  ) {}

  save(config: UserRuntimeConfig): void {
    this.db.upsertRuntimeUser({
      user_id: config.userId,
      account_handle: config.accountHandle,
      profile_path: config.profilePath,
      cron_schedule: config.schedule.cronSchedule,
      timezone: config.schedule.timezone,
      rate_limit_max_concurrent: config.rateLimit.maxConcurrent,
      rate_limit_request_delay_ms: config.rateLimit.requestDelayMs,
    });

    this.db.upsertRuntimeLarkConfig({
      user_id: config.userId,
      app_id: config.lark.appId,
      app_secret_encrypted: this.encryptOptional(config.lark.appSecret),
      base_id: config.lark.baseId,
      default_receiver_id: config.lark.defaultReceiverId,
    });

    for (const source of sourceNames) {
      this.db.upsertRuntimeSourceConfig({
        user_id: config.userId,
        source,
        enabled: config.sources[source].enabled ? 1 : 0,
        config_json: JSON.stringify(this.toSourceConfigJson(config, source)),
      });
    }

    this.saveCredential(config.userId, 'douyin_cookie', config.sources.douyin.cookie);
    this.saveCredential(config.userId, 'zhihu_cookie', config.sources.zhihu.cookie);
    this.saveCredential(
      config.userId,
      'douyin_tiktokdownloader_token',
      config.sources.douyin.tiktokDownloaderToken
    );
    this.saveCredential(config.userId, 'xiaohongshu_cookie', config.sources.xiaohongshu.cookie);
    this.saveCredential(config.userId, 'weibo_cookie', config.sources.weibo.cookie);
    this.saveCredential(config.userId, 'embedding_api_key', config.ai.embedding.apiKey);
    this.saveCredential(config.userId, 'embedding_base_url', config.ai.embedding.baseURL);
    this.saveCredential(config.userId, 'embedding_model', config.ai.embedding.model);
    this.saveCredential(config.userId, 'deepseek_api_key', config.ai.deepseek.apiKey);
    this.saveCredential(config.userId, 'deepseek_base_url', config.ai.deepseek.baseURL);
    this.saveCredential(config.userId, 'ai_mode', config.ai.mode);
    this.saveCredential(config.userId, 'cloud_base_url', config.ai.cloud.baseURL);
    this.saveCredential(config.userId, 'cloud_token', config.ai.cloud.token);
    this.saveCredential(config.userId, 'cloud_email', config.ai.cloud.email);
    this.saveCredential(config.userId, 'cloud_expires_at', config.ai.cloud.expiresAt);
  }

  get(userId: string): UserRuntimeConfig | undefined {
    const user = this.db.getRuntimeUser(userId);
    if (!user) {
      return undefined;
    }

    const lark = this.db.getRuntimeLarkConfig(userId);
    const sourceRecords = new Map(
      this.db.getRuntimeSourceConfigs(userId).map((record) => [record.source as SourceName, record])
    );
    const credentials = new Map(
      this.db.getRuntimeCredentials(userId).map((record) => [record.credential_key, record])
    );

    return {
      userId: user.user_id,
      accountHandle: user.account_handle,
      profilePath: user.profile_path || '',
      sources: this.toSourcesRuntimeConfig(sourceRecords, credentials),
      lark: {
        appId: lark?.app_id || '',
        appSecret: this.decryptOptional(lark?.app_secret_encrypted),
        baseId: lark?.base_id || '',
        defaultReceiverId: lark?.default_receiver_id || '',
      },
      ai: {
        mode: this.toAiMode(this.decryptCredential(credentials, 'ai_mode')),
        cloud: {
          baseURL: this.decryptCredential(credentials, 'cloud_base_url') || 'http://127.0.0.1:8787',
          token: this.decryptCredential(credentials, 'cloud_token'),
          email: this.decryptCredential(credentials, 'cloud_email'),
          expiresAt: this.decryptCredential(credentials, 'cloud_expires_at'),
        },
        embedding: {
          apiKey: this.decryptCredential(credentials, 'embedding_api_key'),
          baseURL: this.decryptCredential(credentials, 'embedding_base_url'),
          model: this.decryptCredential(credentials, 'embedding_model'),
        },
        deepseek: {
          apiKey: this.decryptCredential(credentials, 'deepseek_api_key'),
          baseURL: this.decryptCredential(credentials, 'deepseek_base_url'),
        },
      },
      schedule: {
        cronSchedule: user.cron_schedule,
        timezone: user.timezone,
      },
      rateLimit: {
        maxConcurrent: user.rate_limit_max_concurrent,
        requestDelayMs: user.rate_limit_request_delay_ms,
      },
    };
  }

  migrateCredentialsToActiveCodec(): number {
    let migrated = 0;
    for (const user of this.db.listRuntimeUsers()) {
      const config = this.get(user.user_id);
      if (!config) {
        continue;
      }

      this.save(config);
      migrated += 1;
    }

    return migrated;
  }

  private toSourceConfigJson(config: UserRuntimeConfig, source: SourceName): SourceConfigJson {
    switch (source) {
      case 'reddit':
        return {
          subreddits: config.sources.reddit.subreddits,
        };
      case 'zhihu':
        return {
          keywords: config.sources.zhihu.keywords,
        };
      case 'douyin':
        return {
          keywords: config.sources.douyin.keywords,
          tiktokDownloaderApiUrl: config.sources.douyin.tiktokDownloaderApiUrl,
        };
      case 'xiaohongshu':
        return {
          keywords: config.sources.xiaohongshu.keywords,
          adapter: config.sources.xiaohongshu.adapter,
          cookieSource: config.sources.xiaohongshu.cookieSource,
          chromeProfile: config.sources.xiaohongshu.chromeProfile,
        };
      case 'weibo':
        return {
          keywords: config.sources.weibo.keywords,
        };
      default:
        return {};
    }
  }

  private toSourcesRuntimeConfig(
    records: Map<SourceName, RuntimeSourceConfigRecord>,
    credentials: Map<string, RuntimeCredentialRecord>
  ): SourcesRuntimeConfig {
    const reddit = this.readSourceRecord(records, 'reddit');
    const zhihu = this.readSourceRecord(records, 'zhihu');
    const douyin = this.readSourceRecord(records, 'douyin');
    const xiaohongshu = this.readSourceRecord(records, 'xiaohongshu');
    const weibo = this.readSourceRecord(records, 'weibo');

    return {
      x: {
        enabled: this.isEnabled(records, 'x'),
      },
      hackernews: {
        enabled: this.isEnabled(records, 'hackernews'),
      },
      github: {
        enabled: this.isEnabled(records, 'github'),
      },
      zhihu: {
        enabled: this.isEnabled(records, 'zhihu'),
        keywords: this.stringArray(zhihu.keywords),
        cookie: this.decryptCredential(credentials, 'zhihu_cookie'),
      },
      producthunt: {
        enabled: this.isEnabled(records, 'producthunt'),
      },
      reddit: {
        enabled: this.isEnabled(records, 'reddit'),
        subreddits: this.stringArray(reddit.subreddits),
      },
      v2ex: {
        enabled: this.isEnabled(records, 'v2ex'),
      },
      douyin: {
        enabled: this.isEnabled(records, 'douyin'),
        keywords: this.stringArray(douyin.keywords),
        cookie: this.decryptCredential(credentials, 'douyin_cookie'),
        tiktokDownloaderApiUrl: this.stringValue(douyin.tiktokDownloaderApiUrl),
        tiktokDownloaderToken: this.decryptCredential(credentials, 'douyin_tiktokdownloader_token'),
      },
      xiaohongshu: {
        enabled: this.isEnabled(records, 'xiaohongshu'),
        keywords: this.stringArray(xiaohongshu.keywords),
        cookie: this.decryptCredential(credentials, 'xiaohongshu_cookie'),
        adapter: xiaohongshu.adapter === 'native' ? 'native' : 'redbook',
        cookieSource: this.toCookieSource(xiaohongshu.cookieSource),
        chromeProfile: this.stringValue(xiaohongshu.chromeProfile),
      },
      weibo: {
        enabled: this.isEnabled(records, 'weibo'),
        keywords: this.stringArray(weibo.keywords),
        cookie: this.decryptCredential(credentials, 'weibo_cookie'),
      },
    };
  }

  private readSourceRecord(
    records: Map<SourceName, RuntimeSourceConfigRecord>,
    source: SourceName
  ): SourceConfigJson {
    const value = records.get(source)?.config_json;
    if (!value) {
      return {};
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as SourceConfigJson : {};
    } catch {
      return {};
    }
  }

  private isEnabled(records: Map<SourceName, RuntimeSourceConfigRecord>, source: SourceName): boolean {
    return records.get(source)?.enabled === 1;
  }

  private saveCredential(userId: string, credentialKey: string, value: string): void {
    if (!value) {
      return;
    }

    this.db.upsertRuntimeCredential({
      user_id: userId,
      credential_key: credentialKey,
      encrypted_value: this.credentialCodec.encrypt(value),
    });
  }

  private decryptCredential(
    credentials: Map<string, RuntimeCredentialRecord>,
    credentialKey: string
  ): string {
    return this.decryptOptional(credentials.get(credentialKey)?.encrypted_value);
  }

  private encryptOptional(value: string | undefined): string {
    return value ? this.credentialCodec.encrypt(value) : '';
  }

  private decryptOptional(value: string | undefined): string {
    return value ? this.credentialCodec.decrypt(value) : '';
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  private stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private toCookieSource(value: unknown): 'chrome' | 'safari' | 'firefox' {
    if (value === 'safari' || value === 'firefox') {
      return value;
    }

    return 'chrome';
  }

  private toAiMode(value: string): 'local' | 'cloud' {
    return value === 'cloud' ? 'cloud' : 'local';
  }
}
