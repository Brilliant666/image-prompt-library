import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/components/gallery/Lightbox.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const descendants = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];

// Run the actual React and native event handlers with deterministic time. This
// exercises browser click/click/dblclick order; it is not a physical touch test.
function harness(t) {
  const slots = [], effects = [], timers = new Map();
  let cursor = 0, dirty = false, tree, now = 1000, timerId = 0, unmounted = false;
  const state = { closed: 0, next: 0, prev: 0, lateUpdates: 0 };
  class FakeElement {
    listeners = new Map();
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    emit(name, event = {}) { for (const callback of this.listeners.get(name) || []) callback(event); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    closest() { return null; }
  }
  class FakeImage extends FakeElement {}
  const surface = new FakeElement(), image = new FakeImage(), window = new FakeElement();
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { if (unmounted) state.lateUpdates++; slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(callback, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { deps, callback }; return slots[i].callback; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps, cleanup: undefined }; } },
  };
  const jsx = (type, props) => ({ type, props });
  const dependencies = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'react-dom': { createPortal: node => node }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../utils/playground/clickSuppression': { suppressGlobalClicks() {}, useGlobalClickSuppression() {} },
    '../../hooks/useModalFocus': { useModalFocus: () => ({ containerRef: null, handleModalKeyDown() {} }) },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'document', 'Element', 'HTMLImageElement', 'Date', 'setTimeout', 'clearTimeout', js)(
    name => { assert.ok(name in dependencies, `unmocked dependency ${name}`); return dependencies[name]; }, module, module.exports,
    window, { body: {} }, FakeElement, FakeImage, { now: () => now },
    (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; }, id => timers.delete(id),
  );
  let props = { src: '/media/first.png', currentIndex: 0, total: 2, onClose: () => state.closed++, onPrev: () => state.prev++, onNext: () => state.next++ };
  function render() {
    if (unmounted) return;
    cursor = 0; dirty = false; tree = module.exports.default(props);
    for (const node of descendants(tree)) if (node.props?.className === 'pg-lightbox-surface') node.props.ref.current = surface;
    effects.splice(0).forEach(effect => effect());
  }
  function flush() { for (let count = 0; dirty && count < 30; count++) render(); assert.ok(!dirty || unmounted, 'render settles'); }
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at; timers.delete(id); timer.callback(); flush();
    }
    now = target; flush();
  }
  const node = (type, predicate = () => true) => descendants(tree).find(node => node.type === type && predicate(node.props))?.props;
  const event = (target = image, detail = 1) => ({ target, detail, button: 0, clientX: 430, clientY: 320, stopPropagation() {}, preventDefault() {} });
  const unmount = () => { if (unmounted) return; unmounted = true; slots.forEach(slot => slot?.cleanup?.()); };
  render(); flush(); advance(600); t.after(unmount);
  return {
    state, node, advance, unmount, event, image, surface, window,
    click(detail = 1, target = image) { surface.emit('mousedown', event(target, detail)); window.emit('mouseup', event(target, detail)); node('div', p => p.className === 'pg-lightbox-surface').onClick(event(target, detail)); flush(); },
    doubleClick() { node('div', p => p.className === 'pg-lightbox-surface').onDoubleClick(event(image, 2)); flush(); },
    queuedCallbacks: () => [...timers.values()].map(timer => timer.callback),
    update(value) { props = { ...props, ...value }; render(); flush(); },
  };
}

test('actual image click/click/dblclick callbacks zoom in and out without closing', t => {
  const box = harness(t);
  box.click(); assert.equal(box.state.closed, 0);
  box.advance(420); // A normal desktop double click can be slower than a touch tap.
  box.click(2); box.doubleClick();
  assert.match(box.node('img').style.transform, /scale\(3\)/);
  box.advance(700); assert.equal(box.state.closed, 0);
  box.click(); box.advance(100); box.click(2); box.doubleClick();
  assert.match(box.node('img').style.transform, /scale\(1\)/);
  box.advance(700); assert.equal(box.state.closed, 0);
});

test('single image click closes only after the double-click window; backdrop and close button remain immediate', t => {
  const single = harness(t); single.click(); single.advance(499); assert.equal(single.state.closed, 0);
  single.advance(1); assert.equal(single.state.closed, 1);
  const backdrop = harness(t); backdrop.click(); backdrop.click(1, backdrop.surface);
  assert.equal(backdrop.state.closed, 1); backdrop.advance(600); assert.equal(backdrop.state.closed, 1);
  const close = harness(t); close.node('button', props => props['aria-label'] === '关闭大图').onClick(); assert.equal(close.state.closed, 1);
});

test('pending close cannot close a newly selected image, including reused URLs, or survive unmount', t => {
  const box = harness(t); box.click(); const firstQueued = box.queuedCallbacks();
  box.update({ src: '/media/second.png', currentIndex: 1 }); firstQueued.forEach(callback => callback());
  box.advance(600); assert.equal(box.state.closed, 0); assert.equal(box.node('img').src, '/media/second.png');
  box.click(); const sameUrlQueued = box.queuedCallbacks();
  box.update({ currentIndex: 0 }); sameUrlQueued.forEach(callback => callback());
  box.advance(600); assert.equal(box.state.closed, 0);
  box.click(); const unmountQueued = box.queuedCallbacks(); box.unmount();
  unmountQueued.forEach(callback => callback()); box.advance(600);
  assert.equal(box.state.closed, 0); assert.equal(box.state.lateUpdates, 0);
});

test('starting wheel zoom cancels a pending image close and panning does not close it', t => {
  const box = harness(t); box.click();
  box.surface.emit('wheel', { ...box.event(), deltaY: -1 }); box.advance(600);
  assert.equal(box.state.closed, 0); assert.match(box.node('img').style.transform, /scale\(1\.15\)/);
  box.surface.emit('mousedown', box.event());
  box.window.emit('mousemove', { ...box.event(), clientX: 460 }); box.window.emit('mouseup');
  box.node('div', props => props.className === 'pg-lightbox-surface').onClick(box.event());
  box.advance(600); assert.equal(box.state.closed, 0);
});
