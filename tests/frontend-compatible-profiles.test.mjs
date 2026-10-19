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
const { readGenerationPreference, writeGenerationPreference, lastGenerationProfile, resetGenerationPreference } = await import(`data:text/javascript;base64,${Buffer.from(preferenceJs).toString('base64')}`);
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

const settingsSource = await readFile(new URL('../frontend/src/utils/profileSettings.ts', import.meta.url), 'utf8');
const settingsJs = ts.transpileModule(settingsSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { compatibleEndpointPreview, profileValidation } = await import(`data:text/javascript;base64,${Buffer.from(settingsJs).toString('base64')}`);
test('connection previews match the existing v1 contract and never expose credentials or accept image endpoints', () => {
  for (const base of ['https://api.example.test', 'https://api.example.test/', 'https://api.example.test/v1/', 'https://api.example.test/v1/v1']) {
    assert.deepEqual(compatibleEndpointPreview(base), { base: 'https://api.example.test/v1', generate: 'https://api.example.test/v1/images/generations', edit: 'https://api.example.test/v1/images/edits', responses: 'https://api.example.test/v1/responses' });
  }
  assert.equal(compatibleEndpointPreview('http://127.0.0.1:8012/proxy/v1').generate, 'http://127.0.0.1:8012/proxy/v1/images/generations');
  for (const base of ['', 'file:///secret', 'https://user:secret@example.test', 'https://example.test?key=secret', 'https://example.test#secret', 'https://example.test/v1/images/generations']) assert.equal(compatibleEndpointPreview(base), undefined);
  const valid = { display_name: 'Gateway', base_url: 'https://example.test', timeout: 300 };
  assert.equal(profileValidation(valid), undefined);
  assert.equal(profileValidation({ ...valid, display_name: '  ' }), 'name');
  assert.equal(profileValidation({ ...valid, base_url: 'https://user:secret@example.test' }), 'url');
  for (const timeout of [0, 1801, 1.5, NaN]) assert.equal(profileValidation({ ...valid, timeout }), 'timeout');
});
test('reset removes only this profile recipe and preserves selection, other APIs and drafts', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const recipe = { model: 'custom-model', quality: 'max', size: '2048x2048', background: 'transparent', output_format: 'png' };
  writeGenerationPreference(storage, 'a', recipe); writeGenerationPreference(storage, 'b', recipe);
  values.set('draft', 'original prompt');
  assert.equal(resetGenerationPreference(storage, 'a'), true);
  assert.equal(readGenerationPreference(storage, 'a', 'default-a').model, 'default-a');
  assert.equal(readGenerationPreference(storage, 'a').quality, 'auto');
  assert.deepEqual(readGenerationPreference(storage, 'b'), recipe);
  assert.equal(lastGenerationProfile(storage), 'b');
  assert.equal(values.get('draft'), 'original prompt');
  assert.equal(resetGenerationPreference({ removeItem() { throw Error('denied'); } }, 'a'), false);
});

async function componentJs(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
const settingsComponent = await componentJs('../frontend/src/components/OpenAICompatibleSettings.tsx');
const generalComponent = await componentJs('../frontend/src/components/settings/GeneralSettings.tsx');
function walk(node) { return !node || typeof node !== 'object' ? [] : [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(walk)]; }
function settingsHarness(t) {
  const profiles = [
    { id: 'a', display_name: 'Gateway A', base_url: 'https://a.example.test/v1', model: 'model-a', timeout: 300, api_key_present: true, configured: true },
    { id: 'b', display_name: 'Gateway B', base_url: 'https://b.example.test/v1', model: 'model-b', timeout: 600, api_key_present: true, configured: true },
  ];
  const collection = { profiles, default_profile_id: 'a' }, calls = [], events = [], values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => oldStorage ? Object.defineProperty(globalThis, 'localStorage', oldStorage) : delete globalThis.localStorage);
  writeGenerationPreference(storage, 'a', { model: 'remembered-a', quality: 'max', size: '2560x3840', background: 'transparent', output_format: 'png' });
  const slots = [], effects = []; let cursor = 0, dirty = false, tree;
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], update => { slots[i] = typeof update === 'function' ? update(slots[i]) : update; dirty = true; }]; },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || deps.some((dep, index) => dep !== slots[i].deps[index])) { const old = slots[i]; slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
  };
  const jsx = (type, props) => ({ type, props });
  const dependencies = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../api/client': { api: { openAICompatibleProfiles: async () => collection, saveOpenAICompatibleProfile: async (id, fields) => { calls.push({ id, fields }); Object.assign(profiles.find(profile => profile.id === id), fields); return collection; } } },
    '../api/profileActions': { copyApiProfile() { throw Error('unexpected copy'); }, reorderApiProfiles() { throw Error('unexpected reorder'); } },
    '../utils/profileSettings': { compatibleEndpointPreview, profileValidation },
    '../utils/generationPreferences': { readGenerationPreference, resetGenerationPreference },
    '../utils/compatibleRecipe': { COMPATIBLE_ENTERPRISE_MODELS: [], IMAGE25_MODELS: [] }, './OpenAICompatibleSettings.css': {},
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'window', settingsComponent)(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, mod, mod.exports, { dispatchEvent: event => events.push(event) });
  function render() { cursor = 0; dirty = false; tree = mod.exports.default({ onSaved: async () => {}, uiLanguage: 'zh_hans' }); effects.splice(0).forEach(effect => effect()); }
  async function flush() { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); }
  render(); t.after(() => slots.forEach(slot => slot?.cleanup?.()));
  const find = (type, predicate = () => true) => walk(tree).find(node => node.type === type && predicate(node.props))?.props;
  return { find, flush, calls, events, storage, get tree() { return tree; } };
}
test('editing a named profile preserves the existing key and does not issue model or generation requests', async t => {
  const h = settingsHarness(t); await h.flush();
  assert.equal(h.find('input', props => props.type === 'password').value, '');
  assert.ok(h.find('button', props => props.className === 'compatible-current-profile'));
  h.find('input', props => props.type === 'url').onChange({ target: { value: 'https://changed.example.test/v1' } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].id, 'a');
  assert.equal(h.calls[0].fields.base_url, 'https://changed.example.test/v1');
  assert.equal(h.calls[0].fields.model, 'model-a');
  assert.ok(!('api_key' in h.calls[0].fields)); assert.ok(!('api_key_present' in h.calls[0].fields));
  h.find('input', props => props.type === 'url').onChange({ target: { value: 'https://user:secret@example.test' } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls.length, 1, 'invalid addresses are blocked before a write');
  assert.ok(h.find('p', props => props.role === 'status').children.includes('Base URL'));
});
test('browser recipe reset requires confirmation and emits only the selected profile identity', async t => {
  const h = settingsHarness(t); await h.flush();
  h.find('button', props => props.children === '重置本浏览器参数').onClick(); await h.flush();
  assert.equal(readGenerationPreference(h.storage, 'a').model, 'remembered-a'); assert.equal(h.calls.length, 0);
  h.find('button', props => props.children === '取消').onClick(); await h.flush();
  assert.equal(h.find('button', props => props.children === '确认重置'), undefined);
  h.find('button', props => props.children === '重置本浏览器参数').onClick(); await h.flush();
  h.find('button', props => props.children === '确认重置').onClick(); await h.flush();
  assert.equal(readGenerationPreference(h.storage, 'a', 'model-a').model, 'model-a');
  assert.equal(h.events.length, 1); assert.equal(h.events[0].type, 'ipl:generation-preference-reset');
  assert.deepEqual(h.events[0].detail, { profileId: 'a' }); assert.equal(h.calls.length, 0);
});
test('grouped workflow controls preserve other preferences when changing one option', () => {
  const changes = [], value = { enterSubmit: false, clearInputAfterSubmit: true, persistInputOnRestart: true, notifyOnCompletion: false };
  const jsx = (type, props) => ({ type, props }), mod = { exports: {} };
  new Function('require', 'module', 'exports', generalComponent)(() => ({ jsx, jsxs: jsx }), mod, mod.exports);
  const tree = mod.exports.default({ value, onChange: next => changes.push(next), uiLanguage: 'zh_hans' });
  const nodes = walk(tree);
  nodes.find(node => node.type === 'select').props.onChange({ target: { value: 'enter' } });
  assert.deepEqual(changes[0], { ...value, enterSubmit: true });
  const switches = nodes.filter(node => node.type === 'input'); assert.equal(switches.length, 3);
  switches.at(-1).props.onChange({ target: { checked: true } });
  assert.deepEqual(changes[1], { ...value, notifyOnCompletion: true });
});
