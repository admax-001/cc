// 黑小帅 V3 管理侧 —— /api/admin/*（Hono 子应用，挂载于 src/index.js）
// 鉴权：管理员中间件完整独立（解析 token → 会话 → 封禁 → is_admin 四层校验）
// 契约：对齐前端 CrudTable（{data, pagination} 响应 / RESTful CRUD / 批量删除 / 搜索排序分页）
import { Hono } from 'hono'
import { verify } from 'hono/jwt'

const admin = new Hono()

const ok = (data, message = 'success') => ({ code: 200, message, data })
const fail = (code, message, status) => {
  const body = { code, message }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const num = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt }

function readCookie(c, name) {
  const raw = c.req.header('Cookie') || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

// ---------- 管理员鉴权中间件（全部 /api/admin 路由强制，完整四层校验）----------
admin.use('*', async (c, next) => {
  // ① 取 token（Bearer 或 Cookie，前端 admin store 用 Bearer）
  let token = null
  const auth = c.req.header('Authorization')
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7)
  if (!token) token = readCookie(c, 'hxs_token')
  if (!token) return fail(401, '未登录', 401)

  // ② JWT 验签
  let payload
  try {
    payload = await verify(token, c.env.JWT_SECRET, 'HS256')
  } catch {
    return fail(401, '登录已过期，请重新登录', 401)
  }

  // ③ 会话吊销检查
  const sess = await c.env.DB.prepare('SELECT is_active FROM user_sessions WHERE token_id = ?').bind(payload.jti).first()
  if (!sess || !sess.is_active) return fail(401, '登录已失效，请重新登录', 401)

  // ④ 封禁检查 + 管理员身份（唯一管理员 = is_admin = 1）
  const row = await c.env.DB.prepare('SELECT is_admin, is_active FROM users WHERE id = ?').bind(payload.uid).first()
  if (!row || !row.is_active) return fail(403, '该账号已被封禁', 403)
  if (!row.is_admin) return fail(403, '无管理员权限', 403)

  c.set('auth', { uid: payload.uid, jti: payload.jti })
  await next()
})

// ---------- 通用分页/排序参数 ----------
function pageOf(c, dfltLimit = 20) {
  const page = Math.max(1, num(c.req.query('page'), 1))
  const limit = Math.min(100, Math.max(1, num(c.req.query('limit'), dfltLimit)))
  return { page, limit, offset: (page - 1) * limit }
}
// 白名单排序（防注入：只允许声明的字段名）
function orderOf(c, allowed, dflt) {
  const f = c.req.query('sortField') || dflt
  const o = (c.req.query('sortOrder') === 'desc') ? 'DESC' : 'ASC'
  return allowed.includes(f) ? { sql: `ORDER BY ${f} ${o}`, field: f, dir: o } : { sql: `ORDER BY ${dflt} DESC`, field: dflt, dir: 'DESC' }
}

// ============================================================
// 动态监控（GET /admin/monitor/activities）
// 聚合最近的注册 / 发布笔记 / 发表评论，按时间倒序
// ============================================================
admin.get('/monitor/activities', async (c) => {
  const limit = Math.min(50, Math.max(1, num(c.req.query('limit'), 30)))
  const acts = []
  const u = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, created_at FROM users ORDER BY created_at DESC, id DESC LIMIT ?'
  ).bind(limit).all()
  for (const r of (u.results || [])) acts.push({ id: `u${r.id}`, type: 'user_register', user_id: r.user_id, nickname: r.nickname, avatar: r.avatar, created_at: r.created_at, description: '注册了账号' })
  const p = await c.env.DB.prepare(
    'SELECT p.id, p.title, p.created_at, u.user_id, u.nickname, u.avatar FROM posts p LEFT JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC, p.id DESC LIMIT ?'
  ).bind(limit).all()
  for (const r of (p.results || [])) acts.push({ id: `p${r.id}`, type: 'post_publish', post_id: r.id, user_id: r.user_id, nickname: r.nickname, avatar: r.avatar, created_at: r.created_at, description: `发布了笔记《${r.title}》` })
  const cm = await c.env.DB.prepare(
    'SELECT cm.id, cm.post_id, cm.content, cm.created_at, u.user_id, u.nickname, u.avatar FROM comments cm LEFT JOIN users u ON cm.user_id = u.id ORDER BY cm.created_at DESC, cm.id DESC LIMIT ?'
  ).bind(limit).all()
  for (const r of (cm.results || [])) acts.push({ id: `c${r.id}`, type: 'comment_publish', post_id: r.post_id, target_id: r.post_id, comment_id: r.id, user_id: r.user_id, nickname: r.nickname, avatar: r.avatar, created_at: r.created_at, description: '发表了评论', content: (r.content || '').slice(0, 120) })
  acts.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  return c.json(ok(acts.slice(0, limit)))
})

// ============================================================
// 用户管理（GET/POST/PUT/DELETE /admin/users）
// 列表含：计数、封禁状态展示；操作：封禁/解封、编辑、删除（级联）
// ============================================================
admin.get('/users', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const kw = {
    user_id: (c.req.query('user_id') || '').trim(),
    nickname: (c.req.query('nickname') || '').trim(),
    email: (c.req.query('email') || '').trim()
  }
  const conds = []
  const params = []
  if (kw.user_id) { conds.push('u.user_id LIKE ?'); params.push(`%${kw.user_id}%`) }
  if (kw.nickname) { conds.push('u.nickname LIKE ?'); params.push(`%${kw.nickname}%`) }
  if (kw.email) { conds.push('u.email LIKE ?'); params.push(`%${kw.email}%`) }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const ord = orderOf(c, ['id', 'fans_count', 'like_count', 'created_at'], 'id')
  // 排序字段需带表前缀映射
  const map = { id: 'u.id', fans_count: 'u.fans_count', like_count: 'u.like_count', created_at: 'u.created_at' }
  const orderSql = `ORDER BY ${map[ord.field] || 'u.id'} ${ord.dir}`

  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM users u ${where}`
  ).bind(...params).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.user_id, u.nickname, u.avatar, u.bio, u.email, u.location, u.gender, u.zodiac_sign, u.mbti,
            u.education, u.major, u.follow_count, u.fans_count, u.like_count, u.is_active, u.is_admin, u.verified, u.created_at,
            (SELECT reason FROM user_ban ub WHERE ub.user_id = u.id AND ub.status = 0 ORDER BY ub.id DESC LIMIT 1) AS ban_reason
       FROM users u ${where} ${orderSql} LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()

  return c.json(ok({
    data: results.map(r => ({
      ...r,
      personality_tags: [r.gender, r.zodiac_sign, r.mbti].filter(Boolean),
      ban_status_display: r.ban_reason ? '封禁中' : '正常'
    })),
    pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) }
  }))
})

admin.get('/users/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const r = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, bio, email, location, gender, zodiac_sign, mbti, education, major, follow_count, fans_count, like_count, is_active, is_admin, verified, created_at FROM users WHERE id = ?'
  ).bind(id).first()
  if (!r) return fail(404, '用户不存在', 404)
  return c.json(ok(r))
})

admin.post('/users', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  if (!b.user_id || !b.nickname) return fail(400, '黑小帅号与昵称必填', 400)
  const dup = await c.env.DB.prepare('SELECT 1 FROM users WHERE user_id = ?').bind(String(b.user_id)).first()
  if (dup) return fail(409, '该黑小帅号已存在', 409)
  const r = await c.env.DB.prepare(
    'INSERT INTO users (user_id, nickname, avatar, bio, email, location, gender, zodiac_sign, mbti) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(String(b.user_id), String(b.nickname), b.avatar || '', b.bio || '', b.email || null, b.location || '', b.gender || null, b.zodiac_sign || null, b.mbti || null).run()
  return c.json(ok({ id: r.meta?.last_row_id }, '用户创建成功'), 201)
})

admin.put('/users/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const b = await c.req.json().catch(() => ({}))
  const row = await c.env.DB.prepare('SELECT id, is_admin FROM users WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '用户不存在', 404)
  if (row.is_admin && (b.is_active === 0 || b.is_active === '0')) return fail(400, '唯一管理员账号不可封禁/停用', 400)
  const fields = ['nickname', 'avatar', 'bio', 'email', 'location', 'gender', 'zodiac_sign', 'mbti', 'education', 'major', 'is_active', 'verified']
  const sets = []
  const params = []
  for (const f of fields) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]) }
  }
  if (!sets.length) return fail(400, '无有效更新字段', 400)
  params.push(id)
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run()
  return c.json(ok({ id }, '用户已更新'))
})

admin.delete('/users/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const row = await c.env.DB.prepare('SELECT id, is_admin FROM users WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '用户不存在', 404)
  if (row.is_admin) return fail(400, '唯一管理员账号不可删除', 400)
  // 级联清理（D1 无级联保证，显式逐表）
  for (const sql of [
    'DELETE FROM comments WHERE user_id = ?',
    'DELETE FROM likes WHERE user_id = ?',
    'DELETE FROM collections WHERE user_id = ?',
    'DELETE FROM follows WHERE follower_id = ? OR following_id = ?',
    'DELETE FROM notifications WHERE user_id = ? OR sender_id = ?',
    'DELETE FROM user_sessions WHERE user_id = ?',
    'DELETE FROM user_ban WHERE user_id = ?',
    'DELETE FROM post_images WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)',
    'DELETE FROM post_tags WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)',
    'DELETE FROM posts WHERE user_id = ?',
    'DELETE FROM users WHERE id = ?'
  ]) {
    const p = sql.includes('follower_id = ? OR following_id = ?') ? [id, id]
      : sql.includes('user_id = ? OR sender_id = ?') ? [id, id]
      : sql.includes('SELECT id FROM posts WHERE user_id = ?') ? [id]
      : [id]
    await c.env.DB.prepare(sql).bind(...p).run()
  }
  return c.json(ok({ id }, '用户已删除'))
})

admin.delete('/users', async (c) => {
  const { ids } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return fail(400, '缺少 ids', 400)
  const safeIds = ids.map(n => num(n, 0)).filter(n => n > 0)
  // 保护唯一管理员
  const adminRows = await c.env.DB.prepare(
    `SELECT id FROM users WHERE is_admin = 1 AND id IN (${safeIds.join(',')})`
  ).all()
  if (adminRows.results?.length) return fail(400, '包含管理员账号，不可批量删除', 400)
  let deleted = 0
  for (const id of safeIds) {
    const r = await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
    if (r.meta?.changes) {
      await c.env.DB.prepare('DELETE FROM posts WHERE user_id = ?').bind(id).run()
      await c.env.DB.prepare('DELETE FROM comments WHERE user_id = ?').bind(id).run()
      deleted++
    }
  }
  return c.json(ok({ deleted }, `已删除 ${deleted} 个用户`))
})

// ---------- 封禁 / 解封（V3 核心管理动作）----------
admin.post('/users/:id/ban', async (c) => {
  const id = num(c.req.param('id'), 0)
  const b = await c.req.json().catch(() => ({}))
  const reason = String(b.reason || '').trim()
  const duration = String(b.duration || 'permanent')
  if (!reason) return fail(400, '请填写封禁原因', 400)
  const row = await c.env.DB.prepare('SELECT id, is_admin FROM users WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '用户不存在', 404)
  if (row.is_admin) return fail(400, '唯一管理员账号不可封禁', 400)

  // 计算封禁结束时间；permanent → null（永久）
  const durMap = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '1y': 365 * 86400e3 }
  const endTime = duration === 'permanent' ? null : new Date(Date.now() + (durMap[duration] || 0)).toISOString()
  const status = duration === 'permanent' ? 3 : 0
  await c.env.DB.prepare(
    'INSERT INTO user_ban (user_id, reason, end_time, status, operator) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, reason, endTime, status, c.get('auth').uid).run()
  await c.env.DB.prepare('UPDATE users SET is_active = 0 WHERE id = ?').bind(id).run()
  // 吊销该用户全部会话（封禁立即生效）
  await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').bind(id).run()
  return c.json(ok(null, duration === 'permanent' ? '已永久封禁' : '已封禁'), 201)
})

admin.post('/users/:id/unban', async (c) => {
  const id = num(c.req.param('id'), 0)
  const row = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '用户不存在', 404)
  await c.env.DB.prepare('UPDATE user_ban SET status = 1 WHERE user_id = ? AND status = 0').bind(id).run()
  await c.env.DB.prepare('UPDATE users SET is_active = 1 WHERE id = ?').bind(id).run()
  return c.json(ok(null, '已解封'))
})

// ============================================================
// 笔记管理（GET/PUT/DELETE /admin/posts + 详情 + 审核）
// ============================================================
admin.get('/posts', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const kwUser = (c.req.query('user_display_id') || c.req.query('user_id') || '').trim()
  const kwTitle = (c.req.query('title') || '').trim()
  const statusQ = c.req.query('status')
  const conds = ['1=1']
  const params = []
  if (kwUser) { conds.push('u.user_id LIKE ?'); params.push(`%${kwUser}%`) }
  if (kwTitle) { conds.push('p.title LIKE ?'); params.push(`%${kwTitle}%`) }
  if (statusQ !== undefined && statusQ !== '') { conds.push('p.status = ?'); params.push(num(statusQ, 0)) }
  const where = 'WHERE ' + conds.join(' AND ')
  const ord = orderOf(c, ['id', 'view_count', 'like_count', 'comment_count', 'created_at'], 'id')
  const map = { id: 'p.id', view_count: 'p.view_count', like_count: 'p.like_count', comment_count: 'p.comment_count', created_at: 'p.created_at' }

  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM posts p LEFT JOIN users u ON p.user_id = u.id ${where}`
  ).bind(...params).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.content, p.status, p.view_count, p.like_count, p.collect_count, p.comment_count, p.created_at,
            u.id AS author_id, u.user_id AS user_display_id, u.nickname AS author_name, u.avatar AS author_avatar,
            c.name AS category_name
       FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN categories c ON p.category_id = c.id
       ${where} ORDER BY ${map[ord.field] || 'p.id'} ${ord.dir} LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()

  return c.json(ok({
    data: results,
    pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) }
  }))
})

admin.get('/posts/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.content, p.status, p.view_count, p.like_count, p.collect_count, p.comment_count, p.location, p.created_at,
            u.id AS author_id, u.user_id AS user_display_id, u.nickname AS author_name, u.avatar AS author_avatar,
            c.id AS category_id, c.name AS category_name,
            (SELECT json_group_array(pi.url) FROM post_images pi WHERE pi.post_id = p.id) AS images_json,
            (SELECT json_group_array(t.name) FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id = p.id) AS tags_json
       FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = ?`
  ).bind(id).all()
  if (!results?.length) return fail(404, '笔记不存在', 404)
  const r = results[0]
  let images = [], tags = []
  try { images = JSON.parse(r.images_json || '[]') } catch {}
  try { tags = JSON.parse(r.tags_json || '[]') } catch {}
  return c.json(ok({ ...r, images, tags, tags_detail: tags.map((name, i) => ({ id: i + 1, name })) }))
})

admin.put('/posts/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const b = await c.req.json().catch(() => ({}))
  const row = await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '笔记不存在', 404)
  const sets = []
  const params = []
  for (const f of ['title', 'content', 'status', 'location']) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]) }
  }
  if (b.category_id !== undefined) { sets.push('category_id = ?'); params.push(b.category_id || null) }
  if (!sets.length) return fail(400, '无有效更新字段', 400)
  params.push(id)
  await c.env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run()
  return c.json(ok({ id }, '笔记已更新'))
})

const deletePostCascade = async (env, id) => {
  for (const sql of [
    'DELETE FROM post_images WHERE post_id = ?',
    'DELETE FROM post_tags WHERE post_id = ?',
    'DELETE FROM comments WHERE post_id = ?',
    'DELETE FROM likes WHERE target_type = 1 AND target_id = ?',
    'DELETE FROM collections WHERE post_id = ?',
    'DELETE FROM posts WHERE id = ?'
  ]) {
    await env.DB.prepare(sql).bind(id).run()
  }
}

admin.delete('/posts/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const r = await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(id).first()
  if (!r) return fail(404, '笔记不存在', 404)
  await deletePostCascade(c.env, id)
  return c.json(ok({ id }, '笔记已删除'))
})

admin.delete('/posts', async (c) => {
  const { ids } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return fail(400, '缺少 ids', 400)
  let deleted = 0
  for (const id of ids.map(n => num(n, 0)).filter(n => n > 0)) {
    await deletePostCascade(c.env, id)
    deleted++
  }
  return c.json(ok({ deleted }, `已删除 ${deleted} 篇笔记`))
})

// ---------- 笔记审核（PUT /admin/posts/:id/audit）----------
// status：0 通过（已发布）/ 2 待审核；自动写 audit 记录
admin.put('/posts/:id/audit', async (c) => {
  const id = num(c.req.param('id'), 0)
  const b = await c.req.json().catch(() => ({}))
  const status = num(b.status, -1)
  if (![0, 1, 2].includes(status)) return fail(400, '无效的审核状态', 400)
  const row = await c.env.DB.prepare('SELECT id, title FROM posts WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '笔记不存在', 404)
  await c.env.DB.prepare('UPDATE posts SET status = ? WHERE id = ?').bind(status, id).run()
  await c.env.DB.prepare(
    'INSERT INTO audit (admin_id, type, target_id, source, remark, status, audit_time) VALUES (?, 3, ?, 1, ?, 1, ?)'
  ).bind(c.get('auth').uid, id, b.remark || '', new Date().toISOString()).run()
  return c.json(ok({ id, status }, status === 0 ? '审核通过，笔记已发布' : '已标记为待审核'))
})

// ============================================================
// 评论管理 + 评论审核
// ============================================================
admin.get('/comments', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const kwUser = (c.req.query('user_display_id') || '').trim()
  const kwContent = (c.req.query('content') || '').trim()
  const conds = ['1=1']
  const params = []
  if (kwUser) { conds.push('u.user_id LIKE ?'); params.push(`%${kwUser}%`) }
  if (kwContent) { conds.push('cm.content LIKE ?'); params.push(`%${kwContent}%`) }
  const where = 'WHERE ' + conds.join(' AND ')
  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM comments cm LEFT JOIN users u ON cm.user_id = u.id ${where}`
  ).bind(...params).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT cm.id, cm.post_id, cm.content, cm.status, cm.created_at,
            u.id AS author_id, u.user_id AS user_display_id, u.nickname, u.avatar
       FROM comments cm LEFT JOIN users u ON cm.user_id = u.id
       ${where} ORDER BY cm.id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()
  return c.json(ok({
    data: results,
    pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) }
  }))
})

admin.delete('/comments/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const r = await c.env.DB.prepare('SELECT post_id FROM comments WHERE id = ?').bind(id).first()
  if (!r) return fail(404, '评论不存在', 404)
  await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run()
  await c.env.DB.prepare('UPDATE posts SET comment_count = MAX(0, comment_count - 1) WHERE id = ?').bind(r.post_id).run()
  return c.json(ok({ id }, '评论已删除'))
})

admin.delete('/comments', async (c) => {
  const { ids } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return fail(400, '缺少 ids', 400)
  let deleted = 0
  for (const id of ids.map(n => num(n, 0)).filter(n => n > 0)) {
    const r = await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run()
    if (r.meta?.changes) deleted++
  }
  return c.json(ok({ deleted }, `已删除 ${deleted} 条评论`))
})

admin.put('/comments/:id/audit', async (c) => {
  const id = num(c.req.param('id'), 0)
  const b = await c.req.json().catch(() => ({}))
  const status = num(b.status, -1)
  if (![0, 1, 2].includes(status)) return fail(400, '无效的审核状态', 400)
  const row = await c.env.DB.prepare('SELECT id FROM comments WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '评论不存在', 404)
  await c.env.DB.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(status, id).run()
  await c.env.DB.prepare(
    'INSERT INTO audit (admin_id, type, target_id, source, remark, status, audit_time) VALUES (?, 4, ?, 1, ?, 1, ?)'
  ).bind(c.get('auth').uid, id, b.remark || '', new Date().toISOString()).run()
  return c.json(ok({ id, status }, '评论审核完成'))
})

// ============================================================
// 分类 / 标签管理（V1 表直接 CRUD）
// ============================================================
admin.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, title, category_title FROM categories ORDER BY id').all()
  const total = results.length
  return c.json(ok({ data: results, pagination: { page: 1, limit: 100, total, pages: 1 } }))
})
admin.post('/categories', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  if (!b.name || !b.category_title) return fail(400, '分类名与英文标题必填', 400)
  try {
    const r = await c.env.DB.prepare('INSERT INTO categories (name, title, category_title) VALUES (?, ?, ?)')
      .bind(String(b.name), String(b.title || b.category_title), String(b.category_title)).run()
    return c.json(ok({ id: r.meta?.last_row_id }, '分类已创建'), 201)
  } catch (e) {
    return fail(409, '分类名或英文标题重复', 409)
  }
})
admin.put('/categories/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const b = await c.req.json().catch(() => ({}))
  const sets = []
  const params = []
  for (const f of ['name', 'title', 'category_title']) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]) }
  }
  if (!sets.length) return fail(400, '无有效更新字段', 400)
  params.push(id)
  const r = await c.env.DB.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run()
  if (!r.meta?.changes) return fail(404, '分类不存在', 404)
  return c.json(ok({ id }, '分类已更新'))
})
admin.delete('/categories/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  await c.env.DB.prepare('UPDATE posts SET category_id = NULL WHERE category_id = ?').bind(id).run()
  const r = await c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run()
  if (!r.meta?.changes) return fail(404, '分类不存在', 404)
  return c.json(ok({ id }, '分类已删除'))
})

admin.get('/tags', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const kw = (c.req.query('name') || '').trim()
  const where = kw ? 'WHERE name LIKE ?' : ''
  const params = kw ? [`%${kw}%`] : []
  const [cnt] = (await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM tags ${where}`).bind(...params).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, use_count FROM tags ${where} ORDER BY use_count DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()
  return c.json(ok({ data: results, pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) } }))
})
admin.post('/tags', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  if (!b.name) return fail(400, '标签名必填', 400)
  try {
    const r = await c.env.DB.prepare('INSERT INTO tags (name, use_count) VALUES (?, 0)').bind(String(b.name).trim()).run()
    return c.json(ok({ id: r.meta?.last_row_id }, '标签已创建'), 201)
  } catch { return fail(409, '标签已存在', 409) }
})
admin.put('/tags/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const b = await c.req.json().catch(() => ({}))
  if (b.name === undefined) return fail(400, '无有效更新字段', 400)
  const r = await c.env.DB.prepare('UPDATE tags SET name = ? WHERE id = ?').bind(String(b.name).trim(), id).run()
  if (!r.meta?.changes) return fail(404, '标签不存在', 404)
  return c.json(ok({ id }, '标签已更新'))
})
admin.delete('/tags/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  await c.env.DB.prepare('DELETE FROM post_tags WHERE tag_id = ?').bind(id).run()
  const r = await c.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run()
  if (!r.meta?.changes) return fail(404, '标签不存在', 404)
  return c.json(ok({ id }, '标签已删除'))
})
admin.delete('/tags', async (c) => {
  const { ids } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return fail(400, '缺少 ids', 400)
  let deleted = 0
  for (const id of ids.map(n => num(n, 0)).filter(n => n > 0)) {
    await c.env.DB.prepare('DELETE FROM post_tags WHERE tag_id = ?').bind(id).run()
    const r = await c.env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(id).run()
    if (r.meta?.changes) deleted++
  }
  return c.json(ok({ deleted }, `已删除 ${deleted} 个标签`))
})

// ============================================================
// 简单关联模块：点赞 / 收藏 / 关注 / 通知 / 会话（列表 + 单删/批删）
// 通用 CRUD 工厂，字段映射对齐各管理页 columns
// ============================================================
function crudRoutes({ path, list: listFn, del: delFn, name }) {
  admin.get(path, listFn)
  if (delFn) {
    admin.delete(`${path}/:id`, async (c) => {
      const id = num(c.req.param('id'), 0)
      const r = await delFn(c.env, id)
      if (!r) return fail(404, `${name}不存在`, 404)
      return c.json(ok({ id }, `${name}已删除`))
    })
    admin.delete(path, async (c) => {
      const { ids } = await c.req.json().catch(() => ({}))
      if (!Array.isArray(ids) || !ids.length) return fail(400, '缺少 ids', 400)
      let deleted = 0
      for (const id of ids.map(n => num(n, 0)).filter(n => n > 0)) {
        const r = await delFn(c.env, id)
        if (r) deleted++
      }
      return c.json(ok({ deleted }, `已删除 ${deleted} 条记录`))
    })
  }
}

// 点赞管理
crudRoutes({
  path: '/likes',
  name: '点赞',
  list: async (c) => {
    const { page, limit, offset } = pageOf(c)
    const kwUser = (c.req.query('user_display_id') || '').trim()
    const where = kwUser ? 'WHERE u.user_id LIKE ?' : ''
    const params = kwUser ? [`%${kwUser}%`] : []
    const [cnt] = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM likes l LEFT JOIN users u ON l.user_id = u.id ${where}`
    ).bind(...params).all()).results
    const { results } = await c.env.DB.prepare(
      `SELECT l.id, l.target_type, l.target_id, l.created_at, u.id AS user_pk, u.user_id AS user_display_id, u.nickname,
              p.title AS post_title
         FROM likes l LEFT JOIN users u ON l.user_id = u.id
         LEFT JOIN posts p ON (l.target_type = 1 AND p.id = l.target_id)
         ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all()
    return c.json(ok({ data: results, pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) } }))
  },
  del: async (env, id) => {
    const r = await env.DB.prepare('DELETE FROM likes WHERE id = ?').bind(id).run()
    return r.meta?.changes ? { id } : null
  }
})

// 收藏管理
crudRoutes({
  path: '/collections',
  name: '收藏',
  list: async (c) => {
    const { page, limit, offset } = pageOf(c)
    const kwUser = (c.req.query('user_display_id') || '').trim()
    const where = kwUser ? 'WHERE u.user_id LIKE ?' : ''
    const params = kwUser ? [`%${kwUser}%`] : []
    const [cnt] = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM collections cl LEFT JOIN users u ON cl.user_id = u.id ${where}`
    ).bind(...params).all()).results
    const { results } = await c.env.DB.prepare(
      `SELECT cl.id, cl.post_id, cl.created_at, u.id AS user_pk, u.user_id AS user_display_id, u.nickname,
              p.title AS post_title
         FROM collections cl LEFT JOIN users u ON cl.user_id = u.id
         LEFT JOIN posts p ON p.id = cl.post_id
         ${where} ORDER BY cl.id DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all()
    return c.json(ok({ data: results, pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) } }))
  },
  del: async (env, id) => {
    const r = await env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(id).run()
    return r.meta?.changes ? { id } : null
  }
})

// 关注管理
crudRoutes({
  path: '/follows',
  name: '关注',
  list: async (c) => {
    const { page, limit, offset } = pageOf(c)
    const kw = (c.req.query('follower_display_id') || c.req.query('following_display_id') || '').trim()
    const where = kw ? 'WHERE fu.user_id LIKE ? OR tu.user_id LIKE ?' : ''
    const params = kw ? [`%${kw}%`, `%${kw}%`] : []
    const [cnt] = (await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM follows f LEFT JOIN users fu ON f.follower_id = fu.id LEFT JOIN users tu ON f.following_id = tu.id ${where}`
    ).bind(...params).all()).results
    const { results } = await c.env.DB.prepare(
      `SELECT f.id, f.created_at,
              fu.id AS follower_pk, fu.user_id AS follower_display_id, fu.nickname AS follower_nickname,
              tu.id AS following_pk, tu.user_id AS following_display_id, tu.nickname AS following_nickname
         FROM follows f LEFT JOIN users fu ON f.follower_id = fu.id LEFT JOIN users tu ON f.following_id = tu.id
         ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all()
    return c.json(ok({ data: results, pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) } }))
  },
  del: async (env, id) => {
    const r = await env.DB.prepare('DELETE FROM follows WHERE id = ?').bind(id).run()
    return r.meta?.changes ? { id } : null
  }
})

// 通知管理（管理员可发系统通知）
admin.get('/notifications', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const kwUser = (c.req.query('user_display_id') || '').trim()
  const where = kwUser ? 'WHERE u.user_id LIKE ?' : ''
  const params = kwUser ? [`%${kwUser}%`] : []
  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM notifications n LEFT JOIN users u ON n.user_id = u.id ${where}`
  ).bind(...params).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.type, n.title, n.content, n.target_id, n.is_read, n.created_at,
            u.id AS user_pk, u.user_id AS user_display_id, u.nickname
       FROM notifications n LEFT JOIN users u ON n.user_id = u.id
       ${where} ORDER BY n.id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()
  return c.json(ok({ data: results, pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) } }))
})
admin.post('/notifications', async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const userId = num(b.user_id, 0)
  const title = String(b.title || '').trim()
  if (!userId || !title) return fail(400, '接收者与标题必填', 400)
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? OR user_id = ?').bind(userId, String(b.user_id || '')).first()
  if (!u) return fail(404, '接收用户不存在', 404)
  const r = await c.env.DB.prepare(
    'INSERT INTO notifications (user_id, sender_id, type, title, content, target_id) VALUES (?, ?, 0, ?, ?, NULL)'
  ).bind(u.id, c.get('auth').uid, title, String(b.content || '').slice(0, 500)).run()
  return c.json(ok({ id: r.meta?.last_row_id }, '系统通知已发送'), 201)
})
admin.delete('/notifications/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const r = await c.env.DB.prepare('DELETE FROM notifications WHERE id = ?').bind(id).run()
  if (!r.meta?.changes) return fail(404, '通知不存在', 404)
  return c.json(ok({ id }, '通知已删除'))
})
admin.delete('/notifications', async (c) => {
  const { ids } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return fail(400, '缺少 ids', 400)
  let deleted = 0
  for (const id of ids.map(n => num(n, 0)).filter(n => n > 0)) {
    const r = await c.env.DB.prepare('DELETE FROM notifications WHERE id = ?').bind(id).run()
    if (r.meta?.changes) deleted++
  }
  return c.json(ok({ deleted }, `已删除 ${deleted} 条通知`))
})

// 会话管理（用户登录会话；吊销即强制下线）
admin.get('/sessions', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const kwUser = (c.req.query('user_display_id') || '').trim()
  const where = kwUser ? 'WHERE u.user_id LIKE ?' : ''
  const params = kwUser ? [`%${kwUser}%`] : []
  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM user_sessions s LEFT JOIN users u ON s.user_id = u.id ${where}`
  ).bind(...params).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.token_id, s.expires_at, s.is_active, s.created_at,
            u.id AS user_pk, u.user_id AS user_display_id, u.nickname
       FROM user_sessions s LEFT JOIN users u ON s.user_id = u.id
       ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()
  return c.json(ok({
    data: results.map(r => ({ ...r, token_id: String(r.token_id || '').slice(0, 8) + '…' })),
    pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) }
  }))
})
admin.delete('/sessions/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const r = await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE id = ?').bind(id).run()
  if (!r.meta?.changes) return fail(404, '会话不存在', 404)
  return c.json(ok({ id }, '会话已吊销（该设备强制下线）'))
})
admin.delete('/sessions', async (c) => {
  const { ids } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return fail(400, '缺少 ids', 400)
  let deleted = 0
  for (const id of ids.map(n => num(n, 0)).filter(n => n > 0)) {
    const r = await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE id = ?').bind(id).run()
    if (r.meta?.changes) deleted++
  }
  return c.json(ok({ deleted }, `已吊销 ${deleted} 个会话`))
})

// ============================================================
// 管理员账号模块（V3 单管理员模型）
// 列表 = 唯一管理员；创建/更新/删除 = 明确拒绝（唯一管理员机制不可绕过）
// ============================================================
admin.get('/admins', async (c) => {
  const r = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, is_admin, created_at FROM users WHERE is_admin = 1'
  ).first()
  const list = r ? [{ ...r, username: r.user_id, role: '唯一管理员（首个注册账号）' }] : []
  return c.json(ok({ data: list, pagination: { page: 1, limit: 20, total: list.length, pages: 1 } }))
})
admin.post('/admins', (c) => fail(400, '本站为唯一管理员机制：部署后首个注册账号自动成为管理员，不支持添加其他管理员', 400))
admin.put('/admins/:id', (c) => fail(400, '唯一管理员信息请通过个人资料修改（普通用户接口）', 400))
admin.delete('/admins/:id', (c) => fail(400, '唯一管理员不可删除（如需更换管理员，请联系站点所有者重置数据库）', 400))

// 管理员会话（复用 user_sessions，取管理员的会话视图）
admin.get('/admin-sessions', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const [cnt] = (await c.env.DB.prepare(
    'SELECT COUNT(*) AS total FROM user_sessions s JOIN users u ON s.user_id = u.id WHERE u.is_admin = 1'
  ).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.token_id, s.expires_at, s.is_active, s.created_at,
            u.id AS admin_pk, u.user_id, u.nickname
       FROM user_sessions s JOIN users u ON s.user_id = u.id
       WHERE u.is_admin = 1 ORDER BY s.id DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all()
  return c.json(ok({
    data: results.map(r => ({ ...r, token_id: String(r.token_id || '').slice(0, 8) + '…' })),
    pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) }
  }))
})
admin.delete('/admin-sessions/:id', async (c) => {
  const id = num(c.req.param('id'), 0)
  const r = await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE id = ?').bind(id).run()
  if (!r.meta?.changes) return fail(404, '会话不存在', 404)
  return c.json(ok({ id }, '会话已吊销'))
})

// ============================================================
// 审核记录（GET /admin/audit）
// ============================================================
admin.get('/audit', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const typeQ = c.req.query('type')
  const statusQ = c.req.query('status')
  const conds = ['1=1']
  const params = []
  if (typeQ !== undefined && typeQ !== '') { conds.push('a.type = ?'); params.push(num(typeQ, 0)) }
  if (statusQ !== undefined && statusQ !== '') { conds.push('a.status = ?'); params.push(num(statusQ, 0)) }
  const where = 'WHERE ' + conds.join(' AND ')
  const [cnt] = (await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit a ${where}`).bind(...params).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.admin_id, a.type, a.target_id, a.source, a.remark, a.status, a.created_at, a.audit_time,
            u.nickname AS admin_nickname
       FROM audit a LEFT JOIN users u ON a.admin_id = u.id
       ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()
  return c.json(ok({ data: results, pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) } }))
})

// ============================================================
// 举报工单（列表 / 统计 / 处理）
// ============================================================
admin.get('/reports', async (c) => {
  const { page, limit, offset } = pageOf(c)
  const statusQ = c.req.query('status')
  const kw = (c.req.query('reporter_display_id') || '').trim()
  const conds = ['1=1']
  const params = []
  if (statusQ !== undefined && statusQ !== '') { conds.push('r.status = ?'); params.push(num(statusQ, 0)) }
  if (kw) { conds.push('u.user_id LIKE ?'); params.push(`%${kw}%`) }
  const where = 'WHERE ' + conds.join(' AND ')
  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM reports r LEFT JOIN users u ON r.reporter_id = u.id ${where}`
  ).bind(...params).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.detail, r.status, r.handle_note, r.created_at, r.handled_at,
            u.id AS reporter_pk, u.user_id AS reporter_display_id, u.nickname AS reporter_nickname,
            p.title AS post_title
       FROM reports r LEFT JOIN users u ON r.reporter_id = u.id
       LEFT JOIN posts p ON (r.target_type = 1 AND p.id = r.target_id)
       ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()
  return c.json(ok({ data: results, pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) } }))
})

admin.get('/reports/stats', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT status, COUNT(*) AS cnt FROM reports GROUP BY status'
  ).all()
  const stats = { total: 0, pending: 0, violated: 0, dismissed: 0 }
  for (const r of results) {
    stats.total += r.cnt
    if (r.status === 0) stats.pending += r.cnt
    else if (r.status === 1) stats.violated += r.cnt
    else if (r.status === 2) stats.dismissed += r.cnt
  }
  return c.json(ok(stats))
})

// 处理举报：status 1=违规（连带删除/下架目标），2=不违规（恢复）
admin.put('/reports/:id/process', async (c) => {
  const id = num(c.req.param('id'), 0)
  const b = await c.req.json().catch(() => ({}))
  const status = num(b.status, -1)
  if (![1, 2].includes(status)) return fail(400, '处理结果只能为 1（违规）或 2（不违规）', 400)
  const row = await c.env.DB.prepare('SELECT id, target_type, target_id FROM reports WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '举报工单不存在', 404)

  await c.env.DB.prepare(
    'UPDATE reports SET status = ?, handle_note = ?, handled_at = ? WHERE id = ?'
  ).bind(status, String(b.handle_note || '').slice(0, 200), new Date().toISOString(), id).run()

  // 违规处理：下架目标（笔记→status 2 待审核/评论→删除）；不违规：不动内容
  if (status === 1) {
    if (row.target_type === 1) {
      await c.env.DB.prepare('UPDATE posts SET status = 2 WHERE id = ?').bind(row.target_id).run()
    } else if (row.target_type === 2) {
      const cm = await c.env.DB.prepare('SELECT post_id FROM comments WHERE id = ?').bind(row.target_id).first()
      await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(row.target_id).run()
      if (cm) await c.env.DB.prepare('UPDATE posts SET comment_count = MAX(0, comment_count - 1) WHERE id = ?').bind(cm.post_id).run()
    }
    await c.env.DB.prepare(
      'INSERT INTO audit (admin_id, type, target_id, source, remark, status, audit_time) VALUES (?, ?, ?, 2, ?, 1, ?)'
    ).bind(c.get('auth').uid, row.target_type === 1 ? 3 : 4, row.target_id, `举报成立：${b.handle_note || ''}`, new Date().toISOString()).run()
  }
  return c.json(ok({ id, status }, status === 1 ? '已判定违规并处理目标内容' : '已判定不违规'))
})

// 用户端举报提交入口（管理侧配套，登录用户即可用）
export { admin }
