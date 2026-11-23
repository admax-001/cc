// V3 管理员引导机制实测：首注册=唯一管理员
import { execSync } from 'node:child_process'

const BASE = 'http://localhost:8788'
const ROOT = 'C:/Users/Administrator/Desktop/xf/xf-cloudflare'

const post = async (u, b, h) => req('POST', u, b, h)
const get = async (u, h) => req('GET', u, null, h)
const put = async (u, b, h) => req('PUT', u, b, h)
async function req(method, u, b, h) {
  const r = await fetch(BASE + u, {
    method,
    headers: { 'Content-Type': 'application/json', ...(h || {}) },
    body: b ? JSON.stringify(b) : undefined
  })
  return await r.json().catch(() => ({}))
}

// 注册辅助：取验证码 → 从本地 D1 读出真实值（模拟用户看图输入）
async function register(user_id, nickname, password) {
  const cap = await get('/api/auth/captcha')
  const codeOut = execSync(
    `node node_modules/wrangler/bin/wrangler.js d1 execute xf --local --command "SELECT code FROM captchas WHERE id = '${cap.data.captchaId}'" --json`,
    { encoding: 'utf8', cwd: ROOT, env: { ...process.env, CI: 'true' } }
  )
  const code = JSON.parse(codeOut)[0].results[0].code
  return post('/api/auth/register', { user_id, nickname, password, captchaId: cap.data.captchaId, captchaText: code })
}

async function main() {
  console.log('=== V3 管理员引导机制实测 ===\n')

  // 1. 首个注册账号 → 应成为管理员
  const first = await register('firstadmin', '首个管理员', 'FirstAdmin2026!')
  console.log(`1) 首个注册 firstadmin: code=${first.code}`)
  console.log(`   is_admin=${first.data?.user?.is_admin} | message=${first.message}`)

  // 2. 第二个注册账号 → 普通用户
  const second = await register('normaluser', '普通用户', 'NormalUser2026!')
  console.log(`2) 第二个注册 normaluser: code=${second.code}`)
  console.log(`   is_admin=${second.data?.user?.is_admin}（应为 false）`)

  // 3. 登录返回 is_admin
  const login1 = await post('/api/auth/login', { user_id: 'firstadmin', password: 'FirstAdmin2026!' })
  const login2 = await post('/api/auth/login', { user_id: 'normaluser', password: 'NormalUser2026!' })
  console.log(`3) 登录返回 is_admin: firstadmin=${login1.data?.user?.is_admin} | normaluser=${login2.data?.user?.is_admin}`)

  // 4. me 返回 is_admin
  const tok1 = { Authorization: `Bearer ${login1.data.tokens.access_token}` }
  const me = await get('/api/auth/me', tok1)
  console.log(`4) me 接口: is_admin=${me.data?.is_admin}`)

  // 5. 管理员登录接口（admin 契约：data.admin + data.tokens）
  const adminLogin = await post('/api/auth/admin/login', { username: 'firstadmin', password: 'FirstAdmin2026!' })
  console.log(`5) 管理员登录(契约 username): code=${adminLogin.code} | admin.user_id=${adminLogin.data?.admin?.user_id} | tokens=${adminLogin.data?.tokens?.access_token ? 'OK' : '无'}`)

  // 6. 普通账号走管理员登录 → 403
  const adminDenied = await post('/api/auth/admin/login', { username: 'normaluser', password: 'NormalUser2026!' })
  console.log(`6) 普通账号管理员登录: code=${adminDenied.code} msg=${adminDenied.message}`)

  // 7. 管理员 me（admin 契约）
  const adminMe = await get('/api/auth/admin/me', tok1)
  console.log(`7) 管理员 /auth/admin/me: code=${adminMe.code} | admin.nickname=${adminMe.data?.admin?.nickname}`)

  // 8. 普通账号访问 admin/me → 403
  const tok2 = { Authorization: `Bearer ${login2.data.tokens.access_token}` }
  const adminMeDenied = await get('/api/auth/admin/me', tok2)
  console.log(`8) 普通账号 /auth/admin/me: code=${adminMeDenied.code}`)

  // 9. 数据库级唯一性：直接 UPDATE 强行把第二人设为管理员应被索引拒绝
  const before = await get('/api/auth/me', tok2)
  let constraintBlocked = false
  try {
    execSync(
      `node node_modules/wrangler/bin/wrangler.js d1 execute xf --local --command "UPDATE users SET is_admin = 1 WHERE user_id = 'normaluser'" -y`,
      { encoding: 'utf8', cwd: ROOT, env: { ...process.env, CI: 'true' }, stdio: 'pipe' }
    )
  } catch (e) {
    constraintBlocked = true // 部分唯一索引拒绝（退出码非 0）
  }
  console.log(`9) 唯一索引兜底（强设第二人为管理员）: ${constraintBlocked ? '被数据库拒绝 ✅' : '⚠️ 未拦截（需人工检查）'}`)

  // 10. 种子用户均非管理员（保证部署后首个真实注册者拿到管理员位）
  const seedCheck = execSync(
    `node node_modules/wrangler/bin/wrangler.js d1 execute xf --local --command "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1" --json`,
    { encoding: 'utf8', cwd: ROOT, env: { ...process.env, CI: 'true' } }
  )
  const adminCount = JSON.parse(seedCheck)[0].results[0].n
  console.log(`10) 当前管理员总数: ${adminCount}（唯一性：应恒为 1）`)

  console.log('\n=== V3 管理员机制实测完成 ===')
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
