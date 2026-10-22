import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const component = await compile('../frontend/src/components/ToolbarSelect.tsx');
const header = await compile('../frontend/src/components/ScopeHeader.tsx');
const translations = await compile('../frontend/src/utils/i18n.ts');
const jsx = (type, props) => ({ type, props });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' };
const descendants = node => Array.isArray(node) ? node.flatMap(descendants) : !node || typeof node !== 'object' ? [] : [node, ...descendants(node.props?.children)];
const content = node => Array.isArray(node) ? node.map(content).join('') : node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : content(node.props?.children);
function evaluate(source, deps, document, window, ResizeObserver, MutationObserver) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'document', 'window', 'ResizeObserver', 'MutationObserver', source)(
    name => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; }, module, module.exports, document, window, ResizeObserver, MutationObserver);
  return module.exports;
}
const { makeTranslator } = evaluate(translations, {});
const options = ['updated', 'created', 'title', 'source'].map(value => ({ value, label: `Label ${value}` }));
function harness(overrides = {}, geometry = {}) {
  const slots = [], pending = [], effects = new Map(), listeners = new Map(), windowListeners = new Map();
  const resizeObservers = [], mutationObservers = [], changes = [], scrolls = [];
  let cursor = 0, dirty = false, tree, elements = [], unavailable = false;
  let rect = { left: 250, top: 100, bottom: 138, width: 150, ...geometry.rect };
  let props = { label: 'Sort', prefix: 'Sort', value: 'created', options, ...overrides };
  const eventTarget = map => ({ addEventListener(name, fn) { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(fn); }, removeEventListener(name, fn) { map.get(name)?.delete(fn); if (!map.get(name)?.size) map.delete(name); } });
  const document = { body: {}, activeElement: null, ...eventTarget(listeners) };
  const window = { innerWidth: geometry.width ?? 1200, innerHeight: geometry.height ?? 800, ...eventTarget(windowListeners), visualViewport: undefined };
  const effect = (callback, dependencies) => {
    const i = cursor++, previous = effects.get(i);
    if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, j) => Object.is(value, previous.dependencies[j]))) return;
    pending.push(() => { previous?.cleanup?.(); effects.set(i, { dependencies, cleanup: callback() }); });
  };
  const hooks = {
    useId() { return `select-${cursor++}`; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; dirty ||= !Object.is(next, slots[i]); slots[i] = next; }]; },
    useEffect: effect, useLayoutEffect: effect,
  };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.active = true; resizeObservers.push(this); }
    observe() {}
    disconnect() { this.active = false; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.active = true; mutationObservers.push(this); }
    observe() {}
    disconnect() { this.active = false; }
  }
  const Select = evaluate(component, {
    react: hooks, 'react/jsx-runtime': jsxRuntime, 'react-dom': { createPortal(node, parent) { assert.equal(parent, document.body); return jsx('portal', { children: node }); } },
    'lucide-react': { Check: 'Check', ChevronDown: 'ChevronDown' }, './ToolbarSelect.css': {},
  }, document, window, ResizeObserver, MutationObserver).default;
  function render() {
    dirty = false; cursor = 0;
    tree = Select({ ...props, onChange(value) { changes.push(value); props.onChange?.(value); props = { ...props, value }; dirty = true; } });
    const previous = elements;
    elements = descendants(tree).map((node, index) => {
      const element = previous[index]?.node.type === node.type ? previous[index] : {};
      element.node = node;
      element.parentElement = null;
      element.closest = () => unavailable ? {} : null;
      element.focus = () => { document.activeElement = element; };
      element.contains = target => target === element || (node.props?.role === 'listbox' && target?.node?.props?.role === 'option');
      element.getBoundingClientRect = () => rect;
      element.scrollHeight = geometry.menuHeight ?? 160;
      element.scrollIntoView = args => scrolls.push({ index: node.props?.['data-option-index'], args });
      element.querySelector = selector => elements.find(candidate => candidate.node.props?.['data-option-index'] === Number(selector.match(/"(\d+)"/)?.[1]));
      if (node.props?.ref) node.props.ref.current = element;
      return element;
    });
    for (const element of previous) if (element.node.props?.ref && !elements.includes(element)) element.node.props.ref.current = null;
    while (pending.length) pending.shift()();
  }
  function flush() { for (let i = 0; dirty && i < 20; i++) render(); assert.equal(dirty, false, 'hooks settle'); }
  const nodes = () => descendants(tree);
  const trigger = () => nodes().find(node => node.props?.role === 'combobox');
  const menu = () => nodes().find(node => node.props?.role === 'listbox');
  const choices = () => nodes().filter(node => node.props?.role === 'option');
  const emit = (map, name, event) => { for (const callback of [...(map.get(name) ?? [])]) callback(event); flush(); };
  render(); flush();
  return {
    changes, scrolls, document, window, trigger, menu, choices, nodes, listeners, windowListeners,
    open() { trigger().props.onClick(); flush(); },
    choose(index) { choices()[index].props.onClick(); flush(); },
    key(key, nativeEvent = {}) { const result = { prevented: false, stopped: false }; trigger().props.onKeyDown({ key, nativeEvent, preventDefault() { result.prevented = true; }, stopPropagation() { result.stopped = true; } }); flush(); return result; },
    update(values) { props = { ...props, ...values }; dirty = true; flush(); },
    outside() { emit(listeners, 'pointerdown', { target: {} }); },
    focusOutside() { const target = {}; document.activeElement = target; emit(listeners, 'focusin', { target }); return target; },
    inert(value) { unavailable = value; mutationObservers.filter(observer => observer.active).forEach(observer => observer.callback()); flush(); },
    resize(width, height, nextRect = {}) { window.innerWidth = width; window.innerHeight = height; rect = { ...rect, ...nextRect }; emit(windowListeners, 'resize'); },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
    activeObservers() { return [...resizeObservers, ...mutationObservers].filter(observer => observer.active).length; },
  };
}

test('the entire production trigger opens the list, tracks the selected value and commits only explicit choices', () => {
  const h = harness();
  assert.equal(content(h.trigger()), 'SortLabel created');
  h.open();
  assert.equal(h.choices().length, 4);
  assert.equal(h.choices()[1].props['aria-selected'], true);
  assert.equal(h.trigger().props['aria-controls'], h.menu().props.id);
  assert.equal(h.trigger().props['aria-activedescendant'], h.choices()[1].props.id);
  assert.deepEqual(h.changes, []);
  h.choose(2);
  assert.deepEqual(h.changes, ['title']);
  assert.equal(h.trigger().props['aria-expanded'], false);
  assert.equal(content(h.trigger()), 'SortLabel title');
  assert.equal(h.document.activeElement.node.props.role, 'combobox');
  h.open(); h.choose(2);
  assert.deepEqual(h.changes, ['title'], 'choosing the current value does not dispatch a duplicate filter/reorder');
  h.unmount();
});

test('arrows and Home/End navigate without committing; Enter and Space commit the highlighted choice', () => {
  const h = harness();
  h.key('ArrowDown');
  assert.equal(h.trigger().props['aria-activedescendant'], h.choices()[1].props.id);
  h.key('ArrowDown'); h.key('End'); h.key('ArrowDown');
  assert.equal(h.trigger().props['aria-activedescendant'], h.choices()[3].props.id);
  h.key('Home'); h.key('ArrowUp');
  assert.equal(h.trigger().props['aria-activedescendant'], h.choices()[0].props.id);
  assert.deepEqual(h.changes, []);
  h.key('Enter'); assert.deepEqual(h.changes, ['updated']);
  h.key(' '); h.key('End'); h.key(' '); assert.deepEqual(h.changes, ['updated', 'source']);
  assert.ok(h.scrolls.some(scroll => scroll.index === 3 && scroll.args.block === 'nearest'));
  h.unmount();
});

test('Escape restores trigger focus; Tab, outside click and outside focus dismiss without committing or trapping focus', () => {
  const h = harness(); h.open(); h.key('End');
  assert.deepEqual(h.key('Escape'), { prevented: true, stopped: true });
  assert.equal(h.document.activeElement.node.props.role, 'combobox');
  h.open(); assert.deepEqual(h.key('Tab'), { prevented: false, stopped: false });
  assert.equal(h.trigger().props['aria-expanded'], false);
  h.open(); h.outside(); assert.equal(h.menu(), undefined);
  h.open(); const outside = h.focusOutside(); assert.equal(h.document.activeElement, outside);
  assert.equal(h.menu(), undefined);
  assert.deepEqual(h.changes, []);
  assert.equal(h.listeners.size, 0); assert.equal(h.windowListeners.size, 0); assert.equal(h.activeObservers(), 0);
  h.unmount();
});

test('disabled choices are skipped, while a disabled or inert toolbar cannot leave a live portal', () => {
  const h = harness({ options: options.map((option, i) => ({ ...option, disabled: i === 2 })) });
  h.open(); h.key('ArrowDown');
  assert.equal(h.trigger().props['aria-activedescendant'], h.choices()[3].props.id);
  h.choose(2); assert.deepEqual(h.changes, []);
  h.update({ disabled: true }); assert.equal(h.menu(), undefined); assert.equal(h.trigger().props.disabled, true);
  h.open(); assert.equal(h.menu(), undefined);
  h.update({ disabled: false }); h.open(); h.inert(true); assert.equal(h.menu(), undefined);
  h.open(); assert.equal(h.menu(), undefined);
  h.inert(false); h.open(); assert.ok(h.menu());
  h.update({ options: [] }); assert.equal(h.menu(), undefined); assert.equal(h.trigger().props.disabled, true);
  assert.equal(h.activeObservers(), 0); h.unmount();
});

for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) test(`IME ${JSON.stringify(nativeEvent)} does not navigate, commit or dismiss`, () => {
  const h = harness(); h.open();
  const active = h.trigger().props['aria-activedescendant'];
  for (const key of ['ArrowDown', 'Home', 'End', 'Enter', ' ', 'Escape']) {
    assert.deepEqual(h.key(key, nativeEvent), { prevented: false, stopped: true });
    assert.equal(h.trigger().props['aria-activedescendant'], active); assert.ok(h.menu());
  }
  assert.deepEqual(h.changes, []); h.unmount();
});

test('composition lifecycle is guarded and dismissal resets it before reopening', () => {
  const h = harness(); h.open(); h.trigger().props.onCompositionStart();
  assert.deepEqual(h.key('Enter'), { prevented: false, stopped: true });
  h.outside(); h.open(); h.key('End'); h.key('Enter');
  assert.deepEqual(h.changes, ['source']); h.unmount();
});

test('body portal flips above at the viewport edge, clamps horizontally on mobile, and releases observers on unmount', () => {
  const h = harness({}, { width: 390, height: 600, rect: { left: 285, top: 545, bottom: 585 }, menuHeight: 230 });
  h.open();
  assert.ok(h.nodes().some(node => node.type === 'portal'));
  assert.equal(h.menu().props['data-placement'], 'above');
  const { left, top, width, maxHeight } = h.menu().props.style;
  assert.ok(left >= 8 && left + width <= 382); assert.ok(top >= 8 && top + Math.min(230, maxHeight) <= 539);
  h.resize(320, 600, { left: 10, top: 40, bottom: 80 });
  assert.equal(h.menu().props['data-placement'], 'below');
  assert.ok(h.menu().props.style.left + h.menu().props.style.width <= 312);
  h.unmount(); assert.equal(h.listeners.size, 0); assert.equal(h.windowListeners.size, 0); assert.equal(h.activeObservers(), 0);
});

test('short visual viewports bound menu height and invalidated options repair the active descendant', () => {
  const h = harness({}, { width: 280, height: 180, rect: { left: 200, top: 65, bottom: 100 }, menuHeight: 280 });
  h.open();
  assert.ok(h.menu().props.style.maxHeight <= 66);
  h.key('End'); h.update({ options: options.slice(0, 2) });
  assert.equal(h.trigger().props['aria-activedescendant'], h.choices()[1].props.id);
  assert.deepEqual(h.changes, []); h.unmount();
});

for (const language of ['zh_hans', 'zh_hant', 'en']) test(`real ScopeHeader ${language} labels and sort callback flow through the production dropdown`, () => {
  const t = makeTranslator(language), changes = [];
  const Header = evaluate(header, { 'react/jsx-runtime': jsxRuntime, 'lucide-react': { ArrowLeft: 'ArrowLeft' }, './ToolbarSelect': { __esModule: true, default: 'ToolbarSelect' } }).default;
  const tree = Header({ t, title: 'Library', count: 2, countLabel: 'items', sort: 'updated_desc', onSort: value => changes.push(value) });
  const control = descendants(tree).find(node => node.type === 'ToolbarSelect');
  assert.equal(control.props.label, t('sortChip'));
  assert.deepEqual(control.props.options.map(option => option.value), ['updated_desc', 'created_desc', 'created_asc', 'title_asc', 'title_desc', 'source_asc', 'model_asc']);
  const h = harness(control.props); h.open(); h.key('End');
  assert.deepEqual(changes, []);
  h.key('Enter'); assert.deepEqual(changes, ['model_asc']);
  assert.ok(content(h.trigger()).includes(t('sortByModel'))); h.unmount();
});
