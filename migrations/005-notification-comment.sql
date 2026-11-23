-- 005：通知表加评论定位列（幂等性由 deploy.mjs 容错 duplicate column 保证）
-- 评论/回复类通知携带评论 id，前端消息页点击即可滚动定位到该评论
ALTER TABLE notifications ADD COLUMN target_comment_id INTEGER;
