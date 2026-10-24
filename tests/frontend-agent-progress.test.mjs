import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/api/agentClient.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const snapshot = (revision, state = 'running', id = 'req/a') => ({ revision, request: { id, state }, conversation: { id: 'conversation' }, jobs: [], images: [] });
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
  new Function('module', 'exports', 'EventSource', 'setTimeout', 'clearTimeout', compiled)(module, module.exports, stream ? Stream : undefined,
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
