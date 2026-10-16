import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  clearManagerToken,
  deleteServerApp,
  getManagerState,
  getManagerToken,
  saveManagerSettings,
  saveServerApp,
  startServerApp,
  stopServerApp,
  restartServerApp,
  setManagerToken,
  updateServerApp,
  browseManagerPath,
  type ManagerState,
} from '../../services/serverManager'
import styles from './index.module.scss'

const jobLabels = { running: '正在下载或更新', succeeded: '更新完成', failed: '更新失败' }
const managerDownloadVersion = '1.0.6'
const managerDownloadFile = `steamcmd-manager-v${managerDownloadVersion}.zip`

export function ServerManagerPage({ embedded = false }: { embedded?: boolean }) {
  const [paired, setPaired] = useState(false)
  const [tokenInput, setTokenInput] = useState(getManagerToken)
  const [state, setState] = useState<ManagerState | null>(null)
  const [steamCmdPath, setSteamCmdPath] = useState('')
  const [installRoot, setInstallRoot] = useState('')
  const [name, setName] = useState('')
  const [appId, setAppId] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const refreshingRef = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return null
    refreshingRef.current = true
    try {
      const next = await getManagerState()
      setState(next)
      setPaired(true)
      setError('')
      return next
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接失败')
      return null
    } finally {
      refreshingRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!getManagerToken()) return
    void refresh().then((next) => {
      if (next) {
        setSteamCmdPath(next.steamCmdPath)
        setInstallRoot(next.installRoot)
      }
    })
  }, [refresh])

  useEffect(() => {
    if (!paired || busy) return
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [paired, busy, refresh])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setManagerToken(tokenInput)
    const next = await refresh()
    if (next) {
      setSteamCmdPath(next.steamCmdPath)
      setInstallRoot(next.installRoot)
      setNotice('已连接到这台 Windows 云服务器')
    }
  }

  async function run(action: () => Promise<ManagerState>, success: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      setState(await action())
      setNotice(success)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await run(
      () =>
        saveManagerSettings({ steamCmdPath: steamCmdPath.trim(), installRoot: installRoot.trim() }),
      '目录已保存到 Windows 云服务器'
    )
  }

  async function browse(kind: 'folder' | 'steamcmd', setValue: (value: string) => void) {
    setBusy(true)
    try {
      const result = await browseManagerPath(kind)
      if (result.path) setValue(result.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开目录选择器')
    } finally {
      setBusy(false)
    }
  }

  async function saveApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = Number(appId)
    if (!Number.isSafeInteger(id) || id <= 0) {
      setError('请输入有效的专用服务器 App ID')
      return
    }
    if (
      await run(
        () =>
          saveServerApp({
            appId: id,
            name: name.trim() || undefined,
            folder: folder.trim() || undefined,
          }),
        '游戏配置已保存，已显示在下方列表'
      )
    ) {
      setName('')
      setAppId('')
      setFolder('')
    }
  }

  return (
    <main className={styles.page}>
      {!embedded && (
        <header className={styles.header}>
          <Link to="/" className={styles.back}>
            ← 返回游戏库
          </Link>
          <h1>游戏服务器管理</h1>
          <p>请在安装 SteamCMD 的 Windows 云服务器上打开此页。</p>
        </header>
      )}

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}

      <section className={styles.download}>
        <div>
          <h2>Windows 管理程序 v{managerDownloadVersion}</h2>
          {paired && (
            <p>
              当前连接版本：
              {state?.managerVersion ? `v${state.managerVersion}` : '旧版（未提供版本号）'}
            </p>
          )}
          <p>请下载对应版本并解压，然后双击启动 BAT。首次启动会显示配对密钥。</p>
        </div>
        <a
          href={`${import.meta.env.BASE_URL}downloads/${managerDownloadFile}`}
          download={managerDownloadFile}
          className={styles.downloadLink}
        >
          下载 ZIP
        </a>
      </section>

      {!paired ? (
        <form className={styles.form} onSubmit={(event) => void pair(event)}>
          <h2>连接本机程序</h2>
          <p className={styles.hint}>
            先运行 Windows 管理程序，然后输入它显示的配对密钥。密钥仅保存在当前浏览器。
          </p>
          <label>
            配对密钥
            <input
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <button type="submit">连接</button>
        </form>
      ) : (
        <>
          <div className={styles.connection}>
            <span>● 已连接本机程序</span>
            <button
              type="button"
              onClick={() => {
                clearManagerToken()
                setPaired(false)
                setState(null)
                setTokenInput('')
              }}
            >
              断开配对
            </button>
          </div>

          <div className={styles.tools}>
            <div className={styles.popoverTool}>
              <button type="button" className={styles.toolButton}>
                安装目录
              </button>
              <form
                className={`${styles.form} ${styles.popover}`}
                onSubmit={(event) => void saveSettings(event)}
              >
                <h2>安装目录</h2>
                <label>
                  SteamCMD 路径
                  <div className={styles.pathInput}>
                    <input
                      value={steamCmdPath}
                      onChange={(event) => setSteamCmdPath(event.target.value)}
                      placeholder="自动识别，或选择 steamcmd.exe"
                    />
                    <button
                      type="button"
                      className={styles.browseButton}
                      onClick={() => void browse('steamcmd', setSteamCmdPath)}
                    >
                      浏览
                    </button>
                  </div>
                </label>
                <label>
                  游戏安装根目录
                  <div className={styles.pathInput}>
                    <input
                      value={installRoot}
                      onChange={(event) => setInstallRoot(event.target.value)}
                      placeholder="自动识别，或选择 steamapps\\common"
                    />
                    <button
                      type="button"
                      className={styles.browseButton}
                      onClick={() => void browse('folder', setInstallRoot)}
                    >
                      浏览
                    </button>
                  </div>
                </label>
                <button type="submit" disabled={busy || state?.job?.status === 'running'}>
                  保存目录
                </button>
              </form>
            </div>
            <div className={styles.popoverTool}>
              <button type="button" className={styles.toolButton}>
                添加服务器
              </button>
              <form
                className={`${styles.form} ${styles.popover}`}
                onSubmit={(event) => void saveApp(event)}
              >
                <h2>添加游戏服务器</h2>
                <label>
                  游戏名称
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={100}
                    placeholder="可选，下载后自动识别"
                  />
                </label>
                <label>
                  专用服务器 App ID
                  <input
                    value={appId}
                    onChange={(event) => setAppId(event.target.value)}
                    required
                    inputMode="numeric"
                    placeholder="2278520"
                  />
                </label>
                <label>
                  安装文件夹名
                  <input
                    value={folder}
                    onChange={(event) => setFolder(event.target.value)}
                    maxLength={64}
                    placeholder="可选，下载后自动识别"
                  />
                </label>
                <p className={styles.hint}>
                  只填写 App ID 即可下载；名称和文件夹会从 Steam
                  下载结果自动识别。已有存档可手动填写文件夹名；更新前先关闭游戏服务器。
                </p>
                <button type="submit" disabled={busy}>
                  保存游戏
                </button>
              </form>
            </div>
          </div>

          <section className={styles.list} aria-label="已保存的游戏服务器">
            <h2>已保存的服务器</h2>
            {state?.apps.length === 0 && <p>还没有保存服务器配置。</p>}
            {state?.apps.map((app) => (
              <article key={app.appId} className={styles.card}>
                <div className={styles.cardTop}>
                  <div>
                    <h3>{app.name || `App ID ${app.appId}`}</h3>
                    <p>
                      App ID {app.appId} · {app.folder || '下载后自动识别安装文件夹'}
                    </p>
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      disabled={busy || state.job?.status === 'running'}
                      onClick={() =>
                        void run(() => updateServerApp(app.appId), `${app.name} 已开始下载／更新`)
                      }
                    >
                      下载／更新
                    </button>
                    {app.running ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => stopServerApp(app.appId),
                              `${app.name || app.appId} 已停止`
                            )
                          }
                        >
                          停止
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => restartServerApp(app.appId),
                              `${app.name || app.appId} 已重启`
                            )
                          }
                        >
                          重启
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => startServerApp(app.appId),
                            `${app.name || app.appId} 已启动`
                          )
                        }
                      >
                        启动
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy || state.job?.status === 'running'}
                      onClick={() => {
                        if (
                          window.confirm(`删除「${app.name}」的网页配置？不会删除游戏文件和存档。`)
                        )
                          void run(() => deleteServerApp(app.appId), '游戏配置已删除')
                      }}
                    >
                      删除配置
                    </button>
                  </div>
                </div>
                <p className={styles.serverStatus}>
                  {app.running ? '● 服务运行中' : '○ 服务未运行'}
                  {app.executable ? ` · ${app.executable}` : ''}
                </p>
                {state.job?.appId === app.appId && <p>最近任务：{jobLabels[state.job.status]}</p>}
              </article>
            ))}
          </section>

          {state?.job && (
            <section className={styles.job}>
              <h2>最近任务：{jobLabels[state.job.status]}</h2>
              <p>
                App ID {state.job.appId} · 开始于 {new Date(state.job.startedAt).toLocaleString()}
              </p>
              <pre>{state.job.output || '等待 SteamCMD 输出…'}</pre>
            </section>
          )}
        </>
      )}
    </main>
  )
}
