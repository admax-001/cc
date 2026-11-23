-- 黑小帅 V2 互动侧数据模型（D1 / SQLite，全部幂等 CREATE IF NOT EXISTS）
-- 从原版小石榴 18 表 MySQL schema 移植适配：关注 / 点赞 / 收藏 / 通知 / 会话

-- ---- 关注关系 ----
CREATE TABLE IF NOT EXISTS follows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id  INTEGER NOT NULL REFERENCES users(id),
  following_id INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

-- ---- 点赞（target_type：1-笔记，2-评论）----
CREATE TABLE IF NOT EXISTS likes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  target_type INTEGER NOT NULL DEFAULT 1,
  target_id   INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id);

-- ---- 收藏 ----
CREATE TABLE IF NOT EXISTS collections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  post_id    INTEGER NOT NULL REFERENCES posts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_collections_post ON collections(post_id);

-- ---- 通知（type：1-点赞，2-评论/回复，3-关注）----
CREATE TABLE IF NOT EXISTS notifications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  sender_id         INTEGER NOT NULL REFERENCES users(id),
  type              INTEGER NOT NULL,
  title             TEXT NOT NULL,
  content           TEXT,
  target_id         INTEGER,
  target_comment_id INTEGER,
  is_read           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);

-- ---- 用户会话（登出吊销 / 多端管理，token_id 即 JWT 的 jti）----
CREATE TABLE IF NOT EXISTS user_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_id   TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- ---- 注册图形验证码（一次性，5 分钟过期；插入时顺带清理过期行）----
CREATE TABLE IF NOT EXISTS captchas (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
