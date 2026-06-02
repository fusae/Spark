import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface AccountProfile {
  id?: number;
  account_handle: string;
  bio?: string;
  topics?: string; // JSON array
  writing_style?: string; // JSON object
  interests?: string; // JSON array
  audience?: string; // 目标受众描述
  sample_tweets?: string; // JSON array
  interest_vector?: string; // Serialized vector (768-dim)
  last_updated?: string;
  tweet_count?: number;
}

export interface ContentPool {
  id?: number;
  user_id?: string;
  source: string;
  title?: string;
  content: string;
  url?: string;
  author?: string;
  published_at?: string;
  metrics?: string; // JSON
  collected_at?: string;
  embedding_vector?: string;
}

export interface Recommendation {
  id?: number;
  user_id?: string;
  content_id: number;
  match_score: number;
  match_reason?: string;
  drafts?: string; // JSON
  recommended_at?: string;
  status?: string;
  user_feedback?: string;
}

export interface RecommendationWithContent extends Recommendation {
  source: string;
  title?: string;
  content: string;
  url?: string;
  author?: string;
  published_at?: string;
  collected_at?: string;
}

export interface FeedbackLog {
  id?: number;
  recommendation_id: number;
  action: string;
  modified_draft?: string;
  created_at?: string;
}

export interface RuntimeUserRecord {
  user_id: string;
  account_handle: string;
  profile_path?: string;
  cron_schedule: string;
  timezone: string;
  rate_limit_max_concurrent: number;
  rate_limit_request_delay_ms: number;
  created_at?: string;
  updated_at?: string;
}

export interface RuntimeLarkConfigRecord {
  user_id: string;
  app_id?: string;
  app_secret_encrypted?: string;
  base_id?: string;
  default_receiver_id?: string;
  updated_at?: string;
}

export interface RuntimeSourceConfigRecord {
  user_id: string;
  source: string;
  enabled: number;
  config_json?: string;
  updated_at?: string;
}

export interface RuntimeCredentialRecord {
  user_id: string;
  credential_key: string;
  encrypted_value: string;
  updated_at?: string;
}

export interface RuntimeCredentialCheckRecord {
  user_id: string;
  platform: string;
  status: 'unknown' | 'valid' | 'invalid';
  message?: string;
  checked_at?: string;
}

export interface RuntimeJobRecord {
  id?: number;
  user_id: string;
  job_type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  payload_json?: string;
  scheduled_for?: string;
  attempts?: number;
  last_error?: string;
  run_log_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface RuntimeRunLogRecord {
  id?: number;
  user_id: string;
  job_type: string;
  status: 'running' | 'succeeded' | 'failed';
  started_at?: string;
  finished_at?: string;
  message?: string;
  stats_json?: string;
  error?: string;
}

export class DatabaseManager {
  private db: Database.Database;

  constructor(dbPath: string) {
    logger.info(`Initializing database at: ${dbPath}`);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * 初始化数据库表结构
   */
  initialize(): void {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
    this.migrate();
    logger.info('Database schema initialized successfully');
  }

  private migrate(): void {
    this.migrateContentPoolUserIsolation();

    const columns = this.db.prepare('PRAGMA table_info(recommendations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has('user_id')) {
      this.db.exec('ALTER TABLE recommendations ADD COLUMN user_id TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_recommendations_user_id ON recommendations(user_id, recommended_at)');
    this.db.exec(`
      UPDATE recommendations
      SET user_id = 'local'
      WHERE user_id IS NULL OR user_id = ''
    `);
    this.db.exec(`
      DELETE FROM recommendations
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM recommendations
        GROUP BY user_id, content_id
      )
    `);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_user_content ON recommendations(user_id, content_id)');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_credential_checks (
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, platform),
        FOREIGN KEY (user_id) REFERENCES runtime_users(user_id) ON DELETE CASCADE
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_runtime_credential_checks_platform ON runtime_credential_checks(platform)');
  }

  private migrateContentPoolUserIsolation(): void {
    const columns = this.db.prepare('PRAGMA table_info(content_pool)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'user_id')) {
      this.db.pragma('foreign_keys = OFF');
      try {
        this.db.exec(`
          BEGIN;
          CREATE TABLE content_pool_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL DEFAULT 'local',
            source TEXT NOT NULL,
            title TEXT,
            content TEXT NOT NULL,
            url TEXT,
            author TEXT,
            published_at TIMESTAMP,
            metrics TEXT,
            collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            embedding_vector TEXT,
            UNIQUE(user_id, url)
          );
          INSERT INTO content_pool_migrated (
            id, user_id, source, title, content, url, author, published_at, metrics, collected_at, embedding_vector
          )
          SELECT
            id, 'local', source, title, content, url, author, published_at, metrics, collected_at, embedding_vector
          FROM content_pool;
          DROP TABLE content_pool;
          ALTER TABLE content_pool_migrated RENAME TO content_pool;
          COMMIT;
        `);
      } catch (error) {
        if (this.db.inTransaction) {
          this.db.exec('ROLLBACK');
        }
        throw error;
      } finally {
        this.db.pragma('foreign_keys = ON');
      }
    }

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_content_pool_url ON content_pool(url)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_content_pool_collected_at ON content_pool(collected_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_content_pool_user_collected_at ON content_pool(user_id, collected_at)');
  }

  /**
   * 账号画像相关操作
   */
  upsertAccountProfile(profile: AccountProfile): void {
    const stmt = this.db.prepare(`
      INSERT INTO account_profile (account_handle, bio, topics, writing_style, interests, audience, sample_tweets, interest_vector, tweet_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_handle) DO UPDATE SET
        bio = excluded.bio,
        topics = excluded.topics,
        writing_style = excluded.writing_style,
        interests = excluded.interests,
        audience = excluded.audience,
        sample_tweets = excluded.sample_tweets,
        interest_vector = excluded.interest_vector,
        tweet_count = excluded.tweet_count,
        last_updated = CURRENT_TIMESTAMP
    `);
    stmt.run(
      profile.account_handle,
      profile.bio || null,
      profile.topics || null,
      profile.writing_style || null,
      profile.interests || null,
      profile.audience || null,
      profile.sample_tweets || null,
      profile.interest_vector || null,
      profile.tweet_count || 0
    );
    logger.debug(`Account profile upserted: ${profile.account_handle}`);
  }

  getAccountProfile(accountHandle: string): AccountProfile | undefined {
    const stmt = this.db.prepare('SELECT * FROM account_profile WHERE account_handle = ?');
    return stmt.get(accountHandle) as AccountProfile | undefined;
  }

  /**
   * 内容池相关操作
   */
  insertContent(content: ContentPool): number {
    const stmt = this.db.prepare(`
      INSERT INTO content_pool (user_id, source, title, content, url, author, published_at, metrics, collected_at, embedding_vector)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      content.user_id || 'local',
      content.source,
      content.title || null,
      content.content,
      content.url || null,
      content.author || null,
      content.published_at || null,
      content.metrics || null,
      content.collected_at || null,
      content.embedding_vector || null
    );
    logger.debug(`Content inserted with ID: ${result.lastInsertRowid}`);
    return Number(result.lastInsertRowid);
  }

  getContentById(id: number): ContentPool | undefined {
    const stmt = this.db.prepare('SELECT * FROM content_pool WHERE id = ?');
    return stmt.get(id) as ContentPool | undefined;
  }

  getRecentContent(limit: number = 50, userId: string = 'local', hours?: number): ContentPool[] {
    if (hours !== undefined) {
      const stmt = this.db.prepare(`
        SELECT * FROM content_pool
        WHERE user_id = ?
          AND collected_at >= datetime('now', '-' || ? || ' hours')
        ORDER BY collected_at DESC
        LIMIT ?
      `);
      return stmt.all(userId, hours, limit) as ContentPool[];
    }

    const stmt = this.db.prepare(`
      SELECT * FROM content_pool
      WHERE user_id = ?
      ORDER BY collected_at DESC
      LIMIT ?
    `);
    return stmt.all(userId, limit) as ContentPool[];
  }

  getContentByUrl(url: string, userId: string = 'local'): ContentPool | undefined {
    const stmt = this.db.prepare('SELECT * FROM content_pool WHERE user_id = ? AND url = ?');
    return stmt.get(userId, url) as ContentPool | undefined;
  }

  getContentByHash(_hash: string): ContentPool | undefined {
    // 使用 title 和 url 的组合来查找（简化实现）
    // 在实际应用中，可以添加专门的 hash 字段
    // 这是一个简化实现，实际应该在表中添加 content_hash 字段
    return undefined;
  }

  deleteOldContent(daysOld: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM content_pool
      WHERE collected_at < datetime('now', '-' || ? || ' days')
    `);
    const result = stmt.run(daysOld);
    logger.info(`Deleted ${result.changes} old content items`);
    return result.changes;
  }

  /**
   * 获取最近指定小时内的内容
   */
  getRecentContents(hours: number, userId: string = 'local'): ContentPool[] {
    const stmt = this.db.prepare(`
      SELECT * FROM content_pool
      WHERE user_id = ?
        AND collected_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY collected_at DESC
    `);
    return stmt.all(userId, hours) as ContentPool[];
  }

  /**
   * 批量获取内容
   */
  getContentsByIds(ids: number[]): ContentPool[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT * FROM content_pool
      WHERE id IN (${placeholders})
    `);
    return stmt.all(...ids) as ContentPool[];
  }

  /**
   * 更新内容的 embedding 向量
   */
  updateContentEmbedding(id: number, vector: string): void {
    const stmt = this.db.prepare(`
      UPDATE content_pool
      SET embedding_vector = ?
      WHERE id = ?
    `);
    stmt.run(vector, id);
    logger.debug(`Content ${id} embedding updated`);
  }

  /**
   * 推荐记录相关操作
   */
  insertRecommendation(recommendation: Recommendation): number {
    const stmt = this.db.prepare(`
      INSERT INTO recommendations (user_id, content_id, match_score, match_reason, drafts, status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, content_id) DO UPDATE SET
        match_score = excluded.match_score,
        match_reason = excluded.match_reason,
        drafts = excluded.drafts,
        status = excluded.status,
        user_feedback = NULL,
        recommended_at = CURRENT_TIMESTAMP
      RETURNING id
    `);
    const result = stmt.get(
      recommendation.user_id || null,
      recommendation.content_id,
      recommendation.match_score,
      recommendation.match_reason || null,
      recommendation.drafts || null,
      recommendation.status || 'pending'
    ) as { id: number };
    logger.debug(`Recommendation saved with ID: ${result.id}`);
    return result.id;
  }

  updateRecommendationStatus(id: number, status: string, feedback?: string): void {
    const stmt = this.db.prepare(`
      UPDATE recommendations
      SET status = ?, user_feedback = ?
      WHERE id = ?
    `);
    stmt.run(status, feedback, id);
    logger.debug(`Recommendation ${id} status updated to: ${status}`);
  }

  getRecommendationsByStatus(status: string): Recommendation[] {
    const stmt = this.db.prepare('SELECT * FROM recommendations WHERE status = ? ORDER BY recommended_at DESC');
    return stmt.all(status) as Recommendation[];
  }

  getRecommendationById(id: number): Recommendation | undefined {
    const stmt = this.db.prepare('SELECT * FROM recommendations WHERE id = ?');
    return stmt.get(id) as Recommendation | undefined;
  }

  listRecommendationsWithContent(userId: string, limit: number = 20): RecommendationWithContent[] {
    const stmt = this.db.prepare(`
      SELECT
        r.*,
        c.source,
        c.title,
        c.content,
        c.url,
        c.author,
        c.published_at,
        c.collected_at
      FROM recommendations r
      JOIN content_pool c ON c.id = r.content_id
      WHERE r.user_id = ? OR (r.user_id IS NULL AND ? = 'local')
      ORDER BY r.recommended_at DESC
      LIMIT ?
    `);
    return stmt.all(userId, userId, limit) as RecommendationWithContent[];
  }

  /**
   * 反馈日志相关操作
   */
  insertFeedback(feedback: FeedbackLog): number {
    const stmt = this.db.prepare(`
      INSERT INTO feedback_log (recommendation_id, action, modified_draft)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(
      feedback.recommendation_id,
      feedback.action,
      feedback.modified_draft || null
    );
    logger.debug(`Feedback logged with ID: ${result.lastInsertRowid}`);
    return Number(result.lastInsertRowid);
  }

  getFeedbackByRecommendation(recommendationId: number): FeedbackLog[] {
    const stmt = this.db.prepare('SELECT * FROM feedback_log WHERE recommendation_id = ? ORDER BY created_at DESC');
    return stmt.all(recommendationId) as FeedbackLog[];
  }

  /**
   * 运行配置相关操作
   */
  upsertRuntimeUser(record: RuntimeUserRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_users (
        user_id, account_handle, profile_path, cron_schedule, timezone,
        rate_limit_max_concurrent, rate_limit_request_delay_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        account_handle = excluded.account_handle,
        profile_path = excluded.profile_path,
        cron_schedule = excluded.cron_schedule,
        timezone = excluded.timezone,
        rate_limit_max_concurrent = excluded.rate_limit_max_concurrent,
        rate_limit_request_delay_ms = excluded.rate_limit_request_delay_ms,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      record.user_id,
      record.account_handle,
      record.profile_path || null,
      record.cron_schedule,
      record.timezone,
      record.rate_limit_max_concurrent,
      record.rate_limit_request_delay_ms
    );
  }

  getRuntimeUser(userId: string): RuntimeUserRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM runtime_users WHERE user_id = ?');
    return stmt.get(userId) as RuntimeUserRecord | undefined;
  }

  listRuntimeUsers(): RuntimeUserRecord[] {
    const stmt = this.db.prepare('SELECT * FROM runtime_users ORDER BY created_at DESC');
    return stmt.all() as RuntimeUserRecord[];
  }

  deleteRuntimeUser(userId: string): void {
    const stmt = this.db.prepare('DELETE FROM runtime_users WHERE user_id = ?');
    stmt.run(userId);
  }

  upsertRuntimeLarkConfig(record: RuntimeLarkConfigRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_lark_configs (
        user_id, app_id, app_secret_encrypted, base_id, default_receiver_id
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        app_id = excluded.app_id,
        app_secret_encrypted = excluded.app_secret_encrypted,
        base_id = excluded.base_id,
        default_receiver_id = excluded.default_receiver_id,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      record.user_id,
      record.app_id || null,
      record.app_secret_encrypted || null,
      record.base_id || null,
      record.default_receiver_id || null
    );
  }

  getRuntimeLarkConfig(userId: string): RuntimeLarkConfigRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM runtime_lark_configs WHERE user_id = ?');
    return stmt.get(userId) as RuntimeLarkConfigRecord | undefined;
  }

  upsertRuntimeSourceConfig(record: RuntimeSourceConfigRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_source_configs (user_id, source, enabled, config_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, source) DO UPDATE SET
        enabled = excluded.enabled,
        config_json = excluded.config_json,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(
      record.user_id,
      record.source,
      record.enabled,
      record.config_json || null
    );
  }

  getRuntimeSourceConfigs(userId: string): RuntimeSourceConfigRecord[] {
    const stmt = this.db.prepare('SELECT * FROM runtime_source_configs WHERE user_id = ?');
    return stmt.all(userId) as RuntimeSourceConfigRecord[];
  }

  upsertRuntimeCredential(record: RuntimeCredentialRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_credentials (user_id, credential_key, encrypted_value)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, credential_key) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(record.user_id, record.credential_key, record.encrypted_value);
  }

  getRuntimeCredentials(userId: string): RuntimeCredentialRecord[] {
    const stmt = this.db.prepare('SELECT * FROM runtime_credentials WHERE user_id = ?');
    return stmt.all(userId) as RuntimeCredentialRecord[];
  }

  deleteRuntimeCredential(userId: string, credentialKey: string): void {
    const stmt = this.db.prepare('DELETE FROM runtime_credentials WHERE user_id = ? AND credential_key = ?');
    stmt.run(userId, credentialKey);
  }

  upsertRuntimeCredentialCheck(record: RuntimeCredentialCheckRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_credential_checks (user_id, platform, status, message)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, platform) DO UPDATE SET
        status = excluded.status,
        message = excluded.message,
        checked_at = CURRENT_TIMESTAMP
    `);
    stmt.run(record.user_id, record.platform, record.status, record.message || null);
  }

  getRuntimeCredentialChecks(userId: string): RuntimeCredentialCheckRecord[] {
    const stmt = this.db.prepare('SELECT * FROM runtime_credential_checks WHERE user_id = ?');
    return stmt.all(userId) as RuntimeCredentialCheckRecord[];
  }

  deleteRuntimeCredentialCheck(userId: string, platform: string): void {
    const stmt = this.db.prepare('DELETE FROM runtime_credential_checks WHERE user_id = ? AND platform = ?');
    stmt.run(userId, platform);
  }

  insertRuntimeJob(job: RuntimeJobRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_jobs (user_id, job_type, status, payload_json, scheduled_for)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      job.user_id,
      job.job_type,
      job.status,
      job.payload_json || null,
      job.scheduled_for || null
    );
    return Number(result.lastInsertRowid);
  }

  claimNextRuntimeJob(): RuntimeJobRecord | undefined {
    const select = this.db.prepare(`
      SELECT * FROM runtime_jobs
      WHERE status = 'queued'
        AND datetime(COALESCE(scheduled_for, CURRENT_TIMESTAMP)) <= datetime('now')
      ORDER BY datetime(COALESCE(scheduled_for, CURRENT_TIMESTAMP)) ASC, id ASC
      LIMIT 1
    `);
    const update = this.db.prepare(`
      UPDATE runtime_jobs
      SET status = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `);

    const transaction = this.db.transaction(() => {
      const job = select.get() as RuntimeJobRecord | undefined;
      if (!job?.id) {
        return undefined;
      }

      const result = update.run(job.id);
      return result.changes === 1
        ? { ...job, status: 'running' as const, attempts: (job.attempts || 0) + 1 }
        : undefined;
    });

    return transaction();
  }

  updateRuntimeJobStatus(
    id: number,
    status: RuntimeJobRecord['status'],
    options: { lastError?: string; runLogId?: number } = {}
  ): void {
    const stmt = this.db.prepare(`
      UPDATE runtime_jobs
      SET status = ?, last_error = ?, run_log_id = COALESCE(?, run_log_id), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(status, options.lastError || null, options.runLogId || null, id);
  }

  listRuntimeJobs(limit: number = 50): RuntimeJobRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM runtime_jobs
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as RuntimeJobRecord[];
  }

  markInterruptedRuntimeWork(reason: string): { jobs: number; runs: number } {
    const failJobs = this.db.prepare(`
      UPDATE runtime_jobs
      SET status = 'failed',
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `);
    const failRuns = this.db.prepare(`
      UPDATE runtime_run_logs
      SET status = 'failed',
          finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
          message = '运行中断',
          error = COALESCE(error, ?)
      WHERE status = 'running'
    `);

    const transaction = this.db.transaction(() => ({
      jobs: failJobs.run(reason).changes,
      runs: failRuns.run(reason).changes,
    }));

    return transaction();
  }

  insertRuntimeRunLog(log: RuntimeRunLogRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_run_logs (user_id, job_type, status, message, stats_json, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      log.user_id,
      log.job_type,
      log.status,
      log.message || null,
      log.stats_json || null,
      log.error || null
    );
    return Number(result.lastInsertRowid);
  }

  finishRuntimeRunLog(
    id: number,
    status: RuntimeRunLogRecord['status'],
    options: { message?: string; statsJson?: string; error?: string } = {}
  ): void {
    const stmt = this.db.prepare(`
      UPDATE runtime_run_logs
      SET status = ?, finished_at = CURRENT_TIMESTAMP, message = ?, stats_json = ?, error = ?
      WHERE id = ?
    `);
    stmt.run(
      status,
      options.message || null,
      options.statsJson || null,
      options.error || null,
      id
    );
  }

  updateRuntimeRunLog(
    id: number,
    options: { message?: string; statsJson?: string; error?: string }
  ): void {
    const stmt = this.db.prepare(`
      UPDATE runtime_run_logs
      SET message = COALESCE(?, message),
          stats_json = COALESCE(?, stats_json),
          error = COALESCE(?, error)
      WHERE id = ?
    `);
    stmt.run(
      options.message ?? null,
      options.statsJson ?? null,
      options.error ?? null,
      id
    );
  }

  listRuntimeRunLogs(userId?: string, limit: number = 50): RuntimeRunLogRecord[] {
    if (userId) {
      const stmt = this.db.prepare(`
        SELECT * FROM runtime_run_logs
        WHERE user_id = ?
        ORDER BY datetime(started_at) DESC, id DESC
        LIMIT ?
      `);
      return stmt.all(userId, limit) as RuntimeRunLogRecord[];
    }

    const stmt = this.db.prepare(`
      SELECT * FROM runtime_run_logs
      ORDER BY datetime(started_at) DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as RuntimeRunLogRecord[];
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
    logger.info('Database connection closed');
  }
}
