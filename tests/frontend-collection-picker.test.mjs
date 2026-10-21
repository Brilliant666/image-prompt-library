import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
function evaluate(js, dependencies, document = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'document', js)(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, document);
  return module.exports;
}
const component = await compile('../frontend/src/components/CollectionPicker.tsx');
const { makeTranslator } = evaluate(await compile('../frontend/src/utils/i18n.ts'), {});
const collections = Array.from({ length: 12 }, (_, index) => ({
  id: `collection-${index}`, name: `Collection ${index}`, count: index, preview_images: [],
  names: index === 0 ? { en: 'Portraits', zh_hans: '环境人像', zh_hant: '環境人像' } : {},
}));
function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(descendants)];
}
function content(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(content).join('');
  return content(node.props?.children);
}
function harness(overrides = {}) {
  const slots = [], effects = new Map(), pending = [], listeners = new Map(), changes = [];
  let cursor = 0, dirty = false, tree, elements = [];
  let props = { value: { id: collections[0].id, name: collections[0].name }, collections, t: makeTranslator('zh_hans'), ...overrides };
  const document = {
    activeElement: null,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useId() { const i = cursor++; return `synthetic-id-${i}`; },
    useEffect(callback, dependencies) {
      const i = cursor++, previous = effects.get(i);
      if (previous && dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))) return;
      pending.push(() => { previous?.cleanup?.(); effects.set(i, { dependencies, cleanup: callback() }); });
    },
  };
  const jsx = (type, props) => ({ type, props });
  const { default: Picker } = evaluate(component, {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }), './CollectionPicker.css': {},
  }, document);
  function render() {
    cursor = 0; dirty = false;
    tree = Picker({ ...props, onChange: value => { changes.push(value); props = { ...props, value }; dirty = true; } });
    const oldElements = elements;
    elements = descendants(tree).map((node, index) => {
      const element = oldElements[index]?.node.type === node.type ? oldElements[index] : {};
      element.node = node;
      element.focus = () => { document.activeElement = element; };
      element.contains = target => target === element || (node === tree && elements.includes(target));
      element.querySelectorAll = () => elements.filter(candidate => candidate.node.props?.className?.split(' ').includes('collection-picker-option'));
      if (node.props?.ref) node.props.ref.current = element;
      return element;
    });
    while (pending.length) pending.shift()();
  }
  function flush() { for (let i = 0; dirty && i < 20; i++) render(); assert.equal(dirty, false, 'Hooks must settle'); }
  const nodes = () => descendants(tree);
  const trigger = () => nodes().find(node => node.props?.className === 'collection-picker-trigger');
  const search = () => nodes().find(node => node.type === 'input');
  const options = () => nodes().filter(node => node.props?.className?.split(' ').includes('collection-picker-option'));
  const open = () => { trigger().props.onClick(); flush(); };
  const query = text => { search().props.onChange({ target: { value: text } }); flush(); };
  const choose = text => { const option = options().find(node => content(node) === text); assert.ok(option, `Missing option ${text}`); option.props.onClick(); flush(); };
  const key = (name, nativeEvent = {}) => {
    const result = { prevented: false, stopped: false };
    tree.props.onKeyDown({ key: name, nativeEvent, preventDefault() { result.prevented = true; }, stopPropagation() { result.stopped = true; } });
    flush(); return result;
  };
  render(); flush();
  return {
    changes, document, listeners, trigger, search, options, open, query, choose, key,
    root: () => tree, nodes, flush,
    update(next) { props = { ...props, ...next }; dirty = true; flush(); },
    outside() { listeners.get('pointerdown')?.({ target: {} }); flush(); },
    unmount() { for (const effect of effects.values()) effect.cleanup?.(); },
  };
}

test('opening the production picker shows all candidates rather than filtering by the selected name or limiting to eight', () => {
  const h = harness();
  h.open();
  assert.equal(h.options().length, 13);
  assert.equal(h.search().props.value, '');
  assert.ok(h.options().some(option => content(option) === 'Collection 11'));
  assert.deepEqual(h.changes, []);
  h.choose('Collection 11');
  assert.deepEqual(h.changes, [{ id: 'collection-11', name: 'Collection 11' }]);
  assert.equal(h.trigger().props['aria-expanded'], false);
  assert.equal(content(h.trigger()), 'Collection 11');
});

test('search includes translated names and an existing exact alias never offers duplicate creation', () => {
  const h = harness();
  h.open(); h.query('  環境人像  ');
  assert.deepEqual(h.options().map(content), ['未分类', 'Collection 0']);
  h.choose('Collection 0');
  assert.deepEqual(h.changes, [{ id: 'collection-0', name: 'Collection 0' }]);
  h.open(); h.query('PORTRAITS');
  assert.equal(h.options().some(option => option.props.className.includes('collection-picker-create')), false);
});

test('typing a new name does not change the draft until explicit creation, and only returns a trimmed selection', () => {
  const h = harness();
  h.open(); h.query('  New synthetic collection  ');
  assert.deepEqual(h.changes, []);
  assert.equal(content(h.trigger()), 'Collection 0');
  h.choose('新建「New synthetic collection」');
  assert.deepEqual(h.changes, [{ id: null, name: 'New synthetic collection' }]);
  assert.equal(content(h.trigger()), 'New synthetic collection');
});

test('Escape and outside dismissal discard search without changing selection; reopening starts with all candidates', () => {
  const h = harness();
  h.open(); h.query('Uncommitted name');
  assert.deepEqual(h.key('Escape'), { prevented: true, stopped: true });
  assert.equal(h.trigger().props['aria-expanded'], false);
  assert.equal(h.document.activeElement.node.props.className, 'collection-picker-trigger');
  assert.deepEqual(h.changes, []);
  h.open(); assert.equal(h.options().length, 13);
  h.query('Other name'); h.outside();
  assert.equal(h.trigger().props['aria-expanded'], false);
  assert.deepEqual(h.changes, []);
  assert.equal(h.listeners.size, 0);
});

test('unassigned is an explicit choice and a selected collection missing from the current list is preserved', () => {
  const h = harness({ value: { id: 'missing', name: 'Historical collection' }, collections: [] });
  h.open();
  assert.deepEqual(h.options().map(content), ['未分类', 'Historical collection']);
  assert.equal(h.options()[1].props['aria-pressed'], true);
  h.choose('未分类');
  assert.deepEqual(h.changes, [{ id: null, name: '' }]);
  assert.equal(content(h.trigger()), '未分类');
});

test('arrow keys move option focus, and disabling an open picker closes it and removes outside listeners', () => {
  const h = harness(); h.open();
  assert.equal(h.document.activeElement.node.type, 'input');
  h.key('ArrowDown'); assert.equal(content(h.document.activeElement.node), '未分类');
  h.key('ArrowDown'); assert.equal(content(h.document.activeElement.node), 'Collection 0');
  h.key('ArrowUp'); assert.equal(content(h.document.activeElement.node), '未分类');
  h.update({ disabled: true });
  assert.equal(h.trigger().props.disabled, true);
  assert.equal(h.trigger().props['aria-expanded'], false);
  assert.equal(h.listeners.size, 0);
  assert.deepEqual(h.changes, []);
  h.unmount();
});

for (const [signal, nativeEvent] of [
  ['isComposing', { isComposing: true }],
  ['legacy keyCode 229', { isComposing: false, keyCode: 229 }],
]) {
  test(`IME ${signal} leaves candidate navigation and confirmation to the input without bubbling to the editor`, () => {
    const h = harness(); h.open(); h.query('环境');
    const search = h.document.activeElement;
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      assert.deepEqual(h.key(key, nativeEvent), { prevented: false, stopped: true }, key);
      assert.equal(h.document.activeElement, search, `${key} must not move input focus`);
      assert.equal(h.trigger().props['aria-expanded'], true, `${key} must not dismiss the picker`);
      assert.equal(h.search().props.value, '环境');
      assert.deepEqual(h.changes, []);
    }
    // The guard must not suppress ordinary navigation after IME confirmation.
    assert.deepEqual(h.key('ArrowDown'), { prevented: true, stopped: true });
    assert.equal(content(h.document.activeElement.node), '未分类');
    h.unmount();
  });
}

test('composition lifecycle preserves search focus when the key event lacks an IME flag and releases it after composition ends', () => {
  const h = harness(); h.open();
  h.search().props.onCompositionStart(); h.query('环境');
  const search = h.document.activeElement;
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
    assert.deepEqual(h.key(key), { prevented: false, stopped: true });
    assert.equal(h.document.activeElement, search);
    assert.equal(h.trigger().props['aria-expanded'], true);
  }
  h.search().props.onCompositionEnd();
  assert.deepEqual(h.key('ArrowDown'), { prevented: true, stopped: true });
  assert.equal(content(h.document.activeElement.node), '未分类');
  assert.deepEqual(h.key('Escape'), { prevented: true, stopped: true });
  assert.equal(h.trigger().props['aria-expanded'], false);
  assert.deepEqual(h.changes, []);
  h.unmount();
});

test('closing during composition does not leave keyboard navigation locked when the picker reopens', () => {
  const h = harness(); h.open();
  h.search().props.onCompositionStart(); h.outside(); h.open();
  assert.deepEqual(h.key('ArrowDown'), { prevented: true, stopped: true });
  assert.equal(content(h.document.activeElement.node), '未分类');
  h.unmount();
});

for (const [language, unassigned, search, create] of [
  ['zh_hans', '未分类', '搜索或新建 Collection', '新建「Unique」'],
  ['zh_hant', '未分類', '搜尋或新建 Collection', '新建「Unique」'],
  ['en', 'Unassigned', 'Search or create a Collection', 'Create “Unique”'],
]) {
  test(`the production picker renders ${language} labels and explicit creation`, () => {
    const h = harness({ t: makeTranslator(language), value: { id: null, name: '' } });
    assert.equal(content(h.trigger()), unassigned);
    h.open(); assert.equal(h.search().props['aria-label'], search);
    h.query('Unique'); assert.ok(h.options().some(option => content(option) === create));
    h.unmount(); assert.equal(h.listeners.size, 0);
  });
}
