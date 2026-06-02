import { createServer, IncomingMessage, ServerResponse } from 'http';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { URL, fileURLToPath } from 'url';
import { config, ensureDirectories, localRuntimeConfig } from '../config.js';
import { DatabaseManager } from '../db/index.js';
import type { InitialProfileData, SampleTweet } from '../profile/types.js';
import { RuntimeConfigRepository } from '../runtime/config-repository.js';
import { RuntimeJobQueue } from '../runtime/job-queue.js';
import { MultiUserScheduler } from '../runtime/multi-user-scheduler.js';
import { RuntimeTaskRunner } from '../runtime/task-runner.js';
import { RuntimeWorker } from '../runtime/worker.js';
import { sourceNames, UserRuntimeConfig } from '../types/runtime-config.js';
import { findBrowserExecutable } from '../utils/browser-launcher.js';
import { logger } from '../utils/logger.js';
import { CookieHelper, isCookiePlatform } from './cookie-helper.js';
import { isAiCredential, validateAiCredential, validateCredential } from './credential-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type JsonBody = Record<string, unknown>;
type PublicCredentialCheck = {
  status: 'unknown' | 'valid' | 'invalid';
  message: string;
  checkedAt: string;
} | null;
type ProfileFormData = {
  bio?: unknown;
  topics?: unknown;
  interests?: unknown;
  style?: unknown;
  audience?: unknown;
  samplePosts?: unknown;
};

class AdminServer {
  private scheduler: MultiUserScheduler;
  private worker: RuntimeWorker;
  private cookieHelper: CookieHelper;
  private adminToken = process.env.ADMIN_TOKEN || '';

  constructor(
    private db: DatabaseManager,
    private repository: RuntimeConfigRepository,
    private queue: RuntimeJobQueue
  ) {
    const runner = new RuntimeTaskRunner(db);
    this.scheduler = new MultiUserScheduler(db, repository, queue);
    this.worker = new RuntimeWorker(queue, repository, runner);
    this.cookieHelper = new CookieHelper();
  }

  start(port: number, host: string): void {
    if (!this.isLoopbackHost(host) && !this.adminToken) {
      throw new Error('ADMIN_TOKEN is required when ADMIN_HOST is not a loopback address');
    }

    this.scheduler.reload();
    this.worker.start();

    const server = createServer((req, res) => {
      void this.handle(req, res);
    });

    server.listen(port, host, () => {
      logger.info(`Admin server listening on http://${host}:${port}`);
    });

    const shutdown = (): void => {
      this.scheduler.stop();
      this.worker.stop();
      this.db.close();
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const method = req.method || 'GET';

    try {
      if (method === 'GET' && (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.ico')) {
        this.asset(res, url.pathname);
        return;
      }

      if (!this.isAuthorized(req, url)) {
        this.unauthorized(res);
        return;
      }

      if (method === 'GET' && url.pathname === '/') {
        if (this.shouldShowOnboarding(url.searchParams.get('userId') || localRuntimeConfig.userId)) {
          this.redirect(res, this.onboardingLocation(url));
          return;
        }

        this.html(res, this.renderDashboard());
        return;
      }

      if (method === 'GET' && url.pathname === '/dashboard') {
        this.html(res, this.renderDashboard());
        return;
      }

      if (method === 'GET' && url.pathname === '/onboarding') {
        this.html(res, this.renderOnboarding());
        return;
      }

      if (method === 'GET' && url.pathname === '/api/users') {
        this.json(res, this.listUsers());
        return;
      }

      const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && method === 'GET') {
        this.json(res, this.getUser(userMatch[1]));
        return;
      }

      if (userMatch && method === 'POST') {
        const body = await this.readJson(req);
        const saved = body.mode === 'create'
          ? this.createUser(userMatch[1])
          : this.saveUser(userMatch[1], body);
        this.scheduler.reload();
        this.json(res, saved);
        return;
      }

      if (userMatch && method === 'PUT') {
        const body = await this.readJson(req);
        const saved = this.saveUser(userMatch[1], body);
        this.scheduler.reload();
        this.json(res, saved);
        return;
      }

      if (userMatch && method === 'DELETE') {
        this.deleteUser(userMatch[1]);
        this.scheduler.reload();
        this.json(res, { ok: true });
        return;
      }

      const userRecommendationsMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/recommendations$/);
      if (userRecommendationsMatch && method === 'GET') {
        this.json(res, this.listRecommendations(userRecommendationsMatch[1], Number(url.searchParams.get('limit') || 30)));
        return;
      }

      const userContentMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/content$/);
      if (userContentMatch && method === 'GET') {
        this.json(res, this.listRecentContent(
          userContentMatch[1],
          Number(url.searchParams.get('limit') || 50),
          url.searchParams.get('source') || ''
        ));
        return;
      }

      const recommendationStatusMatch = url.pathname.match(/^\/api\/recommendations\/(\d+)\/status$/);
      if (recommendationStatusMatch && method === 'POST') {
        const body = await this.readJson(req);
        const status = String(body.status || '');
        if (!['pending', 'approved', 'rejected', 'posted'].includes(status)) {
          this.json(res, { error: 'Invalid recommendation status' }, 400);
          return;
        }
        this.db.updateRecommendationStatus(Number(recommendationStatusMatch[1]), status, String(body.feedback || ''));
        this.json(res, { ok: true });
        return;
      }

      const credentialMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/credentials\/([^/]+)$/);
      if (credentialMatch && method === 'POST') {
        const body = await this.readJson(req);
        const saved = this.saveCredential(credentialMatch[1], credentialMatch[2], body);
        this.json(res, this.publicConfig(saved));
        return;
      }

      if (credentialMatch && method === 'DELETE') {
        this.deleteCredential(credentialMatch[1], credentialMatch[2]);
        this.json(res, { ok: true });
        return;
      }

      const validateCredentialMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/credentials\/([^/]+)\/validate$/);
      if (validateCredentialMatch && method === 'POST') {
        const userId = validateCredentialMatch[1];
        const platform = validateCredentialMatch[2];

        const validation = isCookiePlatform(platform)
          ? await validateCredential(platform, this.getRuntimeConfig(userId))
          : isAiCredential(platform)
            ? await validateAiCredential(platform, this.getRuntimeConfig(userId))
            : null;
        if (!validation) {
          this.json(res, { error: `Unsupported credential: ${platform}` }, 400);
          return;
        }
        this.db.upsertRuntimeCredentialCheck({
          user_id: userId,
          platform,
          status: validation.status,
          message: validation.message,
        });
        this.json(res, {
          validation,
          config: this.publicConfig(this.getRuntimeConfig(userId)),
        });
        return;
      }

      const loginMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/login\/([^/]+)$/);
      if (loginMatch && method === 'POST') {
        const userId = loginMatch[1];
        const platform = loginMatch[2];

        if (!isCookiePlatform(platform)) {
          this.json(res, { error: `Unsupported local login platform: ${platform}` }, 400);
          return;
        }

        try {
          const body = await this.readJson(req);
          const mode = body.mode === 'reauth' || body.mode === 'captcha' ? body.mode : 'normal';
          const cookies = await this.cookieHelper.launchLoginWindow(platform, { userId, mode });
          const saved = this.saveCredential(userId, platform, { value: cookies });
          this.json(res, this.publicConfig(saved));
        } catch (error) {
          this.json(res, { error: (error as Error).message }, 500);
        }
        return;
      }

      const sourceRecoveryMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/run\/sources$/);
      if (sourceRecoveryMatch && method === 'POST') {
        const body = await this.readJson(req);
        const sources = this.stringArray(body.sources)
          .filter((source) => sourceNames.includes(source as never));
        if (sources.length === 0) {
          this.json(res, { error: 'At least one source is required' }, 400);
          return;
        }
        const jobId = this.queue.enqueue(sourceRecoveryMatch[1], 'source_recovery', { sources });
        this.json(res, { ok: true, jobId, sources });
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/run$/);
      if (runMatch && method === 'POST') {
        const jobId = this.queue.enqueue(runMatch[1], 'daily_run');
        this.json(res, { ok: true, jobId });
        return;
      }

      const testPushMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/test-push$/);
      if (testPushMatch && method === 'POST') {
        const jobId = this.queue.enqueue(testPushMatch[1], 'test_push');
        this.json(res, { ok: true, jobId });
        return;
      }

      const profileMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/profile$/);
      if (profileMatch && method === 'PUT') {
        const body = await this.readJson(req);
        this.json(res, this.saveProfile(profileMatch[1], body));
        return;
      }

      if (profileMatch && method === 'GET') {
        this.json(res, this.getProfile(profileMatch[1]));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/jobs') {
        this.json(res, this.queue.list(Number(url.searchParams.get('limit') || 50)));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/runs') {
        this.json(res, this.db.listRuntimeRunLogs(
          url.searchParams.get('userId') || undefined,
          Number(url.searchParams.get('limit') || 50)
        ));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/status') {
        this.json(res, {
          scheduledUserIds: this.scheduler.getScheduledUserIds(),
          jobs: this.queue.list(10),
          runs: this.db.listRuntimeRunLogs(undefined, 10),
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/diagnostics/environment') {
        this.json(res, this.environmentDiagnostics());
        return;
      }

      this.json(res, { error: 'Not found' }, 404);
    } catch (error) {
      logger.error('Admin request failed', error as Error);
      this.json(res, { error: (error as Error).message }, 500);
    }
  }

  private listUsers(): unknown[] {
    return this.db.listRuntimeUsers().map((user) => {
      const runtimeConfig = this.repository.get(user.user_id);
      return {
        userId: user.user_id,
        accountHandle: user.account_handle,
        schedule: runtimeConfig?.schedule,
        enabledSources: runtimeConfig
          ? this.dashboardSources().filter((source) => runtimeConfig.sources[source].enabled)
          : [],
        connections: this.connectionStatus(user.user_id),
      };
    });
  }

  private getRuntimeConfig(userId: string): UserRuntimeConfig {
    const runtimeConfig = this.repository.get(userId);
    if (runtimeConfig) {
      return runtimeConfig;
    }

    return this.defaultConfig(userId);
  }

  private getUser(userId: string): unknown {
    return this.publicConfig(this.getRuntimeConfig(userId));
  }

  private saveUser(userId: string, body: JsonBody): unknown {
    const runtimeConfig = this.normalizeConfig(userId, body);
    this.repository.save(runtimeConfig);
    this.resetCredentialChecksForIncomingConfig(userId, body);
    return this.publicConfig(runtimeConfig);
  }

  private createUser(userId: string): unknown {
    const runtimeConfig = this.blankConfig(userId);
    this.repository.save(runtimeConfig);
    return this.publicConfig(runtimeConfig);
  }

  private deleteUser(userId: string): void {
    this.db.deleteRuntimeUser(userId);
    const profilePath = resolve('./data/profiles', `${this.safeFileName(userId)}.json`);
    if (existsSync(profilePath)) {
      unlinkSync(profilePath);
    }
  }

  private listRecommendations(userId: string, limit: number): unknown[] {
    return this.db.listRecommendationsWithContent(userId, Math.max(1, Math.min(limit || 30, 100))).map((item) => ({
      id: item.id,
      userId: item.user_id,
      contentId: item.content_id,
      score: item.match_score,
      reason: item.match_reason,
      drafts: this.safeJson(item.drafts, []),
      status: item.status || 'pending',
      recommendedAt: item.recommended_at,
      feedback: item.user_feedback,
      source: item.source,
      title: item.title,
      content: item.content,
      url: item.url,
      author: item.author,
      publishedAt: item.published_at,
      collectedAt: item.collected_at,
    }));
  }

  private listRecentContent(userId: string, limit: number, source: string): unknown[] {
    const runtimeConfig = this.repository.get(userId);
    const enabledSources = new Set(
      sourceNames.filter((sourceName) => runtimeConfig?.sources[sourceName]?.enabled)
    );
    const selectedSource = sourceNames.includes(source as never) ? source : '';
    return this.db.getRecentContent(Math.max(1, Math.min((limit || 50) * 3, 300)))
      .filter((item) => !selectedSource || item.source === selectedSource)
      .filter((item) => enabledSources.size === 0 || enabledSources.has(item.source as never))
      .slice(0, Math.max(1, Math.min(limit || 50, 100)))
      .map((item) => ({
        id: item.id,
        source: item.source,
        title: item.title,
        content: item.content,
        url: item.url,
        author: item.author,
        publishedAt: item.published_at,
        collectedAt: item.collected_at,
        metrics: this.safeJson(item.metrics, {}),
      }));
  }

  private safeJson(value: string | undefined, fallback: unknown): unknown {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return fallback;
    }
  }

  private saveCredential(userId: string, platform: string, body: JsonBody): UserRuntimeConfig {
    const value = typeof body.value === 'string' ? body.value : '';
    if (!value) {
      throw new Error('Credential value is required');
    }

    const runtimeConfig = this.getRuntimeConfig(userId);
    if (platform === 'zhihu') {
      runtimeConfig.sources.zhihu.cookie = value;
      runtimeConfig.sources.zhihu.enabled = true;
    } else if (platform === 'douyin') {
      runtimeConfig.sources.douyin.cookie = value;
      runtimeConfig.sources.douyin.enabled = true;
    } else if (platform === 'xiaohongshu') {
      runtimeConfig.sources.xiaohongshu.cookie = value;
      runtimeConfig.sources.xiaohongshu.enabled = true;
    } else if (platform === 'weibo') {
      runtimeConfig.sources.weibo.cookie = value;
      runtimeConfig.sources.weibo.enabled = true;
    } else if (platform === 'embedding') {
      runtimeConfig.ai.embedding.apiKey = value;
    } else if (platform === 'deepseek') {
      runtimeConfig.ai.deepseek.apiKey = value;
    } else {
      throw new Error(`Unsupported platform credential: ${platform}`);
    }

    this.repository.save(runtimeConfig);
    if (isCookiePlatform(platform) || isAiCredential(platform)) {
      this.db.upsertRuntimeCredentialCheck({
        user_id: userId,
        platform,
        status: 'unknown',
        message: isCookiePlatform(platform) ? '已保存登录状态，等待检查' : '已保存密钥，等待验证',
      });
    }
    return runtimeConfig;
  }

  private deleteCredential(userId: string, credential: string): void {
    const credentialKey = this.runtimeCredentialKey(credential);
    if (!credentialKey) {
      throw new Error(`Unsupported credential: ${credential}`);
    }

    this.db.deleteRuntimeCredential(userId, credentialKey);
    this.db.deleteRuntimeCredentialCheck(userId, credential);
  }

  private runtimeCredentialKey(credential: string): string {
    if (isCookiePlatform(credential)) {
      return `${credential}_cookie`;
    }
    if (credential === 'embedding') {
      return 'embedding_api_key';
    }
    if (credential === 'deepseek') {
      return 'deepseek_api_key';
    }
    return '';
  }

  private resetCredentialChecksForIncomingConfig(userId: string, body: JsonBody): void {
    const incoming = body as Partial<UserRuntimeConfig>;
    if (Object.prototype.hasOwnProperty.call(incoming.ai?.embedding || {}, 'apiKey')) {
      this.db.upsertRuntimeCredentialCheck({
        user_id: userId,
        platform: 'embedding',
        status: 'unknown',
        message: '已更新内容智能筛选密钥，等待验证',
      });
    }
    if (Object.prototype.hasOwnProperty.call(incoming.ai?.deepseek || {}, 'apiKey')) {
      this.db.upsertRuntimeCredentialCheck({
        user_id: userId,
        platform: 'deepseek',
        status: 'unknown',
        message: '已更新 AI 自动写草稿密钥，等待验证',
      });
    }
  }

  private getProfile(userId: string): unknown {
    const runtimeConfig = this.getRuntimeConfig(userId);
    const profilePath = this.resolveProfilePath(runtimeConfig);
    if (!existsSync(profilePath)) {
      return {
        profilePath,
        bio: '',
        topics: [],
        interests: [],
        style: '',
        audience: '',
        samplePosts: []
      };
    }

    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as InitialProfileData;
    return {
      profilePath,
      bio: profile.bio || '',
      topics: profile.topics || [],
      interests: profile.interests || [],
      style: profile.writingStyle?.tone || '',
      audience: profile.audience || '',
      samplePosts: (profile.sampleTweets || []).map((tweet) => tweet.text)
    };
  }

  private saveProfile(userId: string, body: JsonBody): unknown {
    const runtimeConfig = this.getRuntimeConfig(userId);
    const profilePath = this.resolveProfilePath(runtimeConfig);
    const existing = existsSync(profilePath)
      ? JSON.parse(readFileSync(profilePath, 'utf8')) as Partial<InitialProfileData>
      : {};
    const form = body as ProfileFormData;
    const interests = this.stringArray(form.interests);
    const topics = this.stringArray(form.topics);
    const sampleTexts = this.stringArray(form.samplePosts);
    const sampleTweets: SampleTweet[] = sampleTexts.map((text) => ({ text, likes: 0 }));

    const profile: InitialProfileData = {
      accountHandle: runtimeConfig.accountHandle || existing.accountHandle || userId,
      bio: this.stringValue(form.bio) || existing.bio || '',
      topics: topics.length > 0 ? topics : existing.topics || interests,
      writingStyle: {
        tone: this.stringValue(form.style) || existing.writingStyle?.tone || '',
        avgLength: existing.writingStyle?.avgLength || 280,
        emojiUsage: existing.writingStyle?.emojiUsage || '适中',
        commonEmojis: existing.writingStyle?.commonEmojis || [],
        structure: existing.writingStyle?.structure,
      },
      interests: interests.length > 0 ? interests : existing.interests || [],
      audience: this.stringValue(form.audience) || existing.audience || '',
      tweetCount: existing.tweetCount || sampleTweets.length,
      sampleTweets: sampleTweets.length > 0 ? sampleTweets : existing.sampleTweets || [],
    };

    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');

    if (!runtimeConfig.profilePath) {
      this.repository.save({ ...runtimeConfig, profilePath });
    }

    logger.info(`Profile saved for user ${userId}: ${profilePath}`);
    return this.getProfile(userId);
  }

  private normalizeConfig(userId: string, body: JsonBody): UserRuntimeConfig {
    const base = this.repository.get(userId) || this.defaultConfig(userId);
    const incoming = body as Partial<UserRuntimeConfig>;
    const sources = {
      ...base.sources,
      ...incoming.sources,
      zhihu: {
        ...base.sources.zhihu,
        ...incoming.sources?.zhihu,
      },
      douyin: {
        ...base.sources.douyin,
        ...incoming.sources?.douyin,
      },
      xiaohongshu: {
        ...base.sources.xiaohongshu,
        ...incoming.sources?.xiaohongshu,
      },
      reddit: {
        ...base.sources.reddit,
        ...incoming.sources?.reddit,
      },
      weibo: {
        ...base.sources.weibo,
        ...incoming.sources?.weibo,
      },
    };
    const lark = {
      ...base.lark,
      ...incoming.lark,
    };
    if (!incoming.lark?.appSecret) {
      lark.appSecret = base.lark.appSecret;
    }
    const ai = {
      embedding: {
        ...base.ai.embedding,
        ...incoming.ai?.embedding,
      },
      deepseek: {
        ...base.ai.deepseek,
        ...incoming.ai?.deepseek,
      },
    };
    if (!incoming.ai?.embedding?.apiKey) {
      ai.embedding.apiKey = base.ai.embedding.apiKey;
    }
    if (!incoming.ai?.deepseek?.apiKey) {
      ai.deepseek.apiKey = base.ai.deepseek.apiKey;
    }
    if (!incoming.sources?.zhihu?.cookie) {
      sources.zhihu.cookie = base.sources.zhihu.cookie;
    }
    if (!incoming.sources?.douyin?.cookie) {
      sources.douyin.cookie = base.sources.douyin.cookie;
    }
    if (!incoming.sources?.douyin?.tiktokDownloaderToken) {
      sources.douyin.tiktokDownloaderToken = base.sources.douyin.tiktokDownloaderToken;
    }
    if (!incoming.sources?.xiaohongshu?.cookie) {
      sources.xiaohongshu.cookie = base.sources.xiaohongshu.cookie;
    }
    if (!incoming.sources?.weibo?.cookie) {
      sources.weibo.cookie = base.sources.weibo.cookie;
    }

    return {
      ...base,
      ...incoming,
      userId,
      sources,
      lark,
      ai,
      schedule: {
        ...base.schedule,
        ...incoming.schedule,
      },
      rateLimit: {
        ...base.rateLimit,
        ...incoming.rateLimit,
      },
    };
  }

  private defaultConfig(userId: string): UserRuntimeConfig {
    const base = JSON.parse(JSON.stringify(localRuntimeConfig)) as UserRuntimeConfig;
    const runtimeConfig = userId === localRuntimeConfig.userId
      ? { ...base, userId }
      : this.blankConfigFromBase(userId, base);
    return {
      ...runtimeConfig,
      ai: {
        embedding: {
          ...runtimeConfig.ai.embedding,
          apiKey: '',
        },
        deepseek: {
          ...runtimeConfig.ai.deepseek,
          apiKey: '',
        },
      },
    };
  }

  private blankConfig(userId: string): UserRuntimeConfig {
    const base = JSON.parse(JSON.stringify(localRuntimeConfig)) as UserRuntimeConfig;
    return this.blankConfigFromBase(userId, base);
  }

  private blankConfigFromBase(userId: string, base: UserRuntimeConfig): UserRuntimeConfig {
    return {
      userId,
      accountHandle: userId,
      profilePath: '',
      sources: {
        x: { enabled: false },
        hackernews: { enabled: false },
        github: { enabled: false },
        zhihu: { enabled: false, keywords: [], cookie: '' },
        producthunt: { enabled: false },
        reddit: { enabled: false, subreddits: [] },
        v2ex: { enabled: false },
        douyin: {
          enabled: false,
          keywords: [],
          cookie: '',
          tiktokDownloaderApiUrl: '',
          tiktokDownloaderToken: '',
        },
        xiaohongshu: {
          enabled: false,
          keywords: [],
          cookie: '',
          adapter: 'redbook',
          cookieSource: 'chrome',
          chromeProfile: '',
        },
        weibo: { enabled: false, keywords: [], cookie: '' },
      },
      lark: {
        appId: '',
        appSecret: '',
        baseId: '',
        defaultReceiverId: '',
      },
      ai: {
        embedding: {
          apiKey: '',
          baseURL: base.ai.embedding.baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: base.ai.embedding.model || 'text-embedding-v4',
        },
        deepseek: {
          apiKey: '',
          baseURL: base.ai.deepseek.baseURL || 'https://api.deepseek.com',
        },
      },
      schedule: base.schedule,
      rateLimit: base.rateLimit,
    };
  }

  private publicConfig(configForUser: UserRuntimeConfig): unknown {
    const clone = JSON.parse(JSON.stringify(configForUser)) as UserRuntimeConfig;
    const credentialChecks = this.credentialChecks(configForUser.userId);
    const status = {
      larkAppSecret: Boolean(configForUser.lark.appSecret),
      zhihuCookie: Boolean(configForUser.sources.zhihu.cookie),
      douyinCookie: Boolean(configForUser.sources.douyin.cookie),
      douyinTikTokDownloaderToken: Boolean(configForUser.sources.douyin.tiktokDownloaderToken),
      xiaohongshuCookie: Boolean(configForUser.sources.xiaohongshu.cookie),
      weiboCookie: Boolean(configForUser.sources.weibo.cookie),
      embeddingApiKey: this.credentialUsable(Boolean(configForUser.ai.embedding.apiKey), credentialChecks.embedding),
      deepseekApiKey: this.credentialUsable(Boolean(configForUser.ai.deepseek.apiKey), credentialChecks.deepseek),
    };

    clone.lark.appSecret = '';
    clone.ai.embedding.apiKey = '';
    clone.ai.deepseek.apiKey = '';
    clone.sources.zhihu.cookie = '';
    clone.sources.douyin.cookie = '';
    clone.sources.douyin.tiktokDownloaderToken = '';
    clone.sources.xiaohongshu.cookie = '';
    clone.sources.weibo.cookie = '';

    return {
      ...clone,
      credentialStatus: status,
      credentialChecks,
    };
  }

  private credentialChecks(userId: string): Record<string, PublicCredentialCheck> {
    const checks = Object.fromEntries(
      this.db.getRuntimeCredentialChecks(userId).map((check) => [
        check.platform,
        {
          status: check.status,
          message: check.message || '',
          checkedAt: check.checked_at || '',
        },
      ])
    ) as Record<string, PublicCredentialCheck>;

    return {
      douyin: checks.douyin || null,
      xiaohongshu: checks.xiaohongshu || null,
      zhihu: checks.zhihu || null,
      weibo: checks.weibo || null,
      embedding: checks.embedding || null,
      deepseek: checks.deepseek || null,
    };
  }

  private credentialUsable(hasCredential: boolean, check: PublicCredentialCheck): boolean {
    return hasCredential && check?.status !== 'invalid';
  }

  private shouldShowOnboarding(userId: string): boolean {
    const runtimeConfig = this.repository.get(userId);
    if (runtimeConfig) {
      return !runtimeConfig.profilePath;
    }

    return userId === localRuntimeConfig.userId
      ? !localRuntimeConfig.profilePath
      : true;
  }

  private onboardingLocation(url: URL): string {
    const params = new URLSearchParams();
    const userId = url.searchParams.get('userId');
    const token = url.searchParams.get('token');
    if (userId) {
      params.set('userId', userId);
    }
    if (token) {
      params.set('token', token);
    }

    const query = params.toString();
    return query ? `/onboarding?${query}` : '/onboarding';
  }

  private resolveProfilePath(runtimeConfig: UserRuntimeConfig): string {
    if (runtimeConfig.profilePath) {
      return resolve(runtimeConfig.profilePath);
    }

    return resolve('./data/profiles', `${this.safeFileName(runtimeConfig.userId)}.json`);
  }

  private safeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'local';
  }

  private stringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }

    if (typeof value === 'string') {
      return value
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  private stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    if (!this.adminToken) {
      return true;
    }

    const rawAuthorization = req.headers.authorization;
    const authorization = typeof rawAuthorization === 'string' ? rawAuthorization : '';
    const headerToken = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const adminHeader = req.headers['x-admin-token'];
    const xAdminToken = typeof adminHeader === 'string'
      ? adminHeader
      : Array.isArray(adminHeader) && typeof adminHeader[0] === 'string'
      ? adminHeader[0]
      : '';
    const queryToken = url.searchParams.get('token') || '';

    return [headerToken, xAdminToken, queryToken].includes(this.adminToken);
  }

  private unauthorized(res: ServerResponse): void {
    this.json(res, { error: 'Unauthorized' }, 401);
  }

  private notFound(res: ServerResponse): void {
    this.json(res, { error: 'Not found' }, 404);
  }

  private isLoopbackHost(host: string): boolean {
    return ['127.0.0.1', 'localhost', '::1'].includes(host);
  }

  private connectionStatus(userId: string): Record<string, boolean> {
    const keys = new Set(this.db.getRuntimeCredentials(userId).map((row) => row.credential_key));
    return {
      zhihu: keys.has('zhihu_cookie'),
      douyin: keys.has('douyin_cookie'),
      xiaohongshu: keys.has('xiaohongshu_cookie'),
      weibo: keys.has('weibo_cookie'),
    };
  }

  private dashboardSources(): typeof sourceNames {
    return sourceNames.filter((source) => source !== 'x' && source !== 'producthunt') as typeof sourceNames;
  }

  private environmentDiagnostics(): Record<string, unknown> {
    const browserPath = findBrowserExecutable();
    return {
      browser: {
        ok: Boolean(browserPath),
        message: browserPath ? '浏览器已就绪' : '未找到 Chrome、Edge 或 Brave，登录平台无法使用',
      },
      credentialStorage: {
        ok: Boolean(process.env.CREDENTIAL_ENCRYPTION_KEY),
        message: process.env.CREDENTIAL_ENCRYPTION_KEY ? '本机凭证已加密存储' : '当前凭证未启用加密存储',
      },
      backgroundScraping: {
        ok: process.env.LOCAL_SCRAPER_HEADLESS !== 'false',
        message: process.env.LOCAL_SCRAPER_HEADLESS === 'false' ? '抓取浏览器处于可见调试模式' : '正常抓取将在后台运行',
      },
    };
  }

  private async readJson(req: IncomingMessage): Promise<JsonBody> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) as JsonBody : {};
  }

  private json(res: ServerResponse, payload: unknown, status: number = 200): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload, null, 2));
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { location });
    res.end();
  }

  private html(res: ServerResponse, payload: string): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(payload);
  }

  private asset(res: ServerResponse, pathname: string): void {
    const fileName = pathname === '/favicon.ico' ? 'spark-icon-32.png' : pathname.replace('/assets/', '');
    if (!/^[a-z0-9_.-]+$/i.test(fileName)) {
      this.notFound(res);
      return;
    }

    const filePath = [
      resolve(process.cwd(), 'assets', fileName),
      resolve(__dirname, '..', '..', 'assets', fileName),
    ].find((candidate) => existsSync(candidate));
    if (!filePath) {
      this.notFound(res);
      return;
    }

    const ext = fileName.split('.').pop() || '';
    const contentTypes: Record<string, string> = {
      png: 'image/png',
      svg: 'image/svg+xml; charset=utf-8',
      icns: 'image/icns',
      css: 'text/css; charset=utf-8',
    };
    res.writeHead(200, {
      'content-type': contentTypes[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    });
    res.end(readFileSync(filePath));
  }

  private renderOnboarding(): string {
    const path = resolve(__dirname, 'onboarding.html');
    return readFileSync(path, 'utf8');
  }

  private renderDashboard(): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Spark - 管理后台</title>
  <link rel="icon" type="image/png" href="/assets/spark-icon-32.png">
  <link rel="apple-touch-icon" href="/assets/spark-icon.png">
  <link rel="stylesheet" href="/assets/tailwind.css">
  <style>
    [x-cloak] { display: none !important; }
    :root {
      color-scheme: light;
      --surface: #ffffff;
      --surface-soft: #f8fafc;
      --line: #dbe3ee;
      --text: #111827;
      --muted: #64748b;
      --accent: #2563eb;
    }
    body {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: #f4f7fb;
    }
    input, textarea, select {
      background-color: #fff;
      transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--accent) !important;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, .12) !important;
    }
    .admin-shell {
      background: linear-gradient(180deg, #f8fafc 0%, #eef3f9 100%);
    }
    .admin-card {
      background: var(--surface);
      border: 1px solid var(--line);
      box-shadow: 0 10px 30px rgba(15, 23, 42, .06);
      border-radius: 8px;
    }
    .metric-card {
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, .18);
    }
    .btn-primary {
      background: #1d4ed8;
      color: white;
      border-radius: 8px;
      transition: background-color .16s ease, transform .16s ease;
    }
    .btn-primary:hover { background: #1e40af; }
    .btn-primary:active { transform: translateY(1px); }
    .config-nav-button {
      border-radius: 6px;
      border: 1px solid #dbe3ee;
      background: #fff;
      padding: 6px 10px;
      color: #475569;
      font-size: 12px;
      font-weight: 600;
    }
    .config-nav-button:hover { border-color: #93c5fd; color: #1d4ed8; }
    .config-section { scroll-margin-top: 132px; }
    details > summary { cursor: pointer; list-style: none; }
    details > summary::-webkit-details-marker { display: none; }
  </style>
</head>
<body class="admin-shell">
  <!-- Header -->
  <header class="bg-white border-b border-gray-200 sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex min-h-16 justify-between gap-3 py-2">
        <div class="flex items-center gap-3">
          <img src="/assets/spark-logo.svg" alt="" class="h-9 w-9">
          <h1 class="text-xl font-bold text-gray-900">Spark</h1>
          <span class="ml-3 hidden whitespace-nowrap rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800 sm:inline-flex">管理后台</span>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button data-action="run" onclick="runUser()" class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-wait disabled:bg-blue-300">
            立即运行
          </button>
          <button data-action="diagnose" onclick="diagnoseSystem()" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:text-gray-400">
            一键诊断
          </button>
          <button data-action="test-push" onclick="testPush()" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:text-gray-400">
            测试推送
          </button>
          <select id="headerUserSelect" onchange="selectUser(encodeURIComponent(this.value))" class="max-w-40 rounded-md border border-gray-300 bg-white px-2 py-2 text-sm text-gray-700">
            <option value="local">local</option>
          </select>
          <button onclick="toggleUserManager()" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            管理用户
          </button>
          <div id="statusIndicator" class="flex items-center">
            <div id="statusDot" class="w-2 h-2 bg-gray-400 rounded-full"></div>
            <span id="statusText" class="ml-2 text-sm text-gray-600">空闲</span>
          </div>
        </div>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="grid grid-cols-1 gap-6">

      <!-- Sidebar - User List -->
      <div id="userManager" class="hidden">
        <div class="admin-card">
          <div class="p-4 border-b border-gray-200">
            <h2 class="text-lg font-semibold text-gray-900">用户</h2>
          </div>
          <div class="p-4">
            <div class="mb-4">
              <input
                id="userId"
                type="text"
                placeholder="新用户 ID（可选）"
                value="local"
                onkeydown="if(event.key === 'Enter') createUser()"
                class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
              <button
                id="createUserButton"
                onclick="createUser()"
                class="mt-2 w-full bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 disabled:bg-blue-300 transition"
              >
                新建用户
              </button>
              <div id="userActionMessage" class="mt-2 text-xs text-gray-500">点击列表切换用户；新建可留空自动生成 ID。</div>
            </div>
            <div id="users" class="space-y-2"></div>
          </div>
        </div>
      </div>

      <!-- Main Panel -->
      <div>
        <!-- Tabs -->
        <div class="admin-card">
          <div class="border-b border-gray-200">
            <nav class="flex -mb-px overflow-x-auto whitespace-nowrap">
              <button onclick="switchTab('overview')" id="tab-overview" class="tab-button active px-6 py-3 text-sm font-medium border-b-2 border-blue-600 text-blue-600">
                概览
              </button>
              <button onclick="switchTab('recommendations')" id="tab-recommendations" class="tab-button px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300">
                推荐内容
              </button>
              <button onclick="switchTab('data')" id="tab-data" class="tab-button px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300">
                数据浏览
              </button>
              <button onclick="switchTab('config')" id="tab-config" class="tab-button px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300">
                配置
              </button>
              <button onclick="switchTab('platforms')" id="tab-platforms" class="tab-button px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300">
                平台连接
              </button>
              <button onclick="switchTab('logs')" id="tab-logs" class="tab-button px-6 py-3 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300">
                运行日志
              </button>
            </nav>
          </div>

          <!-- Tab Content -->
          <div class="p-6">

            <!-- Overview Tab -->
            <div id="content-overview" class="tab-content">
              <div id="activationChecklist" class="mb-6"></div>

              <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div class="metric-card bg-blue-50 p-4">
                  <div class="text-sm text-blue-600 font-medium">已启用平台</div>
                  <div id="enabledSourcesCount" class="text-2xl font-bold text-blue-900 mt-1">0</div>
                </div>
                <div class="metric-card bg-green-50 p-4">
                  <div class="text-sm text-green-600 font-medium">定时任务</div>
                  <div id="scheduleStatus" class="text-2xl font-bold text-green-900 mt-1">未设置</div>
                </div>
                <div class="metric-card bg-purple-50 p-4">
                  <div class="text-sm text-purple-600 font-medium">平台连接</div>
                  <div id="connectionCount" class="text-2xl font-bold text-purple-900 mt-1">0/2</div>
                </div>
                <div class="metric-card bg-amber-50 p-4">
                  <div class="text-sm text-amber-700 font-medium">需要处理</div>
                  <div id="attentionCount" class="text-2xl font-bold text-amber-900 mt-1">0</div>
                </div>
              </div>

              <div class="mb-6">
                <div class="flex items-center justify-between mb-3">
                  <h3 class="text-sm font-semibold text-gray-900">平台健康状态</h3>
                  <span id="lastRunSummary" class="text-xs text-gray-500">等待运行</span>
                </div>
                <div id="platformHealthGrid" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3"></div>
              </div>

              <details class="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
                <summary class="flex items-center justify-between gap-3 text-sm font-semibold text-gray-900">
                  <span>诊断详情</span>
                  <button data-action="diagnose" onclick="event.preventDefault(); diagnoseSystem()" class="text-xs font-medium text-blue-700 hover:text-blue-900 disabled:text-gray-400">一键诊断</button>
                </summary>
                <div class="mt-4">
                  <h3 class="mb-3 text-sm font-semibold text-gray-900">AI 健康状态</h3>
                  <div id="aiHealthGrid" class="grid grid-cols-1 md:grid-cols-2 gap-3"></div>
                </div>
                <div class="mt-4">
                  <h3 class="mb-3 text-sm font-semibold text-gray-900">本机环境</h3>
                  <div id="environmentHealthGrid" class="grid grid-cols-1 md:grid-cols-3 gap-3"></div>
                </div>
              </details>

              <div id="runOutcomeCard" class="mb-6 rounded-lg border border-gray-200 bg-white p-4"></div>

              <details id="statusBox" class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <summary class="text-sm font-medium text-gray-700">状态信息</summary>
                <pre id="status" class="mt-3 text-xs text-gray-600 whitespace-pre-wrap font-mono"></pre>
              </details>
            </div>

            <!-- Recommendations Tab -->
            <div id="content-recommendations" class="tab-content hidden">
              <div class="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 class="text-xl font-semibold text-gray-900">推荐内容</h2>
                  <p class="mt-1 text-sm text-gray-500">这里是每天跑完后真正要看的结果；日志只用于排查问题。</p>
                </div>
                <div class="flex gap-2">
                  <button onclick="loadRecommendations()" class="bg-gray-600 text-white px-4 py-2 rounded-md hover:bg-gray-700 transition">
                    刷新
                  </button>
                  <button onclick="switchTab('logs')" class="bg-white text-gray-700 px-4 py-2 rounded-md border border-gray-300 hover:bg-gray-50 transition">
                    查看日志
                  </button>
                </div>
              </div>

              <div id="runProgressPanel" class="mb-5"></div>
              <div id="recommendationsList" class="space-y-4">
                <div class="text-gray-500">加载中...</div>
              </div>

            </div>

            <!-- Data Tab -->
            <div id="content-data" class="tab-content hidden">
              <div class="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 class="text-xl font-semibold text-gray-900">数据浏览</h2>
                  <p class="mt-1 text-sm text-gray-500">查看已经入库的原始内容，用于排查抓取结果和来源质量。</p>
                </div>
                <div class="flex gap-2">
                  <select id="contentSourceFilter" onchange="loadRawContent()" class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm md:w-48">
                    <option value="">全部平台</option>
                  </select>
                  <button onclick="loadRawContent()" class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                    刷新
                  </button>
                </div>
              </div>
              <div id="rawContentList" class="space-y-3">
                <div class="text-gray-500">加载中...</div>
              </div>
            </div>

            <!-- Config Tab -->
            <div id="content-config" class="tab-content hidden">
              <div class="sticky top-16 z-20 -mx-2 mb-5 flex flex-wrap gap-2 border-b border-gray-200 bg-white/95 px-2 py-3 backdrop-blur">
                <button onclick="scrollConfigSection('config-basic')" class="config-nav-button">基本信息</button>
                <button onclick="scrollConfigSection('config-profile')" class="config-nav-button">账号画像</button>
                <button onclick="scrollConfigSection('config-keywords')" class="config-nav-button">搜索关键词</button>
                <button onclick="scrollConfigSection('config-schedule')" class="config-nav-button">定时任务</button>
                <button onclick="scrollConfigSection('config-ai')" class="config-nav-button">AI 能力</button>
                <button onclick="scrollConfigSection('config-feishu')" class="config-nav-button">飞书推送</button>
              </div>
              <div class="flex flex-col gap-6">

                <!-- Basic Info Section -->
                <div id="config-basic" style="order: 1" class="config-section bg-white border border-gray-200 rounded-lg p-6">
                  <h3 class="text-lg font-semibold text-gray-900 mb-4">基本信息</h3>
                  <div class="space-y-4">
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">用户 ID</label>
                      <input id="configUserId" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="例如: local">
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">创作者账号</label>
                      <input id="configAccountHandle" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="例如: @myaccount">
                      <p class="mt-1 text-xs text-gray-500">用于画像和草稿口吻，不用于抓取 X 内容。</p>
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">画像文件路径</label>
                      <input id="configProfilePath" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="留空则使用 data/profiles/{用户ID}.json">
                    </div>
                  </div>
                </div>

                <!-- AI Section -->
                <details id="config-ai" style="order: 5" class="config-section bg-white border border-gray-200 rounded-lg p-6">
                  <summary class="flex items-center justify-between gap-3">
                    <h3 class="text-lg font-semibold text-gray-900">AI 能力</h3>
                    <span class="text-xs text-gray-500">点击展开</span>
                  </summary>
                  <div class="mt-4 space-y-5">
                    <p class="text-sm text-gray-600">只想先跑起来可以跳过；补上以后，Spark 才会自动筛选内容并生成草稿。</p>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                        <div class="mb-3">
                          <label class="block text-sm font-semibold text-gray-900">内容智能筛选密钥</label>
                          <p class="mt-1 text-xs text-gray-500">用来从每天抓到的内容里挑出最值得看的部分。</p>
                        </div>
                        <div class="flex gap-2">
                          <input id="configEmbeddingApiKey" type="password" class="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="粘贴内容智能筛选密钥（阿里云百炼）">
                          <button onclick="validateAiCredential('embedding')" class="px-3 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">验证</button>
                          <button onclick="clearCredential('embedding')" class="px-3 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50">清空</button>
                        </div>
                        <p id="configEmbeddingStatus" class="mt-1 text-xs text-gray-500">未配置</p>
                      </div>
                      <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
                        <div class="mb-3">
                          <label class="block text-sm font-semibold text-gray-900">AI 自动写草稿密钥</label>
                          <p class="mt-1 text-xs text-gray-500">用来为推荐内容生成短、中、长三种草稿。</p>
                        </div>
                        <div class="flex gap-2">
                          <input id="configDeepseekApiKey" type="password" class="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="粘贴 AI 自动写草稿密钥（DeepSeek）">
                          <button onclick="validateAiCredential('deepseek')" class="px-3 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">验证</button>
                          <button onclick="clearCredential('deepseek')" class="px-3 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50">清空</button>
                        </div>
                        <p id="configDeepseekStatus" class="mt-1 text-xs text-gray-500">未配置</p>
                      </div>
                    </div>
                    <details class="rounded-lg border border-gray-200 bg-white p-4">
                      <summary class="text-sm font-medium text-gray-700">高级参数</summary>
                      <div class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <label class="block text-sm font-medium text-gray-700 mb-2">内容筛选服务地址</label>
                          <input id="configEmbeddingBaseUrl" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1">
                        </div>
                        <div>
                          <label class="block text-sm font-medium text-gray-700 mb-2">内容筛选模型</label>
                          <input id="configEmbeddingModel" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="text-embedding-v4">
                        </div>
                        <div>
                          <label class="block text-sm font-medium text-gray-700 mb-2">写草稿服务地址</label>
                          <input id="configDeepseekBaseUrl" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="https://api.deepseek.com">
                        </div>
                      </div>
                    </details>
                  </div>
                </details>

                <!-- Source Parameters Section -->
                <div id="config-keywords" style="order: 3" class="config-section bg-white border border-gray-200 rounded-lg p-6">
                  <h3 class="text-lg font-semibold text-gray-900 mb-2">搜索关键词</h3>
                  <p class="text-sm text-gray-500 mb-4">仅支持站内搜索的平台需要关键词；Hacker News、GitHub、V2EX 抓热门榜后由模型筛选。</p>
                  <div class="space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">知乎关键词</label>
                        <input id="configZhihuKeywords" type="text" class="w-full select-text px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="逗号分隔">
                      </div>
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">抖音关键词</label>
                        <input id="configDouyinKeywords" type="text" class="w-full select-text px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="逗号分隔">
                      </div>
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">小红书关键词</label>
                        <input id="configXiaohongshuKeywords" type="text" class="w-full select-text px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="逗号分隔">
                      </div>
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">微博关键词</label>
                        <input id="configWeiboKeywords" type="text" class="w-full select-text px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="逗号分隔">
                      </div>
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">Reddit 关注社区</label>
                      <input id="configRedditSubreddits" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="LocalLLaMA, OpenAI, programming">
                    </div>
                  </div>
                </div>

                <!-- Profile Section -->
                <div id="config-profile" style="order: 2" class="config-section bg-white border border-gray-200 rounded-lg p-6">
                  <h3 class="text-lg font-semibold text-gray-900 mb-4">账号画像</h3>
                  <div class="space-y-4">
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">兴趣领域</label>
                      <input id="configInterests" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="用逗号分隔，例如: AI, 编程, 创业">
                      <p class="mt-1 text-xs text-gray-500">描述你感兴趣的话题，用逗号分隔</p>
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">写作风格</label>
                      <textarea id="configStyle" rows="3" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="例如: 简洁专业，注重技术深度"></textarea>
                      <p class="mt-1 text-xs text-gray-500">描述你的写作风格和语气</p>
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">目标受众</label>
                      <textarea id="configAudience" rows="3" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="例如: 技术从业者，对 AI 和编程感兴趣"></textarea>
                      <p class="mt-1 text-xs text-gray-500">描述你的目标读者群体</p>
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">示例内容</label>
                      <textarea id="configSamplePosts" rows="6" class="w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="粘贴你之前发布的内容示例，每行一条"></textarea>
                      <p class="mt-1 text-xs text-gray-500">提供 3-5 条你之前发布的内容，帮助 AI 学习你的风格</p>
                    </div>
                  </div>
                </div>

                <!-- Schedule Section -->
                <div id="config-schedule" style="order: 4" class="config-section bg-white border border-gray-200 rounded-lg p-6">
                  <h3 class="text-lg font-semibold text-gray-900 mb-4">定时任务</h3>
                  <div class="space-y-4">
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">运行时间</label>
                      <select id="configSchedule" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="0 9 * * *">每天早上 9:00</option>
                        <option value="0 12 * * *">每天中午 12:00</option>
                        <option value="0 18 * * *">每天晚上 18:00</option>
                        <option value="0 9,18 * * *">每天 9:00 和 18:00</option>
                        <option value="0 */6 * * *">每 6 小时一次</option>
                        <option value="0 */3 * * *">每 3 小时一次</option>
                        <option value="custom">自定义 Cron 表达式</option>
                      </select>
                    </div>
                    <div id="customCronContainer" class="hidden">
                      <label class="block text-sm font-medium text-gray-700 mb-2">自定义 Cron 表达式</label>
                      <input id="configCustomCron" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="例如: 0 9 * * *">
                      <p class="mt-1 text-xs text-gray-500">格式: 分 时 日 月 周，<a href="https://crontab.guru" target="_blank" class="text-blue-600 hover:underline">参考 Cron 语法</a></p>
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">时区</label>
                      <select id="configTimezone" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="Asia/Shanghai">中国标准时间 (UTC+8)</option>
                        <option value="America/New_York">美国东部时间 (UTC-5)</option>
                        <option value="America/Los_Angeles">美国西部时间 (UTC-8)</option>
                        <option value="Europe/London">英国时间 (UTC+0)</option>
                        <option value="Asia/Tokyo">日本时间 (UTC+9)</option>
                      </select>
                    </div>
                  </div>
                </div>

                <!-- Feishu Section -->
                <details id="config-feishu" style="order: 6" class="config-section bg-white border border-gray-200 rounded-lg p-6">
                  <summary class="flex items-center justify-between gap-3">
                    <h3 class="text-lg font-semibold text-gray-900">飞书推送</h3>
                    <span class="text-xs text-gray-500">点击展开</span>
                  </summary>
                  <div class="mt-4 space-y-4">
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">App ID</label>
                      <input id="configFeishuAppId" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="从飞书开放平台获取">
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">App Secret</label>
                      <input id="configFeishuAppSecret" type="password" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="从飞书开放平台获取">
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">Base ID</label>
                      <input id="configFeishuBaseId" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="多维表格的 Base ID">
                    </div>
                    <div>
                      <label class="block text-sm font-medium text-gray-700 mb-2">接收人 ID</label>
                      <input id="configFeishuReceiverId" type="text" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="接收消息的用户或群组 ID">
                    </div>
                  </div>
                </details>

                <!-- Save Button -->
                <div style="order: 7" class="flex items-center justify-between">
                  <button data-action="save-config" onclick="saveUserFromForm()" class="bg-blue-600 text-white px-8 py-3 rounded-md hover:bg-blue-700 disabled:bg-blue-300 transition font-medium text-lg">
                    保存所有配置
                  </button>
                  <button onclick="toggleAdvancedConfig()" class="text-sm text-gray-600 hover:text-gray-900 underline">
                    切换到高级模式（JSON 编辑）
                  </button>
                </div>

                <!-- Advanced JSON Editor (Hidden by default) -->
                <div id="advancedConfigContainer" style="order: 8" class="hidden">
                  <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
                    <p class="text-sm text-yellow-800">⚠️ 高级模式：直接编辑 JSON 配置，请谨慎操作</p>
                  </div>
                  <textarea
                    id="config"
                    class="w-full h-96 px-4 py-3 border border-gray-300 rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="配置将在这里显示..."
                  ></textarea>
                  <div class="mt-4">
                    <button onclick="saveUser()" class="bg-gray-600 text-white px-6 py-2 rounded-md hover:bg-gray-700 transition font-medium">
                      保存 JSON 配置
                    </button>
                  </div>
                </div>

              </div>
            </div>

            <!-- Platforms Tab -->
            <div id="content-platforms" class="tab-content hidden">
              <div class="mb-4">
                <h3 class="text-sm font-medium text-gray-700 mb-2">选择要启用的内容平台</h3>
                <p class="text-sm text-gray-500">点击开关启用或禁用平台，修改后记得保存配置</p>
              </div>

              <div id="platformsList" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                <!-- Platforms will be rendered here by JavaScript -->
              </div>

              <div id="platformCredentialPanel" class="hidden mt-4 border border-gray-200 rounded-lg p-4 bg-gray-50">
                <!-- Selected platform credential controls will be rendered here -->
              </div>

              <div class="mt-6">
                <button data-action="save-platforms" onclick="savePlatformConfig()" class="bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 disabled:bg-blue-300 transition font-medium">
                  保存平台配置
                </button>
              </div>

              <details class="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
                <summary class="text-sm font-medium text-blue-800">查看登录帮助</summary>
                <div class="mt-4 space-y-4">
                <!-- Cookie 获取教程 -->
                <div>
                  <div class="flex">
                    <div class="flex-shrink-0">
                      <svg class="h-5 w-5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
                      </svg>
                    </div>
                    <div class="ml-3 flex-1">
                      <h3 class="text-sm font-medium text-blue-800 mb-2">如何获取 Cookie？</h3>
                      <div class="space-y-3">
                        <div>
                          <p class="text-sm font-semibold text-blue-900 mb-1">方法一：使用浏览器开发者工具（推荐）</p>
                          <ol class="list-decimal list-inside space-y-1 text-sm text-blue-700 ml-2">
                            <li>在浏览器中登录对应平台（知乎、抖音、小红书、微博）</li>
                            <li>按 <kbd class="px-1 py-0.5 bg-white rounded text-xs">F12</kbd> 打开开发者工具</li>
                            <li>切换到 <strong>Network（网络）</strong> 标签</li>
                            <li>刷新页面（<kbd class="px-1 py-0.5 bg-white rounded text-xs">F5</kbd>）</li>
                            <li>点击任意请求，在右侧找到 <strong>Request Headers</strong></li>
                            <li>找到 <code class="bg-white px-1 rounded">Cookie:</code> 这一行</li>
                            <li>复制整行 Cookie 值（通常很长），粘贴到上方输入框</li>
                          </ol>
                        </div>
                        <div class="pt-2 border-t border-blue-200">
                          <p class="text-sm font-semibold text-blue-900 mb-1">方法二：使用浏览器扩展（即将支持）</p>
                          <p class="text-sm text-blue-700">安装 Cookie 导出扩展，一键复制当前网站的 Cookie</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 平台说明 -->
                <div class="rounded-lg border border-gray-200 bg-white p-4">
                  <h3 class="text-sm font-medium text-gray-800 mb-2">平台说明</h3>
                  <div class="text-sm text-gray-600 space-y-1">
                    <p>🔐 <strong>需要登录：</strong>知乎、抖音、小红书、微博</p>
                    <p>🆓 <strong>免费平台：</strong>HackerNews、GitHub、Reddit、V2EX（无需配置）</p>
                    <p>🔑 <strong>高级配置：</strong>X、Product Hunt 暂不在普通界面配置</p>
                  </div>
                </div>

                <!-- Cookie 安全提示 -->
                <div class="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                  <div class="flex">
                    <div class="flex-shrink-0">
                      <svg class="h-5 w-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
                      </svg>
                    </div>
                    <div class="ml-3">
                      <h3 class="text-sm font-medium text-yellow-800">安全提示</h3>
                      <p class="mt-1 text-sm text-yellow-700">Cookie 包含你的登录凭证，请妥善保管。本系统会加密存储 Cookie，但请不要分享给他人。</p>
                    </div>
                  </div>
                </div>
                </div>
              </details>
            </div>

            <!-- Logs Tab -->
            <div id="content-logs" class="tab-content hidden">
              <div class="mb-4 flex flex-wrap items-center gap-3">
                <select id="logStatusFilter" onchange="loadLogs()" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm">
                  <option value="">全部状态</option>
                  <option value="running">运行中</option>
                  <option value="succeeded">成功</option>
                  <option value="failed">失败</option>
                </select>
                <label class="flex items-center gap-2 text-sm text-gray-600">
                  <input id="logAutoScroll" type="checkbox" checked>
                  自动定位最新
                </label>
                <button onclick="loadLogs()" class="bg-gray-600 text-white px-4 py-2 rounded-md hover:bg-gray-700 transition">
                  刷新日志
                </button>
              </div>
              <div id="logsContainer" class="bg-gray-50 rounded-lg p-4 border border-gray-200 max-h-96 overflow-y-auto">
                <div id="logs" class="space-y-3 text-sm text-gray-700">加载中...</div>
              </div>
            </div>

          </div>
        </div>
      </div>

    </div>
  </div>

  <!-- Toast Notification -->
  <div id="toast" class="fixed bottom-4 right-4 hidden">
    <div class="bg-white rounded-lg shadow-lg border border-gray-200 p-4 max-w-sm">
      <div class="flex items-center">
        <div id="toastIcon" class="flex-shrink-0"></div>
        <div class="ml-3">
          <p id="toastMessage" class="text-sm font-medium text-gray-900"></p>
        </div>
      </div>
    </div>
  </div>

  <div id="loginProgressModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/40 p-4">
    <div class="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-semibold text-blue-700">平台连接</p>
          <h3 id="loginProgressTitle" class="mt-1 text-xl font-bold text-gray-900">请在浏览器中完成登录</h3>
        </div>
        <span id="loginProgressCountdown" class="rounded-md bg-gray-100 px-2 py-1 text-sm font-semibold text-gray-700">05:00</span>
      </div>
      <p id="loginProgressMessage" class="mt-4 text-sm leading-6 text-gray-600"></p>
      <div class="mt-5 rounded-md bg-blue-50 p-3 text-sm text-blue-800">
        完成后不需要点击按钮，Spark 会自动检测并继续运行。
      </div>
    </div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const initialUserId = urlParams.get('userId') || 'local';
    const initialTab = ['overview', 'recommendations', 'data', 'config', 'platforms', 'logs'].includes(urlParams.get('tab') || '')
      ? urlParams.get('tab')
      : '';
    let currentUserId = initialUserId;
    let currentConfig = null;
    let currentProfile = null;
    let selectedPlatformId = null;
    let logsRefreshTimer = null;
    let recommendationsRefreshTimer = null;
    let knownUserIds = new Set();
    let latestRunStats = {};
    let lastRecoveryNoticeKey = '';
    const autoRecoveryRunIds = new Set();
    let autoRecoveryRunning = false;
    let autoRecoveryAttempts = 0;
    let latestRunId = null;
    let watchedRunPreviousId = null;
    let watchedRunDeadline = 0;
    let environmentStatus = null;
    let loginCountdownTimer = null;
    const tokenFromUrl = urlParams.get('token');
    const adminTokenKey = 'sparkAdminToken';
    const legacyAdminTokenKey = 'contentScoutAdminToken';
    if (tokenFromUrl) {
      localStorage.setItem(adminTokenKey, tokenFromUrl);
      localStorage.removeItem(legacyAdminTokenKey);
      window.history.replaceState(null, '', window.location.pathname);
    }
    const adminToken = localStorage.getItem(adminTokenKey) || localStorage.getItem(legacyAdminTokenKey) || '';

    // Platform definitions
    const platforms = [
      { id: 'hackernews', name: 'Hacker News', icon: 'HN', color: 'bg-orange-500', needsAuth: false, description: '免费使用' },
      { id: 'github', name: 'GitHub Trending', icon: 'GH', color: 'bg-gray-800', needsAuth: false, description: '免费使用' },
      { id: 'zhihu', name: '知乎', icon: '知', color: 'bg-blue-600', needsAuth: 'cookie', description: '需要登录' },
      { id: 'reddit', name: 'Reddit', icon: 'RD', color: 'bg-orange-600', needsAuth: false, description: '免费使用' },
      { id: 'v2ex', name: 'V2EX', icon: 'V2', color: 'bg-gray-700', needsAuth: false, description: '免费使用' },
      { id: 'douyin', name: '抖音', icon: '抖', color: 'bg-black', needsAuth: 'cookie', description: '需要登录' },
      { id: 'xiaohongshu', name: '小红书', icon: '小', color: 'bg-red-500', needsAuth: 'cookie', description: '需要登录' },
      { id: 'weibo', name: '微博', icon: '微', color: 'bg-yellow-500', needsAuth: 'cookie', description: '需要登录' }
    ];

    function updateContentSourceFilter(config) {
      const select = document.getElementById('contentSourceFilter');
      if (!select || !config) return;
      const current = select.value;
      select.innerHTML = '<option value="">全部平台</option>' + platforms
        .filter(platform => config.sources?.[platform.id]?.enabled)
        .map(platform => \`<option value="\${platform.id}">\${platform.name}</option>\`)
        .join('');
      select.value = Array.from(select.options).some(option => option.value === current) ? current : '';
    }

    // Toast notification
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      const icon = document.getElementById('toastIcon');
      const msg = document.getElementById('toastMessage');

      msg.textContent = message;

      if (type === 'success') {
        icon.innerHTML = '<svg class="h-5 w-5 text-green-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>';
      } else {
        icon.innerHTML = '<svg class="h-5 w-5 text-red-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>';
      }

      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 3000);
    }

    function setActionBusy(action, busy, busyText) {
      document.querySelectorAll(\`[data-action="\${action}"]\`).forEach(button => {
        if (!button.dataset.defaultText) {
          button.dataset.defaultText = button.textContent.trim();
        }
        button.disabled = busy;
        button.textContent = busy ? busyText : button.dataset.defaultText;
      });
    }

    function setRuntimeStatus(status, label) {
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');
      if (!dot || !text) return;
      const colors = {
        idle: 'bg-gray-400',
        running: 'bg-blue-500',
        warning: 'bg-amber-500',
        error: 'bg-red-500'
      };
      dot.className = \`w-2 h-2 rounded-full \${colors[status] || colors.idle}\${status === 'running' ? ' animate-pulse' : ''}\`;
      text.textContent = label;
    }

    function updateRuntimeStatusFromRun(run) {
      if (!run) {
        setRuntimeStatus('idle', '空闲');
        return;
      }
      if (run.status === 'running') {
        setRuntimeStatus('running', '运行中');
      } else if (run.status === 'failed') {
        setRuntimeStatus('error', '运行失败');
      } else {
        setRuntimeStatus('idle', '空闲');
      }
    }

    function scrollConfigSection(id) {
      const section = document.getElementById(id);
      if (section?.tagName === 'DETAILS') {
        section.open = true;
      }
      section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function openConfigSection(id) {
      switchTab('config');
      setTimeout(() => scrollConfigSection(id), 0);
    }

    function toggleUserManager() {
      document.getElementById('userManager')?.classList.toggle('hidden');
    }

    // Tab switching
    function switchTab(tabName) {
      document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active', 'border-blue-600', 'text-blue-600');
        btn.classList.add('border-transparent', 'text-gray-500');
      });
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.add('hidden');
      });

      document.getElementById(\`tab-\${tabName}\`).classList.add('active', 'border-blue-600', 'text-blue-600');
      document.getElementById(\`content-\${tabName}\`).classList.remove('hidden');

      if (tabName === 'logs') {
        loadLogs();
      }
      if (tabName === 'recommendations') {
        loadRecommendations();
      }
      if (tabName === 'data') {
        loadRawContent();
      }
    }

    // API request helper
    async function request(path, options = {}) {
      try {
        const headers = {'content-type': 'application/json'};
        if (adminToken) {
          headers.authorization = \`Bearer \${adminToken}\`;
        }

        const response = await fetch(path, {
          headers,
          ...options
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        return data;
      } catch (error) {
        showToast(error.message, 'error');
        throw error;
      }
    }

    // Load users
    async function loadUsers() {
      try {
        const users = await request('/api/users');
        knownUserIds = new Set(users.map(u => u.userId));
        const container = document.getElementById('users');
        const headerSelect = document.getElementById('headerUserSelect');
        if (headerSelect) {
          headerSelect.innerHTML = users
            .map(u => \`<option value="\${escapeHtml(u.userId)}">\${escapeHtml(u.userId)}</option>\`)
            .join('');
          headerSelect.value = currentUserId;
        }
        if (!users.length) {
          container.innerHTML = '<div class="text-sm text-gray-500 px-1 py-2">暂无用户</div>';
          return users;
        }

        container.innerHTML = users.map(u => {
          const enabledCount = Array.isArray(u.enabledSources) ? u.enabledSources.length : 0;
          const activeClass = u.userId === currentUserId
            ? 'border-blue-500 bg-blue-50 text-blue-900'
            : 'border-gray-200 hover:bg-gray-50 text-gray-900';

          return \`
            <div class="flex items-stretch gap-2">
              <button
                onclick="selectUser('\${encodeURIComponent(u.userId)}')"
                class="min-w-0 flex-1 text-left px-3 py-2 rounded-md border transition \${activeClass}"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="font-medium truncate">\${escapeHtml(u.userId)}</span>
                  <span class="shrink-0 text-xs text-gray-500">\${enabledCount} 平台</span>
                </div>
              </button>
              <button
                onclick="deleteUser('\${encodeURIComponent(u.userId)}')"
                class="shrink-0 px-2 rounded-md border border-red-200 text-red-600 hover:bg-red-50 text-xs"
                title="删除用户"
                aria-label="删除用户 \${escapeHtml(u.userId)}"
              >
                删除
              </button>
            </div>
          \`;
        }).join('');
        return users;
      } catch (error) {
        console.error('Failed to load users:', error);
        return [];
      }
    }

    function selectUser(encodedId) {
      const id = decodeURIComponent(encodedId);
      document.getElementById('userId').value = id;
      loadUser();
    }

    function readUserId() {
      return document.getElementById('userId').value.trim() || 'local';
    }

    function readInputUserId() {
      return document.getElementById('userId').value.trim();
    }

    function generateUserId() {
      const now = new Date();
      const pad = value => String(value).padStart(2, '0');
      const base = \`user-\${now.getFullYear()}\${pad(now.getMonth() + 1)}\${pad(now.getDate())}-\${pad(now.getHours())}\${pad(now.getMinutes())}\${pad(now.getSeconds())}\`;
      let candidate = base;
      let index = 2;
      while (knownUserIds.has(candidate)) {
        candidate = \`\${base}-\${index}\`;
        index += 1;
      }
      return candidate;
    }

    function setUserActionMessage(message, type = 'info') {
      const element = document.getElementById('userActionMessage');
      if (!element) return;
      element.textContent = message;
      element.className = type === 'error'
        ? 'mt-2 text-xs text-red-600'
        : 'mt-2 text-xs text-gray-500';
    }

    function parseCommaList(value) {
      return String(value || '')
        .split(/[,\\n]/)
        .map(item => item.trim())
        .filter(Boolean);
    }

    // Load user config
    async function loadUser() {
      try {
        const id = readUserId();
        const data = await request(\`/api/users/\${encodeURIComponent(id)}\`);
        await applyLoadedUser(id, data);
        await loadUsers();
        setUserActionMessage(\`已切换到 \${id}\`);
        showToast('配置加载成功');
      } catch (error) {
        console.error('Failed to load user:', error);
      }
    }

    async function createUser() {
      const button = document.getElementById('createUserButton');
      try {
        if (button) {
          button.disabled = true;
          button.textContent = '创建中...';
        }

        await loadUsers();
        const inputId = readInputUserId();
        const id = inputId && !knownUserIds.has(inputId) ? inputId : generateUserId();
        document.getElementById('userId').value = id;
        const saved = await request(\`/api/users/\${encodeURIComponent(id)}\`, {
          method: 'POST',
          body: JSON.stringify({mode: 'create'})
        });
        await applyLoadedUser(id, saved);
        await loadUsers();
        setUserActionMessage(\`已新建用户 \${id}\`);
        showToast('用户已新建');
      } catch (error) {
        setUserActionMessage(error.message, 'error');
        console.error('Failed to create user:', error);
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = '新建用户';
        }
      }
    }

    async function deleteUser(encodedId) {
      const id = decodeURIComponent(encodedId);
      if (!confirm(\`删除用户 \${id}？该用户的配置、登录状态和运行记录都会删除。\`)) {
        return;
      }

      try {
        await request(\`/api/users/\${encodeURIComponent(id)}\`, {method: 'DELETE'});
        const users = await loadUsers();
        if (currentUserId === id) {
          if (users.length) {
            document.getElementById('userId').value = users[0].userId;
            await loadUser();
          } else {
            currentUserId = '';
            currentConfig = null;
            document.getElementById('userId').value = '';
            setUserActionMessage('用户已删除，暂无用户');
          }
        }
        showToast('用户已删除');
      } catch (error) {
        setUserActionMessage(error.message, 'error');
        console.error('Failed to delete user:', error);
      }
    }

    async function applyLoadedUser(id, data) {
      currentUserId = id;
      currentConfig = data;
      currentProfile = null;
      document.getElementById('userId').value = id;
      document.getElementById('config').value = JSON.stringify(data, null, 2);
      latestRunStats = await loadLatestRunStats(id);
      updateOverview(data);
      updatePlatformStatus(data);
      loadConfigIntoForm(data);
      updateContentSourceFilter(data);
      await loadEnvironmentDiagnostics();

      try {
        const profile = await request(\`/api/users/\${encodeURIComponent(id)}/profile\`);
        currentProfile = profile;
        document.getElementById('configInterests').value = Array.isArray(profile.interests)
          ? profile.interests.join(', ')
          : profile.interests || '';
        document.getElementById('configStyle').value = profile.style || '';
        document.getElementById('configAudience').value = profile.audience || '';
        document.getElementById('configSamplePosts').value = Array.isArray(profile.samplePosts)
          ? profile.samplePosts.join('\\n')
          : profile.samplePosts || '';
        updateOverview(currentConfig);
      } catch (error) {
        currentProfile = null;
        document.getElementById('configInterests').value = '';
        document.getElementById('configStyle').value = '';
        document.getElementById('configAudience').value = '';
        document.getElementById('configSamplePosts').value = '';
        updateOverview(currentConfig);
      }
    }

    async function loadLatestRunStats(id) {
      try {
        const runs = await request(\`/api/runs?userId=\${encodeURIComponent(id)}&limit=1\`);
        return parseStats(runs[0]?.stats_json);
      } catch {
        return {};
      }
    }

    // Update overview
    function updateOverview(config) {
      const enabledSources = platforms.filter(platform => config.sources[platform.id]?.enabled);
      document.getElementById('enabledSourcesCount').textContent = enabledSources.length;
      document.getElementById('scheduleStatus').textContent = config.schedule?.cronSchedule || '未设置';

      const connections = [
        config.credentialStatus?.zhihuCookie,
        config.credentialStatus?.douyinCookie,
        config.credentialStatus?.xiaohongshuCookie,
        config.credentialStatus?.weiboCookie
      ].filter(Boolean).length;
      document.getElementById('connectionCount').textContent = \`\${connections}/4\`;
      document.getElementById('attentionCount').textContent = String(attentionIssues(config).length);
      renderActivationChecklist(config);
      renderPlatformHealth(config);
      renderAiHealth(config);
      renderEnvironmentHealth();
      renderRunOutcome(config);
      document.getElementById('lastRunSummary').textContent = buildRunSummary(latestRunStats);
      notifyRecoverableFailures();
    }

    function renderActivationChecklist(config) {
      const container = document.getElementById('activationChecklist');
      if (!container) return;

      const enabledSources = platforms.filter(platform => config.sources?.[platform.id]?.enabled);
      const loginPlatforms = enabledSources.filter(platform => platform.needsAuth === 'cookie');
      const connectedLoginPlatforms = loginPlatforms.filter(platform => {
        const hasAuth = Boolean(config.credentialStatus?.[\`\${platform.id}Cookie\`]);
        const check = credentialCheck(config, platform.id);
        return hasAuth && check?.status === 'valid';
      });
      const firstPendingLogin = loginPlatforms.find(platform => {
        const hasAuth = Boolean(config.credentialStatus?.[\`\${platform.id}Cookie\`]);
        const check = credentialCheck(config, platform.id);
        return !hasAuth || check?.status !== 'valid';
      });
      const firstPendingFailure = firstPendingLogin
        ? platformRecoveryFailure(firstPendingLogin.id, config)
        : '';
      const profileReady = profileHasContent(currentProfile);
      const embeddingReady = credentialReady(config, 'embedding');
      const deepseekReady = credentialReady(config, 'deepseek');
      const aiReadyCount = [embeddingReady, deepseekReady].filter(Boolean).length;
      const hasRun = Boolean(latestRunStats && Array.isArray(latestRunStats.aggregation));
      const selected = latestRunStats?.filtering?.selected ?? latestRunStats?.result?.recommendations ?? 0;
      const drafts = latestRunStats?.drafts?.drafts ?? 0;
      const unresolvedIssues = attentionIssues(config);

      const tasks = [
        {
          done: profileReady,
          title: '确认创作方向',
          description: profileReady ? '画像已保存，会按你的兴趣和语气筛选内容。' : '告诉 Spark 你关注什么、写给谁看。',
          action: "openConfigSection('config-profile')",
          actionLabel: profileReady ? '查看' : '去填写',
        },
        {
          done: enabledSources.length > 0,
          title: '选择灵感来源',
          description: enabledSources.length ? \`已启用 \${enabledSources.length} 个平台。\` : '至少启用一个平台后才能抓内容。',
          action: "switchTab('platforms')",
          actionLabel: enabledSources.length ? '查看' : '去选择',
        },
        {
          done: loginPlatforms.length === 0 || connectedLoginPlatforms.length === loginPlatforms.length,
          title: '连接需要登录的平台',
          description: loginPlatforms.length
            ? \`已确认 \${connectedLoginPlatforms.length}/\${loginPlatforms.length} 个需要登录的平台。\`
            : '当前启用的平台都不需要登录。',
          action: firstPendingLogin
            ? (firstPendingFailure
              ? loginRecoveryAction(firstPendingLogin.id, firstPendingFailure)
              : \`switchTab('platforms'); selectPlatformCredential('\${firstPendingLogin.id}')\`)
            : "switchTab('platforms')",
          actionLabel: firstPendingLogin ? '去处理' : '查看',
        },
        {
          done: embeddingReady && deepseekReady,
          title: '接入 AI 能力',
          description: aiReadyCount === 2 ? '内容智能筛选和 AI 自动写草稿都已接入。' : \`已接入 \${aiReadyCount}/2 项；没接入也能抓内容，但不会完整自动化。\`,
          action: "openConfigSection('config-ai')",
          actionLabel: aiReadyCount === 2 ? '查看' : (aiReadyCount ? '补齐' : '去接入'),
        },
        {
          done: unresolvedIssues.length === 0,
          title: '处理异常',
          description: unresolvedIssues.length ? \`还有 \${unresolvedIssues.length} 个问题需要处理。\` : '当前没有需要处理的问题。',
          action: unresolvedIssues[0]?.action || "switchTab('overview')",
          actionLabel: unresolvedIssues.length ? '去处理' : '查看',
        },
        {
          done: hasRun,
          title: hasRun ? '查看推荐结果' : '跑一次看看结果',
          description: hasRun ? \`上次筛出 \${selected} 条推荐，生成 \${drafts} 个草稿。\` : '首次运行后，这里会直接告诉你内容在哪看。',
          action: hasRun ? "switchTab('recommendations'); loadRecommendations()" : 'runUser()',
          actionLabel: hasRun ? '看推荐' : '立即运行',
        },
      ];
      const completed = tasks.filter(task => task.done).length;
      const percent = Math.round((completed / tasks.length) * 100);
      const isReady = completed === tasks.length;

      container.innerHTML = \`
        <div class="rounded-xl border \${isReady ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'} p-5">
          <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div class="text-sm font-semibold \${isReady ? 'text-green-800' : 'text-amber-800'}">\${isReady ? 'Spark 已就绪' : '把 Spark 跑起来'}</div>
              <div class="mt-1 text-xl font-bold text-gray-900">\${completed}/\${tasks.length} 项完成</div>
              <div class="mt-2 h-2 w-full max-w-md overflow-hidden rounded-full bg-white/70">
                <div class="h-full rounded-full \${isReady ? 'bg-green-500' : 'bg-amber-500'}" style="width: \${percent}%"></div>
              </div>
            </div>
            <button data-action="run" onclick="runUser()" class="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300">
              立即运行
            </button>
          </div>
          <div class="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            \${tasks.map(task => \`
              <div class="rounded-lg border \${task.done ? 'border-green-100 bg-white' : 'border-amber-100 bg-white'} p-3">
                <div class="flex items-center gap-2">
                  <span class="h-2.5 w-2.5 rounded-full \${task.done ? 'bg-green-500' : 'bg-amber-500'}"></span>
                  <span class="font-medium text-gray-900">\${escapeHtml(task.title)}</span>
                </div>
                <p class="mt-2 min-h-[40px] text-xs leading-5 text-gray-600">\${escapeHtml(task.description)}</p>
                <button onclick="\${task.action}" class="mt-3 text-xs font-medium text-blue-700 hover:text-blue-900">\${escapeHtml(task.actionLabel)}</button>
              </div>
            \`).join('')}
          </div>
        </div>
      \`;
    }

    function profileHasContent(profile) {
      if (!profile) return false;
      const textFields = [profile.bio, profile.style, profile.audience];
      const listFields = [profile.interests, profile.topics, profile.samplePosts];
      return textFields.some(value => String(value || '').trim().length > 0)
        || listFields.some(value => Array.isArray(value) ? value.length > 0 : String(value || '').trim().length > 0);
    }

    function credentialReady(config, kind) {
      const hasKey = kind === 'embedding'
        ? Boolean(config.credentialStatus?.embeddingApiKey)
        : Boolean(config.credentialStatus?.deepseekApiKey);
      const check = credentialCheck(config, kind);
      return hasKey && check?.status !== 'invalid';
    }

    function renderPlatformHealth(config) {
      const container = document.getElementById('platformHealthGrid');
      if (!container) return;

      const aggregation = Array.isArray(latestRunStats.aggregation) ? latestRunStats.aggregation : [];
      const bySource = new Map(aggregation.map(item => [item.source, item]));

      container.innerHTML = platforms.map(platform => {
        const enabled = Boolean(config.sources[platform.id]?.enabled);
        const hasAuth = platform.needsAuth === 'cookie'
          ? Boolean(config.credentialStatus?.[\`\${platform.id}Cookie\`])
          : true;
        const stat = bySource.get(platform.id);
        const check = credentialCheck(config, platform.id);
        const health = platformHealth(platform, enabled, hasAuth, stat, check);

        return \`
          <div class="border \${health.border} \${health.bg} rounded-lg p-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="h-2.5 w-2.5 rounded-full \${health.dot}"></span>
                  <span class="font-medium text-gray-900 truncate">\${platform.name}</span>
                </div>
                <div class="mt-1 text-xs \${health.text}">\${health.message}</div>
                \${strictProbeBadge(platform, hasAuth, check)}
              </div>
              \${health.action ? \`<button onclick="\${health.action}" class="shrink-0 text-xs font-medium text-blue-700 hover:text-blue-900">\${health.actionLabel || '处理'}</button>\` : ''}
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderAiHealth(config) {
      const container = document.getElementById('aiHealthGrid');
      if (!container) return;

      const items = [
        aiHealth('embedding', '内容智能筛选', '从抓到的内容里挑出最可能值得看的'),
        aiHealth('deepseek', 'AI 自动写草稿', '为推荐内容生成短、中、长三种草稿'),
      ];

      container.innerHTML = items.map(item => \`
        <div class="border \${item.border} \${item.bg} rounded-lg p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="h-2.5 w-2.5 rounded-full \${item.dot}"></span>
                <span class="font-medium text-gray-900">\${item.label}</span>
              </div>
              <div class="mt-1 text-xs text-gray-500">\${item.description}</div>
              <div class="mt-1 text-xs \${item.text}">\${item.message}</div>
            </div>
            <div class="flex shrink-0 gap-2">
              \${item.canValidate ? \`<button onclick="validateAiCredential('\${item.kind}')" class="text-xs font-medium text-blue-700 hover:text-blue-900">验证</button>\` : ''}
              <button onclick="switchTab('config')" class="text-xs font-medium text-gray-600 hover:text-gray-900">配置</button>
            </div>
          </div>
        </div>
      \`).join('');

      function aiHealth(kind, label, description) {
        const hasKey = kind === 'embedding'
          ? Boolean(config.credentialStatus?.embeddingApiKey)
          : Boolean(config.credentialStatus?.deepseekApiKey);
        const check = credentialCheck(config, kind);
        if (!hasKey) {
          return {
            kind,
            label,
            description,
            dot: 'bg-yellow-500',
            bg: 'bg-yellow-50',
            border: 'border-yellow-100',
            text: 'text-yellow-700',
            message: '未配置，相关能力会降级',
            canValidate: false,
          };
        }
        if (check?.status === 'valid') {
          return {
            kind,
            label,
            description,
            dot: 'bg-green-500',
            bg: 'bg-green-50',
            border: 'border-green-100',
            text: 'text-green-700',
            message: check.message || '已验证可用',
            canValidate: true,
          };
        }
        if (check?.status === 'invalid') {
          return {
            kind,
            label,
            description,
            dot: 'bg-red-500',
            bg: 'bg-red-50',
            border: 'border-red-100',
            text: 'text-red-700',
            message: check.message || '密钥不可用',
            canValidate: true,
          };
        }
        return {
          kind,
          label,
          description,
          dot: 'bg-blue-500',
          bg: 'bg-blue-50',
          border: 'border-blue-100',
          text: 'text-blue-700',
          message: check?.message || '已保存，建议验证一次',
          canValidate: true,
        };
      }
    }

    async function loadEnvironmentDiagnostics() {
      try {
        environmentStatus = await request('/api/diagnostics/environment');
      } catch (error) {
        environmentStatus = null;
        console.error('Failed to load environment diagnostics:', error);
      }
      renderEnvironmentHealth();
    }

    function renderEnvironmentHealth() {
      const container = document.getElementById('environmentHealthGrid');
      if (!container) return;
      const items = environmentStatus
        ? [
          ['浏览器', environmentStatus.browser],
          ['凭证保护', environmentStatus.credentialStorage],
          ['后台抓取', environmentStatus.backgroundScraping],
        ]
        : [['本机环境', { ok: false, message: '等待检测' }]];
      container.innerHTML = items.map(([label, item]) => \`
        <div class="rounded-lg border \${item.ok ? 'border-green-100 bg-green-50' : 'border-amber-100 bg-amber-50'} p-3">
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full \${item.ok ? 'bg-green-500' : 'bg-amber-500'}"></span>
            <span class="font-medium text-gray-900">\${label}</span>
          </div>
          <div class="mt-1 text-xs \${item.ok ? 'text-green-700' : 'text-amber-700'}">\${escapeHtml(item.message)}</div>
        </div>
      \`).join('');
    }

    function renderRunOutcome(config) {
      const panel = document.getElementById('runOutcomeCard');
      if (!panel) return;

      const hasRun = latestRunStats && Array.isArray(latestRunStats.aggregation);
      const issues = attentionIssues(config);
      if (!hasRun) {
        panel.className = 'mb-6 rounded-lg border border-gray-200 bg-white p-4';
        panel.innerHTML = \`
          <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="font-semibold text-gray-900">还没有运行结果</div>
              <div class="mt-1 text-sm text-gray-600">点击“立即运行”后，这里会显示抓取数量、推荐数量、草稿数量和需要处理的问题。</div>
            </div>
            <button data-action="run" onclick="runUser()" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300">立即运行</button>
          </div>
        \`;
        return;
      }

      const titleClass = issues.length ? 'text-amber-900' : 'text-green-900';
      const boxClass = issues.length ? 'border-amber-200 bg-amber-50' : 'border-green-200 bg-green-50';
      panel.className = \`mb-6 rounded-lg border \${boxClass} p-4\`;
      panel.innerHTML = \`
        <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div class="font-semibold \${titleClass}">最近一次运行结果</div>
            <div class="mt-1 text-sm text-gray-700">\${escapeHtml(buildRunSummary(latestRunStats))}</div>
          </div>
          <div class="flex shrink-0 gap-2">
            <button onclick="switchTab('recommendations'); loadRecommendations()" class="rounded-md bg-white px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50">看推荐</button>
            <button data-action="run" onclick="runUser()" class="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300">重跑</button>
          </div>
        </div>
        \${issues.length ? \`
          <div class="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            \${issues.map(issue => \`
              <div class="flex items-center justify-between gap-3 rounded-md bg-white/70 border border-white p-3 text-sm">
                <span class="text-gray-800">\${escapeHtml(issue.message)}</span>
                \${issue.action ? \`<button onclick="\${issue.action}" class="shrink-0 text-xs font-medium text-blue-700 hover:text-blue-900">\${issue.actionLabel}</button>\` : ''}
              </div>
            \`).join('')}
          </div>
        \` : ''}
      \`;
    }

    function attentionIssues(config) {
      const issues = [];
      const seen = new Set();
      const add = issue => {
        const key = issue.key || issue.message;
        if (seen.has(key)) return;
        seen.add(key);
        issues.push(issue);
      };
      const aggregation = Array.isArray(latestRunStats.aggregation) ? latestRunStats.aggregation : [];
      const failedSources = new Set(
        aggregation
          .filter(item => Number(item.errors || 0) > 0)
          .map(item => item.source)
      );

      platforms.forEach(platform => {
        const enabled = Boolean(config.sources?.[platform.id]?.enabled);
        if (!enabled) return;
        if (failedSources.has(platform.id)) return;

        if (platform.needsAuth === 'cookie') {
          const hasAuth = Boolean(config.credentialStatus?.[\`\${platform.id}Cookie\`]);
          const check = credentialCheck(config, platform.id);
          if (!hasAuth) {
            add({
              key: \`\${platform.id}:missing-auth\`,
              message: \`\${platform.name} 还没登录\`,
              action: \`switchTab('platforms'); selectPlatformCredential('\${platform.id}')\`,
              actionLabel: '去登录',
            });
          } else if (check?.status === 'invalid') {
            add({
              key: \`\${platform.id}:invalid-auth\`,
              message: \`\${platform.name} 登录失效\`,
              action: loginRecoveryAction(platform.id, 'auth_required'),
              actionLabel: '重新登录',
            });
          } else if (check?.status !== 'valid') {
            add({
              key: \`\${platform.id}:unknown-auth\`,
              message: \`\${platform.name} 登录状态待检查\`,
              action: \`validatePlatformCredential('\${platform.id}')\`,
              actionLabel: '检查连接',
            });
          }
        }
      });

      aggregation
        .filter(item => Number(item.errors || 0) > 0)
        .forEach(item => {
          const platform = platforms.find(p => p.id === item.source);
          const name = platform?.name || item.source;
          const auth = item.failureType === 'auth_required';
          const captcha = item.failureType === 'captcha_required';
          add({
            key: \`\${item.source}:run:\${item.failureType || 'failed'}\`,
            message: item.userMessage || \`\${name} 最近一次抓取失败\`,
            action: (auth || captcha) && platform?.needsAuth === 'cookie'
              ? loginRecoveryAction(item.source, item.failureType)
              : 'runUser()',
            actionLabel: auth || captcha ? '去处理' : '重跑',
          });
        });

      [
        ['embedding', '内容智能筛选', config.credentialStatus?.embeddingApiKey],
        ['deepseek', 'AI 自动写草稿', config.credentialStatus?.deepseekApiKey],
      ].forEach(([kind, label, hasKey]) => {
        const check = credentialCheck(config, kind);
        if (!hasKey) {
          add({
            key: \`\${kind}:missing\`,
            message: \`\${label}密钥未配置\`,
            action: "switchTab('config')",
            actionLabel: '去配置',
          });
        } else if (check?.status === 'invalid') {
          add({
            key: \`\${kind}:invalid\`,
            message: check.message || \`\${label}密钥不可用\`,
            action: \`validateAiCredential('\${kind}')\`,
            actionLabel: '验证',
          });
        } else if (check?.status !== 'valid') {
          add({
            key: \`\${kind}:unknown\`,
            message: \`\${label}密钥未验证\`,
            action: \`validateAiCredential('\${kind}')\`,
            actionLabel: '验证',
          });
        }
      });

      return issues;
    }

    function platformHealth(platform, enabled, hasAuth, stat, check) {
      if (!enabled) {
        return {
          dot: 'bg-gray-300',
          bg: 'bg-white',
          border: 'border-gray-200',
          text: 'text-gray-500',
          message: '未启用',
        };
      }

      if (!hasAuth) {
        return {
          dot: 'bg-blue-500',
          bg: 'bg-blue-50',
          border: 'border-blue-100',
          text: 'text-blue-700',
          message: '需要登录后才能抓取',
          action: \`switchTab('platforms'); selectPlatformCredential('\${platform.id}')\`,
          actionLabel: '去登录',
        };
      }

      if (platform.needsAuth === 'cookie' && check?.status === 'invalid') {
        return {
          dot: 'bg-red-500',
          bg: 'bg-red-50',
          border: 'border-red-100',
          text: 'text-red-700',
          message: check.message || '登录状态失效，需要重新登录',
          action: loginRecoveryAction(platform.id, 'auth_required'),
          actionLabel: '重新登录',
        };
      }

      if (!stat) {
        const needsValidation = platform.needsAuth === 'cookie' && check?.status !== 'valid';
        return {
          dot: needsValidation ? 'bg-yellow-500' : 'bg-blue-500',
          bg: needsValidation ? 'bg-yellow-50' : 'bg-blue-50',
          border: needsValidation ? 'border-yellow-100' : 'border-blue-100',
          text: needsValidation ? 'text-yellow-700' : 'text-blue-700',
          message: needsValidation ? '登录状态待检查' : '等待首次运行',
          action: needsValidation ? \`switchTab('platforms'); selectPlatformCredential('\${platform.id}')\` : '',
          actionLabel: '检查连接',
        };
      }

      if (Number(stat.errors || 0) > 0) {
        const failureType = stat.failureType || '';
        const needsLogin = failureType === 'auth_required';
        const needsCaptcha = failureType === 'captcha_required';
        const isPlatformChanged = failureType === 'platform_changed';
        return {
          dot: isPlatformChanged ? 'bg-yellow-500' : 'bg-red-500',
          bg: isPlatformChanged ? 'bg-yellow-50' : 'bg-red-50',
          border: isPlatformChanged ? 'border-yellow-100' : 'border-red-100',
          text: isPlatformChanged ? 'text-yellow-700' : 'text-red-700',
          message: stat.userMessage || (needsLogin ? '登录状态失效，需要重新登录' : '抓取失败，稍后会自动重试'),
          action: needsLogin || needsCaptcha ? loginRecoveryAction(platform.id, failureType) : '',
          actionLabel: needsLogin || needsCaptcha ? '去处理' : (stat.actionLabel || '处理'),
        };
      }

      if (Number(stat.itemsCollected || 0) === 0) {
        return {
          dot: 'bg-yellow-500',
          bg: 'bg-yellow-50',
          border: 'border-yellow-100',
          text: 'text-yellow-700',
          message: '本次未抓到内容',
        };
      }

      return {
        dot: 'bg-green-500',
        bg: 'bg-green-50',
        border: 'border-green-100',
        text: 'text-green-700',
        message: \`本次抓到 \${Number(stat.itemsCollected || 0)} 条\`,
      };
    }

    function loginRecoveryAction(platformId, failureType) {
      const mode = failureType === 'captcha_required' ? 'captcha' : 'reauth';
      return \`launchLogin('\${platformId}', { mode: '\${mode}', recoverSource: true })\`;
    }

    function platformRecoveryFailure(platformId, config = currentConfig) {
      const aggregation = Array.isArray(latestRunStats.aggregation) ? latestRunStats.aggregation : [];
      const stat = aggregation.find(item => item.source === platformId && Number(item.errors || 0) > 0);
      if (stat?.failureType === 'captcha_required' || stat?.failureType === 'auth_required') {
        return stat.failureType;
      }

      const check = credentialCheck(config, platformId);
      if (check?.status !== 'invalid') {
        return '';
      }

      return /captcha|验证码|滑块|风控|安全验证|verify/i.test(check.message || '')
        ? 'captcha_required'
        : 'auth_required';
    }

    function buildRunSummary(stats) {
      if (!stats || !Array.isArray(stats.aggregation)) {
        return '等待运行';
      }

      const collected = stats.aggregation.reduce((sum, item) => sum + Number(item.itemsCollected || 0), 0);
      const selected = stats.filtering?.selected ?? stats.result?.recommendations ?? 0;
      const drafts = stats.drafts?.drafts ?? 0;
      const failed = stats.aggregation.filter(item => Number(item.errors || 0) > 0).map(item => item.source);
      const base = \`抓到 \${collected} 条，筛选 \${selected} 条，草稿 \${drafts} 个\`;
      const notices = [
        failed.length ? \`失败：\${failed.join('、')}\` : '',
        stats.filtering?.userMessage,
        stats.drafts?.userMessage,
        stats.push?.userMessage,
      ].filter(Boolean);
      return notices.length ? \`\${base}；\${notices.join('；')}\` : base;
    }

    function notifyRecoverableFailures() {
      const aggregation = Array.isArray(latestRunStats.aggregation) ? latestRunStats.aggregation : [];
      const userActionFailures = aggregation.filter(item => item.failureType === 'auth_required' || item.failureType === 'captcha_required');
      if (!userActionFailures.length) return;
      const key = userActionFailures.map(item => \`\${item.source}:\${item.userMessage}\`).join('|');
      if (key === lastRecoveryNoticeKey) return;
      lastRecoveryNoticeKey = key;
      showToast(\`\${userActionFailures.map(item => item.source).join('、')} 需要处理登录或验证\`, 'error');
    }

    // Update platform status
    function updatePlatformStatus(config) {
      const container = document.getElementById('platformsList');
      if (!container) return;

      const html = platforms.map(platform => {
        const isEnabled = config.sources[platform.id]?.enabled || false;
        const hasAuth = platform.needsAuth === 'cookie'
          ? Boolean(config.credentialStatus?.[\`\${platform.id}Cookie\`])
          : true;
        const isSelected = selectedPlatformId === platform.id;

        const statusBadge = platformStatusBadge(platform, isEnabled, hasAuth, credentialCheck(config, platform.id));

        const toggleClass = isEnabled ? 'bg-blue-600' : 'bg-gray-200';
        const toggleSpanClass = isEnabled ? 'translate-x-6' : 'translate-x-1';
        const selectedClass = isSelected ? 'border-blue-500 ring-2 ring-blue-100 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300';

        return \`
          <div class="border \${selectedClass} rounded-lg p-3 transition">
            <div class="flex items-start justify-between gap-3">
              <div class="flex items-center min-w-0">
                <div class="w-9 h-9 \${platform.color} rounded-md flex items-center justify-center text-white font-bold text-xs shrink-0">
                  \${platform.icon}
                </div>
                <div class="ml-3 min-w-0">
                  <h3 class="font-semibold text-gray-900 truncate">\${platform.name}</h3>
                  <p class="text-xs text-gray-500 truncate">\${platform.description}</p>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button
                  onclick="togglePlatform('\${platform.id}')"
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition \${toggleClass}"
                  data-platform="\${platform.id}"
                  data-enabled="\${isEnabled}"
                >
                  <span class="inline-block h-4 w-4 transform rounded-full bg-white transition \${toggleSpanClass}"></span>
                </button>
              </div>
            </div>
            <div class="mt-3 flex items-center justify-between gap-2">
              \${statusBadge}
              \${platform.needsAuth === 'cookie' ? \`
                <button onclick="selectPlatformCredential('\${platform.id}')" class="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 bg-white hover:bg-gray-50 text-gray-700">
                  \${hasAuth ? '更新登录' : '配置登录'}
                </button>
              \` : '<span class="text-xs text-gray-400">无需登录</span>'}
            </div>
          </div>
        \`;
      }).join('');

      container.innerHTML = html;
      renderPlatformCredentialPanel(config);
    }

    function credentialCheck(config, platformId) {
      return config.credentialChecks?.[platformId] || null;
    }

    function renderAiCredentialStatus(kind, config) {
      const elementId = kind === 'embedding' ? 'configEmbeddingStatus' : 'configDeepseekStatus';
      const label = kind === 'embedding' ? '内容智能筛选' : 'AI 自动写草稿';
      const hasKey = kind === 'embedding'
        ? Boolean(config.credentialStatus?.embeddingApiKey)
        : Boolean(config.credentialStatus?.deepseekApiKey);
      const check = credentialCheck(config, kind);
      const element = document.getElementById(elementId);
      if (!element) return;

      if (!hasKey) {
        element.textContent = check?.status === 'invalid' ? check.message : \`\${label}密钥未配置\`;
        element.className = 'mt-1 text-xs text-gray-500';
      } else if (check?.status === 'valid') {
        element.textContent = check.message || \`\${label}密钥可用\`;
        element.className = 'mt-1 text-xs text-green-700';
      } else if (check?.status === 'invalid') {
        element.textContent = check.message || \`\${label}密钥不可用\`;
        element.className = 'mt-1 text-xs text-red-700';
      } else {
        element.textContent = check?.message || \`\${label}密钥已保存，建议验证一次\`;
        element.className = 'mt-1 text-xs text-yellow-700';
      }
    }

    function platformStatusBadge(platform, isEnabled, hasAuth, check) {
      if (!isEnabled) {
        return '<span class="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded">未启用</span>';
      }

      if (platform.needsAuth === 'cookie' && !hasAuth) {
        return '<span class="px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 rounded">需登录</span>';
      }

      if (platform.needsAuth === 'cookie') {
        if (check?.status === 'valid') {
          return \`<span class="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded">\${usesStrictProbe(platform) ? '连接正常' : '可用'}</span>\`;
        }
        if (check?.status === 'invalid') {
          return '<span class="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 rounded">登录失效</span>';
        }
        if (check?.status === 'checking') {
          return '<span class="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 rounded">验证中</span>';
        }
        return '<span class="px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 rounded">待检查</span>';
      }

      return '<span class="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded">可用</span>';
    }

    function usesStrictProbe(platform) {
      return platform.id === 'douyin' || platform.id === 'xiaohongshu';
    }

    function strictProbeBadge(platform, hasAuth, check) {
      if (!usesStrictProbe(platform) || !hasAuth) return '';
      if (check?.status === 'valid') {
        return '<div class="mt-1 text-[11px] text-green-700">连接检查：通过</div>';
      }
      if (check?.status === 'invalid') {
        return '<div class="mt-1 text-[11px] text-red-700">连接检查：登录失效</div>';
      }
      return '<div class="mt-1 text-[11px] text-yellow-700">连接检查：等待检查</div>';
    }

    function selectPlatformCredential(platformId) {
      selectedPlatformId = platformId;
      updatePlatformStatus(currentConfig);
    }

    function renderPlatformCredentialPanel(config) {
      const panel = document.getElementById('platformCredentialPanel');
      const platform = platforms.find(item => item.id === selectedPlatformId);
      if (!panel || !platform || platform.needsAuth !== 'cookie') {
        panel?.classList.add('hidden');
        return;
      }

      const hasAuth = Boolean(config.credentialStatus?.[\`\${platform.id}Cookie\`]);
      const checkMeta = credentialCheckMeta(platform, hasAuth, credentialCheck(config, platform.id));
      const recoveryFailure = platformRecoveryFailure(platform.id, config);
      const loginAction = recoveryFailure
        ? loginRecoveryAction(platform.id, recoveryFailure)
        : \`launchLogin('\${platform.id}')\`;
      const loginLabel = recoveryFailure === 'captcha_required'
        ? '处理验证码'
        : recoveryFailure === 'auth_required' ? '重新登录' : '在浏览器中登录';
      panel.classList.remove('hidden');
      panel.innerHTML = \`
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center">
            <div class="w-8 h-8 \${platform.color} rounded-md flex items-center justify-center text-white font-bold text-xs">\${platform.icon}</div>
            <div class="ml-3">
              <h3 class="font-semibold text-gray-900">\${platform.name} 连接</h3>
              <p class="text-xs text-gray-500">会在你的电脑上打开登录窗口，正常登录即可；登录状态只保存在本机。</p>
              \${usesStrictProbe(platform) ? '<p class="mt-1 text-xs text-blue-700">检查连接会访问真实搜索接口，确认登录状态是否还能抓取内容。</p>' : ''}
            </div>
          </div>
          <span class="px-2 py-1 text-xs font-medium rounded \${checkMeta.className}">\${checkMeta.label}</span>
        </div>
        <div class="mb-3 text-xs \${checkMeta.textClass}">\${checkMeta.message}</div>
        <div class="space-y-3">
          <div class="flex flex-col gap-2 sm:flex-row">
            <button onclick="\${loginAction}" class="bg-blue-600 text-white px-4 py-2 text-sm rounded-md hover:bg-blue-700 transition">
              \${loginLabel}
            </button>
            <button onclick="validatePlatformCredential('\${platform.id}')" class="bg-emerald-600 text-white px-4 py-2 text-sm rounded-md hover:bg-emerald-700 transition \${hasAuth ? '' : 'opacity-50 cursor-not-allowed'}" \${hasAuth ? '' : 'disabled'}>
              检查连接
            </button>
          </div>
          <details class="rounded-md border border-gray-200 bg-white p-3">
            <summary class="text-xs font-medium text-gray-600">手动粘贴 Cookie（高级）</summary>
            <div class="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-[1fr_auto]">
              <input
                id="\${platform.id}Cookie"
                type="text"
                placeholder="粘贴 \${platform.name} Cookie"
                class="px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
              <button onclick="saveCookie('\${platform.id}')" class="bg-gray-600 text-white px-4 py-2 text-sm rounded-md hover:bg-gray-700 transition">
                保存 Cookie
              </button>
            </div>
          </details>
        </div>
      \`;
    }

    function credentialCheckMeta(platform, hasAuth, check) {
      if (!hasAuth) {
        return {
          label: '未连接',
          message: '还没有连接，请先在浏览器中登录。',
          className: 'bg-yellow-100 text-yellow-800',
          textClass: 'text-yellow-700',
        };
      }

      if (check?.status === 'valid') {
        return {
          label: usesStrictProbe(platform) ? '连接正常' : '可用',
          message: check.message || '登录状态已确认可用。',
          className: 'bg-green-100 text-green-800',
          textClass: 'text-green-700',
        };
      }

      if (check?.status === 'invalid') {
        return {
          label: '登录失效',
          message: check.message || 'Cookie 已失效，需要重新登录。',
          className: 'bg-red-100 text-red-800',
          textClass: 'text-red-700',
        };
      }

      if (check?.status === 'checking') {
        return {
          label: '验证中',
          message: '正在检查登录状态是否可用。',
          className: 'bg-blue-100 text-blue-800',
          textClass: 'text-blue-700',
        };
      }

      return {
        label: '未验证',
        message: check?.message || '已保存登录状态，建议检查一次。',
        className: 'bg-yellow-100 text-yellow-800',
        textClass: 'text-yellow-700',
      };
    }

    // Toggle platform enabled/disabled
    function togglePlatform(platformId) {
      const button = document.querySelector(\`button[data-platform="\${platformId}"]\`);
      const currentState = button.getAttribute('data-enabled') === 'true';
      const newState = !currentState;

      // Update UI immediately
      button.setAttribute('data-enabled', newState);
      button.className = \`relative inline-flex h-6 w-11 items-center rounded-full transition \${newState ? 'bg-blue-600' : 'bg-gray-200'}\`;
      button.querySelector('span').className = \`inline-block h-4 w-4 transform rounded-full bg-white transition \${newState ? 'translate-x-6' : 'translate-x-1'}\`;

      // Update config
      if (!currentConfig.sources[platformId]) {
        currentConfig.sources[platformId] = {};
      }
      currentConfig.sources[platformId].enabled = newState;
      updatePlatformStatus(currentConfig);
    }

    // Save platform configuration
    async function savePlatformConfig() {
      setActionBusy('save-platforms', true, '保存中...');
      try {
        const id = currentUserId;
        const data = await request(\`/api/users/\${encodeURIComponent(id)}\`, {
          method: 'PUT',
          body: JSON.stringify(currentConfig)
        });
        currentConfig = data;
        document.getElementById('config').value = JSON.stringify(data, null, 2);
        await loadUsers();
        updateOverview(data);
        showToast('平台配置保存成功');
      } catch (error) {
        console.error('Failed to save platform config:', error);
      } finally {
        setActionBusy('save-platforms', false);
      }
    }

    // Save user config
    // Toggle advanced config mode
    function toggleAdvancedConfig() {
      const container = document.getElementById('advancedConfigContainer');
      const isHidden = container.classList.contains('hidden');

      if (isHidden) {
        container.classList.remove('hidden');
        // Sync current config to JSON editor
        if (currentConfig) {
          document.getElementById('config').value = JSON.stringify(currentConfig, null, 2);
        }
      } else {
        container.classList.add('hidden');
      }
    }

    // Load config into form fields
    function loadConfigIntoForm(config) {
      // Basic info
      document.getElementById('configUserId').value = config.userId || '';
      document.getElementById('configAccountHandle').value = config.accountHandle || '';
      document.getElementById('configProfilePath').value = config.profilePath || '';

      // AI
      document.getElementById('configEmbeddingBaseUrl').value = config.ai?.embedding?.baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      document.getElementById('configEmbeddingModel').value = config.ai?.embedding?.model || 'text-embedding-v4';
      document.getElementById('configDeepseekBaseUrl').value = config.ai?.deepseek?.baseURL || 'https://api.deepseek.com';
      const embeddingApiKeyInput = document.getElementById('configEmbeddingApiKey');
      embeddingApiKeyInput.value = '';
      embeddingApiKeyInput.placeholder = config.credentialStatus?.embeddingApiKey
        ? '已配置，留空保持不变'
        : '粘贴内容智能筛选密钥（阿里云百炼）';
      renderAiCredentialStatus('embedding', config);
      const deepseekApiKeyInput = document.getElementById('configDeepseekApiKey');
      deepseekApiKeyInput.value = '';
      deepseekApiKeyInput.placeholder = config.credentialStatus?.deepseekApiKey
        ? '已配置，留空保持不变'
        : '粘贴 AI 自动写草稿密钥（DeepSeek）';
      renderAiCredentialStatus('deepseek', config);

      // Sources
      document.getElementById('configZhihuKeywords').value = (config.sources?.zhihu?.keywords || []).join(', ');
      document.getElementById('configDouyinKeywords').value = (config.sources?.douyin?.keywords || []).join(', ');
      document.getElementById('configXiaohongshuKeywords').value = (config.sources?.xiaohongshu?.keywords || []).join(', ');
      document.getElementById('configWeiboKeywords').value = (config.sources?.weibo?.keywords || []).join(', ');
      document.getElementById('configRedditSubreddits').value = (config.sources?.reddit?.subreddits || []).join(', ');

      // Schedule
      const cronSchedule = config.schedule?.cronSchedule || '0 9 * * *';
      const scheduleSelect = document.getElementById('configSchedule');
      const standardOptions = ['0 9 * * *', '0 12 * * *', '0 18 * * *', '0 9,18 * * *', '0 */6 * * *', '0 */3 * * *'];

      if (standardOptions.includes(cronSchedule)) {
        scheduleSelect.value = cronSchedule;
        document.getElementById('customCronContainer').classList.add('hidden');
      } else {
        scheduleSelect.value = 'custom';
        document.getElementById('customCronContainer').classList.remove('hidden');
        document.getElementById('configCustomCron').value = cronSchedule;
      }

      document.getElementById('configTimezone').value = config.schedule?.timezone || 'Asia/Shanghai';

      // Feishu
      document.getElementById('configFeishuAppId').value = config.lark?.appId || '';
      const appSecretInput = document.getElementById('configFeishuAppSecret');
      appSecretInput.value = '';
      appSecretInput.placeholder = config.credentialStatus?.larkAppSecret
        ? '已配置，留空保持不变'
        : '从飞书开放平台获取';
      document.getElementById('configFeishuBaseId').value = config.lark?.baseId || '';
      document.getElementById('configFeishuReceiverId').value = config.lark?.defaultReceiverId || '';

      // Also update JSON editor
      document.getElementById('config').value = JSON.stringify(config, null, 2);
    }

    // Save config from form
    async function saveUserFromForm() {
      setActionBusy('save-config', true, '保存中...');
      try {
        const id = currentUserId;

        // Get schedule value
        const scheduleSelect = document.getElementById('configSchedule').value;
        const cronSchedule = scheduleSelect === 'custom'
          ? document.getElementById('configCustomCron').value
          : scheduleSelect;

        const appSecret = document.getElementById('configFeishuAppSecret').value;
        const larkConfig = {
          appId: document.getElementById('configFeishuAppId').value,
          baseId: document.getElementById('configFeishuBaseId').value,
          defaultReceiverId: document.getElementById('configFeishuReceiverId').value
        };
        if (appSecret) {
          larkConfig.appSecret = appSecret;
        }
        const embeddingApiKey = document.getElementById('configEmbeddingApiKey').value;
        const deepseekApiKey = document.getElementById('configDeepseekApiKey').value;
        const aiConfig = {
          embedding: {
            ...currentConfig.ai?.embedding,
            baseURL: document.getElementById('configEmbeddingBaseUrl').value,
            model: document.getElementById('configEmbeddingModel').value
          },
          deepseek: {
            ...currentConfig.ai?.deepseek,
            baseURL: document.getElementById('configDeepseekBaseUrl').value
          }
        };
        if (embeddingApiKey) {
          aiConfig.embedding.apiKey = embeddingApiKey;
        }
        if (deepseekApiKey) {
          aiConfig.deepseek.apiKey = deepseekApiKey;
        }
        const sourcesConfig = {
          ...currentConfig.sources,
          zhihu: {
            ...currentConfig.sources.zhihu,
            keywords: parseCommaList(document.getElementById('configZhihuKeywords').value)
          },
          douyin: {
            ...currentConfig.sources.douyin,
            keywords: parseCommaList(document.getElementById('configDouyinKeywords').value)
          },
          xiaohongshu: {
            ...currentConfig.sources.xiaohongshu,
            keywords: parseCommaList(document.getElementById('configXiaohongshuKeywords').value)
          },
          weibo: {
            ...currentConfig.sources.weibo,
            keywords: parseCommaList(document.getElementById('configWeiboKeywords').value)
          },
          reddit: {
            ...currentConfig.sources.reddit,
            subreddits: parseCommaList(document.getElementById('configRedditSubreddits').value)
          }
        };

        // Build config object
        const payload = {
          ...currentConfig,
          userId: document.getElementById('configUserId').value,
          accountHandle: document.getElementById('configAccountHandle').value || document.getElementById('configUserId').value,
          profilePath: document.getElementById('configProfilePath').value,
          sources: sourcesConfig,
          schedule: {
            cronSchedule: cronSchedule,
            timezone: document.getElementById('configTimezone').value
          },
          lark: larkConfig,
          ai: aiConfig
        };

        // Save profile data separately if provided
        const interests = document.getElementById('configInterests').value;
        const style = document.getElementById('configStyle').value;
        const audience = document.getElementById('configAudience').value;
        const samplePosts = document.getElementById('configSamplePosts').value;

        if (interests || style || audience || samplePosts) {
          const profilePayload = {};
          if (interests) profilePayload.interests = interests.split(',').map(s => s.trim()).filter(Boolean);
          if (style) profilePayload.style = style;
          if (audience) profilePayload.audience = audience;
          if (samplePosts) profilePayload.samplePosts = samplePosts.split('\\n').filter(s => s.trim());

          await request(\`/api/users/\${encodeURIComponent(id)}/profile\`, {
            method: 'PUT',
            body: JSON.stringify(profilePayload)
          });
          currentProfile = profilePayload;
        }

        const data = await request(\`/api/users/\${encodeURIComponent(id)}\`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });

        currentConfig = data;
        await loadUsers();
        updateOverview(data);
        showToast('配置保存成功');
      } catch (error) {
        console.error('Failed to save user:', error);
        showToast('保存失败: ' + error.message, 'error');
      } finally {
        setActionBusy('save-config', false);
      }
    }

    async function saveUser() {
      try {
        const id = currentUserId;
        const payload = JSON.parse(document.getElementById('config').value);
        const data = await request(\`/api/users/\${encodeURIComponent(id)}\`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        currentConfig = data;
        document.getElementById('config').value = JSON.stringify(data, null, 2);
        await loadUsers();
        updateOverview(data);
        showToast('配置保存成功');
      } catch (error) {
        console.error('Failed to save user:', error);
      }
    }

    // Save cookie
    async function saveCookie(platform) {
      try {
        const id = currentUserId;
        const input = \`\${platform}Cookie\`;
        const value = document.getElementById(input).value;

        if (!value) {
          showToast('请输入 Cookie', 'error');
          return;
        }

        const data = await request(\`/api/users/\${encodeURIComponent(id)}/credentials/\${platform}\`, {
          method: 'POST',
          body: JSON.stringify({value})
        });

        currentConfig = data;
        document.getElementById('config').value = JSON.stringify(data, null, 2);
        document.getElementById(input).value = '';
        await loadUsers();
        updateOverview(data);
        updatePlatformStatus(data);

        const platformNames = {
          'zhihu': '知乎',
          'douyin': '抖音',
          'xiaohongshu': '小红书',
          'weibo': '微博'
        };
        showToast(\`\${platformNames[platform] || platform} Cookie 已保存，请检查连接\`);
      } catch (error) {
        console.error('Failed to save cookie:', error);
      }
    }

    // Launch login window
    async function launchLogin(platform, options = {}) {
      const mode = options.mode || 'normal';
      try {
        const id = currentUserId;
        openLoginProgress(platform, mode);
        showToast('正在打开登录窗口，请在浏览器中完成登录...', 'success');

        const data = await request(\`/api/users/\${encodeURIComponent(id)}/login/\${platform}\`, {
          method: 'POST',
          body: JSON.stringify({ mode })
        });

        currentConfig = data;
        document.getElementById('config').value = JSON.stringify(data, null, 2);
        await loadUsers();
        updateOverview(data);
        updatePlatformStatus(data);

        const platformNames = {
          'zhihu': '知乎',
          'douyin': '抖音',
          'xiaohongshu': '小红书',
          'weibo': '微博'
        };
        if (options.recoverSource) {
          const validation = await validatePlatformCredential(platform, true);
          if (validation?.status !== 'valid') {
            showToast(validation?.message || \`\${platformNames[platform] || platform} 仍未通过检查\`, 'error');
            return false;
          }
          await runSources([platform]);
          showToast(\`\${platformNames[platform] || platform} 已恢复，正在补抓\`);
          return true;
        }

        showToast(\`\${platformNames[platform] || platform} 登录成功，请检查连接\`);
        return true;
      } catch (error) {
        console.error('Failed to launch login:', error);
        showToast('登录失败: ' + error.message, 'error');
        return false;
      } finally {
        closeLoginProgress();
      }
    }

    function openLoginProgress(platform, mode) {
      const modal = document.getElementById('loginProgressModal');
      const platformName = platforms.find(item => item.id === platform)?.name || platform;
      const action = mode === 'captcha' ? '完成验证码或滑块验证' : '完成登录或扫码';
      document.getElementById('loginProgressTitle').textContent = \`\${platformName}：请\${action}\`;
      document.getElementById('loginProgressMessage').textContent = mode === 'captcha'
        ? '已经为你打开验证页面。请在新窗口中完成验证码或滑块验证，窗口会在成功后自动关闭。'
        : '已经为你打开登录页面。请在新窗口中完成扫码、手机号或账号密码登录，窗口会在成功后自动关闭。';
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      const startedAt = Date.now();
      updateLoginCountdown(startedAt);
      clearInterval(loginCountdownTimer);
      loginCountdownTimer = setInterval(() => updateLoginCountdown(startedAt), 1000);
    }

    function updateLoginCountdown(startedAt) {
      const remaining = Math.max(0, 5 * 60 - Math.floor((Date.now() - startedAt) / 1000));
      const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
      const seconds = String(remaining % 60).padStart(2, '0');
      document.getElementById('loginProgressCountdown').textContent = \`\${minutes}:\${seconds}\`;
    }

    function closeLoginProgress() {
      clearInterval(loginCountdownTimer);
      loginCountdownTimer = null;
      const modal = document.getElementById('loginProgressModal');
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }

    async function validateAiCredential(kind, silent = false) {
      try {
        const id = currentUserId;
        currentConfig.credentialChecks ||= {};
        currentConfig.credentialChecks[kind] = {
          status: 'unknown',
          message: '正在验证密钥是否可用。',
          checkedAt: new Date().toISOString()
        };
        renderAiCredentialStatus(kind, currentConfig);

        const result = await request(\`/api/users/\${encodeURIComponent(id)}/credentials/\${kind}/validate\`, {
          method: 'POST'
        });

        currentConfig = result.config;
        document.getElementById('config').value = JSON.stringify(currentConfig, null, 2);
        loadConfigIntoForm(currentConfig);
        await loadUsers();

        const validation = result.validation || currentConfig.credentialChecks?.[kind];
        if (!silent) {
          if (validation?.status === 'valid') {
            showToast(validation.message || '密钥可用');
          } else {
            showToast(validation?.message || '密钥不可用', 'error');
          }
        }
      } catch (error) {
        console.error('Failed to validate AI credential:', error);
      }
    }

    async function clearCredential(kind) {
      try {
        const labels = {
          embedding: '内容智能筛选密钥',
          deepseek: 'AI 自动写草稿密钥'
        };
        if (!confirm(\`清空 \${labels[kind] || kind}？\`)) {
          return;
        }

        await request(\`/api/users/\${encodeURIComponent(currentUserId)}/credentials/\${kind}\`, {
          method: 'DELETE'
        });
        const data = await request(\`/api/users/\${encodeURIComponent(currentUserId)}\`);
        currentConfig = data;
        document.getElementById('config').value = JSON.stringify(data, null, 2);
        loadConfigIntoForm(data);
        await loadUsers();
        showToast('已清空');
      } catch (error) {
        console.error('Failed to clear credential:', error);
      }
    }

    async function validatePlatformCredential(platform, silent = false) {
      try {
        const id = currentUserId;
        currentConfig.credentialChecks ||= {};
        currentConfig.credentialChecks[platform] = {
          status: 'checking',
          message: '正在检查登录状态是否可用。',
          checkedAt: new Date().toISOString()
        };
        updatePlatformStatus(currentConfig);
        updateOverview(currentConfig);

        const result = await request(\`/api/users/\${encodeURIComponent(id)}/credentials/\${platform}/validate\`, {
          method: 'POST'
        });

        currentConfig = result.config;
        document.getElementById('config').value = JSON.stringify(currentConfig, null, 2);
        await loadUsers();
        updateOverview(currentConfig);
        updatePlatformStatus(currentConfig);

        const validation = result.validation || currentConfig.credentialChecks?.[platform];
        if (!silent) {
          if (validation?.status === 'valid') {
            showToast(validation.message || '登录状态可用');
          } else if (validation?.status === 'invalid') {
            showToast(validation.message || '登录状态失效', 'error');
          } else {
            showToast(validation?.message || '登录状态未检查', 'error');
          }
        }
        return validation;
      } catch (error) {
        console.error('Failed to validate credential:', error);
        return null;
      }
    }

    async function diagnoseSystem() {
      if (!currentConfig || !currentUserId) return;
      setActionBusy('diagnose', true, '诊断中...');
      setRuntimeStatus('warning', '诊断中');
      try {
        showToast('开始诊断，请稍等');
        await loadEnvironmentDiagnostics();
        const cookiePlatforms = platforms.filter(platform =>
          platform.needsAuth === 'cookie' &&
          currentConfig.sources?.[platform.id]?.enabled &&
          currentConfig.credentialStatus?.[\`\${platform.id}Cookie\`]
        );
        for (const platform of cookiePlatforms) {
          await validatePlatformCredential(platform.id, true);
        }
        if (currentConfig.credentialStatus?.embeddingApiKey) {
          await validateAiCredential('embedding', true);
        }
        if (currentConfig.credentialStatus?.deepseekApiKey) {
          await validateAiCredential('deepseek', true);
        }
        showToast('诊断完成');
      } finally {
        setActionBusy('diagnose', false);
        setRuntimeStatus('idle', '空闲');
      }
    }

    // Run user
    async function runUser(options = {}) {
      setActionBusy('run', true, '提交中...');
      setRuntimeStatus('running', '运行中');
      try {
        if (!options.autoRetry) {
          autoRecoveryAttempts = 0;
        }
        const id = currentUserId;
        document.getElementById('status').textContent = '正在运行...';
        const previousRuns = await request(\`/api/runs?userId=\${encodeURIComponent(id)}&limit=1\`);
        latestRunId = previousRuns[0]?.id ?? latestRunId;
        const result = await request(\`/api/users/\${encodeURIComponent(id)}/run\`, {method: 'POST'});
        watchedRunPreviousId = latestRunId;
        watchedRunDeadline = Date.now() + 15 * 60 * 1000;
        document.getElementById('status').textContent = JSON.stringify(result, null, 2);
        showToast(options.autoRetry ? '已重新提交抓取任务' : '任务已提交');
        if (!options.keepTab) {
          switchTab('recommendations');
        }
        setTimeout(loadRecommendations, 500);
      } catch (error) {
        console.error('Failed to run user:', error);
        setRuntimeStatus('error', '提交失败');
      } finally {
        setActionBusy('run', false);
      }
    }

    async function runSources(sources) {
      try {
        const uniqueSources = [...new Set(sources)].filter(Boolean);
        if (uniqueSources.length === 0) return;
        const id = currentUserId;
        document.getElementById('status').textContent = '正在补抓失败平台...';
        const previousRuns = await request(\`/api/runs?userId=\${encodeURIComponent(id)}&limit=1\`);
        latestRunId = previousRuns[0]?.id ?? latestRunId;
        const result = await request(\`/api/users/\${encodeURIComponent(id)}/run/sources\`, {
          method: 'POST',
          body: JSON.stringify({ sources: uniqueSources })
        });
        watchedRunPreviousId = latestRunId;
        watchedRunDeadline = Date.now() + 15 * 60 * 1000;
        document.getElementById('status').textContent = JSON.stringify(result, null, 2);
        showToast(\`已提交补抓任务：\${uniqueSources.join('、')}\`);
        setTimeout(loadRecommendations, 500);
      } catch (error) {
        console.error('Failed to recover sources:', error);
      }
    }

    // Test push
    async function testPush() {
      setActionBusy('test-push', true, '测试中...');
      try {
        const id = currentUserId;
        document.getElementById('status').textContent = '正在测试...';
        const result = await request(\`/api/users/\${encodeURIComponent(id)}/test-push\`, {method: 'POST'});
        document.getElementById('status').textContent = JSON.stringify(result, null, 2);
        showToast('测试推送已发送');
      } catch (error) {
        console.error('Failed to test push:', error);
      } finally {
        setActionBusy('test-push', false);
      }
    }

    // Load logs
    async function loadLogs() {
      try {
        const runs = await request(\`/api/runs?userId=\${encodeURIComponent(currentUserId)}&limit=20\`);
        const filter = document.getElementById('logStatusFilter')?.value || '';
        const visibleRuns = filter ? runs.filter(run => run.status === filter) : runs;
        document.getElementById('logs').innerHTML = renderRuns(visibleRuns);
        updateRuntimeStatusFromRun(runs[0]);
        if (runs.length) {
          latestRunStats = parseStats(runs[0].stats_json);
          if (currentConfig) {
            updateOverview(currentConfig);
          }
        }
        if (logsRefreshTimer) {
          clearTimeout(logsRefreshTimer);
          logsRefreshTimer = null;
        }
        const logsVisible = !document.getElementById('content-logs').classList.contains('hidden');
        if (logsVisible && runs.some(run => run.status === 'running')) {
          logsRefreshTimer = setTimeout(loadLogs, 3000);
        }
        if (document.getElementById('logAutoScroll')?.checked) {
          const container = document.getElementById('logsContainer');
          container.scrollTop = 0;
        }
      } catch (error) {
        console.error('Failed to load logs:', error);
      }
    }

    async function loadRecommendations() {
      try {
        const [items, runs] = await Promise.all([
          request(\`/api/users/\${encodeURIComponent(currentUserId)}/recommendations?limit=30\`),
          request(\`/api/runs?userId=\${encodeURIComponent(currentUserId)}&limit=1\`)
        ]);
        const latestRun = runs[0];
        const waitingForSubmittedRun = Date.now() < watchedRunDeadline &&
          (!latestRun || String(latestRun.id) === String(watchedRunPreviousId));
        const submittedRunCompleted = Date.now() < watchedRunDeadline &&
          latestRun &&
          String(latestRun.id) !== String(watchedRunPreviousId) &&
          latestRun.status !== 'running';
        latestRunId = latestRun?.id ?? latestRunId;
        latestRunStats = parseStats(latestRun?.stats_json);
        updateRuntimeStatusFromRun(latestRun);
        renderRunProgress(latestRun);
        document.getElementById('recommendationsList').innerHTML = renderRecommendations(items, latestRun);
        if (currentConfig) {
          updateContentSourceFilter(currentConfig);
          updateOverview(currentConfig);
        }

        if (submittedRunCompleted) {
          watchedRunDeadline = 0;
          await handleAutoRecovery(latestRun);
        }

        if (recommendationsRefreshTimer) {
          clearTimeout(recommendationsRefreshTimer);
          recommendationsRefreshTimer = null;
        }
        const visible = !document.getElementById('content-recommendations').classList.contains('hidden');
        if (visible && (waitingForSubmittedRun || latestRun?.status === 'running')) {
          recommendationsRefreshTimer = setTimeout(loadRecommendations, 3000);
        }
      } catch (error) {
        console.error('Failed to load recommendations:', error);
      }
    }

    async function loadRawContent() {
      try {
        const sourceFilter = document.getElementById('contentSourceFilter')?.value || '';
        const items = await request(\`/api/users/\${encodeURIComponent(currentUserId)}/content?limit=80\${sourceFilter ? '&source=' + encodeURIComponent(sourceFilter) : ''}\`);
        document.getElementById('rawContentList').innerHTML = renderRawContent(items);
      } catch (error) {
        console.error('Failed to load raw content:', error);
      }
    }

    async function handleAutoRecovery(latestRun) {
      if (!latestRun || latestRun.status === 'running' || autoRecoveryRunning) return;
      if (autoRecoveryRunIds.has(latestRun.id)) return;
      if (autoRecoveryAttempts >= 2) return;

      const aggregation = Array.isArray(latestRunStats.aggregation) ? latestRunStats.aggregation : [];
      const failures = aggregation.filter(item =>
        Number(item.errors || 0) > 0 &&
        (item.failureType === 'auth_required' || item.failureType === 'captcha_required')
      );
      if (failures.length === 0) return;

      autoRecoveryRunIds.add(latestRun.id);
      autoRecoveryRunning = true;
      autoRecoveryAttempts += 1;
      try {
        const recoveredSources = [];
        for (const failure of failures) {
          const platform = platforms.find(item => item.id === failure.source);
          if (!platform || platform.needsAuth !== 'cookie') continue;
          const needsCaptcha = failure.failureType === 'captcha_required';
          showToast(\`\${platform.name} \${needsCaptcha ? '需要完成验证' : '需要重新登录'}，处理后会自动重跑\`, 'error');
          const loggedIn = await launchLogin(platform.id, { mode: needsCaptcha ? 'captcha' : 'reauth' });
          if (!loggedIn) continue;
          const validation = await validatePlatformCredential(platform.id, true);
          if (validation?.status !== 'valid') continue;
          recoveredSources.push(platform.id);
        }
        if (recoveredSources.length > 0) {
          await runSources(recoveredSources);
        }
      } finally {
        autoRecoveryRunning = false;
      }
    }

    function renderRunProgress(run) {
      const panel = document.getElementById('runProgressPanel');
      if (!run) {
        panel.innerHTML = \`
          <div class="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
            还没有运行记录。点击“立即运行”后，推荐内容会出现在下方。
          </div>
        \`;
        return;
      }

      const stats = parseStats(run.stats_json);
      const stages = Array.isArray(stats.stages) ? stats.stages : [];
      const phaseOrder = ['初始化', '抓取', '清洗合并', '画像', '筛选', '生成草稿', '保存结果', '推送'];
      const donePhases = new Set(stages
        .filter(stage => ['succeeded', 'skipped', 'failed'].includes(stage.status))
        .map(stage => stage.phase));
      const currentStage = stages[stages.length - 1];
      const percent = run.status === 'succeeded' || run.status === 'failed'
        ? 100
        : Math.max(8, Math.min(95, Math.round((donePhases.size / phaseOrder.length) * 100)));
      const color = run.status === 'failed'
        ? 'bg-red-600'
        : run.status === 'succeeded' ? 'bg-green-600' : 'bg-blue-600';
      const title = run.status === 'running'
        ? \`正在运行：\${escapeHtml(currentStage?.phase || '准备中')}\`
        : run.status === 'succeeded' ? '本次运行已完成' : '本次运行失败';
      const hint = run.status === 'running'
        ? '通常 1-5 分钟；登录平台较多时会更久。结果生成后会自动出现在下方。'
        : buildRunSummary(stats);

      panel.innerHTML = \`
        <div class="rounded-lg border border-gray-200 bg-white p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="font-semibold text-gray-900">\${title}</div>
              <div class="mt-1 text-sm text-gray-600">\${escapeHtml(hint)}</div>
            </div>
            <span class="px-2 py-1 text-xs font-medium rounded \${statusClass(run.status)}">\${statusLabel(run.status)}</span>
          </div>
          <div class="mt-4 h-2 rounded-full bg-gray-100 overflow-hidden">
            <div class="h-full \${color}" style="width: \${percent}%"></div>
          </div>
          \${stages.length ? \`
            <div class="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
              \${stages.slice(-4).map(stage => \`
                <div class="flex gap-2 text-xs text-gray-600">
                  <span class="mt-1 h-2 w-2 shrink-0 rounded-full \${stageDotClass(stage.status)}"></span>
                  <span><span class="font-medium text-gray-800">\${escapeHtml(stage.phase || '')}</span> · \${escapeHtml(stage.message || '')}</span>
                </div>
              \`).join('')}
            </div>
          \` : ''}
        </div>
      \`;
    }

    function renderRecommendations(items, latestRun) {
      if (!items.length) {
        const running = latestRun?.status === 'running';
        return \`
          <div class="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center">
            <div class="text-base font-semibold text-gray-900">\${running ? '正在生成推荐内容' : '暂无推荐内容'}</div>
            <p class="mt-2 text-sm text-gray-600">\${running ? '不用盯日志，完成后这里会自动刷新。' : '点击概览里的“立即运行”，跑完后这里会显示推荐卡片。'}</p>
          </div>
        \`;
      }

      return items.map(item => {
        const drafts = Array.isArray(item.drafts) ? item.drafts : [];
        const primaryDraft = drafts[0]?.content || '';
        return \`
          <article class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">\${sourceLabel(item.source)}</span>
                  <span class="rounded px-2 py-1 text-xs font-medium \${statusClass(item.status)}">\${recommendationStatusLabel(item.status)}</span>
                  <span class="text-xs text-gray-500">评分 \${formatScore(item.score)}</span>
                  <span class="text-xs text-gray-400">\${formatTime(item.recommendedAt)}</span>
                </div>
                <h3 class="mt-3 text-lg font-semibold text-gray-950">\${escapeHtml(item.title || '无标题')}</h3>
              </div>
              <div class="flex shrink-0 flex-wrap gap-2">
                <button onclick="setRecommendationStatus(\${Number(item.id)}, 'approved')" class="rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700">保留</button>
                <button onclick="setRecommendationStatus(\${Number(item.id)}, 'rejected')" class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">忽略</button>
              </div>
            </div>

            <p class="mt-3 text-sm leading-6 text-gray-700">\${escapeHtml(truncateText(item.content || '', 280))}</p>
            \${item.reason ? \`<div class="mt-3 rounded-md bg-blue-50 p-3 text-sm text-blue-900"><span class="font-medium">推荐理由：</span>\${escapeHtml(item.reason)}</div>\` : ''}

            <div class="mt-4">
              <div class="mb-2 text-sm font-semibold text-gray-900">草稿</div>
              \${drafts.length ? \`
                <div class="space-y-3">
                  \${drafts.map((draft, index) => \`
                    <div class="rounded-md border border-gray-200 bg-gray-50 p-3">
                      <div class="mb-2 flex items-center justify-between gap-2">
                        <span class="text-xs font-medium text-gray-600">\${draftStyleLabel(draft.style)} · \${Number(draft.length || draft.content?.length || 0)} 字</span>
                        <button onclick="copyDraftText(\${Number(item.id)}, \${index})" class="text-xs font-medium text-blue-700 hover:text-blue-900">复制</button>
                      </div>
                      <div id="draft-\${Number(item.id)}-\${index}" class="whitespace-pre-wrap text-sm leading-6 text-gray-800">\${escapeHtml(draft.content || '')}</div>
                    </div>
                  \`).join('')}
                </div>
              \` : \`
                <div class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  这条内容已保留，但没有生成草稿；接入 AI 自动写草稿后会生成短、中、长三个版本。
                </div>
              \`}
            </div>

            <div class="mt-4 flex flex-wrap gap-3 text-sm">
              \${item.url ? \`<a href="\${escapeHtml(item.url)}" target="_blank" rel="noreferrer" class="font-medium text-blue-700 hover:text-blue-900">查看原文</a>\` : ''}
              \${primaryDraft ? \`<button onclick="copyDraftText(\${Number(item.id)}, 0)" class="font-medium text-gray-700 hover:text-gray-950">复制首个草稿</button>\` : ''}
            </div>
          </article>
        \`;
      }).join('');
    }

    function renderRawContent(items) {
      if (!items.length) {
        return \`
          <div class="rounded-lg border border-gray-200 bg-gray-50 p-5 text-center text-sm text-gray-600">
            暂无已入库内容。检查连接只确认登录状态，不会保存内容；点击“立即运行”后这里会显示抓取结果。
          </div>
        \`;
      }

      return items.map(item => {
        const metrics = item.metrics || {};
        const metricText = [
          metrics.likes !== undefined ? \`赞 \${metrics.likes}\` : '',
          metrics.comments !== undefined ? \`评 \${metrics.comments}\` : '',
          metrics.shares !== undefined ? \`转 \${metrics.shares}\` : '',
        ].filter(Boolean).join(' · ');

        return \`
          <article class="rounded-lg border border-gray-200 bg-white p-4">
            <div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span class="rounded bg-gray-100 px-2 py-1 font-medium text-gray-700">\${sourceLabel(item.source)}</span>
                  \${item.author ? \`<span>\${escapeHtml(item.author)}</span>\` : ''}
                  \${metricText ? \`<span>\${escapeHtml(metricText)}</span>\` : ''}
                  <span>\${formatTime(item.collectedAt)}</span>
                </div>
                <h4 class="mt-2 text-sm font-semibold text-gray-950">\${escapeHtml(item.title || '无标题')}</h4>
                <p class="mt-2 text-sm leading-6 text-gray-700">\${escapeHtml(truncateText(item.content || '', 220))}</p>
              </div>
              \${item.url ? \`<a href="\${escapeHtml(item.url)}" target="_blank" rel="noreferrer" class="shrink-0 text-sm font-medium text-blue-700 hover:text-blue-900">原文</a>\` : ''}
            </div>
          </article>
        \`;
      }).join('');
    }

    async function setRecommendationStatus(id, status) {
      await request(\`/api/recommendations/\${encodeURIComponent(id)}/status\`, {
        method: 'POST',
        body: JSON.stringify({status})
      });
      showToast(status === 'approved' ? '已保留' : '已忽略');
      await loadRecommendations();
    }

    async function copyDraftText(id, index) {
      const element = document.getElementById(\`draft-\${id}-\${index}\`);
      const text = element?.textContent || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        showToast('草稿已复制');
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        showToast('草稿已复制');
      }
    }

    function renderRuns(runs) {
      if (!runs.length) {
        return '<div class="text-gray-500">暂无运行日志</div>';
      }

      return runs.map(run => {
        const stats = parseStats(run.stats_json);
        const stages = Array.isArray(stats.stages) ? stats.stages : [];
        const aggregation = Array.isArray(stats.aggregation) ? stats.aggregation : [];
        return \`
          <div class="bg-white border border-gray-200 rounded-lg p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="font-semibold text-gray-900">\${escapeHtml(run.job_type)} · \${statusLabel(run.status)}</div>
                <div class="text-xs text-gray-500 mt-1">\${formatTime(run.started_at)}\${run.finished_at ? ' - ' + formatTime(run.finished_at) : ''}</div>
              </div>
              <span class="px-2 py-1 text-xs font-medium rounded \${statusClass(run.status)}">\${statusLabel(run.status)}</span>
            </div>
            <div class="mt-2 text-sm text-gray-700">\${escapeHtml(run.message || '')}</div>
            \${run.error ? \`<div class="mt-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded p-2">\${escapeHtml(run.error)}</div>\` : ''}
            \${aggregation.length ? renderAggregation(aggregation) : ''}
            \${stages.length ? renderStages(stages) : '<div class="mt-3 text-xs text-gray-500">暂无阶段明细</div>'}
          </div>
        \`;
      }).join('');
    }

    function renderAggregation(aggregation) {
      return \`
        <div class="mt-3 overflow-x-auto">
          <table class="min-w-full text-xs">
            <thead>
	              <tr class="text-left text-gray-500 border-b border-gray-100">
	                <th class="py-1 pr-3">平台</th>
	                <th class="py-1 pr-3">抓取</th>
	                <th class="py-1 pr-3">入库</th>
	                <th class="py-1 pr-3">错误</th>
	                <th class="py-1 pr-3">原因</th>
	              </tr>
            </thead>
            <tbody>
              \${aggregation.map(item => \`
	                <tr class="border-b border-gray-50">
	                  <td class="py-1 pr-3 font-medium text-gray-800">\${escapeHtml(item.source || '')}</td>
	                  <td class="py-1 pr-3">\${Number(item.itemsCollected || 0)}</td>
	                  <td class="py-1 pr-3">\${Number(item.itemsSaved || 0)}</td>
	                  <td class="py-1 pr-3">\${Number(item.errors || 0)}</td>
	                  <td class="py-1 pr-3 text-gray-600">\${escapeHtml(item.userMessage || item.failureType || '')}</td>
	                </tr>
              \`).join('')}
            </tbody>
          </table>
        </div>
      \`;
    }

    function renderStages(stages) {
      return \`
        <div class="mt-3 space-y-2">
          \${stages.map(stage => \`
            <div class="flex gap-3">
              <span class="mt-1.5 h-2 w-2 rounded-full shrink-0 \${stageDotClass(stage.status)}"></span>
              <div class="min-w-0">
                <div class="text-sm">
                  <span class="font-medium text-gray-900">\${escapeHtml(stage.phase || '')}</span>
                  <span class="text-gray-700"> · \${escapeHtml(stage.message || '')}</span>
                </div>
                <div class="text-xs text-gray-500">\${formatTime(stage.at)}\${stage.data ? ' · ' + escapeHtml(formatStageData(stage.data)) : ''}</div>
              </div>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    function parseStats(value) {
      if (!value) return {};
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }

    function formatStageData(data) {
      return Object.entries(data)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => \`\${key}: \${Array.isArray(value) ? value.join(', ') : value}\`)
        .join('，');
    }

    function statusLabel(status) {
      return {
        running: '运行中',
        succeeded: '成功',
        failed: '失败',
        skipped: '跳过'
      }[status] || status;
    }

    function statusClass(status) {
      return {
        running: 'bg-blue-100 text-blue-800',
        succeeded: 'bg-green-100 text-green-800',
        failed: 'bg-red-100 text-red-800',
        pending: 'bg-blue-100 text-blue-800',
        approved: 'bg-green-100 text-green-800',
        rejected: 'bg-gray-100 text-gray-700',
        posted: 'bg-purple-100 text-purple-800'
      }[status] || 'bg-gray-100 text-gray-700';
    }

    function stageDotClass(status) {
      return {
        running: 'bg-blue-500',
        succeeded: 'bg-green-500',
        failed: 'bg-red-500',
        skipped: 'bg-gray-400'
      }[status] || 'bg-gray-400';
    }

    function recommendationStatusLabel(status) {
      return {
        pending: '待审核',
        approved: '已保留',
        rejected: '已忽略',
        posted: '已发布'
      }[status] || status || '待审核';
    }

    function sourceLabel(source) {
      const platform = platforms.find(item => item.id === source);
      return platform?.name || source || '未知来源';
    }

    function draftStyleLabel(style) {
      return {
        short: '短版',
        medium: '中版',
        long: '长版'
      }[style] || '草稿';
    }

    function formatScore(value) {
      const score = Number(value || 0);
      return Number.isFinite(score) ? score.toFixed(1) : '0.0';
    }

    function truncateText(value, maxLength) {
      const text = String(value || '').trim();
      return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
    }

    function formatTime(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', function() {
      // Handle schedule dropdown change
      document.getElementById('configSchedule').addEventListener('change', function(e) {
        const customContainer = document.getElementById('customCronContainer');
        if (e.target.value === 'custom') {
          customContainer.classList.remove('hidden');
        } else {
          customContainer.classList.add('hidden');
        }
      });

      // Load initial data
      document.getElementById('userId').value = initialUserId;
      loadUsers();
      loadUser().then(() => {
        if (initialTab) switchTab(initialTab);
      });
    });
  </script>
</body>
</html>`;
  }
}

function main(): void {
  ensureDirectories();
  const db = new DatabaseManager(config.dbPath);
  db.initialize();
  const repository = new RuntimeConfigRepository(db);
  if (process.env.CREDENTIAL_ENCRYPTION_KEY) {
    logger.info(`Encrypted credentials for ${repository.migrateCredentialsToActiveCodec()} runtime users`);
  }
  const queue = new RuntimeJobQueue(db);
  const port = Number(process.env.ADMIN_PORT || 8787);
  const host = process.env.ADMIN_HOST || '127.0.0.1';
  new AdminServer(db, repository, queue).start(port, host);
}

if (process.argv[1]?.endsWith('admin-server.ts') || process.argv[1]?.endsWith('admin-server.js')) {
  main();
}
