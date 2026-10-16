const API = 'http://127.0.0.1:17864/api'
const TOKEN_KEY = 'game-gallery-local-manager-token'

export interface ServerApp {
  appId: number
  name: string
  folder: string
  running?: boolean
  executable?: string
}

export interface ServerJob {
  id: string
  appId: number
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt?: string
  output: string
}

export interface ManagerState {
  managerVersion?: string
  steamCmdPath: string
  installRoot: string
  apps: ServerApp[]
  job: ServerJob | null
}

export function getManagerToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setManagerToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim())
}

export function clearManagerToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getManagerToken()
  if (!token) throw new Error('请先输入 Windows 本地程序显示的配对密钥')
  const controller = new AbortController()
  const timer = window.setTimeout(
    () => controller.abort(),
    path.startsWith('/browse') ? 120000 : 10000
  )
  try {
    const response = await fetch(`${API}${path}`, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Manager-Token': token,
      },
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result?.error ?? `请求失败（${response.status}）`)
    return result as T
  } catch (cause) {
    if (controller.signal.aborted)
      throw new Error('本机程序响应超时，请确认目录选择窗口已关闭，然后重试连接。')
    if (cause instanceof Error && !(cause instanceof TypeError)) throw cause
    throw new Error(
      '无法连接本机程序。请在 Windows 云服务器上运行管理程序，并允许浏览器访问本地网络。'
    )
  } finally {
    window.clearTimeout(timer)
  }
}

export const getManagerState = () => request<ManagerState>('/state')

export const saveManagerSettings = (settings: Pick<ManagerState, 'steamCmdPath' | 'installRoot'>) =>
  request<ManagerState>('/settings', { method: 'PUT', body: JSON.stringify(settings) })

export const saveServerApp = (
  app: Pick<ServerApp, 'appId'> & Partial<Pick<ServerApp, 'name' | 'folder'>>
) => request<ManagerState>('/apps', { method: 'POST', body: JSON.stringify(app) })

export const browseManagerPath = (kind: 'folder' | 'steamcmd') =>
  request<{ path: string | null }>(`/browse?kind=${kind}`)

export const deleteServerApp = (appId: number) =>
  request<ManagerState>(`/apps/${appId}`, { method: 'DELETE' })

export const updateServerApp = (appId: number) =>
  request<ManagerState>(`/apps/${appId}/update`, { method: 'POST' })

export const startServerApp = (appId: number) =>
  request<ManagerState>(`/apps/${appId}/start`, { method: 'POST' })

export const stopServerApp = (appId: number) =>
  request<ManagerState>(`/apps/${appId}/stop`, { method: 'POST' })

export const restartServerApp = (appId: number) =>
  request<ManagerState>(`/apps/${appId}/restart`, { method: 'POST' })
