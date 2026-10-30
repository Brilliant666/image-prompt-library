import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { localRecoveryDependencies } from './helpers/local-result-recovery.mjs';

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
for (const name of ['generationFailures', 'generationSets', 'generationSiblings', 'generationQueueHistory']) {
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
  id, provider: 'openai_compatible', created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', status: 'running', prompt_text: `Synthetic ${id}`, parameters: {}, metadata: {}, ...extra,
});
const result = (jobs, extra = {}) => ({
  jobs, total: 270, status_counts: { queued: 0, running: 4, succeeded: 94, accepted: 14, failed: 155, discarded: 3, cancelled: 0 },
  generation_sets: [], provider_queue_states: [], ...extra,
});

function storage() {
  const items = new Map();
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key), items };
}
function harness(t, apiOverrides = {}, propOverrides = {}, environment = {}) {
  globalThis.sessionStorage = environment.storage || storage();
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
    confirm: environment.confirm || (() => true),
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
    name => { if (name in localRecoveryDependencies) return localRecoveryDependencies[name]; assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; },
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
    calls, timers, flush, update, dispose, node,
    open() { node((props, type) => type === 'button' && props['aria-controls'] === 'generation-work-queue').onClick(); },
    close() { node((props, type) => type === 'button' && props['aria-label'] === 'close').onClick(); },
    rows: () => nodes(tree).filter(value => value.props?.className?.startsWith('generation-queue-row status-')),
    loading: () => Boolean(node(props => props.className === 'muted queue-loading')),
    activeSignal: () => Boolean(node(props => props['aria-label'] === 'queueActiveJobs')),
    button: label => node((props, type) => type === 'button' && (props['aria-label'] === label || props.children === label)),
    cached: () => node(props => props.className === 'muted queue-cache-status')?.children,
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

test('actual queue shows local registration recovery and refreshes the same job without offering paid failure retry', async t => {
  let paid = 0;
  const pending = job('paid-retained', { status: 'failed', metadata: { local_result_recovery: {
    state: 'pending', message: '图片已取得，本地保存记录待恢复。', can_recover: true } } });
  const h = harness(t, { retryGenerationJob: async () => { paid++; throw Error('No paid retry'); } });
  h.calls[0].resolve(result([pending])); await h.flush(); h.open(); await h.flush();
  h.calls.at(-1).resolve(result([pending])); await h.flush();
  assert.equal(h.button('queueRetryFailed'), undefined);
  const control = h.node((props, type) => type === 'local-result-recovery'); assert.ok(control);
  const restored = { ...pending, status: 'succeeded', result_path: 'generation-results/paid-retained/final.png', metadata: {} };
  control.onRecovered(restored); await h.flush();
  h.calls.at(-1).resolve(result([restored])); await h.flush();
  assert.equal(h.node((props, type) => type === 'local-result-recovery'), undefined); assert.equal(paid, 0);
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
test('cleared images retain an openable history record and explain the distinction from deletion', async t => {
  const cleared = job('cleared', { status: 'discarded', result_path: null });
  const opened = [];
  const h = harness(t, {}, { onOpenJob: value => opened.push(value) });
  h.open(); await h.flush();
  h.calls.at(-1).resolve(result([cleared])); await h.flush();
  assert.equal(h.rows().length, 1);
  const open = h.node(p => p.className === 'generation-queue-row-main');
  assert.ok(!open.disabled);
  open.onClick();
  assert.deepEqual(opened, [cleared]);
  assert.equal(h.button('queueDiscardResult'), undefined);
  assert.equal(h.node(p => p.className === 'muted queue-history-help').children, 'queueCleanupHelp');
  assert.ok(h.node(p => p.children === 'queueRecordRetained'));
});

test('cancelling the clear-image confirmation leaves the result and history untouched', async t => {
  const ready = job('ready', { status: 'succeeded', result_path: 'generation-results/ready/result.png' });
  let changed = 0, discarded = 0;
  const confirmations = [];
  const h = harness(t, { discardGenerationJob: async () => { discarded++; } },
    { onChanged: () => changed++ }, { confirm: value => { confirmations.push(value); return false; } });
  h.open(); await h.flush();
  h.calls.at(-1).resolve(result([ready])); await h.flush();
  h.button('queueDiscardResult').onClick(); await h.flush();
  assert.deepEqual(confirmations, ['queueCleanupConfirm']);
  assert.equal(discarded, 0);
  assert.equal(changed, 0);
  assert.ok(h.button('queueDiscardResult'));
});

for (const otherStatus of ['succeeded', 'discarded']) test(`cleared batch members remain individually readable in history (${otherStatus})`, async t => {
  const cleared = job('cleared-slot', { status: 'discarded', generation_group_id: 'batch', generation_group_index: 1, generation_group_size: 2 });
  const other = job('other-slot', { status: otherStatus, generation_group_id: 'batch', generation_group_index: 2, generation_group_size: 2 });
  const opened = [];
  const h = harness(t, {}, { onOpenJob: value => opened.push(value) });
  h.open(); await h.flush();
  h.calls.at(-1).resolve(result([cleared, other])); await h.flush();
  const rows = h.rows().filter(row => row.props.className.includes('status-discarded'));
  assert.equal(rows.length, otherStatus === 'discarded' ? 2 : 1);
  for (const row of rows) {
    const button = nodes(row).find(node => node.props?.className === 'generation-queue-row-main');
    assert.ok(!button.props.disabled);
    button.props.onClick();
  }
  assert.deepEqual(opened.map(value => value.id), otherStatus === 'discarded' ? ['cleared-slot', 'other-slot'] : ['cleared-slot']);
});

const mutations = [
  { method: 'cancelGenerationJob', button: 'queueStopSaving', original: job('cancel'), updated: job('cancel', { status: 'cancelled' }) },
  { method: 'retryGenerationJob', button: 'queueRetry', original: job('failed', { status: 'failed' }), updated: job('retried', { status: 'queued' }) },
  { method: 'markGenerationJobFailed', button: 'queueMarkFailed', original: job('stalled', { started_at: '2000-01-01T00:00:00Z' }), updated: job('stalled', { status: 'failed' }) },
  { method: 'discardGenerationJob', button: 'queueDiscardResult', original: job('discard', { status: 'succeeded', result_path: 'generation-results/discard/result.png' }), updated: job('discard', { status: 'discarded' }) },
  { method: 'cancelRemainingGenerationSet', button: 'queueCancelRemaining', original: job('batch-member', { generation_group_id: 'batch', generation_group_index: 1, generation_group_size: 2 }), updated: { ...batch, remaining: 0, jobs: [] }, sets: [batch] },
];
const history = utilities['../utils/generationQueueHistory'];
async function seedQueue(t, cache, jobs = [job('remembered')]) {
  const h = harness(t, {}, { libraryScope: 'library-a', open: true }, { storage: cache });
  h.calls[0].resolve(result(jobs)); await h.flush(); h.dispose();
}
test('page reload restores the full page before pending detail read, and a summary cannot overwrite it', async t => {
  const cache = storage();
  await seedQueue(t, cache, Array.from({ length: 100 }, (_, i) => job(`remembered-${i}`)));
  const h = harness(t, {}, { libraryScope: 'library-a' }, { storage: cache });
  assert.equal(h.rows().length, 100);
  assert.equal(h.cached(), 'queueCachedRefreshing');
  h.calls[0].resolve(result([job('summary-only')], { status_counts: { queued: 0, running: 0, succeeded: 2, accepted: 0, failed: 0, discarded: 0, cancelled: 0 } }));
  await h.flush();
  assert.equal(h.activeSignal(), false, 'latest counts replace cached indicators');
  assert.equal(history.readGenerationQueueHistory('library-a').jobs.length, 100);
  h.open(); await h.flush();
  assert.equal(h.rows().length, 100);
  assert.equal(h.loading(), false);
  const staleAction = h.button('queueStopSaving');
  assert.equal(staleAction.disabled, true);
  h.calls.at(-1).resolve(result([job('fresh')])); await h.flush();
  assert.equal(h.cached(), undefined);
  assert.equal(h.button('queueStopSaving').disabled, false);
  assert.equal(history.readGenerationQueueHistory('library-a').jobs[0].id, 'fresh');
});

test('unknown scope waits; scope discovery hydrates, and scope changes reject old reads', async t => {
  const cache = storage(); await seedQueue(t, cache);
  const h = harness(t, {}, { open: true }, { storage: cache });
  assert.equal(h.rows().length, 0);
  const unknownRead = h.calls[0];
  h.update({ libraryScope: 'library-a' }); await h.flush();
  assert.equal(h.rows().length, 1);
  const aRead = h.calls.at(-1);
  h.update({ libraryScope: 'library-b' }); await h.flush();
  assert.equal(h.rows().length, 0);
  unknownRead.resolve(result([job('unknown-late')]));
  aRead.resolve(result([job('a-late')])); await h.flush();
  assert.equal(h.rows().length, 0);
  assert.equal(history.readGenerationQueueHistory('library-b'), undefined);
  h.calls.at(-1).resolve(result([job('b-current')])); await h.flush();
  assert.equal(history.readGenerationQueueHistory('library-b').jobs[0].id, 'b-current');
});

test('failed refresh retains cached rows with explicit stale label; cached callbacks cannot mutate', async t => {
  const cache = storage(); await seedQueue(t, cache);
  let cancelled = 0;
  const h = harness(t, { cancelGenerationJob: async () => { cancelled++; } }, { libraryScope: 'library-a', open: true }, { storage: cache });
  h.button('queueStopSaving').onClick({ stopPropagation() {} }); await h.flush();
  assert.equal(cancelled, 0, 'callback guard protects even if disabled DOM control is bypassed');
  h.calls[0].reject(Error('Synthetic failure')); await h.flush();
  assert.equal(h.rows().length, 1);
  assert.equal(h.cached(), 'queueCachedUnavailable');
  assert.equal(h.button('queueStopSaving').disabled, true);
});

test('mutation invalidates persisted rows immediately and failed refresh cannot restore stale actions', async t => {
  const cache = storage(), pending = deferred();
  const h = harness(t, { cancelGenerationJob: () => pending.promise }, { libraryScope: 'library-a', open: true }, { storage: cache });
  h.calls[0].resolve(result([job('to-cancel')])); await h.flush();
  assert.ok(history.readGenerationQueueHistory('library-a'));
  h.button('queueStopSaving').onClick({ stopPropagation() {} }); await h.flush();
  assert.equal(history.readGenerationQueueHistory('library-a'), undefined);
  const readCount = h.calls.length;
  await h.poll(); await h.flush();
  assert.equal(h.calls.length, readCount, 'poll cannot cache pre-mutation data while mutation is pending');
  pending.resolve(job('to-cancel', { status: 'cancelled' })); await h.flush();
  h.calls.at(-1).reject(Error('Synthetic failure')); await h.flush();
  assert.equal(history.readGenerationQueueHistory('library-a'), undefined);
  const reload = harness(t, {}, { libraryScope: 'library-a', open: true }, { storage: cache });
  assert.equal(reload.rows().length, 0);
});

test('external refresh invalidates persistence, and unmount prevents a late read from saving', async t => {
  const cache = storage();
  const h = harness(t, {}, { libraryScope: 'library-a', open: true }, { storage: cache });
  h.calls[0].resolve(result([job('before-change')])); await h.flush();
  h.update({ refreshKey: 1 }); await h.flush();
  assert.equal(history.readGenerationQueueHistory('library-a'), undefined);
  h.dispose();
  h.calls.at(-1).resolve(result([job('after-unmount')])); await h.flush();
  assert.equal(history.readGenerationQueueHistory('library-a'), undefined);
});

test('late mutation completion cannot update a different library or resurrect its old cache', async t => {
  const cache = storage(), pending = deferred();
  let changed = 0;
  const h = harness(t, { cancelGenerationJob: () => pending.promise },
    { libraryScope: 'library-a', open: true, onChanged: () => changed++ }, { storage: cache });
  h.calls[0].resolve(result([job('a')])); await h.flush();
  h.button('queueStopSaving').onClick({ stopPropagation() {} }); await h.flush();
  h.update({ libraryScope: 'library-b' }); await h.flush();
  h.calls.at(-1).resolve(result([job('b')])); await h.flush();
  pending.resolve(job('a', { status: 'cancelled' })); await h.flush();
  assert.equal(changed, 0);
  assert.equal(h.rows()[0].props.children[0].props.children[1].props.children, 'Synthetic b');
  assert.equal(history.readGenerationQueueHistory('library-b').jobs[0].id, 'b');
});

test('mutation survives initiating drawer unmount and refreshes a remounted drawer only after completion', async t => {
  const cache = storage(), pending = deferred();
  const a = harness(t, { discardGenerationJob: () => pending.promise },
    { libraryScope: 'library-a', open: true }, { storage: cache });
  a.calls[0].resolve(result([job('clearing', { status: 'succeeded', result_path: 'generation-results/clearing/result.png' })]));
  await a.flush();
  a.button('queueDiscardResult').onClick(); await a.flush();
  a.dispose();
  const changed = [];
  const b = harness(t, {}, { libraryScope: 'library-a', open: true, onChanged: updated => changed.push(updated) }, { storage: cache });
  await b.flush();
  assert.equal(b.calls.length, 0, 'do not read and authorize a pre-mutation snapshot');
  assert.equal(history.readGenerationQueueHistory('library-a'), undefined);
  pending.resolve(job('clearing', { status: 'discarded' })); await a.flush(); await b.flush();
  assert.equal(b.calls.length, 1, 'server completion refreshes the new drawer despite old unmount');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'discarded', 'current gallery receives confirmed clear so its card can disappear');
  b.calls[0].resolve(result([job('clearing', { status: 'discarded' })])); await b.flush();
  assert.equal(b.rows()[0].props.className, 'generation-queue-row status-discarded');
  assert.equal(b.button('queueDiscardResult'), undefined);
  assert.equal(history.readGenerationQueueHistory('library-a').jobs[0].status, 'discarded');
});

test('A to B to A while mutation is pending receives completion in the new A lifecycle', async t => {
  const cache = storage(), pending = deferred(), changed = [];
  const h = harness(t, { cancelGenerationJob: () => pending.promise },
    { libraryScope: 'library-a', open: true, onChanged: value => changed.push(value) }, { storage: cache });
  h.calls[0].resolve(result([job('a')])); await h.flush();
  h.button('queueStopSaving').onClick({ stopPropagation() {} }); await h.flush();
  h.update({ libraryScope: 'library-b' }); await h.flush();
  h.calls.at(-1).resolve(result([job('b')])); await h.flush();
  h.update({ libraryScope: 'library-a' }); await h.flush();
  const reads = h.calls.length;
  pending.resolve(job('a', { status: 'cancelled' })); await h.flush();
  assert.equal(h.calls.length, reads + 1);
  assert.equal(changed.length, 1);
  h.calls.at(-1).resolve(result([job('a', { status: 'cancelled' })])); await h.flush();
  assert.equal(h.cached(), undefined);
  assert.equal(h.rows()[0].props.className, 'generation-queue-row status-cancelled');
});

test('batch summaries survive reload without persisting embedded recipes or provider backoff state', async t => {
  const cache = storage();
  const h = harness(t, {}, { libraryScope: 'library-a', open: true }, { storage: cache });
  const member = job('member', { generation_group_id: 'batch', generation_group_index: 1, generation_group_size: 3 });
  h.calls[0].resolve(result([member], { generation_sets: [{
    ...batch, provider: 'openai_compatible', created_at: member.created_at, total: 3,
    succeeded: 1, failed: 0, accepted: 0, discarded: 0, cancelled: 0, completed: 1,
    jobs: [job('PRIVATE-embedded', { parameters: { api_key: 'PRIVATE' } })],
  }] })); await h.flush(); h.dispose();
  const next = harness(t, {}, { libraryScope: 'library-a', open: true }, { storage: cache });
  assert.ok(next.node(p => p.className === 'generation-set-card generation-queue-batch-card'));
  assert.equal(next.button('queueCancelRemaining').disabled, true);
  assert.equal(next.button('queueOpenBatch').disabled, true);
  assert.equal(history.readGenerationQueueHistory('library-a').generationSets[0].total, 3);
  assert.ok(![...cache.items.values()][0].includes('PRIVATE'));
});

test('cache projection is bounded, excludes recipes and secrets, and retains retry/group display mapping', () => {
  globalThis.sessionStorage = storage();
  const source = job('retry', {
    result_path: 'generation-results/retry/result.png',
    generation_group_id: 'set', generation_group_index: 2, generation_group_size: 3,
    parameters: { quality: 'max', requested_aspect_ratio: '9:16', input_images: [{ data: 'data:image/png;base64,PRIVATE' }], api_key: 'PRIVATE' },
    metadata: { retry_of_generation_job_id: 'previous', retried_by_generation_job_id: 'next', retry_reason: 'failed_retry', requested: { api_key: 'PRIVATE' }, error: 'PRIVATE' },
    error: 'PRIVATE', arbitrary: 'PRIVATE',
  });
  history.saveGenerationQueueHistory('library-a', { jobs: [source], total: 1, generationSets: [] });
  const raw = [...sessionStorage.items.values()][0];
  assert.ok(!raw.includes('PRIVATE'));
  const restored = history.readGenerationQueueHistory('library-a').jobs[0];
  assert.equal(restored.generation_group_index, 2);
  assert.equal(restored.metadata.retry_of_generation_job_id, 'previous');
  assert.equal(restored.metadata.retried_by_generation_job_id, 'next');
  assert.equal(restored.parameters.requested_aspect_ratio, '9:16');
  history.saveGenerationQueueHistory('library-a', { jobs: Array.from({ length: 250 }, (_, i) => job(String(i))), total: 250, generationSets: [] });
  assert.equal(history.readGenerationQueueHistory('library-a').jobs.length, 200);
});

test('corrupt, expired, oversized and unavailable session storage never block the queue', async t => {
  for (const value of ['{', JSON.stringify({ version: 1, scope: 'library-a', jobs: [], generationSets: [], total: 0, savedAt: Date.now() - 31 * 60 * 1000 }), 'x'.repeat(1024 * 1024 + 1)]) {
    const cache = storage(); cache.setItem('image-prompt-library:generation-queue-history:v1', value);
    const h = harness(t, {}, { libraryScope: 'library-a', open: true }, { storage: cache });
    assert.equal(h.rows().length, 0);
    h.calls[0].resolve(result([job('fresh')])); await h.flush();
    assert.equal(h.rows().length, 1);
  }
  const unavailable = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('blocked'); } };
  const h = harness(t, {}, { libraryScope: 'library-a', open: true }, { storage: unavailable });
  h.calls[0].resolve(result([job('fresh')])); await h.flush();
  assert.equal(h.rows().length, 1);
});
for (const mutation of mutations) for (const succeeds of [true, false]) {
  test(`${mutation.method} notifies the gallery only after server-confirmed success (${succeeds ? 'success' : 'failure'})`, async t => {
    const pending = deferred(), requests = [];
    let changed = 0; const confirmedJobs = [];
    const h = harness(t, { [mutation.method]: id => { requests.push(id); return pending.promise; } }, { onChanged: value => { changed++; confirmedJobs.push(value); } });
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
    if (succeeds && mutation.method === 'discardGenerationJob') assert.deepEqual(confirmedJobs, [mutation.updated]);
    if (succeeds) {
      h.calls.at(-1).reject(Error('Synthetic refresh failure after mutation'));
      await h.flush();
      assert.equal(changed, 1, 'subsequent read failure must not undo or duplicate the confirmed notification');
    }
  });
}
