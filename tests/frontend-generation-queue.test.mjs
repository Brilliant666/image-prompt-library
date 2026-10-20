import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('../frontend/src/components/GenerationQueueDrawer.tsx', import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const componentJs = compile(await readFile(sourceUrl, 'utf8'));
const utilityModules = new Map();
async function utility(url) {
  if (utilityModules.has(url.href)) return utilityModules.get(url.href);
  const js = compile(await readFile(url, 'utf8'));
  const deps = {};
  for (const [, name] of js.matchAll(/require\("([^"]+)"\)/g)) deps[name] = await utility(new URL(`${name}.ts`, url));
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => deps[name], module, module.exports);
  utilityModules.set(url.href, module.exports);
  return module.exports;
}
const utilities = {};
for (const name of ['generationFailures', 'generationSets', 'generationSiblings']) {
  utilities[`../utils/${name}`] = await utility(new URL(`../utils/${name}.ts`, sourceUrl));
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const job = (id, extra = {}) => ({
  id, status: 'running', prompt_text: `Synthetic ${id}`, parameters: {}, metadata: {}, ...extra,
});
const result = (jobs, extra = {}) => ({
  jobs, total: 270, status_counts: { queued: 0, running: 4, succeeded: 94, accepted: 14, failed: 155, discarded: 3, cancelled: 0 },
  generation_sets: [], provider_queue_states: [], ...extra,
});

function harness(t, apiOverrides = {}, propOverrides = {}) {
  const slots = [], effects = [], calls = [], timers = new Map();
  let cursor = 0, dirty = false, tree, nextTimer = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (get, deps) => {
    const i = cursor++;
    if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: get() };
    return slots[i].value;
  };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => {
        const next = typeof value === 'function' ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
      }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo: memo, useCallback: (value, deps) => memo(() => value, deps),
    useEffect(effect, deps) {
      const i = cursor++, old = slots[i];
      if (!old || !same(old.deps, deps)) {
        slots[i] = { deps };
        effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
  };
  const window = {
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { throw Error('No rate limit countdown in these fixtures'); }, clearInterval() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: true }),
  };
  const jsx = (type, props) => ({ type, props });
  const deps = {
    ...utilities, react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'react-dom': { createPortal: node => node }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../api/client': { mediaUrl: value => value, api: {
      generationJobs(params) { const pending = deferred(); calls.push({ params, ...pending }); return pending.promise; },
      ...apiOverrides,
    } },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'document', componentJs)(
    name => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; },
    module, module.exports, window, undefined,
  );
  const props = {
    t: key => key, open: false, refreshKey: 0,
    onOpen: () => update({ open: true }), onClose: () => update({ open: false }),
    onOpenJob() {}, onOpenProviders() {},
    ...propOverrides,
  };
  function render() { cursor = 0; dirty = false; tree = module.exports.default(props); effects.splice(0).forEach(effect => effect()); }
  function update(value) { Object.assign(props, value); render(); }
  async function flush() { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } }
  const node = predicate => nodes(tree).find(value => predicate(value.props || {}, value.type))?.props;
  const dispose = () => slots.forEach(slot => slot?.cleanup?.());
  render(); t.after(dispose);
  return {
    calls, timers, flush, update, dispose,
    open() { node((props, type) => type === 'button' && props['aria-controls'] === 'generation-work-queue').onClick(); },
    close() { node((props, type) => type === 'button' && props['aria-label'] === 'close').onClick(); },
    rows: () => nodes(tree).filter(value => value.props?.className?.startsWith('generation-queue-row status-')),
    loading: () => Boolean(node(props => props.className === 'muted queue-loading')),
    activeSignal: () => Boolean(node(props => props['aria-label'] === 'queueActiveJobs')),
    button: label => node((props, type) => type === 'button' && (props['aria-label'] === label || props.children === label)),
    alert: () => node(props => props.role === 'alert')?.children,
    async poll() { const [id, callback] = timers.entries().next().value; timers.delete(id); await callback(); },
  };
}

test('closed summary never becomes a one-row detail page; opening waits for the first complete page', async t => {
  const h = harness(t);
  assert.equal(h.calls[0].params.limit, 1);
  h.calls[0].resolve(result([job('summary')]));
  await h.flush();
  h.open(); await h.flush();
  assert.equal(h.calls.at(-1).params.limit, 100);
  assert.equal(h.loading(), true);
  assert.equal(h.rows().length, 0);
  h.calls.at(-1).resolve(result(Array.from({ length: 100 }, (_, i) => job(`detail-${i}`))));
  await h.flush();
  assert.equal(h.loading(), false);
  assert.equal(h.rows().length, 100);
  h.close(); await h.flush();
  h.calls.at(-1).resolve(result([job('new-summary')]));
  await h.flush();
  h.open(); await h.flush();
  assert.equal(h.rows().length, 100, 'reopening immediately retains the full prior page');
  assert.equal(h.loading(), false);
  h.calls.at(-1).resolve(result([job('latest-detail')]));
  await h.flush();
  assert.equal(h.rows().length, 1, 'a completed detail read remains authoritative');
});

test('close/reopen and unmount invalidate late responses without losing the detail cache', async t => {
  const h = harness(t), oldSummary = h.calls[0];
  h.open(); await h.flush();
  const firstDetail = h.calls.at(-1);
  firstDetail.resolve(result([job('current')]));
  await h.flush();
  oldSummary.resolve(result([job('stale')]));
  await h.flush();
  assert.equal(h.rows()[0].props.children[0].props.children[1].props.children, 'Synthetic current');
  h.close(); await h.flush();
  const closedSummary = h.calls.at(-1);
  h.open(); await h.flush();
  closedSummary.reject(Error('stale summary failure'));
  await h.flush();
  assert.equal(h.alert(), undefined);
  h.dispose();
  h.calls.at(-1).resolve(result([job('after-unmount')]));
  await h.flush();
  assert.equal(h.rows()[0].props.children[0].props.children[1].props.children, 'Synthetic current');
});

test('cached active batch details do not keep closed polling alive after the latest summary becomes idle', async t => {
  const h = harness(t);
  h.open(); await h.flush();
  h.calls.at(-1).resolve(result([job('batch-member', {
    generation_group_id: 'batch', generation_group_index: 1, generation_group_size: 2,
  })], { generation_sets: [{ generation_group_id: 'batch', total: 2, remaining: 2, running: 2, queued: 0 }] }));
  await h.flush();
  assert.equal(h.timers.size, 1);
  h.close(); await h.flush();
  h.calls.at(-1).resolve(result([], {
    status_counts: { queued: 0, running: 0, succeeded: 2, accepted: 0, failed: 0, discarded: 0, cancelled: 0 },
    generation_sets: [],
  }));
  await h.flush();
  assert.equal(h.timers.size, 0, 'current summary, not cached batch remaining, controls polling');
  assert.equal(h.activeSignal(), false, 'closed summary also clears the active trigger indicator');
});

test('failed detail refresh retains cached rows and can recover on a later poll', async t => {
  const h = harness(t);
  h.open(); await h.flush();
  h.calls.at(-1).resolve(result([job('kept')]));
  await h.flush();
  h.update({ refreshKey: 1 }); await h.flush();
  h.calls.at(-1).reject(Error('Synthetic read failure'));
  await h.flush();
  assert.equal(h.rows().length, 1);
  assert.equal(h.alert(), 'Synthetic read failure');
  const poll = h.poll();
  h.calls.at(-1).resolve(result([job('recovered'), job('new')]));
  await poll; await h.flush();
  assert.equal(h.rows().length, 2);
  assert.equal(h.alert(), undefined);
});

const batch = { generation_group_id: 'batch', total: 2, remaining: 2, running: 2, queued: 0 };
const mutations = [
  { method: 'cancelGenerationJob', button: 'queueStopSaving', original: job('cancel'), updated: job('cancel', { status: 'cancelled' }) },
  { method: 'retryGenerationJob', button: 'queueRetry', original: job('failed', { status: 'failed' }), updated: job('retried', { status: 'queued' }) },
  { method: 'markGenerationJobFailed', button: 'queueMarkFailed', original: job('stalled', { started_at: '2000-01-01T00:00:00Z' }), updated: job('stalled', { status: 'failed' }) },
  { method: 'discardGenerationJob', button: 'queueDiscardResult', original: job('discard', { status: 'succeeded', result_path: 'generation-results/discard/result.png' }), updated: job('discard', { status: 'discarded' }) },
  { method: 'cancelRemainingGenerationSet', button: 'queueCancelRemaining', original: job('batch-member', { generation_group_id: 'batch', generation_group_index: 1, generation_group_size: 2 }), updated: { ...batch, remaining: 0, jobs: [] }, sets: [batch] },
];
for (const mutation of mutations) for (const succeeds of [true, false]) {
  test(`${mutation.method} notifies the gallery only after server-confirmed success (${succeeds ? 'success' : 'failure'})`, async t => {
    const pending = deferred(), requests = [];
    let changed = 0;
    const h = harness(t, { [mutation.method]: id => { requests.push(id); return pending.promise; } }, { onChanged: () => changed++ });
    h.open(); await h.flush();
    h.calls.at(-1).resolve(result([mutation.original], { generation_sets: mutation.sets || [] }));
    await h.flush();
    const action = h.button(mutation.button);
    assert.ok(action, 'production mutation control is rendered');
    action.onClick({ stopPropagation() {} });
    await h.flush();
    assert.equal(requests.length, 1);
    assert.equal(changed, 0, 'optimistic state is not a confirmed mutation');
    if (succeeds) pending.resolve(mutation.updated);
    else pending.reject(Error('Synthetic mutation failure'));
    await h.flush();
    assert.equal(changed, succeeds ? 1 : 0);
    if (succeeds) {
      h.calls.at(-1).reject(Error('Synthetic refresh failure after mutation'));
      await h.flush();
      assert.equal(changed, 1, 'subsequent read failure must not undo or duplicate the confirmed notification');
    }
  });
}
