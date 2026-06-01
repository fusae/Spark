import axios from 'axios';
import { FailureInfo, RecoverableFailure } from '../utils/failure.js';

export type SessionProbePlatform = 'douyin' | 'xiaohongshu';

export interface SessionProbeResult {
  ok: boolean;
  failure?: FailureInfo;
}

const headers = (cookie: string): Record<string, string> => ({
  Cookie: cookie,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
});

export async function probeCookieSession(
  platform: string,
  cookie: string
): Promise<SessionProbeResult | null> {
  if (platform === 'douyin') {
    return probeDouyinSession(cookie);
  }
  if (platform === 'xiaohongshu') {
    return probeXiaohongshuSession(cookie);
  }
  return null;
}

export function asRecoverableFailure(failure: FailureInfo): RecoverableFailure {
  return new RecoverableFailure(
    failure.failureType,
    failure.userMessage,
    failure.recoverable,
    failure.actionLabel
  );
}

async function probeDouyinSession(cookie: string): Promise<SessionProbeResult> {
  if (!cookie) {
    return failed('auth_required', '抖音需要先完成登录', true, '重新登录');
  }

  try {
    const response = await axios.get<Record<string, unknown>>(
      'https://www.douyin.com/aweme/v1/web/notice/count/',
      {
        headers: headers(cookie),
        timeout: 10000,
        validateStatus: () => true,
      }
    );
    const statusCode = numberValue(response.data?.status_code);
    const message = stringValue(response.data?.status_msg);

    if (response.status === 200 && statusCode === 0) {
      return { ok: true };
    }
    if (response.status === 401 || response.status === 403 || statusCode === 8 || statusCode === 2483) {
      return failed('auth_required', '抖音登录态失效，需要重新登录', true, '重新登录');
    }
    if (isCaptchaMessage(message)) {
      return failed('captcha_required', '抖音触发验证码或风控，需要人工验证', true, '处理验证');
    }
    return httpFailure('抖音', response.status, message);
  } catch (error) {
    return networkFailure('抖音', error);
  }
}

async function probeXiaohongshuSession(cookie: string): Promise<SessionProbeResult> {
  if (!cookie) {
    return failed('auth_required', '小红书需要先完成登录', true, '重新登录');
  }

  try {
    const response = await axios.get<Record<string, unknown>>(
      'https://edith.xiaohongshu.com/api/sns/web/unread_count',
      {
        headers: headers(cookie),
        timeout: 10000,
        validateStatus: () => true,
      }
    );
    const data = recordValue(response.data?.data);
    const code = numberValue(response.data?.code);
    const message = stringValue(response.data?.msg);

    if (
      response.status === 200 &&
      code === 0 &&
      response.data?.success === true &&
      data &&
      Object.keys(data).length > 0
    ) {
      return { ok: true };
    }
    if (response.status === 401 || response.status === 403 || code === -101) {
      return failed('auth_required', '小红书登录态失效，需要重新登录', true, '重新登录');
    }
    if (response.status === 200 && code === 0 && response.data?.success === true) {
      return failed(
        'auth_required',
        '小红书登录态不完整或已半失效，需要重新登录并完成验证',
        true,
        '重新登录'
      );
    }
    if (isCaptchaMessage(message)) {
      return failed('captcha_required', '小红书触发验证码或风控，需要人工验证', true, '处理验证');
    }
    return httpFailure('小红书', response.status, message);
  } catch (error) {
    return networkFailure('小红书', error);
  }
}

function failed(
  failureType: FailureInfo['failureType'],
  userMessage: string,
  recoverable: boolean,
  actionLabel?: string
): SessionProbeResult {
  return {
    ok: false,
    failure: { failureType, userMessage, recoverable, actionLabel },
  };
}

function httpFailure(label: string, status: number, message: string): SessionProbeResult {
  if (status === 429 || status >= 500) {
    return failed('network', `${label}验证接口暂时不可用，稍后会自动重试`, true);
  }
  return failed(
    'platform_changed',
    `${label}登录验证接口返回异常${message ? `：${message}` : ''}`,
    false,
    '等待适配'
  );
}

function networkFailure(label: string, error: unknown): SessionProbeResult {
  const message = error instanceof Error ? error.message : String(error || '');
  return failed('network', `${label}登录验证网络异常：${message}`, true);
}

function isCaptchaMessage(message: string): boolean {
  return /captcha|验证码|安全验证|滑块|风控|risk control|risk_control|verify/i.test(message);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
