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
const { readGenerationPreference, writeGenerationPreference, lastGenerationProfile, resetGenerationPreference, updateRememberedModel } = await import(`data:text/javascript;base64,${Buffer.from(preferenceJs).toString('base64')}`);
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

test('saving a profile model updates only its remembered model and preserves the selected profile', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const original = { model: 'old-model', quality: 'max', size: '2048x3072', size_mode: 'auto4k', background: 'transparent', output_format: 'webp', moderation: 'low', output_compression: 0 };
  writeGenerationPreference(storage, 'a', original); writeGenerationPreference(storage, 'b', { ...original, model: 'other-model' });
  values.set('draft', 'untouched draft');
  assert.equal(updateRememberedModel(storage, 'a', 'new-model'), true);
  assert.deepEqual(readGenerationPreference(storage, 'a'), { ...original, model: 'new-model' });
  assert.deepEqual(readGenerationPreference(storage, 'b'), { ...original, model: 'other-model' });
  assert.equal(lastGenerationProfile(storage), 'b'); assert.equal(values.get('draft'), 'untouched draft');
  assert.equal(updateRememberedModel(storage, 'a', ''), true);
  assert.equal(readGenerationPreference(storage, 'a').model, '');
  const denied = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('full'); } };
  assert.equal(updateRememberedModel(denied, 'a', 'new-model'), false);
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
const { compatibleEndpointPreview, profileValidation, parseProfileModels, profileModelChoices } = await import(`data:text/javascript;base64,${Buffer.from(settingsJs).toString('base64')}`);
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

test('custom root mode never appends v1 and non-gpt image choices only preserve the selected historical ID', () => {
  assert.equal(compatibleEndpointPreview('https://example.test/gateway/', 'custom').generate, 'https://example.test/gateway/images/generations');
  assert.equal(compatibleEndpointPreview('https://example.test/v1/v1/', 'custom').base, 'https://example.test/v1/v1');
  assert.equal(compatibleEndpointPreview('https://example.test/', 'custom').responses, 'https://example.test/responses');
  assert.equal(compatibleEndpointPreview('https://key:secret@example.test/', 'custom'), undefined);
  assert.deepEqual(parseProfileModels(' alpha, beta\r\nalpha， gamma\n'), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(parseProfileModels(' \n,'), []);
  assert.deepEqual(profileModelChoices({ model: 'default-id', models: ['alpha', 'beta', 'alpha'] }, 'historical-id', ['legacy']), ['historical-id']);
  assert.deepEqual(profileModelChoices({ model: 'default-id', models: [] }, '', ['legacy']), []);
  for (const partial_images of [-1, 4, 1.5, NaN]) assert.equal(profileValidation({ display_name: 'API', base_url: 'https://example.test', timeout: 300, partial_images }), 'partial_images');
  for (const models of [Array.from({ length: 101 }, (_, index) => `model-${index}`), ['a'.repeat(201)], ['model\tname']]) assert.equal(profileValidation({ display_name: 'API', base_url: 'https://example.test', timeout: 300, models }), 'models');
});

async function componentJs(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
const settingsComponent = await componentJs('../frontend/src/components/OpenAICompatibleSettings.tsx');
const generalComponent = await componentJs('../frontend/src/components/settings/GeneralSettings.tsx');
const networkComponent = await componentJs('../frontend/src/components/ApiNetworkSettings.tsx');
const networkSource = await readFile(new URL('../frontend/src/utils/apiNetwork.ts', import.meta.url), 'utf8');
const networkJs = ts.transpileModule(networkSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const network = await import(`data:text/javascript;base64,${Buffer.from(networkJs).toString('base64')}`);
function walk(node) { return !node || typeof node !== 'object' ? [] : [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(walk)]; }
function settingsHarness(t, apiOverrides = {}, initial = {}) {
  const profiles = [
    { id: 'a', display_name: 'Gateway A', base_url: 'https://a.example.test/v1', model: 'model-a', timeout: 300, api_key_present: true, configured: true },
    { id: 'b', display_name: 'Gateway B', base_url: 'https://b.example.test/v1', model: 'model-b', timeout: 600, api_key_present: true, configured: true },
  ];
  const collection = { profiles, default_profile_id: 'a' }, calls = [], defaultCalls = [], events = [], values = new Map();
  profiles[0].model_catalog = initial.catalogA; profiles[1].model_catalog = initial.catalogB;
  Object.assign(profiles[0], initial.profileA); Object.assign(profiles[1], initial.profileB);
  const catalogCalls = [], cacheReads = [], listeners = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => oldStorage ? Object.defineProperty(globalThis, 'localStorage', oldStorage) : delete globalThis.localStorage);
  writeGenerationPreference(storage, 'a', { model: 'remembered-a', quality: 'max', size: '2560x3840', background: 'transparent', output_format: 'png' });
  const slots = [], effects = []; let cursor = 0, dirty = false, tree, mounted = true, lateUpdates = 0;
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], update => { if (!mounted) { lateUpdates++; return; } slots[i] = typeof update === 'function' ? update(slots[i]) : update; dirty = true; }]; },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || deps.some((dep, index) => dep !== slots[i].deps[index])) { const old = slots[i]; slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
  };
  const jsx = (type, props) => ({ type, props });
  const refresh = apiOverrides.refreshOpenAICompatibleModels || (async id => { catalogCalls.push(id); return { models: [], fetched_at: '2026-01-02T00:00:00Z', checked_at: '2026-01-02T00:00:00Z', error: null }; });
  const backendRefresh = async id => {
    const profile = profiles.find(item => item.id === id), connection = profile.base_url;
    const value = await refresh(id);
    // Emulate the backend's saved-connection guard and canonical cache.
    if (profile.base_url === connection) profile.model_catalog = value;
    return value;
  };
  const dependencies = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../api/client': { api: { openAICompatibleProfiles: async () => collection, openAICompatibleModels: async id => { cacheReads.push(id); return profiles.find(profile => profile.id === id)?.model_catalog || { models: [], fetched_at: null, checked_at: null, error: null }; }, saveOpenAICompatibleProfile: async (id, fields) => {
      calls.push({ id, fields });
      const { proxy_url, remove_proxy_url, ...publicFields } = fields;
      const profile = profiles.find(profile => profile.id === id);
      Object.assign(profile, publicFields, remove_proxy_url ? { proxy_url_present: false, proxy_endpoint: '' }
        : proxy_url ? { proxy_url_present: true, proxy_endpoint: network.safeProxyEndpoint(proxy_url) } : {});
      return collection;
    }, defaultOpenAICompatibleProfile: async id => { defaultCalls.push(id); collection.default_profile_id = id; return collection; }, ...apiOverrides, refreshOpenAICompatibleModels: backendRefresh } },
    '../api/profileActions': { copyApiProfile() { throw Error('unexpected copy'); }, reorderApiProfiles() { throw Error('unexpected reorder'); } },
    '../utils/profileSettings': { compatibleEndpointPreview, profileValidation, parseProfileModels },
    '../utils/apiNetwork': network, './ApiNetworkSettings': { __esModule: true, default: 'ApiNetworkSettings' },
    '../utils/generationPreferences': { readGenerationPreference, resetGenerationPreference, updateRememberedModel },
    '../utils/compatibleRecipe': { COMPATIBLE_ENTERPRISE_MODELS: [], IMAGE25_MODELS: [] }, './OpenAICompatibleSettings.css': {},
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'window', settingsComponent)(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, mod, mod.exports, { dispatchEvent: event => { events.push(event); for (const listener of listeners.get(event.type) || []) listener(event); }, addEventListener: (name, listener) => listeners.set(name, [...(listeners.get(name) || []), listener]), removeEventListener: (name, listener) => listeners.set(name, (listeners.get(name) || []).filter(item => item !== listener)) });
  function render() { cursor = 0; dirty = false; tree = mod.exports.default({ onSaved: async () => {}, uiLanguage: 'zh_hans', onSetDefaultConnection: () => defaultCalls.push('connection') }); effects.splice(0).forEach(effect => effect()); }
  async function flush() { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); }
  render(); t.after(() => slots.forEach(slot => slot?.cleanup?.()));
  const find = (type, predicate = () => true) => walk(tree).find(node => node.type === type && predicate(node.props))?.props;
  return { find, flush, calls, defaultCalls, events, catalogCalls, cacheReads, storage, values, unmount: () => { mounted = false; slots.forEach(slot => slot?.cleanup?.()); }, get lateUpdates() { return lateUpdates; }, get tree() { return tree; } };
}

const cachedCatalog = { models: [{ id: 'image-sounding-text-model', image_generation: false }, { id: 'mystery-model', image_generation: null }, { id: 'explicit-image-model', image_generation: true }], fetched_at: '2026-01-01T00:00:00Z', checked_at: '2026-01-01T00:00:00Z', error: null };
const catalogIds = h => walk(h.tree).filter(node => node.type === 'button' && node.props['data-catalog-model']).map(node => node.props['data-catalog-model']);

test('legacy and new API profiles default to direct without an extra discovery or dirty form', async t => {
  const h = settingsHarness(t); await h.flush();
  assert.equal(h.find('ApiNetworkSettings').mode, 'direct');
  assert.equal(h.find('ApiNetworkSettings').proxyUrl, '');
  assert.equal(h.find('button', props => props.children === '放弃修改'), undefined);
  h.find('button', props => props.className === 'secondary compatible-profile-add').onClick(); await h.flush();
  assert.equal(h.find('ApiNetworkSettings').mode, 'direct');
  assert.equal(h.find('ApiNetworkSettings').proxyUrlPresent, false);
  assert.equal(h.find('button', props => props.children === '放弃修改'), undefined);
  assert.deepEqual(h.catalogCalls, []); assert.deepEqual(h.calls, []);
});

test('network modes save per profile and a blank proxy draft preserves the saved credential', async t => {
  const h = settingsHarness(t, {}, { profileA: { network_mode: 'proxy', proxy_url_present: true, proxy_endpoint: 'socks5://proxy.example.test:1080' } }); await h.flush();
  assert.equal(h.find('ApiNetworkSettings').mode, 'proxy');
  h.find('input', props => props.list === 'compatible-known-models').onChange({ target: { value: 'model-adjusted' } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls[0].fields.network_mode, 'proxy');
  for (const field of ['proxy_url', 'remove_proxy_url', 'proxy_url_present', 'proxy_endpoint']) assert.equal(field in h.calls[0].fields, false, field);
  assert.equal(h.find('ApiNetworkSettings').proxyUrlPresent, true);
  for (const mode of ['environment', 'direct']) {
    h.find('ApiNetworkSettings').onModeChange(mode); await h.flush();
    h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
    assert.equal(h.calls.at(-1).fields.network_mode, mode);
    assert.equal('remove_proxy_url' in h.calls.at(-1).fields, false);
    assert.equal(h.find('ApiNetworkSettings').proxyUrlPresent, true);
  }
  assert.equal(h.catalogCalls.length, 3, 'only the pre-existing single catalog refresh runs after each save');
});

test('proxy replacement is write-only and explicit removal is not confused with an empty input', async t => {
  const h = settingsHarness(t); await h.flush();
  h.find('ApiNetworkSettings').onModeChange('proxy');
  h.find('ApiNetworkSettings').onProxyUrlChange('socks5h://sample:synthetic-secret@proxy.example.test:1080'); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls[0].fields.proxy_url, 'socks5h://sample:synthetic-secret@proxy.example.test:1080');
  assert.equal(h.find('ApiNetworkSettings').proxyUrl, '');
  assert.equal(h.find('ApiNetworkSettings').proxyEndpoint, 'socks5h://proxy.example.test:1080');
  assert.equal(JSON.stringify(h.tree).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify([...h.values]).includes('synthetic-secret'), false);
  h.find('ApiNetworkSettings').onRemoveProxyChange(true);
  h.find('ApiNetworkSettings').onModeChange('direct'); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls[1].fields.remove_proxy_url, true);
  assert.equal(h.calls[1].fields.network_mode, 'direct');
  assert.equal('proxy_url' in h.calls[1].fields, false);
  assert.equal(h.find('ApiNetworkSettings').proxyUrlPresent, false);
  assert.equal(h.find('ApiNetworkSettings').removeProxy, false);
});

test('catalog completion preserves a proxy draft, while discard and profile selection clear it', async t => {
  let finish;
  const h = settingsHarness(t, { refreshOpenAICompatibleModels: () => new Promise(resolve => { finish = resolve; }) }); await h.flush();
  h.find('button', props => props['aria-label'] === '刷新接口模型').onClick(); await h.flush();
  h.find('ApiNetworkSettings').onModeChange('proxy');
  h.find('ApiNetworkSettings').onProxyUrlChange('https://sample:synthetic-secret@proxy.example.test:8443'); await h.flush();
  finish(cachedCatalog); await h.flush();
  assert.equal(h.find('ApiNetworkSettings').proxyUrl, 'https://sample:synthetic-secret@proxy.example.test:8443');
  assert.equal(h.find('ApiNetworkSettings').mode, 'proxy');
  assert.deepEqual(catalogIds(h), ['explicit-image-model', 'mystery-model']);
  h.find('button', props => props.children === '放弃修改').onClick(); await h.flush();
  h.find('button', props => props.className === 'compatible-profile-option' && props['aria-pressed'] === false).onClick(); await h.flush();
  assert.equal(h.find('ApiNetworkSettings').proxyUrl, '');
  assert.equal(h.find('ApiNetworkSettings').mode, 'direct');
  assert.equal(h.find('ApiNetworkSettings').removeProxy, false);
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls[0].id, 'b');
  assert.equal('proxy_url' in h.calls[0].fields, false);
  assert.equal(JSON.stringify([...h.values]).includes('synthetic-secret'), false);
});

test('invalid or missing proxy addresses prevent profile saves without disclosing the rejected value', async t => {
  const h = settingsHarness(t); await h.flush();
  h.find('ApiNetworkSettings').onModeChange('proxy'); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.match(h.find('p', props => props.role === 'status').children, /请填写代理地址/);
  for (const proxyUrl of ['ftp://sample:synthetic-secret@proxy.example.test', 'https://proxy.example.test/path', 'https://proxy.example.test?secret=synthetic-secret', 'https://proxy.example.test:0', 'https://proxy.example.test:65536', 'http://proxy.example.test\\path']) {
    h.find('ApiNetworkSettings').onProxyUrlChange(proxyUrl); await h.flush();
    h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
    assert.equal(h.find('p', props => props.role === 'status').children.includes('synthetic-secret'), false);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.catalogCalls.length, 0);
  for (const protocol of ['http', 'https', 'socks5', 'socks5h']) {
    assert.equal(network.apiNetworkIssue('proxy', { proxyUrl: `${protocol}://sample:encoded%20secret@proxy.example.test:1080`, removeProxy: false }, false), undefined);
  }
});

test('an uncertain profile save clears the submitted proxy secret without displaying service errors', async t => {
  const h = settingsHarness(t, { saveOpenAICompatibleProfile: async () => { throw Error('synthetic-secret'); } }); await h.flush();
  h.find('ApiNetworkSettings').onModeChange('proxy');
  h.find('ApiNetworkSettings').onProxyUrlChange('http://sample:synthetic-secret@proxy.example.test:8080'); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.find('ApiNetworkSettings').proxyUrl, '');
  assert.equal(JSON.stringify(h.tree).includes('synthetic-secret'), false);
  assert.deepEqual(h.catalogCalls, []);
});

function networkHarness(initial = {}) {
  let props = { uiLanguage: 'zh_hans', mode: 'proxy', proxyUrl: '', proxyUrlPresent: true, proxyEndpoint: 'http://sample:synthetic-secret@proxy.example.test:8080', removeProxy: false, ...initial };
  const slots = [], effects = []; let cursor = 0, tree;
  const jsx = (type, props) => ({ type, props });
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], update => { slots[i] = typeof update === 'function' ? update(slots[i]) : update; }]; },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useId: () => 'network-test',
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || deps.some((dep, index) => dep !== slots[i][index])) { slots[i] = deps; effects.push(effect); } },
  };
  const dependencies = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../utils/apiNetwork': network, './ToolbarSelect': { __esModule: true, default: 'ToolbarSelect' }, './ApiNetworkSettings.css': {} };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', networkComponent)(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, mod, mod.exports);
  function render() {
    cursor = 0;
    tree = mod.exports.default({ ...props, onModeChange: mode => { props.mode = mode; }, onProxyUrlChange: proxyUrl => { props.proxyUrl = proxyUrl; }, onRemoveProxyChange: removeProxy => { props.removeProxy = removeProxy; } });
    effects.splice(0).forEach(effect => effect());
  }
  render();
  return { render, find: (type, predicate = () => true) => walk(tree).find(node => node.type === type && predicate(node.props))?.props, get tree() { return tree; }, get props() { return props; } };
}

test('shared network controls use the themed selector and reveal only newly entered proxy credentials', () => {
  const h = networkHarness();
  assert.deepEqual(h.find('ToolbarSelect').options.map(option => option.value), ['direct', 'environment', 'proxy']);
  assert.equal(h.find('select'), undefined);
  assert.equal(h.find('input').type, 'password');
  assert.equal(h.find('input').placeholder, '已保存 · http://proxy.example.test:8080');
  assert.equal(JSON.stringify(h.tree).includes('synthetic-secret'), false);
  h.find('input').onChange({ target: { value: 'http://new:entered-only-secret@proxy.example.test:8080' } }); h.render();
  h.find('button', props => props['aria-label'] === '显示代理地址').onClick(); h.render();
  assert.equal(h.find('input').type, 'text');
  assert.equal(h.find('input').autoComplete, 'new-password');
  h.find('button', props => props.children === '清除已保存代理').onClick(); h.render();
  assert.equal(h.props.mode, 'direct'); assert.equal(h.props.proxyUrl, ''); assert.equal(h.props.removeProxy, true);
  h.find('ToolbarSelect').onChange('proxy'); h.render();
  assert.equal(h.find('input').type, 'password');
  assert.equal(h.find('input').placeholder.includes('已保存'), false);
  h.find('button', props => props.children === '撤销清除').onClick(); h.render();
  assert.equal(h.props.removeProxy, false);
});

test('undoing a proxy removal restores the connection mode from before the clear action', () => {
  for (const mode of ['proxy', 'environment', 'direct']) {
    const h = networkHarness({ mode });
    h.find('button', props => props.children === '清除已保存代理').onClick(); h.render();
    assert.equal(h.props.mode, mode === 'proxy' ? 'direct' : mode);
    assert.equal(h.props.removeProxy, true);
    assert.equal(h.find('span', props => props.role === 'status').children, '保存后清除代理地址。');
    h.find('button', props => props.children === '撤销清除').onClick(); h.render();
    assert.equal(h.props.mode, mode, 'undo must restore the mode that clearing automatically changed');
    assert.equal(h.props.removeProxy, false);
    assert.equal(h.props.proxyUrl, '');
    assert.equal(h.find('span', props => props.role === 'status'), undefined);
    assert.deepEqual(network.apiNetworkPayload(h.props.mode, { proxyUrl: h.props.proxyUrl, removeProxy: h.props.removeProxy }), { network_mode: mode });
  }
});

test('undoing a proxy removal preserves a connection mode explicitly selected after clearing', () => {
  for (const mode of ['environment', 'direct', 'proxy']) {
    const h = networkHarness({ mode: 'proxy' });
    h.find('button', props => props.children === '清除已保存代理').onClick(); h.render();
    h.find('ToolbarSelect').onChange(mode); h.render();
    h.find('button', props => props.children === '撤销清除').onClick(); h.render();
    assert.equal(h.props.mode, mode, 'a later explicit choice takes priority over the clear snapshot');
    assert.equal(h.props.removeProxy, false);
    assert.deepEqual(network.apiNetworkPayload(h.props.mode, { proxyUrl: h.props.proxyUrl, removeProxy: h.props.removeProxy }), { network_mode: mode });
  }
});

test('cached model discovery prioritizes declared image capability and keeps selection separate from manual lists', async t => {
  const h = settingsHarness(t, {}, { catalogA: cachedCatalog }); await h.flush();
  assert.deepEqual(h.catalogCalls, [], 'opening settings reads cached profiles without contacting the upstream');
  assert.deepEqual(catalogIds(h), ['explicit-image-model', 'mystery-model']);
  h.find('button', props => props['aria-label'] === '显示全部接口模型').onClick(); await h.flush();
  assert.deepEqual(catalogIds(h), ['explicit-image-model', 'mystery-model', 'image-sounding-text-model']);
  h.find('button', props => props['data-catalog-model'] === 'mystery-model').onClick(); await h.flush();
  assert.equal(h.find('input', props => props.list === 'compatible-known-models').value, 'mystery-model');
  assert.equal(h.find('textarea', props => props['aria-label'] === '可用图片模型').value, '');
  assert.equal(h.calls.length, 0); assert.equal(h.find('button', props => props['aria-label'] === '刷新接口模型').disabled, true);
});

test('successful profile saves refresh models once without blocking saved configuration or replacing manual choices', async t => {
  let finish; const refreshes = [];
  const h = settingsHarness(t, { refreshOpenAICompatibleModels: id => { refreshes.push(id); return new Promise(resolve => { finish = resolve; }); } }, { catalogA: cachedCatalog }); await h.flush();
  h.find('textarea', props => props['aria-label'] === '可用图片模型').onChange({ target: { value: 'manual-model' } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.deepEqual(refreshes, ['a']); assert.equal(h.calls.length, 1);
  assert.equal('model_catalog' in h.calls[0].fields, false, 'the read-only catalog is never sent back as configuration');
  assert.equal(h.find('fieldset').disabled, false, 'discovery has independent loading state after the save');
  assert.ok(h.find('p', props => props.role === 'status').children.startsWith('已保存'));
  assert.equal(h.find('button', props => props['aria-label'] === '刷新接口模型').disabled, true);
  finish({ models: [{ id: 'discovered-model', image_generation: true }], fetched_at: '2026-01-02T00:00:00Z', checked_at: '2026-01-02T00:00:00Z', error: null }); await h.flush();
  assert.deepEqual(catalogIds(h), ['discovered-model']);
  assert.equal(h.find('input', props => props.list === 'compatible-known-models').value, 'model-a');
  assert.equal(h.find('textarea', props => props['aria-label'] === '可用图片模型').value, 'manual-model');
  const refresh = h.find('button', props => props['aria-label'] === '刷新接口模型').onClick;
  refresh(); refresh(); await h.flush(); assert.deepEqual(refreshes, ['a', 'a'], 'duplicate clicks share one refresh');
  finish({ ...cachedCatalog, checked_at: '2026-01-03T00:00:00Z' }); await h.flush();
});

test('saving while an older catalog request is pending queues one fresh discovery and ignores the old result', async t => {
  const refreshes = [], finishes = [];
  const h = settingsHarness(t, { refreshOpenAICompatibleModels: id => { refreshes.push(id); return new Promise(resolve => finishes.push(resolve)); } }, { catalogA: cachedCatalog }); await h.flush();
  h.find('button', props => props['aria-label'] === '刷新接口模型').onClick(); await h.flush();
  h.find('input', props => props.type === 'url').onChange({ target: { value: 'https://new.example.test/v1' } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls.length, 1); assert.deepEqual(refreshes, ['a']);
  finishes[0]({ ...cachedCatalog, models: [{ id: 'old-connection-model', image_generation: true }] }); await h.flush();
  assert.deepEqual(refreshes, ['a', 'a']); assert.deepEqual(catalogIds(h), ['explicit-image-model', 'mystery-model']);
  assert.equal(h.find('button', props => props['aria-label'] === '刷新接口模型').disabled, true);
  finishes[1]({ ...cachedCatalog, models: [{ id: 'new-connection-model', image_generation: true }] }); await h.flush();
  assert.deepEqual(catalogIds(h), ['new-connection-model']);
  assert.equal(h.find('button', props => props['aria-label'] === '刷新接口模型').disabled, false);
  assert.equal(h.events.filter(event => event.type === 'ipl:model-catalog-changed').length, 2);
  assert.equal(h.events.filter(event => event.type === 'ipl:agent-config-changed').length, 1, 'only the configuration save uses the broad event');
});

test('dirty and unsaved connections cannot refresh models or send an entered key', async t => {
  const h = settingsHarness(t); await h.flush();
  h.find('input', props => props.type === 'password').onChange({ target: { value: 'synthetic-not-saved-key' } }); await h.flush();
  const dirtyRefresh = h.find('button', props => props['aria-label'] === '刷新接口模型');
  assert.equal(dirtyRefresh.disabled, true); dirtyRefresh.onClick(); await h.flush();
  assert.deepEqual(h.catalogCalls, []); assert.equal(h.calls.length, 0);
  h.find('input', props => props.type === 'password').onChange({ target: { value: '' } }); await h.flush();
  h.find('button', props => props.className?.includes('compatible-profile-add')).onClick(); await h.flush();
  const newRefresh = h.find('button', props => props['aria-label'] === '刷新接口模型');
  assert.equal(newRefresh.disabled, true); newRefresh.onClick(); await h.flush();
  assert.deepEqual(h.catalogCalls, []); assert.equal(h.calls.length, 0);
});

test('a pending catalog refresh preserves newer model and manual-list edits', async t => {
  let finish;
  const h = settingsHarness(t, { refreshOpenAICompatibleModels: () => new Promise(resolve => { finish = resolve; }) }, { catalogA: cachedCatalog }); await h.flush();
  h.find('button', props => props['aria-label'] === '刷新接口模型').onClick(); await h.flush();
  h.find('input', props => props.list === 'compatible-known-models').onChange({ target: { value: 'new-manual-default' } }); await h.flush();
  h.find('textarea', props => props['aria-label'] === '可用图片模型').onChange({ target: { value: 'new-manual-choice' } }); await h.flush();
  finish({ ...cachedCatalog, models: [{ id: 'discovered-only', image_generation: true }] }); await h.flush();
  assert.equal(h.find('input', props => props.list === 'compatible-known-models').value, 'new-manual-default');
  assert.equal(h.find('textarea', props => props['aria-label'] === '可用图片模型').value, 'new-manual-choice');
  assert.deepEqual(catalogIds(h), ['discovered-only']); assert.equal(h.calls.length, 0);
  assert.equal(h.find('button', props => props['aria-label'] === '刷新接口模型').disabled, true);
});

for (const failure of ['catalog-error', 'request-error']) test(`${failure} model discovery keeps the successful save and previous cached list`, async t => {
  const failedCatalog = { ...cachedCatalog, checked_at: '2026-01-02T00:00:00Z', error: 'model_catalog_refresh_failed' };
  const h = settingsHarness(t, { refreshOpenAICompatibleModels: async () => { if (failure === 'request-error') throw Error('private upstream key'); return failedCatalog; } }, { catalogA: cachedCatalog }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls.length, 1); assert.ok(h.find('p', props => props.role === 'status').children.startsWith('已保存'));
  assert.deepEqual(catalogIds(h), ['explicit-image-model', 'mystery-model']);
  assert.ok(h.find('div', props => props.className === 'compatible-catalog-error'));
  const times = walk(h.tree).filter(node => node.type === 'time').map(node => node.props.dateTime);
  assert.ok(times.includes(cachedCatalog.fetched_at)); assert.ok(times.some(value => value !== cachedCatalog.checked_at));
  assert.ok(!JSON.stringify(h.tree).includes('private upstream key'));
});

for (const [error, reason] of [
  ['The provider denied access to its model list. Check the saved API key and permissions.', '接口拒绝读取模型'],
  ['The model list request timed out. Try refreshing again later.', '读取模型列表超时'],
  ['The provider could not return its model list. Check that this connection supports GET /models.', '请确认支持 GET /models'],
  ['The provider returned an invalid model list.', '模型列表格式无效'],
  ['The provider model list exceeded the supported size limit.', '模型列表超过大小限制'],
  ['The provider returned no models. Any previously fetched models have been kept.', '接口返回了空模型列表'],
  ['The saved connection changed during refresh. Refresh the current connection again.', '连接配置发生变化'],
]) test(`cached catalog translates the safe provider reason: ${reason}`, async t => {
  const h = settingsHarness(t, {}, { catalogA: { ...cachedCatalog, error } }); await h.flush();
  assert.ok(JSON.stringify(h.find('div', props => props.className === 'compatible-catalog-error')).includes(reason));
  assert.deepEqual(h.catalogCalls, []);
});

for (const interruption of ['switch-profile', 'close']) test(`late model discovery cannot update the settings after ${interruption}`, async t => {
  let finish;
  const other = { ...cachedCatalog, models: [{ id: 'profile-b-model', image_generation: true }] };
  const h = settingsHarness(t, { refreshOpenAICompatibleModels: () => new Promise(resolve => { finish = resolve; }) }, { catalogA: cachedCatalog, catalogB: other }); await h.flush();
  h.find('button', props => props['aria-label'] === '刷新接口模型').onClick(); await h.flush();
  if (interruption === 'switch-profile') walk(h.tree).filter(node => node.type === 'button' && node.props.className?.includes('compatible-profile-option'))[1].props.onClick();
  else h.unmount();
  await h.flush();
  finish({ ...cachedCatalog, models: [{ id: 'late-a-model', image_generation: true }] }); await h.flush();
  assert.deepEqual(h.events.map(event => [event.type, event.detail]), [['ipl:model-catalog-changed', { profileId: 'a' }]], 'catalog invalidation outlives the selected form');
  assert.equal(h.lateUpdates, 0);
  if (interruption === 'switch-profile') { assert.deepEqual(catalogIds(h), ['profile-b-model']); assert.equal(h.find('input', props => props.list === 'compatible-known-models').value, 'model-b'); }
});
test('automatic catalog refresh completes after settings close without local updates', async t => {
  let finish;
  const h = settingsHarness(t, { refreshOpenAICompatibleModels: () => new Promise(resolve => { finish = resolve; }) }, { catalogA: cachedCatalog }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(typeof finish, 'function');
  const before = h.events.length;
  h.unmount();
  finish({ ...cachedCatalog, models: [{ id: 'gpt-image-new', image_generation: true }] }); await h.flush();
  assert.deepEqual(h.events.slice(before).map(event => [event.type, event.detail]), [['ipl:model-catalog-changed', { profileId: 'a' }]]);
  assert.equal(h.lateUpdates, 0);
});
for (const returnBeforeCompletion of [true, false]) test(`catalog refresh A to B to A refreshes cache when return-before-completion=${returnBeforeCompletion}`, async t => {
  let finish; let upstreamReads = 0;
  const h = settingsHarness(t, { refreshOpenAICompatibleModels: () => { upstreamReads++; return new Promise(resolve => { finish = resolve; }); } }, { catalogA: cachedCatalog }); await h.flush();
  const choose = index => walk(h.tree).filter(node => node.type === 'button' && node.props.className?.includes('compatible-profile-option'))[index].props.onClick();
  h.find('button', props => props['aria-label'] === '刷新接口模型').onClick(); await h.flush();
  choose(1); await h.flush();
  if (returnBeforeCompletion) { choose(0); await h.flush(); }
  else { h.find('input', props => props.list === 'compatible-known-models').onChange({ target: { value: 'unsaved-b' } }); await h.flush(); }
  finish({ ...cachedCatalog, models: [{ id: 'gpt-image-new', image_generation: true }] }); await h.flush();
  if (!returnBeforeCompletion) {
    assert.equal(h.find('input', props => props.list === 'compatible-known-models').value, 'unsaved-b');
    h.find('input', props => props.list === 'compatible-known-models').onChange({ target: { value: 'model-b' } }); await h.flush();
    choose(0); await h.flush();
  }
  assert.deepEqual(catalogIds(h), ['gpt-image-new']);
  assert.equal(h.find('button', props => props['aria-label'] === '刷新接口模型').disabled, false);
  assert.equal(upstreamReads, 1, 'navigation only reads the local cache');
});
test('late local cache reads cannot overwrite a newer catalog, changed profile, or closed form', async t => {
  const reads = [], finishes = [];
  const h = settingsHarness(t, { openAICompatibleModels: id => { reads.push(id); return new Promise(resolve => finishes.push(resolve)); } }, { catalogA: cachedCatalog }); await h.flush();
  const choose = index => walk(h.tree).filter(node => node.type === 'button' && node.props.className?.includes('compatible-profile-option'))[index].props.onClick();
  choose(1); await h.flush();
  choose(0); await h.flush();
  assert.deepEqual(reads, ['a', 'b', 'a']);
  finishes[2]({ ...cachedCatalog, models: [{ id: 'gpt-image-current', image_generation: true }] }); await h.flush();
  finishes[0]({ ...cachedCatalog, models: [{ id: 'gpt-image-stale', image_generation: true }] });
  finishes[1]({ ...cachedCatalog, models: [{ id: 'gpt-image-b', image_generation: true }] }); await h.flush();
  assert.deepEqual(catalogIds(h), ['gpt-image-current']);
  choose(1); await h.flush();
  h.unmount();
  finishes[3](cachedCatalog); await h.flush();
  assert.equal(h.lateUpdates, 0);
  assert.deepEqual(h.catalogCalls, [], 'all cache reads stay local');
});
test('editing a named profile preserves the existing key and does not issue model or generation requests', async t => {
  const h = settingsHarness(t); await h.flush();
  assert.equal(h.find('input', props => props.type === 'password').value, '');
  assert.ok(h.find('div', props => props.className === 'compatible-current-profile'));
  assert.equal(h.find('div', props => props.id === 'compatible-registered-profiles').hidden, undefined);
  assert.equal(h.find('details'), undefined, 'selected profile sections are fully expanded');
  h.find('input', props => props.type === 'url').onChange({ target: { value: 'https://changed.example.test/v1' } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].id, 'a');
  assert.equal(h.calls[0].fields.base_url, 'https://changed.example.test/v1');
  assert.equal(h.calls[0].fields.model, 'model-a');
  assert.deepEqual(h.calls[0].fields.models, [], 'saving a legacy profile preserves an empty list and existing fallback suggestions');
  assert.deepEqual(profileModelChoices(h.calls[0].fields, '', ['legacy-suggestion']), []);
  assert.ok(!('api_key' in h.calls[0].fields)); assert.ok(!('api_key_present' in h.calls[0].fields));
  assert.equal(readGenerationPreference(h.storage, 'a').model, 'remembered-a');
  assert.equal(h.events.filter(event => event.type === 'ipl:profile-model-saved').length, 0, 'an unrelated save must not change the remembered model');
  h.find('input', props => props.type === 'url').onChange({ target: { value: 'https://user:secret@example.test' } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls.length, 1, 'invalid addresses are blocked before a write');
  assert.ok(h.find('p', props => props.role === 'status').children.includes('Base URL'));
});

test('a changed default model synchronizes browser memory and announces the confirmed model only after save succeeds', async t => {
  let finishSave;
  const h = settingsHarness(t, { saveOpenAICompatibleProfile: (id, fields) => new Promise(resolve => { finishSave = () => resolve({ default_profile_id: id, profiles: [{ ...fields, id, configured: true, api_key_present: true, model: 'confirmed-model' }] }); }) }); await h.flush();
  const oldRecipe = readGenerationPreference(h.storage, 'a');
  writeGenerationPreference(h.storage, 'b', { ...oldRecipe, model: 'other-model' });
  h.find('input', props => props.list === 'compatible-known-models').onChange({ target: { value: 'new-model' } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(readGenerationPreference(h.storage, 'a').model, 'remembered-a'); assert.equal(h.events.length, 0);
  finishSave(); await h.flush();
  assert.deepEqual(readGenerationPreference(h.storage, 'a'), { ...oldRecipe, model: 'confirmed-model' });
  assert.equal(readGenerationPreference(h.storage, 'b').model, 'other-model'); assert.equal(lastGenerationProfile(h.storage), 'b');
  const changed = h.events.filter(event => event.type === 'ipl:profile-model-saved');
  assert.equal(changed.length, 1); assert.deepEqual(changed[0].detail, { profileId: 'a', model: 'confirmed-model' });
  assert.ok(h.events.indexOf(changed[0]) < h.events.findIndex(event => event.type === 'ipl:agent-config-changed'));
  assert.ok(walk(h.tree).some(node => node.type === 'dd' && node.props.children === 'confirmed-model'), 'the remembered parameters summary updates too');
});

for (const outcome of ['failed', 'discarded-edit', 'closed-before-response']) test(`${outcome} model settings do not modify remembered choices or emit a model change`, async t => {
  let finishSave;
  const h = settingsHarness(t, { saveOpenAICompatibleProfile: async (id, fields) => {
    if (outcome === 'failed') throw Error('private diagnostics');
    return new Promise(resolve => { finishSave = () => resolve({ default_profile_id: id, profiles: [{ ...fields, id, configured: true, api_key_present: true }] }); });
  } }); await h.flush();
  h.find('input', props => props.list === 'compatible-known-models').onChange({ target: { value: 'new-model' } }); await h.flush();
  if (outcome === 'discarded-edit') h.unmount();
  else { h.find('form').onSubmit({ preventDefault() {} }); await h.flush(); if (outcome === 'closed-before-response') { h.unmount(); finishSave(); await h.flush(); } }
  assert.equal(readGenerationPreference(h.storage, 'a').model, 'remembered-a');
  assert.equal(h.events.filter(event => event.type === 'ipl:profile-model-saved').length, 0);
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

test('viewing profiles leaves the default untouched and default changes only after an explicit successful action', async t => {
  const h = settingsHarness(t); await h.flush();
  const options = walk(h.tree).filter(node => node.type === 'button' && node.props.className?.includes('compatible-profile-option'));
  options[1].props.onClick(); await h.flush();
  assert.deepEqual(h.defaultCalls, []);
  assert.equal(h.calls.length, 0);
  h.find('button', props => props.children === '设为默认连接').onClick(); await h.flush();
  assert.deepEqual(h.defaultCalls, ['b', 'connection']);
  assert.deepEqual(h.catalogCalls, [], 'changing the default profile does not trigger discovery');
});

test('an uncertain profile default change never switches the global connection', async t => {
  let requests = 0;
  const h = settingsHarness(t, { defaultOpenAICompatibleProfile: async () => { requests++; throw Error('secret diagnostics'); } }); await h.flush();
  walk(h.tree).filter(node => node.type === 'button' && node.props.className?.includes('compatible-profile-option'))[1].props.onClick(); await h.flush();
  h.find('button', props => props.children === '设为默认连接').onClick(); await h.flush();
  assert.equal(requests, 1); assert.deepEqual(h.defaultCalls, []);
  assert.ok(h.find('p', props => props.role === 'status').children.includes('无法确认'));
  assert.ok(!JSON.stringify(h.tree).includes('secret diagnostics'));
});

test('transport options save only into the edited API and preserve its key; disabled streaming retains preview preference', async t => {
  const h = settingsHarness(t); await h.flush();
  assert.equal(h.find('select', props => props['aria-label'] === '中间预览图数量').disabled, true);
  h.find('textarea', props => props['aria-label'] === '可用图片模型').onChange({ target: { value: 'one, two\none' } }); await h.flush();
  h.find('select', props => props['aria-label'] === '地址拼接方式').onChange({ target: { value: 'custom' } }); await h.flush();
  h.find('input', props => props['aria-label'] === '流式传输').onChange({ target: { checked: true } }); await h.flush();
  assert.equal(h.find('select', props => props['aria-label'] === '中间预览图数量').disabled, false);
  h.find('select', props => props['aria-label'] === '中间预览图数量').onChange({ target: { value: '3' } }); await h.flush();
  h.find('input', props => props['aria-label'] === '返回 Base64 图片数据').onChange({ target: { checked: true } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].id, 'a');
  assert.deepEqual(h.calls[0].fields.models, ['one', 'two']);
  assert.equal(h.calls[0].fields.base_url_mode, 'custom'); assert.equal(h.calls[0].fields.stream, true);
  assert.equal(h.calls[0].fields.partial_images, 3); assert.equal(h.calls[0].fields.response_format, 'b64_json');
  assert.ok(!('api_key' in h.calls[0].fields)); assert.deepEqual(h.defaultCalls, []);
  h.find('input', props => props['aria-label'] === '流式传输').onChange({ target: { checked: false } }); await h.flush();
  h.find('input', props => props['aria-label'] === '返回 Base64 图片数据').onChange({ target: { checked: false } }); await h.flush();
  h.find('form').onSubmit({ preventDefault() {} }); await h.flush();
  assert.equal(h.calls[1].fields.stream, false); assert.equal(h.calls[1].fields.partial_images, 3); assert.equal(h.calls[1].fields.response_format, 'auto');
  assert.equal(h.find('select', props => props['aria-label'] === '中间预览图数量').disabled, true);
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
