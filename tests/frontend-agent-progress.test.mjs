import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/api/agentClient.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const progressCode = ts.transpileModule(await readFile(new URL('../frontend/src/api/agentProgress.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const progressModule = { exports: {} }; new Function('module', 'exports', progressCode)(progressModule, progressModule.exports);
const snapshot = (revision, state = 'running', id = 'req/a') => ({ schemaVersion: 1, revision,
  request: { id, state, conversationId: 'conversation', roundId: 'round' },
  conversation: { id: 'conversation', title: 'Synthetic', activeRoundId: 'round', createdAt: 1, updatedAt: 1,
    rounds: [{ id: 'round', requestId: id, status: 'running' }],
    messages: [{ id: 'assistant', roundId: 'round', role: 'assistant', content: '', createdAt: 1 }] },
  jobs: [], images: [], editingTask: null });
function initial(revision = 1, text = '', epoch = 'epoch-1') {
  const value = snapshot(revision); value.conversation.messages[0].content = text;
  const { rounds, messages, ...conversation } = value.conversation;
  value.stream = { version: 1, epoch, sequence: 0, requestId: 'req/a', conversationId: 'conversation', roundId: 'round',
    view: { revision, conversation, round: rounds[0], messages, request: value.request, editingTask: null, jobs: [], images: [] } };
  return value;
}
const patch = (sequence, operations, extra = {}) => ({ version: 1, epoch: 'epoch-1', sequence, baseSequence: sequence - 1, requestId: 'req/a', conversationId: 'conversation', roundId: 'round', operations, ...extra });
const append = (offset, value) => ({ op: 'append', path: ['messages', 0, 'content'], offset, value });
function harness({ stream = true } = {}) {
  const timers = new Map(), streams = [], reads = [], updates = [], errors = [];
  let timerId = 0;
  class Stream {
    constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    close() { this.closed = true; }
    emit(name, value) { this.listeners[name]?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
  }
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'EventSource', 'setTimeout', 'clearTimeout', compiled)(name => { assert.equal(name, './agentProgress'); return progressModule.exports; }, module, module.exports, stream ? Stream : undefined,
    (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, id => timers.delete(id));
  module.exports.agentApi.request = (id, signal) => new Promise((resolve, reject) => reads.push({ id, signal, resolve, reject }));
  const close = module.exports.watchAgentRequest('req/a', value => updates.push(value), reason => errors.push(reason));
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { timers, streams, reads, updates, errors, close, flush, fire(ms) {
    const entry = [...timers].find(([, item]) => item.ms === ms); assert.ok(entry, `timer ${ms}`);
    timers.delete(entry[0]); entry[1].callback();
  } };
}

test('Agent SSE delivers text snapshots immediately and closes at terminal state without provider requests', () => {
  const h = harness();
  assert.equal(h.streams[0].url, '/api/agent/requests/req%2Fa/events');
  h.streams[0].emit('snapshot', snapshot(2));
  h.streams[0].emit('snapshot', snapshot(3));
  assert.deepEqual(h.updates.map(value => value.revision), [2, 3]);
  assert.equal(h.reads.length, 0);
  h.streams[0].emit('snapshot', snapshot(4, 'completed'));
  assert.equal(h.streams[0].closed, true);
  assert.equal(h.timers.size, 0);
  h.streams[0].emit('snapshot', snapshot(5));
  assert.equal(h.updates.length, 3);
});

test('stream failure falls back to read-only polling once; late events cannot replace its snapshot', async () => {
  const h = harness(); h.streams[0].onerror(); h.streams[0].onerror();
  assert.equal(h.streams[0].closed, true); assert.equal(h.reads.length, 1);
  h.streams[0].emit('snapshot', snapshot(100)); assert.equal(h.updates.length, 0);
  h.reads[0].resolve(snapshot(3)); await h.flush();
  h.fire(1200); assert.equal(h.reads.length, 2);
  h.reads[1].resolve(snapshot(4, 'completed')); await h.flush();
  assert.deepEqual(h.updates.map(value => value.revision), [3, 4]);
  assert.equal(h.timers.size, 0); assert.equal(h.errors.length, 0);
});

test('stalled stream watchdog and malformed JSON safely fall back without reconnect loops', () => {
  const h = harness(); h.streams[0].emit('heartbeat', {}); h.fire(20_000);
  assert.equal(h.reads.length, 1); assert.equal(h.streams.length, 1); h.close();
  const other = harness(); other.streams[0].emit('snapshot', '{broken');
  assert.equal(other.reads.length, 1); other.close();
});

test('without EventSource polling is immediate, read errors remain retryable, unmount aborts and ignores late responses', async () => {
  const h = harness({ stream: false }); assert.equal(h.reads.length, 1);
  h.reads[0].reject(Error('temporary read failure')); await h.flush();
  assert.equal(h.errors.length, 1); h.fire(1200);
  h.close(); assert.equal(h.reads[1].signal.aborted, true);
  h.reads[1].resolve(snapshot(5)); await h.flush();
  assert.equal(h.updates.length, 0); assert.equal(h.timers.size, 0);
});

test('closing or switching away detaches an active stream and does not mutate the request', () => {
  const h = harness(); h.close();
  assert.equal(h.streams[0].closed, true);
  h.streams[0].emit('heartbeat', {}); h.streams[0].emit('snapshot', snapshot(3)); h.streams[0].onerror();
  assert.equal(h.updates.length, 0); assert.equal(h.reads.length, 0);
  assert.equal(h.timers.size, 0);
});


test('bounded patches preserve history, append UTF-16 text once and close on persisted terminal truth', () => {
  const h = harness(), value = initial(5, 'Hi😀');
  const historical = { id: 'old', requestId: 'old-request', status: 'done' };
  value.conversation.rounds.unshift(historical);
  value.conversation.messages.unshift({ id: 'old-answer', roundId: 'old', role: 'assistant', content: 'Original historical answer', createdAt: 0 });
  // The bounded view remains current-round-only, as produced by the server.
  value.stream.view.messages = [value.conversation.messages[1]];
  h.streams[0].emit('snapshot', value);
  const original = h.updates[0];
  const delta = patch(1, [append(4, ' again'), { op: 'replace', path: ['revision'], value: 6 }]);
  h.streams[0].emit('patch', delta); h.streams[0].emit('patch', delta);
  h.streams[0].emit('patch', patch(2, [append(10, ' again')]));
  assert.equal(h.updates.length, 3); assert.equal(h.reads.length, 0);
  assert.equal(h.updates[2].conversation.messages[1].content, 'Hi😀 again again');
  assert.equal(original.conversation.messages[1].content, 'Hi😀');
  assert.equal(h.updates[2].conversation.messages[0], original.conversation.messages[0]);
  assert.equal(h.updates[2].conversation.rounds[0], original.conversation.rounds[0]);
  h.streams[0].emit('patch', patch(3, [{ op: 'replace', path: ['request', 'state'], value: 'completed' }]));
  assert.equal(h.streams[0].closed, true); assert.equal(h.timers.size, 0);
  h.streams[0].onerror(); assert.equal(h.reads.length, 0);
});

test('sequence gaps and backend epochs repair display with a new GET baseline, never replay a POST', () => {
  const h = harness(); h.streams[0].emit('snapshot', initial());
  h.streams[0].emit('patch', patch(2, [append(0, 'lost prior delta')]));
  assert.equal(h.streams[0].closed, true); h.fire(100);
  assert.equal(h.streams.length, 2); assert.equal(h.reads.length, 0);
  h.streams[0].emit('patch', patch(1, [append(0, 'late')])); assert.equal(h.updates.length, 1);
  h.streams[1].emit('snapshot', initial(3, 'Restored text', 'new-backend-epoch'));
  assert.equal(h.updates[1].conversation.messages[0].content, 'Restored text');
  h.streams[1].emit('patch', patch(1, [append(13, '!')], { epoch: 'new-backend-epoch' }));
  assert.equal(h.updates[2].conversation.messages[0].content, 'Restored text!'); h.close();
});

test('wrong identities and duplicate or reordered events cannot contaminate another run', () => {
  const h = harness(); h.streams[0].emit('snapshot', initial());
  for (const extra of [{ requestId: 'other' }, { conversationId: 'other' }, { roundId: 'other' }]) h.streams[0].emit('patch', patch(1, [append(0, 'wrong')], extra));
  assert.equal(h.updates.length, 1); assert.equal(h.streams[0].closed, undefined);
  h.streams[0].emit('patch', patch(1, [append(0, 'word')]));
  h.streams[0].emit('patch', patch(0, [append(0, 'old')]));
  assert.equal(h.updates.length, 2); assert.equal(h.updates[1].conversation.messages[0].content, 'word'); h.close();
});

test('unknown epoch, corrupt offsets and unsafe operations trigger read-only resync', () => {
  for (const invalid of [patch(1, [append(0, 'x')], { epoch: 'unexpected' }), patch(1, [append(1, 'x')]), patch(1, [{ op: 'replace', path: ['__proto__', 'polluted'], value: true }]), patch(1, [{ op: 'replace', path: ['messages', -1], value: {} }]), patch(1, [append(0, 'x')], { version: 999 })]) {
    const h = harness(); h.streams[0].emit('snapshot', initial()); h.streams[0].emit('patch', invalid);
    assert.equal(h.updates.length, 1); assert.equal(h.streams[0].closed, true); h.fire(100);
    assert.equal(h.streams.length, 2); assert.equal({}.polluted, undefined); h.close();
  }
});

test('fallback limits and repeated structure resyncs settle on polling without reconnect loops', async () => {
  for (const reason of ['view_limit', 'patch_limit', 'unavailable']) {
    const h = harness(); h.streams[0].emit('snapshot', initial()); h.streams[0].emit('fallback', { reason });
    assert.equal(h.reads.length, 1); assert.equal(h.streams.length, 1); h.reads[0].resolve(snapshot(2, 'completed')); await h.flush(); h.close();
  }
  const h = harness();
  for (let n = 0; n < 3; n++) { h.streams[n].emit('resync', { reason: 'structure_changed' }); if (n < 2) h.fire(100); }
  assert.equal(h.streams.length, 3); assert.equal(h.reads.length, 1); h.close();
});

test('two observers have independent epochs and closing one tab never stops another', () => {
  const a = harness(), b = harness();
  a.streams[0].emit('snapshot', initial(1, 'A', 'tab-a')); b.streams[0].emit('snapshot', initial(1, 'A', 'tab-b'));
  a.close(); b.streams[0].emit('patch', patch(1, [append(1, 'B')], { epoch: 'tab-b' }));
  assert.equal(a.updates.length, 1); assert.equal(b.updates[1].conversation.messages[0].content, 'AB');
  assert.equal(b.streams[0].closed, undefined); assert.equal(a.reads.length + b.reads.length, 0); b.close();
});


test('oversized initial views omit a baseline and accept fallback without an SSE reconnect', async () => {
  const h = harness(), value = initial(); delete value.stream.view;
  h.streams[0].emit('snapshot', value); h.streams[0].emit('fallback', { reason: 'view_limit' });
  assert.equal(h.updates.length, 1); assert.equal(h.reads.length, 1); assert.equal(h.streams.length, 1);
  assert.equal([...h.timers.values()].some(timer => timer.ms === 100), false);
  h.reads[0].resolve(snapshot(2, 'completed')); await h.flush(); assert.equal(h.updates.length, 2); h.close();
});

test('preview replacement releases obsolete metadata while retaining historical image evidence', () => {
  const h = harness(), value = initial();
  value.images = [{ id: 'preview-old' }, { id: 'history-input' }];
  value.jobs = [{ id: 'image-job', metadata: { agent: { partialImageId: 'preview-old' } } }];
  value.stream.view.images = [value.images[0]]; value.stream.view.jobs = value.jobs;
  value.conversation.rounds.unshift({ id: 'history', requestId: 'prior-request', inputImageIds: ['history-input'] });
  h.streams[0].emit('snapshot', value);
  const nextImages = [{ id: 'preview-new' }];
  h.streams[0].emit('patch', patch(1, [{ op: 'replace', path: ['images'], value: nextImages }, { op: 'replace', path: ['jobs', 0, 'metadata', 'agent', 'partialImageId'], value: 'preview-new' }]));
  assert.deepEqual(h.updates[1].images.map(image => image.id), ['history-input', 'preview-new']);
  // Even malformed legacy provenance cannot silently erase an actual input.
  value.conversation.rounds[0].inputImageIds.push('preview-old');
  const guarded = harness(); guarded.streams[0].emit('snapshot', value);
  guarded.streams[0].emit('patch', patch(1, [{ op: 'replace', path: ['images'], value: nextImages }, { op: 'replace', path: ['jobs', 0, 'metadata', 'agent', 'partialImageId'], value: 'preview-new' }]));
  assert.deepEqual(guarded.updates[1].images.map(image => image.id), ['preview-old', 'history-input', 'preview-new']); h.close(); guarded.close();
});


test('job-only progress at the same conversation revision retains the new persisted result', () => {
  const h = harness(), value = initial(7);
  value.jobs = [{ id: 'historical', status: 'succeeded' }, { id: 'current-job', status: 'running', result_path: null }];
  value.stream.view.jobs = [value.jobs[1]];
  h.streams[0].emit('snapshot', value);
  h.streams[0].emit('patch', patch(1, [{ op: 'replace', path: ['jobs', 0, 'status'], value: 'succeeded' }, { op: 'replace', path: ['jobs', 0, 'result_path'], value: 'synthetic-result.png' }]));
  assert.equal(h.updates[1].revision, 7);
  assert.equal(h.updates[1].jobs[1].status, 'succeeded'); assert.equal(h.updates[1].jobs[1].result_path, 'synthetic-result.png');
  assert.equal(h.updates[1].jobs[0], h.updates[0].jobs[0]); assert.equal(h.reads.length, 0); h.close();
});
