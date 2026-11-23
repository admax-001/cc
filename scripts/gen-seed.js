// 生成 seed.sql 种子数据（V1 阅读侧）
// 规模对齐本地环境：50 用户 / 200 笔记 / 约 630 图 / 800 评论 / 10 分类 / 76 标签
// 图片引用 t.alcy.cc 已验证可用链接池循环取用
// 用法：node scripts/gen-seed.js
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const out = process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || path.join(__dirname, '..', 'seed.sql')

// —— 随机但可复现 ——
let seed = 20261123
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min

// —— 图片池（已验证 HTTP 200）——
const POST_IMGS = [
  'https://t.alcy.cc/pic/moemp/GH0aEp6bIAAT2Wa.webp',
  'https://t.alcy.cc/pic/moemp/5.webp',
  'https://t.alcy.cc/pic/moemp/055.webp',
  'https://t.alcy.cc/pic/moemp/200.webp',
  'https://t.alcy.cc/pic/moemp/12.webp',
  'https://t.alcy.cc/pic/moemp/photo_2024-09-30_14-14-34.webp',
  'https://t.alcy.cc/pic/mp/136017344_p0.webp',
  'https://t.alcy.cc/pic/mp/89225483_p0.webp',
  'https://t.alcy.cc/pic/mp/20250526_01.webp',
  'https://t.alcy.cc/pic/mp/20250526_02.webp'
]
const AVATARS = [
  'https://t.alcy.cc/pic/tx/PixPin_2025-07-02_19-09-44.jpg',
  'https://t.alcy.cc/pic/tx/22.webp',
  'https://t.alcy.cc/pic/tx/10.webp',
  'https://t.alcy.cc/pic/tx/21.webp',
  'https://t.alcy.cc/pic/tx/33.webp',
  'https://t.alcy.cc/pic/tx/44.webp'
]

const CATEGORIES = [
  ['学习', 'study'], ['校园', 'campus'], ['情感', 'emotion'], ['兴趣', 'interest'],
  ['生活', 'life'], ['社交', 'social'], ['求助', 'help'], ['观点', 'opinion'],
  ['毕业', 'graduate'], ['职场', 'workplace']
]

const NICKS = ['云鲸漫游','芋圆小甜饼','晚风扑满怀','雾岛听风','星子打烊了','小梨涡','薄荷微光','风拂过裙摆','春日部干事','山月记','橘色晚霞','夏夜晚风','碎星入怀','奶芙泡芙','奶油小方','莓烦恼','汽水冒泡','甜度超标','小熊软糖','枕星河入梦','树影摇窗','林间小筑','碎碎念小记','木槿昔年','柚子味汽水','七秒记忆的鱼','拿铁不加糖','渡鹤','折月煮酒','听雾说','拾光者','栖迟于林','竹里馆主','一枕星河','半盏清茶','青柠气泡','屿暖','栀夏','默语','予笙','汐藏','白桃乌龙','屿风与你','温柔一只猫','麦芽糖的话','揽星河入梦','咕咕鸟','屿你同行','薄暮流光','北屿']
const MBTIS = ['INTJ','INFP','ENFP','ISTJ','ENTP','ISFP','INFJ','ENFJ','ISTP','ESTJ','ISFJ','INTP','ESTP','ESFP']
const BIOS = ['一句话介绍自己','努力学习的小白','爱睡觉爱美食','在路上的观察者','记录即意义','慢慢来比较快','校园生活玩家','灵感捕手','平凡的日常收藏家','热爱可抵岁月漫长','保持热爱奔赴山海','书影音漫游指南','效率工具研究者','手账与胶带爱好者','背包客与美食家','方法论收集癖','细节控','好天气收藏家']

const TITLE_TMPL = [
  ['高效学习法分享，让你事半功倍','深度分析：xxx背后的原因','个人见解：xxx的利与弊','问题解答：详细教程来了','面试技巧总结，助你成功拿offer'],
  ['新生入学指南，学长学姐的贴心提醒','校园好物推荐，实用又好看','考研经验分享，我的上岸之路','英语学习心得，零基础也能学好','图书馆自习攻略，效率翻倍'],
  ['关于成长，我想说的话','写给焦虑时的自己','和朋友的一次深夜长谈','记录最近的小确幸','情绪管理心得，与自己和解'],
  ['烘焙小课堂，甜蜜生活从这里开始','手工编织入门，治愈系爱好','摄影构图技巧，手机也能出大片','书法练习日记，一笔一划皆修行','吉他自学一个月的成果'],
  ['早起挑战日记，美好从清晨开始','美食制作教程，治愈系料理时光','租房改造指南，低成本大改变','健身三个月的变化记录','断舍离实践，生活更轻盈'],
  ['今日穿搭分享，做自己的时尚博主','周末city walk路线推荐','和朋友的小聚日常','认识新朋友的破冰技巧','宿舍好物分享，提升幸福感'],
  ['求助：这道题怎么解？','求推荐适合新手的xxx','有人知道这个软件怎么用吗','急问：这个情况该怎么办','求助帖：电脑蓝屏自救指南'],
  ['关于xxx现象的一些思考','我为什么不焦虑了','对大学生活的几点观察','关于选择比努力更重要的辩论','理性讨论：习惯的力量'],
  ['毕业倒计时，我的大学总结','毕业答辩全流程经验','毕业旅行计划分享','离校手续办理清单','写给学弟学妹的话'],
  ['实习日记：初入职场的酸甜苦辣','职场穿搭指南，形象管理很重要','职业规划分享，如何找到适合的方向','简历修改心得，拿到面试邀约','时间管理技巧，告别拖延症']
]
const CONTENT_TMPL = [
  '大家好，今天想分享一些最近的实践心得。{tagline}经过一段时间的摸索，我总结了几个关键点：第一，目标要拆解成可执行的小步骤；第二，建立自己的反馈机制，每周复盘一次；第三，不要追求完美主义，先完成再优化。希望这些经验对大家有帮助，有问题欢迎评论区交流～',
  '这条笔记记录一下最近的日常。{tagline}说实话一开始也没想好怎么开始，就先从最简单的做起，慢慢地居然坚持下来了。过程里有几次想放弃，但看到一点点变化后就又有动力了。如果你也在做类似的事，欢迎留言互相打卡监督！',
  '关于这个话题，我的看法是这样的。{tagline}网上有很多说法，但我结合自己的体验，觉得最重要的是找到适合自己的节奏，别人的方法可以参考但不必照搬。以下是我踩过的三个坑和对应的解决办法，供大家避雷。',
  '整理了一份超详细的入门攻略，从零基础到入门亲测有效。{tagline}全文比较长，先讲思路再讲步骤，建议先收藏再看。文中的资料都是我自己用过的，没有废话，直接上干货。觉得有用的话点个赞让更多人看到～',
  '最近的一点碎碎念和生活感悟。{tagline}日子平平淡淡，但也有一些值得记录的瞬间。把这些写下来，回头看的时候会感谢当时认真生活的自己。也祝愿看到这条笔记的你，天天开心，万事顺遂。'
]
const TAGLINES = ['','说实话这方法真的不错。','亲测有效，强烈安利。','仅供参考哈～','一句话总结：坚持就是胜利。','不夸张地说，改变了我。']
const COMMENT_TMPL = [
  '写得太好了，收藏了！','感谢分享，正需要这个','博主好用心，支持一下','学到了，回去就试试','同感，我也遇到过类似情况','已点赞已关注，蹲后续','这个思路清奇，但好像可行','感谢，解决了我的大问题','路过留个爪印','哈哈哈哈太真实了','加油！期待更多分享','有道理，受教了','马克一下周末看','慕了慕了','这个角度我没有想过，厉害','支持博主，继续更新呀','看到了很多共鸣，感谢','总结能力一流','有用，转给我同学了','666，前排膜拜','已转发到班群，谢谢博主','好文，帮大忙','蹲一个下期','哈哈这波操作可以','这个值得反复看','终于等到了这篇','感觉说出了我的心声','满满干货，笔记做起来','先赞后看，习惯成自然','前排围观，写得很清楚','这个我关注很久了，终于有人写明白','不错不错，就是排版可以再优化','收藏夹吃灰预警（不是）','求出个详细教程'
]
const TAG_POOL = ['高效学习','校园','成长','手工','美食','穿搭','摄影','健身','考研','英语','实习','职场','简历','情绪管理','早起','city walk','断舍离','吉他','书法','烘焙','书单','观影','方法论','好物推荐','宿舍改造','复盘','时间管理','读书笔记','生活记录','小确幸','毕业','答辩','旅行攻略','新手入门','避坑指南','干货分享','经验分享','打卡','自律','治愈系','手账','效率工具','大学生','学习方法','思维导图','笔记法','图书馆','自习','早起打卡','运动','健身餐','睡眠','心理学','自我提升','沟通','表达','演讲','辩论','读书','写作','随笔','感悟','正能量','解压','放松','音乐','歌单','耳机推荐','数码','软件推荐','编程','前端','AI工具','办公技巧']

const CITIES = ['北京','上海','广州','深圳','杭州','成都','武汉','西安','南京','重庆','长沙','厦门','青岛','哈尔滨','昆明','大连','苏州','郑州','天津','合肥']
const esc = (s) => s.replace(/'/g, "''")
const ts = (daysAgo, hh = 12, mm = 0) => {
  const d = new Date(Date.UTC(2026, 10, 23) - daysAgo * 86400000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`
}

const lines = []
lines.push('-- 黑小帅 V1 种子数据（自动生成，勿手改）')
lines.push('-- 生成时间: ' + new Date().toISOString())
// 注意：Cloudflare D1 不支持 BEGIN TRANSACTION / SAVEPOINT / PRAGMA，
// wrangler d1 execute --file 本身就是原子导入（失败自动回滚），无需显式事务包裹
// 外键依赖：comments/post_tags/post_images/likes/collections/follows/notifications/user_ban/reports → posts/users，先删子表再删父表
lines.push('DELETE FROM comments; DELETE FROM post_tags; DELETE FROM post_images; DELETE FROM likes; DELETE FROM collections; DELETE FROM follows; DELETE FROM notifications; DELETE FROM posts; DELETE FROM tags; DELETE FROM categories; DELETE FROM user_sessions; DELETE FROM user_ban; DELETE FROM reports; DELETE FROM audit; DELETE FROM users;')
lines.push("DELETE FROM sqlite_sequence WHERE name IN ('categories','tags','users','posts','post_images','comments');")

// 分类
CATEGORIES.forEach(([name, title], i) => lines.push(`INSERT INTO categories (id, name, title, category_title) VALUES (${i + 1}, '${esc(name)}', '${title}', '${title}');`))

// 标签
const tags = TAG_POOL
tags.forEach((name, i) => lines.push(`INSERT INTO tags (id, name, use_count) VALUES (${i + 1}, '${esc(name)}', ${int(1, 9)});`))

// 用户（8 个特定数字账号，密码统一 12345678，PBKDF2 哈希与 src/auth.js 同格式）
const ACCOUNTS = Array.from({ length: 8 }, (_, i) => String(10000001 + i)) // 10000001 ~ 10000008
const PASSWORD = '12345678'
const ITER = 100000
const hashPasswordSync = (password) => {
  const salt = crypto.randomBytes(16)
  const key = crypto.pbkdf2Sync(password, salt, ITER, 32, 'sha256')
  return ['pbkdf2', ITER, salt.toString('base64'), key.toString('base64')].join('$')
}
ACCOUNTS.forEach((acc, i) => {
  lines.push(`INSERT INTO users (id, user_id, nickname, avatar, bio, gender, mbti, password_hash, created_at) VALUES (${i + 1}, '${acc}', '${esc(NICKS[i])}', '${pick(AVATARS)}', '${esc(pick(BIOS))}', '${pick(['male', 'female', 'secret'])}', '${pick(MBTIS)}', '${hashPasswordSync(PASSWORD)}', '${ts(int(60, 200))}');`)
})

// 笔记（150）+ 图（1~6 张/篇）+ 标签关联（2~4 个/篇）
let imgSeq = 0, tagUse = {}
for (let i = 1; i <= 150; i++) {
  const catIdx = int(0, CATEGORIES.length - 1)
  const title = pick(TITLE_TMPL[catIdx])
  const content = pick(CONTENT_TMPL).replace('{tagline}', pick(TAGLINES))
  const daysAgo = int(0, 45), hh = int(8, 23), mm = int(0, 59)
  lines.push(`INSERT INTO posts (id, user_id, title, content, category_id, location, view_count, like_count, comment_count, status, created_at) VALUES (${i}, ${int(1, 8)}, '${esc(title)}', '${esc(content)}', ${catIdx + 1}, '${pick(CITIES)}', ${int(5, 900)}, ${int(0, 80)}, ${int(0, 12)}, 0, '${ts(daysAgo, hh, mm)}');`)
  const nImg = int(1, 6)
  for (let s = 0; s < nImg; s++) {
    imgSeq++
    lines.push(`INSERT INTO post_images (id, post_id, url, sort) VALUES (${imgSeq}, ${i}, '${POST_IMGS[imgSeq % POST_IMGS.length]}', ${s});`)
  }
  const tCount = int(2, 4), tSet = new Set()
  while (tSet.size < Math.min(tCount, tags.length)) {
    tSet.add(int(0, tags.length - 1))
  }
  for (const tIdx of tSet) {
    lines.push(`INSERT INTO post_tags (post_id, tag_id) VALUES (${i}, ${tIdx + 1});`)
    tagUse[tIdx + 1] = (tagUse[tIdx + 1] || 0) + 1
  }
}

// 更新标签真实使用量
Object.entries(tagUse).forEach(([tid, n]) => lines.push(`UPDATE tags SET use_count = ${n} WHERE id = ${tid};`))

// 评论（600，分布到前 120 篇）
for (let i = 0; i < 600; i++) {
  lines.push(`INSERT INTO comments (id, post_id, user_id, content, created_at) VALUES (${i + 1}, ${int(1, 120)}, ${int(1, 8)}, '${esc(pick(COMMENT_TMPL))}', '${ts(int(0, 40), int(8, 23), int(0, 59))}');`)
}

fs.writeFileSync(out, lines.join('\n'), 'utf8')
console.log(`seed.sql 已生成 -> ${out}`)
console.log(`账号 ${ACCOUNTS.length}（${ACCOUNTS[0]}~${ACCOUNTS[ACCOUNTS.length - 1]}，密码 ${PASSWORD}）/ 分类 ${CATEGORIES.length} / 标签 ${tags.length} / 笔记 150 / 图片 ${imgSeq} / 评论 600`)
