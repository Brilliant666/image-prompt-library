import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const key = 'image-prompt-library.library_card_layout.v1';
async function compile(name) {
  const source = await readFile(new URL(`../frontend/src/components/${name}.tsx`, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
const cardsCode = await compile('CardsView'), headerCode = await compile('ScopeHeader');
const jsx = (type, props, key) => ({ type, props, key });
const treeNodes = node => !node || typeof node !== 'object' ? [] : [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(treeNodes)];
function evaluate(code, deps, window, ResizeObserver) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'ResizeObserver', code)(name => { assert.ok(name in deps, name); return deps[name]; }, module, module.exports, window, ResizeObserver);
  return module.exports.default;
}
function harness(storage, overrides = {}) {
  const slots = [], effects = [], observers = [], resizeHandlers = new Set();
  let index = 0, tree, dirty = false, width = 900;
  const element = { getBoundingClientRect: () => ({ width }) };
  const writes = [], sorts = [], open = [], selected = [];
  const props = { items: [{ id: 'first' }, { id: 'second' }], t: key => key, total: 2, sort: 'title_desc', onSort: value => sorts.push(value), onOpen: id => open.push(id), onCopyPrompt() {}, onClearCluster() {}, onToggleSelection: id => selected.push(id), selectedIds: new Set(['second']), ...overrides };
  const dependencies = { react: {
    useState: initial => {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; dirty ||= !Object.is(next, slots[i]); slots[i] = next; }];
    },
    useRef: initial => { const i = index++; return slots[i] ??= { current: initial }; },
    useLayoutEffect: (callback, deps) => {
      const i = index++, previous = slots[i];
      if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
        slots[i] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = callback(); });
      }
    },
  }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': { ChevronDown: 'ChevronDown' }, './ItemCard': { __esModule: true, default: 'ItemCard' }, './ScopeHeader': { __esModule: true, default: 'ScopeHeader' }, './ToolbarSelect': { __esModule: true, default: 'ToolbarSelect' }, './LibraryCardLayout.css': {} };
  const window = { innerWidth: 1200, addEventListener: (_, callback) => resizeHandlers.add(callback), removeEventListener: (_, callback) => resizeHandlers.delete(callback), localStorage: storage === undefined ? undefined : { getItem: () => storage.getItem(key), setItem: (key, value) => { writes.push([key, value]); storage.setItem(key, value); } } };
  class Observer {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe(target) { assert.equal(target, element); this.active = true; }
    disconnect() { this.active = false; }
  }
  const Cards = evaluate(cardsCode, dependencies, window, Observer);
  const render = () => {
    let passes = 0;
    do {
      assert.ok(passes++ < 10, 'render should stabilize');
      dirty = false; index = 0; tree = Cards(props);
      const grid = treeNodes(tree).find(node => node.type === 'section');
      // React clears refs on removed DOM nodes before running layout effects.
      slots.filter(slot => slot && Object.hasOwn(slot, 'current')).forEach(ref => { ref.current = grid ? element : null; });
      while (effects.length) effects.shift()();
    } while (dirty);
  };
  const header = () => treeNodes(tree).find(node => node.type === 'ScopeHeader').props;
  const selector = () => treeNodes(header().extraControls).find(node => node.type === 'ToolbarSelect').props;
  const change = value => { selector().onChange(value); render(); };
  render();
  return { header, selector, change, writes, sorts, open, selected,
    cards: () => treeNodes(tree).filter(node => node.type === 'ItemCard'),
    columns: () => treeNodes(tree).filter(node => node.props?.className === 'library-arrangement-column').map(column => treeNodes(column).filter(node => node.type === 'ItemCard').map(card => card.props.item.id)),
    grid: () => treeNodes(tree).find(node => node.type === 'section')?.props, props,
    update: next => { Object.assign(props, next); render(); },
    resize: (viewport, containerWidth = width) => { window.innerWidth = viewport; width = containerWidth; observers.filter(observer => observer.active).forEach(observer => observer.callback()); resizeHandlers.forEach(callback => callback()); render(); },
    activeObservers: () => observers.filter(observer => observer.active).length,
    unmount: () => slots.forEach(slot => slot?.cleanup?.()),
  };
}
function storage(value = null) { return { getItem: () => value, setItem: (_, next) => { value = next; } }; }

test('Library defaults to the unchanged vertical grid without writing a preference', () => {
  const h = harness(storage());
  assert.equal(h.selector().value, 'vertical');
  assert.equal(h.grid().className, 'cards-grid masonry-like responsive-cards-grid is-selecting');
  assert.deepEqual(h.writes, []);
});

test('sparse Collection cards request larger responsive images while ordinary search cards use the standard sizes', () => {
  const sparse = harness(storage(), { clusterName: 'Small collection' });
  assert(sparse.cards().every(card => card.props.imageSizes === '100vw'));
  const regular = harness(storage(), { hasActiveSearch: true });
  assert(regular.cards().every(card => card.props.imageSizes === undefined));
  sparse.update({ items: Array.from({ length: 9 }, (_, index) => ({ id: String(index) })) });
  assert(sparse.cards().every(card => card.props.imageSizes === undefined));
});

test('layout callback changes presentation only and preserves item order, selection and sorting callbacks', () => {
  const h = harness(storage());
  const before = h.cards().map(card => card.props.item);
  h.change('horizontal');
  assert.match(h.grid().className, /library-horizontal/);
  assert.deepEqual(h.cards().map(card => card.props.item), before);
  assert.deepEqual(h.cards().map(card => card.props.isSelected), [false, true]);
  assert.equal(h.header().sort, 'title_desc');
  assert.deepEqual(h.sorts, []);
  h.cards()[0].props.onOpen('first'); h.cards()[1].props.onToggleSelection('second');
  assert.deepEqual(h.open, ['first']); assert.deepEqual(h.selected, ['second']);
  assert.deepEqual(h.writes, [[key, 'horizontal']]);
  h.change('vertical'); assert.doesNotMatch(h.grid().className, /library-horizontal/);
});

test('saved horizontal choice survives remount, while invalid or inaccessible storage safely uses vertical', () => {
  const persistent = storage(); const first = harness(persistent); first.change('horizontal');
  assert.equal(harness(persistent).selector().value, 'horizontal');
  assert.equal(harness(storage('corrupt')).selector().value, 'vertical');
  assert.equal(harness(undefined).selector().value, 'vertical');
  const failing = harness({ getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } });
  assert.equal(failing.selector().value, 'vertical');
  failing.change('horizontal'); assert.equal(failing.selector().value, 'horizontal');
});

test('layout control remains available during loading and empty results', () => {
  for (const overrides of [{ items: [], loading: true }, { items: [], emptyMode: 'first-run' }, { items: [], total: 0 }]) {
    const h = harness(storage(), overrides); h.change('horizontal');
    assert.equal(h.selector().value, 'horizontal'); assert.deepEqual(h.sorts, []);
  }
});

test('horizontal arrangement distributes sorted cards across columns without changing card data or callbacks', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `${i + 1}`, title: `Title ${i + 1}`, image: { width: 300, height: (i + 1) * 100 } }));
  const h = harness(storage('horizontal'), { items });
  assert.deepEqual(h.columns(), [['1', '5', '9'], ['2', '6', '10'], ['3', '7'], ['4', '8']]);
  for (const card of h.cards()) {
    assert.equal(card.props.item, items.find(item => item.id === card.props.item.id));
    assert.equal(card.props.onOpen, h.props.onOpen);
  }
  h.update({ items: [...items].reverse(), sort: 'created_desc' });
  assert.deepEqual(h.columns(), [['10', '6', '2'], ['9', '5', '1'], ['8', '4'], ['7', '3']]);
  assert.deepEqual(h.sorts, []);
  h.change('vertical');
  assert.deepEqual(h.cards().map(card => card.props.item.id), [...items].reverse().map(item => item.id));
  assert.equal(h.activeObservers(), 0);
});

test('responsive arrangement redistributes every item once on container and viewport resize', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ id: `${i + 1}` }));
  const h = harness(storage('horizontal'), { items });
  h.resize(1200, 680);
  assert.deepEqual(h.columns(), [['1', '4', '7'], ['2', '5', '8'], ['3', '6', '9']]);
  h.resize(760, 600);
  assert.deepEqual(h.columns(), [['1', '3', '5', '7', '9'], ['2', '4', '6', '8']]);
  h.resize(400, 350);
  assert.deepEqual(h.columns(), [items.map(item => item.id)]);
  h.resize(1200, 900);
  assert.equal(h.columns().length, 4);
  assert.deepEqual(h.cards().map(card => card.props.item.id).sort(), items.map(item => item.id).sort());
});

test('hidden Library keeps each horizontal card in its existing column until a visible resize', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `${i + 1}` }));
  const h = harness(storage('horizontal'), { items, selectedIds: new Set(['2']) });
  h.resize(1600, 1400);
  const before = h.columns();
  assert.equal(before.length, 6);

  // App keeps Library mounted with `hidden`; its observed grid then measures zero.
  h.resize(1600, 0);
  assert.deepEqual(h.columns(), before, 'hiding must not move cards to new React parents');
  assert.equal(h.activeObservers(), 1, 'keep observing so reopening can measure the visible grid');
  h.resize(1600, 1400);
  assert.deepEqual(h.columns(), before, 'reopening at the same size preserves card parents');

  h.resize(600, 0);
  assert.deepEqual(h.columns(), before, 'viewport changes while hidden must also wait for visible dimensions');
  h.resize(600, 500);
  assert.equal(h.columns().length, 2);
  assert.deepEqual(h.columns(), [items.filter((_, i) => i % 2 === 0).map(item => item.id), items.filter((_, i) => i % 2 === 1).map(item => item.id)]);
  const second = h.cards().find(card => card.props.item.id === '2');
  assert.equal(second.props.item, items[1]);
  assert.equal(second.props.isSelected, true);
  second.props.onOpen('2');
  second.props.onToggleSelection('2');
  assert.deepEqual(h.open, ['2']);
  assert.deepEqual(h.selected, ['2']);
  assert.deepEqual(h.writes, []);
  h.unmount();
  assert.equal(h.activeObservers(), 0);
});

test('hidden sparse collections retain their columns across viewport changes and measure on reveal', () => {
  const h = harness(storage('horizontal'), { clusterName: 'Collection', items: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] });
  const before = h.columns();
  assert.equal(before.length, 3);
  h.resize(400, 0);
  assert.deepEqual(h.columns(), before);
  h.resize(400, 350);
  assert.deepEqual(h.columns(), [['one', 'two', 'three']]);
});

test('sparse collections retain original one, two or three desktop columns and mobile breakpoints', () => {
  for (const length of [1, 2, 3, 8]) {
    const h = harness(storage('horizontal'), { clusterName: 'Collection', items: Array.from({ length }, (_, i) => ({ id: `${i}` })) });
    assert.equal(h.columns().length, Math.min(length, 3));
    h.resize(760); assert.equal(h.columns().length, Math.min(length, 2));
    h.resize(400); assert.equal(h.columns().length, 1);
  }
});

test('horizontal measurement attaches after empty results populate and detaches when emptied or unmounted', () => {
  const h = harness(storage('horizontal'), { items: [], loading: true });
  assert.equal(h.activeObservers(), 0);
  h.update({ items: [{ id: 'one' }, { id: 'two' }], loading: false });
  assert.equal(h.activeObservers(), 1);
  assert.equal(h.columns().length, 4);
  h.resize(760); assert.deepEqual(h.columns(), [['one'], ['two']]);
  h.update({ items: [] }); assert.equal(h.activeObservers(), 0);
  h.update({ items: [{ id: 'one' }] }); assert.equal(h.activeObservers(), 1);
  h.unmount(); assert.equal(h.activeObservers(), 0);
});

test('production ScopeHeader appends the optional layout after sorting; callers without it keep only sorting', () => {
  const Header = evaluate(headerCode, { './ToolbarSelect': { __esModule: true, default: 'ToolbarSelect' }, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': { ArrowLeft: 'ArrowLeft', ChevronDown: 'ChevronDown' } });
  const changes = [], props = { t: key => key, title: 'Library', count: 2, countLabel: 'items', sort: 'updated_desc', onSort: value => changes.push(value) };
  const original = Header(props);
  assert.equal(treeNodes(original).filter(node => node.type === 'ToolbarSelect').length, 1);
  assert.doesNotMatch(original.props.className, /has-extra-controls/);
  const extra = jsx('ToolbarSelect', { 'aria-label': 'layout' });
  const updated = Header({ ...props, extraControls: extra });
  const controls = treeNodes(updated).filter(node => node.type === 'ToolbarSelect');
  assert.equal(controls[1], extra);
  controls[0].props.onChange('created_desc');
  assert.deepEqual(changes, ['created_desc']);
});
