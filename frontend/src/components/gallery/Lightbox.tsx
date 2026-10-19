// Gesture implementation adapted from CookSleep/gpt_image_playground Lightbox.tsx.
// Pinned source and MIT license: docs/PLAYGROUND.md and licenses/Playground-MIT.txt.
import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X, Download } from 'lucide-react';
import { suppressGlobalClicks, useGlobalClickSuppression } from '../../utils/playground/clickSuppression';
import { useModalFocus } from '../../hooks/useModalFocus';
const MIN_SCALE = 1, MAX_SCALE = 10, SWIPE_INTENT_THRESHOLD = 10, SWIPE_ACTION_THRESHOLD = 40, DOUBLE_TAP_DELAY = 350, DOUBLE_TAP_DISTANCE = 40;
const MOUSE_DOUBLE_CLICK_DELAY = 500;
type TouchIntent = 'none' | 'horizontal-swipe' | 'vertical-move' | 'zoom-pan' | 'pinch';
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }
interface Props {src: string; onClose:()=>void; currentIndex:number; total:number; onPrev:()=>void; onNext:()=>void}
export default function Lightbox({src,onClose,currentIndex,total,onPrev,onNext}:Props) {
  const showNav = total > 1;
  useGlobalClickSuppression();
  const {containerRef: focusRef, handleModalKeyDown} = useModalFocus<HTMLDivElement>(onClose);
  const containerRef = useRef<HTMLDivElement>(null)
  const openedAtRef = useRef(Date.now())
  const imageIdentityRef = useRef({ src, currentIndex })
  if (imageIdentityRef.current.src !== src || imageIdentityRef.current.currentIndex !== currentIndex) {
    imageIdentityRef.current = { src, currentIndex }
  }

  // 用 ref 追踪最新变换，避免闭包过期
  const scaleRef = useRef(1)
  const txRef = useRef(0)
  const tyRef = useRef(0)

  // 仅用于触发渲染
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((n) => n + 1), [])

  // 缩放倍率显示：2s 无操作后自动隐藏
  const [showZoomBadge, setShowZoomBadge] = useState(false)
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 拖拽状态
  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    baseTx: 0,
    baseTy: 0,
  })

  // 双指缩放状态
  const pinchRef = useRef({
    active: false,
    startDist: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    midX: 0,
    midY: 0,
  })

  // 双击检测（触控）
  const tapRef = useRef({ time: 0, x: 0, y: 0 })
  const hadMultiTouchRef = useRef(false)
  const touchStartedOnImageRef = useRef(false)
  const touchStartedOnControlRef = useRef(false)
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const touchIntentRef = useRef<TouchIntent>('none')
  const touchMovedRef = useRef(false)
  const swipeHandledRef = useRef(false)
  const doubleTapHandledRef = useRef(false)
  const closeTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 判断本次 mousedown → mouseup 是否发生了拖拽，用于区分点击和拖拽
  const didDragRef = useRef(false)
  const suppressNextClickRef = useRef(false)
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const suppressClick = () => {
      suppressNextClickRef.current = true
    }

    window.addEventListener('image-context-menu-dismiss-lightbox-click', suppressClick)
    return () => window.removeEventListener('image-context-menu-dismiss-lightbox-click', suppressClick)
  }, [])

  const getCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { cx: 0, cy: 0 }
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 }
  }, [])

  const cancelCloseTap = useCallback(() => {
    if (closeTapTimerRef.current !== null) {
      clearTimeout(closeTapTimerRef.current)
      closeTapTimerRef.current = null
    }
  }, [])

  const scheduleCloseTap = useCallback((delay: number, suppressClicks = false) => {
    cancelCloseTap()
    const imageIdentity = imageIdentityRef.current
    const timer = setTimeout(() => {
      if (closeTapTimerRef.current !== timer) return
      closeTapTimerRef.current = null
      if (imageIdentityRef.current !== imageIdentity) return
      if (suppressClicks) suppressGlobalClicks()
      onClose()
    }, delay)
    closeTapTimerRef.current = timer
  }, [cancelCloseTap, onClose])

  // 切换图片会取消旧图的单击关闭；回调也检查身份，避免已排队的计时器关闭新图。
  useEffect(() => {
    cancelCloseTap()
    openedAtRef.current = Date.now()
    tapRef.current = { time: 0, x: 0, y: 0 }
    scaleRef.current = 1
    txRef.current = 0
    tyRef.current = 0
    dragRef.current.active = false
    pinchRef.current.active = false
    didDragRef.current = false
    setShowZoomBadge(false)
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    rerender()
    return cancelCloseTap
  }, [src, currentIndex, rerender, cancelCloseTap])

  const suppressNextClickBriefly = useCallback(() => {
    suppressNextClickRef.current = true
    if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current)
    suppressClickTimerRef.current = setTimeout(() => {
      suppressNextClickRef.current = false
      suppressClickTimerRef.current = null
    }, 350)
  }, [])

  const resetTouchGesture = useCallback(() => {
    touchStartRef.current = null
    touchIntentRef.current = 'none'
    touchMovedRef.current = false
    swipeHandledRef.current = false
    touchStartedOnControlRef.current = false
  }, [])

  const apply = useCallback((s: number, tx: number, ty: number) => {
    cancelCloseTap()
    const ns = clamp(s, MIN_SCALE, MAX_SCALE)
    scaleRef.current = ns
    txRef.current = ns <= 1 ? 0 : tx
    tyRef.current = ns <= 1 ? 0 : ty

    // 显示缩放倍率并重置自动隐藏计时器
    if (ns > 1) {
      setShowZoomBadge(true)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
      zoomTimerRef.current = setTimeout(() => setShowZoomBadge(false), 1500)
    } else {
      setShowZoomBadge(false)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    }

    rerender()
  }, [rerender, cancelCloseTap])

  // ====== 滚轮缩放 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const s = scaleRef.current
      const tx = txRef.current
      const ty = tyRef.current
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2

      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      const r = ns / s
      apply(ns, mx - r * (mx - tx), my - r * (my - ty))
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [apply])

  // ====== 鼠标拖拽 + 点击关闭 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (e.detail > 1) cancelCloseTap()
      didDragRef.current = false
      if (scaleRef.current <= 1) return
      e.preventDefault()
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        baseTx: txRef.current,
        baseTy: tyRef.current,
      }
    }

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d.active) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true
      apply(scaleRef.current, d.baseTx + dx, d.baseTy + dy)
    }

    const onUp = () => {
      dragRef.current.active = false
    }

    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [apply, cancelCloseTap])

  // ====== 单击关闭（仅未缩放且非拖拽） ======
  const onClick = useCallback((e: React.MouseEvent) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      e.stopPropagation()
      return
    }
    if (didDragRef.current) return
    if (e.target instanceof HTMLImageElement) {
      if (e.detail > 1) { cancelCloseTap(); return }
      if (scaleRef.current <= 1) scheduleCloseTap(MOUSE_DOUBLE_CLICK_DELAY)
    } else {
      cancelCloseTap()
      onClose()
    }
  }, [onClose, cancelCloseTap, scheduleCloseTap])

  // ====== 鼠标双击缩放 ======
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    cancelCloseTap()
    if (Date.now() - openedAtRef.current < DOUBLE_TAP_DELAY) return
    if (scaleRef.current > 1) {
      apply(1, 0, 0)
    } else {
      const { cx, cy } = getCenter()
      const mx = e.clientX - cx
      const my = e.clientY - cy
      apply(3, -mx * 2, -my * 2)
    }
  }, [apply, getCenter, cancelCloseTap])

  // ====== 触控事件 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        cancelCloseTap()
        resetTouchGesture()
        hadMultiTouchRef.current = true
        touchIntentRef.current = 'pinch'
        tapRef.current = { time: 0, x: 0, y: 0 }
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const { cx, cy } = getCenter()
        pinchRef.current = {
          active: true,
          startDist: dist,
          startScale: scaleRef.current,
          startTx: txRef.current,
          startTy: tyRef.current,
          midX: (a.clientX + b.clientX) / 2 - cx,
          midY: (a.clientY + b.clientY) / 2 - cy,
        }
        dragRef.current.active = false
      } else if (e.touches.length === 1) {
        const t = e.touches[0]
        const now = Date.now()
        const prev = tapRef.current
        touchStartedOnImageRef.current = e.target instanceof HTMLImageElement
        touchStartedOnControlRef.current = e.target instanceof Element && Boolean(e.target.closest('button'))
        touchStartRef.current = { x: t.clientX, y: t.clientY, time: now }
        touchIntentRef.current = 'none'
        touchMovedRef.current = false
        swipeHandledRef.current = false

        // 双击检测
        if (
          touchStartedOnImageRef.current &&
          now - prev.time < DOUBLE_TAP_DELAY &&
          Math.abs(t.clientX - prev.x) < DOUBLE_TAP_DISTANCE &&
          Math.abs(t.clientY - prev.y) < DOUBLE_TAP_DISTANCE
        ) {
          e.preventDefault()
          cancelCloseTap()
          suppressNextClickBriefly()
          doubleTapHandledRef.current = true
          if (scaleRef.current > 1) {
            apply(1, 0, 0)
          } else {
            const { cx, cy } = getCenter()
            const mx = t.clientX - cx
            const my = t.clientY - cy
            apply(3, -mx * 2, -my * 2)
          }
          tapRef.current = { time: 0, x: 0, y: 0 }
          resetTouchGesture()
          return
        }
        tapRef.current = { time: now, x: t.clientX, y: t.clientY }

        if (scaleRef.current > 1 && touchStartedOnImageRef.current) {
          e.preventDefault()
          dragRef.current = {
            active: true,
            startX: t.clientX,
            startY: t.clientY,
            baseTx: txRef.current,
            baseTy: tyRef.current,
          }
        }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (pinchRef.current.active && e.touches.length === 2) {
        e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const p = pinchRef.current
        const ns = clamp(p.startScale * (dist / p.startDist), MIN_SCALE, MAX_SCALE)
        const r = ns / p.startScale
        apply(ns, p.midX - r * (p.midX - p.startTx), p.midY - r * (p.midY - p.startTy))
      } else if (dragRef.current.active && e.touches.length === 1) {
        e.preventDefault()
        const t = e.touches[0]
        const d = dragRef.current
        const dx = t.clientX - d.startX
        const dy = t.clientY - d.startY
        if (Math.abs(dx) > SWIPE_INTENT_THRESHOLD || Math.abs(dy) > SWIPE_INTENT_THRESHOLD) {
          touchMovedRef.current = true
          touchIntentRef.current = 'zoom-pan'
        }
        apply(scaleRef.current, d.baseTx + dx, d.baseTy + dy)
      } else if (scaleRef.current <= 1 && e.touches.length === 1 && touchStartRef.current) {
        const t = e.touches[0]
        const dx = t.clientX - touchStartRef.current.x
        const dy = t.clientY - touchStartRef.current.y
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)

        if (absX > SWIPE_INTENT_THRESHOLD || absY > SWIPE_INTENT_THRESHOLD) {
          touchMovedRef.current = true
        }
        if (touchIntentRef.current === 'none' && (absX > SWIPE_INTENT_THRESHOLD || absY > SWIPE_INTENT_THRESHOLD)) {
          touchIntentRef.current = absX > absY ? 'horizontal-swipe' : 'vertical-move'
          if (touchIntentRef.current === 'horizontal-swipe') cancelCloseTap()
        }
        if (touchIntentRef.current === 'horizontal-swipe') {
          e.preventDefault()
        }
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current.active = false
      if (e.touches.length === 0) {
        dragRef.current.active = false
        if (hadMultiTouchRef.current) {
          hadMultiTouchRef.current = false
          tapRef.current = { time: 0, x: 0, y: 0 }
          resetTouchGesture()
          return
        }

        if (doubleTapHandledRef.current) {
          doubleTapHandledRef.current = false
          resetTouchGesture()
          return
        }

        const start = touchStartRef.current
        const changed = e.changedTouches[0]
        const dx = start && changed ? changed.clientX - start.x : 0
        const intent = touchIntentRef.current
        const moved = touchMovedRef.current

        if (intent === 'horizontal-swipe' && scaleRef.current <= 1) {
          cancelCloseTap()
          suppressNextClickBriefly()
          swipeHandledRef.current = Math.abs(dx) >= SWIPE_ACTION_THRESHOLD
          tapRef.current = { time: 0, x: 0, y: 0 }
          e.preventDefault()
          if (swipeHandledRef.current) {
            if (dx < 0 && showNav) onNext()
            if (dx > 0 && showNav) onPrev()
          }
          resetTouchGesture()
          return
        }

        if (moved || intent === 'vertical-move' || intent === 'zoom-pan') {
          suppressNextClickBriefly()
          tapRef.current = { time: 0, x: 0, y: 0 }
          resetTouchGesture()
          return
        }

        // 触摸设备会在 touchend 后补发 click，这里接管点按，避免首个点按关闭导致双击缩放失效。
        suppressNextClickBriefly()

        // 单击关闭：未缩放时图片也可点按关闭；图片上的关闭延迟到双击窗口后，避免破坏双击缩放。
        if (touchStartedOnControlRef.current) {
          resetTouchGesture()
          return
        }
        if (scaleRef.current <= 1 && touchStartedOnImageRef.current) {
          scheduleCloseTap(DOUBLE_TAP_DELAY, true)
        } else if (!touchStartedOnImageRef.current) {
          cancelCloseTap()
          suppressGlobalClicks()
          if (e.cancelable) e.preventDefault()
          onClose()
        }
        resetTouchGesture()
      }
    }

    const onTouchCancel = () => {
      cancelCloseTap()
      tapRef.current = { time: 0, x: 0, y: 0 }
      hadMultiTouchRef.current = false
      doubleTapHandledRef.current = false
      pinchRef.current.active = false
      dragRef.current.active = false
      resetTouchGesture()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchCancel)
    return () => {
      cancelCloseTap()
      if (suppressClickTimerRef.current) {
        clearTimeout(suppressClickTimerRef.current)
        suppressClickTimerRef.current = null
      }
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [apply, cancelCloseTap, getCenter, onClose, onNext, onPrev, resetTouchGesture, scheduleCloseTap, showNav, suppressNextClickBriefly])

  const s = scaleRef.current
  const tx = txRef.current
  const ty = tyRef.current
  const isZoomed = s > 1
  const isDragging = dragRef.current.active || pinchRef.current.active
  const zoomPercent = Math.round(s * 100)

  useEffect(() => () => { if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current); }, []);
  return createPortal(<div className="pg-lightbox" ref={focusRef} role="dialog" aria-modal="true" aria-label="图片大图" tabIndex={-1} onKeyDown={event => { if (event.key === 'ArrowLeft') onPrev(); else if (event.key === 'ArrowRight') onNext(); else handleModalKeyDown(event); }}>
    <div ref={containerRef} className="pg-lightbox-surface" onClick={onClick} onDoubleClick={onDoubleClick} style={{cursor:isZoomed?(isDragging?'grabbing':'grab'):'zoom-in'}}>
      <img src={src} alt="生成图片原图" style={{transform:`translate(${tx}px, ${ty}px) scale(${s})`,transition:isDragging?'none':'transform .15s ease-out'}} />
    </div>
    <div className="pg-lightbox-tools"><span>{currentIndex+1} / {total} {showZoomBadge ? `· ${zoomPercent}%` : ''}</span><button onClick={()=>apply(1,0,0)}>适应窗口</button><a href={src} download><Download size={19}/>下载原图</a><button aria-label="关闭大图" onClick={onClose}><X/></button></div>
    {showNav && <><button className="pg-lightbox-prev" aria-label="上一张" onClick={onPrev}><ChevronLeft/></button><button className="pg-lightbox-next" aria-label="下一张" onClick={onNext}><ChevronRight/></button></>}
  </div>,document.body);
}
