import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
function evaluate(js, dependencies, clock = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', js)(name => {
    assert.ok(name in dependencies, `unmocked dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, clock);
  return module.exports;
}
const component = await compile('../frontend/src/components/gallery/DetailModal.tsx');
const recipe = evaluate(await compile('../frontend/src/utils/galleryRecipe.ts'), { './compatibleRecipe': {}, './compatibleProfiles': {}, './promptTemplateVariables': {} });
const inputUtils = evaluate(await compile('../frontend/src/utils/recipeInputs.ts'), {});
function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(descendants)];
}
function harness(t, job, overrides = {}) {
  const slots = [], effects = [], timers = [], events = { copies: [], reused: [], accepted: [], naming: [], writes: [], lists: 0, changed: 0 };
  let cursor = 0, dirty = false, tree;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } },
  };
  const jsx = (type, props) => ({ type, props });
  const api = {
    items: async () => { events.lists++; return { items: [{ id: 'existing', title: 'Existing reference' }], total: 1 }; },
    acceptGenerationJobAsNewItem: async (...args) => { events.writes.push(['new', ...args]); return { item: { id: 'new-reference' } }; },
    acceptGenerationJobIntoItem: async (...args) => { events.writes.push(['existing', ...args]); return { item: { id: 'existing' } }; },
    ...overrides.api,
  };
  const { default: DetailModal } = evaluate(component, {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../api/client': { api, mediaUrl: path => `/media/${path}` },
    '../../utils/galleryRecipe': recipe, '../../utils/recipeInputs': inputUtils,
    '../../utils/clipboard': { copyTextToClipboard: async text => { events.copies.push(text); return typeof overrides.copyResult === 'function' ? overrides.copyResult() : overrides.copyResult ?? true; } },
    '../../hooks/useModalFocus': { useModalFocus: () => ({ containerRef: {}, handleModalKeyDown() {} }) },
    '../GenerationResultSummary': { GenerationResultSummary: 'GenerationResultSummary' }, './DetailModal.css': {},
  }, { localStorage: overrides.storage ?? { getItem: () => null, setItem() {} }, setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout(id) { timers[id - 1] = undefined; } });
  function render() {
    cursor = 0; dirty = false;
    tree = DetailModal({ job, t: key => key, onClose() {}, onLightbox() {}, onChange: () => events.changed++, onAccepted: (id, autoTitle) => { events.accepted.push(id); events.naming.push(autoTitle); }, onReuse: (...args) => events.reused.push(args) });
    effects.splice(0).forEach(effect => effect());
  }
  async function flush() { for (let i = 0; i < 20; i++) { if (dirty) render(); await Promise.resolve(); } if (dirty) render(); }
  render();
  t.after(() => slots.forEach(slot => slot?.cleanup?.()));
  const find = (type, predicate = () => true) => descendants(tree).find(node => node.type === type && predicate(node.props))?.props;
  return { find, flush, events, timers, get tree() { return tree; } };
}
const prompt = '  原文\r\n\n保留空白\t ';
const job = {
  id: 'detail-original', status: 'succeeded', provider: 'openai_compatible', prompt_text: 'before', edited_prompt_text: prompt,
  model: 'image-model', created_at: '2026-01-01T10:00:00Z', result_path: 'generation-results/original.webp', result_width: 941, result_height: 1676,
  generation_group_size: 3,
  parameters: { size: '2160x3840', quality: 'max', compatible_profile_name: 'Selected provider', input_images: [{ id: 'ref', name: 'Source original', result_path: 'originals/reference.png' }] },
  metadata: { requested: { quality: 'high', moderation: 'low' }, decoded_image: { width: 941, height: 1676, format: 'webp' } },
};

test('detail copy preserves exact text and changes only local copy feedback with an original-file download', async t => {
  const h = harness(t, job);
  assert.equal(h.find('p', props => props.className === 'pg-full-prompt').children, prompt);
  assert.equal(h.find('a', props => props['aria-label'] === '下载原图').href, '/media/generation-results/original.webp');
  assert.equal(h.find('span', props => props.title === '实际文件尺寸').children, '941 × 1676');
  h.find('button', props => props['aria-label'] === '复制提示词').onClick(); await h.flush();
  assert.deepEqual(h.events.copies, [prompt]);
  assert.ok(h.find('button', props => props['aria-label'] === '已复制提示词'));
  assert.equal(h.find('p', props => props.role === 'alert'), undefined);
  h.find('button', props => props['aria-label'] === '已复制提示词').onClick(); await h.flush();
  assert.equal(h.timers[0], undefined);
  assert.equal(h.timers.length, 2);
  h.timers[1](); await h.flush();
  assert.ok(h.find('button', props => props['aria-label'] === '复制提示词'));
  assert.equal(h.find('GenerationResultSummary').job, job);
  assert.equal(h.find('img', props => props.alt === '原始参考 1').src, '/media/originals/reference.png');
  const config = h.find('dl', props => props.className === 'pg-detail-parameters');
  const rows = descendants({ props: config }).filter(node => node.type === 'div' && node.props.children?.[0]?.type === 'dt');
  assert.equal(rows.find(node => node.props.children[0].props.children === '请求质量').props.children[1].props.children, 'high');
});

test('detail copy failure clears previous success feedback', async t => {
  let copies = 0;
  const h = harness(t, job, { copyResult: () => ++copies === 1 });
  h.find('button', props => props['aria-label'] === '复制提示词').onClick(); await h.flush();
  h.find('button', props => props['aria-label'] === '已复制提示词').onClick(); await h.flush();
  assert.ok(h.find('button', props => props['aria-label'] === '复制提示词'));
  assert.ok(h.find('p', props => props.children === '无法复制，请选择原文复制'));
});

test('detail keeps unknown values unknown, reports copy failure and does not offer image actions for missing results', async t => {
  const h = harness(t, { ...job, status: 'failed', result_path: undefined, result_width: undefined, result_height: undefined, parameters: {}, metadata: {}, error: 'Provider error' }, { copyResult: false });
  assert.equal(h.find('a'), undefined);
  assert.equal(h.find('span', props => props.title === '实际文件尺寸'), undefined);
  assert.equal(h.find('button', props => props.children?.includes?.('继续编辑')).disabled, true);
  assert.ok(h.find('p', props => props.children === 'Provider error'));
  assert.ok(h.find('p', props => typeof props.children === 'string' && props.children.includes('不会自动重试')));
  h.find('button', props => props['aria-label'] === '复制提示词').onClick(); await h.flush();
  assert.ok(h.find('p', props => props.children === '无法复制，请选择原文复制'));
  assert.equal(h.find('button', props => props['aria-label'] === '已复制提示词'), undefined);
});

for (const existing of [false, true]) test(`detail saves ${existing ? 'into an existing reference' : 'a new reference with optional title left blank'} through existing endpoints`, async t => {
  const h = harness(t, job);
  h.find('button', props => props.children === '保存到 Library').onClick(); await h.flush();
  if (existing) { h.find('button', props => props.children === '添加到已有条目…').onClick(); await h.flush(); h.find('select').onChange({ target: { value: 'existing' } }); await h.flush(); }
  h.find('button', props => props.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, existing ? [['existing', job.id, 'existing']] : [['new', job.id, { auto_title: false }]]);
  assert.equal(h.events.changed, 1);
  assert.deepEqual(h.events.accepted, [existing ? 'existing' : 'new-reference']);
  h.find('button', props => props.children?.includes?.('恢复配方')).onClick();
  h.find('button', props => props.children?.includes?.('继续编辑')).onClick();
  assert.deepEqual(h.events.reused, [[job], [job, true]]);
});

test('gallery naming is opt in and does not resend or change the original prompt or image', async t => {
  const snapshot = structuredClone(job);
  const h = harness(t, job);
  h.find('button', props => props.children === '保存到 Library').onClick(); await h.flush();
  assert.equal(h.find('input', props => props.type === 'checkbox').checked, false);
  h.find('input', props => props.type === 'checkbox').onChange({ target: { checked: true } }); await h.flush();
  h.find('button', props => props.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, [['new', job.id, { auto_title: true }]]);
  assert.deepEqual(h.events.naming, [true]);
  assert.deepEqual(job, snapshot);
  assert.equal(h.find('p', props => props.className === 'pg-full-prompt').children, prompt);
  assert.equal(h.find('a', props => props['aria-label'] === '下载原图').href, '/media/generation-results/original.webp');
});

test('a manual title disables previously selected naming and remains the only title sent', async t => {
  const h = harness(t, job);
  h.find('button', props => props.children === '保存到 Library').onClick(); await h.flush();
  h.find('input', props => props.type === 'checkbox').onChange({ target: { checked: true } }); await h.flush();
  h.find('input', props => props.placeholder === '留空使用默认名称').onChange({ target: { value: '手动名称' } }); await h.flush();
  assert.equal(h.find('input', props => props.type === 'checkbox').disabled, true);
  assert.equal(h.find('input', props => props.type === 'checkbox').checked, false);
  h.find('button', props => props.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, [['new', job.id, { title: '手动名称', auto_title: false }]]);
  assert.deepEqual(h.events.naming, [false]);
});

test('attaching to an existing reference cannot rename it even after selecting automatic naming', async t => {
  const h = harness(t, job);
  h.find('button', props => props.children === '保存到 Library').onClick(); await h.flush();
  h.find('input', props => props.type === 'checkbox').onChange({ target: { checked: true } }); await h.flush();
  h.find('button', props => props.children === '添加到已有条目…').onClick(); await h.flush();
  h.find('select').onChange({ target: { value: 'existing' } }); await h.flush();
  assert.equal(h.find('input', props => props.type === 'checkbox'), undefined);
  h.find('button', props => props.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, [['existing', job.id, 'existing']]);
  assert.deepEqual(h.events.naming, [false]);
});

test('a result whose Library asset was removed offers collection again without generation', async t => {
  const h = harness(t, { ...job, accepted_image_id: null });
  h.find('button', props => props.children === '保存到 Library').onClick(); await h.flush();
  h.find('button', props => props.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, [['new', job.id, { auto_title: false }]]);
});

test('naming preference survives remounts and opt-out; a manual title does not erase the preference', async t => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const open = async () => { const h = harness(t, job, { storage }); h.find('button', p => p.children === '保存到 Library').onClick(); await h.flush(); return h; };
  const first = await open();
  assert.equal(first.find('input', p => p.type === 'checkbox').checked, false);
  first.find('input', p => p.type === 'checkbox').onChange({ target: { checked: true } }); await first.flush();
  const second = await open();
  assert.equal(second.find('input', p => p.type === 'checkbox').checked, true);
  second.find('input', p => p.placeholder === '留空使用默认名称').onChange({ target: { value: 'Manual' } }); await second.flush();
  second.find('button', p => p.children === '确认保存').onClick(); await second.flush();
  assert.deepEqual(second.events.writes, [['new', job.id, { title: 'Manual', auto_title: false }]]);
  const third = await open();
  assert.equal(third.find('input', p => p.type === 'checkbox').checked, true);
  third.find('button', p => p.children === '确认保存').onClick(); await third.flush();
  assert.deepEqual(third.events.writes, [['new', job.id, { auto_title: true }]]);
  third.find('input', p => p.type === 'checkbox').onChange({ target: { checked: false } }); await third.flush();
  const fourth = await open();
  assert.equal(fourth.find('input', p => p.type === 'checkbox').checked, false);
});

test('default collection avoids loading destinations; optional attachment requires a target and can be cancelled', async t => {
  const h = harness(t, job);
  h.find('button', p => p.children === '保存到 Library').onClick(); await h.flush();
  assert.equal(h.events.lists, 0);
  assert.equal(h.find('select'), undefined);
  h.find('button', p => p.children === '添加到已有条目…').onClick(); await h.flush();
  assert.equal(h.events.lists, 1);
  assert.equal(h.find('button', p => p.children === '确认保存').disabled, true);
  await h.find('button', p => p.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, []);
  h.find('select').onChange({ target: { value: 'existing' } }); await h.flush();
  h.find('button', p => p.children === '改为单独收录').onClick(); await h.flush();
  h.find('button', p => p.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, [['new', job.id, { auto_title: false }]]);
});

test('unavailable browser storage does not prevent collection or an explicit naming choice', async t => {
  const h = harness(t, job, { storage: { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } } });
  h.find('button', p => p.children === '保存到 Library').onClick(); await h.flush();
  assert.equal(h.find('input', p => p.type === 'checkbox').checked, false);
  h.find('input', p => p.type === 'checkbox').onChange({ target: { checked: true } }); await h.flush();
  h.find('button', p => p.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, [['new', job.id, { auto_title: true }]]);
});

const titleUpdates = await compile('../frontend/src/hooks/useGalleryTitleUpdates.ts');
function titleUpdateHarness(t, getStatus) {
  const callbacks = [], timers = new Map(); let sequence = 0, cleanup;
  const { useGalleryTitleUpdates } = evaluate(titleUpdates, {
    react: { useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: fn => { cleanup = fn(); } },
    '../api/client': { api: { galleryTitleStatus: getStatus } },
  }, { setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); } });
  const track = useGalleryTitleUpdates(id => callbacks.push(id));
  t.after(() => cleanup());
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { track, callbacks, timers, flush, unmount: () => cleanup(), async tick() { const next = timers.entries().next().value; assert.ok(next); timers.delete(next[0]); next[1](); await flush(); } };
}

test('background naming status polling is read only, deduplicated and reports completion for each saved item', async t => {
  const calls = [], states = new Map([['a', ['pending', 'running', 'succeeded']], ['b', ['skipped']]]);
  const h = titleUpdateHarness(t, async id => { calls.push(id); return { status: states.get(id).shift() }; });
  h.track('a'); h.track('a'); h.track('b'); await h.flush();
  assert.deepEqual(calls, ['a', 'b']); assert.deepEqual(h.callbacks, ['b']);
  await h.tick(); assert.deepEqual(h.callbacks, ['b']);
  await h.tick(); assert.deepEqual(h.callbacks, ['b', 'a']);
  assert.equal(h.timers.size, 0);
});

test('closing the app cancels late naming updates and scheduled polling', async t => {
  let resolve;
  const h = titleUpdateHarness(t, () => new Promise(done => { resolve = done; }));
  h.track('a'); h.unmount(); resolve({ status: 'succeeded' }); await h.flush();
  assert.deepEqual(h.callbacks, []); assert.equal(h.timers.size, 0);
});

for (const failing of [false, true]) test(`naming polling has a bound for ${failing ? 'failed status reads' : 'a task that never finishes'}`, async t => {
  let calls = 0;
  const h = titleUpdateHarness(t, async () => { calls++; if (failing) throw Error('offline'); return { status: 'running' }; });
  h.track('a'); await h.flush();
  while (h.timers.size) await h.tick();
  assert.equal(calls, failing ? 3 : 120); assert.deepEqual(h.callbacks, []);
});

// Invoke the production effect callback so title refreshes cannot replace an open form.
const itemDetailSource = await readFile(new URL('../frontend/src/components/ItemDetailModal.tsx', import.meta.url), 'utf8');
const itemDetailAst = ts.createSourceFile('ItemDetailModal.tsx', itemDetailSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let titleEffect;
function locateTitleEffect(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect'
      && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])
      && node.arguments[1].elements.some(part => ts.isIdentifier(part) && part.text === 'titleRefreshKey')) titleEffect = node.arguments[0].getText(itemDetailAst);
  ts.forEachChild(node, locateTitleEffect);
}
locateTitleEffect(itemDetailAst);
assert.ok(titleEffect);
const titleEffectJs = ts.transpileModule(`module.exports = ${titleEffect};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function runTitleEffect(item, getItem, apply) {
  const module = { exports: {} };
  new Function('module', 'api', 'id', 'item', 'titleRefreshKey', 'setItem', titleEffectJs)(module, { item: getItem }, item.id, item, 1, apply);
  return module.exports();
}
for (const manual of [false, true]) test(`completed naming ${manual ? 'preserves a newer manual title' : 'patches only the title, preserving open detail state'}`, async () => {
  let complete;
  const original = { id: 'a', title: 'Generated image', prompts: [{ text: prompt }], images: [{ id: 'original' }] };
  let current = original;
  const cleanup = runTitleEffect(original, () => new Promise(resolve => { complete = resolve; }), update => { current = update(current); });
  if (manual) current = { ...current, title: 'My own title' };
  complete({ ...original, title: 'Named by model', prompts: [], images: [] });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(current.title, manual ? 'My own title' : 'Named by model');
  assert.equal(current.prompts, original.prompts); assert.equal(current.images, original.images);
  cleanup();
});

test('closing a Library detail ignores its delayed title refresh', async () => {
  let complete, updates = 0;
  const cleanup = runTitleEffect({ id: 'a', title: 'Original' }, () => new Promise(resolve => { complete = resolve; }), () => updates++);
  cleanup(); complete({ id: 'a', title: 'Late' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(updates, 0);
});

test('completion of item B does not cancel item A pending title refresh', async () => {
  const source = await readFile(new URL('../frontend/src/App.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback, stateDeclaration, refreshExpression;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useGalleryTitleUpdates') callback = node.arguments[0];
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
        && node.name.elements[0]?.name?.getText(ast).startsWith('titleUpdate')) stateDeclaration = node;
    if (ts.isJsxAttribute(node) && node.name.text === 'titleRefreshKey') refreshExpression = node.initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback && stateDeclaration && refreshExpression);
  const [stateName, setterName] = stateDeclaration.name.elements.map(part => part.name.getText(ast));
  let state = new Function(`return (${stateDeclaration.initializer.arguments[0]?.getText(ast) || 'undefined'});`)();
  const callbackJs = ts.transpileModule(`module.exports = ${callback.getText(ast)};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', setterName, 'setItemsReloadKey', callbackJs)(module, update => { state = update(state); }, () => {});
  const keyFor = new Function(stateName, 'detailId', `return (${refreshExpression.getText(ast)});`);
  module.exports('a');
  const original = { id: 'a', title: 'Generated image', prompts: [{ text: prompt }], images: [{ id: 'original' }] };
  let current = original, complete;
  const previousKey = keyFor(state, 'a');
  const cleanup = runTitleEffect(original, () => new Promise(resolve => { complete = resolve; }), update => { current = update(current); });
  module.exports('b');
  // React cleans up an effect whenever its dependency key changes.
  if (keyFor(state, 'a') !== previousKey) cleanup();
  complete({ ...original, title: 'Named A' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(current.title, 'Named A');
  assert.equal(keyFor(state, 'a'), previousKey);
  assert.equal(current.prompts, original.prompts); assert.equal(current.images, original.images);
  cleanup();
});
