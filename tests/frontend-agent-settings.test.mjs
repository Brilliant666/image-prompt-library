import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const transpile = async name => ts.transpileModule(await readFile(new URL(`../frontend/src/components/settings/${name}.tsx`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const [pickerCode, settingsCode] = await Promise.all(['AgentModelPicker', 'AgentSettings'].map(transpile));
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
  const deps = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, key) => key }), './AgentModelPicker.css': {}, ...dependencies };
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
