import { existsSync } from 'fs';
import { join } from 'path';
import type puppeteer from 'puppeteer';

type LocalBrowserLaunchOptions = NonNullable<Parameters<typeof puppeteer.launch>[0]>;

export function localBrowserLaunchOptions(
  userDataDir: string,
  headless = false
): LocalBrowserLaunchOptions {
  const executablePath = findBrowserExecutable();

  return {
    headless,
    userDataDir,
    executablePath,
    defaultViewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  };
}

export function findBrowserExecutable(): string | undefined {
  const configured = process.env.LOCAL_BROWSER_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) {
    return configured;
  }

  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function browserCandidates(): string[] {
  if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter((value): value is string => Boolean(value));

    return roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ]);
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/brave-browser',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}
