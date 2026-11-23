# 部署手册

黑小帅支持三种部署姿势，任选其一，全部**0 元托管**（Cloudflare 免费额度）。

## 前置要求

- [Cloudflare 免费账号](https://dash.cloudflare.com/sign-up)
- Node.js 18+（本地命令行部署需要）

## 方式一：本地一键部署（推荐）

```bash
npm install          # 安装 API 依赖
npx wrangler login   # 浏览器授权登录一次（弹页点击 Allow）
node deploy.mjs      # 一键完成剩余全部
```

`deploy.mjs` 8 个步骤，**幂等可重跑**（已存在的资源自动跳过）：

| 步骤 | 内容 | 说明 |
|---|---|---|
| 1/8 | 依赖检查 | 缺 `node_modules` 自动 `npm install` |
| 2/8 | 登录检查 | `wrangler whoami`，未登录给出引导 |
| 3/8 | D1 数据库 | 已存在则跳过，不存在则创建 `xiaoshiliu` |
| 4/8 | 回写配置 | `database_id` 自动写入 `wrangler.toml` |
| 5/8 | 建表 | 导入 `schema.sql`（7 张表，IF NOT EXISTS 幂等） |
| 6/8 | 种子数据 | 导入 `seed.sql`（导入前自动清空旧数据） |
| 7/8 | 前端构建 | Vue3 → `dist/`；`--api-only` 可跳过 |
| 8/8 | 发布 + 自检 | `wrangler deploy` 后请求 `/api/health` |

**Windows 用户提示**：中文路径下会自动切换到英文目录构建再拷回，无需手动处理；
网络抖动自动重试 3 次。

只改了 API 不动前端时可用快速通道：

```bash
npm run deploy        # 等价 wrangler deploy（跳过重新构建）
```

## 方式二：GitHub Actions 自动部署

1. Fork / 推送本仓库到你的 GitHub。
2. 创建 API Token：<https://dash.cloudflare.com/profile/api-tokens>
   （选 "Edit Cloudflare Workers" 模板，或自定义最小权限：
   Workers Scripts:Edit + D1:Edit + Account:Read）。
3. 仓库 Settings → Secrets and variables → Actions 添加：

   | Secret | 值 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 上一步创建的 Token |
   | `CLOUDFLARE_ACCOUNT_ID` | dash 右侧栏 Account ID |

4. 推送到 `main` 分支，`.github/workflows/deploy.yml` 自动执行
   `node deploy.mjs` 完成部署；也可在 Actions 页手动触发（workflow_dispatch）。

## 方式三：API Token 纯命令行（服务器 / CI 无浏览器）

```bash
set CLOUDFLARE_API_TOKEN=你的token      # macOS/Linux: export CLOUDFLARE_API_TOKEN=...
node deploy.mjs
```

## 部署后验证

```bash
curl https://<你的worker名>.workers.dev/api/health
curl "https://<你的worker名>.workers.dev/api/posts?page=1&limit=20"
```

浏览器打开根路径即博客首页（瀑布流 + 分类 / 标签 / 搜索 / 详情 / 评论）。

> **大陆访问提示**：`*.workers.dev` 在中国大陆访问不畅。正式使用请绑定自有域名：
> Cloudflare 控制台 → 你的域名接入（免费）→ Workers 路由 / 自定义域，
> 绑定后全球（含国内）可达。

## 日常运维

```bash
npm run gen:seed              # 重新生成一批种子数据
npm run db:seed:remote        # 覆盖导入线上数据库
npm run db:export             # 导出 backup.sql 备份留档
npx wrangler tail             # 实时查看线上日志
npx wrangler rollback         # 回滚到上一版本
npx wrangler deployments list # 查看部署历史
```

## 本地开发

```bash
npm run dev                   # wrangler dev @8787（本地 D1 + API + 前端资产）
cd frontend && npm run dev    # 仅前端 @5173（vite 代理 /api → 8787）
```

首次 `wrangler dev` 会自动创建本地 D1 并导入 `schema.sql` / `seed.sql`。

## 常见问题

| 问题 | 处理 |
|---|---|
| 重新部署会覆盖数据吗？ | `deploy.mjs` 每次重导种子数据（先清空再导入）；生产数据请先 `npm run db:export` 备份 |
| 想换一批内容？ | `npm run gen:seed` 重新生成 `seed.sql` 后重跑 `node deploy.mjs` |
| 前端改了代码怎么发布？ | 重跑 `node deploy.mjs`（自动重新构建 dist 并部署） |
| D1 导入报事务错误？ | D1 不支持 `BEGIN TRANSACTION` / `PRAGMA`，`wrangler d1 execute --file` 本身原子，无需包裹 |
| 部署成功但访问超时？ | 大陆网络对 workers.dev 的干扰；绑定自有域名或用海外网络验证 |

> AI生成
