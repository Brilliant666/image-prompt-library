import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { localRecoveryDependencies } from './helpers/local-result-recovery.mjs';

async function compile(relative) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
function evaluate(js, dependencies, timers = globalThis) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', js)(name => {
    if (name in localRecoveryDependencies) return localRecoveryDependencies[name]; assert.ok(name in dependencies, `unmocked dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, timers.setTimeout, timers.clearTimeout);
  return module.exports;
}
const component = await compile('../frontend/src/components/gallery/TaskGrid.tsx');
const agentGalleryBridge = evaluate(await compile('../frontend/src/utils/agentGalleryBridge.ts'), {});
const recipe = evaluate(await compile('../frontend/src/utils/galleryRecipe.ts'), {
  './compatibleRecipe': {}, './compatibleProfiles': {}, './promptTemplateVariables': {},
});
const gridMath = evaluate(await compile('../frontend/src/utils/playground/virtualGrid.ts'), {});
const cardMeta = evaluate(await compile('../frontend/src/utils/galleryCardMeta.ts'), {});
function descendants(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).flatMap(descendants)];
}
function render(t, job, selected = new Set(), copy = async () => true) {
  const events = { opened: [], reused: [], selected: [], copied: [], messages: [] };
  const slots = [], effects = [], timers = new Map();
  let cursor = 0, dirty = false, tree, now = 0, timerId = 0;
  const clock = {
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps, cleanup: undefined }; } },
  };
  const jsx = (type, props) => ({ type, props });
  const scrollRef = { current: { clientHeight: 500 } };
  const { default: TaskGrid } = evaluate(component, {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../api/client': { mediaUrl: path => `/media/${path}` },
    '../../utils/galleryRecipe': recipe,
    '../../utils/agentGalleryBridge': agentGalleryBridge,
    '../../utils/galleryCardMeta': cardMeta,
    '../../utils/playground/virtualGrid': gridMath,
    '../../utils/playground/useVirtualGrid': { useVirtualGrid: (_grid, count, scroll) => {
      assert.equal(scroll, scrollRef);
      return { startIndex: 0, endIndex: count, paddingTop: 0, paddingBottom: 0, metricsRef: { current: { columns: 3, rowHeight: 162, rowGap: 16, columnGap: 16, width: 1250 } } };
    } },
    '../../utils/clipboard': { copyTextToClipboard: async text => { events.copied.push(text); return copy(text); } },
  }, clock);
  const update = () => {
    dirty = false; cursor = 0;
    tree = TaskGrid({ jobs: [job], selected, scrollRef, onOpen: value => events.opened.push(value), onReuse: (...values) => events.reused.push(values), onSelection: value => events.selected.push(value), onMessage: value => events.messages.push(value) });
    effects.splice(0).forEach(effect => effect());
  };
  const flush = async () => { for (let i = 0; i < 10; i++) { if (dirty) update(); await Promise.resolve(); } if (dirty) update(); };
  const advance = async milliseconds => { now += milliseconds; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); } await flush(); };
  update();
  const unmount = () => slots.forEach(slot => slot?.cleanup?.());
  t.after(unmount);
  return { get tree() { return tree; }, events, flush, advance, unmount, find: (type, predicate) => descendants(tree).find(node => node.type === type && predicate(node.props))?.props };
}
const prompt = '  完整提示词\r\n\n原样保留\t ';
const job = {
  id: 'compact-result', status: 'succeeded', prompt_text: 'older prompt', edited_prompt_text: prompt,
  model: 'gpt-image-2.5-sunburst-enterprise', created_at: '2026-01-01T10:00:00Z',
  result_path: 'generation-results/original.webp', result_width: 941, result_height: 1676,
  parameters: { size: '2160x3840', quality: 'max' },
};

test('compact card retains actual dimensions, full model, exact prompt and original image link', t => {
  const h = render(t, job);
  assert.equal(h.find('img', () => true).src, '/media/generation-results/original.webp');
  assert.equal(h.find('p', () => true).children, prompt);
  assert.equal(h.find('p', () => true).title, prompt);
  assert.equal(h.find('span', props => props.title === '实际文件尺寸').children, '941 × 1676');
  assert.equal(h.find('span', props => props.className === 'pg-image-ratio').children, '≈9:16');
  assert.equal(h.find('span', props => props.title === '请求质量').children, 'max');
  assert.equal(h.find('small', props => props.className === 'pg-card-model').children, job.model);
  assert.equal(h.find('small', props => props.className === 'pg-card-model').title, job.model);
  assert.equal(h.find('a', props => props['aria-label'] === '下载原图').href, '/media/generation-results/original.webp');
  assert.equal(h.find('time', () => true).dateTime, job.created_at);
});

test('running stream preview is labelled provisional and cannot be downloaded or reused as a result', t => {
  const version = 'a'.repeat(64);
  const pending = { ...job, status: 'running', result_path: null, result_width: null, result_height: null,
    metadata: { stream_preview: { path: `generation-results/${job.id}/stream-preview/image.png`, version, width: 320, height: 200, index: 0 } } };
  const h = render(t, pending);
  assert.equal(h.find('img', () => true).src, `/media/generation-results/${job.id}/stream-preview/image.png?preview=${version}`);
  assert.equal(h.find('img', () => true).alt, '生成中预览，非最终结果');
  assert.equal(h.find('span', props => props.className === 'pg-stream-preview-label').children, '生成中 · 预览');
  assert.equal(h.find('span', props => props.className === 'pg-image-ratio'), undefined);
  assert.equal(h.find('span', props => props.className === 'pg-image-dimensions'), undefined);
  assert.equal(h.find('a', props => props['aria-label'] === '下载原图'), undefined);
  assert.equal(h.find('button', props => props['aria-label'] === '使用结果继续编辑').disabled, true);
});

test('terminal jobs and foreign preview paths never render transient image metadata', t => {
  const preview = { path: `generation-results/${job.id}/stream-preview/image.png`, version: 'a'.repeat(64) };
  for (const candidate of [
    { ...job, status: 'failed', result_path: null, metadata: { stream_preview: preview } },
    { ...job, status: 'running', result_path: null, metadata: { stream_preview: { ...preview, path: 'https://outside.invalid/image.png' } } },
    { ...job, status: 'running', result_path: null, metadata: { stream_preview: { ...preview, path: 'generation-results/another-job/stream-preview/image.png' } } },
  ]) {
    const h = render(t, candidate);
    assert.equal(h.find('img', () => true), undefined);
    assert.equal(h.find('a', props => props['aria-label'] === '下载原图'), undefined);
  }
});

test('compact card callbacks preserve inspect, full-recipe reuse, edit, exact copy and independent selection', async t => {
  const selected = new Set(['previous']);
  const h = render(t, job, selected);
  h.find('button', props => props['aria-label'] === `查看任务 ${job.id}`).onClick();
  h.find('button', props => props['aria-label'] === '恢复完整配方').onClick();
  h.find('button', props => props['aria-label'] === '使用结果继续编辑').onClick();
  h.find('button', props => props['aria-label'] === '复制提示词').onClick();
  h.find('button', props => props['aria-label'] === `选择任务 ${job.id}`).onClick();
  await h.flush();
  assert.deepEqual(h.events.opened, [job]);
  assert.deepEqual(h.events.reused, [[job], [job, true]]);
  assert.deepEqual(h.events.copied, [prompt]);
  assert.deepEqual(h.events.messages, [], 'successful copy must not create a workspace notification');
  const feedback = h.find('button', props => props['aria-label'] === '已复制提示词');
  assert.ok(feedback);
  assert.equal(feedback.children[0].type, 'Check');
  assert.equal(h.find('span', props => props.role === 'status').children, '已复制');
  assert.deepEqual([...h.events.selected[0]], ['previous', job.id]);
  assert.deepEqual([...selected], ['previous']);
});

test('failed compact card does not infer actual size from request and cannot edit a missing result', t => {
  const h = render(t, { ...job, status: 'failed', result_path: undefined, result_width: undefined, result_height: undefined, model: undefined, started_at: '2026-01-01T10:01:00Z', completed_at: '2026-01-01T10:01:25Z', updated_at: '2026-02-01T12:00:00Z' });
  assert.equal(h.find('img', () => true), undefined);
  assert.equal(h.find('span', props => props.className === 'pg-status-tag failed').children, recipe.galleryStatus.failed);
  assert.equal(h.find('span', props => props.title === '实际文件尺寸').children, '尺寸未返回');
  assert.equal(h.find('small', props => props.className === 'pg-card-model').children, '模型未报告');
  assert.equal(h.find('button', props => props['aria-label'] === '使用结果继续编辑').disabled, true);
  assert.equal(h.find('a', props => props['aria-label'] === '下载原图'), undefined);
  assert.ok(h.find('CircleAlert', props => props['aria-hidden'] === 'true'));
  assert.equal(h.find('span', props => props['aria-label'] === '任务耗时 00:25').title, '任务耗时（不含排队）');
  assert.equal(h.find('span', props => props.className === 'pg-image-ratio'), undefined);
});

test('actual image badges retain exact custom ratios and explicitly mark close approximations', () => {
  const dimensions = (width, height) => cardMeta.galleryImageDimensions({ result_width: width, result_height: height, parameters: { size: '4096x4096' } });
  assert.deepEqual(dimensions(1536, 1024), { pixels: '1536 × 1024', ratio: '3:2', exactRatio: '3:2' });
  assert.equal(dimensions(941, 1672).ratio, '≈9:16');
  assert.deepEqual(dimensions(1370, 1148), { pixels: '1370 × 1148', ratio: '≈6:5', exactRatio: '685:574' });
  assert.equal(dimensions(1700, 1000).ratio, '17:10');
  assert.equal(dimensions(317, 211).ratio, '≈3:2');
  assert.equal(dimensions(1421, 1000).ratio, '1421:1000', 'do not force a familiar ratio outside the tolerance');
  for (const invalid of [undefined, null, 0, -1, 1.5, NaN, Infinity, '1024']) assert.equal(dimensions(invalid, 1024), undefined);
});

test('task elapsed time excludes queue, acceptance and cleanup and handles hour boundaries', () => {
  const timed = { status: 'succeeded', created_at: '2026-01-01T09:00:00Z', started_at: '2026-01-01T10:00:00Z', completed_at: '2026-01-01T10:01:05.900Z', accepted_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' };
  for (const status of ['succeeded', 'accepted', 'failed', 'cancelled', 'discarded']) assert.deepEqual(cardMeta.galleryTaskElapsed({ ...timed, status }), { label: '01:05', running: false });
  assert.equal(cardMeta.galleryTaskElapsed({ ...timed, completed_at: '2026-01-01T11:02:03Z' }).label, '01:02:03');
  assert.equal(cardMeta.galleryTaskElapsed({ ...timed, completed_at: timed.started_at }).label, '00:00');
  assert.deepEqual(cardMeta.galleryTaskElapsed({ ...timed, status: 'running', completed_at: undefined }, Date.parse('2026-01-01T10:00:26Z')), { label: '00:26', running: true });
  for (const patch of [{ status: 'queued' }, { started_at: undefined }, { started_at: 'invalid' }, { completed_at: undefined }, { completed_at: 'invalid' }, { completed_at: '2026-01-01T09:59:59Z' }]) assert.equal(cardMeta.galleryTaskElapsed({ ...timed, ...patch }), undefined);
});

test('unknown timing is omitted and cancelled or cleared records do not receive a failure icon', t => {
  for (const status of ['succeeded', 'cancelled', 'discarded', 'queued']) {
    const h = render(t, { ...job, status, started_at: undefined, completed_at: '2026-01-01T10:00:25Z' });
    assert.equal(h.find('CircleAlert', () => true), undefined);
    assert.equal(h.find('span', props => props.className?.startsWith('pg-task-duration')), undefined);
  }
});

test('copy feedback expires locally and repeated copy renews its full lifetime', async t => {
  const h = render(t, job);
  h.find('button', props => props['aria-label'] === '复制提示词').onClick(); await h.flush();
  await h.advance(2100);
  h.find('button', props => props['aria-label'] === '已复制提示词').onClick(); await h.flush();
  await h.advance(2199);
  assert.ok(h.find('button', props => props['aria-label'] === '已复制提示词'));
  await h.advance(1);
  assert.ok(h.find('button', props => props['aria-label'] === '复制提示词'));
  assert.equal(h.find('span', props => props.role === 'status').children, '');
  assert.deepEqual(h.events.copied, [prompt, prompt]);
  assert.deepEqual(h.events.messages, []);
});

for (const [name, failure] of [['false result', () => false], ['rejection', () => { throw Error('clipboard permission denied'); }]]) {
  test(`copy ${name} reports an error without showing a success state`, async t => {
    const h = render(t, job, new Set(), failure);
    h.find('button', props => props['aria-label'] === '复制提示词').onClick(); await h.flush();
    assert.ok(h.find('button', props => props['aria-label'] === '复制提示词'));
    assert.equal(h.find('span', props => props.role === 'status').children, '');
    assert.deepEqual(h.events.messages, ['复制失败，请打开详情手动复制']);
  });
}

test('a stale clipboard failure cannot overwrite the latest successful copy', async t => {
  let rejectFirst, calls = 0;
  const pending = new Promise((_, reject) => { rejectFirst = reject; });
  const h = render(t, job, new Set(), () => ++calls === 1 ? pending : true);
  h.find('button', props => props['aria-label'] === '复制提示词').onClick();
  h.find('button', props => props['aria-label'] === '复制提示词').onClick(); await h.flush();
  rejectFirst(Error('late clipboard failure')); await h.flush();
  assert.ok(h.find('button', props => props['aria-label'] === '已复制提示词'));
  assert.deepEqual(h.events.messages, []);
});
