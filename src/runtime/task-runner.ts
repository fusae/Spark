import { ContentAggregator } from '../aggregator/index.js';
import { DatabaseManager } from '../db/index.js';
import { EmbeddingClient } from '../ai/embedding.js';
import { DeepSeekClient } from '../ai/deepseek.js';
import { CloudAiClient } from '../ai/cloud.js';
import type { ChatClient, EmbeddingProvider } from '../ai/types.js';
import { FeishuClient } from '../feishu/index.js';
import { FilterEngine } from '../filter/index.js';
import { DraftGenerator } from '../generator/index.js';
import { ProfileManager } from '../profile/index.js';
import { sourceNames, UserRuntimeConfig } from '../types/runtime-config.js';
import { logger } from '../utils/logger.js';
import { classifyFailure } from '../utils/failure.js';
import { CloudScraperRuleClient, ScraperRuleSet } from '../scrapers/rules.js';

export interface RuntimeTaskResult {
  aggregation: Array<{
    source: string;
    itemsCollected: number;
    itemsSaved: number;
    errors: number;
    failureType?: string;
    userMessage?: string;
    recoverable?: boolean;
    actionLabel?: string;
  }>;
  recommendations: number;
  pushed: number;
}

interface RuntimeTaskStage {
  at: string;
  phase: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  message: string;
  data?: Record<string, unknown>;
}

interface RuntimeTaskProgress {
  stages: RuntimeTaskStage[];
  aggregation: RuntimeTaskResult['aggregation'];
  filtering?: {
    selected: number;
    finalCount: number;
    minAiScore: number;
    degraded?: boolean;
    failureType?: string;
    userMessage?: string;
    actionLabel?: string;
  };
  drafts?: {
    contents: number;
    batches: number;
    validRecommendations: number;
    drafts: number;
    degraded?: boolean;
    failureType?: string;
    userMessage?: string;
    actionLabel?: string;
  };
  push?: {
    attempted: number;
    succeeded: number;
    failed: number;
    skipped?: boolean;
    failureType?: string;
    userMessage?: string;
    actionLabel?: string;
  };
  result?: RuntimeTaskResult;
}

export class RuntimeTaskRunner {
  constructor(private db: DatabaseManager) {}

  async runDaily(configForUser: UserRuntimeConfig): Promise<RuntimeTaskResult> {
    return this.runPipeline(configForUser, 'daily_run');
  }

  async runSourceRecovery(configForUser: UserRuntimeConfig, sources: string[]): Promise<RuntimeTaskResult> {
    const enabledSources = sourceNames.filter((source) =>
      sources.includes(source) && configForUser.sources[source].enabled
    );
    if (enabledSources.length === 0) {
      throw new Error('No enabled sources to recover');
    }

    return this.runPipeline(configForUser, 'source_recovery', enabledSources);
  }

  private async runPipeline(
    configForUser: UserRuntimeConfig,
    jobType: 'daily_run' | 'source_recovery',
    sources?: string[]
  ): Promise<RuntimeTaskResult> {
    const progress: RuntimeTaskProgress = {
      stages: [],
      aggregation: [],
    };
    const runLogId = this.db.insertRuntimeRunLog({
      user_id: configForUser.userId,
      job_type: jobType,
      status: 'running',
      message: jobType === 'source_recovery' ? '准备补抓失败平台' : '准备运行',
      stats_json: JSON.stringify(progress),
    });
    this.logStage(runLogId, progress, '准备', 'running', jobType === 'source_recovery'
      ? `准备补抓：${sources?.join('、')}`
      : '初始化运行环境');

    try {
      const result = await this.executeDaily(configForUser, runLogId, progress, sources);
      progress.result = result;
      const summary = this.buildSummary(progress, result);
      this.logStage(runLogId, progress, '完成', 'succeeded', summary, {
        recommendations: result.recommendations,
        pushed: result.pushed,
      });
      this.db.finishRuntimeRunLog(runLogId, 'succeeded', {
        message: summary,
        statsJson: JSON.stringify(progress),
      });
      return result;
    } catch (error) {
      this.logStage(runLogId, progress, '失败', 'failed', (error as Error).message);
      this.db.finishRuntimeRunLog(runLogId, 'failed', {
        message: '运行失败',
        statsJson: JSON.stringify(progress),
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async sendTestPush(configForUser: UserRuntimeConfig): Promise<void> {
    const runLogId = this.db.insertRuntimeRunLog({
      user_id: configForUser.userId,
      job_type: 'test_push',
      status: 'running',
      message: 'Test push started',
    });

    try {
      const feishuClient = this.createFeishuClient(configForUser);
      await feishuClient.initialize(configForUser.lark.defaultReceiverId, {
        listenForActions: false,
      });
      await feishuClient.sendText('Spark 测试推送成功');
      feishuClient.close();

      this.db.finishRuntimeRunLog(runLogId, 'succeeded', {
        message: 'Test push completed',
      });
    } catch (error) {
      this.db.finishRuntimeRunLog(runLogId, 'failed', {
        message: 'Test push failed',
        error: (error as Error).message,
      });
      throw error;
    }
  }

  private async executeDaily(
    configForUser: UserRuntimeConfig,
    runLogId: number,
    progress: RuntimeTaskProgress,
    sources?: string[]
  ): Promise<RuntimeTaskResult> {
    logger.info(`Runtime daily run started: ${configForUser.userId}`);

    this.logStage(runLogId, progress, '初始化', 'running', '创建模型、爬虫、筛选器和推送客户端');
    const aiConfig = this.resolveAiConfig(configForUser);
    const aiClients = this.createAiClients(aiConfig);
    const profileManager = new ProfileManager(
      this.db,
      aiConfig.embedding.apiKey,
      configForUser.accountHandle,
      aiConfig.deepseek.apiKey,
      aiConfig.deepseek.baseURL,
      aiConfig.embedding.baseURL,
      aiConfig.embedding.model,
      configForUser.profilePath,
      {
        embeddingClient: aiClients.embedding,
      }
    );
    const filterEngine = new FilterEngine(aiClients.embedding, aiClients.chat, this.db, configForUser.userId);
    const draftGenerator = new DraftGenerator(aiClients.chat, aiClients.modelName);

    const scraperRules = await this.loadScraperRules(configForUser, runLogId, progress);

    this.logStage(runLogId, progress, '抓取', 'running', sources ? '开始补抓失败平台' : '开始抓取所有已启用平台', {
      sources: sources || sourceNames.filter((source) => configForUser.sources[source].enabled),
    });
    const aggregator = new ContentAggregator(this.db, configForUser, (event) => {
      const stat = {
        source: event.stats.source,
        itemsCollected: event.stats.itemsCollected,
        itemsSaved: event.stats.itemsSaved,
        errors: event.stats.errors,
        failureType: event.stats.failureType,
        userMessage: event.stats.userMessage,
        recoverable: event.stats.recoverable,
        actionLabel: event.stats.actionLabel,
      };
      progress.aggregation = [
        ...progress.aggregation.filter((item) => item.source !== stat.source),
        stat,
      ];
      const message = event.stats.errors
        ? `${event.source} 抓取失败：${event.stats.userMessage || '已跳过该平台'}`
        : `${event.source} 抓取完成`;
      this.logStage(runLogId, progress, '抓取', event.stats.errors ? 'failed' : 'succeeded', message, {
        collected: event.stats.itemsCollected,
        duplicates: event.stats.itemsDeduped,
        saved: event.stats.itemsSaved,
        errors: event.stats.errors,
        durationMs: event.stats.duration,
        failureType: event.stats.failureType,
        userMessage: event.stats.userMessage,
        action: event.stats.actionLabel,
      });
    }, {
      localBrowserHeadless: sources ? false : undefined,
      scraperRules,
    });
    const aggregation = sources
      ? await aggregator.aggregateFrom(sources)
      : await aggregator.aggregateAll();
    progress.aggregation = this.formatAggregationStats(aggregation);
    const totalCollected = aggregation.reduce((sum, stat) => sum + stat.itemsCollected, 0);
    const totalDeduped = aggregation.reduce((sum, stat) => sum + stat.itemsDeduped, 0);
    const totalSaved = aggregation.reduce((sum, stat) => sum + stat.itemsSaved, 0);
    this.logStage(runLogId, progress, '清洗合并', 'succeeded', '平台内容已去重并入库', {
      collected: totalCollected,
      duplicates: totalDeduped,
      saved: totalSaved,
    });

    if (!sources && aggregation.length > 0 && aggregation.every((stat) => stat.errors > 0)) {
      this.logStage(runLogId, progress, '筛选', 'skipped', '所有平台抓取失败，跳过筛选');
      this.logStage(runLogId, progress, '生成草稿', 'skipped', '所有平台抓取失败，跳过草稿生成');
      this.logStage(runLogId, progress, '推送', 'skipped', '所有平台抓取失败，跳过推送');
      throw new Error('所有平台抓取失败');
    }

    if (sources && aggregation.every((stat) => stat.errors > 0)) {
      this.logStage(runLogId, progress, '筛选', 'skipped', '补抓失败，跳过筛选');
      this.logStage(runLogId, progress, '生成草稿', 'skipped', '补抓失败，跳过草稿生成');
      this.logStage(runLogId, progress, '推送', 'skipped', '补抓失败，跳过推送');
      throw new Error(`补抓失败：${aggregation.map((stat) => stat.source).join('、')}`);
    }

    if (sources && totalSaved === 0) {
      this.logStage(runLogId, progress, '筛选', 'skipped', '补抓没有新增内容，跳过筛选');
      this.logStage(runLogId, progress, '生成草稿', 'skipped', '补抓没有新增内容，跳过草稿生成');
      this.logStage(runLogId, progress, '推送', 'skipped', '补抓没有新增内容，跳过推送');
      return {
        aggregation: this.formatAggregationStats(aggregation),
        recommendations: 0,
        pushed: 0,
      };
    }

    this.logStage(runLogId, progress, '画像', 'running', '读取或初始化账号画像');
    let profile = await profileManager.getProfile();
    if (!profile) {
      profile = await profileManager.initializeProfile();
    }
    if (!profile.interestVector || profile.interestVector.length === 0) {
      if (this.canGenerateEmbeddings(aiConfig)) {
        this.logStage(runLogId, progress, '画像', 'running', '账号画像缺少向量，正在自动补齐');
        try {
          await profileManager.refreshVector();
          const refreshedProfile = await profileManager.getProfile();
          if (!refreshedProfile) {
            throw new Error('Profile does not exist after vector refresh');
          }
          profile = refreshedProfile;
        } catch (error) {
          logger.warn('Profile vector auto-refresh failed, continuing with degraded filtering', error as Error);
          this.logStage(runLogId, progress, '画像', 'skipped', '画像向量补齐失败，后续筛选会降级', {
            error: (error as Error).message,
          });
        }
      } else {
        this.logStage(runLogId, progress, '画像', 'skipped', '未配置内容筛选 API，跳过画像向量补齐');
      }
    }

    this.logStage(runLogId, progress, '筛选', 'running', '开始向量匹配和 AI 排序', {
      topK: 20,
      finalCount: 5,
      minAiScore: 7.0,
    });
    const filterResult = await filterEngine.filter(profile, {
      topK: 20,
      finalCount: 5,
      minAiScore: 7.0,
    });
    const embeddingFailure = filterResult.stats.embeddingFallback
      ? classifyFailure(new Error(filterResult.stats.embeddingFallbackReason || 'Embedding unavailable'), 'Embedding')
      : undefined;
    const aiRankFailure = filterResult.stats.aiFallback
      ? classifyFailure(new Error(filterResult.stats.aiFallbackReason || 'DeepSeek ranking unavailable'), 'DeepSeek')
      : undefined;
    const filteringMessages = [embeddingFailure?.userMessage, aiRankFailure?.userMessage].filter(Boolean);
    this.recordAiCredentialFailure(configForUser.userId, 'embedding', embeddingFailure);
    this.recordAiCredentialFailure(configForUser.userId, 'deepseek', aiRankFailure);
    progress.filtering = {
      selected: filterResult.contents.length,
      finalCount: 5,
      minAiScore: 7.0,
      degraded: Boolean(filterResult.stats.embeddingFallback || filterResult.stats.aiFallback),
      failureType: embeddingFailure?.failureType || aiRankFailure?.failureType,
      userMessage: filteringMessages.length ? filteringMessages.join('；') : undefined,
      actionLabel: embeddingFailure?.actionLabel || aiRankFailure?.actionLabel,
    };
    this.logStage(runLogId, progress, '筛选', progress.filtering.degraded ? 'skipped' : 'succeeded', progress.filtering.degraded
      ? `模型筛选降级，产出 ${filterResult.contents.length} 条候选`
      : `筛选出 ${filterResult.contents.length} 条推荐候选`, {
      selected: filterResult.contents.length,
      degraded: progress.filtering.degraded,
      failureType: progress.filtering.failureType,
      userMessage: progress.filtering.userMessage,
    });

    if (filterResult.contents.length === 0) {
      this.logStage(runLogId, progress, '生成草稿', 'skipped', '没有候选内容，跳过草稿生成');
      return {
        aggregation: this.formatAggregationStats(aggregation),
        recommendations: 0,
        pushed: 0,
      };
    }

    this.logStage(runLogId, progress, '生成草稿', 'running', `开始为 ${filterResult.contents.length} 条内容生成草稿`);
    const draftResults = await draftGenerator.generateBatch(filterResult.contents, profile);
    const contentById = new Map(
      filterResult.contents.map((content) => [content.contentId, content])
    );
    const recommendations = draftResults
      .map((draftResult) => {
        const content = contentById.get(draftResult.contentId);
        if (!content || draftResult.drafts.length === 0) {
          return null;
        }

        return {
          content,
          drafts: draftResult.drafts,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    if (recommendations.length === 0) {
      recommendations.push(...filterResult.contents.map((content) => ({
        content,
        drafts: [],
      })));
    }

    const draftFailure = draftResults.length === 0
      ? classifyFailure(draftGenerator.getLastError() || new Error('DeepSeek draft generation failed'), 'DeepSeek')
      : undefined;
    this.recordAiCredentialFailure(configForUser.userId, 'deepseek', draftFailure);
    progress.drafts = {
      contents: filterResult.contents.length,
      batches: draftResults.length,
      validRecommendations: recommendations.length,
      drafts: draftResults.reduce((sum, result) => sum + result.drafts.length, 0),
      degraded: draftResults.length === 0,
      failureType: draftFailure?.failureType,
      userMessage: draftFailure?.userMessage || (draftResults.length === 0 ? '草稿生成失败，已降级推送候选内容' : undefined),
      actionLabel: draftFailure?.actionLabel,
    };
    this.logStage(
      runLogId,
      progress,
      '生成草稿',
      progress.drafts.degraded ? 'skipped' : 'succeeded',
      progress.drafts.degraded
        ? `草稿生成失败，降级推送 ${recommendations.length} 条候选内容`
        : `生成 ${progress.drafts.drafts} 条草稿，形成 ${recommendations.length} 条推荐`,
      progress.drafts
    );

    const persistedRecommendations = recommendations.map((recommendation) => ({
      ...recommendation,
      recommendationId: this.db.insertRecommendation({
        user_id: configForUser.userId,
        content_id: recommendation.content.contentId,
        match_score: recommendation.content.aiScore || recommendation.content.embeddingSimilarity * 10,
        match_reason: recommendation.content.aiReason,
        drafts: JSON.stringify(recommendation.drafts),
        status: 'pending',
      }),
    }));
    this.logStage(runLogId, progress, '保存结果', 'succeeded', `已保存 ${persistedRecommendations.length} 条推荐，可在应用内查看`);

    if (!this.canPushToFeishu(configForUser)) {
      logger.warn(`Feishu config incomplete, skip push: ${configForUser.userId}`);
      progress.push = {
        attempted: persistedRecommendations.length,
        succeeded: 0,
        failed: 0,
        skipped: true,
      };
      this.logStage(runLogId, progress, '推送', 'skipped', '飞书配置不完整，跳过推送');
      return {
        aggregation: this.formatAggregationStats(aggregation),
        recommendations: persistedRecommendations.length,
        pushed: 0,
      };
    }

    this.logStage(runLogId, progress, '推送', 'running', `开始推送 ${persistedRecommendations.length} 条推荐到飞书`);
    let pushResults: Awaited<ReturnType<FeishuClient['pushRecommendations']>> = [];
    let pushError = '';
    let pushFailure: ReturnType<typeof classifyFailure> | undefined;
    const feishuClient = this.createFeishuClient(configForUser);
    try {
      await feishuClient.initialize(configForUser.lark.defaultReceiverId, {
        listenForActions: false,
      });
      pushResults = await feishuClient.pushRecommendations(persistedRecommendations);
    } catch (error) {
      pushError = (error as Error).message;
      pushFailure = classifyFailure(error, '飞书');
      logger.error('Feishu push failed, keeping run result available in admin logs', error as Error);
    } finally {
      feishuClient.close();
    }
    const pushed = pushResults.filter((result) => result.success).length;
    progress.push = {
      attempted: persistedRecommendations.length,
      succeeded: pushed,
      failed: pushError ? persistedRecommendations.length : pushResults.length - pushed,
      failureType: pushFailure?.failureType,
      userMessage: pushFailure?.userMessage,
      actionLabel: pushFailure?.actionLabel,
    };
    this.logStage(
      runLogId,
      progress,
      '推送',
      progress.push.failed > 0 ? 'failed' : 'succeeded',
      pushError ? `飞书推送失败：${pushError}` : `飞书推送成功 ${pushed}/${persistedRecommendations.length}`,
      progress.push
    );

    return {
      aggregation: this.formatAggregationStats(aggregation),
      recommendations: persistedRecommendations.length,
      pushed,
    };
  }

  private logStage(
    runLogId: number,
    progress: RuntimeTaskProgress,
    phase: string,
    status: RuntimeTaskStage['status'],
    message: string,
    data?: Record<string, unknown>
  ): void {
    progress.stages.push({
      at: new Date().toISOString(),
      phase,
      status,
      message,
      data,
    });
    this.db.updateRuntimeRunLog(runLogId, {
      message,
      statsJson: JSON.stringify(progress),
    });
  }

  private canPushToFeishu(configForUser: UserRuntimeConfig): boolean {
    return Boolean(
      configForUser.lark.appId &&
      configForUser.lark.appSecret &&
      configForUser.lark.defaultReceiverId
    );
  }

  private createFeishuClient(configForUser: UserRuntimeConfig): FeishuClient {
    return new FeishuClient(this.db, {
      appId: configForUser.lark.appId,
      appSecret: configForUser.lark.appSecret,
    });
  }

  private resolveAiConfig(configForUser: UserRuntimeConfig): UserRuntimeConfig['ai'] {
    return {
      mode: configForUser.ai.mode === 'cloud' ? 'cloud' : 'local',
      cloud: {
        baseURL: configForUser.ai.cloud?.baseURL || 'http://127.0.0.1:8787',
        token: configForUser.ai.cloud?.token || '',
        email: configForUser.ai.cloud?.email || '',
        expiresAt: configForUser.ai.cloud?.expiresAt || '',
      },
      embedding: {
        apiKey: configForUser.ai.embedding.apiKey,
        baseURL: configForUser.ai.embedding.baseURL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: configForUser.ai.embedding.model || 'text-embedding-v4',
      },
      deepseek: {
        apiKey: configForUser.ai.deepseek.apiKey,
        baseURL: configForUser.ai.deepseek.baseURL || 'https://api.deepseek.com',
      },
    };
  }

  private createAiClients(aiConfig: UserRuntimeConfig['ai']): {
    embedding: EmbeddingProvider;
    chat: ChatClient;
    modelName: string;
  } {
    if (aiConfig.mode === 'cloud' && aiConfig.cloud.token) {
      const cloud = new CloudAiClient({
        baseURL: aiConfig.cloud.baseURL,
        token: aiConfig.cloud.token,
      });
      return {
        embedding: cloud,
        chat: cloud,
        modelName: 'spark-cloud',
      };
    }

    if (aiConfig.mode === 'cloud' && !aiConfig.cloud.token) {
      logger.warn('Spark Cloud mode selected but token is missing, falling back to local AI config');
    }

    const embeddingClient = new EmbeddingClient(
      aiConfig.embedding.apiKey,
      aiConfig.embedding.baseURL,
      aiConfig.embedding.model
    );
    const deepseekClient = new DeepSeekClient(aiConfig.deepseek.apiKey, aiConfig.deepseek.baseURL);
    return {
      embedding: embeddingClient,
      chat: deepseekClient,
      modelName: 'deepseek-chat',
    };
  }

  private async loadScraperRules(
    configForUser: UserRuntimeConfig,
    runLogId: number,
    progress: RuntimeTaskProgress
  ): Promise<ScraperRuleSet> {
    const cloud = configForUser.ai.cloud;
    if (!cloud?.baseURL || !cloud?.token) {
      this.logStage(runLogId, progress, '规则同步', 'skipped', '未登录 Spark Cloud，使用客户端内置抓取规则');
      return {};
    }

    try {
      const client = new CloudScraperRuleClient({
        baseURL: cloud.baseURL,
        token: cloud.token,
      });
      const rules = await client.fetchRules();
      const platforms = Object.keys(rules);
      this.logStage(
        runLogId,
        progress,
        '规则同步',
        platforms.length > 0 ? 'succeeded' : 'skipped',
        platforms.length > 0 ? `已同步 ${platforms.length} 个平台抓取规则` : 'Cloud 暂无下发规则，使用内置规则',
        { platforms }
      );
      return rules;
    } catch (error) {
      logger.warn('Failed to load scraper rules from Spark Cloud, using built-in rules', error as Error);
      this.logStage(runLogId, progress, '规则同步', 'skipped', '规则同步失败，使用客户端内置抓取规则', {
        error: (error as Error).message,
      });
      return {};
    }
  }

  private canGenerateEmbeddings(aiConfig: UserRuntimeConfig['ai']): boolean {
    return aiConfig.mode === 'cloud'
      ? Boolean(aiConfig.cloud.token)
      : Boolean(aiConfig.embedding.apiKey);
  }

  private recordAiCredentialFailure(
    userId: string,
    platform: 'embedding' | 'deepseek',
    failure: ReturnType<typeof classifyFailure> | undefined
  ): void {
    if (!failure) {
      return;
    }

    if (failure.failureType !== 'api_unavailable' && failure.failureType !== 'api_quota') {
      return;
    }

    this.db.upsertRuntimeCredentialCheck({
      user_id: userId,
      platform,
      status: 'invalid',
      message: failure.userMessage,
    });
  }

  private formatAggregationStats(stats: Awaited<ReturnType<ContentAggregator['aggregateAll']>>): RuntimeTaskResult['aggregation'] {
    return stats.map((stat) => ({
      source: stat.source,
      itemsCollected: stat.itemsCollected,
      itemsSaved: stat.itemsSaved,
      errors: stat.errors,
      failureType: stat.failureType,
      userMessage: stat.userMessage,
      recoverable: stat.recoverable,
      actionLabel: stat.actionLabel,
    }));
  }

  private buildSummary(progress: RuntimeTaskProgress, result: RuntimeTaskResult): string {
    const collected = progress.aggregation.reduce((sum, item) => sum + item.itemsCollected, 0);
    const saved = progress.aggregation.reduce((sum, item) => sum + item.itemsSaved, 0);
    const failedSources = progress.aggregation
      .filter((item) => item.errors > 0)
      .map((item) => item.source);
    const drafts = progress.drafts?.drafts || 0;
    const base = `抓到 ${collected} 条，入库 ${saved} 条，筛选出 ${result.recommendations} 条，生成 ${drafts} 个草稿，推送成功 ${result.pushed} 条`;
    const notices = [
      failedSources.length > 0 ? `${failedSources.join('、')} 抓取失败` : '',
      progress.filtering?.userMessage,
      progress.drafts?.userMessage,
      progress.push?.userMessage,
    ].filter(Boolean);
    return notices.length > 0 ? `${base}；${notices.join('；')}` : base;
  }
}
