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

test('custom root mode never appends v1 and image choices preserve configured and historical aliases', () => {
  assert.equal(compatibleEndpointPreview('https://example.test/gateway/', 'custom').generate, 'https://example.test/gateway/images/generations');
  assert.equal(compatibleEndpointPreview('https://example.test/v1/v1/', 'custom').base, 'https://example.test/v1/v1');
  assert.equal(compatibleEndpointPreview('https://example.test/', 'custom').responses, 'https://example.test/responses');
  assert.equal(compatibleEndpointPreview('https://key:secret@example.test/', 'custom'), undefined);
  assert.deepEqual(parseProfileModels(' alpha, beta\r\nalpha， gamma\n'), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(parseProfileModels(' \n,'), []);
  assert.deepEqual(profileModelChoices({ model: 'default-id', models: ['alpha', 'beta', 'alpha'] }, 'historical-id', ['legacy']), ['historical-id', 'default-id', 'alpha', 'beta']);
  assert.deepEqual(profileModelChoices({ model: 'default-id', models: [] }, '', ['legacy']), ['default-id', 'legacy']);
  for (const partial_images of [-1, 4, 1.5, NaN]) assert.equal(profileValidation({ display_name: 'API', base_url: 'https://example.test', timeout: 300, partial_images }), 'partial_images');
  for (const models of [Array.from({ length: 101 }, (_, index) => `model-${index}`), ['a'.repeat(201)], ['model\tname']]) assert.equal(profileValidation({ display_name: 'API', base_url: 'https://example.test', timeout: 300, models }), 'models');
});

test('image choices follow output capabilities across protocols, not model families', () => {
  const models = [
    {id:'flux-image',image_generation:true,text_generation:false},
    {id:'dual-output',image_generation:true,text_generation:true},
    {id:'text-only',image_generation:null,text_generation:true},
    {id:'not-image',image_generation:false,text_generation:null},
    {id:'custom-alias',image_generation:null,text_generation:null},
    {id:'gpt-image-not-supported',image_generation:false},
  ];
  for (const protocol of ['openai_compatible','gemini_native','seedream_native']) {
    const profile={protocol,model:'text-only',models:['custom-alias','not-image'],model_catalog:{models}};
    assert.deepEqual(profileModelChoices(profile,'historical-manual'),['historical-manual','flux-image','dual-output','custom-alias']);
    assert.deepEqual(profileModelChoices(profile,'not-image'),['not-image','flux-image','dual-output','custom-alias']);
    assert.equal(profileModelChoices(profile,'').includes('text-only'),false);
    assert.deepEqual(profile.model_catalog.models,models,'candidate selection does not mutate catalog declarations');
  }
  assert.deepEqual(profileModelChoices({protocol:'seedream_native',model:'custom-endpoint',image_capabilities:{known_models:['doc-reference']}},''),['custom-endpoint','doc-reference']);
});

async function componentJs(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
const generalComponent = await componentJs('../frontend/src/components/settings/GeneralSettings.tsx');
const networkComponent = await componentJs('../frontend/src/components/ApiNetworkSettings.tsx');
const networkSource = await readFile(new URL('../frontend/src/utils/apiNetwork.ts', import.meta.url), 'utf8');
const networkJs = ts.transpileModule(networkSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const network = await import(`data:text/javascript;base64,${Buffer.from(networkJs).toString('base64')}`);
function walk(node) { return !node || typeof node !== 'object' ? [] : [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(walk)]; }
// Connection-editor scenarios moved to frontend-api-connections.test.mjs.
// The new suite exercises explicit draft discovery instead of the removed save-time fetch.
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
