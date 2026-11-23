// 黑小帅 V2 认证模块
// - 密码：PBKDF2-SHA256（Web Crypto 原生，无依赖；格式 "pbkdf2$<iter>$<salt-b64>$<hash-b64>"）
// - 令牌：JWT（hono/jwt 内置，payload 含 uid + jti）
// - 会话：user_sessions 表落库，登出 / 全端登出可吊销
import { sign, verify } from 'hono/jwt'

const ITER = 100000
const KEY_LEN = 32
const TOKEN_TTL = 7 * 24 * 3600 // 7 天
const COOKIE_NAME = 'hxs_token'

// ---------- 密码哈希 ----------
const enc = new TextEncoder()
const b64 = (u8) => btoa(String.fromCharCode(...u8))
const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function derive(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    KEY_LEN * 8
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await derive(password, salt, ITER)
  return ['pbkdf2', ITER, b64(salt), b64(key)].join('$')
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, iter, saltB64, hashB64] = String(stored || '').split('$')
    if (algo !== 'pbkdf2') return false
    const salt = unb64(saltB64)
    const key = await derive(password, salt, parseInt(iter, 10) || ITER)
    const expect = unb64(hashB64)
    if (expect.length !== key.length) return false
    let diff = 0 // 常量时间比较，防时序侧信道
    for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ key[i]
    return diff === 0
  } catch {
    return false
  }
}

// ---------- JWT 签发 ----------
export async function issueToken(env, user) {
  const jti = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const payload = { uid: user.id, jti, iat: now, exp: now + TOKEN_TTL }
  // hono/jwt 在 Workers 环境要求显式 alg（HS256 对称签名，密钥即 JWT_SECRET）
  const token = await sign(payload, env.JWT_SECRET, 'HS256')
  // 会话入库（可吊销；过期会话由 V3 Cron 清理）
  await env.DB.prepare(
    'INSERT INTO user_sessions (user_id, token_id, expires_at) VALUES (?, ?, ?)'
  ).bind(user.id, jti, new Date(payload.exp * 1000).toISOString()).run()
  return { token, exp: payload.exp }
}

// ---------- 登录态中间件 ----------
// 支持 Authorization: Bearer <token>（fetch 请求）或 hxs_token Cookie（浏览器页面）
export async function requireAuth(c, next) {
  const r = await authGuard(c, true)
  if (r) return r
  await next()
}

// 可选登录态：有 token 就解析（供公开页面的个性化字段，如 isFollowing），无 token 放行
export async function optionalAuth(c, next) {
  const r = await authGuard(c, false)
  if (r) return r
  await next()
}

async function authGuard(c, required) {
  let token = null
  const auth = c.req.header('Authorization')
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7)
  if (!token) token = readCookie(c, COOKIE_NAME)

  if (!token) {
    return required ? c.json({ code: 401, message: '未登录，请先登录' }, 401) : null
  }

  let payload
  try {
    payload = await verify(token, c.env.JWT_SECRET, 'HS256')
  } catch {
    // 可选态下 token 无效视为未登录而非报错
    return required ? c.json({ code: 401, message: '登录已过期，请重新登录' }, 401) : null
  }

  // 会话吊销检查（登出后 JWT 立即失效）
  const sess = await c.env.DB.prepare(
    'SELECT is_active FROM user_sessions WHERE token_id = ?'
  ).bind(payload.jti).first()
  if (!sess || !sess.is_active) {
    return required ? c.json({ code: 401, message: '登录已失效，请重新登录' }, 401) : null
  }

  // 封禁实时校验（管理员封禁后，已签发 token 立即不可用）
  const user = await c.env.DB.prepare(
    'SELECT is_active FROM users WHERE id = ?'
  ).bind(payload.uid).first()
  if (!user || !user.is_active) {
    return required ? c.json({ code: 403, message: '该账号已被封禁，如有疑问请联系管理员' }, 403) : null
  }

  c.set('auth', { uid: payload.uid, jti: payload.jti })
  return null
}

function readCookie(c, name) {
  const raw = c.req.header('Cookie') || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

// ---------- 通知生成（写操作联动，失败不阻塞主流程）----------
// targetCommentId：评论类通知携带评论 id（前端用于定位/跳转到该评论），可空
export async function notify(env, { userId, senderId, type, title, content, targetId, targetCommentId }) {
  if (userId === senderId) return // 自己的操作不给自己发通知
  try {
    await env.DB.prepare(
      'INSERT INTO notifications (user_id, sender_id, type, title, content, target_id, target_comment_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, senderId, type, title, content || '', targetId || null, targetCommentId || null).run()
  } catch (e) {
    console.error('notify failed:', e && e.message)
  }
}
