import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { ContentAggregator } from '../aggregator/index.js';
import { ProfileManager } from '../profile/index.js';
import { FilterEngine } from '../filter/index.js';
import { DraftGenerator } from '../generator/index.js';
import { FeishuClient } from '../feishu/index.js';
import { FeedbackLearner } from '../feedback/index.js';
import { DatabaseManager } from '../db/index.js';
import { logger } from '../utils/logger.js';

export class Scheduler {
  private tasks: ScheduledTask[] = [];

  constructor(
    private aggregator: ContentAggregator,
    private profileManager: ProfileManager,
    private filterEngine: FilterEngine,
    private draftGenerator: DraftGenerator,
    private feishuClient: FeishuClient,
    private feedbackLearner: FeedbackLearner,
    private db: DatabaseManager
  ) {}

  start(): void {
    logger.info('启动定时任务调度器');

    // 每日 9:00 执行主任务
    const dailyTask = cron.schedule('0 9 * * *', async () => {
      await this.runDailyTask();
    });
    this.tasks.push(dailyTask);
    logger.info('已注册每日任务: 每天 9:00');

    // 每周日凌晨 2:00 执行学习任务
    const weeklyTask = cron.schedule('0 2 * * 0', async () => {
      await this.runWeeklyLearning();
    });
    this.tasks.push(weeklyTask);
    logger.info('已注册每周学习任务: 每周日 2:00');

    // 每天凌晨 3:00 清理过期数据
    const cleanupTask = cron.schedule('0 3 * * *', async () => {
      await this.runCleanup();
    });
    this.tasks.push(cleanupTask);
    logger.info('已注册清理任务: 每天 3:00');

    logger.info(`定时任务调度器启动完成，共 ${this.tasks.length} 个任务`);
  }

  stop(): void {
    logger.info('停止定时任务调度器');
    this.tasks.forEach(task => task.stop());
    this.tasks = [];
  }

  async runDailyTask(): Promise<void> {
    const startTime = Date.now();
    logger.info('========== 开始每日任务 ==========');

    try {
      // 1. 内容聚合
      logger.info('Step 1/5: 内容聚合');
      await this.aggregator.aggregateAll();

      // 聚合完成后，从数据库获取最近的内容
      const dbContents = await this.db.getRecentContents(24); // 获取最近 24 小时的内容

      // 转换为 ContentItem 格式
      const contents = dbContents.map(item => ({
        source: item.source,
        title: item.title || '',
        content: item.content,
        url: item.url || '',
        author: item.author || undefined,
        publishedAt: new Date(item.published_at || Date.now()),
        metrics: item.metrics ? JSON.parse(item.metrics) : undefined,
        collectedAt: new Date(item.collected_at || Date.now()),
        id: item.id
      }));

      logger.info(`聚合完成: ${contents.length} 条内容`);

      if (contents.length === 0) {
        logger.warn('没有聚合到任何内容，跳过后续步骤');
        return;
      }

      // 2. 获取画像
      logger.info('Step 2/5: 加载账号画像');
      const profile = await this.profileManager.getProfile();
      if (!profile) {
        throw new Error('账号画像不存在，请先初始化');
      }

      // 3. 智能过滤
      logger.info('Step 3/5: 智能过滤');
      const filterResult = await this.filterEngine.filter(profile);
      const filtered = filterResult.contents;
      logger.info(`过滤完成: ${filtered.length} 条推荐`);

      if (filtered.length === 0) {
        logger.warn('没有符合条件的推荐内容');
        return;
      }

      // 4. 生成草稿
      logger.info('Step 4/5: 生成推文草稿');
      const recommendations = [];
      for (const content of filtered) {
        const draftResult = await this.draftGenerator.generateDrafts(content, profile);
        recommendations.push({ content, drafts: draftResult.drafts });
      }
      logger.info(`草稿生成完成: ${recommendations.length} 条推荐`);

      // 5. 飞书推送
      logger.info('Step 5/5: 飞书推送');
      await this.feishuClient.pushRecommendations(recommendations);
      logger.info('推送完成');

      const duration = (Date.now() - startTime) / 1000;
      logger.info(`========== 每日任务完成，耗时 ${duration.toFixed(2)}s ==========`);

    } catch (error) {
      logger.error('每日任务失败', error);
      await this.notifyError(error as Error);
      throw error;
    }
  }

  async runWeeklyLearning(): Promise<void> {
    logger.info('========== 开始每周学习任务 ==========');

    try {
      // 检查是否需要学习
      const shouldLearn = await this.feedbackLearner.shouldTriggerLearning();
      if (!shouldLearn) {
        logger.info('反馈数量不足，跳过学习');
        return;
      }

      // 获取最近 7 天的反馈
      const sql = `
        SELECT * FROM feedback_log
        WHERE created_at >= datetime('now', '-7 days')
        ORDER BY created_at DESC
      `;
      const feedbacks = this.db['db'].prepare(sql).all();
      logger.info(`获取到 ${feedbacks.length} 条反馈`);

      if (feedbacks.length < 10) {
        logger.info('反馈数量不足 10 条，跳过学习');
        return;
      }

      // 分析反馈模式
      const pattern = await this.feedbackLearner.analyzeFeedback(feedbacks as any);
      logger.info('反馈分析完成', {
        acceptanceRate: pattern.acceptanceRate,
        acceptedTopics: pattern.acceptedTopics.length,
        rejectedTopics: pattern.rejectedTopics.length
      });

      // 更新画像
      const currentProfile = await this.profileManager.getProfile();
      if (currentProfile) {
        const updatedProfile = await this.feedbackLearner.updateProfile(currentProfile, pattern);
        await this.profileManager.updateProfile(updatedProfile);
        logger.info('画像更新完成');
      }

      logger.info('========== 每周学习任务完成 ==========');

    } catch (error) {
      logger.error('每周学习任务失败', error);
      await this.notifyError(error as Error);
    }
  }

  async runCleanup(): Promise<void> {
    logger.info('========== 开始清理任务 ==========');

    try {
      // 清理 7 天前的内容
      const deleted = await this.db.deleteOldContent(7);
      logger.info(`清理完成: 删除 ${deleted} 条过期内容`);

      logger.info('========== 清理任务完成 ==========');

    } catch (error) {
      logger.error('清理任务失败', error);
    }
  }

  async runManually(): Promise<void> {
    logger.info('手动触发每日任务');
    await this.runDailyTask();
  }

  private async notifyError(error: Error): Promise<void> {
    const message = `⚠️ 系统错误\n\n错误信息：${error.message}\n时间：${new Date().toLocaleString('zh-CN')}`;

    try {
      // 简化：直接记录日志，飞书通知功能待实现
      logger.error('系统错误通知', { message });
    } catch (e) {
      logger.error('发送错误通知失败', e);
    }
  }
}
