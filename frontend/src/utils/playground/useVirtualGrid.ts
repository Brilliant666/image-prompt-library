import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { getVisibleRange, type GridMetrics } from './virtualGrid'

// 首次测量前按单列、卡片默认高度估算，挂载后在绘制前就会用实际测量值修正
const INITIAL_METRICS: GridMetrics = { columns: 1, rowHeight: 162, rowGap: 16, columnGap: 16, width: 0 }

/**
 * 固定行高网格虚拟列表：只渲染滚动容器或窗口视口及上下各一屏内的行，其余用上下 padding 撑开。
 * 列数、行高、间距都从实际渲染的网格读取，响应式断点只由 CSS 决定。
 */
export function useVirtualGrid(gridRef: RefObject<HTMLElement | null>, count: number, scrollRef?: RefObject<HTMLElement | null>) {
  const metricsRef = useRef(INITIAL_METRICS)
  // 视口顶部所在行的首个下标及视口顶部相对该行的偏移，列数或行高变化时据此保持阅读位置
  const anchorRef = useRef<{ index: number; offset: number } | null>(null)
  const pendingScrollRef = useRef<number | null>(null)
  const countRef = useRef(count)
  countRef.current = count
  const [range, setRange] = useState(() => {
    const height = scrollRef?.current?.clientHeight ?? window.innerHeight
    return getVisibleRange(count, INITIAL_METRICS, 0, height, height)
  })

  const update = useCallback(() => {
    const grid = gridRef.current
    const scroller = scrollRef?.current
    if (!grid || (scrollRef && !scroller) || grid.getClientRects().length === 0) return
    const m = metricsRef.current
    const vh = scroller ? scroller.clientHeight : window.innerHeight
    const viewportTop = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0
    const viewTop = pendingScrollRef.current ?? viewportTop - grid.getBoundingClientRect().top
    const stride = m.rowHeight + m.rowGap
    const row = Math.floor(viewTop / stride)
    anchorRef.current = viewTop > 0 ? { index: row * m.columns, offset: viewTop - row * stride } : null
    const next = getVisibleRange(countRef.current, m, viewTop, viewTop + vh, vh)
    setRange((prev) => pendingScrollRef.current === null && prev.startIndex === next.startIndex && prev.endIndex === next.endIndex
      && prev.paddingTop === next.paddingTop && prev.paddingBottom === next.paddingBottom ? prev : next)
  }, [gridRef, scrollRef])

  const measure = useCallback(() => {
    const grid = gridRef.current
    const scroller = scrollRef?.current
    if (!grid || (scrollRef && !scroller) || grid.getClientRects().length === 0) return
    const style = getComputedStyle(grid)
    const prev = metricsRef.current
    const next = {
      columns: style.gridTemplateColumns.split(' ').length,
      rowHeight: grid.firstElementChild?.getBoundingClientRect().height || prev.rowHeight,
      rowGap: parseFloat(style.rowGap) || 0,
      columnGap: parseFloat(style.columnGap) || 0,
      width: grid.clientWidth,
    }
    metricsRef.current = next
    const anchor = anchorRef.current
    if (anchor && (next.columns !== prev.columns || next.rowHeight !== prev.rowHeight || next.rowGap !== prev.rowGap)) {
      // 让原先位于视口顶部的那一行在新布局下仍停在视口顶部附近
      pendingScrollRef.current = Math.floor(anchor.index / next.columns) * (next.rowHeight + next.rowGap) + anchor.offset
    }
    update()
  }, [gridRef, scrollRef, update])

  const hasItems = count > 0
  useLayoutEffect(() => {
    const grid = gridRef.current
    const scroller = scrollRef?.current
    if (!hasItems || !grid || (scrollRef && !scroller)) return
    measure()
    // Composer 高度变化只会缩小滚动容器，因此网格和容器都需要观察。
    // hidden 切换保留滚动位置与锚点；再次可见时由尺寸观察重新测量。
    const ro = new ResizeObserver(measure)
    ro.observe(grid)
    if (scroller) ro.observe(scroller)
    const scrollTarget = scroller || window
    scrollTarget.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      // 列表清空期间布局可能变化，旧锚点不再可信，恢复时不应据此滚动
      anchorRef.current = null
      pendingScrollRef.current = null
      scrollTarget.removeEventListener('scroll', update)
      window.removeEventListener('resize', measure)
    }
  }, [gridRef, scrollRef, hasItems, measure, update])

  useLayoutEffect(() => update(), [count, update])

  useLayoutEffect(() => {
    const target = pendingScrollRef.current
    const grid = gridRef.current
    const scroller = scrollRef?.current
    if (target === null || !grid || (scrollRef && !scroller) || grid.getClientRects().length === 0) return
    // 新 padding 已提交后再滚动，否则靠近列表底部时会被旧 scrollHeight 截断。
    pendingScrollRef.current = null
    const viewportTop = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0
    const delta = target + grid.getBoundingClientRect().top - viewportTop
    if (scroller) scroller.scrollTop += delta
    else window.scrollBy(0, delta)
    update()
  }, [range, gridRef, scrollRef, update])

  return { ...range, metricsRef }
}
