import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../frontend/src/utils/compatibleProfiles.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { recipeProfileId, generationProviderChoices } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('restore pins request profile; old recipes never follow a new default', () => {
  assert.equal(recipeProfileId({ parameters: { compatible_profile_id: 'alpha' } }), 'alpha');
  assert.equal(recipeProfileId({ parameters: { compatible_profile_id: 'beta' }, metadata: { requested: { compatible_profile_id: 'alpha' } } }), 'alpha');
  assert.equal(recipeProfileId({ parameters: {} }), 'legacy');
  assert.equal(recipeProfileId({ parameters: { compatible_profile_id: 'removed' } }), 'removed');
});

test('each endpoint has independent readiness and default model; OAuth remains unchanged', () => {
  const oauth = { provider: 'oauth', model: 'oauth-model', features: { image_edit: true } };
  const base = { provider: 'openai_compatible', features: { image_edit: false, title_suggestion: false } };
  const profiles = [
    { id: 'a', display_name: 'API A', model: 'model-a', configured: true, api_key_present: true },
    { id: 'b', display_name: 'API B', model: '', configured: true, api_key_present: true },
    { id: 'c', display_name: 'API C', model: 'model-c', configured: false, api_key_present: false },
  ];
  const choices = generationProviderChoices([oauth, base], profiles);
  assert.equal(choices[0], oauth);
  assert.deepEqual(choices.slice(1).map(p => [p.profile_id, p.display_name, p.model, p.can_generate]), [
    ['a', 'API A', 'model-a', true], ['b', 'API B', '', true], ['c', 'API C', 'model-c', false],
  ]);
  assert.equal(choices[1].features.image_edit, true);
  assert.equal(choices[3].features.image_edit, false);
  assert.equal(generationProviderChoices([base], [])[0].can_generate, false);
});
const preferenceSource = await readFile(new URL('../frontend/src/utils/generationPreferences.ts', import.meta.url), 'utf8');
const preferenceJs = ts.transpileModule(preferenceSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readGenerationPreference, writeGenerationPreference, lastGenerationProfile } = await import(`data:text/javascript;base64,${Buffer.from(preferenceJs).toString('base64')}`);
test('generation choices survive reopening and stay isolated by endpoint', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const a = { model: 'alias-a', size: '2160x3840', quality: 'max', background: 'auto', output_format: 'png' };
  const b = { ...a, model: 'alias-b', size: '1024x1024', quality: 'xhigh' };
  writeGenerationPreference(storage, 'a', { ...a, api_key: 'not-to-be-saved', prompt: 'private' });
  writeGenerationPreference(storage, 'b', b);
  assert.deepEqual(readGenerationPreference(storage, 'a', 'new-default'), a);
  assert.deepEqual(readGenerationPreference(storage, 'b'), b);
  assert.equal(lastGenerationProfile(storage), 'b');
  assert.equal(readGenerationPreference(storage, 'new', 'default').quality, 'auto');
  assert.equal(readGenerationPreference(storage, 'new', 'default').model, 'default');
  assert.ok(!JSON.stringify([...values.values()]).includes('not-to-be-saved'));
  assert.ok(!JSON.stringify([...values.values()]).includes('private'));
});
test('invalid or disabled preference storage falls back safely', () => {
  for (const value of ['{', 'null', '{"size":"oops","quality":"bogus"}']) {
    assert.equal(readGenerationPreference({ getItem: () => value }, 'a').size, 'auto');
  }
  const denied = { getItem: () => { throw Error('disabled'); }, setItem: () => { throw Error('full'); } };
  assert.equal(readGenerationPreference(denied, 'a').quality, 'auto');
  assert.doesNotThrow(() => writeGenerationPreference(denied, 'a', {}));
});

const localSource = await readFile(new URL('../frontend/src/utils/localPreferences.ts', import.meta.url), 'utf8');
const localJs = ts.transpileModule(localSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readLocalPreferences, saveLocalPreferences, LOCAL_PREFERENCES_DEFAULTS } = await import(`data:text/javascript;base64,${Buffer.from(localJs).toString('base64')}`);
test('local workflow preferences validate booleans and persist no prompts, keys or extra fields', t => {
  const values = new Map();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget(); let changes = 0;
  events.addEventListener('ipl:local-preferences-changed', () => { changes++; });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window; });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key), setItem: (key, value) => values.set(key, value),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; });
  assert.deepEqual(readLocalPreferences(), LOCAL_PREFERENCES_DEFAULTS);
  assert.equal(saveLocalPreferences({ ...LOCAL_PREFERENCES_DEFAULTS, enterSubmit: true, persistInputOnRestart: true, api_key: 'private-key', prompt: 'private-prompt' }), true);
  assert.equal(changes, 1, 'mounted workspaces can refresh draft behavior immediately after a saved preference change');
  assert.equal(readLocalPreferences().enterSubmit, true);
  assert.equal(readLocalPreferences().persistInputOnRestart, true);
  assert.ok(!JSON.stringify([...values.values()]).includes('private-'));
  const key = [...values.keys()][0];
  values.set(key, '{"enterSubmit":"true","notifyOnCompletion":1}');
  assert.deepEqual(readLocalPreferences(), LOCAL_PREFERENCES_DEFAULTS);
  values.set(key, 'null');
  assert.deepEqual(readLocalPreferences(), LOCAL_PREFERENCES_DEFAULTS);
  values.set(key, '{');
  assert.deepEqual(readLocalPreferences(), LOCAL_PREFERENCES_DEFAULTS);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage denied'); } });
  assert.deepEqual(readLocalPreferences(), LOCAL_PREFERENCES_DEFAULTS);
  assert.equal(saveLocalPreferences(LOCAL_PREFERENCES_DEFAULTS), false);
  assert.equal(changes, 1, 'failed persistence must not announce a successful settings change');
});

const actionSource = await readFile(new URL('../frontend/src/api/profileActions.ts', import.meta.url), 'utf8');
const actionJs = ts.transpileModule(actionSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { copyApiProfile, reorderApiProfiles } = await import(`data:text/javascript;base64,${Buffer.from(actionJs).toString('base64')}`);
test('profile copy and order send only identities to local routes and never retry a failed mutation', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ profiles: [], default_profile_id: null }), { status: 200 });
  });
  await copyApiProfile('source', 'new-copy', 'Copy');
  await reorderApiProfiles(['b', 'a']);
  assert.equal(calls[0].url, '/api/generation-providers/openai-compatible/profiles/source/copy');
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: 'new-copy', display_name: 'Copy' });
  assert.equal(calls[1].url, '/api/generation-providers/openai-compatible/profiles/reorder');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { profile_ids: ['b', 'a'] });
  for (const { options } of calls) {
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    assert.ok(!options.body.includes('api_key'));
  }
  t.mock.method(globalThis, 'fetch', async () => { calls.push({ failed: true }); return new Response('secret-diagnostics', { status: 409 }); });
  await assert.rejects(copyApiProfile('source', 'new-copy', 'Copy'), error => error.message === 'profile_action_failed');
  assert.equal(calls.length, 3);
});
