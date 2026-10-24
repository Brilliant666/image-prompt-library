import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/components/agent/useAgentScroll.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const frames = new Map(), observers = [], calls = [], listeners = new Map();
  let sequence = 0, reducedMotion = false;
  const events = () => {
    const events = new Map();
    return {
      addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
      removeEventListener(name, fn) { events.get(name)?.delete(fn); },
      emit(name, value = {}) { for (const fn of events.get(name) || []) fn(value); },
      get listenerCount() { return [...events.values()].reduce((n, rows) => n + rows.size, 0); },
    };
  };
  const container = { ...events(), scrollTop: 0, scrollHeight: 6000, clientHeight: 600,
    scrollTo(options) {
      calls.push(options);
      if (options.behavior !== 'smooth') { this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight)); this.emit('scroll'); }
    },
  };
  const targets = [];
  const content = { ...events(), querySelectorAll: () => targets };
  const globals = {
    requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class {
      observed = []; disconnected = false;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(node) { this.observed.push(node); }
      disconnect() { this.disconnected = true; }
    },
    window: {
      matchMedia: () => ({ matches: reducedMotion }),
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
      removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    },
  };
  const slots = [], effects = [];
  let cursor = 0;
  const hooks = {
    useRef(value) { const i = cursor++; if (!slots[i]) slots[i] = { current: value }; return slots[i]; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); }); } },
    useCallback(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { deps, value: fn }; return slots[i].value; },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(name => { assert.equal(name, 'react'); return hooks; }, module, module.exports, ...Object.values(globals));
  let props = { containerRef: { current: container }, contentRef: { current: content }, active: true, conversationId: 'A', ready: false, revision: 1, onFocusResolved() {} };
  return {
    ...module.exports, container, content, targets, calls, observers, frames, globals,
    render(next = {}) { props = { ...props, ...next }; cursor = 0; const callback = module.exports.useAgentScroll(props); effects.splice(0).forEach(fn => fn()); return callback; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
    flush() { for (let i = 0; frames.size; i++) { assert.ok(i < 10, 'animation frames must settle'); const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); } },
    resize() { for (const observer of observers) if (!observer.disconnected) observer.callback(); },
    reduceMotion() { reducedMotion = true; },
    get windowListeners() { return [...listeners.values()].reduce((n, rows) => n + rows.size, 0); },
  };
}

test('successful first conversation load opens the latest round even when history exceeds 220px', () => {
  const f = fixture();
  f.render(); f.flush();
  assert.equal(f.calls.length, 0, 'loading history must not be treated as loaded');
  f.render({ ready: true }); f.flush();
  assert.equal(f.container.scrollTop, 5400);
  f.container.scrollHeight += 1600;
  f.render({ revision: 2 }); f.flush();
  assert.equal(f.container.scrollTop, 7000, 'large text updates retain the pre-update follow intent');
  f.unmount();
});

test('one bottom action follows delayed images and composer/container resizing until the real latest message', () => {
  const f = fixture(); const state = { following: false };
  const controller = f.createAgentScrollController(f.container, f.content, state);
  controller.scrollToBottom();
  assert.equal(f.calls[0].behavior, 'smooth');
  f.container.scrollTop = 2400; f.container.emit('scroll');
  assert.equal(state.following, true, 'intermediate smooth scroll events are not upward browsing');
  f.container.scrollHeight = 7200; f.resize(); f.flush();
  assert.equal(f.container.scrollTop, 6600);
  f.container.scrollHeight = 8000; f.content.emit('load'); f.flush();
  assert.equal(f.container.scrollTop, 7400, 'late image load is included without a second click');
  f.container.clientHeight = 480; f.resize(); f.flush();
  assert.equal(f.container.scrollTop, 7520, 'a taller composer does not hide the tail');
  assert.deepEqual(f.observers[0].observed, [f.content, f.container]);
  controller.dispose();
});

test('upward reading cancels a pending jump and late content never pulls the user back', () => {
  const f = fixture(); const state = { following: true };
  const controller = f.createAgentScrollController(f.container, f.content, state);
  controller.scrollToBottom('instant');
  f.container.scrollHeight += 300; f.resize();
  f.container.emit('wheel', { deltaY: -50 });
  f.container.scrollTop -= 80; f.container.emit('scroll'); f.flush();
  const readingTop = f.container.scrollTop;
  f.container.scrollHeight += 900; f.resize(); f.content.emit('load'); f.flush();
  assert.equal(f.container.scrollTop, readingTop);
  assert.equal(state.following, false);
  f.container.scrollTop = f.container.scrollHeight - f.container.clientHeight; f.container.emit('scroll');
  f.container.scrollHeight += 500; controller.layoutChanged(); f.flush();
  assert.equal(f.container.scrollTop, f.container.scrollHeight - f.container.clientHeight, 'manually reaching the tail resumes following');
  controller.dispose();
});

test('scrollbar, keyboard and touch navigation interrupt smooth following; reduced motion avoids animation', () => {
  for (const method of ['scrollbar', 'keyboard', 'touch']) {
    const f = fixture(); const state = { following: false };
    const controller = f.createAgentScrollController(f.container, f.content, state);
    f.container.scrollTop = 2000;
    controller.scrollToBottom();
    if (method === 'keyboard') f.container.emit('keydown', { key: 'PageUp', target: { closest: () => null } });
    if (method === 'touch') { f.container.emit('touchstart', { touches: [{ clientY: 100 }] }); f.container.emit('touchmove', { touches: [{ clientY: 130 }] }); }
    if (method === 'scrollbar') f.container.emit('pointerdown');
    f.container.scrollTop = 1800; f.container.emit('scroll');
    f.container.scrollHeight += 700; f.resize(); f.flush();
    assert.equal(f.container.scrollTop, 1800, method);
    assert.equal(state.following, false, method);
    f.reduceMotion(); controller.scrollToBottom();
    assert.equal(f.calls.at(-1).behavior, 'instant');
    assert.equal(f.container.scrollTop, 6100);
    controller.dispose();
  }
});

test('Gallery round focus wins over initial bottom positioning and subsequent image loads', () => {
  const f = fixture(); let resolved = 0;
  f.targets.push({ dataset: { agentRound: 'round-3' }, scrollIntoView(options) { assert.equal(options.block, 'center'); f.container.scrollTop = 1300; f.container.emit('scroll'); } });
  f.render({ ready: true, focusRoundId: 'round-3', onFocusResolved: () => { resolved++; } }); f.flush();
  assert.equal(resolved, 1); assert.equal(f.container.scrollTop, 1300);
  f.render({ focusRoundId: undefined });
  f.container.scrollHeight += 600; f.resize(); f.flush();
  assert.equal(f.container.scrollTop, 1300);
  f.unmount();
});

test('hidden workspaces cancel frames and observers; returning preserves upward reading and another conversation starts at its tail', () => {
  const f = fixture();
  f.render({ ready: true }); f.flush();
  f.container.emit('wheel', { deltaY: -100 }); f.container.scrollTop = 700; f.container.emit('scroll');
  const old = f.observers[0];
  f.render({ active: false });
  assert.equal(old.disconnected, true); assert.equal(f.container.listenerCount, 0); assert.equal(f.content.listenerCount, 0); assert.equal(f.windowListeners, 0);
  f.container.scrollHeight += 1200; old.callback(); f.flush(); assert.equal(f.container.scrollTop, 700);
  f.render({ active: true }); f.flush(); assert.equal(f.container.scrollTop, 700, 'tab switching preserves intentional reading');
  f.render({ conversationId: 'B', ready: false }); f.flush(); assert.equal(f.container.scrollTop, 700);
  f.container.scrollHeight = 10000;
  f.render({ ready: true });
  assert.equal(f.frames.size, 1);
  f.render({ active: false }); f.flush(); assert.equal(f.container.scrollTop, 700, 'a queued frame cannot scroll a hidden workspace');
  f.render({ active: true }); f.flush(); assert.equal(f.container.scrollTop, 9400);
  f.unmount(); assert.equal(f.frames.size, 0); assert.equal(f.windowListeners, 0);
});

test('a superseded conversation round-focus callback cannot move the next conversation', () => {
  const f = fixture(); let resolved = 0;
  f.targets.push({ dataset: { agentRound: 'round-A' }, scrollIntoView() { f.container.scrollTop = 123; } });
  f.render({ ready: true, focusRoundId: 'round-A', onFocusResolved: () => { resolved++; } });
  f.render({ conversationId: 'B', ready: false });
  f.flush(); assert.equal(resolved, 0); assert.equal(f.container.scrollTop, 0);
  f.container.scrollHeight = 9000; f.render({ ready: true }); f.flush();
  assert.equal(f.container.scrollTop, 8400);
  assert.equal(resolved, 1, 'the stale target is cleared without focusing it in B');
  f.unmount();
});
