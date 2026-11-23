<template>
  <div class="post-detail-page">

    <div v-if="loading" class="loading-container">
      <div class="loading-spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- 笔记不存在：站内空态（不再闪现 NotFound 页 + 倒计时强跳） -->
    <div v-else-if="notFoundState" class="detail-empty">
      <div class="empty-icon">📝</div>
      <h3>该笔记不存在或已被删除</h3>
      <p>它可能已被作者删除，或链接已失效</p>
      <button class="empty-action" @click="goBack">返回首页逛逛</button>
    </div>

    <!-- 瞬时错误（网络/服务抖动）：可重试，不当作页面不存在 -->
    <div v-else-if="loadError" class="detail-empty">
      <div class="empty-icon">⚠️</div>
      <h3>加载失败</h3>
      <p>网络波动或服务暂时不可用，请稍后重试</p>
      <button class="empty-action" @click="retry">重新加载</button>
    </div>

    <div v-else>

      <DetailCard :item="postData" :page-mode="true" :target-comment-id="targetCommentId" @close="goBack" />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getPostDetail } from '@/api/posts'
import DetailCard from '@/components/DetailCard.vue'

const route = useRoute()
const router = useRouter()

const postData = ref(null)
const loading = ref(true)
const notFoundState = ref(false)
const loadError = ref(false)
const targetCommentId = ref(null)
const lastPostId = ref(null)

// 保存原始页面标题
const originalTitle = ref('')




// 返回主页
const goBack = () => {
  router.push('/explore')
}

// 获取笔记详情
const fetchPostDetail = async (postId) => {
  lastPostId.value = postId
  try {
    loading.value = true
    notFoundState.value = false
    loadError.value = false
    const response = await getPostDetail(postId)

    if (response && response.notFound) {
      // 笔记不存在/已删除：站内空态（不跳 NotFound 页）
      notFoundState.value = true
      return
    }
    if (response && response.id) {
      postData.value = response
      // 设置页面标题
      document.title = response.title || '笔记详情'
      return
    }
    // 瞬时错误：可重试错误态（不跳 NotFound 页）
    loadError.value = true
  } catch (error) {
    console.error('获取笔记详情出错:', error)
    loadError.value = true
  } finally {
    loading.value = false
  }
}

// 重试（网络抖动后再次拉取）
const retry = () => {
  if (lastPostId.value) fetchPostDetail(lastPostId.value)
}





// 组件挂载时获取笔记详情
onMounted(() => {
  // 保存原始页面标题
  originalTitle.value = document.title

  const postId = route.query.id
  if (postId) {
    // 获取targetCommentId参数
    targetCommentId.value = route.query.targetCommentId || null
    fetchPostDetail(postId)
  } else {
    // 缺少 id 参数：URL 本身无效，走 NotFound（真路由层 404）
    router.replace({ name: 'not_found' })
    loading.value = false
  }
})

// 组件卸载时恢复原始标题
onUnmounted(() => {
  // 恢复原始页面标题
  if (originalTitle.value) {
    document.title = originalTitle.value
  }
})
</script>

<style scoped>
.post-detail-page {
  min-height: calc(100vh - 64px);
  margin: 10px;
  width: 100%;
  box-sizing: border-box;
  position: relative;
  padding-top: 64px;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 64px 20px 20px 20px;
}

/* 中等屏幕适配 */
@media (max-width: 960px) {
  .post-detail-page {
    margin: 0;
    padding: 0;
    padding-top: 64px;
    width: 100vw;
    max-width: 100vw;
  }
}

/* 移动端适配 */
@media (max-width: 768px) {
  .post-detail-page {
    margin: 0;
    padding: 0;
    overflow-y: visible;
    overflow-x: hidden;
    width: 100vw;
    height: 100vh;
    min-height: 100vh;
    max-width: 100vw;
    display: block;
    border-radius: 0;
    box-shadow: none;
    align-items: normal;
    justify-content: normal;
  }
}

/* 加载状态样式 */
.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 400px;
  text-align: center;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

/* 笔记不存在 / 加载失败 空态样式 */
.detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 360px;
  text-align: center;
  padding: 40px 24px;
}

.detail-empty .empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  line-height: 1;
}

.detail-empty h3 {
  font-size: 18px;
  color: var(--text-color-primary, #1f2d3d);
  margin: 0 0 8px;
  font-weight: 600;
}

.detail-empty p {
  font-size: 14px;
  color: var(--text-color-secondary, #5b6b80);
  margin: 0 0 24px;
}

.detail-empty .empty-action {
  padding: 10px 32px;
  border: none;
  border-radius: 20px;
  background: var(--primary-color, #ff2442);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}

.detail-empty .empty-action:hover {
  opacity: 0.85;
}

/* 中等屏幕和移动端的加载状态样式 */
@media (max-width: 960px) {
  .loading-container {
    position: relative;
    top: auto;
    left: auto;
    transform: none;
    min-height: calc(100vh - 64px);
    width: 100%;
  }
}

@media (max-width: 768px) {
  .loading-container {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    transform: none;
    min-height: 100vh;
    width: 100vw;
    height: 100vh;
    padding: 20px;
    box-sizing: border-box;
    background: var(--bg-color-primary);
    z-index: 1000;
  }
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid var(--border-color-primary);
  border-top: 4px solid var(--primary-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

/* 移动端加载动画 */
@media (max-width: 768px) {
  .loading-spinner {
    width: 48px;
    height: 48px;
    border-width: 5px;
    margin-bottom: 20px;
  }
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}
</style>