# 架构说明

黑小帅 V1 采用 **Cloudflare Workers 全家桶**托管：前端静态资产、API、数据库
全部收敛到同一个 Worker 同域服务，无服务器、免证书、免运维，月成本 0 元。

## 总体拓扑

```
                        浏览器
                          │
                          ▼
              https://<你的worker>.workers.dev
                          │
          ┌───────────────┴───────────────┐
          │      Cloudflare Worker        │
          │      (xiaoshiliu-api)         │
          ├───────────────┬───────────────┤
          │ Static Assets │  Hono API     │
          │   [assets]    │  /api/*       │
          │  dist/ 产物   │  src/index.js │
          │  SPA 回退     │               │
          └───────┬───────┴──────┬────────┘
                  │              │ binding: DB
                  │              ▼
                  │        D1 (SQLite)
                  │        数据库 xiaoshiliu
                  ▼
             图库域名（外链图片）
             浏览器直连加载，不占 Worker 流量
```

## 三层组件

### 1）前端静态资产（`frontend/` → `dist/`）

- Vue 3 + Vite 工程，构建产物 40 个文件（约 2.9MB）。
- Worker 的 `[assets]` 指令直接托管 `dist/`，`not_found_handling = single-page-application`
  保证 `/explore` 等 SPA 路由未命中静态文件时自动回退 `index.html`。
- **同域无跨域**：前端与 API 同源，无需 CORS 配置、无需单独 Pages 项目。

### 2）Worker API（`src/index.js`）

- Hono 框架，13 个 V1 只读接口 + 13 个 V2 写接口占位（返回 501 明确提示）。
- 响应结构完全对齐原 Vue3 前端 `transformPostData` 期望的字段名
  （`images` 数组、`nickname` / `user_avatar` / `author_account` 顶层字段、
  评论嵌套 `pagination` 等），前端 api 层零改动即可对接。
- 搜索接口另有扁平结构（`toFlatPost`）：搜索页直接渲染后端原始数据，
  `author` 为字符串而非嵌套对象。

### 3）D1 数据库（Cloudflare 边缘 SQLite）

7 张表：

| 表 | 作用 |
|---|---|
| `categories` | 分类频道（10 个：学习 / 校园 / 情感 / 兴趣 …） |
| `tags` | 标签（74 个，含 use_count 热度） |
| `users` | 用户（50 个；V1 无密码字段，V2 补登录体系） |
| `posts` | 笔记主表（标题 / 正文 / 分类 / 浏览量 / 计数冗余） |
| `post_images` | 笔记图组（外链 URL，697 条） |
| `post_tags` | 笔记-标签多对多关联 |
| `comments` | 评论（800 条） |

- Worker 内通过绑定（`binding = "DB"`）直查，无连接池、无冷启动。
- 图片字段用 `json_group_array` 聚合为 JSON 数组返回。

## 关键设计决策

### 同域托管 vs 前后端分仓

| 方案 | 结论 |
|---|---|
| 前后端同一个 Worker（**采用**） | 一条 `deploy.mjs` 同时发前端与 API；同源免跨域；workers.dev 单域名 |
| Pages（前端）+ Workers（API） | 两个项目两套配置，跨域需 CORS；适合前后端团队分仓协作 |

### 图片外链模式（V1）

`cover_image` / `images[].url` 直接存图库域名的完整 URL，浏览器 `<img>` 原样引用：

- 不消耗 Worker 请求额度与流量；
- 图床独立扩缩容，博客侧零改动；
- V2 将切换 **imgbed API 直传**（自建图库，域名 + API key + 每日保活已就绪），
  外链粘贴作为兜底，Cloudflare R2 长期备选，切换仅改环境变量。

### 种子数据程序化生成

`scripts/gen-seed.js` 生成 `seed.sql`（导入前自动清空旧数据）。
注意 **D1 不支持 `BEGIN TRANSACTION` / `PRAGMA` 语句**，
`wrangler d1 execute --file` 本身原子（失败自动回滚），无需显式事务包裹。

## 免费额度对照

| 项 | 免费额度 | V1 实际占用 |
|---|---|---|
| Workers 请求 | 10 万次 / 天 | 从零计起 |
| D1 存储 | 5 GB | ~308 KB |
| D1 行读取 | 500 万行 / 天 | 瀑布流每页约 200 行 |
| D1 行写入 | 10 万行 / 天 | V1 只读，暂无写入 |

## 已知限制

- `*.workers.dev` 域名在中国大陆访问不畅，正式使用请在 Cloudflare 控制台
  绑定自有域名（DNS 接入免费，绑定后全球含国内可达）。
- V1 无登录态（users 表无密码字段、无 JWT / KV），写功能属 V2 范围。
- D1 为边缘共享 SQLite，不适合直接明文存高敏数据（见 SECURITY.md）。

> AI生成
