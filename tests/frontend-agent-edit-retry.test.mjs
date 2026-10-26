import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function compile(path) { return ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText; }
function evaluate(js, dependencies, globals = {}) { const module = { exports: {} }; new Function('require', 'module', 'exports', ...Object.keys(globals), js)(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports, ...Object.values(globals)); return module.exports; }
const code = Object.fromEntries(await Promise.all(['AgentImageRetryDialog', 'AgentEditingTaskDialog', 'AgentFailedImageEditDialog'].map(async name => [name, await compile(`../frontend/src/components/agent/${name}.tsx`)])));
const retryUtility = evaluate(await compile('../frontend/src/utils/playground/agentImageRetry.ts'), {});
const referenceUtility = evaluate(await compile('../frontend/src/utils/playground/agentImageReferences.ts'), {});
const clientCode = await compile('../frontend/src/api/agentClient.ts');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : '';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const config = () => ({ revision: 3, config: { apiConfigMode: 'hybrid', imageProfileId: 'a', imageModel: 'current-a' }, profiles: [{ id: 'a', display_name: 'Provider A', model: 'default-a', configured: true }, { id: 'b', display_name: 'Provider B', model: 'default-b', configured: true }] });
const job = () => ({ id: 'failed-job', provider: 'openai_compatible', status: 'failed', prompt_text: '  Actual execution prompt\n\nnot the original user question  ', parameters: { size: '1536x1024', quality: 'high', output_format: 'webp', output_compression: 0, background: 'opaque', moderation: 'low' } });
function harness(t, component, initialProps = {}, options = {}) {
  const slots = [], effects = [], posts = [], reads = [], receipts = [], applied = [], saves = [];
  const storage = options.storage || new Map();
  let cursor = 0, dirty = false, tree, unmounted = false, late = 0, id = 0;
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], next => { if (unmounted) late++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; dirty = true; }]; },
    useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, n) => value !== old.deps[n])) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } },
  };
  class AgentApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const api = {
    retryImage: (jobId, payload) => { posts.push({ jobId, payload }); return options.post?.(jobId, payload) ?? Promise.resolve({ retryId: payload.retryId, sourceJobId: jobId, job: { id: 'new-job', status: 'queued' } }); },
    imageRetryReceipt: (retryId, conversationId) => { reads.push({ retryId, conversationId }); return options.read?.(retryId, conversationId) ?? Promise.resolve({ retryId, sourceJobId: 'failed-job', job: { id: 'new-job', status: 'queued' } }); },
    submit: () => { throw new Error('Retry must not call text planning'); },
  };
  const jsx = (type, props) => ({ type, props });
  const dependencies = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../api/agentClient': { AgentApiError, agentApi: api }, '../../utils/playground/agentImageRetry': retryUtility, '../../utils/playground/agentImageReferences': referenceUtility, '../ToolbarSelect': { __esModule: true, default: 'select-control' }, '../settings/AgentModelPicker': { __esModule: true, default: 'model-control' }, './AgentActionDialog': { AgentActionDialog: 'dialog-shell' } };
  const Component = evaluate(code[component], dependencies, { crypto: { randomUUID: () => `retry-${++id}` }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }).default;
  const props = { job: job(), config: config(), conversationId: 'conversation', onClose() {}, onReceipt: value => receipts.push(value), onEdit() {}, onSave: value => { saves.push(value); return options.save?.(value) ?? Promise.resolve(); }, onApply: value => { applied.push(value); return options.apply?.(value) ?? Promise.resolve(); }, ...initialProps };
  const render = () => { cursor = 0; dirty = false; tree = Component(props); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let n = 0; n < 24; n++) { if (dirty && !unmounted) render(); await Promise.resolve(); } };
  const find = (type, label) => nodes(tree).find(node => node.type === type && (!label || node.props.label === label || node.props['aria-label'] === label || text(node) === label))?.props;
  const unmount = () => { unmounted = true; slots.forEach(slot => slot?.cleanup?.()); };
  render(); t.after(() => { if (!unmounted) unmount(); });
  return { posts, reads, receipts, saves, applied, storage, flush, find, unmount, AgentApiError, text: () => text(tree), get late() { return late; } };
}

test('actual retry confirmation changes only image routing and parameters, then creates one authorized task with no text planning', async t => {
  const pending = deferred(), h = harness(t, 'AgentImageRetryDialog', {}, { post: () => pending.promise }); await h.flush();
  assert.equal(h.posts.length, 0); assert.match(h.text(), /可能产生费用/);
  h.find('select-control', '重试生图供应商').onChange('b'); await h.flush();
  assert.equal(h.find('model-control').value, 'default-b');
  h.find('model-control').onChange('manual-b'); h.find('select-control', '重试质量').onChange('max'); await h.flush();
  assert.match(h.text(), /Provider B · manual-b · 手动覆盖模型/);
  const confirm = h.find('button', '确认重试一张图片'); confirm.onClick(); confirm.onClick(); await h.flush();
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0], { jobId: 'failed-job', payload: { retryId: 'retry-1', conversationId: 'conversation', configRevision: 3, imageConfig: { profileId: 'b', model: 'manual-b' }, params: { ...job().parameters, quality: 'max' }, confirmed: true } });
  assert.equal(h.find('input', '重试尺寸').disabled, true);
  pending.resolve({ retryId: 'retry-1', sourceJobId: 'failed-job', job: { id: 'new-job', status: 'queued' } }); await h.flush();
  assert.equal(h.receipts.length, 1); assert.equal(retryUtility.readImageRetries({ getItem: key => h.storage.get(key) }).length, 0);
  assert.equal(h.find('button', '确认重试一张图片'), undefined); assert.match(h.text(), /原失败记录和草稿保持不变/);
});

test('retry confirmation retains recorded effective parameters and does not invent an absent moderation override', async t => {
  const original = job(); delete original.parameters.moderation;
  original.metadata = { requested: { size: '2048x2048', quality: 'max' } };
  const h = harness(t, 'AgentImageRetryDialog', { job: original }); await h.flush();
  assert.equal(h.find('input', '重试尺寸').value, '2048x2048');
  h.find('button', '确认重试一张图片').onClick(); await h.flush();
  assert.equal(h.posts[0].payload.params.size, '2048x2048');
  assert.equal(h.posts[0].payload.params.quality, 'max');
  assert.equal(h.posts[0].payload.params.output_compression, 0);
  assert.equal(Object.hasOwn(h.posts[0].payload.params, 'moderation'), false);
});

test('unknown retry survives close and refresh and reconciles the same identity using GET only', async t => {
  const storage = new Map();
  const first = harness(t, 'AgentImageRetryDialog', {}, { storage, post: async () => { throw new TypeError('connection lost'); } }); await first.flush();
  first.find('button', '确认重试一张图片').onClick(); await first.flush(); assert.equal(first.posts.length, 1); first.unmount();
  let checks = 0;
  const second = harness(t, 'AgentImageRetryDialog', {}, { storage, read: async retryId => { if (++checks === 1) throw new Error('not confirmed'); return { retryId, sourceJobId: 'failed-job', job: { id: 'same-job', status: 'queued' } }; } }); await second.flush();
  assert.equal(second.posts.length, 0); assert.equal(second.reads.length, 0); assert.equal(second.find('button', '确认重试一张图片'), undefined);
  second.find('button', '检查原重试状态').onClick(); await second.flush();
  assert.match(second.text(), /原重试身份保持不变/); assert.equal(second.posts.length, 0);
  second.find('button', '检查原重试状态').onClick(); await second.flush();
  assert.deepEqual(second.reads, [{ retryId: 'retry-1', conversationId: 'conversation' }, { retryId: 'retry-1', conversationId: 'conversation' }]);
  assert.equal(second.receipts[0].job.id, 'same-job'); assert.equal(second.posts.length, 0);
});

test('late retry acceptance clears its journal but never updates an unmounted dialog', async t => {
  const pending = deferred(), h = harness(t, 'AgentImageRetryDialog', {}, { post: () => pending.promise }); await h.flush();
  h.find('button', '确认重试一张图片').onClick(); await h.flush(); h.unmount();
  pending.resolve({ retryId: 'retry-1', sourceJobId: 'failed-job', job: { id: 'new-job' } }); await h.flush();
  assert.equal(h.late, 0); assert.equal(h.receipts.length, 0); assert.equal(retryUtility.readImageRetries({ getItem: key => h.storage.get(key) }).length, 0);
});

for (const provider of ['agent_native', 'agent_native_batch']) test(`native ${provider} never silently changes transport or posts a direct retry`, async t => {
  const h = harness(t, 'AgentImageRetryDialog', { job: { ...job(), provider } }); await h.flush();
  assert.match(h.text(), /暂不支持直接换配置重试/); assert.ok(h.find('button', '修改提示词后重新生成'));
  const confirm = h.find('button', '确认重试一张图片'); assert.equal(confirm.disabled, true); confirm.onClick(); await h.flush(); assert.equal(h.posts.length, 0);
});

test('actual task panel binds stable target and roles, preserves explicit constraints, and saves or ends without any model call', async t => {
  const choices = [{ reference: { kind: 'upload', uploadId: 'new-target' }, label: '新图', url: '/new.png' }, { reference: { kind: 'job', jobId: 'old-light' }, label: '历史光线', url: '/old.png' }];
  const h = harness(t, 'AgentEditingTaskDialog', { task: { needsTargetSelection: true, auxiliaries: [], constraints: [] }, choices }); await h.flush();
  assert.match(h.text(), /明确选择编辑对象/); assert.equal(h.find('button', '保存任务').disabled, true);
  h.find('select-control', '当前编辑对象').onChange('upload:new-target'); await h.flush();
  h.find('select-control', '历史光线的参考作用').onChange('lighting');
  h.find('textarea', '当前修改要求').onChange({ target: { value: '只调整袜子' } });
  h.find('textarea', '已经确认的约束').onChange({ target: { value: '白色过膝袜\n保持人物姿势' } });
  h.find('select-control', '编辑任务专业工作流').onChange('gpt-image'); await h.flush();
  h.find('button', '保存任务').onClick(); await h.flush();
  assert.deepEqual(h.saves[0], { target: choices[0].reference, auxiliaries: [{ ref: choices[1].reference, role: 'lighting' }], requirements: '只调整袜子', constraints: ['白色过膝袜', '保持人物姿势'], workflow: 'gpt-image' });
  h.find('button', '结束当前编辑任务').onClick(); await h.flush(); assert.equal(h.saves[1], null);
  assert.equal(h.posts.length, 0);
});

test('failed prompt editing starts with the exact execution prompt, preserves whitespace and needs explicit confirmation', async t => {
  const h = harness(t, 'AgentFailedImageEditDialog'); await h.flush();
  assert.equal(h.find('textarea', '修改实际执行提示词').value, job().prompt_text); assert.equal(h.applied.length, 0);
  const changed = '  Keep pose\n\nChange only light.  ';
  h.find('textarea', '修改实际执行提示词').onChange({ target: { value: changed } }); await h.flush();
  h.find('button', '确认填入当前草稿').onClick(); await h.flush(); assert.deepEqual(h.applied, [changed]); assert.equal(h.posts.length, 0);
});

test('production API uses retry-current, receipt GET and branch PATCH without automatic paid retries', async () => {
  const calls = [];
  const client = evaluate(clientCode, {}, { fetch: async (url, init) => { calls.push([url, init]); if (url.endsWith('/retry-current')) throw new TypeError('unknown outcome'); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
  await assert.rejects(client.agentApi.retryImage('job/1', { retryId: 'retry', confirmed: true }));
  await client.agentApi.imageRetryReceipt('retry/1', 'conversation/1');
  await client.agentApi.updateEditingTask('conversation/1', { expectedRevision: 4, branchRoundId: 'branch', task: null });
  assert.equal(calls.length, 3); assert.equal(calls[0][0], '/api/generation-jobs/job%2F1/retry-current');
  assert.equal(calls[1][0], '/api/generation-jobs/retry-submissions/retry%2F1?conversation_id=conversation%2F1'); assert.equal(calls[1][1].body, undefined);
  assert.equal(calls[2][1].method, 'PATCH'); assert.equal(JSON.parse(calls[2][1].body).branchRoundId, 'branch');
});
