import type { ChatClient } from '../ai/types.js';
import { logger } from '../utils/logger.js';
import { FilteredContent, RankedContent } from './types.js';
import { AccountProfile } from '../profile/types.js';

/**
 * AI 精排器
 * 使用 DeepSeek 对候选内容进行深度评分和排序
 */
export class AIRanker {
  private lastFallbackReason = '';

  constructor(private chatClient: ChatClient) {}

  /**
   * 执行 AI 精排
   * @param candidates 候选内容列表
   * @param profile 账号画像
   * @param minScore 最低分数阈值
   * @returns 精排后的内容列表
   */
  async rank(
    candidates: FilteredContent[],
    profile: AccountProfile,
    minScore: number = 7.0
  ): Promise<FilteredContent[]> {
    logger.info(`Starting AI ranking: ${candidates.length} candidates, minScore=${minScore}`);
    const startTime = Date.now();
    this.lastFallbackReason = '';

    try {
      // 1. 构建 Prompt
      const prompt = this.buildRankingPrompt(candidates, profile);

      // 2. 调用 AI
      const response = await this.callDeepSeek(prompt);

      // 3. 解析结果
      const rankedResults = this.parseRankingResponse(response, minScore);

      // 4. 更新候选内容的 AI 分数
      const rankedContents = this.mergeRankingResults(candidates, rankedResults);

      const duration = Date.now() - startTime;
      logger.info(`AI ranking completed: ${rankedContents.length} results (${duration}ms)`);

      if (rankedContents.length > 0) {
        const scores = rankedContents.map(c => c.aiScore!);
        logger.debug(`Score range: ${Math.max(...scores).toFixed(1)} - ${Math.min(...scores).toFixed(1)}`);
      }

      return rankedContents;
    } catch (error) {
      this.lastFallbackReason = error instanceof Error ? error.message : String(error);
      logger.error('AI ranking failed:', error);
      // 降级：返回原始候选列表（按 embedding 相似度排序）
      logger.warn('Falling back to embedding similarity ranking');
      return candidates;
    }
  }

  getLastFallbackReason(): string {
    return this.lastFallbackReason;
  }

  /**
   * 构建精排 Prompt
   */
  private buildRankingPrompt(candidates: FilteredContent[], profile: AccountProfile): string {
    const candidateList = candidates
      .map((c, i) => {
        const content = c.content;
        const metrics = content.metrics;
        const likes = metrics?.likes || metrics?.points || metrics?.stars || 0;

        return `${i + 1}. 【${content.source}】${content.title || '无标题'}
   摘要：${this.truncateText(content.content, 200)}
   热度：${likes} 赞
   时间：${this.formatDate(content.publishedAt)}
   URL: ${content.url}`;
      })
      .join('\n\n');

    return `你是一个内容策划专家。

账号画像：
- 账号：@${profile.accountHandle}
- 主题：${profile.topics.join(', ')}
- 风格：${profile.writingStyle.tone}
- 兴趣：${profile.interests.join(', ')}
- 受众：${profile.audience}

候选内容（${candidates.length} 条）：
${candidateList}

任务：为每条内容评分（0-10）并说明原因。评分维度：
1. 话题相关性 (40%) - 与账号主题的匹配度
2. 受众匹配度 (30%) - 是否适合目标受众
3. 时效性 (20%) - 内容的新鲜度和时效性
4. 可发挥空间 (10%) - 是否有足够的评论角度

只返回 top 3-5 条（总分 >= 7），JSON 格式：
[{
  "id": 序号,
  "score": 总分,
  "reason": "匹配原因（50字内）",
  "dimensions": {
    "topicRelevance": 分数,
    "audienceMatch": 分数,
    "timeliness": 分数,
    "potential": 分数
  }
}]

注意：
- 必须返回有效的 JSON 数组
- id 必须是 1 到 ${candidates.length} 之间的整数
- 所有分数必须是 0-10 的数字
- 如果没有符合条件的内容，返回空数组 []`;
  }

  private async callDeepSeek(prompt: string): Promise<string> {
    return this.chatClient.chat(prompt, {
      systemPrompt: '你是一个专业的社交媒体内容分析师，擅长评估内容与账号的匹配度。',
      temperature: 0.3,
      responseFormat: 'json_object',
    });
  }

  /**
   * 解析 AI 返回的 JSON 结果
   */
  private parseRankingResponse(response: string, minScore: number): RankedContent[] {
    try {
      // DeepSeek 可能返回 { "results": [...] } 或直接返回数组
      let parsed = JSON.parse(response);

      // 处理包装在对象中的情况
      if (parsed.results && Array.isArray(parsed.results)) {
        parsed = parsed.results;
      } else if (!Array.isArray(parsed)) {
        // 尝试查找第一个数组字段
        const arrayField = Object.values(parsed).find(v => Array.isArray(v));
        if (arrayField) {
          parsed = arrayField;
        } else {
          logger.warn('AI response is not an array, returning empty results');
          return [];
        }
      }

      // 验证和过滤结果
      const results: RankedContent[] = [];
      for (const item of parsed) {
        if (this.isValidRankedContent(item) && item.score >= minScore) {
          results.push(item);
        }
      }

      logger.info(`Parsed ${results.length} valid results from AI response`);
      return results;
    } catch (error) {
      logger.error('Failed to parse AI ranking response:', error);
      logger.debug('Raw response:', response);

      // 尝试提取 JSON 数组（处理可能的格式问题）
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const extracted = JSON.parse(jsonMatch[0]);
          if (Array.isArray(extracted)) {
            logger.info('Successfully extracted JSON array from response');
            return extracted.filter(item =>
              this.isValidRankedContent(item) && item.score >= minScore
            );
          }
        } catch (e) {
          logger.error('Failed to parse extracted JSON:', e);
        }
      }

      return [];
    }
  }

  /**
   * 验证 RankedContent 对象的有效性
   */
  private isValidRankedContent(item: any): item is RankedContent {
    return (
      typeof item === 'object' &&
      typeof item.id === 'number' &&
      typeof item.score === 'number' &&
      typeof item.reason === 'string' &&
      typeof item.dimensions === 'object' &&
      typeof item.dimensions.topicRelevance === 'number' &&
      typeof item.dimensions.audienceMatch === 'number' &&
      typeof item.dimensions.timeliness === 'number' &&
      typeof item.dimensions.potential === 'number'
    );
  }

  /**
   * 合并 AI 排序结果到候选内容
   */
  private mergeRankingResults(
    candidates: FilteredContent[],
    rankedResults: RankedContent[]
  ): FilteredContent[] {
    const resultMap = new Map<number, RankedContent>();
    for (const result of rankedResults) {
      resultMap.set(result.id, result);
    }

    const merged: FilteredContent[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const ranking = resultMap.get(i + 1); // id 是 1-based

      if (ranking) {
        merged.push({
          ...candidate,
          aiScore: ranking.score,
          aiReason: ranking.reason,
          dimensions: ranking.dimensions,
          rank: merged.length + 1,
        });
      }
    }

    // 按 AI 分数排序
    merged.sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));

    // 更新排名
    merged.forEach((item, index) => {
      item.rank = index + 1;
    });

    return merged;
  }

  /**
   * 截断文本
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength) + '...';
  }

  /**
   * 格式化日期
   */
  private formatDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffHours < 1) {
      return '刚刚';
    } else if (diffHours < 24) {
      return `${diffHours}小时前`;
    } else if (diffHours < 48) {
      return '昨天';
    } else {
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays}天前`;
    }
  }
}
