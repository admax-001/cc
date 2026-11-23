<div align="center">

# 黑小帅

**仿小红书校园图文社区 · Cloudflare 全家桶 0 元托管**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Vue 3](https://img.shields.io/badge/Vue-3.x-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Hono](https://img.shields.io/badge/Hono-API-E36002)](https://hono.dev/)

</div>

前端 + API 由**同一个 Cloudflare Worker 同域托管**：Vue3 静态资产 + Hono API + D1 免费额度，无服务器、免证书、免运维，**月成本 0 元**。

> **部署方式二选一**：① 本地/CI 命令行一键部署 `node deploy.mjs`（推荐，自动建库、导数据、生成 JWT 密钥）；② Cloudflare Git 集成（Workers Builds）连接本仓库时，请把 **Deploy command** 设为 `node deploy.mjs`（不要用默认 `npx wrangler deploy`，否则无法自动建库回写配置，且数据库字段缺失会报错）。

## ✨ 特性

- 🏠 **单 Worker 同域托管**：根路径即博客首页，`/api/*` 为接口，无跨域、无多项目
- 📦 **一键部署**：`node deploy.mjs` 幂等可重跑（建库 → 回写配置 → 导数据 → 构建 → 发布 → JWT 密钥兑底 → 自检）
- 💾 **D1 边缘 SQLite**：7 张表存全量数据，无连接池、无冷启动
- 🖼️ **图片外链模式**：直连图库域名加载，不消耗 Worker 流量
- 🔌 **API 结构对齐原前端**：`transformPostData` 期望字段零改动对接
- 🇨🇳 **中文社区体验**：瀑布流无限滚动、分类频道、热门标签、搜索联想
- 🤖 **GitHub Actions 部署**：手动触发（workflow_dispatch），需在仓库 Secrets 配置 Cloudflare Token

## 🚀 快速开始

```bash
npm install          # 安装 API 依赖
npx wrangler login   # 浏览器授权登录一次
node deploy.mjs      # 一键完成剩余全部（含前端构建）
```

前置要求：[Cloudflare 免费账号](https://dash.cloudflare.com/sign-up) + Node.js 18+。
无浏览器场景（CI / 服务器）用 API Token，详见 [docs/deployment.md](docs/deployment.md)。

部署完成即可访问 `https://<你的worker名>.workers.dev`。

## 📁 项目结构

```
kn/
├── .github/
│   ├── ISSUE_TEMPLATE/           # Bug / Feature 模板
│   ├── workflows/
│   │   ├── ci.yml                # 构建检查
│   │   └── deploy.yml            # Actions 手动部署（需配 secrets）
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── dependabot.yml            # 依赖自动更新
├── docs/
│   ├── architecture.md           # 架构说明
│   ├── deployment.md             # 部署手册（三种姿势 + 运维）
│   └── api.md                    # API 文档（13 读 + 13 占位）
├── frontend/                     # Vue3 前端工程（Vite，构建产物 → ../dist）
├── scripts/gen-seed.js           # 种子数据生成脚本
├── src/index.js                  # API 入口（Hono）+ 静态资产兜底
├── dist/                         # 前端构建产物（随仓库提交，Git 集成可直接部署；本地改动后 deploy.mjs 会自动重建）
├── deploy.mjs                    # 一键部署脚本（核心）
├── wrangler.toml                 # Workers 配置（D1 + 静态资产，database_id 自动回写）
├── schema.sql                    # 建表（7 张，幂等）
├── seed.sql                      # 种子数据（生成物，可重新生成）
├── CHANGELOG.md                  # 更新日志（Keep a Changelog）
├── CONTRIBUTING.md               # 贡献指南
├── SECURITY.md                   # 安全策略
├── LICENSE                       # MIT
└── README.md
```

## 📚 文档

| 文档 | 内容 |
|---|---|
| [架构说明](docs/architecture.md) | 三层拓扑、同域托管决策、数据模型、免费额度 |
| [部署手册](docs/deployment.md) | 四种部署姿势、运维命令、常见问题 |
| [API 文档](docs/api.md) | 13 个只读接口 + 13 个 V2 占位，含响应示例 |

## 🔖 路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| V1 | 阅读侧前端 + API（单 Worker 同域托管，本仓库） | ✅ |
| V2 | 互动侧：注册登录（Turnstile）、发布、点赞收藏关注、通知；图片 imgbed API 直传 | 计划 |
| V3 | 管理侧：后台八模块、Cron 定时任务、审计与备份 | 计划 |

图片存储策略：**imgbed API 直传为主**（自建图库，域名 + API key + 每日保活就绪），外链粘贴兜底，Cloudflare R2 长期备选；切换仅改环境变量。

## 🤝 贡献与致谢

- 贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请私密上报（[SECURITY.md](SECURITY.md)）。
- 本项目基于 [@ZTMYO](https://github.com/ZTMYO) 的开源社区项目二次开发重构，感谢原作者的开源贡献。

## 📄 许可证

[MIT](LICENSE) © 2026 黑小帅 contributors

---

> AI生成
