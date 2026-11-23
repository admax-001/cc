// 黑小帅 V3 API —— Cloudflare Workers (Hono)
// V1 只读 + V2 互动 + V3 管理员引导（首个注册账号成为唯一管理员）+ 前端静态资产兜底
// 响应结构完全对齐原 Vue3 前端 transformPostData 期望的字段名，
// 前端 api 层零改动即可对接。
import { Hono } from 'hono'
import { hashPassword, verifyPassword, issueToken, requireAuth, optionalAuth, notify } from './auth.js'
import { admin } from './admin.js'

const app = new Hono()

// ---------- 工具 ----------
const ok = (data, message = 'success') => ({ code: 200, message, data })
const fail = (code, message, status) => {
  const body = { code, message }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const v2 = (c) => fail(501, '该功能将在 V2 上线开放，敬请期待', 501)
const escapeLike = (kw) => kw.replace(/[\\%_]/g, (m) => '\\' + m)
const num = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt }
const pager = (c, dflt = 20) => {
  const page = Math.max(1, num(c.req.query('page'), 1))
  const limit = Math.min(50, Math.max(1, num(c.req.query('limit'), dflt)))
  return { page, limit, offset: (page - 1) * limit }
}
const parseImages = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : [] } catch { return [] } }

// 登录 Cookie（httpOnly 防 XSS 窃取；SameSite=Lax 跨页携带；生产 https 自动 Secure）
const setCookie = (c, token, expSec) => {
  c.header('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expSec}`,
    { append: true })
}
const clearCookie = (c) => {
  c.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, { append: true })
}

// 列表/详情共用的帖子字段（对齐原前端 transformPostData）
const POST_FIELDS = `
  p.id, p.title, p.content, p.location, p.video_url, p.cover_url, p.view_count, p.like_count, p.comment_count,
  p.status, p.created_at,
  u.id AS author_auto_id, u.user_id AS author_account, u.nickname, u.avatar AS user_avatar,
  u.bio AS author_bio, u.mbti AS author_mbti,
  c.name AS category,
  0 AS liked, 0 AS collected, 0 AS verified,
  COALESCE((SELECT json_group_array(pi.url) FROM post_images pi WHERE pi.post_id = p.id), '[]') AS images_json,
  (SELECT COUNT(*) FROM post_images pi2 WHERE pi2.post_id = p.id) AS image_count`

const toFrontPost = (r) => ({
  id: r.id,
  title: r.title,
  content: r.content || '',
  images: parseImages(r.images_json),
  image_count: r.image_count,
  cover_image: parseImages(r.images_json)[0] || null,
  location: r.location || '',
  view_count: r.view_count || 0,
  like_count: r.like_count || 0,
  comment_count: r.comment_count || 0,
  collect_count: 0,
  liked: false,
  collected: false,
  verified: 0,
  created_at: r.created_at,
  category: r.category || '',
  type: r.video_url ? 2 : 1,
  video: r.video_url ? { url: r.video_url, coverUrl: r.cover_url || null } : null,
  video_url: r.video_url || null,
  cover_url: r.cover_url || null,
  status: r.status,
  user_id: r.author_account || '',
  author_auto_id: r.author_auto_id,
  author_account: r.author_account || '',
  nickname: r.nickname || '匿名用户',
  user_avatar: r.user_avatar || '',
  tags_detail: r.tags_detail || [],
  tags: r.tags_detail ? r.tags_detail.map(t => t.name) : []
})

// 搜索接口专用：对齐原版扁平结构（搜索页不过 transformPostData，直接渲染）
const toFlatPost = (r) => ({
  id: r.id,
  title: r.title,
  content: r.content || '',
  images: parseImages(r.images_json),
  location: r.location || '',
  view_count: r.view_count || 0,
  like_count: r.like_count || 0,
  comment_count: r.comment_count || 0,
  collect_count: 0,
  liked: false,
  collected: false,
  created_at: r.created_at,
  category: r.category || '',
  type: 1,
  status: r.status,
  user_id: r.author_account || '',
  author_auto_id: r.author_auto_id,
  author_account: r.author_account || '',
  nickname: r.nickname || '匿名用户',
  user_avatar: r.user_avatar || '',
  avatar: r.user_avatar || '',
  author: r.nickname || '匿名用户'
})

// ---------- 健康检查 ----------
app.get('/api/health', (c) => c.json(ok({ status: 'ok', version: c.env.APP_VERSION || '1.0.0', time: new Date().toISOString() })))

// ---------- 分类列表 ----------
// 原前端 channels.js 用 category.category_title 作为路由路径
app.get('/api/categories', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, title, category_title FROM categories ORDER BY id').all()
  // 分类变动极少，边缘缓存 5 分钟
  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return c.json(ok(results))
})

// ---------- 笔记分页（瀑布流） ----------
// GET /api/posts?page=1&limit=20&category=<name|id>&status=0|1&user_id=<auto_id>&keyword=<搜索词>
// status=1（草稿）需登录且仅返回本人草稿（账号隔离）；status=0 为公开已发布
app.get('/api/posts', optionalAuth, async (c) => {
  const { page, limit, offset } = pager(c)
  const category = c.req.query('category') || ''
  const statusQ = c.req.query('status')

  // 草稿态：必须登录，且强制只能看自己的（忽略前端传的 user_id，防越权）
  let draftUid = null
  if (statusQ === '1') {
    const auth = c.get('auth')
    if (!auth || !auth.uid) return fail(401, '请先登录', 401)
    draftUid = auth.uid
  }

  let where = statusQ === '1' ? ' WHERE p.status = 1 AND p.user_id = ?' : ' WHERE p.status = 0'
  const params = []
  if (statusQ === '1') params.push(draftUid)
  // 对齐原版：recommend / general 为特殊频道值，不按分类过滤
  if (category && category !== 'recommend' && category !== 'general') {
    where += ' AND (c.name = ? OR CAST(c.id AS TEXT) = ? OR c.category_title = ?)'
    params.push(category, category, category)
  }
  // 草稿/个人主页：按作者过滤（仅公开态允许；草稿态强制本人已处理）
  const userQ = c.req.query('user_id')
  if (statusQ !== '1' && userQ && /^\d+$/.test(userQ)) {
    where += ' AND p.user_id = ?'
    params.push(num(userQ, 0))
  }
  // 关键词搜索（标题/正文）
  const keyword = (c.req.query('keyword') || '').trim()
  if (keyword) {
    where += ' AND (p.title LIKE ? OR p.content LIKE ?)'
    const kw = `%${keyword.replace(/[%_]/g, (m) => '\\' + m)}%`
    params.push(kw, kw)
  }

  const [countRow] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM posts p LEFT JOIN categories c ON p.category_id = c.id${where}`
  ).bind(...params).all()).results
  const total = countRow ? countRow.total : 0

  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_FIELDS}
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       LEFT JOIN categories c ON p.category_id = c.id${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()

  // 仅公开列表加边缘短缓存（60s 新鲜 + 5min 过期可用）；草稿列表绝不缓存
  if (statusQ !== '1') {
    c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  } else {
    c.header('Cache-Control', 'private, no-store')
  }
  return c.json(ok({
    posts: results.map(toFrontPost),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    seed: c.req.query('seed') || null
  }))
})

// ---------- 笔记详情 ----------
app.get('/api/posts/:id', optionalAuth, async (c) => {
  const id = num(c.req.param('id'), 0)
  if (id <= 0) return fail(400, '参数错误', 400)
  const skipView = c.req.query('skipViewCount') === 'true'
  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_FIELDS},
            (SELECT json_group_array(t.name) FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id = p.id) AS tags_json
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?`
  ).bind(id).all()
  if (!results || results.length === 0) return fail(404, '笔记不存在', 404)
  const p = results[0]
  // 非公开状态（1草稿/2审核中/3审核失败）仅作者本人可看：未登录或非本人一律 404（不泄露存在性）
  if (p.status !== 0) {
    const auth = c.get('auth')
    if (!auth || !auth.uid || auth.uid !== p.author_auto_id) return fail(404, '笔记不存在', 404)
  }
  if (!skipView && p.status === 0) {
    await c.env.DB.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').bind(id).run()
    p.view_count = (p.view_count || 0) + 1
  }
  const post = toFrontPost(p)
  try { post.tags = JSON.parse(p.tags_json || '[]') } catch { post.tags = [] }
  post.tags_detail = post.tags.map((name, i) => ({ id: i + 1, name }))
  return c.json(ok(post))
})

// ---------- 笔记评论 ----------
app.get('/api/posts/:id/comments', async (c) => {
  const id = num(c.req.param('id'), 0)
  if (id <= 0) return fail(400, '参数错误', 400)
  const { page, limit, offset } = pager(c, 10)

  const [countRow] = (await c.env.DB.prepare(
    'SELECT COUNT(*) AS total FROM comments WHERE post_id = ?'
  ).bind(id).all()).results
  const total = countRow ? countRow.total : 0

  const { results } = await c.env.DB.prepare(
    `SELECT cm.id, cm.post_id, cm.content, cm.created_at,
            u.id AS author_auto_id, u.user_id AS author_account, u.nickname, u.avatar AS user_avatar
       FROM comments cm LEFT JOIN users u ON cm.user_id = u.id
       WHERE cm.post_id = ?
       ORDER BY cm.created_at DESC, cm.id DESC
       LIMIT ? OFFSET ?`
  ).bind(id, limit, offset).all()

  return c.json(ok({
    comments: results.map((r) => ({
      id: r.id, post_id: r.post_id, parent_id: null, content: r.content,
      created_at: r.created_at, like_count: 0, liked: false,
      user_id: r.author_account || '', author_account: r.author_account || '',
      nickname: r.nickname || '匿名用户', user_avatar: r.user_avatar || '',
      user: { id: r.author_auto_id, user_id: r.author_account, nickname: r.nickname, avatar: r.user_avatar },
      replies: []
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  }))
})

// ---------- 热门标签 / 标签列表 ----------
app.get('/api/tags/hot', async (c) => {
  const limit = Math.min(50, Math.max(1, num(c.req.query('limit'), 20)))
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, use_count FROM tags ORDER BY use_count DESC, id LIMIT ?'
  ).bind(limit).all()
  return c.json(ok(results))
})
app.get('/api/tags', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, use_count FROM tags ORDER BY use_count DESC, id').all()
  return c.json(ok(results))
})

// ---------- 搜索（对齐原前端嵌套结构） ----------
// GET /api/search?type=posts&keyword=xxx&tag=&page=1&limit=20
// GET /api/search/posts?keyword=xxx&...
const searchHandler = async (c) => {
  const keyword = (c.req.query('keyword') || '').trim()
  const tag = (c.req.query('tag') || '').trim()
  if (!keyword && !tag) return fail(400, '缺少 keyword 或 tag 参数', 400)
  const { page, limit, offset } = pager(c)
  const kw = keyword ? '%' + escapeLike(keyword) + '%' : null
  const tg = tag ? '%' + escapeLike(tag) + '%' : null

  const conds = ['p.status = 0']
  const params = []
  if (kw) { conds.push('(p.title LIKE ? ESCAPE \'\\\' OR p.content LIKE ? ESCAPE \'\\\')'); params.push(kw, kw) }
  if (tg) { conds.push('t.name LIKE ? ESCAPE \'\\\''); params.push(tg) }
  const where = 'WHERE ' + conds.join(' AND ')

  const [countRow] = (await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT p.id) AS total
       FROM posts p
       LEFT JOIN post_tags pt ON pt.post_id = p.id
       LEFT JOIN tags t ON pt.tag_id = t.id
       ${where}`
  ).bind(...params).all()).results
  const total = countRow ? countRow.total : 0

  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_FIELDS}
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN post_tags pt ON pt.post_id = p.id
       LEFT JOIN tags t ON pt.tag_id = t.id
       ${where}
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all()

  const pagination = { page, limit, total, pages: Math.ceil(total / limit) }
  const type = c.req.query('type') || 'all'

  // 对齐原版结构：type=all 时 data 为扁平帖子数组 + tagStats；
  // type=posts/videos 时包一层 posts: {data, tagStats, pagination}
  const payload =
    type === 'all'
      ? { data: results.map(toFlatPost), tagStats: [], pagination }
      : { posts: { data: results.map(toFlatPost), tagStats: [], pagination } }

  return c.json(ok({
    keyword, tag: c.req.query('tag') || '', type,
    ...payload,
    users: { data: [], pagination: { page: 1, limit, total: 0, pages: 0 } },
    tags: { data: [], pagination: { page: 1, limit, total: 0, pages: 0 } }
  }))
}
app.get('/api/search', searchHandler)
app.get('/api/search/posts', searchHandler)

// ---------- 搜索联想（V1 返回空结构，前端联想框无内容但不报错） ----------
app.get('/api/search/suggest', async (c) => {
  const keyword = (c.req.query('keyword') || '').trim()
  let tags = []
  if (keyword) {
    const kw = '%' + escapeLike(keyword) + '%'
    const { results } = await c.env.DB.prepare(
      "SELECT name FROM tags WHERE name LIKE ? ESCAPE '\\' ORDER BY use_count DESC LIMIT 5"
    ).bind(kw).all()
    tags = results.map(r => ({ id: r.name, name: r.name }))
  }
  return c.json(ok({ tags, posts: [], users: [] }))
})

// ---------- 关注流（实装：已关注用户的帖子，时间倒序）----------
app.get('/api/posts/following', requireAuth, async (c) => {
  const uid = c.get('auth').uid
  const { page, limit, offset } = pager(c)
  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM posts p WHERE p.status = 0 AND p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)`
  ).bind(uid).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_FIELDS}
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.status = 0 AND p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
       ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`
  ).bind(uid, limit, offset).all()
  return c.json(ok({
    posts: results.map(toFrontPost),
    pagination: { page, limit, total: cnt ? cnt.total : 0, pages: Math.ceil((cnt ? cnt.total : 0) / limit) }
  }))
})

// ---------- 用户公开信息 ----------
app.get('/api/users/:userId', optionalAuth, async (c) => {
  const key = String(c.req.param('userId'))
  const row = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, bio, gender, mbti, verified, follow_count, fans_count, like_count, created_at FROM users WHERE id = ? OR user_id = ?'
  ).bind(num(key, -1), key).first()
  if (!row) return fail(404, '用户不存在', 404)

  // 当前登录者视角的关注状态与获赞/收藏总量
  let isFollowing = false
  const auth = c.get('auth')
  if (auth) {
    const f = await c.env.DB.prepare(
      'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?'
    ).bind(auth.uid, row.id).first()
    isFollowing = !!f
  }
  const stats = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM posts WHERE user_id = ? AND status = 0) AS post_count,
            (SELECT COALESCE(SUM(collect_count), 0) FROM posts WHERE user_id = ? AND status = 0) AS collect_total`
  ).bind(row.id, row.id).first()

  return c.json(ok({
    id: row.id, user_id: row.user_id, nickname: row.nickname, avatar: row.avatar, bio: row.bio,
    gender: row.gender, mbti: row.mbti, verified: row.verified,
    followCount: row.follow_count, fansCount: row.fans_count,
    likeAndCollectCount: (row.like_count || 0) + (stats.collect_total || 0),
    postCount: stats.post_count, isFollowing,
    images: [], created_at: row.created_at
  }))
})

// ---------- 用户笔记列表（实装：原 V1 空壳 → 真实分页）----------
// status=all 时返回本人全部状态（已发布/草稿/审核中/审核失败，供笔记管理页），仅限本人请求；
// 其余情况（含未登录/非本人）只返回公开已发布（status=0）
app.get('/api/users/:userId/posts', optionalAuth, async (c) => {
  const key = String(c.req.param('userId'))
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? OR user_id = ?').bind(num(key, -1), key).first()
  if (!u) return fail(404, '用户不存在', 404)
  const { page, limit, offset } = pager(c)
  const auth = c.get('auth')
  const isSelf = !!(auth && auth.uid === u.id)
  const wantAll = c.req.query('status') === 'all' && isSelf
  const statusCond = wantAll ? 'p.status IN (0, 1, 2, 3)' : 'p.status = 0'
  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM posts WHERE user_id = ? AND ${statusCond.includes('IN') ? 'status IN (0,1,2,3)' : 'status = 0'}`
  ).bind(u.id).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_FIELDS}
       FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.user_id = ? AND ${statusCond}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`
  ).bind(u.id, limit, offset).all()
  // 非公开状态的帖子附加说明字段（前端标签渲染用）
  const posts = results.map(r => ({ ...toFrontPost(r), author_self: isSelf }))
  return c.json(ok({
    posts,
    pagination: { page, limit, total: cnt ? cnt.total : 0, pages: Math.ceil((cnt ? cnt.total : 0) / limit) }
  }))
})

// ---------- 关注状态（当前登录者 → 目标用户）----------
app.get('/api/users/:userId/follow-status', requireAuth, async (c) => {
  const key = String(c.req.param('userId'))
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? OR user_id = ?').bind(num(key, -1), key).first()
  if (!u) return fail(404, '用户不存在', 404)
  const f = await c.env.DB.prepare(
    'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?'
  ).bind(c.get('auth').uid, u.id).first()
  return c.json(ok({ isFollowing: !!f }))
})

// ---------- 用户统计 ----------
app.get('/api/users/:userId/stats', async (c) => {
  const key = String(c.req.param('userId'))
  const u = await c.env.DB.prepare('SELECT id, like_count, follow_count, fans_count FROM users WHERE id = ? OR user_id = ?').bind(num(key, -1), key).first()
  if (!u) return fail(404, '用户不存在', 404)
  const s = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM posts WHERE user_id = ? AND status = 0) AS post_count,
            (SELECT COUNT(*) FROM comments WHERE user_id = ?) AS comment_count,
            (SELECT COUNT(*) FROM collections WHERE user_id = ?) AS collect_count`
  ).bind(u.id, u.id, u.id).first()
  return c.json(ok({
    post_count: s.post_count, comment_count: s.comment_count,
    collect_count: s.collect_count,
    like_count: u.like_count, follow_count: u.follow_count, fans_count: u.fans_count,
    // 兼容字段：个人主页"获赞与收藏"合计（旧字段名 likes_and_collects）
    likes_and_collects: (u.like_count || 0) + (s.collect_count || 0)
  }))
})

// ---------- 关注 / 粉丝列表（分页，含用户卡片字段）----------
const followListHandler = async (c, dir) => {
  const key = String(c.req.param('userId'))
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? OR user_id = ?').bind(num(key, -1), key).first()
  if (!u) return fail(404, '用户不存在', 404)
  const { page, limit, offset } = pager(c)
  // dir=following：我关注的；dir=followers：我的粉丝
  const joinCol = dir === 'following' ? 'f.following_id' : 'f.follower_id'
  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM follows f WHERE ${dir === 'following' ? 'f.follower_id' : 'f.following_id'} = ?`
  ).bind(u.id).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT us.id, us.user_id, us.nickname, us.avatar, us.bio, us.verified, us.fans_count, us.follow_count
       FROM follows f JOIN users us ON us.id = ${joinCol}
       WHERE ${dir === 'following' ? 'f.follower_id' : 'f.following_id'} = ?
       ORDER BY f.created_at DESC LIMIT ? OFFSET ?`
  ).bind(u.id, limit, offset).all()
  return c.json(ok({
    [dir]: results.map(r => ({
      id: r.id, user_id: r.user_id, nickname: r.nickname, avatar: r.avatar, bio: r.bio,
      verified: r.verified, fansCount: r.fans_count, followCount: r.follow_count
    })),
    pagination: { page, limit, total: cnt ? cnt.total : 0, pages: Math.ceil((cnt ? cnt.total : 0) / limit) }
  }))
}
app.get('/api/users/:userId/following', (c) => followListHandler(c, 'following'))
app.get('/api/users/:userId/followers', (c) => followListHandler(c, 'followers'))

// ---------- 用户收藏列表 ----------
app.get('/api/users/:userId/collections', requireAuth, async (c) => {
  const key = String(c.req.param('userId'))
  const u = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? OR user_id = ?').bind(num(key, -1), key).first()
  if (!u) return fail(404, '用户不存在', 404)
  if (u.id !== c.get('auth').uid) return fail(403, '收藏列表仅本人可见', 403)
  const { page, limit, offset } = pager(c)
  const [cnt] = (await c.env.DB.prepare(
    'SELECT COUNT(*) AS total FROM collections WHERE user_id = ?'
  ).bind(u.id).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_FIELDS}
       FROM collections cl
       JOIN posts p ON p.id = cl.post_id
       LEFT JOIN users u ON p.user_id = u.id
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE cl.user_id = ? AND p.status = 0
       ORDER BY cl.created_at DESC LIMIT ? OFFSET ?`
  ).bind(u.id, limit, offset).all()
  return c.json(ok({
    posts: results.map(toFrontPost),
    pagination: { page, limit, total: cnt ? cnt.total : 0, pages: Math.ceil((cnt ? cnt.total : 0) / limit) }
  }))
})

// ============================================================
// V2 互动侧 · 认证（登录 / 注册 / 登出 / 我的信息）
// ============================================================
const COOKIE_NAME = 'hxs_token'

// 校验规则（对齐原版）：黑小帅号 3-15 位字母数字下划线；密码 6-20 位；昵称 1-30
const validUserId = (s) => /^[A-Za-z0-9_]{3,15}$/.test(String(s || ''))
// 密码强度：8-64 位，至少包含字母与数字两类（大小写字母/数字/符号计 4 类，取 2）
const validPwd = (s) => {
  if (typeof s !== 'string' || s.length < 8 || s.length > 64) return { ok: false, msg: '密码长度需 8-64 位' }
  let kinds = 0
  if (/[a-z]/.test(s)) kinds++
  if (/[A-Z]/.test(s)) kinds++
  if (/[0-9]/.test(s)) kinds++
  if (/[^A-Za-z0-9]/.test(s)) kinds++
  if (kinds < 2) return { ok: false, msg: '密码不能太简单，需至少包含字母和数字两类字符' }
  return { ok: true }
}
// 弱密码黑名单（常见弱口令直接拒绝）
const WEAK_PWD = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'qwertyuiop', '11111111', '88888888', '66666666', 'abc12345', 'abcd1234', 'a1234567', '1234qwer', 'iloveyou1'])
const pwdBlocked = (s) => WEAK_PWD.has(String(s).toLowerCase()) || /^(\d)\1+$/.test(s) || /^(0123|1234|2345|3456|4567|5678|6789)\2+$/.test(s) // 顺子/重复

// ---------- 图形验证码（注册前置）----------
// 生成 4 位数字验证码，SVG 渲染，D1 存 5 分钟；插入时顺手清理过期行
app.get('/api/auth/captcha', async (c) => {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0')
  const id = crypto.randomUUID()
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  await c.env.DB.prepare("DELETE FROM captchas WHERE expires_at < datetime('now')").run()
  await c.env.DB.prepare('INSERT INTO captchas (id, code, expires_at) VALUES (?, ?, ?)').bind(id, code, expires).run()
  return c.json(ok({ captchaId: id, captchaSvg: renderCaptchaSvg(code) }))
})

// 简易 SVG 验证码（数字 + 干扰线 + 干扰点；无外部字体依赖）
function renderCaptchaSvg(code) {
  const rnd = (a, b) => a + Math.random() * (b - a)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="44" viewBox="0 0 120 44">`
  svg += `<rect width="120" height="44" fill="#f4f7fb"/>`
  for (let i = 0; i < 5; i++) {
    svg += `<line x1="${rnd(0, 120).toFixed(1)}" y1="${rnd(0, 44).toFixed(1)}" x2="${rnd(0, 120).toFixed(1)}" y2="${rnd(0, 44).toFixed(1)}" stroke="#c9d6f3" stroke-width="1"/>`
  }
  const colors = ['#0f1e33', '#3b82f6', '#2563eb', '#5b6b80']
  for (let i = 0; i < code.length; i++) {
    const x = 14 + i * 26 + rnd(-3, 3)
    const y = 30 + rnd(-4, 2)
    svg += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="26" font-weight="700" fill="${colors[i % 4]}" transform="rotate(${rnd(-12, 12).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" font-family="monospace">${code[i]}</text>`
  }
  for (let i = 0; i < 30; i++) {
    svg += `<circle cx="${rnd(0, 120).toFixed(1)}" cy="${rnd(0, 44).toFixed(1)}" r="1" fill="#dbe4ef"/>`
  }
  return svg + '</svg>'
}

// ---------- 注册 ----------
app.post('/api/auth/register', async (c) => {
  const { user_id, nickname, password, email, avatar: avatarIn, bio: bioIn, location: locationIn, captchaId, captchaText } = await c.req.json().catch(() => ({}))
  if (!validUserId(user_id)) return fail(400, '黑小帅号需 3-15 位字母、数字或下划线', 400)
  if (!nickname || String(nickname).trim().length === 0 || String(nickname).length > 30) return fail(400, '昵称需 1-30 个字符', 400)
  const pwdCheck = validPwd(password)
  if (!pwdCheck.ok) return fail(400, pwdCheck.msg, 400)
  if (pwdBlocked(password)) return fail(400, '密码过于简单，请更换更强的密码', 400)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, '邮箱格式不正确', 400)

  // 图形验证码校验（一次性：取出即删，过期拒用）
  const row = await c.env.DB.prepare('SELECT code, expires_at FROM captchas WHERE id = ?').bind(String(captchaId || '')).first()
  await c.env.DB.prepare('DELETE FROM captchas WHERE id = ?').bind(String(captchaId || '')).run()
  const expired = !row || new Date(row.expires_at) < new Date()
  if (!row || expired) return fail(400, '验证码已过期，请刷新后重试', 400)
  if (String(captchaText || '').trim() !== row.code) return fail(400, '验证码错误，请重新输入', 400)

  // 账号唯一性：先查后插 + UNIQUE 约束双重保护（并发下竞态由 UNIQUE 兑现）
  const dup = await c.env.DB.prepare('SELECT id FROM users WHERE user_id = ?').bind(user_id).first()
  if (dup) return fail(409, '该黑小帅号已被注册', 409)

  const hash = await hashPassword(password)
  const avatar = (typeof avatarIn === 'string' && /^https?:\/.+/.test(avatarIn)) ? avatarIn : `https://picsum.photos/seed/${encodeURIComponent(user_id)}/200/200`
  const bio = (typeof bioIn === 'string' && bioIn.trim()) ? bioIn.trim().slice(0, 100) : ''
  const location = (typeof locationIn === 'string' && locationIn.trim()) ? locationIn.trim().slice(0, 30) : null
  const r = await c.env.DB.prepare(
    'INSERT INTO users (user_id, nickname, avatar, bio, password_hash, email, location, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(user_id, nickname.trim(), avatar, bio, hash, email || null, location, new Date().toISOString()).run()
  const uid = r.meta?.last_row_id

  // —— V3 管理员引导：站点尚无管理员时，首个注册账号成为唯一管理员 ——
  // 唯一性三重保障：①此处先查后授 ②无其他任何写入 is_admin 的路径
  // ③部分唯一索引 idx_users_single_admin 数据库级兜底（并发竞态仅一条成功）
  let isAdmin = false
  const adminExists = await c.env.DB.prepare('SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1').first()
  if (!adminExists) {
    try {
      await c.env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(uid).run()
      isAdmin = true
    } catch (e) {
      // 并发竞态：另一个注册抢先成为管理员（部分唯一索引拒绝写入）
      console.error('管理员引导竞态（已有管理员）:', e && e.message)
    }
  }

  const user = { id: uid, user_id, nickname, avatar, bio: '', is_admin: isAdmin }
  const { token, exp } = await issueToken(c.env, user)
  setCookie(c, token, exp)
  // 前端 user store 契约：tokens.access_token / tokens.refresh_token（V2 双 token 简化为同值）
  const msg = isAdmin ? '注册成功！你已成为本站唯一管理员' : '注册成功'
  return c.json(ok({ user, tokens: { access_token: token, refresh_token: token, expiresIn: exp } }, msg), 201)
})

// ---------- 登录 ----------
app.post('/api/auth/login', async (c) => {
  const { user_id, password } = await c.req.json().catch(() => ({}))
  if (!user_id || !password) return fail(400, '请输入黑小帅号与密码', 400)

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, bio, gender, mbti, verified, is_admin, is_active, password_hash FROM users WHERE user_id = ?'
  ).bind(String(user_id)).first()
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return fail(401, '黑小帅号或密码错误', 401)
  }
  if (!row.is_active) {
    const ban = await c.env.DB.prepare(
      'SELECT reason, end_time FROM user_ban WHERE user_id = ? AND status = 0 ORDER BY id DESC LIMIT 1'
    ).bind(row.id).first()
    const until = ban && ban.end_time ? `，将于 ${ban.end_time.replace('T', ' ').slice(0, 16)} 解封` : ''
    return fail(403, `该账号已被封禁${until}${ban ? '：' + ban.reason : ''}`, 403)
  }

  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), row.id).run()

  const user = { id: row.id, user_id: row.user_id, nickname: row.nickname, avatar: row.avatar, bio: row.bio, gender: row.gender, mbti: row.mbti, verified: row.verified, is_admin: !!row.is_admin }
  const { token, exp } = await issueToken(c.env, user)
  setCookie(c, token, exp)
  return c.json(ok({ user, tokens: { access_token: token, refresh_token: token, expiresIn: exp } }, '登录成功'))
})

// ---------- 登出（吊销当前会话）----------
app.post('/api/auth/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE token_id = ?')
    .bind(c.get('auth').jti).run()
  clearCookie(c)
  return c.json(ok(null, '已退出登录'))
})

// ---------- 登出全部设备（吊销该用户全部会话）----------
app.post('/api/auth/logout-all', requireAuth, async (c) => {
  await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?')
    .bind(c.get('auth').uid).run()
  clearCookie(c)
  return c.json(ok(null, '已在全部设备退出登录'))
})

// ---------- Token 刷新（前端 401 兜底；V2 双 token 同值，验证通过即续签）----------
app.post('/api/auth/refresh', requireAuth, async (c) => {
  const uid = c.get('auth').uid
  const user = await c.env.DB.prepare('SELECT id, user_id, nickname, avatar FROM users WHERE id = ?').bind(uid).first()
  const { token, exp } = await issueToken(c.env, user)
  setCookie(c, token, exp)
  return c.json(ok({ tokens: { access_token: token, refresh_token: token, expiresIn: exp } }, '已刷新'))
})

// ---------- 当前登录用户信息（返回完整档案，前端 getCurrentUser 直接存 userInfo）----------
app.get('/api/auth/me', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, bio, gender, mbti, verified, is_admin, follow_count, fans_count, like_count, created_at FROM users WHERE id = ?'
  ).bind(c.get('auth').uid).first()
  if (!row) return fail(401, '用户不存在', 401)
  return c.json(ok({
    id: row.id, user_id: row.user_id, nickname: row.nickname, avatar: row.avatar, bio: row.bio,
    gender: row.gender, mbti: row.mbti, verified: row.verified, is_admin: !!row.is_admin,
    follow_count: row.follow_count, fans_count: row.fans_count, like_count: row.like_count,
    created_at: row.created_at
  }, '已登录'))
})

// ============================================================
// V3 · 管理员账号（首个注册账号即唯一管理员）
// 管理员登录复用站点账号（黑小帅号+密码），与原版独立 admin 表不同：
// 管理员就是“部署后第一个在网站注册的人”，无独立 admin 表，账号体系单一。
// ============================================================

// ---------- 管理员登录（前端 admin store 契约：data.admin + data.tokens）----------
app.post('/api/auth/admin/login', async (c) => {
  const { username, user_id, password } = await c.req.json().catch(() => ({}))
  const account = String(user_id || username || '').trim()
  if (!account || !password) return fail(400, '请输入账号与密码', 400)

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, bio, is_admin, password_hash FROM users WHERE user_id = ?'
  ).bind(account).first()
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return fail(401, '账号或密码错误', 401)
  }
  if (!row.is_admin) {
    return fail(403, '该账号不是管理员（本站唯一管理员为部署后首个注册账号）', 403)
  }

  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), row.id).run()

  const admin = { id: row.id, user_id: row.user_id, username: row.user_id, nickname: row.nickname, avatar: row.avatar, bio: row.bio, is_admin: true }
  const { token, exp } = await issueToken(c.env, row)
  setCookie(c, token, exp)
  return c.json(ok({ admin, tokens: { access_token: token, refresh_token: token, expiresIn: exp } }, '管理员登录成功'))
})

// ---------- 管理员信息（前端 adminApi.getCurrentAdmin）----------
app.get('/api/auth/admin/me', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, bio, is_admin FROM users WHERE id = ?'
  ).bind(c.get('auth').uid).first()
  if (!row || !row.is_admin) return fail(403, '无管理员权限', 403)
  return c.json(ok({
    admin: { id: row.id, user_id: row.user_id, username: row.user_id, nickname: row.nickname, avatar: row.avatar, bio: row.bio, is_admin: true }
  }))
})

// ---------- 管理员登出 / 刷新（复用用户会话机制）----------
app.post('/api/auth/admin/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE token_id = ?')
    .bind(c.get('auth').jti).run()
  clearCookie(c)
  return c.json(ok(null, '管理员已退出登录'))
})
app.post('/api/auth/admin/refresh', requireAuth, async (c) => {
  const user = await c.env.DB.prepare('SELECT id, user_id, nickname, avatar, is_admin FROM users WHERE id = ?').bind(c.get('auth').uid).first()
  if (!user || !user.is_admin) return fail(403, '无管理员权限', 403)
  const { token, exp } = await issueToken(c.env, user)
  setCookie(c, token, exp)
  return c.json(ok({ tokens: { access_token: token, refresh_token: token, expiresIn: exp } }, '已刷新'))
})

// ---------- 编辑个人资料（仅本人；:userId 兼容自增 id 与文本账号）----------
app.put('/api/users/:userId', requireAuth, async (c) => {
  const uid = c.get('auth').uid
  const key = String(c.req.param('userId'))
  // 路径参数必须指向本人（支持 id 或 user_id 两种写法）
  const me = await c.env.DB.prepare('SELECT id, user_id FROM users WHERE id = ?').bind(uid).first()
  if (!me) return fail(404, '用户不存在', 404)
  if (String(me.id) !== key && me.user_id !== key) return fail(403, '只能编辑自己的资料', 403)

  const b = await c.req.json().catch(() => ({}))
  // 可编辑字段白名单与限制（与 users 表列对齐）
  const fields = {}
  if (b.nickname != null) {
    const v = String(b.nickname).trim()
    if (!v || v.length > 30) return fail(400, '昵称必填且不超过 30 字', 400)
    fields.nickname = v
  }
  if (b.bio != null) fields.bio = String(b.bio).slice(0, 200)
  if (b.gender != null) fields.gender = ['male', 'female', 'secret'].includes(String(b.gender)) ? String(b.gender) : 'secret'
  if (b.mbti != null) fields.mbti = /^[A-Za-z]{0,4}$/.test(String(b.mbti).trim()) ? String(b.mbti).trim().toUpperCase() : ''
  if (b.avatar != null) {
    const v = String(b.avatar).trim()
    if (v && !/^https?:\/\//.test(v)) return fail(400, '头像必须是 http(s) 链接', 400)
    fields.avatar = v || null
  }
  if (b.email != null) {
    const v = String(b.email).trim()
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return fail(400, '邮箱格式不正确', 400)
    fields.email = v || null
  }
  if (b.location != null) fields.location = String(b.location).slice(0, 50) || null
  if (b.zodiac_sign != null) fields.zodiac_sign = String(b.zodiac_sign).slice(0, 20) || null
  if (b.education != null) fields.education = String(b.education).slice(0, 30) || null
  if (b.major != null) fields.major = String(b.major).slice(0, 50) || null

  const keys = Object.keys(fields)
  if (keys.length === 0) return fail(400, '没有可更新的字段', 400)
  await c.env.DB.prepare(
    `UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`
  ).bind(...keys.map(k => fields[k]), uid).run()

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, nickname, avatar, bio, gender, mbti, email, location, zodiac_sign, education, major, verified, follow_count, fans_count, like_count, created_at FROM users WHERE id = ?'
  ).bind(uid).first()
  return c.json(ok(row, '资料已更新'))
})

// ---------- 修改密码（兼容前端 PUT /users/:userId/password 路径）----------
const changePasswordHandler = async (c) => {
  const { old_password, new_password } = await c.req.json().catch(() => ({}))
  if (!old_password || !new_password) return fail(400, '请提供旧密码与新密码', 400)

  const uid = c.get('auth').uid
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(uid).first()
  if (!row || !(await verifyPassword(old_password, row.password_hash))) {
    return fail(401, '旧密码不正确', 401)
  }
  if (old_password === new_password) return fail(400, '新密码不能与旧密码相同', 400)

  const pwdCheck = validPwd(new_password)
  if (!pwdCheck.ok) return fail(400, pwdCheck.msg, 400)
  if (pwdBlocked(new_password)) return fail(400, '新密码过于简单，请更换更强的密码', 400)

  const hash = await hashPassword(new_password)
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, uid).run()

  // 吊销全部会话，再给当前设备签发新 token（其他设备强制下线）
  await c.env.DB.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').bind(uid).run()
  const user = await c.env.DB.prepare('SELECT id, user_id, nickname, avatar FROM users WHERE id = ?').bind(uid).first()
  const { token, exp } = await issueToken(c.env, user)
  setCookie(c, token, exp)
  return c.json(ok({ token, expiresIn: exp }, '密码修改成功，其他设备已退出登录'))
}
app.put('/api/auth/password', requireAuth, changePasswordHandler)
app.put('/api/users/:userId/password', requireAuth, changePasswordHandler)

// ============================================================
// V2 互动侧 · 写操作（发布 / 编辑 / 删除 / 点赞 / 收藏 / 关注 / 评论 / 通知）
// ============================================================

// ---------- 发布笔记 ----------
// body: { title, content, category_id?, images?: [url], tags?: [name], location? }
app.post('/api/posts', requireAuth, async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const uid = c.get('auth').uid
  const title = String(b.title || '').trim()
  const content = String(b.content || '').trim()
  // 状态：1=草稿；2=审核中（视频后台上传中：先落库占位，传完自动转发布，失败转 3）
  //       0/2 之外的值（包括前端旧发的 2=待审核）同 0 直接发布
  let status = 0
  if (b.status === 1 || b.status === '1') status = 1
  else if (b.status === 2 || b.status === '2') status = 2
  if (status === 0) {
    if (!title || title.length > 100) return fail(400, '标题必填且不超过 100 字', 400)
    if (!content) return fail(400, '正文不能为空', 400)
    if (content.length > 5000) return fail(400, '正文不超过 5000 字', 400)
  } else {
    // 草稿/审核中放宽：标题/正文至少一项非空；长度上限仍然生效
    if (!title && !content) return fail(400, '标题和正文至少填写一项', 400)
    if (title.length > 100) return fail(400, '标题不超过 100 字', 400)
    if (content.length > 5000) return fail(400, '正文不超过 5000 字', 400)
  }

  // 分类校验（可空 = 不归类）
  let categoryId = null
  if (b.category_id != null && b.category_id !== '') {
    const cat = await c.env.DB.prepare('SELECT id FROM categories WHERE id = ?').bind(num(b.category_id, 0)).first()
    if (!cat) return fail(400, '分类不存在', 400)
    categoryId = cat.id
  }

  // 图片白名单（外链模式：仅收 http(s) URL，最多 18 张防滥用）
  const images = Array.isArray(b.images) ? b.images.filter(u => /^https?:\/\//.test(String(u))).slice(0, 18) : []
  // 标签：字符串数组，最多 10 个，单个 ≤ 30 字；自动 upsert 计数
  const tags = Array.isArray(b.tags) ? b.tags.map(t => String(t).trim()).filter(t => t && t.length <= 30).slice(0, 10) : []
  // 视频字段（视频笔记）：{url, coverUrl}
  let videoUrl = null
  let coverUrl = null
  if (b.video && b.video.url && /^https?:\/\//.test(String(b.video.url))) {
    videoUrl = String(b.video.url)
    coverUrl = (b.video.coverUrl && /^https?:\/\//.test(String(b.video.coverUrl))) ? String(b.video.coverUrl) : null
  }

  const r = await c.env.DB.prepare(
    'INSERT INTO posts (user_id, title, content, category_id, location, video_url, cover_url, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(uid, title, content, categoryId, b.location ? String(b.location).slice(0, 50) : null, videoUrl, coverUrl, status).run()
  const pid = r.meta?.last_row_id

  for (let i = 0; i < images.length; i++) {
    await c.env.DB.prepare('INSERT INTO post_images (post_id, url, sort) VALUES (?, ?, ?)').bind(pid, String(images[i]), i).run()
  }
  for (const t of tags) {
    await c.env.DB.prepare(
      'INSERT INTO tags (name, use_count) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET use_count = use_count + 1'
    ).bind(t).run()
    const tagRow = await c.env.DB.prepare('SELECT id FROM tags WHERE name = ?').bind(t).first()
    if (tagRow) await c.env.DB.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)').bind(pid, tagRow.id).run()
  }

  // 返回完整详情（对齐 GET /api/posts/:id 结构，前端发布后可直接渲染）
  const detail = await c.env.DB.prepare(
    `SELECT ${POST_FIELDS} FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`
  ).bind(pid).first()
  const post = toFrontPost(detail)
  post.tags = tags
  post.tags_detail = tags.map((name, i) => ({ id: i + 1, name }))
  return c.json(ok(post, '发布成功'), 201)
})

// ---------- 编辑笔记（仅作者本人）----------
app.put('/api/posts/:id', requireAuth, async (c) => {
  const id = num(c.req.param('id'), 0)
  const uid = c.get('auth').uid
  const row = await c.env.DB.prepare('SELECT id, user_id, title, content, status FROM posts WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '笔记不存在', 404)
  if (row.user_id !== uid) return fail(403, '只能编辑自己发布的笔记', 403)

  const b = await c.req.json().catch(() => ({}))
  const title = b.title != null ? String(b.title).trim() : null
  const content = b.content != null ? String(b.content).trim() : null
  // 状态切换：1=草稿；2=审核中（视频上传占位）；3=审核失败（视频上传失败）；
  // 0/其它=发布（审核中视频上传完成的"审核通过"就是转 0 + 补 video_url）
  const updateStatus = b.status !== undefined
  let newStatus = 0
  if (b.status === 1 || b.status === '1') newStatus = 1
  else if (b.status === 2 || b.status === '2') newStatus = 2
  else if (b.status === 3 || b.status === '3') newStatus = 3

  // 发布校验：合并现有值与传入值，标题/正文必须完整、长度达标
  const finalTitle = title !== null ? title : row.title
  const finalContent = content !== null ? content : row.content
  const finalStatus = updateStatus ? newStatus : row.status
  if (finalStatus === 0) {
    if (!finalTitle || finalTitle.length > 100) return fail(400, '发布需要标题（不超过 100 字）', 400)
    if (!finalContent) return fail(400, '发布需要正文内容', 400)
    if (finalContent.length > 5000) return fail(400, '正文不超过 5000 字', 400)
  } else if (finalTitle.length > 100) {
    return fail(400, '标题不超过 100 字', 400)
  } else if (finalContent.length > 5000) {
    return fail(400, '正文不超过 5000 字', 400)
  }

  // 分类校验（与发布接口对齐：传空 = 不归类）
  let categoryId = null
  const updateCategory = b.category_id !== undefined
  if (updateCategory && b.category_id != null && b.category_id !== '') {
    const cat = await c.env.DB.prepare('SELECT id FROM categories WHERE id = ?').bind(num(b.category_id, 0)).first()
    if (!cat) return fail(400, '分类不存在', 400)
    categoryId = cat.id
  }

  // 图片白名单（与发布接口对齐：http(s) URL，最多 18 张；传入即全量替换）
  const updateImages = Array.isArray(b.images)
  const images = updateImages ? b.images.filter(u => /^https?:\/\//.test(String(u))).slice(0, 18) : []
  // 标签（与发布接口对齐：最多 10 个，单个 ≤ 30 字；传入即全量替换）
  const updateTags = Array.isArray(b.tags)
  const tags = updateTags ? b.tags.map(t => String(t).trim()).filter(t => t && t.length <= 30).slice(0, 10) : []
  // 视频字段（视频笔记）：video 对象 {url, coverUrl} 或 null
  let videoUrl = null
  let coverUrl = null
  if (b.video && b.video.url && /^https?:\/\//.test(String(b.video.url))) {
    videoUrl = String(b.video.url)
    coverUrl = (b.video.coverUrl && /^https?:\/\//.test(String(b.video.coverUrl))) ? String(b.video.coverUrl) : null
  }
  const updateVideo = b.video !== undefined

  await c.env.DB.prepare(
    `UPDATE posts SET
       title = COALESCE(?, title),
       content = COALESCE(?, content),
       location = COALESCE(?, location),
       category_id = CASE WHEN ? THEN ? ELSE category_id END,
       video_url = CASE WHEN ? THEN ? ELSE video_url END,
       cover_url = CASE WHEN ? THEN ? ELSE cover_url END,
       status = CASE WHEN ? THEN ? ELSE status END
     WHERE id = ?`
  ).bind(
    title, content, b.location ? String(b.location).slice(0, 50) : null,
    updateCategory ? 1 : 0, categoryId,
    updateVideo ? 1 : 0, videoUrl,
    updateVideo ? 1 : 0, coverUrl,
    updateStatus ? 1 : 0, newStatus,
    id
  ).run()

  // 全量替换图片
  if (updateImages) {
    await c.env.DB.prepare('DELETE FROM post_images WHERE post_id = ?').bind(id).run()
    for (let i = 0; i < images.length; i++) {
      await c.env.DB.prepare('INSERT INTO post_images (post_id, url, sort) VALUES (?, ?, ?)').bind(id, String(images[i]), i).run()
    }
  }

  // 全量替换标签（新标签 upsert 计数，旧标签计数回退）
  if (updateTags) {
    const old = await c.env.DB.prepare(
      'SELECT t.id, t.name FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id = ?'
    ).bind(id).all()
    const oldNames = new Set((old.results || []).map(r => r.name))
    const newNames = new Set(tags)
    for (const r of (old.results || [])) {
      if (!newNames.has(r.name)) {
        await c.env.DB.prepare('UPDATE tags SET use_count = MAX(0, use_count - 1) WHERE id = ?').bind(r.id).run()
      }
    }
    await c.env.DB.prepare('DELETE FROM post_tags WHERE post_id = ?').bind(id).run()
    for (const t of tags) {
      await c.env.DB.prepare(
        'INSERT INTO tags (name, use_count) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET use_count = use_count + 1'
      ).bind(t).run()
      const tagRow = await c.env.DB.prepare('SELECT id FROM tags WHERE name = ?').bind(t).first()
      if (tagRow) await c.env.DB.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)').bind(id, tagRow.id).run()
    }
    // 清理计到 0 的标签（保持标签池干净）
    await c.env.DB.prepare('DELETE FROM tags WHERE use_count <= 0').run()
  }

  // 返回完整详情（对齐 GET /api/posts/:id）
  const detail = await c.env.DB.prepare(
    `SELECT ${POST_FIELDS} FROM posts p LEFT JOIN users u ON p.user_id = u.id LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`
  ).bind(id).first()
  const post = toFrontPost(detail)
  const tagRows = await c.env.DB.prepare(
    'SELECT t.id, t.name FROM post_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.post_id = ?'
  ).bind(id).all()
  post.tags = (tagRows.results || []).map(r => r.name)
  post.tags_detail = (tagRows.results || []).map(r => ({ id: r.id, name: r.name }))
  return c.json(ok(post, '笔记已更新'))
})

// ---------- 删除笔记（仅作者本人，级联清理图片/标签/评论/点赞/收藏）----------
app.delete('/api/posts/:id', requireAuth, async (c) => {
  const id = num(c.req.param('id'), 0)
  const uid = c.get('auth').uid
  const row = await c.env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?').bind(id).first()
  if (!row) return fail(404, '笔记不存在', 404)
  if (row.user_id !== uid) return fail(403, '只能删除自己发布的笔记', 403)

  // D1 无 ON DELETE CASCADE 执行顺序保证，逐表显式清理
  for (const sql of [
    'DELETE FROM post_images WHERE post_id = ?',
    'DELETE FROM post_tags WHERE post_id = ?',
    'DELETE FROM comments WHERE post_id = ?',
    'DELETE FROM likes WHERE target_type = 1 AND target_id = ?',
    'DELETE FROM collections WHERE post_id = ?',
    'DELETE FROM posts WHERE id = ?'
  ]) {
    await c.env.DB.prepare(sql).bind(id).run()
  }
  return c.json(ok({ id }, '笔记已删除'))
})

// ---------- 点赞 / 取消点赞（兼容两种 body：{ post_id } 与 { target_type, target_id }）----------
const parseTarget = (b) => {
  if (b.post_id != null) return { type: 1, id: num(b.post_id, 0) }
  if (b.target_type != null && b.target_id != null) return { type: num(b.target_type, 1), id: num(b.target_id, 0) }
  return { type: 1, id: 0 }
}

app.post('/api/likes', requireAuth, async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const { type, id: tid } = parseTarget(b)
  const uid = c.get('auth').uid
  if (type !== 1) return fail(400, 'V2 暂仅支持笔记点赞', 400) // 评论点赞 V3
  const pid = tid
  const post = await c.env.DB.prepare('SELECT id, user_id, title, like_count FROM posts WHERE id = ?').bind(pid).first()
  if (!post) return fail(404, '笔记不存在', 404)

  const r = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO likes (user_id, target_type, target_id) VALUES (?, 1, ?)'
  ).bind(uid, pid).run()
  if (!r.meta?.changes) return c.json(ok({ liked: true, like_count: post.like_count }, '已点赞')) // 幂等：重复点赞不重复计数

  await c.env.DB.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').bind(pid).run()
  await c.env.DB.prepare('UPDATE users SET like_count = like_count + 1 WHERE id = ?').bind(post.user_id).run()
  await notify(c.env, { userId: post.user_id, senderId: uid, type: 1, title: '赞了你的笔记', content: post.title, targetId: pid })
  const cnt = await c.env.DB.prepare('SELECT like_count FROM posts WHERE id = ?').bind(pid).first()
  return c.json(ok({ liked: true, like_count: cnt.like_count }, '已点赞'), 201)
})

app.delete('/api/likes', requireAuth, async (c) => {
  const b = await c.req.json().catch(() => ({}))
  const { type, id: tid } = parseTarget(b)
  const uid = c.get('auth').uid
  if (type !== 1) return fail(400, 'V2 暂仅支持笔记点赞', 400)
  const pid = tid
  const r = await c.env.DB.prepare(
    'DELETE FROM likes WHERE user_id = ? AND target_type = 1 AND target_id = ?'
  ).bind(uid, pid).run()
  if (r.meta?.changes) {
    await c.env.DB.prepare('UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?').bind(pid).run()
    const post = await c.env.DB.prepare('SELECT user_id FROM posts WHERE id = ?').bind(pid).first()
    if (post) await c.env.DB.prepare('UPDATE users SET like_count = MAX(0, like_count - 1) WHERE id = ?').bind(post.user_id).run()
  }
  const cnt = await c.env.DB.prepare('SELECT like_count FROM posts WHERE id = ?').bind(pid).first()
  return c.json(ok({ liked: false, like_count: cnt ? cnt.like_count : 0 }, '已取消点赞'))
})

// ---------- 收藏 / 取消收藏 ----------
app.post('/api/posts/:id/collect', requireAuth, async (c) => {
  const pid = num(c.req.param('id'), 0)
  const uid = c.get('auth').uid
  const post = await c.env.DB.prepare('SELECT id, user_id, title FROM posts WHERE id = ?').bind(pid).first()
  if (!post) return fail(404, '笔记不存在', 404)

  const r = await c.env.DB.prepare('INSERT OR IGNORE INTO collections (user_id, post_id) VALUES (?, ?)').bind(uid, pid).run()
  if (!r.meta?.changes) return c.json(ok({ collected: true, collect_count: post.collect_count }, '已收藏'))
  await c.env.DB.prepare('UPDATE posts SET collect_count = collect_count + 1 WHERE id = ?').bind(pid).run()
  const cnt = await c.env.DB.prepare('SELECT collect_count FROM posts WHERE id = ?').bind(pid).first()
  return c.json(ok({ collected: true, collect_count: cnt.collect_count }, '已收藏'), 201)
})

app.delete('/api/posts/:id/collect', requireAuth, async (c) => {
  const pid = num(c.req.param('id'), 0)
  const uid = c.get('auth').uid
  const r = await c.env.DB.prepare('DELETE FROM collections WHERE user_id = ? AND post_id = ?').bind(uid, pid).run()
  if (r.meta?.changes) await c.env.DB.prepare('UPDATE posts SET collect_count = MAX(0, collect_count - 1) WHERE id = ?').bind(pid).run()
  const cnt = await c.env.DB.prepare('SELECT collect_count FROM posts WHERE id = ?').bind(pid).first()
  return c.json(ok({ collected: false, collect_count: cnt ? cnt.collect_count : 0 }, '已取消收藏'))
})

// ---------- 关注 / 取消关注（:id 兼容自增 id 与文本账号，前端实际传 user_id 文本）----------
const resolveFollowTarget = async (env, key) =>
  env.DB.prepare('SELECT id, user_id, nickname, fans_count FROM users WHERE id = ? OR user_id = ?').bind(num(key, -1), key).first()

app.post('/api/users/:id/follow', requireAuth, async (c) => {
  const key = String(c.req.param('id'))
  const uid = c.get('auth').uid
  const target = await resolveFollowTarget(c.env, key)
  if (!target) return fail(404, '用户不存在', 404)
  const targetId = target.id
  if (targetId === uid) return fail(400, '不能关注自己', 400)

  const r = await c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').bind(uid, targetId).run()
  if (!r.meta?.changes) return c.json(ok({ following: true, fans_count: target.fans_count || 0 }, '已关注'))
  await c.env.DB.prepare('UPDATE users SET follow_count = follow_count + 1 WHERE id = ?').bind(uid).run()
  await c.env.DB.prepare('UPDATE users SET fans_count = fans_count + 1 WHERE id = ?').bind(targetId).run()
  await notify(c.env, { userId: targetId, senderId: uid, type: 3, title: '关注了你', content: '', targetId: uid })
  const cnt = await c.env.DB.prepare('SELECT fans_count FROM users WHERE id = ?').bind(targetId).first()
  return c.json(ok({ following: true, fans_count: cnt.fans_count }, '已关注'), 201)
})

app.delete('/api/users/:id/follow', requireAuth, async (c) => {
  const key = String(c.req.param('id'))
  const uid = c.get('auth').uid
  const target = await resolveFollowTarget(c.env, key)
  if (!target) return fail(404, '用户不存在', 404)
  const targetId = target.id
  const r = await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').bind(uid, targetId).run()
  if (r.meta?.changes) {
    await c.env.DB.prepare('UPDATE users SET follow_count = MAX(0, follow_count - 1) WHERE id = ?').bind(uid).run()
    await c.env.DB.prepare('UPDATE users SET fans_count = MAX(0, fans_count - 1) WHERE id = ?').bind(targetId).run()
  }
  const cnt = await c.env.DB.prepare('SELECT fans_count FROM users WHERE id = ?').bind(targetId).first()
  return c.json(ok({ following: false, fans_count: cnt ? cnt.fans_count : 0 }, '已取消关注'))
})

// ---------- 发表评论 ----------
app.post('/api/comments', requireAuth, async (c) => {
  const { post_id, content } = await c.req.json().catch(() => ({}))
  const pid = num(post_id, 0)
  const uid = c.get('auth').uid
  const post = await c.env.DB.prepare('SELECT id, user_id, title FROM posts WHERE id = ?').bind(pid).first()
  if (!post) return fail(404, '笔记不存在', 404)
  const text = String(content || '').trim()
  if (!text || text.length > 1000) return fail(400, '评论内容必填且不超过 1000 字', 400)

  const r = await c.env.DB.prepare(
    'INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)'
  ).bind(pid, uid, text).run()
  const cid = r.meta?.last_row_id
  await c.env.DB.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').bind(pid).run()
  await notify(c.env, { userId: post.user_id, senderId: uid, type: 2, title: '评论了你的笔记', content: text.slice(0, 50), targetId: pid, targetCommentId: cid })

  const cm = await c.env.DB.prepare(
    `SELECT cm.id, cm.post_id, cm.content, cm.created_at, u.id AS author_auto_id, u.user_id AS author_account, u.nickname, u.avatar AS user_avatar
       FROM comments cm LEFT JOIN users u ON cm.user_id = u.id WHERE cm.id = ?`
  ).bind(cid).first()
  return c.json(ok({
    id: cm.id, post_id: cm.post_id, parent_id: null, content: cm.content,
    created_at: cm.created_at, like_count: 0, liked: false,
    user_id: cm.author_account, author_account: cm.author_account,
    nickname: cm.nickname, user_avatar: cm.user_avatar,
    user: { id: cm.author_auto_id, user_id: cm.author_account, nickname: cm.nickname, avatar: cm.user_avatar },
    replies: []
  }, '评论成功'), 201)
})

// ---------- 通知（兼容前端分类型路由 + PUT 已读）----------
// 通知类型映射：1-点赞(likes) 2-评论(comments) 3-关注(follows)；collections 暂无来源（收藏不发通知）
const NOTI_TYPE = { likes: 1, comments: 2, follows: 3, collections: 4 }

async function listNotifications(c, typeFilter) {
  const uid = c.get('auth').uid
  const { page, limit, offset } = pager(c, 20)
  const where = typeFilter ? 'WHERE n.user_id = ? AND n.type = ?' : 'WHERE n.user_id = ?'
  const bind = typeFilter ? [uid, typeFilter, limit, offset] : [uid, limit, offset]
  const [cnt] = (await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM notifications n ${where}`
  ).bind(...bind.slice(0, typeFilter ? 2 : 1)).all()).results
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.type, n.title, n.content, n.target_id, n.target_comment_id, n.is_read, n.created_at,
            s.id AS sender_auto_id, s.user_id AS sender_account, s.nickname AS sender_nickname, s.avatar AS sender_avatar, s.verified AS sender_verified,
            p.user_id AS post_author_id,
            (SELECT pi.url FROM post_images pi WHERE pi.post_id = n.target_id ORDER BY pi.sort LIMIT 1) AS post_image
       FROM notifications n
       LEFT JOIN users s ON n.sender_id = s.id
       LEFT JOIN posts p ON p.id = n.target_id
       ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`
  ).bind(...bind).all()
  // 通知项对齐前端消息页契约（扁平字段 + sender 嵌套兼容）
  return c.json(ok({
    notifications: results.map(n => ({
      id: n.id, type: n.type, title: n.title, content: n.content, target_id: n.target_id,
      is_read: n.is_read, created_at: n.created_at,
      // 扁平契约（消息页直接取这些字段）
      from_user_id: n.sender_account || '',
      from_user_auto_id: n.sender_auto_id || null,
      from_nickname: n.sender_nickname || '未知用户',
      from_avatar: n.sender_avatar || '',
      from_verified: n.sender_verified || 0,
      post_image: n.post_image || '',
      post_author_id: n.post_author_id || null,
      target_type: n.type === 2 ? 2 : 1, // 1-笔记 2-评论（点赞 type=1 视为笔记）
      comment_id: n.target_comment_id || null,
      comment_is_liked: 0,
      comment_like_count: 0,
      // 嵌套兼容（旧结构保留）
      sender: { id: n.sender_auto_id, user_id: n.sender_account, nickname: n.sender_nickname, avatar: n.sender_avatar }
    })),
    pagination: { page, limit, total: cnt.total, pages: Math.ceil(cnt.total / limit) }
  }))
}

app.get('/api/notifications', requireAuth, (c) => listNotifications(c, null))
app.get('/api/notifications/likes', requireAuth, (c) => listNotifications(c, NOTI_TYPE.likes))
app.get('/api/notifications/comments', requireAuth, (c) => listNotifications(c, NOTI_TYPE.comments))
app.get('/api/notifications/follows', requireAuth, (c) => listNotifications(c, NOTI_TYPE.follows))
app.get('/api/notifications/collections', requireAuth, (c) => listNotifications(c, NOTI_TYPE.collections))

app.get('/api/notifications/unread-count', requireAuth, async (c) => {
  const r = await c.env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0'
  ).bind(c.get('auth').uid).first()
  return c.json(ok({ count: r.cnt }))
})

// 分类型未读数（前端通知页 Tab 角标）
app.get('/api/notifications/unread-count-by-type', requireAuth, async (c) => {
  const uid = c.get('auth').uid
  const { results } = await c.env.DB.prepare(
    'SELECT type, COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0 GROUP BY type'
  ).bind(uid).all()
  const byType = { comments: 0, likes: 0, collections: 0, follows: 0 }
  let total = 0
  for (const r of results) {
    total += r.cnt
    if (r.type === 1) byType.likes += r.cnt
    else if (r.type === 2) byType.comments += r.cnt
    else if (r.type === 3) byType.follows += r.cnt
    else if (r.type === 4) byType.collections += r.cnt
  }
  return c.json(ok({ ...byType, total }))
})

const markReadAll = async (c) => {
  await c.env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').bind(c.get('auth').uid).run()
  return c.json(ok(null, '全部已读'))
}
app.post('/api/notifications/read-all', requireAuth, markReadAll)
app.put('/api/notifications/read-all', requireAuth, markReadAll)

app.put('/api/notifications/:id/read', requireAuth, async (c) => {
  const id = num(c.req.param('id'), 0)
  const r = await c.env.DB.prepare(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?'
  ).bind(id, c.get('auth').uid).run()
  if (!r.meta?.changes) return fail(404, '通知不存在', 404)
  return c.json(ok(null, '已标记为已读'))
})

app.delete('/api/notifications/:id', requireAuth, async (c) => {
  const id = num(c.req.param('id'), 0)
  const r = await c.env.DB.prepare(
    'DELETE FROM notifications WHERE id = ? AND user_id = ?'
  ).bind(id, c.get('auth').uid).run()
  if (!r.meta?.changes) return fail(404, '通知不存在', 404)
  return c.json(ok(null, '通知已删除'))
})

// ============================================================
// 举报提交（登录用户；管理侧 /admin/reports 审阅）
// ============================================================
app.post('/api/reports', requireAuth, async (c) => {
  const { target_type, target_id, reason, detail } = await c.req.json().catch(() => ({}))
  const tType = num(target_type, 1)
  const tId = num(target_id, 0)
  if (![1, 2].includes(tType) || tId <= 0) return fail(400, '举报目标无效', 400)
  if (!reason || String(reason).trim().length === 0) return fail(400, '请选择举报原因', 400)

  // 目标存在性校验
  const target = tType === 1
    ? await c.env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(tId).first()
    : await c.env.DB.prepare('SELECT id FROM comments WHERE id = ?').bind(tId).first()
  if (!target) return fail(404, '举报目标不存在', 404)

  // 幂等：同一用户对同一目标只留一条待处理举报
  const dup = await c.env.DB.prepare(
    'SELECT 1 FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 0'
  ).bind(c.get('auth').uid, tType, tId).first()
  if (dup) return c.json(ok(null, '该内容你已举报过，管理员将尽快处理'))

  await c.env.DB.prepare(
    'INSERT INTO reports (reporter_id, target_type, target_id, reason, detail) VALUES (?, ?, ?, ?, ?)'
  ).bind(c.get('auth').uid, tType, tId, String(reason).slice(0, 50), String(detail || '').slice(0, 500)).run()
  return c.json(ok(null, '举报已提交，管理员将尽快处理'), 201)
})

// ---------- 根路径状态页（仅 API 直连时可见；部署后前端资产优先接管 / ） ----------
app.get('/', (c) => c.json(ok({
  name: '黑小帅 V3 API（Cloudflare Workers）',
  version: c.env.APP_VERSION || '3.0.0',
  hint: '前端已随本 Worker 一同部署（Static Assets），访问根路径即博客首页',
  admin_note: '部署后首个注册账号自动成为唯一管理员',
  endpoints: [
    'GET /api/health', 'GET /api/categories', 'GET /api/posts?page=1&limit=20&category=',
    'GET /api/posts/:id', 'GET /api/posts/:id/comments?page=1', 'GET /api/tags/hot', 'GET /api/search?keyword=',
    'POST /api/reports（举报）', 'GET /api/admin/*（管理员）'
  ],
  image_note: '图片为外链模式，直连图库域名加载'
}, '黑小帅 API 服务运行中')))

// ============================================================
// V3 管理侧（/api/admin/*，鉴权：唯一管理员）
// ============================================================
app.route('/api/admin', admin)

// API 404 兜底（其余路径由 Static Assets 接管，SPA 路由回退 index.html）
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return fail(404, '接口不存在', 404)
  return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : fail(404, 'Not Found', 404)
})

// ============================================================
// Phase D · 文件上传（imgbed 直传为主：图片 5MB / 视频 100MB）
// 前端契约：
//   POST /upload/single|image|multiple（file 字段）→ { data: { url } }
//   POST /upload/video（file 字段 + 可选 thumbnail 字段）→ { data: { url, coverUrl } }
// 策略（环境变量 IMAGE_UPLOAD_STRATEGY）：
//   imgbed-api  —— 转发自建图床（IMG_API_URL + secret IMG_API_TOKEN），外链返回
//   placeholder  —— 无图床配置时图片回退 picsum 占位（视频必须真实图床，直接报错）
// ============================================================
const parseImgbedUrl = (j, env, apiUrl) => {
  let url = j && (j.data?.url || j.url || j.data?.[0]?.url)
  if (!url && j && Array.isArray(j.data) && typeof j.data[0] === 'string') {
    const p = j.data[0]
    if (/^https?:\/\//i.test(p)) {
      url = p
    } else {
      const base = (env.IMG_BASE_URL || apiUrl.replace(/\/upload.*$/, '')).trim().replace(/\/+$/, '')
      url = `${base}${p.startsWith('/') ? '' : '/'}${p}`
    }
  }
  return url || null
}

// 通用：单文件转发 imgbed（鉴权兼容：CF-ImgBed 标准裸 token，失败自动换 Bearer）
const forwardToImgbed = async (env, file) => {
  const apiUrl = (env.IMG_API_URL || '').trim()
  const token = (env.IMG_API_TOKEN || '').trim()
  if (!apiUrl || !token) return { url: null, reason: 'unconfigured' }
  const authVariants = /^bearer\s/i.test(token) ? [token] : [token, `Bearer ${token}`]
  for (const auth of [...new Set(authVariants)]) {
    try {
      const fwd = new FormData()
      fwd.append('file', file, file.name || 'upload.bin')
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { Authorization: auth },
        body: fwd
      })
      const j = await r.json().catch(() => null)
      const url = parseImgbedUrl(j, env, apiUrl)
      if (r.ok && url) return { url, strategy: 'imgbed' }
      console.error('imgbed 上传失败:', auth.replace(/(\S{8})\S*/, '$1***'), r.status, JSON.stringify(j).slice(0, 200))
    } catch (e) {
      console.error('imgbed 网络异常:', e && e.message)
    }
  }
  return { url: null, reason: 'upload_failed' }
}

const uploadHandler = async (c) => {
  const uid = c.get('auth').uid
  const form = await c.req.formData().catch(() => null)
  const file = form && form.get('file')
  if (!file || typeof file === 'string') return fail(400, '请选择要上传的图片文件', 400)
  if (file.size > 5 * 1024 * 1024) return fail(400, '图片大小不能超过 5MB', 400)
  if (!/^image\//.test(file.type || '')) return fail(400, '仅支持图片文件（视频请用 /upload/video）', 400)

  const strategy = (c.env.IMAGE_UPLOAD_STRATEGY || 'imgbed-api').trim()
  if (strategy === 'imgbed-api') {
    const { url } = await forwardToImgbed(c.env, file)
    if (url) {
      return c.json(ok({ url, strategy: 'imgbed', by: uid, size: file.size, type: file.type }, '上传成功'), 201)
    }
  }

  // 兜底：picsum 语义占位图（按文件名+时间散列，稳定可复现）
  const seed = `${(file.name || 'img').replace(/\W+/g, '').slice(0, 20)}-${uid}-${Date.now() % 100000}`
  const url = `https://picsum.photos/seed/${encodeURIComponent(seed)}/1080/1440`
  return c.json(ok({
    url, strategy: 'placeholder', by: uid, size: file.size, type: file.type,
    hint: '图床未配置（IMAGE_UPLOAD_STRATEGY/IMG_API_URL/IMG_API_TOKEN），已使用占位图'
  }, '上传成功（占位图模式）'), 201)
}

// 视频上传：走 imgbed 存储（视频不可用占位图顶替，失败即报错）
const videoUploadHandler = async (c) => {
  const uid = c.get('auth').uid
  const form = await c.req.formData().catch(() => null)
  const file = form && form.get('file')
  if (!file || typeof file === 'string') return fail(400, '请选择要上传的视频文件', 400)
  if (file.size > 100 * 1024 * 1024) return fail(400, '视频大小不能超过 100MB', 400)
  if (!/^video\//.test(file.type || '')) return fail(400, '仅支持视频文件（图片请用 /upload/single）', 400)

  const { url, reason } = await forwardToImgbed(c.env, file)
  if (!url) {
    return fail(500, reason === 'unconfigured'
      ? '视频上传需要配置图床（IMG_API_URL / IMG_API_TOKEN secret），图片暂不支持视频占位'
      : '视频上传图床失败，请稍后重试', 500)
  }

  // 可选缩略图：一并转存图床，前端封面直接外链
  let coverUrl = null
  const thumb = form && form.get('thumbnail')
  if (thumb && typeof thumb !== 'string' && /^image\//.test(thumb.type || '')) {
    const t = await forwardToImgbed(c.env, thumb)
    coverUrl = t.url
  }

  return c.json(ok({
    url, coverUrl, strategy: 'imgbed', by: uid, size: file.size, type: file.type, name: file.name || 'video.mp4'
  }, '视频上传成功'), 201)
}

app.post('/api/upload/single', requireAuth, uploadHandler)
app.post('/api/upload/image', requireAuth, uploadHandler)
app.post('/api/upload/multiple', requireAuth, async (c) => {
  // 前端批量上传实际是逐张调 /upload/single（upload.js 循环调用），
  // 此端点保留兼容：直接按单张处理
  return uploadHandler(c)
})
app.post('/api/upload/video', requireAuth, videoUploadHandler)

// 全局错误兜底
app.onError((err, c) => {
  console.error('服务器错误:', err && err.message)
  return fail(500, '服务器内部错误', 500)
})

export default app
