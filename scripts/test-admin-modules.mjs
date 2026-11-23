// V3 管理侧全模块实测
import { execSync } from 'node:child_process'

const BASE = 'http://localhost:8788'
const ROOT = 'C:/Users/Administrator/Desktop/xf/xf-cloudflare'

async function req(method, u, b, h) {
  const r = await fetch(BASE + u, {
    method,
    headers: { 'Content-Type': 'application/json', ...(h || {}) },
    body: (method !== 'GET' && method !== 'HEAD' && b !== undefined) ? JSON.stringify(b) : undefined
  })
  return await r.json().catch(() => ({}))
}
const post = (u, b, h) => req('POST', u, b, h)
const get = (u, h) => req('GET', u, undefined, h)
const put = (u, b, h) => req('PUT', u, b, h)
const del = (u, b, h) => req('DELETE', u, b, h)

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
  const results = []
  const check = (name, cond, detail) => {
    results.push([name, !!cond, detail])
    console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`)
  }

  // ===== 准备：管理员（本地库 firstadmin 已存在）+ 普通用户 =====
  let adminLogin = await post('/api/auth/login', { user_id: 'firstadmin', password: 'FirstAdmin2026!' })
  if (adminLogin.code !== 200) {
    // 本地库被重建过则重新注册引导
    const reg = await register('firstadmin', '首个管理员', 'FirstAdmin2026!')
    adminLogin = await post('/api/auth/login', { user_id: 'firstadmin', password: 'FirstAdmin2026!' })
  }
  const A = { Authorization: `Bearer ${adminLogin.data.tokens.access_token}` }
  let normLogin = await post('/api/auth/login', { user_id: 'normaluser', password: 'NormalUser2026!' })
  if (normLogin.code !== 200) {
    await register('normaluser', '普通用户', 'NormalUser2026!')
    normLogin = await post('/api/auth/login', { user_id: 'normaluser', password: 'NormalUser2026!' })
  }
  const N = { Authorization: `Bearer ${normLogin.data.tokens.access_token}` }

  // ===== 0. 鉴权 =====
  const noAuth = await get('/api/admin/users')
  check('0.1 未登录访问管理接口 401', noAuth.code === 401, `code=${noAuth.code}`)
  const normAuth = await get('/api/admin/users', N)
  check('0.2 普通用户访问管理接口 403', normAuth.code === 403, `code=${normAuth.code}`)

  // ===== 1. 动态监控 =====
  const mon = await get('/api/admin/monitor/activities', A)
  const monTypes = new Set((mon.data || []).map(a => a.type))
  check('1.1 动态监控列表', mon.code === 200 && Array.isArray(mon.data), `${mon.data?.length} 条`)
  check('1.2 动态类型覆盖（注册/发布/评论）', ['user_register', 'post_publish', 'comment_publish'].every(t => monTypes.has(t)))

  // ===== 2. 用户管理 =====
  const users = await get('/api/admin/users?page=1&limit=5', A)
  check('2.1 用户列表分页', users.code === 200 && users.data.pagination.total >= 50, `total=${users.data?.pagination?.total}`)
  const userSearch = await get('/api/admin/users?page=1&limit=5&user_id=firstadmin', A)
  check('2.2 用户搜索（黑小帅号）', userSearch.code === 200 && userSearch.data.data.length >= 1 && userSearch.data.data[0].user_id === 'firstadmin')
  const userSort = await get('/api/admin/users?page=1&limit=3&sortField=fans_count&sortOrder=desc', A)
  check('2.3 用户排序（粉丝降序）', userSort.code === 200 && Array.isArray(userSort.data.data))
  const personality = (await get('/api/admin/users?page=1&limit=100', A)).data.data.find(u => u.id === adminLogin.data.user.id)
  check('2.4 用户行含 personality_tags/封禁状态', !!personality && Array.isArray(personality.personality_tags) && 'ban_status_display' in personality)

  // ===== 3. 笔记管理 =====
  const posts = await get('/api/admin/posts?page=1&limit=5', A)
  check('3.1 笔记列表', posts.code === 200 && posts.data.pagination.total === 200, `total=${posts.data?.pagination?.total}`)
  const postDetail = await get('/api/admin/posts/5', A)
  check('3.2 笔记详情（图组+标签）', postDetail.code === 200 && Array.isArray(postDetail.data.images) && Array.isArray(postDetail.data.tags), `imgs=${postDetail.data?.images?.length}`)
  const postSearch = await get('/api/admin/posts?page=1&limit=5&title=学习', A)
  check('3.3 笔记标题搜索', postSearch.code === 200 && Array.isArray(postSearch.data.data))

  // 发布一篇测试笔记 → 审核 → 删除（全流程）
  const pub = await post('/api/posts', { title: 'V3管理侧测试笔记', content: '管理侧审核流程实测', category_id: 1, tags: ['测试'] }, N)
  const pid = pub.data?.id
  check('3.4 普通用户发布测试笔记', pub.code === 201 || pub.code === 200, `id=${pid}`)
  const audit = await put(`/api/admin/posts/${pid}/audit`, { status: 2, remark: '管理侧实测：转入待审核' }, A)
  check('3.5 笔记审核（转待审核）', audit.code === 200, audit.message)
  const audited = await get(`/api/posts/${pid}`)
  check('3.6 待审核笔记前台不可见', audited.code === 404)
  const auditPass = await put(`/api/admin/posts/${pid}/audit`, { status: 0, remark: '审核通过' }, A)
  check('3.7 审核通过重新可见', auditPass.code === 200 && (await get(`/api/posts/${pid}`)).code === 200)
  const auditLog = await get('/api/admin/audit?page=1&limit=5&type=3', A)
  check('3.8 审核记录写入 audit 表', auditLog.code === 200 && auditLog.data.data.length >= 2, `${auditLog.data?.data?.length} 条`)
  const delPost = await del(`/api/admin/posts/${pid}`, null, A)
  check('3.9 管理员删除笔记', delPost.code === 200)

  // ===== 4. 评论管理 =====
  const comments = await get('/api/admin/comments?page=1&limit=5', A)
  check('4.1 评论列表', comments.code === 200 && comments.data.pagination.total === 800, `total=${comments.data?.pagination?.total}`)
  const cmContent = await get('/api/admin/comments?page=1&limit=5&content=教程', A)
  check('4.2 评论内容搜索', cmContent.code === 200 && Array.isArray(cmContent.data.data))

  // ===== 5. 分类 / 标签管理 =====
  const cats = await get('/api/admin/categories', A)
  check('5.1 分类列表', cats.code === 200 && cats.data.data.length === 10, `${cats.data?.data?.length} 个`)
  const newCat = await post('/api/admin/categories', { name: '测试分类', title: 'testcat', category_title: 'testcat' }, A)
  check('5.2 创建分类', newCat.code === 201, `id=${newCat.data?.id}`)
  const upCat = await put(`/api/admin/categories/${newCat.data.id}`, { name: '测试分类改名' }, A)
  check('5.3 更新分类', upCat.code === 200)
  const delCat = await del(`/api/admin/categories/${newCat.data.id}`, null, A)
  check('5.4 删除分类', delCat.code === 200)
  const tags = await get('/api/admin/tags?page=1&limit=5', A)
  check('5.5 标签列表（按热度）', tags.code === 200 && tags.data.pagination.total >= 70, `total=${tags.data?.pagination?.total}`)
  const newTag = await post('/api/admin/tags', { name: 'v3测试标签' }, A)
  check('5.6 创建标签', newTag.code === 201)
  const dupTag = await post('/api/admin/tags', { name: 'v3测试标签' }, A)
  check('5.7 标签重复创建 409', dupTag.code === 409)
  await del('/api/admin/tags/' + newTag.data.id, null, A)

  // ===== 6. 点赞/收藏/关注/通知/会话 =====
  await post('/api/likes', { post_id: 10 }, N)
  const likes = await get('/api/admin/likes?page=1&limit=5', A)
  check('6.1 点赞列表', likes.code === 200 && likes.data.pagination.total >= 1)
  const cols = await get('/api/admin/collections?page=1&limit=5', A)
  check('6.2 收藏列表', cols.code === 200)
  await post('/api/users/1/follow', null, N)
  const follows = await get('/api/admin/follows?page=1&limit=5', A)
  check('6.3 关注列表', follows.code === 200 && follows.data.pagination.total >= 1)
  const notis = await get('/api/admin/notifications?page=1&limit=5', A)
  check('6.4 通知列表', notis.code === 200)
  const sendNoti = await post('/api/admin/notifications', { user_id: 'normaluser', title: '系统通知测试', content: '管理员群发实测' }, A)
  check('6.5 管理员发送系统通知', sendNoti.code === 201)
  const sessions = await get('/api/admin/sessions?page=1&limit=5', A)
  check('6.6 会话列表（token 脱敏）', sessions.code === 200 && sessions.data.data.length >= 1 && String(sessions.data.data[0].token_id).endsWith('…'))

  // ===== 7. 举报工单 =====
  const rep = await post('/api/reports', { target_type: 1, target_id: 10, reason: '垃圾营销', detail: '测试举报' }, N)
  check('7.1 用户提交举报', rep.code === 201 || rep.code === 200)
  const repDup = await post('/api/reports', { target_type: 1, target_id: 10, reason: '垃圾营销' }, N)
  check('7.2 重复举报幂等', repDup.code === 200 && /已举报/.test(repDup.message))
  const repList = await get('/api/admin/reports?page=1&limit=5', A)
  const repId = repList.data?.data?.[0]?.id
  check('7.3 管理侧举报列表', repList.code === 200 && repList.data.pagination.total >= 1)
  const repStats = await get('/api/admin/reports/stats', A)
  check('7.4 举报统计', repStats.code === 200 && repStats.data.total >= 1, JSON.stringify(repStats.data))
  const process = await put(`/api/admin/reports/${repId}/process`, { status: 2, handle_note: '不违规，测试工单' }, A)
  check('7.5 处理举报（不违规）', process.code === 200)
  const p10 = await get('/api/posts/10')
  check('7.6 不违规判定不动内容（笔记仍可见）', p10.code === 200)

  // ===== 8. 封禁/解封 =====
  const ban = await post('/api/admin/users/2/ban', { reason: 'V3封禁实测', duration: '1h' }, A)
  check('8.1 封禁用户（1小时）', ban.code === 201 || ban.code === 200, ban.message)
  const bannedLogin = await post('/api/auth/login', { user_id: 'user002', password: '123456' })
  check('8.2 被封用户登录 403', bannedLogin.code === 403, bannedLogin.message)
  const banList = await get('/api/admin/users?page=1&limit=100&user_id=user002', A)
  check('8.3 封禁状态在用户列表（封禁中）', banList.code === 200 && banList.data.data[0].ban_status_display === '封禁中' && banList.data.data[0].is_active === 0)
  const unban = await post('/api/admin/users/2/unban', {}, A)
  check('8.4 解封用户', unban.code === 200)
  const unbanLogin = await post('/api/auth/login', { user_id: 'user002', password: '123456' })
  check('8.5 解封后可登录', unbanLogin.code === 200)
  const banAdmin = await post('/api/admin/users/1/ban', { reason: '试图封禁管理员', duration: '1h' }, A)
  const adminRow = await get('/api/admin/users?page=1&limit=5&user_id=firstadmin', A)
  check('8.6 管理员账号不可封禁', banAdmin.code === 400 || (adminRow.data.data[0].is_admin === 1 && adminRow.data.data[0].is_active === 1))

  // ===== 9. 管理员账号模块（单管理员模型） =====
  const admins = await get('/api/admin/admins', A)
  check('9.1 管理员列表（唯一）', admins.code === 200 && admins.data.data.length === 1 && admins.data.data[0].user_id === 'firstadmin')
  const addAdmin = await post('/api/admin/admins', { username: 'x', password: 'x' }, A)
  check('9.2 添加管理员被拒（唯一管理员机制）', addAdmin.code === 400)
  const delAdmin = await del('/api/admin/admins/1', null, A)
  check('9.3 删除管理员被拒', delAdmin.code === 400)
  const adminSessions = await get('/api/admin/admin-sessions', A)
  check('9.4 管理员会话视图', adminSessions.code === 200 && Array.isArray(adminSessions.data.data))

  // ===== 10. 批量删除 =====
  const batch = await del('/api/admin/notifications', { ids: [] }, A)
  check('10.1 批量删除空 ids 400', batch.code === 400)

  console.log(`\n=== 汇总: ${results.filter(r => r[1]).length}/${results.length} 通过 ===`)
  const failed = results.filter(r => !r[1])
  if (failed.length) {
    console.log('失败项:')
    failed.forEach(f => console.log(`  ❌ ${f[0]} ${f[2] || ''}`))
    process.exitCode = 1
  }
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
