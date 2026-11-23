// 给 seed.sql 的用户行补 password_hash（PBKDF2，与 src/auth.js 同算法）
// 用法：node scripts/add-pwd.js  （就地改写 seed.sql）
import fs from 'node:fs'
import { webcrypto } from 'node:crypto'

const ITER = 100000
const KEY_LEN = 32
const enc = new TextEncoder()
const b64 = (u8) => Buffer.from(u8).toString('base64')

async function derive(password, salt, iterations) {
  const base = await webcrypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    KEY_LEN * 8
  )
  return new Uint8Array(bits)
}

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const key = await derive(password, salt, ITER)
  return ['pbkdf2', ITER, b64(salt), b64(key)].join('$')
}

const P = 'C:/Users/Administrator/Desktop/hxs/hxs-cloudflare/seed.sql'
let sql = fs.readFileSync(P, 'utf8')

// seed.sql 里用户行形如：
// INSERT INTO users (id, user_id, nickname, avatar, bio, gender, mbti, created_at) VALUES (1, 'user001', ...);
// 策略：为每个用户生成统一演示密码 123456 的哈希，改成 UPDATE 语句追加到文件尾。
const ids = [...sql.matchAll(/INSERT INTO users \(id, user_id, nickname, avatar, bio, gender, mbti, created_at\) VALUES \((\d+), '(user\d+)'/g)]
console.log(`发现 ${ids.length} 个用户，生成密码哈希...`)

let lines = ['\n-- ---- V2：演示账号密码（统一 123456）----']
for (const [, id, uid] of ids) {
  const hash = await hashPassword('123456')
  lines.push(`UPDATE users SET password_hash = '${hash}' WHERE id = ${id}; -- ${uid}`)
}
fs.appendFileSync(P, lines.join('\n') + '\n')
console.log(`已追加 ${ids.length} 条 UPDATE 到 seed.sql`)
