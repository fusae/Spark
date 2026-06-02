-- 账号画像表
CREATE TABLE IF NOT EXISTS account_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_handle TEXT NOT NULL UNIQUE,
  bio TEXT,
  topics TEXT, -- JSON array
  writing_style TEXT, -- JSON object
  interests TEXT, -- JSON array
  audience TEXT, -- 目标受众描述
  sample_tweets TEXT, -- JSON array
  interest_vector TEXT, -- Serialized vector (768-dim)
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tweet_count INTEGER DEFAULT 0
);

-- 内容池表
CREATE TABLE IF NOT EXISTS content_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL DEFAULT 'local',
  source TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  url TEXT,
  author TEXT,
  published_at TIMESTAMP,
  metrics TEXT, -- JSON object
  collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  embedding_vector TEXT, -- Serialized vector
  UNIQUE(user_id, url)
);

-- 推荐记录表
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  content_id INTEGER NOT NULL,
  match_score REAL NOT NULL,
  match_reason TEXT,
  drafts TEXT, -- JSON array
  recommended_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'pending', -- pending, approved, rejected, posted
  user_feedback TEXT,
  FOREIGN KEY (content_id) REFERENCES content_pool(id) ON DELETE CASCADE
);

-- 反馈学习表
CREATE TABLE IF NOT EXISTS feedback_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recommendation_id INTEGER NOT NULL,
  action TEXT NOT NULL, -- approved, rejected, modified, posted
  modified_draft TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE CASCADE
);

-- SaaS/本地共用：用户运行配置
CREATE TABLE IF NOT EXISTS runtime_users (
  user_id TEXT PRIMARY KEY,
  account_handle TEXT NOT NULL,
  profile_path TEXT,
  cron_schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  rate_limit_max_concurrent INTEGER NOT NULL,
  rate_limit_request_delay_ms INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- SaaS/本地共用：飞书配置
CREATE TABLE IF NOT EXISTS runtime_lark_configs (
  user_id TEXT PRIMARY KEY,
  app_id TEXT,
  app_secret_encrypted TEXT,
  base_id TEXT,
  default_receiver_id TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES runtime_users(user_id) ON DELETE CASCADE
);

-- SaaS/本地共用：数据源配置
CREATE TABLE IF NOT EXISTS runtime_source_configs (
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, source),
  FOREIGN KEY (user_id) REFERENCES runtime_users(user_id) ON DELETE CASCADE
);

-- SaaS/本地共用：平台登录态/密钥，值由上层加密后写入
CREATE TABLE IF NOT EXISTS runtime_credentials (
  user_id TEXT NOT NULL,
  credential_key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, credential_key),
  FOREIGN KEY (user_id) REFERENCES runtime_users(user_id) ON DELETE CASCADE
);

-- SaaS/本地共用：平台登录态验证结果
CREATE TABLE IF NOT EXISTS runtime_credential_checks (
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL, -- unknown, valid, invalid
  message TEXT,
  checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, platform),
  FOREIGN KEY (user_id) REFERENCES runtime_users(user_id) ON DELETE CASCADE
);

-- SaaS/本地共用：任务队列
CREATE TABLE IF NOT EXISTS runtime_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT,
  scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  run_log_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES runtime_users(user_id) ON DELETE CASCADE
);

-- SaaS/本地共用：运行日志
CREATE TABLE IF NOT EXISTS runtime_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP,
  message TEXT,
  stats_json TEXT,
  error TEXT,
  FOREIGN KEY (user_id) REFERENCES runtime_users(user_id) ON DELETE CASCADE
);

-- 创建索引以提升查询性能
CREATE INDEX IF NOT EXISTS idx_content_pool_url ON content_pool(url);
CREATE INDEX IF NOT EXISTS idx_content_pool_collected_at ON content_pool(collected_at);
CREATE INDEX IF NOT EXISTS idx_recommendations_content_id ON recommendations(content_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
CREATE INDEX IF NOT EXISTS idx_feedback_log_recommendation_id ON feedback_log(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_runtime_source_configs_source ON runtime_source_configs(source);
CREATE INDEX IF NOT EXISTS idx_runtime_credentials_key ON runtime_credentials(credential_key);
CREATE INDEX IF NOT EXISTS idx_runtime_credential_checks_platform ON runtime_credential_checks(platform);
CREATE INDEX IF NOT EXISTS idx_runtime_jobs_status ON runtime_jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_runtime_jobs_user_id ON runtime_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_runtime_run_logs_user_id ON runtime_run_logs(user_id, started_at);
