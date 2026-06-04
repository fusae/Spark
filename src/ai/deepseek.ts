import OpenAI from 'openai';
import { logger } from '../utils/logger.js';
import type { ChatClient, ChatOptions } from './types.js';

/**
 * DeepSeek 客户端
 * 用于深度分析账号画像，提取更细粒度的风格特征
 */
export class DeepSeekClient implements ChatClient {
  private client: OpenAI;
  private model: string = 'deepseek-chat';

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseURL || 'https://api.deepseek.com',
    });
    logger.info('DeepSeekClient initialized');
  }

  /**
   * 深度分析账号画像
   * 基于样本推文提取风格特征
   */
  async analyzeProfile(sampleTweets: string[], currentProfile: any): Promise<any> {
    try {
      logger.info('Starting deep profile analysis with DeepSeek');

      const prompt = this.buildAnalysisPrompt(sampleTweets, currentProfile);
      const startTime = Date.now();

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: '你是一个专业的社交媒体内容分析师，擅长分析推文风格和受众特征。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const duration = Date.now() - startTime;
      const result = JSON.parse(response.choices[0].message.content || '{}');

      logger.info(`DeepSeek analysis completed (${duration}ms)`);
      return result;
    } catch (error) {
      logger.error('Failed to analyze profile with DeepSeek:', error);
      throw error;
    }
  }

  /**
   * 构建分析提示词
   */
  private buildAnalysisPrompt(sampleTweets: string[], currentProfile: any): string {
    return `
请分析以下推文样本，提取账号的深度画像特征：

## 当前画像
- 主题: ${currentProfile.topics?.join(', ')}
- 兴趣: ${currentProfile.interests?.join(', ')}
- 受众: ${currentProfile.audience}
- 语气: ${currentProfile.writingStyle?.tone}

## 推文样本
${sampleTweets.map((tweet, i) => `${i + 1}. ${tweet}`).join('\n\n')}

请以 JSON 格式返回以下分析结果：
{
  "writingPatterns": {
    "sentenceStructure": "句式结构特点",
    "vocabulary": "词汇特点",
    "rhetoric": "修辞手法"
  },
  "contentStrategy": {
    "hooks": "常用开头方式",
    "storytelling": "叙事风格",
    "callToAction": "行动号召方式"
  },
  "audienceInsights": {
    "painPoints": ["痛点1", "痛点2"],
    "interests": ["兴趣1", "兴趣2"],
    "engagement": "互动偏好"
  },
  "recommendations": {
    "topicExpansion": ["可扩展主题1", "可扩展主题2"],
    "styleImprovement": "风格优化建议"
  }
}
`;
  }

  /**
   * 生成推文草稿
   */
  async generateTweetDraft(topic: string, profile: any): Promise<string> {
    try {
      logger.info(`Generating tweet draft for topic: ${topic}`);

      const prompt = `
基于以下账号画像，为主题"${topic}"生成一条推文草稿：

## 账号画像
- 主题: ${profile.topics?.join(', ')}
- 语气: ${profile.writingStyle?.tone}
- 平均长度: ${profile.writingStyle?.avgLength} 字
- 受众: ${profile.audience}

要求：
1. 符合账号的语气和风格
2. 长度控制在 ${profile.writingStyle?.avgLength || 100} 字左右
3. 内容有价值，能引发思考或互动
4. 不使用或少用 emoji（除非画像中明确使用）

请直接返回推文内容，不要额外说明。
`;

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: '你是一个专业的社交媒体内容创作者。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.7,
      });

      const draft = response.choices[0].message.content || '';
      logger.info('Tweet draft generated successfully');
      return draft.trim();
    } catch (error) {
      logger.error('Failed to generate tweet draft:', error);
      throw error;
    }
  }

  /**
   * 通用聊天接口
   */
  async chat(
    prompt: string,
    options?: ChatOptions
  ): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: options?.systemPrompt || '你是一个专业的 AI 助手。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
        response_format: options?.responseFormat ? { type: options.responseFormat } : undefined,
      });

      return response.choices[0].message.content || '';
    } catch (error) {
      logger.error('DeepSeek chat failed:', error);
      throw error;
    }
  }
}
