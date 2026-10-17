import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/utils/captureOrganizer.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { organizerDefaults, organizerPayload, organizerHasChanges, readOrganizerConfig, organizerSettingsRequest,
  organizerTestTimeoutMs, readOrganizerTestResult, testOrganizerConnection } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const saved = { ...organizerDefaults, base_url: 'https://example.invalid/v1', configured: true, has_api_key: true };
const safeError = (code) => (error) => error.code === code && !error.message.includes('test-only-secret');

test('organizer defaults are opt-in and never reuse an image provider key', () => {
  assert.equal(organizerDefaults.enabled, false);
  assert.equal(organizerDefaults.model, 'gpt-6-luna');
  const empty = readOrganizerConfig({});
  assert.equal(empty.has_api_key, false);
  assert.equal(empty.configured, false);
  assert.equal(empty.generate_title, true);
  assert.equal(empty.assign_collection, true);
  assert.equal(empty.allow_new_collections, true);
});

test('public configuration ignores accidental secrets and never infers call success from configured', () => {
  const config = readOrganizerConfig({ ...saved, api_key: 'test-only-secret', token: 'private', last_result: { status: 'available', message: 'test-only-secret' } });
  assert.equal(config.configured, true);
  assert.equal(config.last_result, undefined);
  assert.equal(config.api_key, undefined);
  assert.equal(config.token, undefined);
  assert.ok(!JSON.stringify(config).includes('test-only-secret'));
  const actual = readOrganizerConfig({ ...saved, last_result: { status: 'failed', category: 'upstream test-only-secret', message: 'test-only-secret', completed_at: '2026-01-02T03:04:05+00:00' } });
  assert.deepEqual(actual.last_result, { status: 'failed', category: '', completed_at: '2026-01-02T03:04:05+00:00' });
});

test('blank key preserves saved key for the same endpoint, explicit replacement is write-only', () => {
  const payload = organizerPayload(saved, '  ', saved);
  assert.equal(payload.api_key, undefined);
  assert.equal(payload.has_api_key, undefined);
  assert.equal(payload.configured, undefined);
  assert.equal(payload.last_result, undefined);
  assert.equal(organizerPayload({ ...saved, base_url: 'https://example.invalid/' }, '', saved).api_key, undefined);
  assert.equal(organizerPayload({ ...saved, base_url: 'https://example.invalid/v1/v1/' }, '', saved).api_key, undefined);
  assert.equal(organizerPayload(saved, ' test-only-secret ', saved).api_key, 'test-only-secret');
});

test('an old key cannot silently follow a changed endpoint even when automation is off', () => {
  const changed = { ...saved, enabled: false, base_url: 'https://other.invalid/v1' };
  assert.throws(() => organizerPayload(changed, '', saved), safeError('replacement_key'));
  assert.equal(organizerPayload(changed, 'new-test-key', saved).base_url, changed.base_url);
  assert.throws(() => organizerPayload({ ...saved, base_url: 'https://example.invalid/another/v1' }, '', saved), safeError('replacement_key'));
});

test('invalid address, timeout and empty enabled operation are rejected before any request', () => {
  for (const base_url of ['file:///tmp/library', 'https://user:test-only-secret@example.invalid/v1', 'https://example.invalid/v1?key=test-only-secret', 'https://example.invalid/#key', 'http://example.invalid/v1', 'https://example.invalid/v1/chat/completions']) {
    assert.throws(() => organizerPayload({ ...saved, base_url }, '', saved), safeError('url'));
  }
  for (const timeout_seconds of [0, 9, 121, 10.5, NaN]) assert.throws(() => organizerPayload({ ...saved, timeout_seconds }, '', saved), safeError('timeout'));
  assert.throws(() => organizerPayload({ ...saved, model: ' ' }, '', saved), safeError('model'));
  assert.throws(() => organizerPayload({ ...saved, model: 'a'.repeat(121) }, '', saved), safeError('model'));
  assert.throws(() => organizerPayload({ ...saved, enabled: true, generate_title: false, assign_collection: false }, '', saved), safeError('options'));
  assert.doesNotThrow(() => organizerPayload({ ...organizerDefaults, generate_title: false, assign_collection: false }, '', readOrganizerConfig({})));
});

test('unsaved content is distinguished from server-only result state', () => {
  assert.equal(organizerHasChanges(saved, '', { ...saved, last_result: { status: 'succeeded' } }), false);
  assert.equal(organizerHasChanges(saved, 'new-test-key', saved), true);
  assert.equal(organizerHasChanges({ ...saved, model: 'other-model' }, '', saved), true);
  assert.equal(organizerHasChanges({ ...saved, allow_new_collections: false }, '', saved), true);
});

test('load, save and check are bounded same-origin requests and local check never sends a key or provider request', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(saved), { status: 200 });
  });
  await organizerSettingsRequest('load');
  await organizerSettingsRequest('save', organizerPayload(saved, 'test-only-secret', saved));
  await organizerSettingsRequest('check');
  assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
    ['/api/capture-organizer/config', 'GET'], ['/api/capture-organizer/config', 'PUT'], ['/api/capture-organizer/check', 'POST'],
  ]);
  for (const [, init] of calls) {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.Authorization, undefined);
  }
  assert.equal(calls[0][1].body, undefined);
  assert.equal(calls[2][1].body, undefined);
  assert.equal(JSON.parse(calls[1][1].body).api_key, 'test-only-secret');
});

test('failure feedback does not display arbitrary service response or credential text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ detail: 'test-only-secret' }), { status: 422 }));
  await assert.rejects(organizerSettingsRequest('save', organizerPayload(saved, '', saved)), safeError('validation'));
});

test('unmount cancellation aborts pending requests without surfacing arbitrary transport details', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('test-only-secret')), { once: true });
  }));
  const controller = new AbortController();
  const pending = organizerSettingsRequest('load', undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, safeError('connection'));
});

test('all three languages distinguish configuration from actual API success and disclose paid external processing', async () => {
  const labelsSource = await readFile(new URL('../frontend/src/utils/captureOrganizerLabels.ts', import.meta.url), 'utf8');
  const labelsJs = ts.transpileModule(labelsSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { captureOrganizerLabels } = await import(`data:text/javascript;base64,${Buffer.from(labelsJs).toString('base64')}`);
  for (const language of ['zh_hans', 'zh_hant', 'en']) {
    const labels = captureOrganizerLabels(language);
    assert.notEqual(labels.configured, labels.succeeded);
    assert.notEqual(labels.checked, labels.succeeded);
    assert.match(labels.privacy, /额度|額度|credits/);
    assert.match(labels.scope, /提示词原文|提示詞原文|prompt text/);
    assert.ok(labels.replacement_key);
    assert.notEqual(labels.resultLabel, labels.testResultLabel);
    assert.match(labels.testHelp, /额度|額度|credits/);
    assert.match(labels.testUncertain, /可能|may/);
  }
});

const testSuccess = { status: 'succeeded', model: 'gpt-6-luna', elapsed_seconds: 1.25, category: '', http_status: 200 };

test('connection test returns only allowlisted result fields, not arbitrary diagnostics or secrets', () => {
  assert.deepEqual(readOrganizerTestResult({ ...testSuccess, api_key: 'test-only-secret', message: 'test-only-secret' }), testSuccess);
  for (const change of [
    { status: 'available' }, { category: 'upstream test-only-secret' }, { elapsed_seconds: Infinity },
    { elapsed_seconds: -1 }, { http_status: '200' }, { http_status: 401 }, { model: 'model test-only-secret' },
  ]) assert.equal(readOrganizerTestResult({ ...testSuccess, ...change }), undefined);
  for (const category of ['configuration', 'authentication', 'model', 'rate_limit', 'timeout', 'connection', 'http_error', 'invalid_response', 'busy']) {
    assert.equal(readOrganizerTestResult({ ...testSuccess, status: 'failed', category, http_status: null }).category, category);
  }
  for (const category of ['timeout', 'connection', 'invalid_response']) assert.equal(readOrganizerTestResult({ ...testSuccess, status: 'failed', category }).outcome_uncertain, true);
});

test('explicit connection test sends exactly one bodyless same-origin POST using only saved settings server-side', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(testSuccess));
  });
  const result = await testOrganizerConnection({ ...saved, api_key: 'test-only-secret', prompt_text: 'private prompt' });
  assert.deepEqual(result, testSuccess);
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, '/api/capture-organizer/test');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, undefined);
  assert.equal(init.headers, undefined);
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.redirect, 'error');
  assert.ok(!JSON.stringify(calls).includes('test-only-secret'));
  assert.ok(!JSON.stringify(calls).includes('private prompt'));
});

test('test waits for saved timeout plus ten seconds, instead of the settings request fifteen-second limit', () => {
  assert.equal(organizerTestTimeoutMs(10), 20000);
  assert.equal(organizerTestTimeoutMs(60), 70000);
  assert.equal(organizerTestTimeoutMs(120), 130000);
  assert.equal(organizerTestTimeoutMs(NaN), 70000);
});

test('missing saved credentials prevents any connection-test request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('must not be called'); });
  assert.equal((await testOrganizerConnection({ ...saved, configured: false })).category, 'configuration');
  assert.equal((await testOrganizerConnection({ ...saved, has_api_key: false })).category, 'configuration');
  assert.equal(fetch.mock.callCount(), 0);
});

test('HTTP 200 without a verified test result is uncertain, never success and never retried', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{"message":"test-only-secret"}'));
  const result = await testOrganizerConnection(saved);
  assert.equal(result.status, 'failed');
  assert.equal(result.category, 'invalid_response');
  assert.equal(result.outcome_uncertain, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(!JSON.stringify(result).includes('test-only-secret'));
});

test('invalid JSON and rejected authorization do not expose raw response bodies', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('test-only-secret'));
  assert.equal((await testOrganizerConnection(saved)).category, 'invalid_response');
  fetch.mock.mockImplementation(async () => new Response('test-only-secret', { status: 403 }));
  const result = await testOrganizerConnection(saved);
  assert.equal(result.category, 'configuration');
  assert.equal(result.http_status, null, 'local-route 403 must not be presented as an upstream HTTP status');
  assert.ok(!JSON.stringify(result).includes('test-only-secret'));
});

test('network failure preserves uncertainty and never automatically resubmits the paid POST', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('test-only-secret'); });
  const result = await testOrganizerConnection(saved);
  assert.equal(result.status, 'failed');
  assert.equal(result.category, 'connection');
  assert.equal(result.outcome_uncertain, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(!JSON.stringify(result).includes('test-only-secret'));
});

test('cancellation resolves uncertain even when fetch ignores abort, without implying remote execution stopped', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = testOrganizerConnection(saved, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.category, 'connection');
  assert.equal(result.outcome_uncertain, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('connection-test deadline reports uncertainty with no second request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Promise(() => {}));
  let completed = false;
  const pending = testOrganizerConnection({ ...saved, timeout_seconds: 60 }).then(result => { completed = true; return result; });
  t.mock.timers.tick(15000);
  await Promise.resolve();
  assert.equal(completed, false, 'the old 15-second configuration timeout must not cancel a model test');
  t.mock.timers.tick(55000);
  const result = await pending;
  assert.equal(result.category, 'timeout');
  assert.equal(result.outcome_uncertain, true);
  assert.equal(fetch.mock.callCount(), 1);
});
