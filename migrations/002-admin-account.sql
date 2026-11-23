-- V3 管理员引导：部署后首个注册账号成为唯一管理员
-- 幂等性：deploy.mjs 对 duplicate column 报错自动跳过

-- 管理员标记（0-普通用户，1-管理员）
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- 数据库级唯一性兜底：is_admin=1 的行最多一条（SQLite 部分唯一索引）
-- 即使并发竞态下两个注册同时尝试成为管理员，也只允许一条成功
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_admin ON users(is_admin) WHERE is_admin = 1;
