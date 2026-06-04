import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseManager } from '../db/index.js';
import { Vectorizer } from './vectorizer.js';
import { DeepSeekClient } from '../ai/deepseek.js';
import type { EmbeddingProvider } from '../ai/types.js';
import { AccountProfile, InitialProfileData } from './types.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 账号画像管理器
 * 负责画像的初始化、查询、更新和向量化
 */
export class ProfileManager {
  private db: DatabaseManager;
  private vectorizer: Vectorizer;
  private deepseekClient?: DeepSeekClient;
  private accountHandle: string;
  private profilePath?: string;

  constructor(
    db: DatabaseManager,
    embeddingApiKey: string,
    accountHandle: string,
    deepseekApiKey?: string,
    deepseekBaseURL?: string,
    embeddingBaseURL?: string,
    embeddingModel?: string,
    profilePath?: string,
    providers?: {
      embeddingClient?: EmbeddingProvider;
    }
  ) {
    this.db = db;
    this.vectorizer = new Vectorizer(
      providers?.embeddingClient || embeddingApiKey,
      embeddingBaseURL,
      embeddingModel
    );
    this.accountHandle = accountHandle;
    this.profilePath = profilePath;

    if (deepseekApiKey) {
      this.deepseekClient = new DeepSeekClient(deepseekApiKey, deepseekBaseURL);
      logger.info('ProfileManager initialized with DeepSeek support');
    } else {
      logger.info('ProfileManager initialized without DeepSeek support');
    }
  }

  /**
   * 初始化账号画像
   * 从私有画像文件或内置样例读取数据并存储到数据库
   */
  async initializeProfile(): Promise<AccountProfile> {
    try {
      logger.info('Initializing account profile...');

      // 检查是否已存在画像
      const existing = await this.getProfile();
      if (existing) {
        logger.info('Profile already exists, skipping initialization');
        return existing;
      }

      // 读取初始画像数据
      const initialData = this.loadInitialProfileData();
      logger.info('Loaded initial profile data');

      // 转换为 AccountProfile 格式
      const profile: AccountProfile = {
        accountHandle: this.accountHandle,
        bio: initialData.bio,
        topics: initialData.topics,
        writingStyle: initialData.writingStyle,
        interests: initialData.interests,
        audience: initialData.audience,
        tweetCount: initialData.tweetCount,
        sampleTweets: initialData.sampleTweets,
      };

      try {
        logger.info('Generating embedding vector...');
        const vector = await this.vectorizer.vectorizeProfile(profile);
        profile.interestVector = vector;
      } catch (error) {
        logger.warn('Profile vector unavailable, continuing without embedding vector', error as Error);
      }

      // 存储到数据库
      this.saveProfileToDatabase(profile);

      logger.info('Profile initialized successfully');
      return profile;
    } catch (error) {
      logger.error('Failed to initialize profile:', error);
      throw error;
    }
  }

  /**
   * 获取账号画像
   */
  async getProfile(): Promise<AccountProfile | null> {
    try {
      const dbProfile = this.db.getAccountProfile(this.accountHandle);
      if (!dbProfile) {
        return null;
      }

      // 转换数据库格式为 AccountProfile
      const profile: AccountProfile = {
        id: dbProfile.id,
        accountHandle: dbProfile.account_handle,
        bio: dbProfile.bio || '',
        topics: dbProfile.topics ? JSON.parse(dbProfile.topics) : [],
        writingStyle: dbProfile.writing_style ? JSON.parse(dbProfile.writing_style) : {},
        interests: dbProfile.interests ? JSON.parse(dbProfile.interests) : [],
        audience: dbProfile.audience || '',
        interestVector: dbProfile.interest_vector ? JSON.parse(dbProfile.interest_vector) : undefined,
        lastUpdated: dbProfile.last_updated ? new Date(dbProfile.last_updated) : undefined,
        tweetCount: dbProfile.tweet_count || 0,
        sampleTweets: dbProfile.sample_tweets ? JSON.parse(dbProfile.sample_tweets) : undefined,
      };

      return profile;
    } catch (error) {
      logger.error('Failed to get profile:', error);
      throw error;
    }
  }

  /**
   * 更新账号画像
   */
  async updateProfile(updates: Partial<AccountProfile>): Promise<void> {
    try {
      logger.info('Updating account profile...');

      const current = await this.getProfile();
      if (!current) {
        throw new Error('Profile does not exist. Please initialize first.');
      }

      // 合并更新
      const updated: AccountProfile = {
        ...current,
        ...updates,
        accountHandle: this.accountHandle, // 确保账号不变
      };

      // 如果主题或兴趣有变化，重新生成向量
      if (updates.topics || updates.interests || updates.audience || updates.bio) {
        try {
          logger.info('Topics/interests changed, regenerating vector...');
          const vector = await this.vectorizer.refreshVector(updated);
          updated.interestVector = vector;
        } catch (error) {
          logger.warn('Profile vector refresh failed, keeping previous vector', error as Error);
          updated.interestVector = current.interestVector;
        }
      }

      // 保存到数据库
      this.saveProfileToDatabase(updated);

      logger.info('Profile updated successfully');
    } catch (error) {
      logger.error('Failed to update profile:', error);
      throw error;
    }
  }

  /**
   * 刷新 embedding 向量
   */
  async refreshVector(): Promise<void> {
    try {
      logger.info('Refreshing embedding vector...');

      const profile = await this.getProfile();
      if (!profile) {
        throw new Error('Profile does not exist');
      }

      const vector = await this.vectorizer.refreshVector(profile);
      profile.interestVector = vector;

      this.saveProfileToDatabase(profile);

      logger.info('Vector refreshed successfully');
    } catch (error) {
      logger.error('Failed to refresh vector:', error);
      throw error;
    }
  }

  /**
   * 使用 DeepSeek 进行深度分析（可选）
   */
  async deepAnalyze(): Promise<any> {
    if (!this.deepseekClient) {
      throw new Error('DeepSeek client not configured');
    }

    try {
      logger.info('Starting deep analysis with DeepSeek...');

      const profile = await this.getProfile();
      if (!profile || !profile.sampleTweets) {
        throw new Error('Profile or sample tweets not found');
      }

      const sampleTexts = profile.sampleTweets.map(t => t.text);
      const analysis = await this.deepseekClient.analyzeProfile(sampleTexts, profile);

      logger.info('Deep analysis completed');
      return analysis;
    } catch (error) {
      logger.error('Failed to perform deep analysis:', error);
      throw error;
    }
  }

  /**
   * 从文件加载初始画像数据
   */
  private loadInitialProfileData(): InitialProfileData {
    const bundledPath = join(__dirname, '../data/initial-profile.json');
    const dataPath = this.profilePath ? resolve(this.profilePath) : bundledPath;

    if (this.profilePath && !existsSync(dataPath)) {
      throw new Error(`Profile file not found: ${dataPath}`);
    }

    const data = readFileSync(dataPath, 'utf-8');
    return JSON.parse(data) as InitialProfileData;
  }

  /**
   * 保存画像到数据库
   */
  private saveProfileToDatabase(profile: AccountProfile): void {
    this.db.upsertAccountProfile({
      account_handle: profile.accountHandle,
      bio: profile.bio,
      topics: JSON.stringify(profile.topics),
      writing_style: JSON.stringify(profile.writingStyle),
      interests: JSON.stringify(profile.interests),
      audience: profile.audience,
      sample_tweets: profile.sampleTweets ? JSON.stringify(profile.sampleTweets) : undefined,
      interest_vector: profile.interestVector ? JSON.stringify(profile.interestVector) : undefined,
      tweet_count: profile.tweetCount,
    });
  }
}
