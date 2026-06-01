# Spark

每天发现值得写的内容。

面向内容创作者的 AI 内容发现、筛选、草稿生成和推送助手。

## 快速开始

### 安装版

从 GitHub Releases 下载对应系统的安装包，安装后直接打开 Spark。首次启动会进入引导页，按页面提示选择平台、填写关键词、连接 AI 服务和设置推送方式。

### 桌面启动

从源码运行时，macOS 可以直接双击 `Spark.command`。首次启动会自动安装依赖，然后打开桌面管理窗口。

也可以手动运行：

```bash
npm install
npm run desktop
```

生成本机安装包：

```bash
npm run desktop:dist
```

产物会输出到 `release/`。

生成指定平台安装包：

```bash
npm run desktop:dist:mac
npm run desktop:dist:win
npm run desktop:dist:linux
```

Windows 用户需要先安装 Node.js 20+，然后下载源码，在 Windows 本机双击 `Build-Windows.cmd`；脚本会自动安装依赖并生成 Windows 安装包到 `release/`。

因为 Spark 使用原生 SQLite 依赖，Windows 安装包建议在 Windows 本机或 GitHub Actions 的 Windows 环境构建。

也可以直接用 GitHub Actions 构建：推送 `v*` 标签后，`.github/workflows/desktop-release.yml` 会分别在 macOS 和 Windows 环境生成安装包并上传到 GitHub Release。

### Web 管理后台

```bash
npm install
npm run admin
```

默认地址：`http://127.0.0.1:8787`

## 配置

复制模板并填写配置：

```bash
cp .env.example .env
cp config/profile.example.json config/profile.local.json
```

常用配置：

```bash
PROFILE_PATH=./config/profile.local.json
EMBEDDING_API_KEY=your_dashscope_api_key
DEEPSEEK_API_KEY=your_deepseek_api_key
LARK_APP_ID=your_lark_app_id
LARK_APP_SECRET=your_lark_app_secret
FEISHU_DEFAULT_RECEIVER_ID=your_open_id_or_chat_id
```

`config/profile.local.json` 用来存放你的账号画像、兴趣和样例内容；它已被 `.gitignore` 排除，不会进入仓库。

### 登录平台

知乎、微博、抖音和小红书需要在本机完成登录。Spark 会把登录状态保存在本机数据目录，不会上传到服务器；桌面安装版会自动生成本机密钥，加密保存 Cookie 和 API Key。

正常抓取默认在后台运行，不会弹出浏览器。遇到登录失效或验证码时，Spark 会按顺序逐个平台打开登录窗口；处理完成后只补抓失败平台，不重复抓取已经成功的平台。

概览页会显示浏览器、凭证保护和后台抓取状态，环境异常时会直接给出提示。

抖音和小红书会在抓取前进行登录态探测，并在真实关键词搜索失败时区分登录过期、验证码和平台改版。

## 可用命令

- `npm run admin`：启动 Web 管理后台
- `npm run desktop`：启动桌面管理壳
- `npm run build`：编译 TypeScript
- `npm run desktop:dist`：生成安装包
- `npm run desktop:dist:win`：生成 Windows 安装包
- `npm run db:init`：初始化数据库
- `npm run lint`：代码检查

## 自动更新

桌面安装版会从 GitHub Releases 检查更新。发布新版本时，更新 `package.json` 里的 `version`，运行打包命令，然后把 `release/` 里的安装包和更新元数据上传到 GitHub Release。

使用自动发布：

```bash
git tag v0.1.1
git push origin v0.1.1
```

## 数据库表结构

### account_profile (账号画像)
- 存储创作者画像、兴趣和内容风格

### content_pool (内容池)
- 存储收集的内容素材

### recommendations (推荐记录)
- 存储内容推荐和匹配结果

### feedback_log (反馈日志)
- 存储用户反馈用于学习优化

## 技术栈

- TypeScript 5.3+
- Node.js 20+
- SQLite (better-sqlite3)
- Winston (日志)
- 阿里云百炼 Embedding
- 飞书 API

## 开源约定

- 仓库只保留通用画像样例，真实画像请放在 `config/profile.local.json`
- `.env`、`node_modules/`、`data/*.db*`、`logs/`、`dist/`、`release/` 都不会进入版本控制
- 不要提交平台 Cookie、飞书凭证、AI API Key 或真实用户画像

## 内容渠道

- 可直接运行：Hacker News、GitHub Trending、Reddit RSS、V2EX
- 需要登录：知乎、微博、抖音、小红书
- 需要凭证：Product Hunt（`PRODUCTHUNT_API_TOKEN`）
- 暂不推荐：X（官方 API 成本较高）

抖音和小红书存在平台风控，可能需要人工完成滑块或验证码。Spark 会识别登录失效、验证码、网络异常和页面改版，单个平台失败不会中断其他平台。
