# 贡献指南

感谢关注黑小帅！欢迎以任意方式参与贡献。

## 快速上手

```bash
git clone https://github.com/your-name/xsl-cloudflare.git
cd xsl-cloudflare

npm install          # 安装 API 依赖
npx wrangler login   # 浏览器授权登录一次
node deploy.mjs      # 一键部署到你的 Cloudflare 账号
```

本地开发（改前端为主）：

```bash
npm run dev              # wrangler dev @8787（本地 D1 + API + 前端）
cd frontend && npm run dev   # 或仅跑前端 @5173（vite 代理 /api → 8787）
```

首次 `wrangler dev` 会自动创建本地 D1 并导入 `schema.sql` / `seed.sql`。

## 目录导览

| 目录 / 文件 | 说明 |
|---|---|
| `src/index.js` | API 入口（Hono），V1 只读接口 + V2 占位 |
| `frontend/` | Vue3 前端工程（Vite，构建产物 → `../dist`） |
| `deploy.mjs` | 一键部署脚本（8 步幂等） |
| `schema.sql` / `seed.sql` | 建表与种子数据 |
| `scripts/gen-seed.js` | 种子数据生成脚本 |
| `docs/` | 架构 / 部署 / API 文档 |

## 提交规范

- 分支从 `main` 拉出，命名建议 `feat/xxx`、`fix/xxx`、`docs/xxx`。
- Commit message 一行简述做了什么，示例：`feat: 笔记详情新增标签聚合`。
- 一个 PR 只做一件事；改动 `frontend/` 的 PR 请附本地构建通过的说明
  （`cd frontend && npm run build`）。

## 提交前自查

```bash
node deploy.mjs          # 或 deploy.mjs --api-only，确认 8 步全绿
```

- 不引入新框架 / 大体积依赖（免费额度有限，请保持轻量）。
- 不提交 `node_modules`、`dist`、`.wrangler`、`backup.sql`（`.gitignore` 已忽略）。
- 种子数据变更请通过修改 `scripts/gen-seed.js` 重新生成，勿手改 `seed.sql`。

## Issue 与 PR

- Bug 请使用 Bug Report 模板并附复现步骤。
- 功能建议请使用 Feature Request 模板并说明使用场景。
- PR 请填写 PR 模板中的变更说明与自测结果。

## 行为准则

保持友善与尊重；对事不对人。详细的社区行为准则参考
[ Contributor Covenant ](https://www.contributor-covenant.org/version/2/1/code_of_conduct.html)。

> AI生成
