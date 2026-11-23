import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { adminApi } from '@/api'

export const useAdminStore = defineStore('admin', () => {
  // 状态
  const admin = ref(null)
  const token = ref(localStorage.getItem('admin_token') || '')
  const refreshToken = ref(localStorage.getItem('admin_refresh_token') || '')

  // 计算属性
  const isLoggedIn = computed(() => !!admin.value && !!token.value)

  // 管理员登录
  const login = async (credentials) => {
    try {
      const response = await adminApi.login(credentials)

      if (response.success && response.data) {
        // 保存管理员信息和令牌
        admin.value = response.data.admin
        token.value = response.data.tokens.access_token
        refreshToken.value = response.data.tokens.refresh_token

        // 保存管理员Token到localStorage
        localStorage.setItem('admin_token', token.value)
        localStorage.setItem('admin_refresh_token', refreshToken.value)
        localStorage.setItem('admin_info', JSON.stringify(admin.value))

        return { success: true, message: response.message }
      } else {
        return { success: false, message: response.message || '登录失败' }
      }
    } catch (error) {
      console.error('管理员登录失败:', error)

      // 处理网络错误或其他异常
      let errorMessage = '登录失败，请稍后重试'
      if (error.response?.data?.message) {
        errorMessage = error.response.data.message
      } else if (error.message) {
        errorMessage = error.message
      }

      return { success: false, message: errorMessage }
    }
  }

  // 刷新令牌
  const refreshTokens = async () => {
    try {
      if (!refreshToken.value) {
        throw new Error('无刷新令牌')
      }

      const response = await adminApi.refreshToken({ refresh_token: refreshToken.value })

      if (response.success && response.data) {
        // 保存新令牌
        token.value = response.data.access_token
        refreshToken.value = response.data.refresh_token

        // 更新本地存储
        localStorage.setItem('admin_token', token.value)
        localStorage.setItem('admin_refresh_token', refreshToken.value)

        return { success: true }
      } else {
        throw new Error(response.message || '刷新令牌失败')
      }
    } catch (error) {
      console.error('刷新令牌失败:', error)
      // 刷新失败，清除登录状态
      await logout()
      return { success: false, message: error.message }
    }
  }

  // 退出登录
  const logout = async () => {
    try {
      // 调用后端登出接口
      if (token.value) {
        await adminApi.logout()
      }

      // 清除本地存储
      admin.value = null
      token.value = ''
      refreshToken.value = ''

      localStorage.removeItem('admin_token')
      localStorage.removeItem('admin_refresh_token')
      localStorage.removeItem('admin_info')

      // 管理员退出登录成功
    } catch (error) {
      console.error('管理员退出登录失败:', error)
      // 即使后端接口失败，也要清除本地状态
      admin.value = null
      token.value = ''
      refreshToken.value = ''
      localStorage.removeItem('admin_token')
      localStorage.removeItem('admin_refresh_token')
      localStorage.removeItem('admin_info')
    }
  }

  // 获取当前管理员信息
  const getCurrentAdmin = async () => {
    try {
      // token 为空时也允许探测：用户在前台已登录（hxs_token cookie）且是管理员时,
      // /api/auth/admin/me 会通过 cookie 鉴权成功 —— 实现"前台登录过，进后台免登录"
      const response = await adminApi.getCurrentAdmin()

      if (response.success && response.data) {
        admin.value = response.data.admin || response.data
        localStorage.setItem('admin_info', JSON.stringify(admin.value))
        return { success: true, data: response.data.admin || response.data }
      } else {
        throw new Error(response.message || '获取管理员信息失败')
      }
    } catch (error) {
      console.error('获取管理员信息失败:', error)

      // 如果是401错误，尝试刷新令牌
      if (error.response?.status === 401) {
        const refreshResult = await refreshTokens()
        if (refreshResult.success) {
          // 刷新成功后重新获取管理员信息
          try {
            const newResponse = await adminApi.getCurrentAdmin()
            if (newResponse.success && newResponse.data) {
              admin.value = newResponse.data.admin || newResponse.data
              localStorage.setItem('admin_info', JSON.stringify(admin.value))
              return { success: true, data: newResponse.data.admin || newResponse.data }
            } else {
              throw new Error(newResponse.message || '获取管理员信息失败')
            }
          } catch (refreshError) {
            console.error('刷新令牌后获取管理员信息失败:', refreshError)
            return { success: false, message: refreshError.message }
          }
        } else {
          // 刷新失败，清除登录状态
          await logout()
        }
      }

      return { success: false, message: error.message }
    }
  }

  // 初始化管理员信息（从本地存储恢复）
  const initializeAdmin = () => {
    try {
      const storedAdminInfo = localStorage.getItem('admin_info')
      if (storedAdminInfo && token.value) {
        admin.value = JSON.parse(storedAdminInfo)
        // 从本地存储恢复管理员信息
      }
    } catch (error) {
      console.error('恢复管理员信息失败:', error)
      // 清除可能损坏的数据
      logout()
    }
  }

  // 从前台用户会话恢复管理员登录态（前台登录 + is_admin=1 → 后台免登录）
  // 原理：管理员账号体系与用户账号同源（同一种 JWT 与 cookie），
  // /api/auth/admin/me 在无 admin_token 时走 hxs_token cookie 鉴权即可通过
  const syncFromUserSession = async () => {
    if (token.value || admin.value) return true // 已有管理员态，无需同步
    const userToken = localStorage.getItem('token')
    if (!userToken) return false
    try {
      // 用户已在前台登录：用同 token 身份探测是否管理员
      localStorage.setItem('admin_token', userToken)
      const result = await getCurrentAdmin()
      if (result.success && result.data?.admin) {
        token.value = userToken
        refreshToken.value = userToken
        admin.value = result.data.admin
        localStorage.setItem('admin_refresh_token', userToken)
        localStorage.setItem('admin_info', JSON.stringify(admin.value))
        return true
      }
      // 不是管理员：清理探测痕迹，避免污染 admin 状态
      localStorage.removeItem('admin_token')
      return false
    } catch (error) {
      localStorage.removeItem('admin_token')
      return false
    }
  }

  // 检查token有效性
  const checkTokenValidity = async () => {
    if (!token.value) return false

    try {
      const result = await getCurrentAdmin()
      return result.success
    } catch (error) {
      return false
    }
  }

  return {
    // 状态
    admin,
    token,
    refreshToken,

    // 计算属性
    isLoggedIn,

    // 方法
    login,
    logout,
    syncFromUserSession,
    refreshTokens,
    getCurrentAdmin,
    initializeAdmin,
    checkTokenValidity
  }
})