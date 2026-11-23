# 安全策略

## 支持版本

| 版本 | 支持状态 |
|---|---|
| 1.0.x | ✅ 支持 |

## 报告漏洞

发现安全漏洞请**勿公开 Issue**，请通过 GitHub Security Advisories
（仓库页 → Security → Report a vulnerability）私密上报，或联系仓库维护者。

我们会在收到报告后尽快评估并修复。

## 部署安全清单（自部署用户）

- [ ] ** wrangler OAuth Token 保存在本机 `.wrangler/` 目录**，切勿提交进仓库（`.gitignore` 已忽略）。
- [ ] CI 自动部署使用 **API Token（`CLOUDFLARE_API_TOKEN` secret）**，
      建议创建仅含 Workers / D1 权限的最小权限 Token，并定期轮换。
- [ ] V2 上线登录功能后：密码使用强哈希（bcrypt / argon2）存储、
      JWT 密钥通过 `wrangler secret put` 注入，不写入 `wrangler.toml`。
- [ ] 图床 API key（imgbed）通过 `wrangler secret put IMG_API_TOKEN` 注入，
      任何密钥不进入代码与配置文件。
- [ ] D1 属于边缘共享 SQLite：业务敏感数据（真实用户隐私、支付信息）
      不适合直接入库存明文，如需托管请在应用层加密。

> AI生成
