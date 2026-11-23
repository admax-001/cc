-- 004：视频笔记字段迁移（幂等性由 deploy.mjs 容错 duplicate column 保证）
-- posts 增加视频两列：video_url 视频直链 / cover_url 封面图直链
ALTER TABLE posts ADD COLUMN video_url TEXT;
ALTER TABLE posts ADD COLUMN cover_url TEXT;
