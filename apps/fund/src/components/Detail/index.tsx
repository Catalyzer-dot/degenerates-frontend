import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import classNames from 'classnames'
import {
  addWatchlist,
  fetchGz,
  fetchQuotes,
  getSessionToken,
  loadDaily,
  loadHoldings,
  loadMeta,
  loadWatchlist,
} from '@services/api'
import type { DailyData, FundMeta, GzData, HoldingsData, QuoteRow } from '@/types'
import { isAfterClose, isTradeMinute, num, pct, pctClass } from '@/utils/format'
import shared from '@/styles/shared.module.scss'
import styles from './index.module.scss'

interface Props {
  code: string
}

function sortDailyRowsDesc(rows: DailyData['rows'] | undefined): DailyData['rows'] {
  return [...(rows || [])].sort((a, b) => b.date.localeCompare(a.date))
}

function toNumber(value: string | null | undefined): number | null {
  if (!value) return null
  const numValue = Number(value)
  return Number.isFinite(numValue) ? numValue : null
}

function getTodayDateString(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isTodayDate(value: string | null | undefined): boolean {
  return !!value && value.slice(0, 10) === getTodayDateString()
}

function deriveDailyChange(latestValue: string, previousValue: string, fallback: string): string {
  if (fallback) {
    return fallback
  }

  const latest = toNumber(latestValue)
  const previous = toNumber(previousValue)
  if (latest == null || previous == null || previous === 0) {
    return ''
  }

  return (((latest - previous) / previous) * 100).toFixed(2)
}

function mergeDailyRows(current: DailyData | null, incoming: DailyData | null): DailyData | null {
  if (!incoming?.rows.length) {
    return current
  }

  const rowsByDate = new Map<string, DailyData['rows'][number]>()
  ;(current?.rows || []).forEach((row) => rowsByDate.set(row.date, row))
  incoming.rows.forEach((row) => rowsByDate.set(row.date, row))

  return {
    rows: sortDailyRowsDesc(Array.from(rowsByDate.values())),
  }
}

interface DailyChartPoint {
  date: string
  value: number
  change: string
}

function formatShortDate(date: string): string {
  const parts = date.split('-')
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : date
}

function buildDailyChartPoints(rows: DailyData['rows']): DailyChartPoint[] {
  return rows
    .map((row, index) => {
      const previous = rows[index - 1]
      const change = deriveDailyChange(row.dwjz, previous?.dwjz || '', row.jzzzl)
      return {
        date: row.date,
        value: Number(row.dwjz),
        change,
      }
    })
    .filter((point) => Number.isFinite(point.value))
}

function pickDateTicks(points: DailyChartPoint[]): DailyChartPoint[] {
  if (points.length <= 6) return points

  const indexes = new Set<number>()
  const maxIndex = points.length - 1
  for (let i = 0; i < 5; i += 1) {
    indexes.add(Math.round((maxIndex * i) / 4))
  }

  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => points[index])
}

function DailyNavChart({ points }: { points: DailyChartPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [tooltipLeftPx, setTooltipLeftPx] = useState<number | null>(null)
  const width = 800
  const height = 190
  const padX = 38
  const padTop = 16
  const padBottom = 34
  const plotWidth = width - padX * 2
  const plotHeight = height - padTop - padBottom

  if (points.length < 2) {
    return <div className={styles.empty}>暂无历史净值数据</div>
  }

  const values = points.map((point) => point.value)
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    min -= 0.01
    max += 0.01
  }
  const padding = (max - min) * 0.08
  min -= padding
  max += padding

  const xForIndex = (index: number) => padX + (plotWidth * index) / (points.length - 1)
  const yForValue = (value: number) => padTop + ((max - value) / (max - min)) * plotHeight
  const line = points
    .map(
      (point, index) => `${index === 0 ? 'M' : 'L'}${xForIndex(index)},${yForValue(point.value)}`
    )
    .join(' ')
  const area = `${line} L${xForIndex(points.length - 1)},${height - padBottom} L${padX},${height - padBottom} Z`
  const ticks = pickDateTicks(points)
  const activeIndex = hoverIndex ?? points.length - 1
  const active = points[activeIndex]
  const activeX = xForIndex(activeIndex)
  const activeY = yForValue(active.value)
  const tooltipLeft =
    tooltipLeftPx == null
      ? `${Math.min(Math.max((activeX / width) * 100, 12), 88)}%`
      : `${tooltipLeftPx}px`

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = Math.min(rect.width / width, rect.height / height)
    const renderedWidth = width * scale
    const offsetX = (rect.width - renderedWidth) / 2
    const svgX = (event.clientX - rect.left - offsetX) / scale
    const nextIndex = Math.round(((svgX - padX) / plotWidth) * (points.length - 1))
    const clampedIndex = Math.max(0, Math.min(points.length - 1, nextIndex))
    setHoverIndex(clampedIndex)

    const nextActiveX = xForIndex(clampedIndex)
    const left = offsetX + nextActiveX * scale
    setTooltipLeftPx(Math.min(Math.max(left, 72), rect.width - 72))
  }

  return (
    <div className={styles.navChart}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="近30天净值走势图"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => {
          setHoverIndex(null)
          setTooltipLeftPx(null)
        }}
      >
        <path d={area} className={styles.navChartArea} />
        <line
          x1={padX}
          x2={width - padX}
          y1={height - padBottom}
          y2={height - padBottom}
          className={styles.navChartAxis}
        />
        {ticks.map((tick) => {
          const index = points.findIndex((point) => point.date === tick.date)
          const x = xForIndex(index)
          return (
            <g key={tick.date}>
              <line
                x1={x}
                x2={x}
                y1={height - padBottom}
                y2={height - padBottom + 4}
                className={styles.navChartTick}
              />
              <text x={x} y={height - 10} textAnchor="middle" className={styles.navChartLabel}>
                {formatShortDate(tick.date)}
              </text>
            </g>
          )
        })}
        <path d={line} className={styles.navChartLine} />
        <line
          x1={activeX}
          x2={activeX}
          y1={padTop}
          y2={height - padBottom}
          className={styles.navChartHoverLine}
        />
        <circle cx={activeX} cy={activeY} r="4" className={styles.navChartPoint} />
      </svg>
      <div className={styles.navChartTooltip} style={{ left: tooltipLeft }}>
        <span>{active.date}</span>
        <strong>净值 {active.value.toFixed(4)}</strong>
        <em className={pctClass(active.change)}>{pct(active.change)}</em>
      </div>
    </div>
  )
}

export default function Detail({ code }: Props) {
  const [meta, setMeta] = useState<FundMeta | null>(null)
  const [gz, setGz] = useState<GzData | null>(null)
  const [holdings, setHoldings] = useState<HoldingsData | null>(null)
  const [holdingQuotes, setHoldingQuotes] = useState<QuoteRow[]>([])
  const [daily, setDaily] = useState<DailyData | null>(null)
  const [fundName, setFundName] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [quoteRefreshing, setQuoteRefreshing] = useState(false)
  const [isTracked, setIsTracked] = useState(false)
  const [isAdding, setIsAdding] = useState(false)

  const holdingsRef = useRef<HoldingsData | null>(null)
  const loadRequestRef = useRef(0)

  useEffect(() => {
    holdingsRef.current = holdings
  }, [holdings])

  useEffect(() => {
    void initialLoad()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshHoldingQuotes()
      void refreshLatestDaily()
      void refreshGz()
    }, 30000)

    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  async function initialLoad() {
    const requestId = loadRequestRef.current + 1
    loadRequestRef.current = requestId

    setLoading(true)
    setLoadError('')
    setFundName(code)
    setMeta(null)
    setGz(null)
    setHoldings(null)
    setHoldingQuotes([])
    setDaily(null)

    try {
      const [metaData, holdingsData, dailyData, watchlist, gzData] = await Promise.all([
        loadMeta(code),
        loadHoldings(code),
        loadDaily(code, 60),
        loadWatchlist().catch(() => []),
        fetchGz(code),
      ])
      if (loadRequestRef.current !== requestId) return

      setMeta(metaData)
      setGz(gzData)
      setHoldings(holdingsData)
      setDaily(dailyData)

      const watch = (watchlist || []).find((item) => item.code === code)
      setFundName(watch?.name || metaData?.name || code)
      setIsTracked(!!watch)

      const holdingSecids = holdingsData?.rows.map((row) => row.secid).filter(Boolean) || []
      const nextHoldingQuotes = holdingSecids.length ? await fetchQuotes(holdingSecids) : []
      if (loadRequestRef.current !== requestId) return
      setHoldingQuotes(nextHoldingQuotes)

      if (!metaData && !holdingsData && !dailyData) {
        setLoadError('Fund data is temporarily unavailable. Please try again later.')
      }
    } catch (error) {
      if (loadRequestRef.current !== requestId) return
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false)
      }
    }
  }

  async function refreshLatestDaily() {
    const latestDaily = await loadDaily(code, 2)
    if (!latestDaily?.rows.length) return
    setDaily((prev) => mergeDailyRows(prev, latestDaily))
  }

  async function refreshGz() {
    const gzData = await fetchGz(code)
    if (gzData) setGz(gzData)
  }

  async function refreshHoldingQuotes() {
    const currentHoldings = holdingsRef.current
    if (!currentHoldings?.rows.length) return

    const secids = currentHoldings.rows.map((row) => row.secid).filter(Boolean)
    if (!secids.length) return

    setHoldingQuotes(await fetchQuotes(secids))
  }

  async function handleTrack() {
    if (isAdding || isTracked) return
    setIsAdding(true)
    try {
      await addWatchlist(code, fundName)
      setIsTracked(true)
    } finally {
      setIsAdding(false)
    }
  }

  async function manualRefreshQuotes() {
    setQuoteRefreshing(true)
    try {
      await Promise.all([refreshHoldingQuotes(), refreshLatestDaily(), refreshGz()])
    } finally {
      setQuoteRefreshing(false)
    }
  }

  const latestDailyRows = useMemo(() => sortDailyRowsDesc(daily?.rows), [daily])
  const dailyValues = useMemo(() => [...latestDailyRows].slice(0, 30).reverse(), [latestDailyRows])
  const dailyChartPoints = useMemo(() => buildDailyChartPoints(dailyValues), [dailyValues])
  const dailyReturn = useMemo(() => {
    if (dailyChartPoints.length < 2) return null
    const first = dailyChartPoints[0].value
    const last = dailyChartPoints[dailyChartPoints.length - 1].value
    if (!first) return null
    return ((last - first) / first) * 100
  }, [dailyChartPoints])

  const holdingsBySecid = useMemo(() => {
    const map = new Map<string, QuoteRow>()
    holdingQuotes.forEach((quote) => map.set(quote.secid, quote))
    return map
  }, [holdingQuotes])

  return (
    <div className={shared.page}>
      <header className={shared.header}>
        <h1>
          <a
            className={shared.back}
            href="#"
            onClick={(e) => {
              e.preventDefault()
              window.history.back()
            }}
          >
            返回
          </a>
          <span>{fundName}</span>
        </h1>
        <div className={shared.meta}>
          <span className="muted">{code}</span>
          <a
            href={`https://fund.eastmoney.com/${code}.html`}
            target="_blank"
            rel="noopener noreferrer"
          >
            天天基金
          </a>
          {getSessionToken() && (
            <button
              type="button"
              className={shared.ghostBtn}
              onClick={handleTrack}
              disabled={isTracked || isAdding}
            >
              {isTracked ? '已追踪' : isAdding ? '追踪中...' : '+ 追踪'}
            </button>
          )}
        </div>
      </header>

      <main className={shared.main}>
        {loading && <div className={shared.statusBox}>加载基金数据中...</div>}
        {loadError && <div className={shared.errorBox}>{loadError}</div>}

        <section className={shared.card}>
          <div className={shared.cardHead}>
            <h2>近 30 天净值</h2>
            {dailyChartPoints.length && dailyReturn != null && (
              <span className="muted small">
                {dailyChartPoints.length} 个交易日，累计{' '}
                <span className={pctClass(dailyReturn)}>
                  {dailyReturn >= 0 ? '+' : ''}
                  {dailyReturn.toFixed(2)}%
                </span>
              </span>
            )}
          </div>
          {dailyChartPoints.length >= 2 ? (
            <DailyNavChart points={dailyChartPoints} />
          ) : (
            <div className={styles.empty}>暂无历史净值数据</div>
          )}
        </section>

        <section className={shared.card}>
          <div className={styles.metaGrid}>
            {(() => {
              const today = new Date()
              const isWeekday = today.getDay() >= 1 && today.getDay() <= 5
              const todayStr = getTodayDateString()
              const todayNav = latestDailyRows[0]?.date === todayStr ? latestDailyRows[0] : null
              const latestNav = latestDailyRows[0] ?? null
              const hasTodayEstimate = !!gz?.gsz && isTodayDate(gz?.gztime)

              // 交易日：优先展示今日净值，其次展示今日估值；否则回退到最新净值
              if (isWeekday) {
                if (todayNav?.dwjz) {
                  return (
                    <div>
                      <label>净值</label>
                      <span>
                        {todayNav.dwjz}
                        {todayNav.jzzzl && (
                          <span className={pctClass(todayNav.jzzzl)}> {pct(todayNav.jzzzl)}</span>
                        )}
                      </span>
                      <span className="metaDate">{todayNav.date}</span>
                    </div>
                  )
                }
                if (hasTodayEstimate) {
                  return (
                    <div>
                      <label>当前估值</label>
                      <span>
                        {gz.gsz}
                        {gz.gszzl && <span className={pctClass(gz.gszzl)}> {pct(gz.gszzl)}</span>}
                      </span>
                      <span className="metaDate">{gz.gztime}</span>
                    </div>
                  )
                }
                return (
                  <div>
                    <label>净值</label>
                    <span>
                      {latestNav?.dwjz ? (
                        <>
                          {latestNav.dwjz}
                          {latestNav.jzzzl && (
                            <span className={pctClass(latestNav.jzzzl)}>
                              {' '}
                              {pct(latestNav.jzzzl)}
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                    {latestNav?.date && <span className="metaDate">{latestNav.date}</span>}
                  </div>
                )
              }
              return (
                <div>
                  <label>净值</label>
                  <span>
                    {latestNav?.dwjz ? (
                      <>
                        {latestNav.dwjz}
                        {latestNav.jzzzl && (
                          <span className={pctClass(latestNav.jzzzl)}> {pct(latestNav.jzzzl)}</span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                  {latestNav?.date && <span className="metaDate">{latestNav.date}</span>}
                </div>
              )
            })()}
            <div>
              <label>规模</label>
              <span>
                {meta?.scale ? `${meta.scale} 亿` : '-'}
                {meta?.scale_date && <span className="muted small"> ({meta.scale_date})</span>}
              </span>
            </div>
            <div>
              <label>经理</label>
              <span>{meta?.manager || '-'}</span>
            </div>
            <div>
              <label>近 1 年</label>
              <span className={pctClass(meta?.r_1y)}>{meta?.r_1y ? `${meta.r_1y}%` : '-'}</span>
            </div>
          </div>
        </section>

        <section className={shared.card}>
          <div className={shared.cardHead}>
            <h2>
              十大持仓
              {holdings?.report_date && (
                <span className="muted small"> 截止 {holdings.report_date}</span>
              )}
            </h2>
            <button
              type="button"
              className={shared.ghostBtn}
              onClick={manualRefreshQuotes}
              disabled={quoteRefreshing}
            >
              {quoteRefreshing ? '刷新中...' : '刷新'}
            </button>
          </div>
          {!holdings?.rows.length ? (
            <div className={styles.empty}>暂无持仓数据</div>
          ) : (
            <div className={shared.tableScroll}>
              <table className={shared.dataTable}>
                <thead>
                  <tr>
                    <th>代码</th>
                    <th>名称</th>
                    <th className="num">占比</th>
                    <th className="num">现价</th>
                    <th className="num">昨收涨跌</th>
                    <th className="num">涨跌</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.rows.map((row) => {
                    const quote = holdingsBySecid.get(row.secid)
                    return (
                      <tr key={row.code} className={styles.noHover}>
                        <td>{row.code}</td>
                        <td>{row.name}</td>
                        <td className="num">{row.ratio.toFixed(2)}%</td>
                        <td className="num">{num(quote?.price)}</td>
                        <td className={classNames('num', pctClass(quote?.prev_chg))}>
                          {pct(quote?.prev_chg)}
                        </td>
                        <td className="num">
                          {quote?.chg != null ? (
                            <span className={styles.chgGroup}>
                              <span className={pctClass(quote?.chg)}>{pct(quote?.chg)}</span>
                              {quote != null && (
                                <span
                                  className={classNames(
                                    styles.chgTag,
                                    isTradeMinute() ? styles.liveTag : styles.closeTag
                                  )}
                                >
                                  {isTradeMinute() ? '实时' : isAfterClose() ? '收盘' : '最新'}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <footer className={shared.footer}>数据：公开行情，仅供参考，不构成投资建议。</footer>
    </div>
  )
}
