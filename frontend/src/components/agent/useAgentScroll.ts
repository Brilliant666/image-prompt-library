import { useCallback, useEffect, useRef, type RefObject } from 'react';

const BOTTOM_TOLERANCE = 4;
type ScrollState = { following: boolean };

// Keep the user's intent across layout changes. Measuring "near bottom" only
// after new text/images render loses that intent as soon as the content grows.
export function createAgentScrollController(container: HTMLElement, content: HTMLElement, state: ScrollState) {
  let disposed = false;
  let frame: number | null = null;
  let smooth = false;
  let previousTop = container.scrollTop;
  let touchY: number | null = null;
  const atBottom = () => container.scrollHeight - container.clientHeight - container.scrollTop <= BOTTOM_TOLERANCE;
  const cancelFrame = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
  const stopSmooth = () => {
    if (smooth) container.scrollTo({ top: container.scrollTop, behavior: 'instant' });
    smooth = false;
  };
  const pause = () => { state.following = false; cancelFrame(); stopSmooth(); };
  const align = (behavior: ScrollBehavior = 'instant') => {
    if (disposed || !state.following) return;
    smooth = behavior === 'smooth';
    container.scrollTo({ top: container.scrollHeight, behavior });
    previousTop = container.scrollTop;
  };
  const layoutChanged = () => {
    if (disposed || !state.following || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; align(); });
  };
  const onScroll = () => {
    if (atBottom()) { state.following = true; smooth = false; }
    else if (!smooth && container.scrollTop < previousTop - 1) state.following = false;
    previousTop = container.scrollTop;
  };
  const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
  const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
  const onTouchMove = (event: TouchEvent) => {
    const next = event.touches[0]?.clientY;
    if (next !== undefined && touchY !== null && next > touchY) pause();
    touchY = next ?? null;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) pause();
  };
  // A pointer drag of the scrollbar interrupts a smooth jump; its subsequent
  // scroll event can then distinguish upward browsing from following the tail.
  const onPointerDown = () => stopSmooth();
  container.addEventListener('scroll', onScroll, { passive: true });
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: true });
  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('pointerdown', onPointerDown);
  content.addEventListener('load', layoutChanged, true);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(layoutChanged);
  observer?.observe(content);
  observer?.observe(container);
  window.addEventListener('resize', layoutChanged);

  return {
    layoutChanged,
    scrollToBottom(behavior: ScrollBehavior = 'smooth') {
      if (disposed) return;
      state.following = true;
      cancelFrame();
      align(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : behavior);
    },
    focusRound(id: string, done: () => void) {
      pause();
      frame = requestAnimationFrame(() => {
        frame = null;
        if (disposed) return;
        const target = Array.from(content.querySelectorAll<HTMLElement>('[data-agent-round]')).find(node => node.dataset.agentRound === id);
        if (target) { target.scrollIntoView({ block: 'center', behavior: 'instant' }); previousTop = container.scrollTop; done(); }
      });
    },
    dispose() {
      disposed = true;
      cancelFrame();
      stopSmooth();
      observer?.disconnect();
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('pointerdown', onPointerDown);
      content.removeEventListener('load', layoutChanged, true);
      window.removeEventListener('resize', layoutChanged);
    },
  };
}

export function useAgentScroll({ containerRef, contentRef, active, conversationId, ready, revision, focusRoundId, onFocusResolved }: {
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  active: boolean;
  conversationId: string | null;
  ready: boolean;
  revision?: number;
  focusRoundId?: string;
  onFocusResolved: () => void;
}) {
  const saved = useRef<{ conversationId: string | null; state: ScrollState }>({ conversationId, state: { following: true } });
  const controller = useRef<ReturnType<typeof createAgentScrollController> | null>(null);
  const focusResolved = useRef(onFocusResolved);
  const focusOwner = useRef({ conversationId, id: focusRoundId });
  focusResolved.current = onFocusResolved;

  useEffect(() => {
    if (saved.current.conversationId !== conversationId) saved.current = { conversationId, state: { following: true } };
    if (!active || !ready || !conversationId || !containerRef.current || !contentRef.current) return;
    const value = createAgentScrollController(containerRef.current, contentRef.current, saved.current.state);
    controller.current = value;
    return () => { value.dispose(); if (controller.current === value) controller.current = null; };
  }, [active, conversationId, ready, containerRef, contentRef]);

  useEffect(() => {
    if (focusOwner.current.id !== focusRoundId) focusOwner.current = { conversationId, id: focusRoundId };
    if (focusRoundId && focusOwner.current.conversationId === conversationId) controller.current?.focusRound(focusRoundId, () => focusResolved.current());
    else {
      if (focusRoundId && active && ready) focusResolved.current();
      controller.current?.layoutChanged();
    }
  }, [active, conversationId, ready, revision, focusRoundId]);

  return useCallback((behavior: ScrollBehavior = 'smooth') => controller.current?.scrollToBottom(behavior), []);
}
