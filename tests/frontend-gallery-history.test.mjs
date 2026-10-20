import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/utils/galleryHistory.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const history = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const job = (extra = {}) => ({
  id: 'job-1', provider: 'openai_compatible', mode: 'text_to_image', status: 'succeeded',
  prompt_text: '  原文\r\n\n  Keep spaces.  ', edited_prompt_text: '  Edited\n\n原文  ', model: 'image-model',
  created_at: '2026-01-01T12:00:00Z', updated_at: '2026-01-01T12:00:05Z',
  completed_at: '2026-01-01T12:00:05Z', result_path: 'generation/job-1/result.png', result_width: 1536, result_height: 1024,
  ...extra,
});

function installStorage(t, overrides = {}) {
  const local = new Map(), session = new Map();
  function storage(map) { return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; }
  for (const [name, value] of Object.entries({ localStorage: storage(local), sessionStorage: storage(session), ...overrides })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  return { local, session, saved: () => JSON.parse([...session.values()][0]), replace: value => session.set([...session.keys()][0], JSON.stringify(value)) };
}

test('filter defaults to all, remembers five choices and migrates legacy states', t => {
  const { local } = installStorage(t);
  assert.equal(history.readGalleryFilter(), '');
  for (const value of ['', 'active', 'successful', 'accepted', 'failed']) {
    history.saveGalleryFilter(value);
    assert.equal(history.readGalleryFilter(), value);
  }
  history.saveGalleryFilter(' successful ');
  assert.equal(history.readGalleryFilter(), 'failed');
  const key = [...local.keys()][0];
  for (const [old, expected] of [['queued', 'active'], ['running', 'active'], ['succeeded', 'successful'], ['accepted', 'accepted'], ['completed', ''], ['cancelled', ''], ['discarded', ''], ['garbage', '']]) {
    local.set(key, old); assert.equal(history.readGalleryFilter(), expected);
  }
  assert.equal(history.galleryFilterStatuses('active'), 'queued,running');
  assert.equal(history.galleryFilterStatuses('successful'), 'succeeded,accepted');
  assert.equal(history.galleryFilterStatuses('completed'), 'succeeded,accepted,failed');
  assert.equal(history.galleryFilterStatuses('failed'), 'failed');
  assert.equal(history.galleryFilterStatuses(''), 'queued,running,succeeded,accepted,failed,cancelled');
  assert.equal(history.galleryFilterStatuses('bogus'), 'queued,running,succeeded,accepted,failed,cancelled');
});

test('running preview metadata is never restored from the history cache', t => {
  const { session } = installStorage(t);
  const preview = { path: 'generation-results/job-1/stream-preview/image.png', version: 'a'.repeat(64), width: 320, height: 200, index: 0 };
  history.saveGalleryHistory('/library-a', 'running', { jobs: [job({ status: 'running', result_path: null, result_width: null, result_height: null, metadata: { stream_preview: preview } })], total: 1 });
  assert.ok(![...session.values()][0].includes('stream_preview'));
  const cached = history.readGalleryHistory('/library-a', 'running');
  assert.equal(cached.jobs[0].metadata, undefined);
  assert.equal(cached.jobs[0].result_path, undefined);
  assert.equal(cached.jobs[0].result_width, undefined);
});

test('snapshot restores card fields with exact prompt whitespace and strips secrets and image bytes', t => {
  const { local, session } = installStorage(t);
  const original = job({ api_key: 'DO-NOT-SAVE', error: 'DO-NOT-SAVE', reference_image_ids: ['private-image'],
    metadata: { response: { b64_json: 'DO-NOT-SAVE' } }, parameters: { quality: 'high', compatible_profile_name: 'Local API',
      api_key: 'DO-NOT-SAVE', base_url: 'https://private.invalid', input_images: [{ data_url: 'data:image/png;base64,DO-NOT-SAVE' }] } });
  history.saveGalleryHistory('/library-a', 'successful', { jobs: [original], total: 42 });
  const cached = history.readGalleryHistory('/library-a', 'successful');
  assert.equal(cached.total, 42);
  assert.equal(cached.jobs[0].prompt_text, original.prompt_text);
  assert.equal(cached.jobs[0].edited_prompt_text, original.edited_prompt_text);
  assert.equal(cached.jobs[0].result_width, 1536);
  assert.deepEqual(cached.jobs[0].parameters, { quality: 'high', compatible_profile_name: 'Local API' });
  assert.equal(cached.jobs[0].metadata, undefined);
  assert.equal(cached.jobs[0].reference_image_ids, undefined);
  assert.equal(cached.jobs[0].error, undefined);
  assert.ok(![...session.values()][0].includes('DO-NOT-SAVE'));
  assert.equal(local.size, 0, 'prompts and snapshots never use persistent localStorage');
});

test('only the latest scope/filter snapshot is retained and never restored into another library', t => {
  const { session } = installStorage(t);
  history.saveGalleryHistory('/library-a', 'successful', { jobs: [job()], total: 1 });
  assert.equal(history.readGalleryHistory('/library-b', 'successful'), undefined);
  assert.equal(history.readGalleryHistory('/library-a', 'completed'), undefined);
  assert.equal(history.readGalleryHistory('', 'successful'), undefined);
  history.saveGalleryHistory('/library-b', 'failed', { jobs: [job({ status: 'failed' })], total: 1 });
  assert.equal(session.size, 1);
  assert.equal(history.readGalleryHistory('/library-a', 'successful'), undefined);
  assert.equal(history.readGalleryHistory('/library-b', 'failed').jobs[0].status, 'failed');
  history.clearGalleryHistory();
  assert.equal(session.size, 0);
});

test('expired and malformed snapshots safely fall back to live loading', t => {
  const state = installStorage(t);
  for (const patch of [
    { savedAt: Date.now() - 30 * 60 * 1000 - 1 }, { savedAt: Date.now() + 60000 },
    { total: -1 }, { total: 0.5 }, { jobs: [job({ status: 'unknown' })] }, { jobs: [job({ status: ['succeeded'] })] },
    { jobs: [job({ status: 'failed' })] }, { jobs: [job({ prompt_text: {} })] },
    { jobs: [job({ created_at: 'invalid' })] }, { jobs: null }, { jobs: [job(), job()], total: 2 },
  ]) {
    history.saveGalleryHistory('/library', 'successful', { jobs: [job()], total: 1 });
    state.replace({ ...state.saved(), ...patch });
    assert.equal(history.readGalleryHistory('/library', 'successful'), undefined);
  }
  state.session.set('image-prompt-library:gallery-history:v1', '{invalid json');
  assert.equal(history.readGalleryHistory('/library', 'successful'), undefined);
});

test('restored snapshots are sanitized again and URL or inline-image result paths are rejected', t => {
  const state = installStorage(t);
  for (const result_path of ['data:image/png;base64,SECRET', 'blob:https://example.invalid/id', 'https://example.invalid/result?token=SECRET', '//example.invalid/result', '../outside.png']) {
    history.saveGalleryHistory('/library', 'successful', { jobs: [job({ result_path })], total: 1 });
    assert.equal(history.readGalleryHistory('/library', 'successful').jobs[0].result_path, undefined);
  }
  const value = state.saved();
  value.jobs[0].metadata = { credential: 'SECRET' };
  value.jobs[0].parameters = { quality: 'high', token: 'SECRET' };
  state.replace(value);
  const restored = history.readGalleryHistory('/library', 'successful');
  assert.equal(restored.jobs[0].metadata, undefined);
  assert.deepEqual(restored.jobs[0].parameters, { quality: 'high' });
});

test('cache bounds cardinality and serialized storage size without truncating prompts', t => {
  const state = installStorage(t);
  const jobs = Array.from({ length: 250 }, (_, i) => job({ id: `job-${i}` }));
  history.saveGalleryHistory('/library', 'successful', { jobs, total: 250 });
  const cached = history.readGalleryHistory('/library', 'successful');
  assert.equal(cached.jobs.length, 200);
  assert.equal(cached.total, 250);
  history.saveGalleryHistory('/library', 'successful', { jobs: [job({ prompt_text: '字'.repeat(1024 * 1024) })], total: 1 });
  assert.equal(state.session.size, 0);
  history.saveGalleryHistory('/library', 'successful', { jobs: [job()], total: 1 });
  const value = state.saved();
  value.jobs = jobs;
  value.total = 250;
  state.replace(value);
  assert.equal(history.readGalleryHistory('/library', 'successful'), undefined);
});

test('storage errors and quota failures never block gallery loading or make a network request', t => {
  let fetches = 0;
  const denied = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('quota'); }, removeItem: () => { throw Error('denied'); } };
  installStorage(t, { localStorage: denied, sessionStorage: denied, fetch: () => { fetches++; throw Error('unexpected network'); } });
  assert.equal(history.readGalleryFilter(), '');
  assert.equal(history.readGalleryHistory('/library', 'successful'), undefined);
  assert.doesNotThrow(() => history.saveGalleryFilter('failed'));
  assert.doesNotThrow(() => history.saveGalleryHistory('/library', 'successful', { jobs: [job()], total: 1 }));
  assert.doesNotThrow(() => history.clearGalleryHistory());
  assert.equal(fetches, 0);
});

test('normal restore only reads browser storage and cannot submit or fetch any job', t => {
  let fetches = 0;
  installStorage(t, { fetch: () => { fetches++; throw Error('unexpected network'); } });
  history.saveGalleryHistory('/library', 'completed', { jobs: [job(), job({ id: 'failed-job', status: 'failed' })], total: 2 });
  assert.equal(history.readGalleryHistory('/library', 'completed').jobs.length, 2);
  assert.equal(fetches, 0);
});


test('old snapshots with cleared cards and obsolete totals cannot be restored', t => {
  const state = installStorage(t);
  history.saveGalleryHistory('/library', '', { jobs: [job()], total: 1 });
  const snapshot = state.saved();
  state.replace({ ...snapshot, version: 1, jobs: [job(), job({ id: 'cleared', status: 'discarded' })], total: 99 });
  assert.equal(history.readGalleryHistory('/library', ''), undefined);
  state.replace({ ...snapshot, jobs: [job({ status: 'discarded' })] });
  assert.equal(history.readGalleryHistory('/library', ''), undefined);
  history.saveGalleryHistory('/library', '', { jobs: [job({ status: 'discarded' })], total: 1 });
  assert.equal(history.readGalleryHistory('/library', ''), undefined);
});
