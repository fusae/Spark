import { AccountProfile } from '../profile/types.js';
import { FilteredContent } from '../filter/types.js';
import { Draft, DraftGenerationOptions, DraftGenerationResult, DraftStyle } from './types.js';
import { StyleAnalyzer } from './style-analyzer.js';
import { logger } from '../utils/logger.js';

export interface DraftChatClient {
  chat(
    prompt: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
    }
  ): Promise<string>;
}

/**
 * 草稿生成器
 * 为筛选后的内容生成多个风格的推文草稿
 */
export class DraftGenerator {
  private readonly DEFAULT_STYLES: DraftStyle[] = ['short', 'medium', 'long'];
  private readonly MAX_LENGTH = 4000;
  private readonly MAX_REWRITE_ATTEMPTS = 3;
  private lastError?: Error;

  constructor(
    private chatClient: DraftChatClient,
    private modelName = 'deepseek-chat'
  ) {
    logger.info(`DraftGenerator initialized with ${modelName}`);
  }

  /**
   * 为单条内容生成草稿
   */
  async generateDrafts(
    content: FilteredContent,
    profile: AccountProfile,
    options?: DraftGenerationOptions
  ): Promise<DraftGenerationResult> {
    const startTime = Date.now();
    const opts = this.normalizeOptions(options);

    logger.info(`Generating drafts for content #${content.contentId}`);
    logger.debug(`Title: ${content.content.title}`);

    try {
      // 1. 构建 prompt
      const prompt = this.buildPrompt(content, profile, opts);

      // 2. 调用草稿生成模型
      const response = await this.chatClient.chat(prompt, {
        temperature: opts.temperature,
        maxTokens: 1800,
        systemPrompt:
          '你是一个中文 X/Twitter 代写编辑，只交付能让账号本人直接复制发布的草稿。拒绝新闻稿、摘要、导读、营销文案、公众号腔和编造经历。正文不要包含链接、URL 或链接占位符。',
      });

      // 3. 解析响应
      const drafts = this.parseResponse(response, opts.maxLength!);

      // 4. 验证草稿，不合格的按版本打回重写
      const validatedDrafts = await this.validateAndRewriteDrafts(drafts, profile, content, opts);

      const duration = Date.now() - startTime;
      logger.info(`Generated ${validatedDrafts.length} drafts in ${duration}ms`);

      return {
        drafts: validatedDrafts,
        contentId: content.contentId,
        generatedAt: new Date(),
        model: this.modelName,
      };
    } catch (error) {
      logger.error(`Failed to generate drafts for content #${content.contentId}:`, error);
      throw error;
    }
  }

  /**
   * 批量生成草稿
   */
  async generateBatch(
    contents: FilteredContent[],
    profile: AccountProfile,
    options?: DraftGenerationOptions
  ): Promise<DraftGenerationResult[]> {
    logger.info(`Generating drafts for ${contents.length} contents`);

    const results: DraftGenerationResult[] = [];
    this.lastError = undefined;

    for (const content of contents) {
      try {
        const result = await this.generateDrafts(content, profile, options);
        results.push(result);

        // 添加延迟避免 API 限流
        await this.delay(500);
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Failed to generate drafts for content #${content.contentId}, skipping`, error);
        // 继续处理下一条
      }
    }

    logger.info(`Batch generation completed: ${results.length}/${contents.length} succeeded`);
    return results;
  }

  getLastError(): Error | undefined {
    return this.lastError;
  }

  /**
   * 构建 prompt
   */
  private buildPrompt(
    content: FilteredContent,
    profile: AccountProfile,
    _options: Required<DraftGenerationOptions>
  ): string {
    const styleDescription = StyleAnalyzer.generateStyleDescription(profile);
    const sampleTweets = StyleAnalyzer.generateSampleTweetsText(profile);
    const targetLength = StyleAnalyzer.calculateTargetLength(profile);
    const emojiStrategy = StyleAnalyzer.analyzeEmojiStrategy(profile);

    const prompt = `你要为一个中文 X/Twitter 账号写可直接发布的推文。

${styleDescription}

历史推文样本：
${sampleTweets}

原始内容：
标题：${content.content.title}
摘要：${content.content.content}
来源：${content.content.url}
推荐理由：${content.aiReason || '相关度高'}

任务：生成 3 个不同长度版本的推文草稿。每条都必须像账号本人临时发的一条推文，而不是资讯摘要。

1. **短版（short）**：60-120 字，一句话快评，先给判断
2. **中版（medium）**：150-260 字，判断 + 关键理由，适合正常单条推文
3. **长版（long）**：320-650 字，分段展开，适合长推，但不要写成文章

要求：
- 严格模仿账号的语气、节奏、句子长度和表达习惯
- 内容要有一个清晰观点或信息增量，不要只是复述标题或改写原文
- 每条只能围绕 1 个主判断写，避免把原文所有信息都塞进去
- 不确定的信息用“看起来/可能/如果属实”处理，不要装作已经亲测
- 只能使用原始内容、推荐理由和历史样本里明确出现的信息；不要编造“我做过/我用过/我关注的点是/我的项目”等个人经历
- 开头直接给判断，不要用“这篇文章/这个项目/这个内容/推荐阅读/值得一看/点击查看/了解更多”
- 不要写成新闻摘要、产品介绍、公众号导语、营销文案
- 不要使用“首先/其次/最后/第一层/第二层/第三层/核心是/本质上/没有之一/值得认真看/重新思考”这种模板话
- 不要为了显得深刻写空话，例如“给开发者一把钥匙”“效果上了一个台阶”“角色发生转变”
- 不要解释“我为什么这样写”，解释只能放在 reasoning 字段
- 短版不要换行；中版最多 2 段；长版最多 4 段
- 优先遵守短/中/长的字数范围；账号平均长度 ${targetLength.min}-${targetLength.max} 只作为语气参考
- ${emojiStrategy}
- 草稿正文不要包含任何链接、URL、[链接] 或“点击/查看原文”等导流话术
- 每个草稿附带生成理由（为什么这样写）

可发推标准：
- 像一个真实开发者临时表达判断，而不是 AI 帮忙总结资料
- 有取舍、有具体细节、有轻微个人口吻，但不硬蹭账号历史项目
- 读者看完能得到一个判断或操作启发，而不是只知道“发生了什么”
- 文字有毛边，不追求段段完整、句句漂亮；不要把结论包装得太圆
- 表达效率要高，删掉“值得关注/新底座/新思路/实打实利好”这类低信息量词
- 认知落差要明确：只写一个别人转发原文时不一定会想到的判断

返回 JSON 格式（纯 JSON，不要 markdown 代码块）：
[
  {
    "content": "像真人发的推文正文",
    "style": "short",
    "reasoning": "内部说明，不要重复正文"
  },
  {
    "content": "像真人发的推文正文",
    "style": "medium",
    "reasoning": "内部说明，不要重复正文"
  },
  {
    "content": "像真人发的推文正文",
    "style": "long",
    "reasoning": "内部说明，不要重复正文"
  }
]`;

    return prompt;
  }

  /**
   * 解析 API 响应
   */
  private parseResponse(response: string, maxLength: number): Draft[] {
    try {
      // 移除可能的 markdown 代码块标记
      let cleaned = response.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '');
      }

      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) {
        throw new Error('Response is not an array');
      }

      const drafts: Draft[] = parsed.map((item: any) => {
        const content = this.sanitizeDraftContent(item.content || '');
        return {
          content,
          style: this.normalizeDraftStyle(item.style),
          reasoning: item.reasoning || '',
          length: content.length,
        };
      });

      // 过滤掉异常超长的草稿
      return drafts.filter(draft => draft.length <= maxLength);
    } catch (error) {
      logger.error('Failed to parse draft response:', error);
      logger.debug('Raw response:', response);
      throw new Error('Failed to parse draft generation response');
    }
  }

  /**
   * 验证草稿，不合格的按 style 重写，保证短/中/长按钮稳定
   */
  private async validateAndRewriteDrafts(
    drafts: Draft[],
    profile: AccountProfile,
    source: FilteredContent,
    options: Required<DraftGenerationOptions>
  ): Promise<Draft[]> {
    const byStyle = new Map<DraftStyle, Draft>();
    for (const draft of drafts) {
      if (!byStyle.has(draft.style)) {
        byStyle.set(draft.style, draft);
      }
    }

    const finalized: Draft[] = [];

    for (const style of options.styles) {
      let current = byStyle.get(style);
      let issues = current ? this.validateDraft(current, profile, source) : ['缺少该长度版本'];

      for (let attempt = 1; issues.length > 0 && attempt <= this.MAX_REWRITE_ATTEMPTS; attempt += 1) {
        logger.warn(`Draft ${style} validation failed (attempt ${attempt}): ${issues.join(', ')}`);
        current = await this.rewriteDraft(style, current, issues, source, profile, options, attempt);
        issues = this.validateDraft(current, profile, source);
        await this.delay(300);
      }

      if (!current) {
        throw new Error(`Failed to generate ${style} draft`);
      }

      if (issues.length > 0) {
        logger.warn(`Draft ${style} still failed after rewrite: ${issues.join(', ')}`);
        current = {
          ...current,
          reasoning: `${current.reasoning}（重写 ${this.MAX_REWRITE_ATTEMPTS} 次后仍有问题：${issues.join('、')}）`,
        };
      }

      finalized.push(current);
    }

    return finalized;
  }

  private validateDraft(draft: Draft, profile: AccountProfile, source: FilteredContent): string[] {
    const validation = StyleAnalyzer.validateDraft(draft.content, profile, {
      sourceTitle: source.content.title,
      sourceContent: source.content.content,
      style: draft.style,
    });

    if (!validation.valid) {
      logger.debug(`Draft content: ${draft.content}`);
    }

    return validation.issues;
  }

  private async rewriteDraft(
    style: DraftStyle,
    draft: Draft | undefined,
    issues: string[],
    source: FilteredContent,
    profile: AccountProfile,
    options: Required<DraftGenerationOptions>,
    attempt: number
  ): Promise<Draft> {
    const response = await this.chatClient.chat(this.buildRewritePrompt(style, draft, issues, source, profile), {
      temperature: Math.max(0.35, options.temperature - 0.1),
      maxTokens: this.getRewriteMaxTokens(style),
      systemPrompt:
        '你是一个中文 X/Twitter 草稿编辑。只按质检问题重写，不增加原文没有的信息，不写解释，不保留 AI 味套话。',
    });

    const parsed = this.parseDraftResponseSafely(response, options.maxLength).find(item => item.style === style);
    if (parsed) {
      return {
        ...parsed,
        reasoning: parsed.reasoning || `第 ${attempt} 次按质检问题重写`,
      };
    }

    const fallbackContent = this.sanitizeDraftContent(response);
    return {
      content: fallbackContent,
      style,
      reasoning: `第 ${attempt} 次按质检问题重写`,
      length: fallbackContent.length,
    };
  }

  private buildRewritePrompt(
    style: DraftStyle,
    draft: Draft | undefined,
    issues: string[],
    source: FilteredContent,
    profile: AccountProfile
  ): string {
    const sampleTweets = StyleAnalyzer.generateSampleTweetsText(profile);
    const lengthRule = {
      short: '60-120 字，不能换行，一句话快评，先给判断',
      medium: '150-260 字，最多 2 段，判断 + 关键理由',
      long: '320-650 字，最多 4 段，分段展开但不要写成文章',
    }[style];

    return `下面这条 ${style} 推文草稿没有通过质检，请按问题重写到合格。

历史推文样本：
${sampleTweets}

原始内容：
标题：${source.content.title}
摘要：${source.content.content}
推荐理由：${source.aiReason || '相关度高'}

不合格草稿：
${draft?.content || '（缺失）'}

质检问题：
${issues.map(issue => `- ${issue}`).join('\n')}

重写要求：
- 只输出 ${style} 版本
- ${lengthRule}
- 直接给判断，不要摘要腔、导读腔、公众号腔
- 不要使用“首先/其次/最后/第一层/核心是/本质上/没有之一/值得认真看/重新思考”等模板话
- 不要使用“值得关注/新底座/新思路/实打实利好”等低信息量词
- 不要照搬原文句子，不要编造亲测经历或账号历史项目
- 必须有一个明确判断或操作启发
- 正文不要包含链接、URL、[链接]

返回纯 JSON：
[
  {
    "content": "重写后的推文正文",
    "style": "${style}",
    "reasoning": "一句话说明这次修掉了什么问题"
  }
]`;
  }

  private getRewriteMaxTokens(style: DraftStyle): number {
    return {
      short: 500,
      medium: 900,
      long: 1400,
    }[style];
  }

  private parseDraftResponseSafely(response: string, maxLength: number): Draft[] {
    try {
      return this.parseResponse(response, maxLength);
    } catch {
      return [];
    }
  }

  private sanitizeDraftContent(content: string): string {
    return content
      .replace(/\[链接\]/g, '')
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+$/g, '')
      .trim();
  }

  private normalizeDraftStyle(style: unknown): DraftStyle {
    if (style === 'short' || style === 'medium' || style === 'long') {
      return style;
    }

    const legacyMap: Record<string, DraftStyle> = {
      opinion: 'short',
      share: 'medium',
      question: 'long',
    };

    if (typeof style === 'string' && legacyMap[style]) {
      return legacyMap[style];
    }

    return 'medium';
  }

  /**
   * 标准化选项
   */
  private normalizeOptions(options?: DraftGenerationOptions): Required<DraftGenerationOptions> {
    return {
      maxLength: options?.maxLength ?? this.MAX_LENGTH,
      styles: options?.styles ?? this.DEFAULT_STYLES,
      temperature: options?.temperature ?? 0.7,
    };
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
