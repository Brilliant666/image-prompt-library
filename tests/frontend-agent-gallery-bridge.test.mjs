import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
function evaluate(js, dependencies, globals = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(name => {
    assert.ok(name in dependencies, `unmocked dependency: ${name}`); return dependencies[name];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
const utilityCache = new Map();
async function utility(path) {
  const url = new URL(path, import.meta.url), key = url.href;
  if (utilityCache.has(key)) return utilityCache.get(key);
  const js = await compile(key), dependencies = {};
  for (const [, name] of js.matchAll(/require\("([^"]+)"\)/g)) dependencies[name] = await utility(new URL(`${name}.ts`, url).href);
  const result = evaluate(js, dependencies); utilityCache.set(key, result); return result;
}
const bridge = await utility('../frontend/src/utils/agentGalleryBridge.ts');
const recipe = await utility('../frontend/src/utils/galleryRecipe.ts');
const compatible = await utility('../frontend/src/utils/compatibleRecipe.ts');
const references = await utility('../frontend/src/utils/recipeInputs.ts');
const preferences = await utility('../frontend/src/utils/generationPreferences.ts');
const profileSettings = await utility('../frontend/src/utils/profileSettings.ts');
const templates = await utility('../frontend/src/utils/promptTemplateVariables.ts');
const components = Object.fromEntries(await Promise.all(['InputBar', 'GalleryWorkspace', 'TaskGrid', 'DetailModal'].map(async name => [name, await compile(`../frontend/src/components/gallery/${name}.tsx`)])));
const descendants = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : '';
const job = extra => ({ id: 'result-1', provider: 'openai_compatible', status: 'succeeded', model: 'image-model', prompt_text: 'original prompt', result_path: 'generation-results/result-1/image.png', created_at: '2026-01-01T00:00:00Z', parameters: { compatible_profile_id: 'images', size: '1536x1024', quality: 'high', background: 'auto', output_format: 'png' }, ...extra });

function harness(t, name, props = {}, options = {}) {
  const slots = [], effects = [], reports = [], calls = [], timers = new Map(), storage = new Map();
  let cursor = 0, dirty = false, tree, timer = 0;
  const memo = (fn, deps) => { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { deps, value: fn() }; return slots[i].value; };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } },
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
  };
  const jsx = (type, props) => ({ type, props });
  const globals = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: new EventTarget(), document: { visibilityState: 'visible' },
    setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    Image: class { naturalWidth = 1200; naturalHeight = 800; async decode() { await options.decode?.(); } },
  };
  globals.window.localStorage = globals.localStorage;
  globals.window.setTimeout = globals.setTimeout; globals.window.clearTimeout = globals.clearTimeout;
  const api = {
    generationProviders: async () => [{ provider: 'openai_compatible', can_generate: true, max_input_images: 4 }],
    openAICompatibleProfiles: async () => ({ profiles: [{ id: 'images', model: 'image-model', configured: true, display_name: 'Images' }], default_profile_id: 'images' }),
    generationJobs: async () => ({ jobs: options.jobs || [], total: options.jobs?.length || 0 }),
    generationJob: async id => { calls.push(['read', id]); return options.jobs?.find(row => row.id === id) || job({ id }); },
    ...options.api,
  };
  const dependencies = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../api/client': { api, mediaUrl: path => `/media/${path}` }, '../../utils/agentGalleryBridge': bridge,
    '../../utils/galleryRecipe': recipe, '../../utils/compatibleRecipe': compatible,
    '../../utils/recipeInputs': references, '../../utils/generationPreferences': preferences,
    '../../utils/profileSettings': profileSettings, '../../utils/promptTemplateVariables': templates,
    '../../utils/galleryDraft': { readGalleryDraft: async () => options.draft, saveGalleryDraft: async () => {} },
    '../../utils/clipboard': { copyTextToClipboard: async () => true },
    '../../utils/galleryCardMeta': { galleryImageDimensions: () => undefined, galleryTaskElapsed: () => undefined },
    '../../utils/playground/virtualGrid': { getIndexesInRect: () => [] },
    '../../utils/playground/useVirtualGrid': { useVirtualGrid: (_, count) => ({ startIndex: 0, endIndex: count, paddingTop: 0, paddingBottom: 0, metricsRef: {} }) },
    '../../hooks/useModalFocus': { useModalFocus: () => ({ containerRef: {}, handleModalKeyDown() {} }) },
    '../../utils/galleryHistory': { readGalleryFilter: () => '', saveGalleryFilter() {}, galleryFilterStatuses: () => '', readGalleryHistory: () => undefined, saveGalleryHistory() {}, clearGalleryHistory() {} },
    '../../utils/generationQueueHistory': { clearGenerationQueueHistory() {} }, '../../utils/generationSiblings': { mapGenerationRetryJob: value => value },
    fflate: {}, '../GenerationResultSummary': { GenerationResultSummary: 'GenerationResultSummary' },
    '../GenerationQueueDrawer': { __esModule: true, default: 'GenerationQueueDrawer', groupGenerationQueueJobs: () => [] },
    '../ToolbarSelect': { __esModule: true, default: 'ToolbarSelect' },
  };
  for (const child of ['InputBar', 'TaskGrid', 'DetailModal', 'Lightbox', 'ReferencePicker', 'SizeDialog']) dependencies[`./${child}`] = { __esModule: true, default: child };
  for (const child of ['InputBar', 'GalleryWorkspace', 'DetailModal']) dependencies[`./${child}.css`] = {};
  // Shared utility functions read storage on the calling global scope.
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: globals.localStorage });
  const Component = evaluate(components[name], dependencies, globals).default;
  let currentProps = { active: true, t: key => key, preferences: {}, configurationRevision: 0, refreshKey: 0, onOpenSettings() {}, onCreated() {}, onQueueChanged() {}, onAccepted() {}, onClose() {}, onChange() {}, onLightbox() {}, onReuse() {}, onOpen() {}, onMessage() {}, onSelection() {}, selected: new Set(), onImageSettingsChange: value => reports.push(value), ...props };
  const render = () => { dirty = false; cursor = 0; tree = Component(currentProps); effects.splice(0).forEach(fn => fn()); };
  const flush = async () => { for (let i = 0; i < 30; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); };
  render();
  t.after(() => { slots.forEach(slot => slot?.cleanup?.()); if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage; });
  return { reports, calls, flush, update(value) { currentProps = { ...currentProps, ...value }; render(); }, nodes: () => descendants(tree), node: (type, predicate = () => true) => descendants(tree).find(value => value.type === type && predicate(value.props))?.props };
}

test('actual gallery cards use Agent metadata for source and only completed images can become references', async t => {
  const sent = [], rows = [job({ id: 'ordinary' }), job({ id: 'hybrid', metadata: { agent: { conversationId: 'chat', roundId: 'round' } } }), job({ id: 'failed', status: 'failed', result_path: null, metadata: { agent: { conversationId: 'chat' } } }), job({ id: 'cleaned', status: 'discarded', result_path: null, metadata: { agent: { conversationId: 'chat' } } })];
  const h = harness(t, 'TaskGrid', { jobs: rows, onSendToAgent: (...values) => sent.push(values) }); await h.flush();
  const references = h.nodes().filter(node => node.type === 'button' && node.props['aria-label'] === '带到 Agent 继续');
  assert.equal(references.length, 2);
  references.forEach(node => node.props.onClick());
  const sources = h.nodes().filter(node => node.type === 'button' && node.props['aria-label'] === '返回 Agent 会话');
  assert.equal(sources.length, 3); sources.forEach(node => node.props.onClick());
  assert.deepEqual(sent.map(([row, intent]) => [row.id, intent]), [['ordinary', 'reference'], ['hybrid', 'reference'], ['hybrid', 'conversation'], ['failed', 'conversation'], ['cleaned', 'conversation']]);
});

test('actual detail exposes a source return after cleanup while ordinary successful results can enter Agent', async t => {
  const sent = [], h = harness(t, 'DetailModal', { job: job({ status: 'discarded', result_path: null, metadata: { agent: { conversationId: 'chat' } } }), onSendToAgent: (...values) => sent.push(values) });
  await h.flush(); h.node('button', props => props['aria-label'] === '返回 Agent 会话').onClick();
  assert.equal(h.node('button', props => text(props.children).includes('带到 Agent 继续')), undefined);
  h.update({ job: job() }); await h.flush();
  h.node('button', props => text(props.children).includes('带到 Agent 继续')).onClick();
  assert.deepEqual(sent.map(([, intent]) => intent), ['conversation', 'reference']);
});

test('actual workspace native reuse keeps its transport and intent; ordinary reuse retains the gallery recipe', async t => {
  const events = [], native = job({ id: 'native', provider: 'agent_native_batch', metadata: { agent: { conversationId: 'chat', roundId: 'round' } } }), ordinary = job({ id: 'ordinary' });
  const report = () => {};
  const h = harness(t, 'GalleryWorkspace', { onCloseDetail: () => events.push('closed'), onSendToAgent: (row, intent) => events.push([row, intent]), onImageSettingsChange: report }, { jobs: [native, ordinary] }); await h.flush();
  assert.equal(h.node('InputBar').onImageSettingsChange, report);
  await h.node('TaskGrid').onReuse(native, true); await h.flush();
  assert.deepEqual(events, ['closed', [native, 'reference']]); assert.equal(h.node('InputBar').command, undefined);
  events.length = 0; await h.node('TaskGrid').onReuse(native); await h.flush();
  assert.deepEqual(events, ['closed', [native, 'conversation']]);
  events.length = 0; await h.node('TaskGrid').onReuse(ordinary); await h.flush();
  assert.equal(h.node('InputBar').command.job, ordinary); assert.deepEqual(events, ['closed']);
  h.node('TaskGrid').onSendToAgent(ordinary, 'reference'); await h.flush();
  assert.deepEqual(events.slice(-2), ['closed', [ordinary, 'reference']]);
});

test('actual InputBar reports only image settings and resolves the current template for auto4k', async t => {
  const historical = job({ parameters: { compatible_profile_id: 'images', quality: 'high', size: 'auto', size_mode: 'auto4k', background: 'opaque', output_format: 'webp', output_compression: 82, moderation: 'low', base_url_mode: 'custom', stream: true, partial_images: 3, response_format: 'b64_json', prompt_template: '海报 {{ratio}}', prompt_template_values: { ratio: '16:9' } } });
  const h = harness(t, 'InputBar', { promptVariablesEnabled: true, command: { id: 1, job: historical } }); await h.flush();
  const settings = h.reports.at(-1);
  assert.equal(settings.unavailable, undefined); assert.equal(settings.params.size, '3840x2160');
  assert.deepEqual(settings.params, { size: '3840x2160', quality: 'high', background: 'opaque', output_format: 'webp', output_compression: 82, moderation: 'low' });
  assert.equal(settings.model, 'image-model'); assert.equal(settings.profileId, 'images');
  assert.equal(h.node('textarea', props => props['aria-label'] === '画廊提示词').value, '海报 {{ratio}}');
  h.node('textarea', props => props['aria-label'] === '画廊提示词').onChange({ target: { value: '海报 1:1 和 16:9' } }); await h.flush();
  assert.match(h.reports.at(-1).unavailable, /冲突比例/);
});

test('actual InputBar marks incompatible providers and incomplete configuration unavailable', async t => {
  const h = harness(t, 'InputBar', { command: { id: 1, job: job({ provider: 'xai_grok_oauth' }) } }); await h.flush();
  assert.match(h.reports.at(-1).unavailable, /供应商不能直接用于 Agent/);
  h.update({ command: { id: 2, job: job({ parameters: { compatible_profile_id: 'missing', size: 'auto', quality: 'auto', background: 'auto', output_format: 'png' } }) } }); await h.flush();
  assert.match(h.reports.at(-1).unavailable, /完成画廊图片 API 配置/);
});

test('actual InputBar reports a cleared model as unavailable instead of copying the profile default', async t => {
  const h = harness(t, 'InputBar'); await h.flush();
  assert.equal(h.reports.at(-1).model, 'image-model');
  assert.equal(h.reports.at(-1).unavailable, undefined);
  h.node('button', props => props['aria-label'] === '请求模型 image-model').onClick(); await h.flush();
  h.node('input', props => props['aria-label'] === '请求模型完整 ID').onChange({ target: { value: '   ' } }); await h.flush();
  assert.equal(h.reports.at(-1).model, '');
  assert.match(h.reports.at(-1).unavailable, /选择生图模型/);
  assert.equal(h.node('input', props => props['aria-label'] === '请求模型完整 ID').value, '   ', 'reporting settings must preserve the user edit');
  h.node('input', props => props['aria-label'] === '请求模型完整 ID').onChange({ target: { value: 'manual-image-model' } }); await h.flush();
  assert.equal(h.reports.at(-1).model, 'manual-image-model');
  assert.equal(h.reports.at(-1).unavailable, undefined);
});

test('actual InputBar waits for measured reference dimensions instead of exporting a square auto4k guess', async t => {
  const decodes = [];
  const draft = { ...recipe.emptyGalleryDraft(), profileId: 'images', prompt: '沿用参考图比例', recipe: { model: 'image-model', size: 'auto', size_mode: 'auto4k', quality: 'auto', background: 'auto', output_format: 'png' }, inputs: [{ id: 'reference', name: 'reference', source: 'uploaded', dataUrl: 'data:image/png;base64,REF', previewUrl: 'data:image/png;base64,REF' }] };
  const h = harness(t, 'InputBar', { preferences: { persistInputOnRestart: true } }, { draft, decode: () => new Promise(resolve => decodes.push(resolve)) });
  await h.flush(); assert.match(h.reports.at(-1).unavailable, /正在读取/);
  decodes.shift()(); await h.flush();
  assert.match(h.reports.at(-1).unavailable, /首张参考图比例/);
  decodes.shift()(); await h.flush();
  assert.ok(h.reports.at(-1).unavailable, 'the second measurement is not complete yet');
  decodes.shift()(); await h.flush();
  assert.equal(h.reports.at(-1).unavailable, undefined);
  assert.equal(h.reports.at(-1).params.size, compatible.resolveAuto4k(draft.prompt, { width: 1200, height: 800 }).size);
  assert.equal(h.node('textarea', props => props['aria-label'] === '画廊提示词').value, draft.prompt);
});

test('actual InputBar native commands call the Agent bridge instead of restoring an Images recipe', async t => {
  const sent = [], native = job({ provider: 'agent_native', metadata: { agent: { conversationId: 'chat' } } });
  const h = harness(t, 'InputBar', { onSendToAgent: (...values) => sent.push(values), command: { id: 1, job: native, editResult: true } }); await h.flush();
  assert.deepEqual(sent, [[native, 'reference']]);
  h.update({ command: { id: 2, job: native } }); await h.flush();
  assert.deepEqual(sent[1], [native, 'conversation']);
  assert.equal(h.node('textarea', props => props['aria-label'] === '画廊提示词').value, '');
});
