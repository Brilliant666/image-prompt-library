import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
function evaluate(js, dependencies) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => {
    assert.ok(name in dependencies, `unmocked dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const gridMath = evaluate(await compile('../frontend/src/utils/playground/virtualGrid.ts'), {});
const hookJs = await compile('../frontend/src/utils/playground/useVirtualGrid.ts');
const taskGridJs = await compile('../frontend/src/components/gallery/TaskGrid.tsx');

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name) { for (const callback of listeners.get(name) || []) callback(); },
  };
}

// Execute the real hook with deterministic layout/observer values. No browser,
// image fetch, provider request, or replacement range algorithm is used.
function harness(t, { container = true, count = 100 } = {}) {
  const layout = { columns: 2, rowHeight: 100, rowGap: 10, columnGap: 12, gridOffset: 40, hidden: false };
  const page = { ...eventTarget(), innerHeight: 900, scrollY: 0, scrolls: [], scrollBy(x, y) { this.scrollY += y; this.scrolls.push([x, y]); } };
  let scrollTop = 0, committedRange;
  const scroller = { ...eventTarget(), clientHeight: 320, clientTop: 2, getBoundingClientRect: () => ({ top: 120 }),
    get scrollTop() { return scrollTop; },
    set scrollTop(value) {
      const rows = committedRange ? Math.ceil((committedRange.endIndex - committedRange.startIndex) / layout.columns) : 0;
      const height = committedRange ? committedRange.paddingTop + committedRange.paddingBottom + rows * (layout.rowHeight + layout.rowGap) - (rows ? layout.rowGap : 0) + layout.gridOffset : Infinity;
      scrollTop = Math.max(0, Math.min(value, height - this.clientHeight));
    },
  };
  const grid = {
    clientWidth: 600,
    getClientRects: () => layout.hidden ? [] : [{}],
    getBoundingClientRect: () => ({ top: container ? 120 + scroller.clientTop + layout.gridOffset - scroller.scrollTop : layout.gridOffset - page.scrollY }),
    firstElementChild: { getBoundingClientRect: () => ({ height: layout.rowHeight }) },
  };
  const gridRef = { current: grid }, scrollRef = { current: scroller }, observers = [];
  const replacements = {
    window: page,
    getComputedStyle: () => ({ gridTemplateColumns: Array(layout.columns).fill('100px').join(' '), rowGap: String(layout.rowGap), columnGap: String(layout.columnGap) }),
    ResizeObserver: class {
      targets = new Set(); disconnected = false;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.targets.add(target); }
      disconnect() { this.disconnected = true; this.targets.clear(); }
    },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const slots = [], effects = []; let cursor = 0, dirty = false, result;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(callback, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { deps, callback }; return slots[i].callback; },
    useLayoutEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps, cleanup: undefined }; } },
  };
  const hook = evaluate(hookJs, { react: hooks, './virtualGrid': gridMath }).useVirtualGrid;
  function render() { dirty = false; cursor = 0; result = hook(gridRef, count, container ? scrollRef : undefined); committedRange = result; effects.splice(0).forEach(effect => effect()); }
  function flush() { for (let i = 0; dirty && i < 10; i++) render(); assert.equal(dirty, false, 'layout updates settle'); }
  function resize(target = grid) { for (const observer of observers) if (observer.targets.has(target)) observer.callback(); flush(); }
  function dispose() { for (const slot of slots) slot?.cleanup?.(); }
  render(); flush();
  t.after(() => { dispose(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { layout, grid, scroller, page, observers, resize, flush, dispose, setCount(value) { count = value; render(); flush(); }, get result() { return result; } };
}

test('container scroll uses its content viewport and observes both grid and results area', t => {
  const h = harness(t);
  assert.equal(h.result.endIndex, 12, '320px container, not the 900px window');
  assert.ok(h.observers[0].targets.has(h.grid));
  assert.ok(h.observers[0].targets.has(h.scroller));
  assert.equal(h.page.listeners.get('scroll')?.size || 0, 0);
  assert.equal(h.scroller.listeners.get('scroll').size, 1);
  h.scroller.scrollTop = 700; h.scroller.emit('scroll'); h.flush();
  assert.equal(h.result.startIndex, 6);
  assert.equal(h.result.endIndex, 24);
  assert.equal(h.result.paddingTop, 330);
  h.scroller.clientHeight = 200; h.resize(h.scroller);
  assert.equal(h.result.startIndex, 8);
  assert.equal(h.result.endIndex, 20, 'composer growth shrinks rendered rows without window resize');
  assert.equal(h.scroller.scrollTop, 700);
  assert.deepEqual(h.page.scrolls, []);
});

test('container resize preserves the leading item anchor and never scrolls the page', t => {
  const h = harness(t);
  h.scroller.scrollTop = 700; h.scroller.emit('scroll'); h.flush();
  h.layout.columns = 1; h.resize();
  assert.equal(h.scroller.scrollTop, 1360, 'item 12 stays at the content viewport top after two columns become one');
  assert.equal(h.result.metricsRef.current.columns, 1);
  h.layout.rowHeight = 120; h.resize();
  assert.equal(h.scroller.scrollTop, 1600, 'the same leading item survives a row-height change');
  assert.deepEqual(h.page.scrolls, []);
});

test('container resize near the bottom commits new padding before scrolling to the anchor', t => {
  const h = harness(t);
  h.scroller.scrollTop = 4900; h.scroller.emit('scroll'); h.flush();
  h.layout.columns = 1; h.resize();
  assert.equal(h.scroller.scrollTop, 9740, 'new target is beyond the old virtual scrollHeight and must not be clamped to it');
  assert.equal(h.result.startIndex, 85);
  assert.equal(h.result.endIndex, 94);
  assert.deepEqual(h.page.scrolls, []);
});

test('hidden workspace keeps its scroll position and remeasures on reveal', t => {
  const h = harness(t);
  h.scroller.scrollTop = 700; h.scroller.emit('scroll'); h.flush();
  const visible = h.result;
  h.layout.hidden = true; h.layout.columns = 1; h.scroller.clientHeight = 0; h.resize(); h.resize(h.scroller);
  assert.equal(h.result, visible);
  assert.equal(h.scroller.scrollTop, 700);
  h.layout.hidden = false; h.scroller.clientHeight = 200; h.resize(h.scroller);
  assert.equal(h.scroller.scrollTop, 1360);
  assert.equal(h.result.startIndex, 10);
  assert.equal(h.result.endIndex, 16);
  h.dispose();
  assert.equal(h.scroller.listeners.get('scroll').size, 0);
  assert.equal(h.page.listeners.get('resize').size, 0);
  assert.ok(h.observers.every(observer => observer.disconnected));
});

test('window scrolling without a scrollRef retains the original range and anchor behavior', t => {
  const h = harness(t, { container: false });
  assert.equal(h.result.endIndex, 32);
  assert.equal(h.page.listeners.get('scroll').size, 1);
  assert.equal(h.observers[0].targets.size, 1);
  h.page.scrollY = 1140; h.page.emit('scroll'); h.flush();
  assert.equal(h.result.startIndex, 2);
  assert.equal(h.result.endIndex, 54);
  h.layout.columns = 1; h.resize();
  assert.equal(h.page.scrollY, 2240);
  assert.deepEqual(h.page.scrolls, [[0, 1100]]);
  h.setCount(0); assert.equal(h.result.endIndex, 0);
  assert.equal(h.page.listeners.get('scroll').size, 0);
});

test('TaskGrid passes the supplied scrollRef to virtualization while retaining grid-relative selection', () => {
  const calls = [], selections = [];
  const scrollRef = { current: { scrollTop: 700 } };
  const jsx = (type, props) => ({ type, props });
  const metrics = { columns: 2, rowHeight: 100, rowGap: 10, columnGap: 12, width: 600 };
  const dependencies = {
    react: { useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect: () => {} },
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../api/client': { mediaUrl: path => path }, '../../utils/playground/virtualGrid': gridMath,
    '../../utils/playground/useVirtualGrid': { useVirtualGrid: (...args) => { calls.push(args); return { startIndex: 6, endIndex: 8, paddingTop: 330, paddingBottom: 0, metricsRef: { current: metrics } }; } },
    '../../utils/galleryRecipe': { galleryJobPrompt: job => job.prompt_text, galleryStatus: {} }, '../../utils/clipboard': {},
  };
  const TaskGrid = evaluate(taskGridJs, dependencies).default;
  const jobs = Array.from({ length: 20 }, (_, i) => ({ id: `job-${i}`, prompt_text: `prompt-${i}`, status: 'queued' }));
  const tree = TaskGrid({ jobs, selected: new Set(), scrollRef, onSelection: value => selections.push(value) });
  assert.equal(calls[0][1], 20);
  assert.equal(calls[0][2], scrollRef);
  const grid = { getBoundingClientRect: () => ({ top: -538, left: 20 }), setPointerCapture() {} };
  tree.props.onPointerDown({ button: 0, target: { closest: () => null }, clientX: 21, clientY: 123, currentTarget: grid, pointerId: 1 });
  tree.props.onPointerMove({ clientX: 100, clientY: 150, currentTarget: grid });
  assert.deepEqual([...selections[0]], ['job-12']);
});
