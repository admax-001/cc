-- V3 管理侧数据模型（幂等：deploy.mjs 对 duplicate column 容错）

-- users：账号状态（封禁/激活）+ 编辑表单字段
ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN zodiac_sign TEXT;
ALTER TABLE users ADD COLUMN education TEXT;
ALTER TABLE users ADD COLUMN major TEXT;

-- comments：审核状态（0-待审核，1-正常，2-审核未通过）
ALTER TABLE comments ADD COLUMN status INTEGER NOT NULL DEFAULT 1;

-- 用户封禁记录（原版 user_ban 表移植）
CREATE TABLE IF NOT EXISTS user_ban (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  reason     TEXT NOT NULL,
  end_time   TEXT,
  status     INTEGER NOT NULL DEFAULT 0,  -- 0封禁中 1管理员解封 2自动解封 3永久 4撤销
  operator   INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_ban_user ON user_ban(user_id);

-- 审核记录（原版 audit 表移植：1用户 2官方认证 3内容 4评论）
CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER,
  type       INTEGER NOT NULL,
  target_id  INTEGER NOT NULL,
  source     INTEGER DEFAULT 1,  -- 1发布自检 2用户举报 3定时巡检
  remark     TEXT,
  status     INTEGER NOT NULL DEFAULT 0,  -- 0待审核 1通过 2拒绝
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  audit_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit(type, target_id);

-- 举报工单（原版 reports 表移植：target 1笔记 2评论）
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  target_type INTEGER NOT NULL,
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT,
  status      INTEGER NOT NULL DEFAULT 0,  -- 0待处理 1违规 2不违规
  handle_note TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
