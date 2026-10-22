import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(path) {
  const source = (await readFile(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8'))
    .replace('import.meta.env.VITE_APP_VERSION', '""');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
function evaluate(code, dependencies, globals = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
const [appCode, topBarCode, i18nCode, searchSortCode] = await Promise.all([
  compile('App.tsx'), compile('components/TopBar.tsx'), compile('utils/i18n.ts'), compile('utils/searchSort.ts'),
]);
const i18n = evaluate(i18nCode, {}), searchSort = evaluate(searchSortCode, {});
const jsx = (type, props) => ({ type, props });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' };
const icons = new Proxy({}, { get: (_, name) => name });
const TopBar = evaluate(topBarCode, {
  'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
  '../assets/header-logo.png': { __esModule: true, default: 'synthetic-logo' },
  './ViewToggle': { __esModule: true, default: 'ViewToggle' }, './SearchScope.css': {},
}).default;
function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(descendants)];
}
function content(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(content).join('');
  return typeof node === 'object' ? content(node.props?.children) : String(node);
}
const collection = {
  id: 'synthetic-portraits', name: 'Portraits fallback', count: 2, preview_images: [],
  names: { en: 'Portraits', zh_hans: '环境人像', zh_hant: '環境人像' },
};

// Keep App's real state and callbacks; replace only the API, browser and unrelated child views.
function harness(language = 'en') {
  const slots = [], effects = [], queries = [];
  let cursor = 0, dirty = false, tree;
  const storage = new Map([
    ['image-prompt-library.ui_language', language], ['image-prompt-library.view_mode.v2', 'cards'],
    ['ai-provider', 'synthetic-provider'],
  ]);
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    addEventListener() {}, removeEventListener() {}, scrollY: 0, scrollTo() {},
    matchMedia: () => ({ matches: true }), setTimeout: () => 1, clearTimeout() {},
  };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => {
        const next = typeof value === 'function' ? value(slots[i]) : value;
        dirty ||= !Object.is(next, slots[i]); slots[i] = next;
      }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(callback, deps) {
      const i = cursor++, previous = slots[i];
      if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) slots[i] = { deps, value: callback() };
      return slots[i].value;
    },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(callback, deps) {
      const i = cursor++, previous = slots[i];
      if (!previous || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
        slots[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = callback(); });
      }
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const dependencies = {
    react: hooks, 'react-dom': { flushSync: callback => callback() }, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons,
    './api/client': { isDemoMode: false, api: {
      clusters: async () => [collection], items: async () => ({ items: [], total: 2 }), tags: async () => [],
      config: async () => ({ version: 'synthetic' }), updateStatus: async () => ({ update_available: false }),
    } },
    './utils/localPreferences': { readLocalPreferences: () => ({}), saveLocalPreferences() {} },
    './hooks/useDebouncedValue': { useDebouncedValue: value => value },
    './hooks/useItemsQuery': { useItemsQuery(q, clusterId, _unused, viewLimit, _reloadKey, sort) {
      const scope = { q, clusterId, viewLimit, sort }; queries.push(scope);
      return { data: { items: [], total: 0 }, loading: false, initialLoading: false, dataScope: scope };
    } },
    './hooks/useGalleryTitleUpdates': { useGalleryTitleUpdates: () => () => {} },
    './hooks/useModalFocus': { useModalFocus: () => ({ containerRef: {}, handleModalKeyDown() {} }) },
    './utils/clipboard': { copyTextToClipboard() {} },
    './utils/defaultAiProvider': { DEFAULT_AI_PROVIDER_STORAGE_KEY: 'ai-provider', resolveDefaultAiProvider: value => value, isAiProvider: () => true },
    './utils/demoTitles': { localizedDemoTitle: item => item.title },
    './utils/appearance': { loadAppearance: () => 'pure_white', applyAppearance() {} },
    './utils/i18n': i18n,
    './utils/prompts': { normalizePromptLanguage: () => 'en' },
    './utils/searchSort': searchSort,
    './utils/quickCaptureLabels': { quickCaptureLabels: () => ({ heading: 'Capture' }) },
  };
  for (const name of ['TopBar', 'FiltersPanel', 'ExploreView', 'CardsView', 'ItemDetailModal', 'ItemEditorModal', 'TrashModal', 'QuickCaptureModal', 'gallery/GalleryWorkspace', 'agent/AgentWorkspace', 'ConfigPanel', 'BatchActionDialog']) {
    dependencies[`./components/${name}`] = { __esModule: true, default: name, trashLabels: () => ({ title: 'Trash' }) };
  }
  const App = evaluate(appCode, dependencies, {
    window, location: { search: '' }, requestAnimationFrame: callback => callback(),
    document: { documentElement: { dataset: {}, removeAttribute() {} }, addEventListener() {}, removeEventListener() {} },
  }).default;
  function render() { cursor = 0; dirty = false; tree = App(); effects.splice(0).forEach(effect => effect()); }
  async function flush() {
    for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); }
    assert.equal(dirty, false, 'App state must settle');
  }
  const props = name => descendants(tree).find(node => node.type === name)?.props;
  const toolbarNodes = () => descendants(TopBar(props('TopBar')));
  const clearButton = () => toolbarNodes().find(node => node.props?.className === 'collection-scope-clear');
  render();
  return {
    flush, props, toolbarNodes, clearButton,
    query: () => queries.at(-1),
    chip: () => toolbarNodes().find(node => node.props?.className === 'collection-scope-label'),
    structuredChips: () => toolbarNodes().filter(node => node.props?.className === 'chip query-filter-chip').map(content),
    async chooseCollection() { props('FiltersPanel').onSelect(collection); await flush(); },
    async switchView(view) { props('TopBar').onView(view); await flush(); },
    async type(query) { toolbarNodes().find(node => node.type === 'input').props.onChange({ target: { value: query } }); await flush(); },
    async clearCollection() { clearButton().props.onClick(); await flush(); },
  };
}

test('Collection scope is visible with empty text in both library views, with a localized accessible clear action', async () => {
  for (const [language, name, clearLabel] of [
    ['en', 'Portraits', 'Clear Collection filter'], ['zh_hans', '环境人像', '清除 Collection 筛选'], ['zh_hant', '環境人像', '清除 Collection 篩選'],
  ]) {
    const h = harness(language); await h.flush(); await h.chooseCollection();
    for (const view of ['cards', 'explore']) {
      await h.switchView(view);
      assert.equal(h.props('TopBar').q, '');
      assert.equal(content(h.chip()), `Collection: ${name}`);
      assert.equal(h.clearButton().props['aria-label'], `${clearLabel}: ${name}`);
      assert.equal(h.clearButton().props.type, 'button');
      assert.equal(h.query().clusterId, collection.id);
    }
  }
});

test('clearing the Collection through its rendered button keeps text, structured chips, sorting and the current view', async () => {
  for (const view of ['cards', 'explore']) {
    const h = harness(); await h.flush(); await h.chooseCollection(); await h.switchView(view);
    await h.type('portrait tag:studio sort:title-desc');
    assert.deepEqual(h.structuredChips(), ['tag:studio']);
    await h.clearCollection();
    assert.equal(h.props('TopBar').q, 'portrait tag:studio sort:title-desc');
    assert.equal(h.props('TopBar').view, view);
    assert.equal(h.query().q, 'portrait tag:studio');
    assert.equal(h.query().sort, 'title_desc');
    assert.equal(h.query().clusterId, undefined);
    assert.equal(h.props('FiltersPanel').selected, undefined);
    assert.equal(h.chip(), undefined);
    assert.deepEqual(h.structuredChips(), ['tag:studio']);
  }
});

test('clearing only search text keeps Collection scope, selected sort and view; switching views shares the same query', async () => {
  const h = harness(); await h.flush(); await h.chooseCollection();
  h.props('CardsView').onSort('created_asc'); await h.flush();
  await h.type('portrait tag:studio');
  await h.switchView('explore');
  assert.equal(h.props('TopBar').q, 'portrait tag:studio');
  assert.deepEqual(h.structuredChips(), ['tag:studio']);
  assert.equal(h.query().clusterId, collection.id);
  await h.type('');
  assert.equal(h.query().q, '');
  assert.equal(h.query().clusterId, collection.id);
  assert.equal(h.query().sort, 'created_asc');
  assert.equal(h.props('TopBar').view, 'explore');
  assert.equal(content(h.chip()), 'Collection: Portraits');
  assert.deepEqual(h.structuredChips(), []);
  await h.switchView('cards');
  assert.equal(h.props('TopBar').q, '');
  assert.equal(h.props('CardsView').clusterName, 'Portraits');
  assert.equal(h.props('CardsView').sort, 'created_asc');
});

test('Gallery and Agent hide scope controls, and returning to a library view retains the shared search', async () => {
  const h = harness(); await h.flush(); await h.chooseCollection(); await h.type('portrait');
  for (const view of ['gallery', 'agent']) {
    await h.switchView(view);
    assert.equal(h.chip(), undefined);
    assert.equal(h.clearButton(), undefined);
    assert.equal(h.toolbarNodes().find(node => node.props?.className === 'library-tools').props.hidden, true);
  }
  await h.switchView('explore');
  assert.equal(h.props('TopBar').q, 'portrait');
  assert.equal(content(h.chip()), 'Collection: Portraits');
  assert.equal(h.query().clusterId, collection.id);
});

test('without a selected Collection, the toolbar keeps structured search chips and has no clear-scope action', async () => {
  const h = harness(); await h.flush(); await h.type('tag:studio has:image');
  assert.equal(h.clearButton(), undefined);
  assert.equal(h.chip(), undefined);
  assert.deepEqual(h.structuredChips(), ['tag:studio', 'has:image']);
});
