import { existsSync } from 'fs';
import { resolve } from 'path';
import puppeteer, { Browser } from 'puppeteer';
import { localBrowserLaunchOptions } from '../utils/browser-launcher.js';

type LocalBrowserPlatform = 'douyin' | 'xiaohongshu' | 'zhihu' | 'weibo';
const profileQueues = new Map<string, Promise<void>>();

export function getLocalBrowserProfileDir(
  platform: LocalBrowserPlatform,
  userId = process.env.USER_ID || 'local'
): string {
  const root = process.env.LOCAL_LOGIN_PROFILE_DIR || './data/browser-profiles';
  return resolve(root, safeFileName(userId), platform);
}

export function hasLocalBrowserProfile(
  platform: LocalBrowserPlatform,
  userId?: string
): boolean {
  return existsSync(getLocalBrowserProfileDir(platform, userId));
}

export async function launchLocalBrowser(
  platform: LocalBrowserPlatform,
  userId?: string,
  headless = process.env.LOCAL_SCRAPER_HEADLESS !== 'false'
): Promise<Browser> {
  const profileDir = getLocalBrowserProfileDir(platform, userId);
  const release = await acquireProfile(profileDir);

  try {
    const browser = await puppeteer.launch(localBrowserLaunchOptions(profileDir, headless));
    const closeBrowser = browser.close.bind(browser);
    let released = false;
    const releaseOnce = (): void => {
      if (!released) {
        released = true;
        release();
      }
    };

    browser.close = async (): Promise<void> => {
      try {
        await closeBrowser();
      } finally {
        releaseOnce();
      }
    };
    browser.once('disconnected', releaseOnce);
    return browser;
  } catch (error) {
    release();
    throw error;
  }
}

async function acquireProfile(profileDir: string): Promise<() => void> {
  const previous = profileQueues.get(profileDir) || Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolveCurrentPromise) => {
    resolveCurrent = resolveCurrentPromise;
  });
  const queued = previous.then(() => current);
  profileQueues.set(profileDir, queued);
  await previous;

  return () => {
    resolveCurrent();
    if (profileQueues.get(profileDir) === queued) {
      profileQueues.delete(profileDir);
    }
  };
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'local';
}
