import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(relative) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
function evaluate(js, dependencies, timers = globalThis) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', js)(name => {
    assert.ok(name in dependencies, `unmocked dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, timers.setTimeout, timers.clearTimeout);
  return module.exports;
}
const component = await compile('../frontend/src/components/gallery/TaskGrid.tsx');
const recipe = evaluate(await compile('../frontend/src/utils/galleryRecipe.ts'), {
  './compatibleRecipe': {}, './compatibleProfiles': {}, './promptTemplateVariables': {},
});
const gridMath = evaluate(await compile('../frontend/src/utils/playground/virtualGrid.ts'), {});
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
  assert.equal(h.find('span', props => props.title === '请求质量').children, 'max');
  assert.equal(h.find('small', props => props.className === 'pg-card-model').children, job.model);
  assert.equal(h.find('small', props => props.className === 'pg-card-model').title, job.model);
  assert.equal(h.find('a', props => props['aria-label'] === '下载原图').href, '/media/generation-results/original.webp');
  assert.equal(h.find('time', () => true).dateTime, job.created_at);
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
  const h = render(t, { ...job, status: 'failed', result_path: undefined, result_width: undefined, result_height: undefined, model: undefined });
  assert.equal(h.find('img', () => true), undefined);
  assert.equal(h.find('span', props => props.className === 'pg-status-tag failed').children, recipe.galleryStatus.failed);
  assert.equal(h.find('span', props => props.title === '实际文件尺寸').children, '尺寸未返回');
  assert.equal(h.find('small', props => props.className === 'pg-card-model').children, '模型未报告');
  assert.equal(h.find('button', props => props['aria-label'] === '使用结果继续编辑').disabled, true);
  assert.equal(h.find('a', props => props['aria-label'] === '下载原图'), undefined);
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
