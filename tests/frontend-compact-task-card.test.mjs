import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(relative) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
function evaluate(js, dependencies) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => {
    assert.ok(name in dependencies, `unmocked dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
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
function render(job, selected = new Set()) {
  const events = { opened: [], reused: [], selected: [], copied: [], messages: [] };
  const jsx = (type, props) => ({ type, props });
  const scrollRef = { current: { clientHeight: 500 } };
  const { default: TaskGrid } = evaluate(component, {
    react: { useRef: initial => ({ current: initial }), useState: initial => [initial, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../api/client': { mediaUrl: path => `/media/${path}` },
    '../../utils/galleryRecipe': recipe,
    '../../utils/playground/virtualGrid': gridMath,
    '../../utils/playground/useVirtualGrid': { useVirtualGrid: (_grid, count, scroll) => {
      assert.equal(scroll, scrollRef);
      return { startIndex: 0, endIndex: count, paddingTop: 0, paddingBottom: 0, metricsRef: { current: { columns: 3, rowHeight: 162, rowGap: 16, columnGap: 16, width: 1250 } } };
    } },
    '../../utils/clipboard': { copyTextToClipboard: async text => { events.copied.push(text); return true; } },
  });
  const tree = TaskGrid({ jobs: [job], selected, scrollRef, onOpen: value => events.opened.push(value), onReuse: (...values) => events.reused.push(values), onSelection: value => events.selected.push(value), onMessage: value => events.messages.push(value) });
  return { tree, events, find: (type, predicate) => descendants(tree).find(node => node.type === type && predicate(node.props))?.props };
}
const prompt = '  完整提示词\r\n\n原样保留\t ';
const job = {
  id: 'compact-result', status: 'succeeded', prompt_text: 'older prompt', edited_prompt_text: prompt,
  model: 'gpt-image-2.5-sunburst-enterprise', created_at: '2026-01-01T10:00:00Z',
  result_path: 'generation-results/original.webp', result_width: 941, result_height: 1676,
  parameters: { size: '2160x3840', quality: 'max' },
};

test('compact card retains actual dimensions, full model, exact prompt and original image link', () => {
  const h = render(job);
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

test('compact card callbacks preserve inspect, full-recipe reuse, edit, copy and independent selection', async () => {
  const selected = new Set(['previous']);
  const h = render(job, selected);
  h.find('button', props => props['aria-label'] === `查看任务 ${job.id}`).onClick();
  h.find('button', props => props['aria-label'] === '恢复完整配方').onClick();
  h.find('button', props => props['aria-label'] === '使用结果继续编辑').onClick();
  h.find('button', props => props['aria-label'] === '复制提示词').onClick();
  h.find('button', props => props['aria-label'] === `选择任务 ${job.id}`).onClick();
  await Promise.resolve();
  assert.deepEqual(h.events.opened, [job]);
  assert.deepEqual(h.events.reused, [[job], [job, true]]);
  assert.deepEqual(h.events.copied, [prompt]);
  assert.deepEqual(h.events.messages, ['已复制提示词']);
  assert.deepEqual([...h.events.selected[0]], ['previous', job.id]);
  assert.deepEqual([...selected], ['previous']);
});

test('failed compact card does not infer actual size from request and cannot edit a missing result', () => {
  const h = render({ ...job, status: 'failed', result_path: undefined, result_width: undefined, result_height: undefined, model: undefined });
  assert.equal(h.find('img', () => true), undefined);
  assert.equal(h.find('span', props => props.className === 'pg-status-tag failed').children, recipe.galleryStatus.failed);
  assert.equal(h.find('span', props => props.title === '实际文件尺寸').children, '尺寸未返回');
  assert.equal(h.find('small', props => props.className === 'pg-card-model').children, '模型未报告');
  assert.equal(h.find('button', props => props['aria-label'] === '使用结果继续编辑').disabled, true);
  assert.equal(h.find('a', props => props['aria-label'] === '下载原图'), undefined);
});
