import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/components/TrashModal.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const item = { id: 'synthetic-trash', title: 'Synthetic item', deleted_at: '2026-01-01T12:00:00Z', first_image: { thumb_path: 'thumbs/synthetic.webp' } };
function descendants(node) { if (!node || typeof node !== 'object') return []; return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(descendants)]; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(t, overrides = {}) {
  const slots = [], effects = [], events = { lists: [], restored: [], purged: [], changed: 0, closed: 0 };
  let cursor = 0, dirty = false, tree, unmounted = false, escape;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { assert.equal(unmounted, false, 'no local update after unmount'); slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } },
  };
  const api = {
    items: async params => { events.lists.push(params); return { items: events.restored.length || events.purged.length ? [] : [item], total: events.restored.length || events.purged.length ? 0 : 1 }; },
    restoreItem: async id => { events.restored.push(id); return item; },
    permanentlyDeleteItem: async id => { events.purged.push(id); return item; },
    ...overrides,
  };
  const jsx = (type, props) => ({ type, props });
  const deps = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../api/client': { api, mediaUrl: path => `/media/${path}` },
    '../hooks/useModalFocus': { useModalFocus: close => { escape = close; return { containerRef: {}, handleModalKeyDown() {} }; } },
    '../utils/images': { imageThumbnailPath: image => image?.thumb_path || '' }, './TrashModal.css': {},
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => { assert.ok(name in deps, name); return deps[name]; }, module, module.exports);
  function render() { cursor = 0; dirty = false; tree = module.exports.default({ uiLanguage: 'en', onChanged: () => events.changed++, onClose: () => events.closed++ }); effects.splice(0).forEach(effect => effect()); }
  async function flush() { for (let i = 0; i < 25; i++) { if (dirty && !unmounted) render(); await Promise.resolve(); } if (dirty && !unmounted) render(); }
  function unmount() { slots.forEach(slot => slot?.cleanup?.()); unmounted = true; }
  render(); t.after(() => { if (!unmounted) unmount(); });
  const find = (type, predicate = () => true) => descendants(tree).find(node => node.type === type && predicate(node.props))?.props;
  const button = label => find('button', props => props['aria-label'] === label || props.children === label);
  return { events, flush, find, button, unmount, escape: () => escape(), get tree() { return tree; } };
}

test('trash loads only trashed items and renders thumbnail, title and deletion time', async t => {
  const h = harness(t); await h.flush();
  assert.deepEqual(h.events.lists, [{ trashed: true, limit: 50, offset: 0, sort: 'updated_desc' }]);
  assert.equal(h.find('img').src, '/media/thumbs/synthetic.webp');
  assert.equal(h.find('strong').children, item.title);
  assert.ok(h.find('small').children.join('').includes('Moved to trash'));
  assert.deepEqual(h.events.restored, []); assert.deepEqual(h.events.purged, []);
});

test('restoring an item removes it from trash and refreshes the application without purging', async t => {
  const h = harness(t); await h.flush();
  h.button(`Restore：${item.title}`).onClick(); await h.flush();
  assert.deepEqual(h.events.restored, [item.id]); assert.deepEqual(h.events.purged, []);
  assert.equal(h.events.changed, 1); assert.equal(h.events.lists.length, 2);
  assert.equal(h.find('p', props => props.className === 'library-trash-empty').children, 'Trash is empty');
});

test('permanent deletion requires a separate explicit confirmation; cancelling never calls the API', async t => {
  const h = harness(t); await h.flush();
  h.button(`Delete permanently：${item.title}`).onClick(); await h.flush();
  assert.ok(h.find('section', props => props.role === 'alertdialog'));
  assert.match(h.find('p', props => props.id === 'library-trash-confirm-warning').children, /Image files remain on disk.*does not immediately free storage/);
  assert.deepEqual(h.events.purged, []);
  h.button('Cancel').onClick(); await h.flush();
  assert.equal(h.find('section', props => props.role === 'alertdialog'), undefined);
  assert.deepEqual(h.events.purged, []);
  h.button(`Delete permanently：${item.title}`).onClick(); await h.flush();
  h.button('Confirm permanent deletion').onClick(); await h.flush();
  assert.deepEqual(h.events.purged, [item.id]); assert.deepEqual(h.events.restored, []);
  assert.equal(h.events.changed, 1);
});

test('Escape cancels permanent-delete confirmation before it can close the trash', async t => {
  const h = harness(t); await h.flush();
  h.button(`Delete permanently：${item.title}`).onClick(); await h.flush();
  h.escape(); await h.flush();
  assert.equal(h.events.closed, 0); assert.deepEqual(h.events.purged, []);
  h.escape(); assert.equal(h.events.closed, 1);
});

test('failed mutation keeps the item visible and shows a generic error without exposing server details', async t => {
  const h = harness(t, { restoreItem: async () => { throw new Error('secret connection token'); } }); await h.flush();
  h.button(`Restore：${item.title}`).onClick(); await h.flush();
  assert.equal(h.find('strong').children, item.title);
  assert.equal(h.find('p', props => props.className === 'library-trash-error').children, 'The action could not be completed. Please retry.');
  assert.equal(h.events.changed, 0); assert.deepEqual(h.events.purged, []);
});

test('failed list can be retried without mutations', async t => {
  let count = 0;
  const h = harness(t, { items: async () => { if (++count === 1) throw Error('private'); return { items: [item], total: 1 }; } }); await h.flush();
  assert.ok(h.find('p', props => props.role === 'alert'));
  h.button('Retry').onClick(); await h.flush();
  assert.equal(h.find('strong').children, item.title); assert.deepEqual(h.events.purged, []);
});

test('load more requests the next offset and deduplicates repeated rows', async t => {
  const requests = [];
  const h = harness(t, { items: async params => { requests.push(params); return params.offset ? { items: [item, { ...item, id: 'second', title: 'Second' }], total: 2 } : { items: [item], total: 2 }; } }); await h.flush();
  h.button('Load more').onClick(); await h.flush();
  assert.equal(requests[1].offset, 1);
  assert.equal(descendants(h.tree).filter(n => n.type === 'li').length, 2);
});

test('late list response cannot update an unmounted trash modal', async t => {
  const pending = deferred(), h = harness(t, { items: () => pending.promise });
  h.unmount(); pending.resolve({ items: [item], total: 1 }); await h.flush();
  assert.equal(h.events.changed, 0);
});

test('pending restore rejects duplicate callback submissions and prevents closing', async t => {
  const pending = deferred(), ids = [];
  const h = harness(t, { restoreItem: id => { ids.push(id); return pending.promise; } }); await h.flush();
  const action = h.button(`Restore：${item.title}`).onClick;
  action(); action(); await h.flush(); h.escape();
  assert.deepEqual(ids, [item.id]); assert.equal(h.events.closed, 0);
  assert.equal(h.button(`Restore：${item.title}`).disabled, true);
  pending.resolve(item); await h.flush(); assert.equal(h.events.changed, 1);
});
