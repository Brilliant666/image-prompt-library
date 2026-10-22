import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const app = await readFile(new URL('../frontend/src/App.tsx', import.meta.url), 'utf8');
// Execute the actual navigation callback with controllable browser scheduling.
const callback = ts.transpileModule(app.slice(app.indexOf('const updateView ='), app.indexOf('const updateSort =')), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const cleanup = app.match(/useEffect\(\(\) => \(\) => \{(\s*viewNavigationRunRef[\s\S]*?)\}, \[\]\);/)[1];
function harness(initial, { native = true, reduced = false } = {}) {
  const transitions = [], commits = [], animations = [], frames = [], timers = new Map(), storage = new Map(), scrolls = [];
  const dataset = {};
  const document = { documentElement: { dataset, removeAttribute: () => delete dataset.viewTransition } };
  if (native) document.startViewTransition = update => {
    let finish;
    const transition = { update, finished: new Promise(resolve => { finish = resolve; }), finish: () => finish(), skipped: false, skipTransition() { this.skipped = true; } };
    transitions.push(transition);
    return transition;
  };
  const window = {
    scrollY: 480, matchMedia: () => ({ matches: reduced }),
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    scrollTo: value => scrolls.push(value),
    setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const refs = { viewScroll: { current: { cards: 230, gallery: 60 } }, viewNavigationRunRef: { current: 0 } };
  const deps = {
    ...refs, window, document, VIEW_STORAGE_KEY: 'view',
    requestAnimationFrame: callback => frames.push(callback), flushSync: callback => callback(),
    cancelPendingEdit() {}, setGalleryQueueOpen() {}, setBatchActionDialog() {}, setSelectionActionsOpen() {},
    setView: value => { commits.push(value); current = value; },
    setViewTransition: value => animations.push(value),
  };
  let current = initial;
  return { transitions, commits, animations, frames, timers, storage, scrolls, dataset, refs,
    navigate(next) { const args = { ...deps, view: current }; new Function(...Object.keys(args), callback + '; return updateView;')(...Object.values(args))(next); },
    frame() { frames.splice(0).forEach(callback => callback()); },
    unmount() { new Function('viewNavigationRunRef', cleanup)(refs.viewNavigationRunRef); },
  };
}

test('Gallery and Agent navigation reveals retained workspaces without snapshots or animation timers', () => {
  for (const [from, to] of [['gallery', 'cards'], ['cards', 'gallery'], ['gallery', 'explore'], ['explore', 'gallery'], ['agent', 'cards'], ['cards', 'agent']]) {
    for (const native of [true, false]) {
      const h = harness(from, { native });
      h.navigate(to);
      assert.deepEqual(h.commits, [to]);
      assert.equal(h.transitions.length, 0);
      assert.equal(h.timers.size, 0);
      assert.ok(h.animations.every(value => value === undefined));
      assert.equal(h.storage.get('view'), to);
      assert.equal(h.refs.viewScroll.current[from], 480);
      h.frame();
      assert.equal(h.scrolls.length, 1);
      assert.equal(h.scrolls[0].top, to === 'cards' ? 230 : to === 'gallery' ? 60 : 0);
    }
  }
});

test('Explore and Library switch immediately without overlapping header snapshots or fallback animations', () => {
  for (const [from, to] of [['cards', 'explore'], ['explore', 'cards']]) {
    for (const native of [true, false]) for (const reduced of [true, false]) {
      const h = harness(from, { native, reduced });
      h.navigate(to);
      assert.deepEqual(h.commits, [to]);
      assert.equal(h.transitions.length, 0);
      assert.equal(h.timers.size, 0);
      assert.ok(h.animations.every(value => value === undefined));
      h.frame();
      assert.deepEqual(h.scrolls, [{ top: to === 'cards' ? 230 : 0, behavior: 'instant' }]);
    }
  }
});

test('rapid navigation ignores an older scroll frame without deferring view changes', () => {
  const h = harness('cards');
  h.navigate('explore');
  h.navigate('gallery');
  h.frame();
  assert.deepEqual(h.commits, ['explore', 'gallery']);
  assert.equal(h.transitions.length, 0);
  assert.equal(h.storage.get('view'), 'gallery');
  assert.deepEqual(h.scrolls, [{ top: 60, behavior: 'instant' }]);
  assert.equal(h.dataset.viewTransition, undefined);
});

test('browsers without native transitions also ignore older scroll frames', () => {
  const h = harness('cards', { native: false });
  h.navigate('explore');
  h.navigate('gallery');
  h.frame();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.scrolls, [{ top: 60, behavior: 'instant' }]);
  assert.equal(h.animations.at(-1), undefined);
});

test('rapidly returning to Library restores its recorded position only once', () => {
  const h = harness('cards');
  h.navigate('explore');
  h.navigate('cards');
  h.frame();
  assert.equal(h.transitions.length, 0);
  assert.deepEqual(h.commits, ['explore', 'cards']);
  assert.equal(h.storage.get('view'), 'cards');
  assert.deepEqual(h.scrolls, [{ top: 480, behavior: 'instant' }]);
});

test('selecting the active view does not reset its scroll or schedule another navigation', () => {
  const h = harness('cards');
  h.navigate('cards');
  h.frame();
  assert.deepEqual(h.commits, []);
  assert.deepEqual(h.scrolls, []);
  assert.equal(h.storage.size, 0);
});

test('unmounting App invalidates a queued scroll restoration', () => {
  const h = harness('explore');
  h.navigate('cards');
  h.unmount();
  h.frame();
  assert.deepEqual(h.commits, ['cards']);
  assert.deepEqual(h.scrolls, []);
});
