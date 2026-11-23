# API 文档（V1 · 阅读侧）

Base URL：`https://<你的worker名>.workers.dev`

统一响应格式：

```json
{ "code": 200, "message": "success", "data": { ... } }
```

错误响应：`{ "code": 4xx/5xx, "message": "错误描述" }`，HTTP 状态码同步返回。

分页参数（`page` 默认 1，`limit` 默认 20、上限 50）：

```json
{ "page": 1, "limit": 20, "total": 200, "pages": 10 }
```

---

## 只读接口（13 个）

### 健康检查

```
GET /api/health
```

```json
{ "code": 200, "data": { "status": "ok", "version": "1.0.0", "time": "2026-11-23T02:00:00.000Z" } }
```

### 分类列表

```
GET /api/categories
```

首页频道 Tab 数据源；前端用 `category_title` 作为路由路径。

```json
{ "code": 200, "data": [ { "id": 1, "name": "学习", "title": "study", "category_title": "study" }, ... ] }
```

### 笔记分页（瀑布流）

```
GET /api/posts?page=1&limit=20&category=学习
```

- `category` 可传分类**名称**（`学习`）、**id**（`1`）或 `category_title`（`study`）
- 特殊频道值 `recommend`（推荐）/ `general`（通用）**不按分类过滤**，返回全量流
- 仅返回 `status = 0`（正常）的笔记

```json
{
  "code": 200,
  "data": {
    "posts": [ { "id": 1, "title": "...", "content": "...",
      "images": ["https://.../a.jpg"], "cover_image": "https://.../a.jpg",
      "image_count": 3, "category": "学习", "location": "",
      "view_count": 12, "like_count": 5, "comment_count": 2, "collect_count": 0,
      "liked": false, "collected": false, "verified": 0, "type": 1, "status": 0,
      "created_at": "2026-11-20 10:00:00",
      "user_id": "user001", "author_auto_id": 1, "author_account": "user001",
      "nickname": "昵称", "user_avatar": "https://.../avatar.jpg",
      "tags": [], "tags_detail": [] } ],
    "pagination": { "page": 1, "limit": 20, "total": 200, "pages": 10 }
  }
}
```

字段名与原 Vue3 前端 `transformPostData` 期望完全对齐，前端 api 层零改动对接。

### 笔记详情

```
GET /api/posts/:id?skipViewCount=false
```

- 返回单篇笔记（结构同上，另含 `tags` / `tags_detail` 标签聚合）
- 默认**浏览计数自增**；传 `skipViewCount=true` 跳过（如管理预览）
- 不存在或已删除返回 `404`

### 笔记评论

```
GET /api/posts/:id/comments?page=1&limit=10
```

按时间倒序；`limit` 默认 10。每条评论含嵌套 `user` 对象与 `replies: []`（V1 一级评论）。

```json
{
  "code": 200,
  "data": {
    "comments": [ { "id": 1, "post_id": 1, "parent_id": null,
      "content": "...", "created_at": "...", "like_count": 0, "liked": false,
      "user_id": "user001", "nickname": "...", "user_avatar": "...",
      "user": { "id": 1, "user_id": "user001", "nickname": "...", "avatar": "..." },
      "replies": [] } ],
    "pagination": { "page": 1, "limit": 10, "total": 8, "pages": 1 }
  }
}
```

### 标签

```
GET /api/tags            # 全量标签（按 use_count 降序）
GET /api/tags/hot?limit=20   # 热门标签（limit 上限 50）
```

```json
{ "code": 200, "data": [ { "id": 1, "name": "学习打卡", "use_count": 32 }, ... ] }
```

### 搜索

```
GET /api/search?type=posts&keyword=复习&tag=&page=1&limit=20
GET /api/search/posts?keyword=复习      # 同一处理器
```

- `keyword` 与 `tag` 至少传一个（否则 400）
- 标题 / 正文 LIKE 模糊匹配，标签经 `post_tags` 关联
- **响应结构与 `type` 相关**（对齐原版）：
  - `type=all`（默认）：`data` 为扁平帖子数组 + `tagStats`
  - `type=posts` / `videos`：包一层 `posts: { data, tagStats, pagination }`
- 搜索页直接渲染后端原始数据（不过 `transformPostData`），
  帖子对象为**扁平结构**：`author` 是字符串昵称而非嵌套对象
- `users` / `tags` 分区 V1 返回空结构（占位防前端报错）

```json
{
  "code": 200,
  "data": {
    "keyword": "复习", "tag": "", "type": "posts",
    "posts": { "data": [ { "id": 3, "title": "...", "author": "昵称", "avatar": "...", ... } ],
               "tagStats": [], "pagination": { "page": 1, "limit": 20, "total": 2, "pages": 1 } },
    "users": { "data": [], "pagination": { "page": 1, "limit": 20, "total": 0, "pages": 0 } },
    "tags":  { "data": [], "pagination": { "page": 1, "limit": 20, "total": 0, "pages": 0 } }
  }
}
```

### 搜索联想

```
GET /api/search/suggest?keyword=学
```

返回标签联想（按热度取 5 条）；`posts` / `users` V1 为空数组。

```json
{ "code": 200, "data": { "tags": [ { "id": "学习打卡", "name": "学习打卡" } ], "posts": [], "users": [] } }
```

### 关注流

```
GET /api/posts/following?page=1
```

V1 无登录体系，返回空列表（前端显示空态）。

### 用户主页笔记

```
GET /api/users/:userId/posts?page=1
```

V1 返回空列表结构（页面不报错，V2 启用）。

### 根路径状态页

```
GET /
```

仅 API 直连时可见（部署后前端资产优先接管 `/`）；返回服务名、版本与端点清单。

---

## V2 占位接口（13 个，返回 501）

以下写接口路由已注册，调用将返回
`{ "code": 501, "message": "该功能将在 V2 上线开放，敬请期待" }`（HTTP 501），
前端点击会收到明确提示而非报错：

| 方法 | 路径 | V2 规划 |
|---|---|---|
| POST / PUT / DELETE | `/api/posts`、`/api/posts/:id` | 发布 / 编辑 / 删除笔记 |
| POST / DELETE | `/api/likes` | 点赞 / 取消点赞 |
| POST / DELETE | `/api/posts/:id/collect` | 收藏 / 取消收藏 |
| POST | `/api/comments` | 发表评论 |
| POST | `/api/auth/login`、`/register`、`/logout`、`/admin/login` | 登录体系（JWT） |
| POST | `/api/upload/image` | 图片上传（imgbed API 直传） |

> AI生成
