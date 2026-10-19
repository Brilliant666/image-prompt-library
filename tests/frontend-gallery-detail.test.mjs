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
  const slots = [], effects = [], timers = [], events = { copies: [], reused: [], accepted: [], writes: [], changed: 0 };
  let cursor = 0, dirty = false, tree;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } },
  };
  const jsx = (type, props) => ({ type, props });
  const api = {
    items: async () => ({ items: [{ id: 'existing', title: 'Existing reference' }], total: 1 }),
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
  }, { setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout(id) { timers[id - 1] = undefined; } });
  function render() {
    cursor = 0; dirty = false;
    tree = DetailModal({ job, t: key => key, onClose() {}, onLightbox() {}, onChange: () => events.changed++, onAccepted: id => events.accepted.push(id), onReuse: (...args) => events.reused.push(args) });
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
  if (existing) { h.find('select').onChange({ target: { value: 'existing' } }); await h.flush(); }
  h.find('button', props => props.children === '确认保存').onClick(); await h.flush();
  assert.deepEqual(h.events.writes, existing ? [['existing', job.id, 'existing']] : [['new', job.id, {}]]);
  assert.equal(h.events.changed, 1);
  assert.deepEqual(h.events.accepted, [existing ? 'existing' : 'new-reference']);
  h.find('button', props => props.children?.includes?.('恢复配方')).onClick();
  h.find('button', props => props.children?.includes?.('继续编辑')).onClick();
  assert.deepEqual(h.events.reused, [[job], [job, true]]);
});
