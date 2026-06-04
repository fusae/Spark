import { AccountProfile } from '../profile/types.js';
import { logger } from '../utils/logger.js';

interface DraftValidationContext {
  sourceTitle?: string;
  sourceContent?: string;
  style?: 'short' | 'medium' | 'long';
}

/**
 * 风格分析器
 * 分析账号画像，提取写作风格特征
 */
export class StyleAnalyzer {
  private static readonly BANNED_DRAFT_PATTERNS: RegExp[] = [
    /^(这篇文章|这个项目|这个内容|推荐阅读|值得一看|点击查看|了解更多)/,
    /(首先|其次|最后|第一层|第二层|第三层|第一点|第二点|第三点|一方面|另一方面)/,
    /(核心是|本质上|归根结底|没有之一|值得认真看|重新思考|给开发者一把钥匙|效果上了一个台阶|角色发生转变)/,
    /(新闻稿|导读|摘要如下|本文|文章认为)/,
    /(https?:\/\/|www\.|［?链接］?|\[链接\])/i,
  ];

  private static readonly AI_FINGERPRINT_PATTERNS: RegExp[] = [
    /(不是[^，。！？\n]{1,24}，?而是[^，。！？\n]{1,40})/,
    /(你可能会觉得|很多人会觉得|有人可能会说|但事实是|真相是)/,
    /(值得注意的是|更重要的是|换句话说|从这个角度看|这背后反映了)/,
    /(作为一个|关于这个|基于这个|进行一个|赋能|抓手|闭环|链路|底座)/,
    /(这也说明|这再次证明|这件事提醒我们)/,
  ];

  private static readonly LOW_SIGNAL_PHRASES = [
    '开源思路值得一试',
    '值得自己动手试试',
    '值得关注',
    '实打实的利好',
    '新底座',
    '新思路',
    '成本最低',
    '效果最好',
    '明显上了一个台阶',
  ];

  /**
   * 生成风格描述文本
   * 用于 prompt 构建
   */
  static generateStyleDescription(profile: AccountProfile): string {
    const { writingStyle, topics, interests, audience } = profile;

    const description = `
账号风格特征：
- 语气：${writingStyle.tone}
- 平均长度：${writingStyle.avgLength} 字符
- Emoji 使用：${writingStyle.emojiUsage}
- 常用 Emoji：${writingStyle.commonEmojis.join(' ')}
- 推文结构：${writingStyle.structure || '像真人短帖，先给判断，再给理由'}

主题领域：
${topics.join(', ')}

兴趣方向：
${interests.join(', ')}

目标受众：
${audience}
`.trim();

    return description;
  }

  /**
   * 生成历史推文样本文本
   */
  static generateSampleTweetsText(profile: AccountProfile): string {
    if (!profile.sampleTweets || profile.sampleTweets.length === 0) {
      return '（无历史推文样本）';
    }

    return profile.sampleTweets
      .slice(0, 5) // 最多取 5 条
      .map((tweet, index) => `${index + 1}. ${tweet.text} (${tweet.likes} likes)`)
      .join('\n---\n');
  }

  /**
   * 计算目标长度范围
   */
  static calculateTargetLength(profile: AccountProfile): { min: number; max: number } {
    const avgLength = profile.writingStyle.avgLength;
    const variance = 120; // 宽松建议范围，仅用于 prompt，不作为硬约束

    return {
      min: Math.max(30, avgLength - variance),
      max: Math.min(4000, avgLength + variance),
    };
  }

  /**
   * 分析 Emoji 使用策略
   */
  static analyzeEmojiStrategy(profile: AccountProfile): string {
    const usage = profile.writingStyle.emojiUsage.toLowerCase();

    if (usage.includes('很少') || usage.includes('rare')) {
      return '尽量不使用 emoji，保持专业简洁';
    } else if (usage.includes('适中') || usage.includes('moderate')) {
      return `适度使用 emoji，优先使用：${profile.writingStyle.commonEmojis.slice(0, 3).join(' ')}`;
    } else if (usage.includes('频繁') || usage.includes('frequent')) {
      return `可以多使用 emoji 增强表达，常用：${profile.writingStyle.commonEmojis.join(' ')}`;
    }

    return '根据内容适当使用 emoji';
  }

  /**
   * 验证草稿是否符合风格
   */
  static validateDraft(draft: string, profile: AccountProfile, context: DraftValidationContext = {}): {
    valid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];

    // 1. 检查长度
    if (draft.length > 4000) {
      issues.push(`超过 4000 字符限制 (当前: ${draft.length})`);
    }

    const styleRange = this.getStyleLengthRange(context.style);
    if (styleRange && (draft.length < styleRange.min || draft.length > styleRange.max)) {
      issues.push(`${styleRange.label}长度不合格 (当前: ${draft.length}, 需要: ${styleRange.min}-${styleRange.max})`);
    }

    if (draft.trim().length < 20) {
      issues.push('内容过短，缺少可发布观点');
    }

    for (const pattern of this.BANNED_DRAFT_PATTERNS) {
      if (pattern.test(draft)) {
        issues.push('包含摘要腔、模板话或导流内容');
        break;
      }
    }

    if (this.looksLikeListicle(draft)) {
      issues.push('结构过像文章提纲，不像自然推文');
    }

    const aiFingerprintCount = this.countMatches(draft, this.AI_FINGERPRINT_PATTERNS);
    if (aiFingerprintCount >= 2) {
      issues.push(`AI 写作指纹过多 (当前: ${aiFingerprintCount})`);
    }

    const lowSignalCount = this.LOW_SIGNAL_PHRASES.filter(phrase => draft.includes(phrase)).length;
    if (lowSignalCount > 0) {
      issues.push('包含低信息量套话');
    }

    if (this.looksLikeSourceRewrite(draft, context)) {
      issues.push('太像原文改写，缺少自己的判断');
    }

    if (!this.hasJudgementSignal(draft)) {
      issues.push('缺少明确判断或操作启发');
    }

    // 2. 检查 Emoji 使用
    const emojiCount = this.countEmojis(draft);
    const usage = profile.writingStyle.emojiUsage.toLowerCase();

    if (usage.includes('很少') && emojiCount > 1) {
      issues.push(`Emoji 使用过多 (当前: ${emojiCount}, 该账号很少使用 emoji)`);
    } else if (usage.includes('频繁') && emojiCount === 0) {
      issues.push('缺少 emoji（该账号通常会使用 emoji）');
    }

    // 3. 检查是否包含链接占位符
    if (!draft.includes('http') && !draft.includes('[链接]')) {
      logger.debug('Draft does not contain URL placeholder');
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * 统计 emoji 数量
   */
  private static countEmojis(text: string): number {
    // 简单的 emoji 检测（匹配 Unicode emoji 范围）
    const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
    const matches = text.match(emojiRegex);
    return matches ? matches.length : 0;
  }

  private static looksLikeListicle(text: string): boolean {
    const numberedMarkers = text.match(/(^|\n)\s*(\d+[.、]|[一二三四五六七八九十]+[、.])/g);
    return (numberedMarkers?.length || 0) >= 2;
  }

  private static countMatches(text: string, patterns: RegExp[]): number {
    return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  }

  private static looksLikeSourceRewrite(text: string, context: DraftValidationContext): boolean {
    const source = `${context.sourceTitle || ''}\n${context.sourceContent || ''}`.trim();
    if (!source) {
      return false;
    }

    const normalizedDraft = this.normalizeText(text);
    const normalizedSource = this.normalizeText(source);
    if (normalizedDraft.length < 40 || normalizedSource.length < 40) {
      return false;
    }

    const draftChunks = this.getTextChunks(normalizedDraft);
    if (draftChunks.length === 0) {
      return false;
    }

    const copiedChunks = draftChunks.filter(chunk => normalizedSource.includes(chunk)).length;
    return copiedChunks / draftChunks.length >= 0.55;
  }

  private static hasJudgementSignal(text: string): boolean {
    return /(我觉得|我更关心|我会|我一般|问题是|关键是|麻烦在|好处是|风险是|看起来|可能|如果属实|这类|这种|适合|不适合|靠谱|不靠谱|值得|没必要|应该|可以|别|先|别急)/.test(text);
  }

  private static normalizeText(text: string): string {
    return text.replace(/\s+/g, '').replace(/[，。！？、,.!?;；:："'“”‘’()[\]【】]/g, '');
  }

  private static getTextChunks(text: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i <= text.length - 12; i += 6) {
      chunks.push(text.slice(i, i + 12));
    }
    return chunks;
  }

  private static getStyleLengthRange(style?: 'short' | 'medium' | 'long'): {
    min: number;
    max: number;
    label: string;
  } | undefined {
    if (style === 'short') {
      return { min: 45, max: 130, label: '短版' };
    }

    if (style === 'medium') {
      return { min: 120, max: 320, label: '中版' };
    }

    if (style === 'long') {
      return { min: 260, max: 760, label: '长版' };
    }

    return undefined;
  }
}
