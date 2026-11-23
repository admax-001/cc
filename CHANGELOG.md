# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，
版本号采用 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer）。

## [1.0.0] - 2026-11-23

### 新增

- **V1 阅读侧全量上线**：仿小红书校园图文社区（黑小帅），前端 + API 由单个
  Cloudflare Worker 同域托管，0 元成本。
- 一键部署脚本 `deploy.mjs`：登录检查 → 创建 D1 → 自动回写 `database_id`
  → 导入建表与种子数据 → 构建前端 → 发布 Worker → 线上自检，8 步幂等可重跑。
- V1 只读 API 13 个：健康检查、分类、笔记分页、笔记详情（浏览计数自增）、
  评论分页、标签与热门标签、搜索（综合 / 笔记 / 联想词）、关注流与用户主页。
- V2 写接口占位 13 个：发布 / 编辑 / 删除、点赞、收藏、评论、登录注册、
  管理员登录、图片上传，路由已注册并返回 501 明确提示。
- Vue3 前端工程（Vite 构建）已对接新 API 并完成 V1 裁剪：瀑布流无限滚动、
  分类频道、热门标签、搜索、笔记详情（图组 + 评论只读）。
- 种子数据 200 笔记 / 50 用户 / 800 评论 / 697 图片 / 10 分类 / 74 标签，
  由 `scripts/gen-seed.js` 程序化生成，可重新生成换一批内容。
- Cloudflare Workers GitHub Actions 自动部署工作流（`.github/workflows/deploy.yml`）。
- 项目文档：README、架构说明、部署手册、API 文档（`docs/`）。

### 架构

- Workers + D1 免费额度托管：前端静态资产（`[assets]` + SPA 回退）与
  Hono API 同域服务，无服务器、免证书、免运维。
- 图片外链模式：`cover_image` / `images[].url` 直接指向图库域名，
  浏览器直连加载，不消耗 Worker 流量。

### 已知限制

- 默认 `*.workers.dev` 域名在中国大陆访问不畅，正式使用请绑定自有域名。
- V1 无登录态（users 表无密码字段、无 JWT/KV），写功能属 V2 范围。

## 计划

- **V2（互动侧）**：注册登录（Turnstile 人机验证）、发布、点赞 / 收藏 / 关注、
  通知；图片切换 imgbed API 直传（自建图库，域名 + API key 已就绪）。
- **V3（管理侧）**：后台八模块、Cron 定时任务、审计与备份。

> AI生成
