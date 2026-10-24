import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const hookJs = await compile('../frontend/src/hooks/useItemsQuery.ts');
const views = {
  cards: await compile('../frontend/src/components/CardsView.tsx'),
  explore: await compile('../frontend/src/components/ExploreView.tsx'),
};
const item = index => ({ id: `item-${index}`, title: `Synthetic ${index}`, tags: [], prompts: [], first_image: null });
const page = (offset, count = 100, total = 1001) => ({ items: Array.from({ length: count }, (_, i) => item(offset + i)), offset, limit: 100, total });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}

function harness(t, view = 'cards', initial = {}) {
  const slots = [], effects = [], calls = [];
  let cursor = 0, dirty = false, tree, query;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (get, deps) => {
    const i = cursor++;
    if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: get() };
    return slots[i].value;
  };
  const effect = (callback, deps) => {
    const i = cursor++, old = slots[i];
    if (!old || !same(old.deps, deps)) {
      slots[i] = { deps };
      effects.push(() => { old?.cleanup?.(); slots[i].cleanup = callback(); });
    }
  };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: memo, useCallback: (value, deps) => memo(() => value, deps), useEffect: effect, useLayoutEffect: effect,
  };
  const jsx = (type, props) => ({ type, props });
  const deps = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../api/client': { mediaUrl: value => value, api: { items(params) { const pending = deferred(); calls.push({ params, ...pending }); return pending.promise; } } },
    '../utils/searchSort': { DEFAULT_ITEM_SORT: 'updated_desc' },
    './ItemCard': 'ItemCard', './ScopeHeader': 'ScopeHeader', './ToolbarSelect': 'ToolbarSelect',
    './LibraryCardLayout.css': {}, 'lucide-react': { ChevronDown: 'ChevronDown' },
  };
  function load(js) { const module = { exports: {} }; new Function('require', 'module', 'exports', js)(name => { assert.ok(name in deps, name); return deps[name]; }, module, module.exports); return module.exports; }
  const { useItemsQuery } = load(hookJs), View = load(views[view]).default;
  const props = { q: 'Synthetic', cluster: undefined, tag: undefined, limit: 100, reload: 0, sort: 'updated_desc', ...initial };
  function render() {
    cursor = 0; dirty = false;
    query = useItemsQuery(props.q, props.cluster, props.tag, props.limit, props.reload, props.sort);
    tree = View({
      t: key => key, items: query.data.items, total: query.data.total, loading: query.loading,
      hasMore: query.hasMore, loadingMore: query.loadingMore, loadMoreError: query.loadMoreError, onLoadMore: query.loadMore,
      hasActiveSearch: Boolean(props.q), searchQuery: props.q, sort: props.sort, clusters: [], onSort() {},
      onOpenCollection() {}, onClearCluster() {}, onOpen() {}, onCopyPrompt() {},
    });
    effects.splice(0).forEach(run => run());
  }
  const dispose = () => slots.forEach(slot => slot?.cleanup?.());
  const more = () => nodes(tree).find(value => value.type === 'button' && value.props?.className === 'explore-load-more')?.props;
  render(); t.after(dispose);
  return {
    calls, more, dispose, query: () => query,
    cards: () => nodes(tree).filter(value => value.type === 'ItemCard').map(value => value.props.item.id),
    async flush() { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } },
    update(values) { Object.assign(props, values); render(); },
  };
}

for (const view of ['cards', 'explore']) {
  test(`${view} continues beyond 1000 through production load-more callbacks without eager requests`, async t => {
    const h = harness(t, view);
    assert.equal(h.calls.length, 1);
    h.calls[0].resolve(page(0)); await h.flush();
    assert.equal(h.calls.length, 1, 'initial page must not fetch the full library');
    for (let offset = 100; offset <= 1000; offset += 100) {
      for (let i = 0; i < 4 && h.calls.length === offset / 100; i++) { assert.ok(h.more(), 'more remains available'); h.more().onClick(); await h.flush(); }
      assert.equal(h.calls.length, offset / 100 + 1);
      assert.equal(h.calls.at(-1).params.offset, offset);
      assert.equal(h.calls.at(-1).params.limit, 100);
      h.calls.at(-1).resolve(page(offset, offset === 1000 ? 1 : 100)); await h.flush();
    }
    while (h.more()) { h.more().onClick(); await h.flush(); }
    assert.equal(h.cards().length, 1001);
    assert.equal(new Set(h.cards()).size, 1001);
    assert.ok(h.cards().includes('item-1000'));
    assert.equal(h.query().hasMore, false);
  });
}

test('next-page failure keeps cards and retries the same offset only when requested', async t => {
  const h = harness(t);
  h.calls[0].resolve(page(0)); await h.flush();
  h.more().onClick(); h.more().onClick(); await h.flush();
  assert.equal(h.calls.length, 2, 'duplicate clicks share one request');
  h.calls[1].reject(Error('synthetic offline')); await h.flush();
  assert.equal(h.cards().length, 100);
  assert.equal(h.calls.length, 2);
  assert.ok(h.query().loadMoreError);
  h.more().onClick(); await h.flush();
  assert.equal(h.calls[2].params.offset, 100);
  h.calls[2].resolve(page(100)); await h.flush();
  assert.equal(h.cards().length, 200);
  assert.equal(h.query().loadMoreError, undefined);
});

test('filter, collection, sort and reload changes reject late pages and restart from zero', async t => {
  const h = harness(t, 'cards', { cluster: 'collection-a', tag: 'portrait' });
  h.calls[0].resolve(page(0)); await h.flush();
  h.query().loadMore(); await h.flush();
  const oldPage = h.calls[1];
  h.update({ q: 'new archived:true', cluster: 'collection-b', sort: 'title_asc' }); await h.flush();
  assert.deepEqual(h.calls[2].params, { q: 'new archived:true', cluster: 'collection-b', tag: 'portrait', sort: 'title_asc', limit: 100, offset: 0 });
  oldPage.resolve(page(100)); await h.flush();
  h.calls[2].resolve(page(500, 100, 300)); await h.flush();
  assert.equal(h.cards()[0], 'item-500');
  assert.equal(h.cards().length, 100);
  h.update({ reload: 1 }); await h.flush();
  assert.equal(h.calls[3].params.offset, 0);
  h.calls[3].resolve(page(700, 100, 100)); await h.flush();
  assert.equal(h.cards()[0], 'item-700');
  assert.equal(h.cards().length, 100);
});

test('duplicate records do not duplicate cards or prevent cursor progress; unmount ignores late pages', async t => {
  const h = harness(t);
  h.calls[0].resolve(page(0)); await h.flush();
  h.query().loadMore(); await h.flush();
  h.calls[1].resolve({ ...page(100), items: [item(99), ...page(101, 99).items] }); await h.flush();
  assert.equal(h.cards().length, 199);
  h.query().loadMore(); await h.flush();
  assert.equal(h.calls[2].params.offset, 200);
  h.dispose();
  h.calls[2].resolve(page(200)); await h.flush();
  assert.equal(h.query().data.items.length, 199);
});

async function loadTwoPages(h) {
  h.calls[0].resolve(page(0)); await h.flush();
  while (h.calls.length === 1) { h.more().onClick(); await h.flush(); }
  h.calls[1].resolve(page(100)); await h.flush();
  while (!h.cards().includes('item-150')) { h.more().onClick(); await h.flush(); }
}

for (const view of ['cards', 'explore']) {
  test(`${view} preserves the loaded window during a same-scope save refresh`, async t => {
    const h = harness(t, view, { sort: 'title_asc' });
    await loadTwoPages(h);
    const visibleBefore = h.cards();
    h.update({ reload: 1 }); await h.flush();
    assert.deepEqual(h.cards(), visibleBefore, 'pending refresh retains the browsing window');
    assert.equal(h.more().disabled, true, 'pause pagination while the current window is refreshed');
    h.calls[2].resolve(page(0)); await h.flush();
    assert.deepEqual(h.cards(), visibleBefore, 'do not publish only the first refreshed page');
    assert.equal(h.calls[3].params.offset, 100);
    assert.equal(h.calls[3].params.limit, 100, 'refresh uses bounded API pages');
    const secondPage = page(100);
    secondPage.items[50] = { ...secondPage.items[50], favorite: true, notes: 'Saved edit' };
    h.calls[3].resolve(secondPage); await h.flush();
    assert.deepEqual(h.cards(), visibleBefore);
    assert.equal(h.query().data.items.find(value => value.id === 'item-150').favorite, true);
    assert.equal(h.query().data.items.find(value => value.id === 'item-150').notes, 'Saved edit');
    assert.equal(h.query().loading, false);
    assert.equal(h.calls.length, 4, 'do not fetch pages beyond the loaded window');
    h.query().loadMore(); await h.flush();
    assert.equal(h.calls[4].params.offset, 200);
  });
}

test('partial refresh failure retains all old pages and retries the full loaded window', async t => {
  const h = harness(t);
  await loadTwoPages(h);
  h.update({ reload: 1 }); await h.flush();
  h.calls[2].resolve(page(0)); await h.flush();
  assert.ok(h.calls[3], 'refresh must include the second loaded page');
  h.calls[3].reject(Error('synthetic refresh offline')); await h.flush();
  assert.equal(h.query().data.items.length, 200);
  assert.ok(h.query().error);
  assert.equal(h.query().loading, false);
  assert.equal(h.query().hasMore, false, 'pause automatic pagination until the failed refresh is retried');
  h.query().loadMore(); await h.flush();
  assert.equal(h.calls.length, 4, 'do not append to a partially refreshed snapshot');
  h.update({ reload: 2 }); await h.flush();
  h.calls[4].resolve(page(0)); await h.flush();
  h.calls[5].resolve(page(100)); await h.flush();
  assert.equal(h.query().data.items.length, 200);
  assert.equal(h.query().error, undefined);
});

test('superseded refreshes and load-more responses cannot truncate or extend the current window', async t => {
  const h = harness(t);
  await loadTwoPages(h);
  h.query().loadMore(); await h.flush();
  const oldMore = h.calls[2];
  h.update({ reload: 1 }); await h.flush();
  h.calls[3].resolve(page(0)); await h.flush();
  const oldRefreshPage = h.calls[4];
  assert.ok(oldRefreshPage);
  h.update({ reload: 2 }); await h.flush();
  oldMore.resolve(page(200)); oldRefreshPage.resolve(page(100)); await h.flush();
  assert.equal(h.query().data.items.length, 200);
  h.calls[5].resolve(page(0)); await h.flush();
  assert.equal(h.calls[6].params.offset, 100);
  h.calls[6].resolve(page(100)); await h.flush();
  assert.equal(h.query().data.items.length, 200);
  assert.equal(h.query().loading, false);
});

test('changing scope during a window refresh resets to one page and rejects old results', async t => {
  const h = harness(t);
  await loadTwoPages(h);
  h.update({ reload: 1 }); await h.flush();
  h.calls[2].resolve(page(0)); await h.flush();
  const oldRefreshPage = h.calls[3];
  assert.ok(oldRefreshPage);
  h.update({ q: 'Other', cluster: 'other-collection', sort: 'title_asc' }); await h.flush();
  assert.equal(h.calls[4].params.offset, 0);
  h.calls[4].resolve(page(0, 100, 700)); await h.flush();
  oldRefreshPage.resolve(page(100)); await h.flush();
  assert.equal(h.query().data.items.length, 100);
  assert.equal(h.query().data.total, 700);
  assert.equal(h.calls.length, 5);
  assert.equal(h.query().dataScope.q, 'Other');
});

test('refresh handles deletions, deduplicates boundary shifts, and advances by the server window', async t => {
  const h = harness(t);
  await loadTwoPages(h);
  h.update({ reload: 1 }); await h.flush();
  h.calls[2].resolve(page(0, 100, 250)); await h.flush();
  assert.ok(h.calls[3]);
  h.calls[3].resolve({ ...page(100, 100, 250), items: [item(99), ...page(101, 99).items] }); await h.flush();
  assert.equal(h.query().data.items.length, 199);
  h.update({ reload: 2 }); await h.flush();
  h.calls[4].resolve(page(0, 100, 125)); await h.flush();
  h.calls[5].resolve(page(100, 25, 125)); await h.flush();
  assert.equal(h.query().data.items.length, 125);
  assert.equal(h.query().hasMore, false);
  assert.equal(h.query().data.total, 125);
});

test('refresh retains a window beyond 1000 without increasing API page size', async t => {
  const h = harness(t);
  h.calls[0].resolve(page(0)); await h.flush();
  for (let offset = 100; offset <= 1000; offset += 100) {
    h.query().loadMore(); await h.flush();
    h.calls.at(-1).resolve(page(offset, offset === 1000 ? 1 : 100)); await h.flush();
  }
  h.update({ reload: 1 }); await h.flush();
  for (let offset = 0; offset <= 1000; offset += 100) {
    assert.equal(h.calls.at(-1).params.offset, offset);
    assert.equal(h.calls.at(-1).params.limit, 100);
    assert.equal(h.query().data.items.length, 1001);
    h.calls.at(-1).resolve(page(offset, offset === 1000 ? 1 : 100)); await h.flush();
  }
  assert.equal(h.query().data.items.length, 1001);
  assert.equal(h.query().hasMore, false);
  assert.equal(h.calls.length, 22);
});

test('an empty refreshed page terminates the window even if total is temporarily stale', async t => {
  const h = harness(t);
  await loadTwoPages(h);
  h.update({ reload: 1 }); await h.flush();
  h.calls[2].resolve(page(0)); await h.flush();
  h.calls[3].resolve(page(100, 0)); await h.flush();
  assert.equal(h.query().data.items.length, 100);
  assert.equal(h.query().hasMore, false);
  assert.equal(h.query().loading, false);
  assert.equal(h.calls.length, 4);
});
