-- V2 互动侧字段迁移（一次性 ALTER，幂等性由 deploy.mjs 容错 duplicate column 保证）
-- 执行顺序：schema.sql（V1 七表）→ 本文件 → v2-schema.sql（V2 新表）→ seed.sql

-- users：登录体系 + 认证 + 计数冗余
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN follow_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN fans_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN location TEXT;

-- posts：收藏计数（V1 前端展示 collect_count 一直是硬编码 0）
ALTER TABLE posts ADD COLUMN collect_count INTEGER NOT NULL DEFAULT 0;
