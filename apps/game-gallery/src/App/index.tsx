import { useState, useEffect, lazy, Suspense, useRef, useCallback } from 'react'
import { Link, Routes, Route } from 'react-router-dom'
import classNames from 'classnames'
import { GameItem } from '../components/GameItem'
import { SearchBar, type SearchResult } from '../components/SearchBar'
import type { Game } from '../types'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Loader2,
  Play,
  Bookmark,
  CheckCircle,
  PackageOpen,
  Plus,
  GamesIcon,
  PlaygroundIcon,
  LogoIcon,
} from '../components/icons/Icons'
import { gameService } from '../services/game'
import { userGameService } from '../services/userGame'
import { steamService } from '../services/steam'
import type { GameStatus } from '../types'
import {
  mergeGameData,
  toCreateGameRequest,
  extractAppIdFromSteamUrl,
} from '../utils/gameDataMapper'
import styles from './index.module.scss'

// 导入自定义 hooks
import { useToast } from '../hooks/useToast'
import { useHighlight } from '../hooks/useHighlight'
import { useGamesGrouping } from '../hooks/useGamesGrouping'
import { useGameSearch } from '../hooks/useGameSearch'
import { useMasonry } from '../hooks/useMasonry'

// 懒加载重组件（命名导出转换为默认导出）
const MiniGames = lazy(() =>
  import('../components/MiniGames').then((module) => ({ default: module.MiniGames }))
)
const SteamSearch = lazy(() =>
  import('../components/SteamSearch').then((module) => ({ default: module.SteamSearch }))
)
const Settings = lazy(() =>
  import('../components/Settings').then((module) => ({ default: module.Settings }))
)
const TowerDefensePage = lazy(() =>
  import('../pages/TowerDefense').then((module) => ({ default: module.TowerDefensePage }))
)
const ServerManagerPage = lazy(() =>
  import('../pages/ServerManager').then((module) => ({ default: module.ServerManagerPage }))
)

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route
        path="/tower-defense"
        element={
          <Suspense
            fallback={
              <div className={styles.loadingContainer}>
                <Loader2 className={`${styles.loaderIcon} animate-spin`} size={32} />
              </div>
            }
          >
            <TowerDefensePage />
          </Suspense>
        }
      />
      <Route
        path="/server-manager"
        element={
          <Suspense fallback={<div>加载中...</div>}>
            <ServerManagerPage />
          </Suspense>
        }
      />
    </Routes>
  )
}

function HomePage() {
  // 状态管理
  const [games, setGames] = useState<Game[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [showSteamSearch, setShowSteamSearch] = useState(false)
  const [mainTab, setMainTab] = useState<'steamgames' | 'playground'>('steamgames')
  const [activeTab, setActiveTab] = useState<'playing' | 'queueing' | 'completion'>('playing')
  const [statusCounts, setStatusCounts] = useState<Record<GameStatus, number>>({
    playing: 0,
    queueing: 0,
    completion: 0,
  })

  // 分页状态
  const [playingPage, setPlayingPage] = useState(1)
  const [queueingPage, setQueueingPage] = useState(1)
  const [completionPage, setCompletionPage] = useState(1)
  const [hasMorePlaying, setHasMorePlaying] = useState(false)
  const [hasMoreQueueing, setHasMoreQueueing] = useState(false)
  const [hasMoreCompletion, setHasMoreCompletion] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // 使用自定义 hooks
  const { toast, showToast } = useToast()
  const { highlightId, setHighlightId } = useHighlight()
  const groupedGames = useGamesGrouping(games)
  const searchResults = useGameSearch(games, searchTerm)
  const currentGames = groupedGames[activeTab]
  const { columns, distribute } = useMasonry()
  const masonryColumns = distribute(currentGames)

  // IntersectionObserver ref
  const observerTarget = useRef<HTMLDivElement>(null)

  // 加载指定状态的游戏
  const loadGamesByStatus = async (status: GameStatus, page: number = 1) => {
    const result = await userGameService.getUserGames({
      status,
      page,
      page_size: 20,
    })

    // Happy Path: 获取失败或未登录
    if (!result) {
      return { games: [], hasMore: false, totalCount: 0 }
    }

    // 转换为前端格式
    const games = mergeGameData(result.data, null)
    return {
      games,
      hasMore: result.pagination.has_next,
      totalCount: result.pagination.total_count,
    }
  }

  // 重新加载各状态第一页，并重置分页游标
  const reloadLibraryFirstPages = async (showLoading: boolean = false) => {
    if (showLoading) {
      setIsLoading(true)
    }

    try {
      const [playingResult, queueingResult, completionResult] = await Promise.all([
        loadGamesByStatus('playing', 1),
        loadGamesByStatus('queueing', 1),
        loadGamesByStatus('completion', 1),
      ])

      const allGames = [...playingResult.games, ...queueingResult.games, ...completionResult.games]

      setGames(allGames)
      setStatusCounts({
        playing: playingResult.totalCount,
        queueing: queueingResult.totalCount,
        completion: completionResult.totalCount,
      })
      setPlayingPage(1)
      setQueueingPage(1)
      setCompletionPage(1)
      setHasMorePlaying(playingResult.hasMore)
      setHasMoreQueueing(queueingResult.hasMore)
      setHasMoreCompletion(completionResult.hasMore)
    } finally {
      if (showLoading) {
        setIsLoading(false)
      }
    }
  }

  // 初始化：加载所有状态的第一页
  useEffect(() => {
    reloadLibraryFirstPages(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 以下 useEffect 已被提取到自定义 hooks 中：
  // - highlightId 自动清除 → useHighlight
  // - toast 自动清除 → useToast

  // 以下代码已被提取到自定义 hooks 中：
  // - 游戏分组和排序 → useGamesGrouping
  // - 搜索逻辑 → useGameSearch

  // Handle search result click
  const handleSearchResultClick = (result: SearchResult) => {
    setMainTab(result.mainTab)
    if (result.type === 'steam-game' && result.status) {
      setActiveTab(result.status)
      // Scroll to the game after a short delay to allow tab switch
      setTimeout(() => {
        setHighlightId(result.id)
        setTimeout(() => setHighlightId(null), 2000)
      }, 100)
    }
  }

  const handleAddGameFromSteam = async (
    name: string,
    steamUrl: string,
    coverImage: string,
    _tags: string[],
    positivePercentage?: number,
    totalReviews?: number,
    releaseDate?: string,
    comingSoon?: boolean,
    isEarlyAccess?: boolean
  ) => {
    // Happy Path: 游戏已存在
    const existing = games.find((g) => g.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      showToast(`"${name}" 已经在队列中！`)
      setHighlightId(existing.id)
      return
    }

    // 从 steamUrl 中提取 appId
    const appId = extractAppIdFromSteamUrl(steamUrl)
    if (!appId) {
      showToast('无效的 Steam URL')
      return
    }

    // 1. 尝试直接使用 app_id 添加到用户库
    const addResult = await userGameService.addUserGame({
      app_id: appId,
      status: 'queueing',
      is_pinned: false,
    })

    let gameId: string
    let userAddedAt: string | undefined
    let userSortOrder = 0

    // 2. 如果游戏不存在数据库，先创建游戏
    if (addResult && 'error' in addResult && addResult.error === 'game_not_found') {
      const createGameParams = toCreateGameRequest({
        appId,
        name,
        steamUrl,
        coverImage,
        type: 'game',
        positivePercentage,
        totalReviews,
        releaseDate,
        comingSoon,
        isEarlyAccess,
      })

      const createdGame = await gameService.createGame(createGameParams)

      // Happy Path: 创建游戏失败
      if (!createdGame) {
        showToast('创建游戏失败')
        return
      }

      // 3. 创建成功后，再添加到用户库
      const addResult2 = await userGameService.addUserGame({
        app_id: appId,
        status: 'queueing',
        is_pinned: false,
      })

      if (!addResult2 || 'error' in addResult2) {
        showToast('添加游戏到库失败')
        return
      }

      gameId = createdGame.id
      userAddedAt = addResult2.added_at ?? addResult2.created_at
      userSortOrder = addResult2.sort_order ?? 0
    } else if (!addResult || 'error' in addResult) {
      // Happy Path: 添加失败
      showToast('添加游戏失败')
      return
    } else {
      gameId = addResult.game_id
      userAddedAt = addResult.added_at ?? addResult.created_at
      userSortOrder = addResult.sort_order ?? 0
    }

    // 4. 获取完整的游戏信息
    const backendGame = await gameService.getGame(gameId)

    // Happy Path: 获取游戏信息失败
    if (!backendGame) {
      showToast('获取游戏信息失败')
      return
    }

    // 更新本地状态
    const newGame: Game = {
      id: backendGame.id,
      name: backendGame.name,
      status: 'queueing',
      isPinned: false,
      sortOrder: userSortOrder,
      addedAt: userAddedAt ?? backendGame.created_at,
      lastUpdated: backendGame.updated_at,
      steamUrl: backendGame.steam_url,
      coverImage: backendGame.capsule_image,
      positivePercentage: positivePercentage,
      totalReviews: totalReviews,
      chinesePositivePercentage: undefined,
      chineseTotalReviews: undefined,
      releaseDate: backendGame.release_date ?? backendGame.release_date_text,
      lastUpdatePublishedAt: backendGame.last_update_published_at,
      comingSoon: comingSoon ?? backendGame.categories?.includes('Coming Soon'),
      isEarlyAccess: isEarlyAccess ?? backendGame.categories?.includes('Early Access'),
      genres: backendGame.genres?.map((name) => ({ id: name, description: name })),
    }

    setGames([newGame, ...games])
    setStatusCounts((prev) => ({ ...prev, queueing: prev.queueing + 1 }))
    showToast(`从 Steam 添加了 "${name}"`)
    setHighlightId(newGame.id)

    // 如果没有好评率或发布日期数据，立即拉取
    const needsAdditionalInfo =
      positivePercentage === undefined ||
      positivePercentage === null ||
      totalReviews === undefined ||
      totalReviews === null ||
      !newGame.releaseDate ||
      isEarlyAccess === undefined ||
      isEarlyAccess === null

    if (!needsAdditionalInfo) {
      return
    }

    // 异步补齐信息，不阻塞添加成功后的 UI 反馈与弹窗关闭
    void (async () => {
      const [reviews, releaseInfo] = await Promise.all([
        steamService.getGameReviews({ appId }),
        steamService.getGameReleaseDate({ appId }),
      ])

      // Happy Path: 获取信息失败或没有新数据
      if (
        !reviews ||
        !releaseInfo ||
        (reviews.positivePercentage === null &&
          reviews.totalReviews === null &&
          releaseInfo.releaseDate === null &&
          releaseInfo.isEarlyAccess === null)
      ) {
        return
      }

      // 更新后端数据库（包括评论数据）
      await gameService.updateGame(newGame.id, {
        positive_percentage: reviews.positivePercentage ?? positivePercentage,
        total_reviews: reviews.totalReviews ?? totalReviews,
        release_date: releaseInfo.releaseDate ?? newGame.releaseDate,
        coming_soon: releaseInfo.comingSoon ?? newGame.comingSoon,
        is_early_access: releaseInfo.isEarlyAccess ?? newGame.isEarlyAccess,
      })

      // 更新本地状态
      setGames((prevGames) =>
        prevGames.map((g) => {
          if (g.id === newGame.id) {
            return {
              ...g,
              positivePercentage: reviews.positivePercentage ?? positivePercentage,
              totalReviews: reviews.totalReviews ?? totalReviews,
              chinesePositivePercentage: reviews.chinesePositivePercentage ?? undefined,
              chineseTotalReviews: reviews.chineseTotalReviews ?? undefined,
              releaseDate: releaseInfo.releaseDate ?? newGame.releaseDate,
              comingSoon: releaseInfo.comingSoon ?? newGame.comingSoon,
              isEarlyAccess: releaseInfo.isEarlyAccess ?? newGame.isEarlyAccess,
              lastUpdated: new Date().toISOString(),
            }
          }
          return g
        })
      )
    })().catch((error) => {
      console.error('补齐 Steam 游戏信息失败:', error)
    })
  }

  const handleUpdateGame = async (id: string, updates: Partial<Game>) => {
    // Happy Path: 游戏不存在
    const game = games.find((g) => g.id === id)
    if (!game) {
      return
    }

    // 只有状态或置顶字段发生变化时才调用更新接口
    if (!updates.status && updates.isPinned === undefined) {
      return
    }

    // 更新用户游戏状态
    const result = await userGameService.updateUserGame(id, {
      status: updates.status,
      is_pinned: updates.isPinned,
    })

    // Happy Path: 更新失败
    if (!result) {
      showToast('更新游戏失败')
      return
    }

    if (updates.status && updates.status !== game.status) {
      setStatusCounts((prev) => ({
        ...prev,
        [game.status]: Math.max(0, prev[game.status] - 1),
        [updates.status!]: prev[updates.status!] + 1,
      }))
    }

    // 更新本地状态
    setGames((prevGames) =>
      prevGames.map((g) =>
        g.id === id
          ? {
              ...g,
              ...(updates.status && { status: updates.status }),
              ...(updates.isPinned !== undefined && { isPinned: updates.isPinned }),
              lastUpdated: new Date().toISOString(),
            }
          : g
      )
    )
  }

  const handleDeleteGame = async (id: string) => {
    // Happy Path: 游戏不存在
    const game = games.find((g) => g.id === id)
    if (!game) {
      return
    }

    // 删除游戏
    const success = await gameService.deleteGame(id)

    // Happy Path: 删除失败
    if (!success) {
      showToast('删除游戏失败')
      return
    }

    // 更新本地状态
    setGames((prevGames) => prevGames.filter((g) => g.id !== id))
    setStatusCounts((prev) => ({
      ...prev,
      [game.status]: Math.max(0, prev[game.status] - 1),
    }))
    showToast(`移除了 "${game.name}"`)
  }

  const handlePinGame = async (id: string) => {
    const game = games.find((g) => g.id === id)
    if (!game) {
      return
    }

    const newPinnedState = !game.isPinned

    // 乐观更新
    setGames((prevGames) =>
      prevGames.map((g) =>
        g.id === id ? { ...g, isPinned: newPinnedState, lastUpdated: new Date().toISOString() } : g
      )
    )

    const result = await userGameService.updateUserGame(id, { is_pinned: newPinnedState })
    if (!result) {
      // 回滚
      setGames((prevGames) =>
        prevGames.map((g) => (g.id === id ? { ...g, isPinned: game.isPinned } : g))
      )
      showToast('操作失败，请重试')
    } else {
      await reloadLibraryFirstPages()
      showToast(newPinnedState ? '已置顶' : '已取消置顶')
    }
  }

  const handleSearch = (term: string) => {
    setSearchTerm(term)
    if (term) {
      const match = games.find((g) => g.name.toLowerCase().includes(term.toLowerCase()))
      if (match) {
        setHighlightId(match.id)
      }
    }
  }

  const handleSettingsClose = async () => {
    await reloadLibraryFirstPages()
  }

  // 加载更多游戏
  const loadMoreGames = useCallback(
    async (status: GameStatus) => {
      // 防止重复加载
      if (isLoadingMore) {
        return
      }

      let currentPage: number
      let setPage: (page: number) => void
      let setHasMore: (hasMore: boolean) => void
      let hasMore: boolean

      if (status === 'playing') {
        currentPage = playingPage
        setPage = setPlayingPage
        setHasMore = setHasMorePlaying
        hasMore = hasMorePlaying
      } else if (status === 'queueing') {
        currentPage = queueingPage
        setPage = setQueueingPage
        setHasMore = setHasMoreQueueing
        hasMore = hasMoreQueueing
      } else {
        currentPage = completionPage
        setPage = setCompletionPage
        setHasMore = setHasMoreCompletion
        hasMore = hasMoreCompletion
      }

      // 如果没有更多数据，不加载
      if (!hasMore) {
        return
      }

      setIsLoadingMore(true)

      try {
        const nextPage = currentPage + 1
        const result = await loadGamesByStatus(status, nextPage)

        setGames((prevGames) => {
          const existingIds = new Set(prevGames.map((g) => g.id))
          const newGames = result.games.filter((g) => !existingIds.has(g.id))
          return [...prevGames, ...newGames]
        })
        setPage(nextPage)
        setHasMore(result.hasMore)
      } catch (error) {
        console.error('加载更多游戏失败:', error)
      } finally {
        setIsLoadingMore(false)
      }
    },
    [
      isLoadingMore,
      playingPage,
      queueingPage,
      completionPage,
      hasMorePlaying,
      hasMoreQueueing,
      hasMoreCompletion,
    ]
  )

  // IntersectionObserver 监听滚动到底部
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoadingMore) {
          loadMoreGames(activeTab)
        }
      },
      { threshold: 0.1 }
    )

    const target = observerTarget.current
    if (target) {
      observer.observe(target)
    }

    return () => {
      if (target) {
        observer.unobserve(target)
      }
    }
  }, [activeTab, isLoadingMore, loadMoreGames])

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1>
          <LogoIcon size={32} className={styles.logoIcon} />
          GameGallery
        </h1>
        <div className={styles.headerActions}>
          <SearchBar
            value={searchTerm}
            onSearch={handleSearch}
            results={searchResults}
            onResultClick={handleSearchResultClick}
          />
          <Suspense fallback={<div />}>
            <Settings onClose={handleSettingsClose} />
          </Suspense>
        </div>
      </header>

      {/* Main Tabs: Games / Playground as peers */}
      <div className={styles.mainTabs}>
        <button
          onClick={() => setMainTab('steamgames')}
          className={classNames(styles.mainTab, {
            [styles.mainTabActive]: mainTab === 'steamgames',
          })}
        >
          <GamesIcon size={18} />
          Games
        </button>
        <button
          onClick={() => setMainTab('playground')}
          className={classNames(styles.mainTab, {
            [styles.mainTabActive]: mainTab === 'playground',
          })}
        >
          <PlaygroundIcon size={18} />
          Playground
        </button>
        <Link to="/server-manager" className={styles.managerLink}>
          服务器管理
        </Link>
      </div>

      {/* Status filters (only when Games tab active) */}
      {mainTab === 'steamgames' && (
        <div className={styles.filterBar}>
          <div className={styles.statusFilters}>
            <button
              data-status="playing"
              onClick={() => setActiveTab('playing')}
              className={classNames(styles.filterBtn, {
                [styles.active]: activeTab === 'playing',
                [styles.activePlaying]: activeTab === 'playing',
              })}
            >
              <Play size={14} />
              <span>Playing</span>
              <span className={styles.filterCount}>{statusCounts.playing}</span>
            </button>
            <button
              data-status="queueing"
              onClick={() => setActiveTab('queueing')}
              className={classNames(styles.filterBtn, {
                [styles.active]: activeTab === 'queueing',
                [styles.activeQueueing]: activeTab === 'queueing',
              })}
            >
              <Bookmark size={14} />
              <span>Queueing</span>
              <span className={styles.filterCount}>{statusCounts.queueing}</span>
            </button>
            <button
              data-status="completion"
              onClick={() => setActiveTab('completion')}
              className={classNames(styles.filterBtn, {
                [styles.active]: activeTab === 'completion',
                [styles.activeCompletion]: activeTab === 'completion',
              })}
            >
              <CheckCircle size={14} />
              <span>Done</span>
              <span className={styles.filterCount}>{statusCounts.completion}</span>
            </button>
          </div>
          <button onClick={() => setShowSteamSearch(true)} className={styles.btnSteam}>
            <Plus size={16} />
            添加
          </button>
        </div>
      )}

      <main>
        {mainTab === 'playground' ? (
          <Suspense
            fallback={
              <div className={styles.loadingContainer}>
                <Loader2 className={`${styles.loaderIcon} animate-spin`} size={32} />
                <div className={styles.mt1}>加载中...</div>
              </div>
            }
          >
            <MiniGames onClose={() => {}} />
          </Suspense>
        ) : isLoading ? (
          <div className={styles.loadingContainer}>
            <Loader2 className={`${styles.loaderIcon} animate-spin`} size={32} />
            <div className={styles.mt1}>加载中...</div>
          </div>
        ) : (
          <div>
            {/* Game List - Masonry Layout */}
            {currentGames.length > 0 ? (
              <>
                <div className={styles.masonry}>
                  {masonryColumns.map((col, colIndex) => (
                    <div key={colIndex} className={styles.masonryColumn}>
                      {col.map((game, indexInCol) => (
                        <motion.div
                          key={game.id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{
                            duration: 0.3,
                            delay: (colIndex + indexInCol * columns) * 0.04,
                          }}
                          className={styles.gameItemWrapper}
                        >
                          <GameItem
                            game={game}
                            onUpdate={handleUpdateGame}
                            onDelete={handleDeleteGame}
                            onPin={handlePinGame}
                            isHighlighted={highlightId === game.id}
                            onShowToast={showToast}
                          />
                        </motion.div>
                      ))}
                    </div>
                  ))}
                </div>
                {/* 加载触发器 */}
                <div ref={observerTarget} className={styles.loadMoreTrigger} />
                {/* 加载状态提示 */}
                {isLoadingMore && (
                  <div className={styles.loadingMore}>
                    <Loader2 className="animate-spin" size={24} />
                    <span>加载中...</span>
                  </div>
                )}
              </>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={styles.emptyState}
              >
                <PackageOpen size={48} strokeWidth={1.5} />
                <p>该状态下暂无游戏</p>
                <button className={styles.emptyStateBtn} onClick={() => setShowSteamSearch(true)}>
                  <Plus size={16} />从 Steam 添加游戏
                </button>
              </motion.div>
            )}
          </div>
        )}
      </main>

      <footer className={styles.footer}>
        <div className={styles.beian}>
          <span>桂ICP备2026002060号</span>
          <span className={styles.separator}>|</span>
          <a
            href="https://beian.mps.gov.cn/#/query/webSearch?code=45010502001153"
            rel="noreferrer"
            target="_blank"
            className={styles.gongan}
          >
            <img src="/beian.png" alt="公安备案" className={styles.beianIcon} />
            桂公网安备45010502001153号
          </a>
        </div>
      </footer>

      {showSteamSearch && (
        <Suspense fallback={<div />}>
          <SteamSearch
            onAddGame={handleAddGameFromSteam}
            onClose={() => setShowSteamSearch(false)}
          />
        </Suspense>
      )}

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className={styles.toast}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default App
