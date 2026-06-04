import { logger } from '../utils/logger.js';

export type ScraperRuleSeverity = 'info' | 'warn' | 'critical';

export interface PlatformScraperRulePayload {
  enabled?: boolean;
  api?: Record<string, unknown>;
  browser?: Record<string, unknown>;
  probe?: Record<string, unknown>;
  parsing?: Record<string, unknown>;
}

export interface ScraperRuleRecord {
  platform: string;
  version: string;
  payload: PlatformScraperRulePayload;
  minClientVersion: string;
  message: string;
  severity: ScraperRuleSeverity;
  updatedAt: string;
}

export type ScraperRuleSet = Record<string, ScraperRuleRecord>;

interface CloudRulesResponse {
  rules?: ScraperRuleRecord[];
  error?: string;
}

export class CloudScraperRuleClient {
  private baseURL: string;
  private token: string;

  constructor(options: { baseURL: string; token: string }) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.token = options.token;
  }

  async fetchRules(clientVersion = process.env.npm_package_version || 'dev'): Promise<ScraperRuleSet> {
    if (!this.baseURL || !this.token) {
      return {};
    }

    const url = new URL(`${this.baseURL}/api/rules`);
    url.searchParams.set('clientVersion', clientVersion);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${this.token}`,
      },
    });
    const data = await response.json().catch(() => ({})) as CloudRulesResponse;
    if (!response.ok) {
      throw new Error(data.error || `规则拉取失败：${response.status}`);
    }

    const rules = Array.isArray(data.rules) ? data.rules : [];
    logger.info(`Loaded ${rules.length} scraper rules from Spark Cloud`);
    return Object.fromEntries(rules.map((rule) => [rule.platform, rule]));
  }
}

export function ruleRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function ruleString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function ruleNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function ruleStringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.map((item) => ruleString(item)).filter(Boolean)
    : fallback;
}

export function ruleNumberList(value: unknown, fallback: number[]): number[] {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter(Number.isFinite)
    : fallback;
}

export function renderRuleTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => encodeURIComponent(values[key] || ''));
}

export function compileRuleRegex(value: unknown, fallback: RegExp): RegExp {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  try {
    return new RegExp(value, 'i');
  } catch {
    return fallback;
  }
}
