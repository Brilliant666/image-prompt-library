import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { IDBFactory } from 'fake-indexeddb';

const modules = new Map();
async function loadTs(relative) {
  const url = new URL(relative, import.meta.url);
  if (modules.has(url.href)) return modules.get(url.href);
  const source = await readFile(url, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies = new Map();
  for (const match of js.matchAll(/require\("([^"]+)"\)/g)) {
    const dependency = new URL(`${match[1]}.ts`, url);
    dependencies.set(match[1], await loadTs(dependency.href));
  }
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => dependencies.get(name), module, module.exports);
  modules.set(url.href, module.exports);
  return module.exports;
}
const recipe = await loadTs('../frontend/src/utils/galleryRecipe.ts');
const drafts = await loadTs('../frontend/src/utils/galleryDraft.ts');
const compatible = await loadTs('../frontend/src/utils/compatibleRecipe.ts');
const references = await loadTs('../frontend/src/utils/recipeInputs.ts');
const preferences = await loadTs('../frontend/src/utils/generationPreferences.ts');
const profileSettings = await loadTs('../frontend/src/utils/profileSettings.ts');
const templates = await loadTs('../frontend/src/utils/promptTemplateVariables.ts');
const generationSiblings = await loadTs('../frontend/src/utils/generationSiblings.ts');
const history = await loadTs('../frontend/src/utils/galleryHistory.ts');
const originalPrompt = '  原文\r\n\nB & <tag>\t ';
const historicalJob = (change = {}) => ({
  id: 'historical', provider: 'openai_compatible', mode: 'text_to_image', prompt_text: originalPrompt,
  status: 'succeeded', model: 'gateway-original-alias', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  parameters: { compatible_profile_id: 'original-api', model: 'gateway-original-alias', quality: 'max', size: '2560x3840', background: 'opaque', output_format: 'webp', output_compression: 0 },
  ...change,
});
const input = (id, extra = {}) => ({ id, name: id, source: 'uploaded', previewUrl: `data:image/png;base64,${id}`, dataUrl: `data:image/png;base64,${id}`, ...extra });

test('history restoration and submission preserve original provider, exact prompt, custom pixels and zero compression', () => {
  const job = historicalJob();
  const frozen = [input('first'), input('second')];
  const draft = recipe.draftFromJob(job, frozen);
  const payload = recipe.galleryPayload(draft, 4);
  assert.equal(payload.prompt_text, originalPrompt);
  assert.equal(payload.provider, job.provider);
  assert.equal(payload.parameters.compatible_profile_id, 'original-api');
  assert.equal(payload.model, 'gateway-original-alias');
  assert.equal(payload.parameters.size, '2560x3840');
  assert.equal(payload.parameters.output_compression, 0);
  assert.equal(payload.parameters.output_format, 'webp');
  assert.equal(payload.parameters.quality, 'max');
  assert.deepEqual(payload.parameters.input_images.map(image => image.id), ['first', 'second']);
  assert.deepEqual(payload.parameters.input_images.map(image => image.data_url), frozen.map(image => image.dataUrl));
  assert.equal(payload.mode, 'image_edit');
  assert.equal(recipe.galleryJobPrompt({ ...job, edited_prompt_text: '' }), '');
});

test('recorded request metadata wins over newer defaults and a deleted API never follows another profile', () => {
  const draft = recipe.draftFromJob(historicalJob({ metadata: { requested: { compatible_profile_id: 'deleted-original', model: 'full-model-original', size: '2048x1152', output_compression: 0 } } }), []);
  const payload = recipe.galleryPayload(draft, 4);
  assert.equal(draft.profileId, 'deleted-original');
  assert.equal(payload.model, 'full-model-original');
  assert.equal(payload.parameters.size, '2048x1152');
  assert.equal(payload.parameters.output_compression, 0);
  assert.equal(recipe.draftFromJob(historicalJob({ parameters: {} }), []).profileId, 'legacy');
});

test('missing and over-limit original references stop submission without dropping or reordering slots', () => {
  const missing = [input('first', { missing: true }), input('second')];
  const draft = recipe.draftFromJob(historicalJob(), missing);
  assert.throws(() => recipe.galleryPayload(draft, 4), /参考图缺失/);
  assert.deepEqual(draft.inputs, missing);
  const tooMany = recipe.draftFromJob(historicalJob(), [input('a'), input('b'), input('c')]);
  assert.throws(() => recipe.galleryPayload(tooMany, 2), /最多接受 2/);
  assert.equal(tooMany.inputs.length, 3);
});

test('auto4k resolves before submission, conflicting ratios stop locally, PNG omits compression', () => {
  const draft = recipe.draftFromJob(historicalJob(), []);
  draft.prompt = '宽高比 9:16'; draft.recipe.size_mode = 'auto4k'; draft.recipe.output_format = 'png';
  const payload = recipe.galleryPayload(draft, 4);
  assert.equal(payload.parameters.size, '2160x3840');
  assert.equal(payload.parameters.output_compression, undefined);
  assert.equal(payload.parameters.size_mode, 'auto4k');
  assert.equal(draft.recipe.size, '2560x3840', 'building a request must not mutate the saved recipe');
  draft.prompt = '9:16 and 16:9';
  assert.throws(() => recipe.galleryPayload(draft, 4), /冲突比例/);
});

test('history search respects edited prompt and exact status without mutating jobs', () => {
  const job = historicalJob({ edited_prompt_text: '  New prompt\n' });
  assert.equal(recipe.galleryMatches(job, 'NEW', 'succeeded'), true);
  assert.equal(recipe.galleryMatches(job, '原文', ''), false);
  assert.equal(recipe.galleryMatches(job, '', 'accepted'), false);
  assert.equal(job.prompt_text, originalPrompt);
});

test('enabled templates retain exact source, language and values while resolving the request and auto4k ratio', () => {
  const template = '  {{subject}}\r\n宽高比 {{ratio}}\t ';
  const draft = recipe.draftFromJob(historicalJob(), []);
  draft.prompt = template; draft.promptLanguage = 'zh_hans';
  draft.templateValues = { subject: '  猫  ', ratio: '9:16', unused: 'not-a-variable' };
  draft.recipe.size = 'auto'; draft.recipe.size_mode = 'auto4k';
  const payload = recipe.galleryPayload(draft, 4, undefined, true);
  const resolved = '    猫  \r\n宽高比 9:16\t ';
  assert.equal(payload.prompt_text, template);
  assert.equal(payload.edited_prompt_text, resolved);
  assert.equal(payload.prompt_language, 'zh_hans');
  assert.equal(payload.parameters.prompt_template, template);
  assert.equal(payload.parameters.prompt_template_resolved_text, resolved);
  assert.deepEqual(payload.parameters.prompt_template_values, { subject: '  猫  ', ratio: '9:16' });
  assert.equal(payload.parameters.size, '2160x3840');
  const restored = recipe.draftFromJob({ ...historicalJob(), ...payload }, []);
  assert.equal(restored.prompt, template);
  assert.equal(restored.promptLanguage, 'zh_hans');
  assert.deepEqual(restored.templateValues, payload.parameters.prompt_template_values);
  assert.equal(recipe.galleryJobPrompt({ ...historicalJob(), ...payload }), resolved);
});

test('disabled templates preserve literal braces and enabled empty variables block before submission', () => {
  const draft = recipe.draftFromJob(historicalJob(), []);
  draft.prompt = '\n {{subject}}\t ';
  const literal = recipe.galleryPayload(draft, 4, undefined, false);
  assert.equal(literal.prompt_text, draft.prompt);
  assert.equal(literal.edited_prompt_text, undefined);
  assert.equal(literal.parameters.prompt_template, undefined);
  assert.throws(() => recipe.galleryPayload(draft, 4, undefined, true), /填写所有提示词变量/);
  draft.templateValues = { subject: '   ' };
  assert.throws(() => recipe.galleryPayload(draft, 4, undefined, true), /填写所有提示词变量/);
});

test('restored auto-size requests retain the recorded aspect ratio and prompt-injection policy', () => {
  const job = historicalJob({ parameters: { ...historicalJob().parameters, size: 'auto', requested_aspect_ratio: '9:16', aspect_ratio_prompt_injection: true } });
  const payload = recipe.galleryPayload(recipe.draftFromJob(job, []), 4);
  assert.equal(payload.parameters.size, 'auto');
  assert.equal(payload.parameters.requested_aspect_ratio, '9:16');
  assert.equal(payload.parameters.aspect_ratio_prompt_injection, true);
  const metadataJob = { ...job, metadata: { requested: { requested_aspect_ratio: '3:4', aspect_ratio_prompt_injection: false } } };
  const recorded = recipe.galleryPayload(recipe.draftFromJob(metadataJob, []), 4);
  assert.equal(recorded.parameters.requested_aspect_ratio, '3:4');
  assert.equal(recorded.parameters.aspect_ratio_prompt_injection, false);
});

test('optional composer draft round-trips ordered references without making API requests, then can be cleared', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB; });
  t.mock.method(globalThis, 'fetch', () => { throw Error('drafts must never call a service'); });
  const draft = { ...recipe.draftFromJob(historicalJob(), [input('first'), input('second')]), aspectRatio: '9:16', aspectInjection: false };
  draft.recipe.size = 'auto';
  assert.equal(await drafts.readGalleryDraft(), undefined);
  await drafts.saveGalleryDraft(draft);
  const restored = await drafts.readGalleryDraft();
  assert.deepEqual(JSON.parse(JSON.stringify(recipe.galleryPayload(restored, 4))), JSON.parse(JSON.stringify(recipe.galleryPayload(draft, 4))));
  await drafts.saveGalleryDraft(undefined);
  assert.equal(await drafts.readGalleryDraft(), undefined);
});

test('malformed stored drafts do not reach the composer and unknown fields are not restored', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB; });
  // Simulate an old/corrupt value outside the application's typed write path.
  await drafts.readGalleryDraft();
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('image-prompt-library-workspace-draft', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  for (const value of [{}, { prompt: 'old', inputs: 'invalid' }, { ...recipe.emptyGalleryDraft(), recipe: null }]) {
    await new Promise((resolve, reject) => { const tx = db.transaction('draft', 'readwrite'); tx.objectStore('draft').put(value, 'current'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    const safe = await drafts.readGalleryDraft();
    if (safe) {
      assert.equal(typeof safe.prompt, 'string');
      assert.equal(typeof safe.recipe.output_format, 'string');
      assert.ok(Array.isArray(safe.inputs));
    }
  }
  db.close();
  await drafts.saveGalleryDraft({ ...recipe.emptyGalleryDraft(), prompt: originalPrompt, api_key: 'synthetic-secret', unrelated: 'not-a-draft-field' });
  const restored = await drafts.readGalleryDraft();
  assert.equal(restored.prompt, originalPrompt);
  assert.equal(restored.api_key, undefined);
  assert.equal(restored.unrelated, undefined);
});

// Exercise the actual component callbacks with mock hooks/API. This does not
// replace the desktop/mobile browser checks; no DOM or provider is contacted.
const inputSource = await readFile(new URL('../frontend/src/components/gallery/InputBar.tsx', import.meta.url), 'utf8');
const inputJs = ts.transpileModule(inputSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function children(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(children)]; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function inputHarness(t, overrides = {}, apiOverrides = {}, environment = {}) {
  const slots = [], effects = []; let cursor = 0, dirty = false, tree;
  const state = { created: 0, settings: 0, posts: [], persisted: [] };
  const store = new Map();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) } });
  const OldImage = globalThis.Image;
  const OldReader = globalThis.FileReader;
  if (environment.readFile) globalThis.FileReader = class { readAsDataURL(file) { Promise.resolve(environment.readFile(file)).then(value => { this.result = value; this.onload?.(); }, () => this.onerror?.()); } };
  globalThis.Image = class { naturalWidth = 1024; naturalHeight = 1024; async decode() { await environment.decode?.(this.src); } };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps, cleanup: undefined }; } },
  };
  const api = {
    generationProviders: async () => [{ provider: 'openai_compatible', display_name: 'Compatible', max_input_images: 4, can_generate: true }],
    openAICompatibleProfiles: async () => ({ profiles: [{ id: 'original-api', display_name: 'Original API', model: 'gateway-original-alias', configured: true }], default_profile_id: 'original-api' }),
    createGenerationJob: async payload => { state.posts.push(payload); return historicalJob(); },
    createGenerationSet: async payload => { state.posts.push(payload); return { jobs: [historicalJob()] }; },
    ...apiOverrides,
  };
  const jsx = (type, props) => ({ type, props });
  const deps = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../api/client': { api, mediaUrl: path => `/media/${path}` }, '../../utils/compatibleRecipe': compatible,
    '../../utils/generationPreferences': preferences, '../../utils/recipeInputs': references, '../../utils/galleryRecipe': recipe,
    '../../utils/profileSettings': profileSettings,
    '../../utils/promptTemplateVariables': templates,
    '../../utils/galleryDraft': { readGalleryDraft: environment.readGalleryDraft || (async () => undefined), saveGalleryDraft: async value => state.persisted.push(value) },
    './ReferencePicker': { __esModule: true, default: 'ReferencePicker' },
    './SizeDialog': { __esModule: true, default: 'SizeDialog' },
    './InputBar.css': {},
  };
  const module = { exports: {} };
  const eventTarget = new EventTarget();
  new Function('require', 'module', 'exports', 'window', inputJs)(name => { assert.ok(name in deps, `unmocked component dependency: ${name}`); return deps[name]; }, module, module.exports, eventTarget);
  let props = { active: true, t: key => key, preferences: { enterSubmit: false, clearInputAfterSubmit: false, persistInputOnRestart: false, notifyOnCompletion: false }, onCreated: () => state.created++, onOpenSettings: () => state.settings++, configurationRevision: 0, ...overrides };
  const render = () => { dirty = false; cursor = 0; tree = module.exports.default(props); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let i = 0; i < 15; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); };
  const find = (type, label) => { const node = children(tree).find(node => node.type === type && (node.props['aria-label'] === label || node.props.children === label)); assert.ok(node, `${type} ${label} exists`); return node.props; };
  render();
  t.after(() => { slots.forEach(slot => slot?.cleanup?.()); if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage; if (OldImage) globalThis.Image = OldImage; else delete globalThis.Image; if (OldReader) globalThis.FileReader = OldReader; else delete globalThis.FileReader; });
  return { state, flush, find, emitPreferenceReset: profileId => eventTarget.dispatchEvent(new CustomEvent('ipl:generation-preference-reset', { detail: { profileId } })), update: value => { props = { ...props, ...value }; render(); }, get tree() { return tree; } };
}

test('actual InputBar submit callback locks two same-tick clicks and clears input only after confirmed creation', async t => {
  const pending = deferred(); const calls = [];
  const harness = inputHarness(t, { preferences: { clearInputAfterSubmit: true } }, { createGenerationJob: payload => { calls.push(payload); return pending.promise; } });
  await harness.flush(); harness.find('textarea', '画廊提示词').onChange({ target: { value: originalPrompt } }); await harness.flush();
  const send = harness.find('button', '生成图片').onClick; send(); send(); await harness.flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].prompt_text, originalPrompt);
  assert.equal(harness.find('textarea', '画廊提示词').value, originalPrompt);
  pending.resolve(historicalJob()); await harness.flush();
  assert.equal(harness.find('textarea', '画廊提示词').value, ''); assert.equal(harness.state.created, 1);
});

test('gallery model suggestions follow the current API list and retain a restored historical model', async t => {
  const harness = inputHarness(t, { command: { id: 971, job: historicalJob({ model: 'historical-model', parameters: { ...historicalJob().parameters, model: 'historical-model' } }) } }, {
    openAICompatibleProfiles: async () => ({ profiles: [{ id: 'original-api', display_name: 'Original API', model: 'configured-default', models: ['model-one', 'model-two', 'model-one'], configured: true }], default_profile_id: 'original-api' }),
  });
  await harness.flush();
  harness.find('button', '请求模型 historical-model').onClick(); await harness.flush();
  const choices = () => children(harness.tree).find(node => node.type === 'datalist' && node.props.id === 'gallery-models').props.children.map(option => option.props.value);
  assert.deepEqual(choices(), ['historical-model', 'configured-default', 'model-one', 'model-two']);
  harness.find('input', '请求模型完整 ID').onChange({ target: { value: 'custom-entered-model' } }); await harness.flush();
  assert.deepEqual(choices(), ['custom-entered-model', 'configured-default', 'model-one', 'model-two']);
  assert.equal(harness.state.posts.length, 0, 'browsing and editing the model never submits a request');
});

test('parameter chips display complete model and exact pixels and preserve edits in a three-job request', async t => {
  const model = 'gpt-image-2.5-sunburst-enterprise';
  const job = historicalJob({ model, parameters: { ...historicalJob().parameters, model } });
  const harness = inputHarness(t, { command: { id: 72, job } }); await harness.flush();
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : '';
  assert.ok(text(harness.find('button', `请求模型 ${model}`).children).includes(model));
  assert.ok(text(harness.find('button', '请求尺寸 2560x3840').children).includes('2560 × 3840'));
  harness.find('button', `请求模型 ${model}`).onClick(); await harness.flush();
  harness.find('input', '请求模型完整 ID').onChange({ target: { value: 'image-model-custom' } }); await harness.flush();
  harness.find('button', '请求尺寸 2560x3840').onClick(); await harness.flush();
  const sizeDialog=children(harness.tree).find(node=>node.type==='SizeDialog');
  assert.equal(sizeDialog.props.recipe.size, '2560x3840');
  sizeDialog.props.onApply({size:'2048x3072',size_mode:undefined});sizeDialog.props.onClose();await harness.flush();
  harness.find('button', '质量 max').onClick(); await harness.flush();
  children(harness.tree).find(node => node.type === 'button' && text(node.props.children) === '超高 · xhigh').props.onClick(); await harness.flush();
  harness.find('button', '更多 WEBP · 透明 false · 审核 auto · 压缩 0').onClick(); await harness.flush();
  harness.find('select', '图片背景').onChange({ target: { value: 'transparent' } });
  harness.find('select', '输出格式').onChange({ target: { value: 'webp' } });
  harness.find('input', '输出压缩').onChange({ target: { value: '0' } });
  harness.find('select', '审核强度').onChange({ target: { value: 'low' } });
  harness.find('select', '生成数量').onChange({ target: { value: '3' } }); await harness.flush();
  assert.deepEqual(harness.find('select', '生成数量').children.map(option => option.props.value), [1, 3, 5, 10]);
  harness.find('button', '生成图片').onClick(); await harness.flush();
  assert.equal(harness.state.posts.length, 1);
  const request = harness.state.posts[0]; assert.equal(request.count, 3);
  assert.equal(request.job.prompt_text, originalPrompt); assert.equal(request.job.model, 'image-model-custom');
  assert.equal(request.job.parameters.size, '2048x3072'); assert.equal(request.job.parameters.quality, 'xhigh');
  assert.equal(request.job.parameters.background, 'transparent'); assert.equal(request.job.parameters.output_format, 'webp'); assert.equal(request.job.parameters.output_compression, 0);
  assert.equal(request.job.parameters.moderation, 'low');
});

test('add-image menu opens original upload and Library/history paths without submitting', async t => {
  const harness = inputHarness(t); await harness.flush();
  let fileOpened = 0;
  children(harness.tree).find(node => node.type === 'input' && node.props.type === 'file').props.ref.current = { click: () => fileOpened++ };
  harness.find('button', '添加参考图').onClick(); await harness.flush();
  assert.equal(harness.find('button', '添加参考图')['aria-expanded'], true);
  harness.find('button', '上传参考图').onClick(); await harness.flush(); assert.equal(fileOpened, 1);
  harness.find('button', '添加参考图').onClick(); await harness.flush();
  harness.find('button', '从 Library 或画廊选择参考图').onClick(); await harness.flush();
  const picker = children(harness.tree).find(node => node.type === 'ReferencePicker'); assert.ok(picker);
  picker.props.onSelect(input('original-bytes')); await harness.flush();
  assert.equal(children(harness.tree).find(node => node.type === 'img').props.src, 'data:image/png;base64,original-bytes');
  assert.equal(harness.state.posts.length, 0);
});

test('actual InputBar failed POST preserves input, blocks retries, and does not send from ordinary Enter or IME', async t => {
  const calls = [];
  const harness = inputHarness(t, {}, { createGenerationJob: async payload => { calls.push(payload); throw Error('uncertain network'); } });
  await harness.flush(); harness.find('textarea', '画廊提示词').onChange({ target: { value: originalPrompt } }); await harness.flush();
  const keyboard = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} };
  harness.find('textarea', '画廊提示词').onKeyDown(keyboard);
  harness.find('textarea', '画廊提示词').onKeyDown({ ...keyboard, ctrlKey: true, nativeEvent: { isComposing: true } });
  assert.equal(calls.length, 0);
  harness.find('button', '生成图片').onClick(); await harness.flush();
  assert.equal(calls.length, 1); assert.equal(harness.find('button', '生成图片').disabled, true);
  harness.find('button', '生成图片').onClick(); await harness.flush();
  assert.equal(calls.length, 1); assert.equal(harness.find('textarea', '画廊提示词').value, originalPrompt);
});

test('actual restored deleted-profile handler stays blocked instead of silently using the current default API', async t => {
  const harness = inputHarness(t, { command: { id: 1, job: historicalJob({ parameters: { ...historicalJob().parameters, compatible_profile_id: 'removed-api' } }) } });
  await harness.flush();
  assert.equal(harness.find('textarea', '画廊提示词').value, originalPrompt);
  assert.equal(harness.find('button', '生成图片').disabled, true);
  harness.find('button', '生成图片').onClick(); await harness.flush();
  assert.equal(harness.state.posts.length, 0);
});

test('actual settings navigation calls the settings callback without creating a generation task', async t => {
  const harness = inputHarness(t); await harness.flush();
  harness.find('button', 'Original API').onClick(); await harness.flush();
  harness.find('button', '管理 API 配置').onClick();
  assert.equal(harness.state.settings, 1); assert.equal(harness.state.posts.length, 0);
});

test('actual API refresh after settings does not replay an already consumed history command over new edits', async t => {
  const harness = inputHarness(t, { command: { id: 17, job: historicalJob() } });
  await harness.flush();
  harness.find('textarea', '画廊提示词').onChange({ target: { value: '  changed after restore\n' } }); await harness.flush();
  harness.update({ configurationRevision: 1 }); await harness.flush();
  assert.equal(harness.find('textarea', '画廊提示词').value, '  changed after restore\n');
  assert.equal(harness.state.posts.length, 0);
});

test('actual uncertain submission remains blocked across settings refresh for a restored recipe', async t => {
  const calls = [];
  const harness = inputHarness(t, { command: { id: 18, job: historicalJob() } }, { createGenerationJob: async value => { calls.push(value); throw Error('uncertain network'); } });
  await harness.flush(); harness.find('button', '生成图片').onClick(); await harness.flush();
  assert.equal(calls.length, 1); assert.equal(harness.find('button', '生成图片').disabled, true);
  harness.update({ configurationRevision: 1 }); await harness.flush();
  assert.equal(harness.find('button', '生成图片').disabled, true);
  harness.find('button', '生成图片').onClick(); await harness.flush(); assert.equal(calls.length, 1);
});

test('actual late historical lookup failure cannot overwrite a more recently restored recipe', async t => {
  const lookup = deferred();
  const item = { id: 'library-a', title: 'A', prompts: [{ text: 'old library prompt', is_original: true }], images: [{ id: 'image-a', role: 'reference_image', generation_provider: 'openai_compatible' }] };
  const harness = inputHarness(t, { command: { id: 30, item, imageId: 'image-a' } }, { generationJobForImage: () => lookup.promise });
  await harness.flush();
  harness.update({ command: { id: 31, job: historicalJob({ prompt_text: 'newest recipe' }) } }); await harness.flush();
  lookup.reject(Error('old lookup missing')); await harness.flush();
  assert.equal(harness.find('textarea', '画廊提示词').value, 'newest recipe');
  assert.equal(harness.find('button', '生成图片').disabled, false);
});

test('pending historical metadata cannot overwrite newer typed prompt', async t => {
  const lookup = deferred();
  const item = { id: 'library-a', title: 'A', prompts: [{ text: 'old library prompt', is_original: true }], images: [{ id: 'image-a', role: 'reference_image', generation_provider: 'openai_compatible' }] };
  const h = inputHarness(t, { command: { id: 1001, item, imageId: 'image-a' } }, { generationJobForImage: () => lookup.promise }); await h.flush();
  h.find('textarea', '画廊提示词').onChange({ target: { value: 'new user prompt' } }); await h.flush();
  lookup.resolve(historicalJob()); await h.flush();
  assert.equal(h.find('textarea', '画廊提示词').value, 'new user prompt');
  assert.equal(h.find('button', '生成图片').disabled, false);
  assert.equal(h.state.posts.length, 0);
});

test('pending original reference restoration cannot overwrite newer model edits', async t => {
  const decode = deferred();
  const job = historicalJob({ parameters: { ...historicalJob().parameters, input_images: [{ id: 'ref', data_url: 'data:image/png;base64,original' }] } });
  const h = inputHarness(t, { command: { id: 1002, job } }, {}, { decode: () => decode.promise }); await h.flush();
  h.find('button', '请求模型 gateway-original-alias').onClick(); await h.flush();
  h.find('input', '请求模型完整 ID').onChange({ target: { value: 'new-model' } }); await h.flush();
  decode.resolve(); await h.flush();
  assert.equal(h.find('input', '请求模型完整 ID').value, 'new-model');
  assert.equal(h.state.posts.length, 0);
});

for (const phase of ['providers', 'stored-draft']) test(`late ${phase} initialization preserves user edits`, async t => {
  const pending = deferred();
  const profiles = { profiles: [{ id: 'original-api', display_name: 'Original API', model: 'gateway-original-alias', configured: true }], default_profile_id: 'original-api' };
  const h = inputHarness(t, { preferences: { persistInputOnRestart: true } }, phase === 'providers' ? { openAICompatibleProfiles: () => pending.promise } : {}, { readGalleryDraft: () => phase === 'stored-draft' ? pending.promise : Promise.resolve(undefined) }); await h.flush();
  h.find('textarea', '画廊提示词').onChange({ target: { value: 'typed during initialization' } }); await h.flush();
  pending.resolve(phase === 'providers' ? profiles : { ...recipe.emptyGalleryDraft(), prompt: 'old persisted draft' }); await h.flush();
  assert.equal(h.find('textarea', '画廊提示词').value, 'typed during initialization');
  assert.equal(h.state.posts.length, 0);
});

const composerChip = (h, name) => children(h.tree).find(node => node.type === 'button' && node.props.className?.includes(`pg-param-${name}`)).props;
const pendingEdits = {
  'dropped prompt': async h => { h.find('textarea', '画廊提示词').onDrop({ preventDefault() {}, dataTransfer: { files: [], getData: type => type === 'text/plain' ? '\nnew text' : '' } }); return payload => assert.equal(payload.prompt_text, 'current {{subject}}\nnew text'); },
  model: async h => { composerChip(h, 'model').onClick(); await h.flush(); h.find('input', '请求模型完整 ID').onChange({ target: { value: 'edited-model' } }); return payload => assert.equal(payload.model, 'edited-model'); },
  profile: async h => { h.find('button', 'Original API').onClick(); await h.flush(); children(h.tree).find(node => node.type === 'button' && node.props.children?.[0] === 'Other API').props.onClick(); return payload => assert.equal(payload.parameters.compatible_profile_id, 'other-api'); },
  size: async h => { composerChip(h, 'size').onClick(); await h.flush(); children(h.tree).find(node => node.type === 'SizeDialog').props.onApply({ size: '2048x3072' }); return payload => assert.equal(payload.parameters.size, '2048x3072'); },
  quality: async h => { composerChip(h, 'quality').onClick(); await h.flush(); children(h.tree).find(node => node.type === 'button' && node.props.children?.at?.(-1) === 'high').props.onClick(); return payload => assert.equal(payload.parameters.quality, 'high'); },
  format: async h => { composerChip(h, 'more').onClick(); await h.flush(); h.find('select', '输出格式').onChange({ target: { value: 'png' } }); return payload => assert.equal(payload.parameters.output_format, 'png'); },
  count: async h => { h.find('select', '生成数量').onChange({ target: { value: '3' } }); return (_payload, posted) => assert.equal(posted.count, 3); },
  template: async h => { const label = children(h.tree).find(node => node.type === 'label' && node.props.children?.[0] === 'subject'); children(label).find(node => node.type === 'input').props.onChange({ target: { value: 'new subject' } }); return payload => assert.equal(payload.parameters.prompt_template_values.subject, 'new subject'); },
  'selected attachment': async h => { h.find('button', '添加参考图').onClick(); await h.flush(); h.find('button', '从 Library 或画廊选择参考图').onClick(); await h.flush(); children(h.tree).find(node => node.type === 'ReferencePicker').props.onSelect(input('new-reference')); return payload => assert.deepEqual(payload.parameters.input_images.map(value => value.id), ['keep', 'new-reference']); },
  'removed attachment': async h => { h.find('button', '移除参考图 1').onClick(); return payload => assert.equal(payload.parameters.input_images.length, 0); },
};
for (const phase of ['metadata', 'reference']) for (const [label, edit] of Object.entries(pendingEdits)) test(`${phase} restore cannot replace newer ${label}`, async t => {
  const pending = deferred();
  const base = historicalJob({ prompt_text: 'current cat', parameters: { ...historicalJob().parameters, prompt_template: 'current {{subject}}', prompt_template_values: { subject: 'cat' }, input_images: [{ id: 'keep', data_url: 'data:image/png;base64,keep' }] } });
  const stale = historicalJob({ prompt_text: 'stale recipe', parameters: { ...historicalJob().parameters, input_images: [{ id: 'stale', data_url: 'data:image/png;base64,pending' }] } });
  const h = inputHarness(t, { command: { id: 1200, job: base }, promptVariablesEnabled: true }, {
    generationJobForImage: () => pending.promise,
    openAICompatibleProfiles: async () => ({ profiles: [{ id: 'original-api', display_name: 'Original API', model: 'gateway-original-alias', configured: true }, { id: 'other-api', display_name: 'Other API', model: 'other-model', configured: true }], default_profile_id: 'original-api' }),
  }, { decode: src => src.endsWith(',pending') && phase === 'reference' ? pending.promise : undefined });
  await h.flush();
  const item = { id: 'stale-item', title: 'Old', prompts: [], images: [{ id: 'stale-image', role: 'reference_image', generation_provider: 'openai_compatible' }] };
  h.update({ command: phase === 'metadata' ? { id: 1201, item } : { id: 1201, job: stale } }); await h.flush();
  const verify = await edit(h); await h.flush();
  pending.resolve(phase === 'metadata' ? stale : undefined); await h.flush();
  assert.equal(h.state.posts.length, 0);
  h.find('button', '生成图片').onClick(); await h.flush();
  assert.equal(h.state.posts.length, 1, 'new user draft remains usable after the stale request finishes');
  const posted = h.state.posts[0], payload = posted.job || posted;
  assert.ok(payload.prompt_text.startsWith('current {{subject}}'));
  verify(payload, posted);
});

test('hiding the composer invalidates a pending restore without replaying it when shown again', async t => {
  const decode = deferred();
  const h = inputHarness(t, { command: { id: 1300, job: historicalJob({ prompt_text: 'current prompt' }) } }, {}, { decode: () => decode.promise }); await h.flush();
  h.update({ command: { id: 1301, job: historicalJob({ prompt_text: 'stale prompt', parameters: { ...historicalJob().parameters, input_images: [{ data_url: 'data:image/png;base64,pending' }] } }) } }); await h.flush();
  h.update({ active: false }); await h.flush(); decode.resolve(); await h.flush();
  h.update({ active: true }); await h.flush();
  assert.equal(h.find('textarea', '画廊提示词').value, 'current prompt');
  assert.equal(h.find('button', '生成图片').disabled, false);
});

test('settings refresh invalidates a pending history restore and leaves the current draft intact', async t => {
  const lookup = deferred();
  const h = inputHarness(t, { command: { id: 1400, job: historicalJob({ prompt_text: 'current prompt' }) } }, { generationJobForImage: () => lookup.promise }); await h.flush();
  h.update({ command: { id: 1401, item: { id: 'old', title: 'Old', prompts: [], images: [{ id: 'old-image', role: 'reference_image', generation_provider: 'openai_compatible' }] } } }); await h.flush();
  h.update({ configurationRevision: 1 }); await h.flush(); lookup.resolve(historicalJob()); await h.flush();
  assert.equal(h.find('textarea', '画廊提示词').value, 'current prompt');
  assert.equal(h.find('button', '生成图片').disabled, false);
});

test('interrupted first draft initialization can finish on the next settings revision', async t => {
  const first = deferred(), second = deferred(); let reads = 0;
  const h = inputHarness(t, { preferences: { persistInputOnRestart: true } }, {}, { readGalleryDraft: () => ++reads === 1 ? first.promise : second.promise }); await h.flush();
  h.update({ configurationRevision: 1 }); await h.flush();
  second.resolve({ ...recipe.emptyGalleryDraft(), profileId: 'original-api', prompt: 'latest disk draft' }); await h.flush();
  first.resolve({ ...recipe.emptyGalleryDraft(), prompt: 'old disk draft' }); await h.flush();
  assert.equal(reads, 2); assert.equal(h.find('textarea', '画廊提示词').value, 'latest disk draft');
});

test('missing restored references still block submission until the user explicitly removes them', async t => {
  const h = inputHarness(t, { command: { id: 1500, job: historicalJob({ mode: 'image_edit', parameters: { ...historicalJob().parameters, input_images: [{ id: 'missing', data_url: 'data:image/png;base64,missing' }] } }) } }, {}, { decode: async () => { throw Error('missing'); } }); await h.flush();
  assert.equal(h.find('button', '生成图片').disabled, true); h.find('button', '生成图片').onClick(); await h.flush(); assert.equal(h.state.posts.length, 0);
  h.find('button', '移除参考图 1').onClick(); await h.flush(); h.find('button', '生成图片').onClick(); await h.flush();
  assert.equal(h.state.posts.length, 1); assert.equal(h.state.posts[0].mode, 'text_to_image');
});

test('typing while a selected file is read preserves both inputs and blocks premature submission', async t => {
  const file = deferred();
  const h = inputHarness(t, {}, {}, { readFile: () => file.promise }); await h.flush();
  h.find('textarea', '画廊提示词').onPaste({ preventDefault() {}, clipboardData: { files: [new File(['synthetic'], 'chosen.png', { type: 'image/png' })] } }); await h.flush();
  h.find('textarea', '画廊提示词').onChange({ target: { value: 'typed while reading image' } }); await h.flush();
  assert.equal(h.find('button', '生成图片').disabled, true); h.find('button', '生成图片').onClick(); await h.flush(); assert.equal(h.state.posts.length, 0);
  file.resolve('data:image/png;base64,chosen-original'); await h.flush();
  assert.equal(h.find('textarea', '画廊提示词').value, 'typed while reading image');
  h.find('button', '生成图片').onClick(); await h.flush();
  assert.equal(h.state.posts.length, 1); assert.equal(h.state.posts[0].parameters.input_images[0].data_url, 'data:image/png;base64,chosen-original');
});

for (const interruption of ['new-command', 'inactive']) test(`late selected file is ignored after ${interruption}`, async t => {
  const file = deferred(); const h = inputHarness(t, {}, {}, { readFile: () => file.promise }); await h.flush();
  const field = children(h.tree).find(node => node.type === 'input' && node.props.type === 'file');
  field.props.onChange({ target: { files: [new File(['synthetic'], 'old.png', { type: 'image/png' })], value: 'old.png' } }); await h.flush();
  h.update(interruption === 'new-command' ? { command: { id: 1600, job: historicalJob({ prompt_text: 'new draft' }) } } : { active: false }); await h.flush();
  file.resolve('data:image/png;base64,old-original'); await h.flush();
  assert.equal(children(h.tree).filter(node => node.type === 'img').length, 0);
  assert.equal(h.find('textarea', '画廊提示词').value, interruption === 'new-command' ? 'new draft' : '');
});

test('pasting a selected image cancels old recipe recovery without losing the new file', async t => {
  const lookup = deferred();
  const h = inputHarness(t, { command: { id: 1700, item: { id: 'old', title: 'Old', prompts: [], images: [{ id: 'old-image', role: 'reference_image', generation_provider: 'openai_compatible' }] } } }, { generationJobForImage: () => lookup.promise }, { readFile: () => 'data:image/png;base64,new-original' }); await h.flush();
  h.find('textarea', '画廊提示词').onPaste({ preventDefault() {}, clipboardData: { files: [new File(['synthetic'], 'new.png', { type: 'image/png' })] } }); await h.flush();
  lookup.resolve(historicalJob()); await h.flush();
  assert.equal(children(h.tree).find(node => node.type === 'img').props.src, 'data:image/png;base64,new-original');
  assert.equal(h.find('textarea', '画廊提示词').value, ''); assert.equal(h.state.posts.length, 0);
});

const historicalTransport = { base_url_mode: 'custom', stream: true, partial_images: 2, response_format: 'b64_json' };
test('actual restored submission keeps frozen transport through ordinary edits and settings refresh', async t => {
  const h = inputHarness(t, { command: { id: 1800, job: historicalJob({ parameters: { ...historicalJob().parameters, ...historicalTransport }, metadata: { requested: { stream: false, partial_images: 0 } } }) } }); await h.flush();
  h.find('textarea', '画廊提示词').onChange({ target: { value: 'edited history' } }); await h.flush();
  h.update({ configurationRevision: 1 }); await h.flush(); h.find('button', '生成图片').onClick(); await h.flush();
  assert.deepEqual(Object.fromEntries(Object.keys(historicalTransport).map(key => [key, h.state.posts[0].parameters[key]])), { ...historicalTransport, stream: false, partial_images: 0 });
});

for (const action of ['choose-profile', 'reset-profile', 'oauth']) test(`${action} clears frozen transport before a new API submission`, async t => {
  const h = inputHarness(t, { command: { id: 1801, job: historicalJob({ parameters: { ...historicalJob().parameters, ...historicalTransport } }) } }, {
    generationProviders: async () => [{ provider: 'openai_compatible', display_name: 'Compatible', max_input_images: 4, can_generate: true }, { provider: 'xai_grok_oauth', display_name: 'Grok OAuth', can_generate: true, default_image_model: 'grok-model' }],
  }); await h.flush();
  if (action === 'reset-profile') h.emitPreferenceReset('original-api');
  else { h.find('button', 'Original API').onClick(); await h.flush(); children(h.tree).find(node => node.type === 'button' && node.props.children?.[0] === (action === 'oauth' ? 'Grok OAuth' : 'Original API')).props.onClick(); }
  await h.flush(); h.find('button', '生成图片').onClick(); await h.flush();
  assert.equal(h.state.posts.length, 1);
  for (const key of Object.keys(historicalTransport)) assert.equal(h.state.posts[0].parameters[key], undefined, `${key} must use the explicitly chosen connection defaults`);
});

test('legacy history displays its transport fallback until the user explicitly chooses a profile', async t => {
  const h = inputHarness(t, { command: { id: 1802, job: historicalJob() } }); await h.flush();
  const message = () => children(h.tree).find(node => node.type === 'p' && node.props.children === '旧记录未保存传输选项，按旧版默认值恢复');
  assert.ok(message()); h.find('button', 'Original API').onClick(); await h.flush();
  children(h.tree).find(node => node.type === 'button' && node.props.children?.[0] === 'Original API').props.onClick(); await h.flush();
  assert.equal(message(), undefined);
});

const workspaceSource = await readFile(new URL('../frontend/src/components/gallery/GalleryWorkspace.tsx', import.meta.url), 'utf8');
const workspaceJs = ts.transpileModule(workspaceSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function workspaceHarness(t, api, overrides = {}, environment = {}) {
  const slots = [], effects = []; let cursor = 0, dirty = false, tree;
  const memo = (get, deps) => { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { deps, value: get() }; return slots[i].value; };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps, cleanup: undefined }; } },
    useCallback: (callback, deps) => memo(() => callback, deps), useMemo: memo,
  };
  const jsx = (type, props) => ({ type, props });
  const deps = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    fflate: { zipSync: environment.zipSync || (() => { throw Error('download not part of this test'); }) }, '../../api/client': { api, mediaUrl: path => `/media/${path}` },
    '../../utils/galleryRecipe': recipe, './InputBar': { __esModule: true, default: 'InputBar' }, './TaskGrid': { __esModule: true, default: 'TaskGrid' }, './DetailModal': { __esModule: true, default: 'DetailModal' }, './Lightbox': { __esModule: true, default: 'Lightbox' }, './GalleryWorkspace.css': {},
    '../../utils/generationSiblings': generationSiblings,
    '../../utils/galleryHistory': history,
    // Grouping/retry collapsing has separate real-component coverage in explore-view.test.mjs.
    '../GenerationQueueDrawer': { __esModule: true, default: 'GenerationQueueDrawer', groupGenerationQueueJobs: jobs => [...new Set(jobs.map(job => job.generation_group_id))].map(id => ({ generationGroupId: id, jobs: jobs.filter(job => job.generation_group_id === id) })) },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', 'document', 'window', 'URL', 'setTimeout', 'clearTimeout', workspaceJs)(name => { assert.ok(name in deps, `unmocked workspace dependency: ${name}`); return deps[name]; }, module, module.exports, environment.fetch || globalThis.fetch, environment.document || globalThis.document, environment.window || globalThis.window, environment.URL || globalThis.URL, environment.setTimeout || globalThis.setTimeout, environment.clearTimeout || globalThis.clearTimeout);
  const props = { active: true, queueOpen: false, onQueueOpenChange() {}, t: key => key, preferences: {}, refreshKey: 0, configurationRevision: 0, onOpenSettings() {}, onAccepted() {}, onQueueChanged() {}, ...overrides };
  const render = () => { dirty = false; cursor = 0; tree = module.exports.default(props); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); };
  render(); t.after(() => slots.forEach(slot => slot?.cleanup?.()));
  return { flush, get tree() { return tree; }, node: (type, predicate = () => true) => children(tree).find(node => node.type === type && predicate(node.props))?.props };
}

test('gallery selection replaces the header controls without inserting a row and cancellation restores focus', async t => {
  const job = historicalJob({ id: 'selected-job' });
  const harness = workspaceHarness(t, { generationJobs: async () => ({ jobs: [job], total: 1 }) });
  await harness.flush();
  const header = () => harness.node('header', props => props.className === 'pg-gallery-header');
  const toolbar = () => harness.node('div', props => props['aria-label'] === '批量操作');
  const filters = () => harness.node('div', props => props.className?.split(' ').includes('pg-gallery-filters'));
  const results = () => harness.node('div', props => props.className === 'pg-gallery-results');
  const primaryChildren = () => harness.tree.props.children.filter(node => node && typeof node === 'object').slice(0, 2).map(node => node.props.className);
  const focus = [];
  results().ref.current = { focus: options => focus.push(options) };
  assert.deepEqual(primaryChildren(), ['pg-gallery-header', 'pg-gallery-results']);
  assert.equal(header().children.length, 2);
  assert.equal(toolbar().inert, true);
  assert.equal(toolbar()['aria-hidden'], true);
  assert.equal(filters().inert, false);
  harness.node('input', props => props['aria-label'] === '搜索生成历史').onChange({ target: { value: '原文' } }); await harness.flush();
  harness.node('TaskGrid').onSelection(new Set([job.id])); await harness.flush();
  assert.deepEqual(primaryChildren(), ['pg-gallery-header', 'pg-gallery-results']);
  assert.equal(header().children.length, 2, 'both header modes stay mounted');
  assert.equal(toolbar().inert, false);
  assert.equal(filters().inert, true);
  assert.equal(filters()['aria-hidden'], true);
  assert.equal(harness.node('b').children, 1);
  harness.node('button', props => props.children === '取消选择').onClick(); await harness.flush();
  assert.equal(harness.node('TaskGrid').selected.size, 0);
  assert.deepEqual(focus, [{ preventScroll: true }]);
  assert.equal(toolbar().inert, true);
  assert.equal(filters().inert, false);
  assert.equal(harness.node('input', props => props['aria-label'] === '搜索生成历史').value, '原文');
  assert.deepEqual(primaryChildren(), ['pg-gallery-header', 'pg-gallery-results']);
});

test('completion feedback dismisses itself without adding content before the gallery results', async t => {
  const timers = new Map(); let nextTimer = 0;
  let job = historicalJob({ status: 'running' });
  const harness = workspaceHarness(t, { generationJobs: async () => ({ jobs: [job], total: 1 }) }, { preferences: { notifyOnCompletion: true } }, {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  await harness.flush();
  job = { ...job, status: 'succeeded' };
  harness.node('button', props => props['aria-label'] === '刷新生成历史').onClick(); await harness.flush();
  const feedback = harness.node('div', props => props.className?.split(' ').includes('pg-gallery-feedback'));
  assert.equal(feedback.role, 'status');
  assert.equal(feedback.children[0].props.children, '生成任务已有新结果');
  assert.deepEqual(harness.tree.props.children.filter(node => node && typeof node === 'object').slice(0, 2).map(node => node.props.className), ['pg-gallery-header', 'pg-gallery-results']);
  const timer = [...timers.values()].find(value => value.delay === 3500);
  assert.ok(timer, 'a completion notification has a bounded lifetime');
  timer.callback(); await harness.flush();
  assert.equal(harness.node('div', props => props.className?.split(' ').includes('pg-gallery-feedback')), undefined);
});

test('copy failure feedback survives history refresh until explicitly dismissed', async t => {
  const job = historicalJob(); let refreshes = 0;
  const harness = workspaceHarness(t, { generationJobs: async () => { refreshes++; return { jobs: [job], total: 1 }; } });
  await harness.flush();
  harness.node('TaskGrid').onMessage('复制失败，请打开详情手动复制'); await harness.flush();
  const feedback = () => harness.node('div', props => props.className?.split(' ').includes('pg-gallery-feedback'));
  assert.equal(feedback().role, 'alert');
  harness.node('button', props => props['aria-label'] === '刷新生成历史').onClick(); await harness.flush();
  assert.equal(refreshes, 2);
  assert.equal(feedback().children[0].props.children, '复制失败，请打开详情手动复制');
  harness.node('button', props => props['aria-label'] === '关闭画廊提示').onClick(); await harness.flush();
  assert.equal(feedback(), undefined);
  assert.equal(harness.node('TaskGrid').jobs[0].prompt_text, originalPrompt);
});

function historyStorage(t) {
  for (const name of ['localStorage', 'sessionStorage']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name), values = new Map();
    Object.defineProperty(globalThis, name, { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  }
}

test('gallery filters successes including accepted records before paging and remembers an explicit choice', async t => {
  historyStorage(t);
  const all = ['succeeded', 'accepted', 'failed', 'running'].map(status => historicalJob({ id: status, status }));
  const calls = [];
  const api = { generationJobs: async params => {
    calls.push(params); const jobs = all.filter(job => !params.statuses || params.statuses.split(',').includes(job.status));
    return { jobs, total: jobs.length };
  } };
  const harness = workspaceHarness(t, api); await harness.flush();
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => job.id), ['succeeded', 'accepted']);
  assert.equal(calls[0].prepare_references, false);
  harness.node('select', props => props['aria-label'] === '任务状态筛选').onChange({ target: { value: 'completed' } }); await harness.flush();
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => job.id), ['succeeded', 'accepted', 'failed']);
  assert.equal(history.readGalleryFilter(), 'completed');
  const reopened = workspaceHarness(t, api); await reopened.flush();
  assert.equal(reopened.node('select', props => props['aria-label'] === '任务状态筛选').value, 'completed');
});

test('successful-only gallery confirms a queued submission without changing the saved filter', async t => {
  historyStorage(t);
  const calls = [];
  let queueChanged = 0;
  const harness = workspaceHarness(t, { generationJobs: async (params, options) => {
    calls.push({ params, options }); return { jobs: [], total: 0 };
  } }, { onQueueChanged: () => queueChanged++ });
  await harness.flush();
  harness.node('InputBar').onCreated(); await harness.flush();
  assert.equal(harness.node('select', props => props['aria-label'] === '任务状态筛选').value, 'successful');
  assert.equal(history.readGalleryFilter(), 'successful');
  assert.ok(children(harness.tree).some(node => node.props?.children === '已加入工作队列，可通过右上角历史记录查看进度。'));
  assert.equal(calls.at(-1).options.fresh, true);
  assert.equal(queueChanged, 1);
});

test('cached cards appear while a request is pending but reuse waits for the authoritative full recipe', async t => {
  historyStorage(t);
  const job = historicalJob({ result_path: 'generation-results/result.png' });
  history.saveGalleryHistory('library-a', 'successful', { jobs: [job], total: 1 });
  const list = deferred(), detail = deferred();
  const harness = workspaceHarness(t, { generationJobs: () => list.promise, generationJob: () => detail.promise }, { libraryScope: 'library-a' });
  await harness.flush();
  const cached = harness.node('TaskGrid').jobs[0];
  assert.equal(cached.prompt_text, originalPrompt); assert.equal(cached.parameters?.compatible_profile_id, undefined);
  harness.node('TaskGrid').onReuse(cached); await harness.flush();
  assert.equal(harness.node('InputBar').command, undefined);
  detail.resolve(job); await harness.flush();
  assert.equal(harness.node('InputBar').command.job.parameters.compatible_profile_id, 'original-api');
  list.resolve({ jobs: [], total: 0 }); await harness.flush();
  assert.equal(harness.node('TaskGrid'), undefined);
  assert.deepEqual(history.readGalleryHistory('library-a', 'successful').jobs, []);
});

test('late history for an old filter cannot replace the new filter or its cache', async t => {
  historyStorage(t); const old = deferred();
  const failed = historicalJob({ id: 'failed', status: 'failed' });
  const harness = workspaceHarness(t, { generationJobs: params => params.statuses === 'succeeded,accepted' ? old.promise : Promise.resolve({ jobs: [failed], total: 1 }) }, { libraryScope: 'library-a' });
  await harness.flush();
  harness.node('select', props => props['aria-label'] === '任务状态筛选').onChange({ target: { value: 'completed' } }); await harness.flush();
  old.resolve({ jobs: [historicalJob()], total: 1 }); await harness.flush();
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => job.id), ['failed']);
  assert.deepEqual(history.readGalleryHistory('library-a', 'completed').jobs.map(job => job.id), ['failed']);
});

test('cached history stays visible on outage and is identified as stale, never mistaken for a successful refresh', async t => {
  historyStorage(t); const job = historicalJob();
  history.saveGalleryHistory('library-a', 'successful', { jobs: [job], total: 1 });
  const harness = workspaceHarness(t, { generationJobs: async () => { throw Error('offline'); } }, { libraryScope: 'library-a' });
  await harness.flush();
  assert.equal(harness.node('TaskGrid').jobs[0].id, job.id);
  const feedback = harness.node('div', props => props.className?.includes('pg-gallery-feedback'));
  assert.equal(feedback.role, 'alert'); assert.match(feedback.children[0].props.children, /上次列表.*offline/);
});

test('completion notice works when successful-only filtering hides running and failed rows', async t => {
  const job = historicalJob(); let failed = 0;
  const harness = workspaceHarness(t, { generationJobs: async () => ({ jobs: [job], total: 1, status_counts: { succeeded: 1, accepted: 0, failed } }) }, { preferences: { notifyOnCompletion: true } });
  await harness.flush(); failed = 1;
  harness.node('button', props => props['aria-label'] === '刷新生成历史').onClick(); await harness.flush();
  assert.equal(harness.node('div', props => props.className?.includes('pg-gallery-feedback')).role, 'status');
});

test('resetting browser parameters only resets the matching recipe, preserving prompt and reference inputs', async t => {
  const harness = inputHarness(t, { command: { id: 99, job: historicalJob() } }); await harness.flush();
  harness.find('button', '添加参考图').onClick(); await harness.flush();
  harness.find('button', '从 Library 或画廊选择参考图').onClick(); await harness.flush();
  children(harness.tree).find(node => node.type === 'ReferencePicker').props.onSelect(input('retained')); await harness.flush();
  harness.emitPreferenceReset('different-api'); await harness.flush();
  assert.equal(harness.find('button', '生成图片').disabled, false);
  preferences.resetGenerationPreference(localStorage, 'original-api');
  harness.emitPreferenceReset('original-api'); await harness.flush();
  harness.find('button', '生成图片').onClick(); await harness.flush();
  const payload = harness.state.posts[0];
  assert.equal(payload.prompt_text, originalPrompt); assert.equal(payload.parameters.quality, 'auto');
  assert.equal(payload.parameters.size, 'auto'); assert.equal(payload.parameters.compatible_profile_id, 'original-api');
  assert.equal(payload.parameters.input_images[0].id, 'retained');
});

test('actual history load-more callbacks can reach entries beyond 1000 through bounded API pages', async t => {
  const all = Array.from({ length: 1201 }, (_, index) => historicalJob({ id: `job-${index}` }));
  const calls = [];
  const harness = workspaceHarness(t, { generationJobs: async ({ limit, offset = 0 }) => { calls.push({ limit, offset }); return { jobs: all.slice(offset, offset + limit), total: all.length }; } });
  await harness.flush();
  assert.equal(harness.node('TaskGrid').jobs.length, 48, 'first paint uses a small page');
  for (let i = 0; i < 25; i++) { const more = harness.node('button', props => props.className === 'pg-load-more'); assert.ok(more); assert.notEqual(more.disabled, true); more.onClick(); await harness.flush(); }
  const jobs = harness.node('TaskGrid').jobs;
  assert.equal(jobs.length, 1201); assert.equal(jobs.at(-1).id, 'job-1200');
  assert.ok(calls.every(call => call.limit <= 1000)); assert.ok(calls.some(call => call.offset > 0));
});

test('actual late detail responses cannot replace a newer selection or reopen a closed detail', async t => {
  const a = historicalJob({ id: 'a' }), b = historicalJob({ id: 'b' });
  const first = deferred(), second = deferred(), third = deferred(); let count = 0;
  const harness = workspaceHarness(t, { generationJobs: async () => ({ jobs: [a, b], total: 2 }), generationJob: () => [first, second, third][count++].promise });
  await harness.flush(); harness.node('TaskGrid').onOpen(a); harness.node('TaskGrid').onOpen(b); await harness.flush();
  second.resolve(b); await harness.flush(); first.resolve(a); await harness.flush();
  assert.equal(harness.node('DetailModal').job.id, 'b');
  harness.node('TaskGrid').onOpen(a); await harness.flush(); harness.node('DetailModal').onClose(); await harness.flush();
  third.resolve(a); await harness.flush(); assert.equal(harness.node('DetailModal'), undefined);
});

test('actual externally focused historical result opens its original image even before its list page is loaded', async t => {
  const job = historicalJob({ id: 'outside-current-page', result_path: 'generation-results/original.webp' });
  const harness = workspaceHarness(t, { generationJobs: async () => ({ jobs: [], total: 0 }), generationJob: async () => job }, { focusJobId: job.id });
  await harness.flush(); harness.node('DetailModal').onLightbox(); await harness.flush();
  assert.equal(harness.node('Lightbox')?.src, '/media/generation-results/original.webp');
});

test('queue callbacks close the queue, scope batch results and restore the complete loaded history', async t => {
  const a = historicalJob({ id: 'a' }), b = historicalJob({ id: 'b' }), outsidePage = historicalJob({ id: 'older-batch-job' });
  const queueStates = [], reads = [];
  const harness = workspaceHarness(t, {
    generationJobs: async () => ({ jobs: [a, b], total: 2 }),
    generationJob: async id => { reads.push(id); return { ...outsidePage, id }; },
    generationSet: async id => { assert.equal(id, 'old-batch'); return { jobs: [b, outsidePage], total: 2 }; },
  }, { queueOpen: true, onQueueOpenChange: open => queueStates.push(open) });
  await harness.flush();
  harness.node('GenerationQueueDrawer').onOpenBatch([b, outsidePage], 2, 'old-batch'); await harness.flush();
  assert.deepEqual(queueStates, [false]);
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => job.id), ['b', 'older-batch-job']);
  harness.node('button', props => props.children === '返回全部历史').onClick(); await harness.flush();
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => job.id), ['a', 'b']);
  harness.node('GenerationQueueDrawer').onOpenJob(outsidePage); await harness.flush();
  assert.deepEqual(queueStates, [false, false]); assert.deepEqual(reads, ['older-batch-job']);
  assert.equal(harness.node('DetailModal').job.id, 'older-batch-job');
});

test('an old queue batch refreshes outside the global page and uses its current original for download and cleanup', async t => {
  const newer = historicalJob({ id: 'newer-global-job' });
  let old = historicalJob({ id: 'old-slot', status: 'running', generation_group_id: 'old-batch', generation_group_index: 1, generation_group_size: 3 });
  const calls = { sets: [], fetches: [], discarded: [], archives: [], clicks: 0, changed: 0, revoked: [] };
  const bytes = Uint8Array.from([0, 12, 255, 24]);
  const anchor = { click() { calls.clicks++; } };
  const harness = workspaceHarness(t, {
    generationJobs: async () => ({ jobs: [newer], total: 1 }),
    generationSet: async id => { calls.sets.push(id); return { jobs: [{ ...old }], total: 3 }; },
    discardGenerationJob: async id => { calls.discarded.push(id); old = { ...old, status: 'discarded', result_path: undefined }; },
  }, { onQueueChanged: () => calls.changed++ }, {
    fetch: async url => { calls.fetches.push(url); return { ok: true, arrayBuffer: async () => bytes.buffer }; },
    zipSync: (files, options) => { calls.archives.push({ files, options }); return bytes; },
    document: { createElement: tag => { assert.equal(tag, 'a'); return anchor; } },
    window: { confirm: () => true },
    URL: { createObjectURL: blob => { assert.equal(blob.type, 'application/zip'); return 'blob:isolated-download'; }, revokeObjectURL: url => calls.revoked.push(url) },
    setTimeout: (callback, delay) => { assert.equal(delay, 60000); callback(); return 0; },
  });
  await harness.flush();
  harness.node('GenerationQueueDrawer').onOpenBatch([old], 3, 'old-batch'); await harness.flush();
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => [job.id, job.status]), [['old-slot', 'running']]);
  assert.deepEqual(calls.sets, ['old-batch']);

  old = { ...old, status: 'succeeded', result_path: 'generation-results/old-original.webp' };
  harness.node('button', props => props['aria-label'] === '刷新生成历史').onClick(); await harness.flush();
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => [job.id, job.status]), [['old-slot', 'succeeded']]);
  harness.node('TaskGrid').onSelection(new Set(['old-slot'])); await harness.flush();
  harness.node('button', props => Array.isArray(props.children) && props.children.includes('打包原图')).onClick(); await harness.flush();
  assert.deepEqual(calls.fetches, ['/media/generation-results/old-original.webp']);
  assert.deepEqual(calls.archives[0], { files: { 'old-slot.webp': bytes }, options: { level: 0 } });
  assert.equal(calls.clicks, 1); assert.equal(anchor.download, 'generation-results.zip');
  assert.deepEqual(calls.revoked, ['blob:isolated-download']);

  harness.node('button', props => Array.isArray(props.children) && props.children.includes('清理结果')).onClick(); await harness.flush();
  assert.deepEqual(calls.discarded, ['old-slot']);
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => [job.id, job.status, job.result_path]), [['old-slot', 'discarded', undefined]]);
  assert.equal(harness.node('TaskGrid').selected.size, 0); assert.equal(calls.changed, 1);
  assert.equal(harness.node('p', props => props.role === 'alert'), undefined);
  assert.deepEqual(calls.sets, ['old-batch', 'old-batch', 'old-batch']);
  harness.node('button', props => props.children === '返回全部历史').onClick(); await harness.flush();
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => job.id), ['newer-global-job']);
});

test('reopening the same batch focuses its results each time, while refresh does not steal focus', async t => {
  const job = historicalJob({ id: 'old-job', generation_group_id: 'old-batch' });
  let focusCount = 0;
  const harness = workspaceHarness(t, {
    generationJobs: async () => ({ jobs: [], total: 0 }),
    generationSet: async () => ({ jobs: [job], total: 1 }),
  });
  await harness.flush();
  harness.node('div', props => props.className === 'pg-gallery-results').ref.current = {
    scrollTo() {}, focus() { focusCount++; },
  };
  harness.node('GenerationQueueDrawer').onOpenBatch([job], 1, 'old-batch'); await harness.flush();
  assert.equal(focusCount, 1);
  harness.node('button', props => props['aria-label'] === '刷新生成历史').onClick(); await harness.flush();
  assert.equal(focusCount, 1);
  harness.node('GenerationQueueDrawer').onOpenBatch([job], 1, 'old-batch'); await harness.flush();
  assert.equal(focusCount, 2);
});

test('creating a task from an old batch returns to all history so the new task is visible', async t => {
  const old = historicalJob({ id: 'old-job', generation_group_id: 'old-batch' });
  const created = historicalJob({ id: 'new-job', status: 'queued' });
  let rows = [old];
  const harness = workspaceHarness(t, {
    generationJobs: async () => ({ jobs: rows, total: rows.length }),
    generationSet: async () => ({ jobs: [old], total: 1 }),
  });
  await harness.flush();
  harness.node('GenerationQueueDrawer').onOpenBatch([old], 1, 'old-batch'); await harness.flush();
  harness.node('TaskGrid').onSelection(new Set([old.id])); await harness.flush();
  rows = [created, old];
  harness.node('InputBar').onCreated(); await harness.flush();
  assert.deepEqual(harness.node('TaskGrid').jobs.map(job => job.id), ['new-job', 'old-job']);
  assert.equal(harness.node('TaskGrid').selected.size, 0);
  assert.equal(harness.node('button', props => props.children === '返回全部历史'), undefined);
});

for (const provider of ['openai_codex_oauth_native', 'xai_grok_oauth']) test(`actual switch from compatible auto4k to ${provider} shows and sends its own ratio controls`, async t => {
  const original = historicalJob({ parameters: { ...historicalJob().parameters, size_mode: 'auto4k', requested_aspect_ratio: '9:16' } });
  const harness = inputHarness(t, { command: { id: 51, job: original } }, {
    generationProviders: async () => [
      { provider: 'openai_compatible', display_name: 'Compatible', max_input_images: 4, can_generate: true },
      { provider, display_name: 'Other provider', max_input_images: 4, can_generate: true, default_image_model: 'other-image-model' },
    ],
  });
  await harness.flush();
  assert.ok(children(harness.tree).some(node => node.props?.['aria-label'] === '4K 自动比例'));
  harness.find('button', 'Original API').onClick(); await harness.flush();
  const other = children(harness.tree).find(node => node.type === 'button' && Array.isArray(node.props.children) && node.props.children[0] === 'Other provider');
  assert.ok(other); other.props.onClick(); await harness.flush();
  assert.equal(children(harness.tree).some(node => node.props?.['aria-label'] === '4K 自动比例'), false);
  assert.equal(children(harness.tree).some(node => node.props?.className === 'pg-note' && String(node.props.children).includes('请求 ')), false);
  harness.find('button', '9:16').onClick(); await harness.flush();
  harness.find('select', '宽高比').onChange({ target: { value: '3:4' } });
  if (provider === 'xai_grok_oauth') harness.find('select', 'Grok 分辨率').onChange({ target: { value: '2k' } });
  await harness.flush(); harness.find('button', '生成图片').onClick(); await harness.flush();
  assert.equal(harness.state.posts.length, 1);
  const payload = harness.state.posts[0];
  assert.equal(payload.provider, provider);
  assert.equal(payload.model, 'other-image-model');
  assert.equal(payload.parameters.requested_aspect_ratio, '3:4');
  assert.equal(payload.parameters.size, undefined);
  assert.equal(payload.parameters.size_mode, undefined);
  if (provider === 'xai_grok_oauth') assert.equal(payload.parameters.resolution, '2k');
});

const pickerSource = await readFile(new URL('../frontend/src/components/gallery/ReferencePicker.tsx', import.meta.url), 'utf8');
const pickerJs = ts.transpileModule(pickerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function pickerHarness(t, api) {
  const slots = [], effects = []; let cursor = 0, dirty = false, tree;
  const selected = []; let closed = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps, cleanup: undefined }; } },
  };
  const jsx = (type, props) => ({ type, props });
  const deps = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, '../../api/client': { api, mediaUrl: path => `/media/${path}` }, '../../hooks/useModalFocus': { useModalFocus: () => ({ containerRef: {}, handleModalKeyDown() {} }) } };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', pickerJs)(name => { assert.ok(name in deps, `unmocked picker dependency: ${name}`); return deps[name]; }, module, module.exports);
  const render = () => { dirty = false; cursor = 0; tree = module.exports.default({ onSelect: value => selected.push(value), onClose: () => closed++ }); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); };
  render(); t.after(() => slots.forEach(slot => slot?.cleanup?.()));
  const button = label => { const node = children(tree).find(node => node.type === 'button' && (node.props.children === label || children(node).some(child => child.type === 'span' && child.props.children === label))); assert.ok(node, `picker button ${label}`); return node.props; };
  return { flush, button, selected, get tree() { return tree; }, get closed() { return closed; } };
}

test('actual reference picker ignores out-of-order details and responses after tab switch or close', async t => {
  const first = deferred(), second = deferred(), switched = deferred(), closing = deferred(); let count = 0;
  const item = id => ({ id, title: id, images: [{ id: `${id}-image`, original_path: `originals/${id}.png`, role: 'reference_image' }] });
  const harness = pickerHarness(t, { items: async () => ({ items: [item('A'), item('B')], total: 2 }), generationJobs: async () => ({ jobs: [], total: 0 }), item: () => [first, second, switched, closing][count++].promise });
  await harness.flush(); harness.button('A').onClick(); harness.button('B').onClick();
  second.resolve(item('B')); await harness.flush(); first.resolve(item('A')); await harness.flush();
  assert.deepEqual(children(harness.tree).filter(node => node.type === 'img').map(node => node.props.alt), ['B']);
  harness.button('返回参考列表').onClick(); await harness.flush(); harness.button('A').onClick();
  harness.button('画廊').onClick(); await harness.flush(); switched.resolve(item('A')); await harness.flush();
  harness.button('Library').onClick(); await harness.flush();
  assert.equal(children(harness.tree).some(node => node.type === 'button' && node.props.children === '返回参考列表'), false);
  harness.button('A').onClick(); harness.button('关闭').onClick(); closing.reject(Error('late closed lookup')); await harness.flush();
  assert.equal(harness.closed, 1);
  assert.equal(children(harness.tree).some(node => node.props?.role === 'alert'), false);
  assert.equal(harness.selected.length, 0);
});

test('actual reference picker serializes repeated load-more clicks and appends one page', async t => {
  const page = deferred(), calls = [];
  const harness = pickerHarness(t, { items: async options => { calls.push(options); return options.offset ? page.promise : { items: [{ id: 'A', title: 'A' }], total: 2 }; }, generationJobs: async () => ({ jobs: [], total: 0 }) });
  await harness.flush(); const more = harness.button('加载更多参考（搜索已加载结果）').onClick; more(); more(); await harness.flush();
  assert.equal(calls.length, 2); assert.equal(calls[1].offset, 1);
  assert.equal(harness.button('加载更多参考（搜索已加载结果）').disabled, true);
  page.resolve({ items: [{ id: 'B', title: 'B' }], total: 2 }); await harness.flush();
  assert.equal(children(harness.tree).filter(node => node.type === 'span' && node.props.children === 'B').length, 1);
  assert.equal(children(harness.tree).some(node => node.type === 'button' && node.props.children === '加载更多参考（搜索已加载结果）'), false);
});
