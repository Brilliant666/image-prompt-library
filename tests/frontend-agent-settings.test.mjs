import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const transpile = async name => ts.transpileModule(await readFile(new URL(`../frontend/src/components/settings/${name}.tsx`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const [pickerCode, settingsCode] = await Promise.all(['AgentModelPicker', 'AgentSettings'].map(transpile));
const profileSettingsCode = ts.transpileModule(await readFile(new URL('../frontend/src/utils/profileSettings.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const profileSettingsModule = { exports: {} };
new Function('module', 'exports', profileSettingsCode)(profileSettingsModule, profileSettingsModule.exports);
const imageOptionsCode = ts.transpileModule(await readFile(new URL('../frontend/src/components/agent/AgentImageOptions.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : [node.props?.children].flat(Infinity).map(text).join('');
const catalog = (...ids) => ({ models: ids.map(id => ({ id, image_generation: null })), fetched_at: '2026-01-01', checked_at: '2026-01-01', error: null });
const profile = (id, models = catalog(`${id}-text`, `${id}-image`)) => ({ id, display_name: `Profile ${id}`, base_url: `https://${id}.invalid/v1`, base_url_mode: 'versioned', model: `${id}-image`, configured: true, api_key_present: true, model_catalog: models });

// Execute production render/event callbacks, with controlled local responses and
// React hooks. This is behavior coverage, not a real browser or paid API test.
function harness(t, code, dependencies, initialProps, eventTarget = new EventTarget()) {
  const slots = [], effects = [], events = [];
  let cursor = 0, dirty = false, tree, props = initialProps, unmounted = false, lateUpdates = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { if (unmounted) lateUpdates++; slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useId() { const i = cursor++; if (!(i in slots)) slots[i] = `id-${i}`; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
  };
  const jsx = (type, props) => ({ type, props });
  const window = { addEventListener: (...args) => eventTarget.addEventListener(...args), removeEventListener: (...args) => eventTarget.removeEventListener(...args), dispatchEvent(event) { events.push(event); return eventTarget.dispatchEvent(event); } };
  const deps = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, key) => key }), './AgentModelPicker.css': {}, '../../utils/profileSettings': profileSettingsModule.exports, ...dependencies };
  const module = { exports: {} };
  const document = { activeElement: null };
  new Function('require', 'module', 'exports', 'window', 'document', code)(name => { assert.ok(name in deps, `Unmocked dependency: ${name}`); return deps[name]; }, module, module.exports, window, document);
  const render = () => { cursor = 0; dirty = false; tree = module.exports.default(props); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let i = 0; i < 30; i++) { if (dirty && !unmounted) render(); await Promise.resolve(); } };
  const unmount = () => { if (!unmounted) { unmounted = true; slots.forEach(slot => slot?.cleanup?.()); } };
  const update = next => { props = { ...props, ...next }; render(); };
  render(); t.after(unmount);
  return { flush, unmount, update, events, document, get lateUpdates() { return lateUpdates; }, all: () => nodes(tree), find: (type, predicate = () => true) => nodes(tree).filter(node => node.type === type && predicate(node.props)).map(node => node.props), text: () => text(tree), notify(id) { window.dispatchEvent(new CustomEvent('ipl:model-catalog-changed', { detail: { profileId: id } })); } };
}

function picker(t, options = {}) {
  const cache = new Map([['a', catalog('reasoning-a', 'gpt-image-a', 'custom-long-model/a')], ['b', catalog('reasoning-b')]]);
  const calls = [], reads = [], refreshes = [], values = [];
  let h;
  const api = {
    openAICompatibleModels(id) { calls.push(['read', id]); return reads.length ? reads.shift().promise : Promise.resolve(cache.get(id) || catalog()); },
    refreshOpenAICompatibleModels(id) { calls.push(['refresh', id]); return refreshes.length ? refreshes.shift().promise : Promise.resolve(cache.get(id) || catalog()); },
  };
  h = harness(t, pickerCode, { '../../api/client': { api } }, { label: '文本模型', active: true, en: false, profile: profile('a'), value: 'historical-manual-model', onChange(value) { values.push(value); h.update({ value }); }, ...options });
  return { ...h, get lateUpdates() { return h.lateUpdates; }, cache, calls, values, queueRead() { const pending = deferred(); reads.push(pending); return pending; }, queueRefresh() { const pending = deferred(); refreshes.push(pending); return pending; }, open() { const trigger = h.find('button', props => props['aria-controls'])[0]; if (!trigger['aria-expanded']) trigger.onClick(); }, refresh() { h.find('button', props => text({ props }).includes('刷新模型'))[0].onClick(); } };
}

test('Agent model field reads full provider catalog locally, preserves custom IDs and only refreshes upstream on explicit action', async t => {
  const h = picker(t); await h.flush(); h.open(); await h.flush();
  assert.deepEqual(h.calls, [['read', 'a']]);
  assert.deepEqual(h.find('button', props => props.role === 'option').map(props => text({ props }).replace('能力未声明', '')), ['reasoning-a', 'gpt-image-a', 'custom-long-model/a']);
  assert.equal(h.find('input', props => props.maxLength)[0].value, 'historical-manual-model');
  h.find('input', props => props.maxLength)[0].onChange({ target: { value: 'my-unsaved-text-model' } });
  const pending = h.queueRefresh(); h.refresh(); await h.flush();
  h.cache.set('a', catalog('new-reasoning-model')); pending.resolve(catalog('DO-NOT-TRUST-RESPONSE'));
  await h.flush(); h.open(); await h.flush();
  assert.ok(h.text().includes('new-reasoning-model'));
  assert.ok(!h.text().includes('DO-NOT-TRUST-RESPONSE'));
  assert.equal(h.find('input', props => props.maxLength)[0].value, 'my-unsaved-text-model');
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'refresh'), [['refresh', 'a']]);
  assert.ok(h.events.every(event => event.type === 'ipl:model-catalog-changed'));
});

test('switching A to B and back during discovery keeps draft models and updates canonical A cache without a stuck loading state', async t => {
  const h = picker(t); await h.flush(); const pending = h.queueRefresh(); h.refresh(); await h.flush();
  h.update({ profile: profile('b'), value: 'unsaved-B' }); await h.flush(); h.open(); await h.flush();
  assert.ok(h.text().includes('reasoning-b')); assert.equal(h.find('input', props => props.maxLength)[0].value, 'unsaved-B');
  h.update({ profile: profile('a'), value: 'unsaved-A' }); await h.flush();
  assert.ok(h.text().includes('刷新中')); h.cache.set('a', catalog('updated-A')); pending.resolve(catalog('old-connection-A'));
  await h.flush(); h.open(); await h.flush();
  assert.ok(h.text().includes('updated-A')); assert.ok(!h.text().includes('old-connection-A')); assert.ok(!h.text().includes('刷新中'));
  assert.equal(h.find('input', props => props.maxLength)[0].value, 'unsaved-A');
  assert.equal(h.calls.filter(([kind]) => kind === 'refresh').length, 1);
});

test('late cache reads cannot overwrite a newer profile, newer same-profile connection or newer catalog notification', async t => {
  const h = picker(t); await h.flush(); const old = h.queueRead(); h.notify('a');
  h.update({ profile: profile('b'), value: 'manual-B' }); await h.flush(); old.resolve(catalog('obsolete-A')); await h.flush();
  h.open(); await h.flush(); assert.ok(h.text().includes('reasoning-b')); assert.ok(!h.text().includes('obsolete-A'));
  const oldConnection = h.queueRead(); h.notify('b');
  h.cache.set('b', catalog('new-connection')); h.update({ profile: { ...profile('b'), base_url: 'https://changed.invalid' } }); await h.flush();
  oldConnection.resolve(catalog('obsolete-connection')); await h.flush(); h.open(); await h.flush();
  assert.ok(h.text().includes('new-connection')); assert.ok(!h.text().includes('obsolete-connection'));
  const first = h.queueRead(); h.notify('b'); h.cache.set('b', catalog('latest-event')); h.notify('b'); await h.flush();
  first.resolve(catalog('obsolete-event')); await h.flush();
  assert.ok(h.text().includes('latest-event')); assert.ok(!h.text().includes('obsolete-event'));
});

test('refresh completion after close notifies saved cache consumers but never updates unmounted local UI', async t => {
  const h = picker(t); await h.flush(); const pending = h.queueRefresh(); h.refresh(); await h.flush(); h.unmount();
  pending.resolve(catalog('done')); await h.flush();
  assert.equal(h.lateUpdates, 0);
  assert.equal(h.events.length, 1); assert.equal(h.events[0].detail.profileId, 'a');
});

test('refresh failure retains catalog and editable manual model without exposing raw errors', async t => {
  const h = picker(t); await h.flush(); const pending = h.queueRefresh(); h.refresh(); await h.flush();
  pending.reject(Error('secret-key upstream credentials')); await h.flush(); h.open(); await h.flush();
  assert.ok(h.text().includes('reasoning-a')); assert.ok(h.text().includes('保留已有清单')); assert.ok(!h.text().includes('secret-key'));
  h.find('input', props => props.maxLength)[0].onChange({ target: { value: 'manual-after-failure' } }); await h.flush();
  assert.equal(h.find('input', props => props.maxLength)[0].value, 'manual-after-failure');
});

test('model search lets composition keys pass and arrows navigate options only after composition ends', async t => {
  const h = picker(t); await h.flush(); h.open(); await h.flush();
  let prevented = 0, focused = 0;
  const listNode = h.find('div', props => props.role === 'listbox')[0];
  listNode.ref.current = { querySelectorAll: () => [{ focus() { focused++; } }] };
  const keydown = h.find('div', props => props.className === 'agent-model-catalog')[0].onKeyDown;
  keydown({ key: 'ArrowDown', keyCode: 40, nativeEvent: { isComposing: true }, preventDefault() { prevented++; } });
  keydown({ key: 'ArrowDown', keyCode: 229, nativeEvent: {}, preventDefault() { prevented++; } });
  assert.equal(focused, 0); assert.equal(prevented, 0);
  keydown({ key: 'ArrowDown', keyCode: 40, nativeEvent: {}, preventDefault() { prevented++; } });
  assert.equal(focused, 1); assert.equal(prevented, 1);
  keydown({ key: 'Enter', keyCode: 13, nativeEvent: {}, target: { tagName: 'INPUT' }, preventDefault() { prevented++; } });
  assert.equal(prevented, 2, 'catalog search must not submit the enclosing settings form');
});

test('image recommendation mode reuses Gallery filtering and preserves custom selections without changing full text catalogs', async t => {
  const h = picker(t, { imageRecommendations: true }); await h.flush(); h.open(); await h.flush();
  assert.deepEqual(h.find('button', props => props.role === 'option').map(props => text({ props }).replace('能力未声明', '')), ['historical-manual-model', 'gpt-image-a']);
  h.update({ value: 'new-custom-image-model' }); await h.flush();
  assert.ok(h.text().includes('new-custom-image-model'));
  assert.ok(!h.text().includes('reasoning-a'));
  assert.equal(h.calls.filter(([kind]) => kind === 'refresh').length, 0);
  h.update({ imageRecommendations: false }); await h.flush();
  assert.ok(h.text().includes('reasoning-a'), 'native and text pickers retain the complete cached model catalog');
});

function imageOptions(t, overrides = {}) {
  const select = () => null, model = () => null;
  const changes = [], copies = [], resets = [], sizes = [];
  const params = { size: '1024x1024', quality: 'high', background: 'auto', output_format: 'webp', output_compression: 87, moderation: 'low' };
  const config = { revision: 3, config: { apiConfigMode: 'hybrid', textProfileId: 'a', imageProfileId: 'b', textModel: 'text-model', imageModel: '' }, profiles: [profile('a'), profile('b')], capabilities: {}, ready: true, imageReady: true, issues: [], imageIssues: [] };
  let h;
  h = harness(t, imageOptionsCode, { '../ToolbarSelect': select, '../settings/AgentModelPicker': model, './AgentImageOptions.css': {} }, {
    config, activeProfileId: 'a', params, galleryAvailable: true, onChange(change) { changes.push(change); h.update({ ...(change.params ? { params: change.params } : {}), ...(change.imageConfig ? { selection: change.imageConfig } : {}) }); },
    onUseGallery() { copies.push(true); }, onResetSelection() { resets.push(true); h.update({ selection: undefined }); }, onChooseSize() { sizes.push(true); }, ...overrides,
  });
  return { ...h, changes, copies, resets, sizes, config, fields: () => h.find(select), models: () => h.find(model) };
}

test('image options keeps text routing independent while selecting an image provider and preserving manual models and other parameters', async t => {
  const h = imageOptions(t); await h.flush();
  assert.ok(h.text().includes('Profile a · text-model'));
  assert.ok(h.text().includes('b-image · 供应商默认模型'));
  assert.equal(h.models()[0].profile.id, 'b'); assert.equal(h.models()[0].imageRecommendations, true);
  h.models()[0].onChange('historical-image-model'); await h.flush();
  h.fields().find(field => field.label === '生图供应商').onChange('a'); await h.flush();
  assert.deepEqual(h.changes.at(-1), { imageConfig: { profileId: 'a', model: 'historical-image-model' } });
  assert.equal(h.models()[0].value, 'historical-image-model');
  h.fields().find(field => field.label === '图片质量').onChange('max'); await h.flush();
  assert.deepEqual(h.changes.at(-1), { params: { size: '1024x1024', quality: 'max', background: 'auto', output_format: 'webp', output_compression: 87, moderation: 'low' } });
  assert.equal(h.find('select').length, 0, 'all visible choices use project controls');
});

for (const selection of [{ model: '' }, { profileId: null, model: '' }]) {
  test(`image options resolves ${'profileId' in selection ? 'null' : 'omitted'} image profile to the same configured supplier used by requests`, async t => {
    const h = imageOptions(t, { selection }); await h.flush();
    assert.equal(h.fields().find(field => field.label === '生图供应商').value, 'b');
    assert.equal(h.models()[0].profile.id, 'b');
    assert.ok(h.text().includes('b-image · 供应商默认模型'));
    assert.deepEqual(h.changes, [], 'rendering a fallback does not rewrite the draft');
    h.models()[0].onChange('manual-override'); await h.flush();
    assert.deepEqual(h.changes.at(-1), { imageConfig: { profileId: 'b', model: 'manual-override' } });
    assert.ok(h.text().includes('Profile a · text-model'), 'text routing remains independent');
  });
}

test('image options opens parent size dialog and copies Gallery only on explicit action, while reset leaves image parameters intact', async t => {
  const h = imageOptions(t, { selection: { profileId: 'b', model: 'my-image' }, sizeMode: 'auto4k' }); await h.flush();
  assert.deepEqual(h.copies, []); assert.ok(h.text().includes('4K · 自动比例'));
  h.find('button', props => props['aria-label'] === '设置图像尺寸')[0].onClick();
  assert.equal(h.sizes.length, 1); assert.deepEqual(h.changes, []);
  h.find('button', props => text({ props }) === '使用画廊当前生图设置')[0].onClick();
  assert.equal(h.copies.length, 1);
  h.find('button', props => text({ props }).includes('恢复 Agent 默认模型'))[0].onClick(); await h.flush();
  assert.equal(h.resets.length, 1); assert.deepEqual(h.changes, []);
  assert.equal(h.fields().find(field => field.label === '图片质量').value, 'high');
  assert.equal(h.models()[0].value, '');
});

test('native and current API modes use Responses image tools without Gallery Images configuration or gpt-image catalog filtering', async t => {
  const h = imageOptions(t); await h.flush();
  h.update({ config: { ...h.config, config: { ...h.config.config, apiConfigMode: 'native' } } }); await h.flush();
  assert.equal(h.fields().some(field => field.label === '生图供应商'), false);
  assert.equal(h.models()[0].profile.id, 'a'); assert.equal(h.models()[0].imageRecommendations, false);
  const copy = h.find('button', props => text({ props }) === '使用画廊当前生图设置')[0];
  assert.equal(copy.disabled, true); copy.onClick(); assert.deepEqual(h.copies, []);
  h.models()[0].onChange('native-tool-model'); await h.flush();
  assert.deepEqual(h.changes.at(-1), { imageConfig: { model: 'native-tool-model' } });
  h.update({ activeProfileId: 'b', config: { ...h.config, config: { ...h.config.config, apiConfigMode: 'off' } } }); await h.flush();
  assert.equal(h.models()[0].profile.id, 'b');
});

test('image options disables mutations during submission and preserves compression when PNG hides its field', async t => {
  const h = imageOptions(t); await h.flush();
  h.fields().find(field => field.label === '图片格式').onChange('png'); await h.flush();
  assert.equal(h.find('input', props => props.type === 'number').length, 0);
  assert.equal(h.changes.at(-1).params.output_compression, 87);
  h.update({ disabled: true }); await h.flush();
  const before = h.changes.length;
  h.fields().find(field => field.label === '图片质量').onChange('low');
  h.models()[0].onChange('ignored-model');
  h.find('button', props => props['aria-label'] === '设置图像尺寸')[0].onClick();
  assert.equal(h.changes.length, before); assert.deepEqual(h.sizes, []);
  assert.ok(h.fields().every(field => field.disabled)); assert.equal(h.models()[0].disabled, true);
});

const agentConfig = { apiConfigMode: 'hybrid', textProfileId: 'a', imageProfileId: 'b', textModel: 'typed-text', imageModel: 'typed-image', reasoningEffort: 'high', stream: true, partialImages: 2, maxToolRounds: 4, maxImageJobs: 3, webSearch: false, mathFormattingPrompt: true };
const settings = (t, config = agentConfig, status = {}) => {
  const saves = [], marker = () => null;
  const value = { revision: 5, config, profiles: [profile('a'), profile('b')], capabilities: { modes: ['off', 'native', 'hybrid'], maxToolRounds: 50, maxImageJobs: 20, webSearch: true }, ready: true, issues: [], imageReady: true, imageIssues: [], ...status };
  const h = harness(t, settingsCode, { './AgentModelPicker': marker, '../../api/agentClient': { AgentApiError: Error, getAgentConfig: async () => value, saveAgentConfig: async (revision, saved) => { saves.push({ revision, config: saved }); return { ...value, revision: 6, config: saved }; } } }, { uiLanguage: 'zh_hans', active: true });
  return { ...h, saves, fields: () => h.find(marker) };
};

test('actual Agent settings binds text and image candidates separately and changing profile never overwrites models or other unsaved settings', async t => {
  const h = settings(t); await h.flush(); assert.deepEqual(h.fields().map(field => field.profile.id), ['a', 'b']);
  h.fields()[0].onChange('unsaved-model'); await h.flush();
  const imageProfile = h.find('label').find(props => text({ props }).includes('图片模型 API 配置'));
  nodes({ props: imageProfile }).find(node => node.type === 'select').props.onChange({ target: { value: 'a' } }); await h.flush();
  assert.deepEqual(h.fields().map(field => field.profile.id), ['a', 'a']);
  assert.deepEqual(h.fields().map(field => field.value), ['unsaved-model', 'typed-image']);
  await h.find('form')[0].onSubmit({ preventDefault() {} }); await h.flush();
  assert.deepEqual(h.saves[0], { revision: 5, config: { ...agentConfig, textModel: 'unsaved-model', imageProfileId: 'a' } });
});

test('current workspace API mode never displays the unrelated fixed profile catalog or sends discovery requests', async t => {
  const h = settings(t, { ...agentConfig, apiConfigMode: 'off' }); await h.flush();
  assert.deepEqual(h.fields().map(field => field.profile), [undefined, undefined]);
  assert.ok(h.fields().every(field => field.unavailableHint.includes('工作区')));
  assert.deepEqual(h.saves, []);
});

test('current API mode follows the supplied workspace profile rather than the independently saved text profile', async t => {
  const h = settings(t, { ...agentConfig, apiConfigMode: 'off', textProfileId: 'a' }); await h.flush();
  h.update({ workspaceProfileId: 'b' }); await h.flush();
  assert.deepEqual(h.fields().map(field => field.profile?.id), ['b', 'b']);
  assert.deepEqual(h.fields().map(field => field.value), ['typed-text', 'typed-image']);
  h.fields()[0].onChange('manual-unsaved'); await h.flush();
  h.update({ workspaceProfileId: 'a' }); await h.flush();
  assert.deepEqual(h.fields().map(field => field.profile?.id), ['a', 'a']);
  assert.deepEqual(h.fields().map(field => field.value), ['manual-unsaved', 'typed-image']);
  h.update({ workspaceProfileId: undefined }); await h.flush();
  assert.deepEqual(h.fields().map(field => field.profile), [undefined, undefined]);
  assert.deepEqual(h.saves, []);
});

test('saved text and image readiness are displayed separately without exposing arbitrary errors or implying unsaved edits are applied', async t => {
  const h = settings(t, agentConfig, { imageReady: false, imageIssues: [{ field: 'imageProfileId', message: 'sensitive-upstream-detail' }] });
  await h.flush();
  const statusText = () => h.find('div', props => props.className === 'settings-status').map(props => text({ props })).join('');
  assert.ok(statusText().includes('已保存配置'));
  assert.ok(statusText().includes('文字配置可用'));
  assert.ok(statusText().includes('图片配置待完善'));
  assert.ok(statusText().includes('请选择已配置的图片 API 配置'));
  assert.ok(statusText().includes('仍可进行纯文字对话'));
  assert.ok(!statusText().includes('sensitive-upstream-detail'));
  const mode = h.find('select', props => props.value === 'hybrid')[0];
  mode.onChange({ target: { value: 'native' } }); await h.flush();
  assert.ok(statusText().includes('未保存的修改尚未应用'));
  assert.ok(statusText().includes('图片配置待完善'), 'saved hybrid status must not claim draft native settings have taken effect');
  assert.equal(h.find('fieldset')[0].disabled, false, 'image readiness must not disable the editable text configuration');
});

test('missing text readiness is not described as a ready text-only configuration', async t => {
  const h = settings(t, agentConfig, { ready: false, issues: [{ field: 'textModel' }], imageReady: false, imageIssues: [] }); await h.flush();
  const statusText = h.find('div', props => props.className === 'settings-status').map(props => text({ props })).join('');
  assert.ok(statusText.includes('文字配置待完善'));
  assert.ok(statusText.includes('先完善文字配置'));
  assert.ok(!statusText.includes('仍可进行纯文字对话'));
});
