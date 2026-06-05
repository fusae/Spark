import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { createServer, get as httpGet } from 'http';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const { autoUpdater } = electronUpdater;

let mainWindow: BrowserWindow | null = null;
let adminProcess: ChildProcess | null = null;
let adminUrl = '';
let adminLogPath = '';
let adminPort = 0;
let restartAttempts = 0;
let isQuitting = false;
let manualUpdateCheck = false;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate local port')));
        return;
      }

      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function waitForHttp(url: string, timeoutMs = 30000): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = (): void => {
      const request = httpGet(url, (response) => {
        response.resume();
        if ((response.statusCode || 0) < 500) {
          resolve();
          return;
        }

        retry();
      });

      request.on('error', retry);
      request.setTimeout(2000, () => {
        request.destroy();
        retry();
      });
    };

    const retry = (): void => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Spark 后台启动超时'));
        return;
      }

      setTimeout(check, 500);
    };

    check();
  });
}

function runtimeEnv(port: number): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.ADMIN_HOST = '127.0.0.1';
  env.ADMIN_PORT = String(port);
  env.SPARK_CLIENT_VERSION = app.getVersion();
  applySystemProxyEnv(env);

  if (app.isPackaged) {
    const runtimeDir = join(app.getPath('userData'), 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    adminLogPath = join(runtimeDir, 'desktop-admin.log');
    env.DB_PATH ||= join(runtimeDir, 'scout.db');
    env.LOG_FILE ||= join(runtimeDir, 'app.log');
    env.LOCAL_LOGIN_PROFILE_DIR ||= join(runtimeDir, 'browser-profiles');
    env.CREDENTIAL_ENCRYPTION_KEY ||= loadOrCreateCredentialKey(runtimeDir);
  }

  return env;
}

function loadOrCreateCredentialKey(runtimeDir: string): string {
  const keyPath = join(runtimeDir, 'credential.key');
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf8').trim();
  }

  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return key;
}

function applySystemProxyEnv(env: NodeJS.ProcessEnv): void {
  if (process.platform !== 'darwin') {
    return;
  }

  removeUnavailableLocalProxyEnv(env);

  const proxy = readMacSystemProxy();
  if (!proxy) {
    return;
  }

  if (!proxy.endpoints.some((endpoint) => canConnectToProxyEndpoint(endpoint))) {
    return;
  }

  env.http_proxy ||= proxy.httpProxy;
  env.HTTP_PROXY ||= proxy.httpProxy;
  env.https_proxy ||= proxy.httpsProxy;
  env.HTTPS_PROXY ||= proxy.httpsProxy;
  env.no_proxy ||= 'localhost,127.0.0.1';
  env.NO_PROXY ||= env.no_proxy;
}

interface ProxyEndpoint {
  host: string;
  port: string;
}

function readMacSystemProxy(): { httpProxy: string; httpsProxy: string; endpoints: ProxyEndpoint[] } | null {
  try {
    const output = execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const values = Object.fromEntries(
      output
        .split('\n')
        .map((line) => line.trim().match(/^([A-Z]+(?:Proxy|Port|Enable))\s+:\s+(.+)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => [match[1], match[2]])
    );

    const httpEndpoint = proxyEndpoint(values.HTTPEnable, values.HTTPProxy, values.HTTPPort);
    const httpsEndpoint = proxyEndpoint(values.HTTPSEnable, values.HTTPSProxy, values.HTTPSPort);
    const socksEndpoint = proxyEndpoint(values.SOCKSEnable, values.SOCKSProxy, values.SOCKSPort);
    const httpProxy = proxyUrl(httpEndpoint, 'http');
    const httpsProxy = proxyUrl(httpsEndpoint, 'http');
    const socksProxy = proxyUrl(socksEndpoint, 'socks5');
    const fallback = httpProxy || socksProxy;
    const secureFallback = httpsProxy || fallback;
    const endpoints = [httpEndpoint, httpsEndpoint, socksEndpoint].filter(
      (endpoint): endpoint is ProxyEndpoint => Boolean(endpoint)
    );
    return fallback && secureFallback
      ? { httpProxy: fallback, httpsProxy: secureFallback, endpoints }
      : null;
  } catch {
    return null;
  }
}

function proxyEndpoint(
  enabled: string | undefined,
  host: string | undefined,
  port: string | undefined
): ProxyEndpoint | null {
  if (enabled !== '1' || !host || !port) {
    return null;
  }

  return { host, port };
}

function proxyUrl(endpoint: ProxyEndpoint | null, scheme: string): string {
  return endpoint ? `${scheme}://${endpoint.host}:${endpoint.port}` : '';
}

function removeUnavailableLocalProxyEnv(env: NodeJS.ProcessEnv): void {
  for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const endpoint = proxyEndpointFromUrl(env[key]);
    if (endpoint && isLocalProxyHost(endpoint.host) && !canConnectToProxyEndpoint(endpoint)) {
      delete env[key];
    }
  }
}

function proxyEndpointFromUrl(value: string | undefined): ProxyEndpoint | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    return parsed.hostname && parsed.port ? { host: parsed.hostname, port: parsed.port } : null;
  } catch {
    return null;
  }
}

function isLocalProxyHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

function canConnectToProxyEndpoint(endpoint: ProxyEndpoint): boolean {
  try {
    execFileSync('/usr/bin/nc', ['-z', '-G', '1', endpoint.host, endpoint.port], {
      stdio: 'ignore',
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

function serverScriptPath(): string {
  return join(appRootPath(), 'dist', 'web', 'admin-server.js');
}

function appIconPath(): string {
  return join(appRootPath(), 'assets', 'spark-icon.png');
}

function appRootPath(): string {
  return app.isPackaged ? app.getAppPath() : process.cwd();
}

function startAdminServer(port: number): void {
  const env = runtimeEnv(port);
  const command = app.isPackaged ? process.execPath : 'node';
  const childEnv = app.isPackaged
    ? { ...env, ELECTRON_RUN_AS_NODE: '1' }
    : env;

  adminProcess = spawn(command, [serverScriptPath()], {
    cwd: app.isPackaged ? app.getPath('userData') : appRootPath(),
    env: childEnv,
    stdio: app.isPackaged ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (app.isPackaged && adminLogPath) {
    const logStream = createWriteStream(adminLogPath, { flags: 'a' });
    logStream.write(`\n--- ${new Date().toISOString()} ---\n`);
    adminProcess.stdout?.pipe(logStream, { end: false });
    adminProcess.stderr?.pipe(logStream, { end: false });
    adminProcess.once('exit', () => {
      logStream.end();
    });
  }

  adminProcess.once('exit', (code) => {
    adminProcess = null;
    if (!isQuitting) {
      if (restartAttempts < 3 && adminPort) {
        restartAttempts += 1;
        setTimeout(() => {
          startAdminServer(adminPort);
          void waitForHttp(adminUrl)
            .then(async () => {
              await mainWindow?.loadURL(adminUrl);
            })
            .catch((error: Error) => showBackendExitDialog(code, error.message));
        }, 1000);
        return;
      }

      showBackendExitDialog(code);
    }
  });
}

function showBackendExitDialog(code: number | null, extraDetail = ''): void {
  void dialog.showMessageBox({
    type: 'error',
    title: 'Spark',
    message: '后台服务已退出',
    detail: [
      code === null ? '进程被终止。' : `退出码：${code}`,
      extraDetail,
      adminLogPath ? `日志：${adminLogPath}` : '',
    ].filter(Boolean).join('\n'),
  });
}

function showMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

function checkForUpdates(manual = false): void {
  if (!app.isPackaged) {
    if (manual) {
      void showMessage({
        type: 'info',
        title: 'Spark',
        message: '开发模式不会检查更新',
        detail: '打包后的安装版会从 GitHub Releases 检查新版本。',
      });
    }
    return;
  }

  manualUpdateCheck = manual;
  autoUpdater.checkForUpdates().catch((error: Error) => {
    if (manual) {
      void showMessage({
        type: 'error',
        title: 'Spark 更新失败',
        message: '检查更新失败',
        detail: error.message,
      });
    }
  });
}

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    void showMessage({
      type: 'info',
      title: 'Spark 有新版本',
      message: `发现 Spark ${info.version}`,
      detail: '正在后台下载，下载完成后会提示重启。',
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (manualUpdateCheck) {
      void showMessage({
        type: 'info',
        title: 'Spark',
        message: '当前已经是最新版本',
      });
    }
    manualUpdateCheck = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    manualUpdateCheck = false;
    void showMessage({
      type: 'info',
      buttons: ['重启更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: 'Spark 更新已下载',
      message: `Spark ${info.version} 已准备好`,
      detail: '重启应用后生效。',
    }).then(({ response }) => {
      if (response === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (error) => {
    if (manualUpdateCheck) {
      void showMessage({
        type: 'error',
        title: 'Spark 更新失败',
        message: '检查更新失败',
        detail: error.message,
      });
    }
    manualUpdateCheck = false;
  });
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Spark',
      submenu: [
        {
          label: '在浏览器打开',
          click: () => {
            if (adminUrl) {
              void shell.openExternal(adminUrl);
            }
          },
        },
        {
          label: '检查更新',
          click: () => checkForUpdates(true),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  const port = await findFreePort();
  adminPort = port;
  adminUrl = `http://127.0.0.1:${port}`;
  startAdminServer(port);
  await waitForHttp(adminUrl);
  restartAttempts = 0;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: 'Spark',
    icon: appIconPath(),
    backgroundColor: '#f5f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(adminUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function stopAdminServer(): void {
  if (adminProcess && !adminProcess.killed) {
    adminProcess.kill();
  }
}

app.on('before-quit', () => {
  isQuitting = true;
  stopAdminServer();
});

app.whenReady()
  .then(async () => {
    if (process.platform === 'darwin') {
      app.dock?.setIcon(appIconPath());
    }
    createMenu();
    await createWindow();
    setupAutoUpdater();
    setTimeout(() => checkForUpdates(), 3000);
  })
  .catch((error: Error) => {
    void dialog.showErrorBox('Spark 启动失败', error.message);
    app.quit();
  });

app.on('activate', () => {
  if (!mainWindow) {
    void createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
