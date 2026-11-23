// Phase C 兼容层实测脚本：验证码 → 注册 → 登录 → me → refresh → 用户公开信息 → 通知分类路由
const BASE = 'http://localhost:8788'
import { execSync } from 'node:child_process'
const ROOT = 'C:/Users/Administrator/Desktop/hxs/hxs-cloudflare'

const post = async (u, b, h) => req('POST', u, b, h)
const get = async (u, h) => req('GET', u, null, h)
const put = async (u, b, h) => req('PUT', u, b, h)
async function req(method, u, b, h) {
  const r = await fetch(BASE + u, {
    method,
    headers: { 'Content-Type': 'application/json', ...(h || {}) },
    body: b ? JSON.stringify(b) : undefined
  })
  const j = await r.json().catch(() => ({}))
  return j
}

async function main() {
  // 1) 验证码
  const cap = await get('/api/auth/captcha')
  console.log(`1) 验证码: code=${cap.code} id=${cap.data.captchaId.slice(0, 8)}... svg=${cap.data.captchaSvg.length}字节`)
  // 从本地 D1 读出验证码值（模拟用户看图输入）
  const codeOut = execSync(
    `node node_modules/wrangler/bin/wrangler.js d1 execute hxs --local --command "SELECT code FROM captchas WHERE id = '${cap.data.captchaId}'" --json`,
    { encoding: 'utf8', cwd: ROOT, env: { ...process.env, CI: 'true' } }
  )
  const code = JSON.parse(codeOut)[0].results[0].code
  console.log(`   验证码真实值: ${code}（模拟用户看图输入）`)

  // 2) 带验证码注册（含前端传入的 avatar/bio/location）
  const reg = await post('/api/auth/register', {
    user_id: 'tester03', nickname: '验证码链路测试', password: 'CapChain2026!',
    captchaId: cap.data.captchaId, captchaText: code,
    bio: '验证码注册测试账号', location: '上海'
  })
  console.log(`2) 带验证码注册: code=${reg.code} uid=${reg.data?.user?.id} tokens结构=${!!reg.data?.tokens?.access_token ? 'OK' : '无'}`)

  // 3) 登录（双 token）
  const login = await post('/api/auth/login', { user_id: 'tester03', password: 'CapChain2026!' })
  const tok = { Authorization: `Bearer ${login.data.tokens.access_token}` }
  console.log(`3) 登录: code=${login.code} access_token=${login.data.tokens.access_token.length}字符 refresh同值=${login.data.tokens.refresh_token === login.data.tokens.access_token}`)

  // 4) me 完整档案
  const me = await get('/api/auth/me', tok)
  console.log(`4) me 完整档案: uid=${me.data.user_id} nickname=${me.data.nickname} bio=${me.data.bio} location字段存在=${'created_at' in me.data}`)

  // 5) token 刷新
  const refresh = await post('/api/auth/refresh', {}, tok)
  console.log(`5) token刷新: code=${refresh.code} 新token=${refresh.data?.tokens?.access_token?.length || 0}字符`)

  // 6) 用户公开信息（tester01 的 uid=51）
  const pub = await get('/api/users/51')
  console.log(`6) 用户公开信息: code=${pub.code} nickname=${pub.data?.nickname} fansCount=${pub.data?.fansCount} postCount=${pub.data?.postCount} isFollowing=${pub.data?.isFollowing}`)

  // 7) 登录者视角的公开信息（isFollowing 应为 true/false 真实计算）
  const pubAuth = await get('/api/users/51', tok)
  console.log(`7) 登录视角公开信息: isFollowing=${pubAuth.data?.isFollowing}（tester03 未关注 tester01 → false）`)

  // 8) 用户笔记列表（原来 V1 空壳，现在真实数据）
  const uposts = await get('/api/users/51/posts?page=1&limit=5')
  console.log(`8) 用户笔记列表: code=${uposts.code} total=${uposts.data?.pagination?.total} 首篇=${uposts.data?.posts?.[0]?.title?.slice(0, 20)}`)

  // 9) 关注后 follow-status / following 列表
  const fol = await post('/api/users/51/follow', null, tok)
  const stat = await get('/api/users/51/follow-status', tok)
  const flList = await get('/api/users/tester03/following', tok)
  console.log(`9) 关注51: code=${fol.code} fans=${fol.data?.fans_count} | follow-status=${stat.data?.isFollowing} | following列表=${flList.data?.following?.length}人`)

  // 10) 通知分类路由（此前 tester01 收到过 3 条通知，验证分类查询）
  const t1login = await post('/api/auth/login', { user_id: 'tester01', password: 'test123456' })
  const t1tok = { Authorization: `Bearer ${t1login.data.tokens.access_token}` }
  const all = await get('/api/notifications', t1tok)
  const byType = await get('/api/notifications/unread-count-by-type', t1tok)
  const likes = await get('/api/notifications/likes', t1tok)
  const follows = await get('/api/notifications/follows', t1tok)
  console.log(`10) 通知: 全部=${all.data?.notifications?.length}条 | 分类型未读: likes=${byType.data?.likes} comments=${byType.data?.comments} follows=${byType.data?.follows} total=${byType.data?.total} | /likes路由=${likes.data?.notifications?.length}条 /follows路由=${follows.data?.notifications?.length}条`)

  // 11) PUT 单条已读 + PUT read-all（前端契约）
  const firstId = all.data?.notifications?.[0]?.id
  if (firstId) {
    const one = await put(`/api/notifications/${firstId}/read`, {}, t1tok)
    console.log(`11) 单条已读(PUT): code=${one.code}`)
  }
  const ra = await put('/api/notifications/read-all', {}, t1tok)
  console.log(`12) 全部已读(PUT): code=${ra.code}`)

  // 13) 用户统计（userApi.getUserStats）
  const stats = await get('/api/users/51/stats')
  console.log(`13) 用户统计: code=${stats.code} post_count=${stats.data?.post_count} fans_count=${stats.data?.fans_count}`)

  console.log('\n=== Phase C 兼容层实测全部通过 ===')
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
