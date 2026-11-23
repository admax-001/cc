#!/usr/bin/env node
// ============================================================
// 黑小帅 V3 API · Cloudflare 一键部署脚本（V3 开发线：xf）
// 用法：node deploy.mjs
// 前提：已完成 Cloudflare 账号登录（npx wrangler login，浏览器授权一次）
// 或设置环境变量 CLOUDFLARE_API_TOKEN（CI/无浏览器场景）
//
// 部署隔离：全新 Worker xf-api + 全新 D1 库 xf，与 V1（xiaoshiliu-api）/ V2（hxs-api）并行互不影响
//
// 脚本自动完成：
//   1. 依赖检查（缺 node_modules 自动 npm install）
//   2. 登录检查（wrangler whoami）
//   3. D1 数据库检查/创建（不存在则创建 xf）
//   4. database_id 自动回写 wrangler.toml（无需手动改配置）
//   5. 导入建表 schema.sql + 种子数据 seed.sql
//   6. 构建前端（Vue3 → dist，可用 --api-only 跳过）
//   7. wrangler deploy 发布 Worker（前端 + API 同域托管）
//   8. 部署后自检 /api/health 并输出访问地址
//   9. JWT_SECRET 兜底：未设置时自动生成强随机密钥并注入（已存在则跳过，绝不覆盖）
// ============================================================
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname)
const TOML = path.join(ROOT, 'wrangler.toml')
const DB_NAME = 'xf'

const IS_WIN = process.platform === 'win32'
const NPM = IS_WIN ? 'npm.cmd' : 'npm'
const T = (s) => console.log(s)

// ---------- 执行工具 ----------
function run(cmd, args, { timeout = 600000, env = {}, cwd = ROOT } = {}) {
  // Windows 下 .cmd/.bat 必须 shell:true，否则 spawnSync 直接 EINVAL 失败
  const needShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd)
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
    windowsHide: true,
    shell: needShell
  })
  const out = (r.stdout || '') + (r.stderr || '')
  return { code: r.status, out, ok: r.status === 0 }
}

// Windows 下优先用 node 直调 wrangler.js 入口（绕开 .cmd 的 spawnSync 限制）；否则 npx 拉起
let WRANGLER = null
function wranglerCmd() {
  if (WRANGLER) return WRANGLER
  const localJs = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (fs.existsSync(localJs)) {
    WRANGLER = { cmd: process.execPath, args: [localJs] }
  } else {
    WRANGLER = { cmd: IS_WIN ? 'npx.cmd' : 'npx', args: ['--yes', 'wrangler'] }
  }
  return WRANGLER
}
// 递归拷贝（Windows 用 robocopy，退出码 0-7 均为成功）
function copyDir(src, dest) {
  if (IS_WIN) {
    const r = spawnSync('robocopy.exe', [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { encoding: 'utf8', timeout: 600000 })
    if (r.status === null || r.status > 7) throw new Error('robocopy 失败: ' + ((r.stderr || '') + (r.stdout || '')).slice(-300))
  } else {
    fs.cpSync(src, dest, { recursive: true })
  }
}

function wr(args, opts = {}) {
  const w = wranglerCmd()
  let last = null
  for (let i = 0; i < 3; i++) {
    const r = run(w.cmd, [...w.args, ...args], { timeout: 300000, ...opts })
    if (r.ok) return r
    last = r
    // 仅对网络类瞬时失败自动重试（云电脑出口网络偶发抖动）
    if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(r.out)) {
      T(`  ~ 网络抖动，${3 * (i + 1)} 秒后自动重试 (${i + 1}/3) ...`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * (i + 1))
      continue
    }
    return r
  }
  return last
}

// ---------- 流程 ----------
T('==========================================================')
T('  黑小帅 V3 API · Cloudflare 一键部署')
T('  Workers + D1 免费额度 · 0 元托管')
T('==========================================================')

T('  [1/8] 依赖与登录 · [2/8] D1 数据 · [3/8] 前端构建 · [4/8] 部署上线')

// 1. 根依赖
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'hono'))) {
  T('\n[1/8] 未检测到依赖，自动安装 npm install ...')
  const inst = run(NPM, ['install', '--no-audit', '--no-fund', '--loglevel=warn'])
  if (!inst.ok) {
    T('  × npm install 失败：\n' + inst.out)
    T('  请手动执行 npm install 后重跑 node deploy.mjs')
    process.exit(1)
  }
  T('  √ 依赖安装完成')
} else {
  T('\n[1/8] √ 依赖已就绪')
}

// 2. 登录
T('\n[2/8] 检查 Cloudflare 登录状态 ...')
const who = wr(['whoami'])
if (!who.ok) {
  T('  × 未登录 Cloudflare (' + (who.out || '').slice(-200) + ')')
  T('  ─────────────────────────────────────────────')
  T('  请先完成一次浏览器授权登录（弹出的页面点击 Allow）：')
  T('      npx wrangler login')
  T('  或使用 API Token（无需浏览器）：')
  T('      在 https://dash.cloudflare.com/profile/api-tokens 创建 token 后')
  T('      set CLOUDFLARE_API_TOKEN=你的token 再重跑本脚本')
  T('  ─────────────────────────────────────────────')
  process.exit(1)
}
const emailMatch = who.out.match(/you are logged in as (\S+?)\s*\(/i) || who.out.match(/account/i)
T(`  √ 已登录${emailMatch ? '：' + emailMatch[1] : ''}`)

// 3. D1 数据库：查询或创建
T(`\n[3/8] 检查 D1 数据库 ${DB_NAME} ...`)
let dbId = null
const info = wr(['d1', 'info', DB_NAME, '--json'])
if (info.ok) {
  try {
    const j = JSON.parse(info.out.slice(info.out.indexOf('{'), info.out.lastIndexOf('}') + 1))
    dbId = (j.uuid) || (j.database_id) || (j.databases && j.databases[0] && j.databases[0].uuid)
  } catch { /* 忽略解析失败 */ }
  if (dbId) T(`  √ 数据库已存在（id: ${dbId}）`)
}
if (!dbId) {
  T(`  数据库不存在，创建 ${DB_NAME} ...`)
  const create = wr(['d1', 'create', DB_NAME])
  if (!create.ok) {
    T('  × 创建失败：\n' + create.out)
    process.exit(1)
  }
  const m = create.out.match(/database_id\s*=?\s*"?([0-9a-f-]{32,})"?/i) || create.out.match(/uuid[:\s]+([0-9a-f-]{32,})/i)
  if (m) dbId = m[1]
  if (!dbId) {
    const re = wr(['d1', 'info', DB_NAME, '--json'])
    if (re.ok) {
      try {
        const j = JSON.parse(re.out.slice(re.out.indexOf('{'), re.out.lastIndexOf('}') + 1))
        dbId = j.uuid || j.database_id
      } catch {}
    }
  }
  if (!dbId) {
    T('  × 未能解析 database_id，请把下面输出里的 database_id 手动填入 wrangler.toml 后重跑：\n' + create.out)
    process.exit(1)
  }
  T(`  √ 创建成功（id: ${dbId}）`)
}

// 4. 回写 wrangler.toml
T('\n[4/8] 回写 database_id 到 wrangler.toml ...')
let toml = fs.readFileSync(TOML, 'utf8')
if (toml.includes('local-dev-placeholder')) {
  toml = toml.replace('local-dev-placeholder', dbId)
  fs.writeFileSync(TOML, toml)
  T('  √ 已写入')
} else if (toml.includes(dbId)) {
  T('  √ 已是最新')
} else {
  toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`)
  fs.writeFileSync(TOML, toml)
  T('  √ 已更新')
}

// 5. 导入数据
T('\n[5/8] 导入建表 schema.sql ...')
const sch = wr(['d1', 'execute', DB_NAME, '--remote', '--file=schema.sql', '-y'])
if (!sch.ok) { T('  × 失败：\n' + sch.out); process.exit(1) }
T('  √ 建表完成（V1 7 张表）')

// 5.1 V2 迁移：users/posts 加列（幂等：duplicate column 视为已迁移跳过）
T('\n[5/8] V2 迁移 migrations/001-v2-user-columns.sql ...')
const mig = wr(['d1', 'execute', DB_NAME, '--remote', '--file=migrations/001-v2-user-columns.sql', '-y'])
if (!mig.ok) {
  if (/duplicate column/i.test(mig.out)) {
    T('  √ 列已存在（幂等跳过）')
  } else { T('  × 失败：\n' + mig.out); process.exit(1) }
} else {
  T('  √ V2 字段迁移完成')
}

// 5.2 V2 新表：follows/likes/collections/notifications/user_sessions（CREATE IF NOT EXISTS 幂等）
T('\n[5/8] 导入 V2 互动表 v2-schema.sql ...')
const v2s = wr(['d1', 'execute', DB_NAME, '--remote', '--file=v2-schema.sql', '-y'])
if (!v2s.ok) { T('  × 失败：\n' + v2s.out); process.exit(1) }
T('  √ V2 互动表完成（follows/likes/collections/notifications/user_sessions）')

// 5.3 V3 迁移：管理员引导（is_admin + 部分唯一索引，幂等：duplicate column 容忍）
T('\n[5/8] V3 迁移 migrations/002-admin-account.sql ...')
const mig2 = wr(['d1', 'execute', DB_NAME, '--remote', '--file=migrations/002-admin-account.sql', '-y'])
if (!mig2.ok) {
  if (/duplicate column/i.test(mig2.out)) {
    T('  √ 列已存在（幂等跳过）')
  } else { T('  × 失败：\n' + mig2.out); process.exit(1) }
} else {
  T('  √ 管理员字段迁移完成（is_admin + 唯一索引）')
}

// 5.4 V3 迁移：管理侧数据表（user_ban / audit / reports + users/comments 加列）
T('\n[5/8] V3 迁移 migrations/003-admin-tables.sql ...')
const mig3 = wr(['d1', 'execute', DB_NAME, '--remote', '--file=migrations/003-admin-tables.sql', '-y'])
if (!mig3.ok) {
  if (/duplicate column/i.test(mig3.out)) {
    T('  √ 列已存在（幂等跳过）')
  } else { T('  × 失败：\n' + mig3.out); process.exit(1) }
} else {
  T('  √ 管理侧表迁移完成（user_ban / audit / reports）')
}

// 5.5 V3 迁移：视频笔记字段（posts 加 video_url / cover_url）
T('\n[5/8] V3 迁移 migrations/004-video-columns.sql ...')
const mig4 = wr(['d1', 'execute', DB_NAME, '--remote', '--file=migrations/004-video-columns.sql', '-y'])
if (!mig4.ok) {
  if (/duplicate column/i.test(mig4.out)) {
    T('  √ 列已存在（幂等跳过）')
  } else { T('  × 失败：\n' + mig4.out); process.exit(1) }
} else {
  T('  √ 视频字段迁移完成（posts.video_url / cover_url）')
}

// 6. 种子数据：仅当库中无用户时导入（已有用户 → 跳过，保护已注册账号与首个管理员不被重置）
T('\n[6/8] 导入种子数据 seed.sql（50 用户/200 笔记/800 评论）...')
const cntOut = wr(['d1', 'execute', DB_NAME, '--remote', '--command', 'SELECT COUNT(*) AS n FROM users', '--json'])
const cntMatch = cntOut.ok ? cntOut.out.match(/"n"\s*:\s*(\d+)/) : null
const userCount = cntMatch ? parseInt(cntMatch[1], 10) : 0
if (userCount > 0) {
  T(`  √ 检测到已有 ${userCount} 个用户账号，跳过种子导入（保护注册数据与管理员）`)
} else {
  const seed = wr(['d1', 'execute', DB_NAME, '--remote', '--file=seed.sql', '-y'])
  if (!seed.ok) { T('  × 失败：\n' + seed.out); process.exit(1) }
  T('  √ 种子数据导入完成')
}

// 6. 前端构建
const skipFrontend = process.argv.includes('--api-only')
const frontendDir = path.join(ROOT, 'frontend')
if (skipFrontend) {
  T('\n[7/8] 跳过前端构建（--api-only）')
} else if (!fs.existsSync(frontendDir)) {
  T('\n[7/8] 未检测到 frontend 目录，跳过前端构建（纯 API 部署）')
} else {
  T('\n[7/8] 构建前端 Vue3 → dist ...')
  const hasNonAscii = /[^\x00-\x7F]/.test(ROOT)
  let buildDir = frontendDir
  let distOut = path.join(ROOT, 'dist')
  if (hasNonAscii) {
    // vite/rollup 在中文路径下解析 index.html 入口会失败，改到英文路径构建，产物再拷回
    const buildRoot = path.join(os.homedir(), 'xsl-runtime', 'xsl-build')
    buildDir = path.join(buildRoot, 'frontend')
    distOut = path.join(buildRoot, 'dist')
    T('  ~ 工作目录含中文路径，切换到英文构建目录：' + buildDir)
    fs.rmSync(buildRoot, { recursive: true, force: true })
    copyDir(frontendDir, buildDir)
  }
  if (!fs.existsSync(path.join(buildDir, 'node_modules'))) {
    const fi = run(NPM, ['install', '--no-audit', '--no-fund', '--loglevel=warn'], { cwd: buildDir, timeout: 900000 })
    if (!fi.ok) { T('  × 前端依赖安装失败：\n' + fi.out); process.exit(1) }
    T('  √ 前端依赖安装完成')
  }
  const localVite = path.join(buildDir, 'node_modules', 'vite', 'bin', 'vite.js')
  let build
  if (fs.existsSync(localVite)) {
    // 用 node 直调本地 vite（npx 缓存版 vite 版本不符且入口解析易出问题）
    build = run(process.execPath, [localVite, 'build', '--outDir', distOut, '--emptyOutDir'], { cwd: buildDir, timeout: 900000 })
  } else {
    build = run(NPM, ['run', 'build', '--', '--outDir', distOut, '--emptyOutDir'], { cwd: buildDir, timeout: 900000 })
  }
  if (!build.ok) { T('  × 前端构建失败：\n' + build.out); process.exit(1) }
  if (hasNonAscii) {
    fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true })
    copyDir(distOut, path.join(ROOT, 'dist'))
    T('  √ 构建产物已拷回 → dist/')
  }
  T('  √ 前端构建完成 → dist/')
}

// 7. 部署
T('\n[8/8] 部署 Worker（前端 + API 同域托管）...')
const dep = wr(['deploy'])
if (!dep.ok) { T('  × 部署失败：\n' + dep.out); process.exit(1) }
const urlM = dep.out.match(/https:\/\/[\w.-]+\.workers\.dev/)
const apiUrl = urlM ? urlM[0] : '（见上方部署输出）'
T('  √ 部署成功')

// 7. 自检
T('\n[8/8] 部署后自检 /api/health ...')
if (urlM) {
  try {
    const res = await fetch(apiUrl + '/api/health')
    const j = await res.json()
    if (j && j.code === 200) {
      T(`  √ 健康检查通过（version ${j.data && j.data.version}）`)
    } else {
      T('  ~ 服务已上线，但健康检查返回异常，稍等几秒后重试：' + apiUrl + '/api/health')
    }
  } catch {
    T('  ~ 服务已上线，边缘节点传播需几秒，稍后访问：' + apiUrl + '/api/health')
  }
}

// 9. JWT_SECRET 兜底：未设置时自动生成并注入（认证/登录依赖它，缺失会导致登录注册不可用）
T('\n[9/9] 检查 JWT_SECRET ...')
const secList = wr(['secret', 'list'])
if (!secList.ok) {
  T('  ~ 无法查询 secret 列表（' + (secList.out || '').slice(-120).trim() + '）')
  T('  请手动确认并设置（在本项目目录执行，自动读取 wrangler.toml 的 Worker 名）：')
  T('      npx wrangler secret put JWT_SECRET')
} else if (/JWT_SECRET/i.test(secList.out)) {
  T('  √ JWT_SECRET 已存在（跳过，绝不覆盖线上密钥，已有登录态不受影响）')
} else {
  // 仅在“查询成功且确认不存在”时才写入，避免误覆盖线上已有密钥
  const newSecret = crypto.randomBytes(48).toString('base64url')
  const wc = wranglerCmd()
  const needShellSec = IS_WIN && /\.(cmd|bat)$/i.test(wc.cmd)
  const put = spawnSync(wc.cmd, [...wc.args, 'secret', 'put', 'JWT_SECRET'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    shell: needShellSec,
    input: newSecret + '\n'
  })
  const putOut = (put.stdout || '') + (put.stderr || '')
  if (put.status === 0 && /Success/i.test(putOut)) {
    T('  √ 已自动生成强随机 JWT_SECRET 并注入（值不回显；这是唯一来源，请勿泄露）')
  } else {
    T('  × 自动注入失败：' + putOut.slice(-200))
    T('  请手动执行：npx wrangler secret put JWT_SECRET（设置前登录/注册不可用）')
    process.exit(1)
  }
}

T('\n==========================================================')
T('  🎉 一键部署完成！')
T('==========================================================')
T(`\n  API 地址      ${apiUrl}`)
T('  健康检查      ' + (urlM ? apiUrl + '/api/health' : 'https://<你的worker名>.workers.dev/api/health'))
T('  笔记列表      ' + (urlM ? apiUrl + '/api/posts?page=1&limit=20' : ''))
T('\n  提示：默认 workers.dev 域名在大陆访问不畅，')
T('  正式使用请绑定自有域名（Pages + Workers 自定义域名）。')
T('  后续 V2/V3 迭代与 imgbed 图床对接见 README.md。')
T('')
