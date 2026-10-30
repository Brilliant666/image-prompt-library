import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const workspace = await readFile(new URL('../frontend/src/components/agent/AgentWorkspace.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('AgentWorkspace.tsx', workspace, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const cardSource = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ResultCard').getText(parsed);
const requestCardSource = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'RequestFailureCard').getText(parsed);
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function module(source, globals = {}, deps = {}) {
  const result = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), compile(source))(name => {
    assert.ok(name in deps, `unmocked dependency: ${name}`); return deps[name];
  }, result, result.exports, ...Object.values(globals));
  return result.exports;
}
const response = module(await readFile(new URL('../frontend/src/utils/playground/agentAssistantBlocks.ts', import.meta.url), 'utf8'));
test('production request failure card copies only sanitized explanation and opens actual details', async () => {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'RequestFailureCard');
  const writes = [], opened = [], errors = [];
  const jsx = (type, props) => ({ type, props });
  const Component = module(`export ${declaration.getText(parsed)}`, { Copy: 'copy', useRef: value => ({ current: value }), useEffect: () => {},
    copyTextToClipboard: async text => { writes.push(text); return true; } }, { 'react/jsx-runtime': { jsx, jsxs: jsx } }).RequestFailureCard;
  const failure = response.getAgentFailure({ kind: 'moderation', detail: '代码：moderation_blocked；供应商说明：输入图片未通过审核。', message: 'RAW_SECRET' });
  const tree = Component({ failure, onDetails: value => opened.push(value), onError: value => errors.push(value), copyEnabled: true });
  const all = nodes(tree), button = label => all.find(node => node.type === 'button' && node.props['aria-label'] === label).props;
  button('复制失败原因').onClick(); await Promise.resolve();
  assert.equal(writes.length, 1); assert.match(writes[0], /供应商审核拒绝.*\n\n代码：moderation_blocked/s);
  assert.doesNotMatch(writes[0], /RAW_SECRET/);
  const target = {}; button('查看失败详情').onClick({ currentTarget: target }); assert.deepEqual(opened, [target]);
  assert.equal(all.some(node => node.props?.['aria-label'] === '复制生图提示词'), false);
  assert.deepEqual(errors, []);
});
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function cardHarness(options = {}) {
  const slots = []; let cursor = 0, tree, dirty = false, unmounted = false, late = 0;
  const imageWrites = [], textWrites = [], errors = [];
  const jsx = (type, props) => ({ type, props });
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof value === 'function' ? value() : value }; return [slots[i].value, next => { if (unmounted) late++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; dirty = true; }]; },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps?.some((value, index) => !Object.is(value, previous.deps?.[index]))) { previous?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; } },
  };
  const globals = { ...hooks, mediaUrl: value => `http://isolated.test/media/${value}`, errorText: reason => reason.message,
    localResultRecovery: job => job.metadata?.local_result_recovery,
    LocalResultRecovery: 'local-result-recovery',
    statusText: { queued: '排队中', running: '生成中', succeeded: '已生成', accepted: '已收录', failed: '失败', unknown: '未知', cancelled: '已停止' },
    sameOriginImage: value => value || '', getAgentJobFailure: options.failure || response.getAgentJobFailure,
    copyTextToClipboard: async text => { textWrites.push(text); return options.textCopy?.(text) ?? true; },
    copyFinalImageToClipboard: (url, args) => { imageWrites.push({ url, args }); return options.copy?.(url, args) ?? Promise.resolve(); },
    AbortController, api: { acceptGenerationJobAsNewItem: async () => {} },
    Copy: 'copy', Check: 'check', MoreHorizontal: 'more', LoaderCircle: 'spinner', ImagePlus: 'image', Download: 'download', Plus: 'plus',
  };
  const Component = options.component === 'request'
    ? module(`export ${requestCardSource}`, globals, { 'react/jsx-runtime': { jsx, jsxs: jsx } }).RequestFailureCard
    : module(`export ${cardSource}`, globals, { 'react/jsx-runtime': { jsx, jsxs: jsx } }).ResultCard;
  let props = { job: { id: 'actual-result', status: 'succeeded', result_path: 'generation-results/actual.png', prompt_text: '  exact\nPrompt  ', result_width: 64, result_height: 32 }, onOpen() {}, onSaved() {}, onDetails() {}, onError: value => errors.push(value), onReference() {}, referenceDisabled: false, copyEnabled: true, ...options.props };
  function render() { cursor = 0; dirty = false; tree = Component(props); }
  async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty && !unmounted) render(); } }
  render();
  return { imageWrites, textWrites, errors, flush, get late() { return late; }, all: () => nodes(tree), button: label => nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === label)?.props,
    update(value) { props = { ...props, ...value }; render(); }, unmount() { unmounted = true; slots.forEach(slot => slot.cleanup?.()); } };
}

test('late failure-copy receipts cannot write into another request, hidden workspace or unmounted card', async () => {
  for (const transition of ['request', 'hidden', 'unmounted']) {
    const pending = deferred();
    const h = cardHarness({ component: 'request', textCopy: () => pending.promise,
      props: { requestId: 'old', failure: response.getAgentFailure('moderation') } });
    h.button('复制失败原因').onClick(); await h.flush();
    if (transition === 'request') h.update({ requestId: 'new' });
    else if (transition === 'hidden') h.update({ copyEnabled: false });
    else h.unmount();
    pending.resolve(false); await h.flush();
    assert.deepEqual(h.errors, [], transition); assert.equal(h.late, 0);
  }
});

test('actual final result card has separate direct actions for image and exact Prompt copying', async () => {
  const h = cardHarness();
  const copy = h.button('复制图片'); assert.ok(copy, 'a successful final result needs a real image copy action');
  copy.onClick(); await h.flush();
  assert.equal(h.imageWrites.length, 1); assert.equal(h.imageWrites[0].url, 'http://isolated.test/media/generation-results/actual.png');
  assert.equal(h.textWrites.length, 0);
  assert.equal(h.all().some(node => node.type === 'details' || node.type === 'summary'), false, 'a single Prompt action needs no ellipsis menu');
  assert.equal(h.button('图片更多操作'), undefined);
  assert.equal(h.button('复制生图提示词').children, '复制生图提示词', 'Prompt copying is a named text action, distinct from image copying');
  h.button('复制生图提示词').onClick(); await h.flush(); assert.deepEqual(h.textWrites, ['  exact\nPrompt  ']);
});

test('actual Agent result card prioritizes retained local results over paid retry and supplier-failure presentation', async () => {
  const recovered = [];
  const h = cardHarness({ props: { job: { id: 'paid-original', status: 'failed', prompt_text: 'Exact original prompt',
    metadata: { local_result_recovery: { state: 'pending', message: '图片已取得，本地保存记录待恢复。', can_recover: true } } },
    retry: 'paid retry', onRecovered: job => recovered.push(job) } });
  const control = h.all().find(node => node.type === 'local-result-recovery');
  assert.ok(control, 'a paid final result needs local recovery, rather than another paid generation');
  assert.equal(h.button('复制失败原因'), undefined);
  assert.equal(h.all().some(node => [node.props?.children].flat(Infinity).includes('paid retry')), false);
  const restored = { id: 'paid-original', status: 'succeeded', result_path: 'generation-results/paid-original/final.png' };
  control.props.onRecovered(restored);
  assert.deepEqual(recovered, [restored]);
  assert.deepEqual(h.imageWrites, []);
  assert.deepEqual(h.textWrites, []);
});

test('terminal results expose Prompt copying directly and retain their applicable result actions', async () => {
  for (const status of ['succeeded', 'accepted', 'failed', 'unknown', 'cancelled']) {
    const retry = { type: 'button', props: { 'aria-label': '重试图片' } };
    const final = ['succeeded', 'accepted'].includes(status);
    const h = cardHarness({ props: { job: { id: status, status, result_path: final ? 'final.png' : null, prompt_text: '  Exact\n\nPrompt  ' }, retry } });
    assert.equal(h.all().some(node => node.type === 'details' || node.type === 'summary' || node.props?.['aria-label'] === '图片更多操作'), false, status);
    const prompt = h.button('复制生图提示词'); assert.ok(prompt, status); assert.equal(prompt.children, '复制生图提示词');
    prompt.onClick(); await h.flush(); assert.deepEqual(h.textWrites, ['  Exact\n\nPrompt  ']); assert.deepEqual(h.imageWrites, []);
    assert.ok(h.button(final ? '查看或编辑生成结果' : '查看生成详情'), status);
    assert.equal(Boolean(h.button('重试图片')), final || status === 'failed', status);
    if (final) {
      assert.ok(h.button('保存到 Library')); assert.ok(h.button('加入本轮参考图'));
      assert.ok(h.all().some(node => node.type === 'a' && node.props.download !== undefined && node.props.href.endsWith('final.png')));
    }
    h.update({ copyEnabled: false }); assert.equal(h.button('复制生图提示词').disabled, true);
  }
});

test('actual result copy action waits for completion, rejects double-click and keeps late receipts off an unmounted card', async () => {
  const pending = deferred(), h = cardHarness({ copy: () => pending.promise });
  const copy = h.button('复制图片'); assert.ok(copy); copy.onClick(); copy.onClick(); await h.flush();
  assert.equal(h.imageWrites.length, 1); assert.ok(h.button('复制图片').disabled);
  assert.ok(!h.all().some(node => node.props?.children === '图片已复制'));
  h.unmount(); assert.equal(h.imageWrites[0].args.signal.aborted, true);
  pending.resolve(); await h.flush(); assert.equal(h.late, 0); assert.deepEqual(h.errors, []);
});

test('copying is aborted on navigation and a failed image write never reports success or copies Prompt', async () => {
  const pending = deferred(), h = cardHarness({ copy: () => pending.promise });
  const copy = h.button('复制图片'); assert.ok(copy); copy.onClick(); await h.flush();
  h.update({ copyEnabled: false }); assert.equal(h.imageWrites[0].args.signal.aborted, true);
  pending.reject(new Error('permission denied')); await h.flush(); assert.deepEqual(h.errors, []); assert.deepEqual(h.textWrites, []);
  const failed = cardHarness({ copy: () => Promise.reject(new Error('没有剪贴板写入权限')) });
  failed.button('复制图片').onClick(); await failed.flush();
  assert.deepEqual(failed.errors, ['没有剪贴板写入权限']); assert.deepEqual(failed.textWrites, []);
});

test('queued, failed, unknown and partial preview cards never offer final-image copying', () => {
  for (const status of ['queued', 'running', 'failed', 'unknown', 'cancelled']) {
    const h = cardHarness({ props: { job: { id: status, status, result_path: status === 'unknown' ? 'partial.png' : null, prompt_text: 'original' }, preview: { status: 'available', url: 'http://isolated.test/preview.png' } } });
    assert.equal(h.button('复制图片'), undefined, status);
  }
  for (const status of ['failed', 'unknown', 'cancelled']) {
    const h = cardHarness({ props: { job: { id: status, status, result_path: null, prompt_text: 'original' } } });
    assert.equal(h.all().some(node => node.props?.className === 'agent-result-placeholder'), false, 'a terminal failure must not retain a blank loading-sized placeholder');
  }
});

test('pending result cards contain no ellipsis menu, recovery controls or duplicate loading status', () => {
  for (const status of ['queued', 'running', 'cancel_requested']) {
    const retry = { type: 'button', props: { 'aria-label': '重试图片' } };
    const h = cardHarness({ props: { job: { id: status, status, result_path: null, prompt_text: 'Keep original' }, retry } });
    assert.equal(h.all().some(node => node.type === 'details'), false, status + ': no meaningless ellipsis menu');
    assert.equal(h.all().some(node => node.type === 'footer'), false, status + ': no premature View/Edit or recovery controls');
    assert.equal(h.all().some(node => node.type === 'button'), false, status + ': pending card has no outcome actions');
    const spinners = h.all().filter(node => node.type === 'spinner');
    assert.equal(spinners.length, 1, status + ': retain a central visual waiting cue');
    assert.equal(spinners[0].props['aria-hidden'], 'true');
    assert.equal(spinners[0].props.role, undefined, 'the visual cue is not a second readable status');
    assert.equal(h.all().some(node => node.props?.role === 'status'), false, 'aggregate progress owns the readable loading status');
  }
});

test('failed and unknown result cards keep a spacious real message body with safe reason copying and explicit details', async () => {
  const detail = '上游返回 model_not_available：请检查当前模型是否支持 Images 接口。';
  for (const status of ['failed', 'unknown']) {
    const retry = { type: 'button', props: { 'aria-label': '重试图片' } };
    const h = cardHarness({ failure: () => ({ label: status === 'unknown' ? '图片结果未知' : '模型或接口不支持', detail, action: '请先查看生成详情，确认后再决定是否重试。' }),
      props: { job: { id: status, status, result_path: null, prompt_text: 'Original Prompt', error: 'RAW_SECRET_DO_NOT_RENDER' }, retry } });
    const article = h.all().find(node => node.type === 'article');
    assert.match(article.props.className, /agent-result-card-terminal/);
    const message = h.all().find(node => node.type === 'section' && node.props.className === 'agent-result-message');
    assert.ok(message, 'terminal card needs a padded content body rather than a thin error bar or empty placeholder');
    assert.match(JSON.stringify(message), /model_not_available/); assert.doesNotMatch(JSON.stringify(message), /RAW_SECRET_DO_NOT_RENDER/);
    assert.equal(h.all().some(node => node.props?.className === 'agent-result-placeholder'), false);
    assert.ok(h.button('查看生成详情'));
    assert.equal(Boolean(h.button('重试图片')), status === 'failed', 'unknown results must not expose a blind retry');
    const copy = h.button('复制失败原因'); assert.ok(copy); copy.onClick(); await h.flush();
    assert.equal(h.textWrites.length, 1); assert.match(h.textWrites[0], /model_not_available/); assert.doesNotMatch(h.textWrites[0], /RAW_SECRET_DO_NOT_RENDER/);
    assert.deepEqual(h.imageWrites, []);
  }
});

const imageRound = (statuses, extra = {}) => ({ id: 'round', requestId: 'request', status: 'completed', outputTaskIds: statuses.map((_, i) => `j${i}`), responseOutput: [{ type: 'function_call', call_id: 'call', name: 'generate_image_batch', status: 'completed' }], ...extra });
const jobs = statuses => statuses.map((status, index) => ({ id: `j${index}`, status, metadata: { agent: { agentBatchCallId: 'call' } } }));
function imageProgressView(round, resultJobs, request) {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ImageResultProgress');
  assert.ok(declaration, 'Workspace must use the actual result progress presentation component');
  const jsx = (type, props) => ({ type, props });
  const Component = module(`export ${declaration.getText(parsed)}`, {}, { 'react/jsx-runtime': { jsx, jsxs: jsx } }).ImageResultProgress;
  return Component({ round, jobs: resultJobs, request, progress: response.getAgentImageProgress(round, resultJobs, request) });
}

test('a single terminal result card explains failure or unknown once without a redundant aggregate bar', () => {
  for (const status of ['failed', 'unknown']) {
    const round = imageRound([status]), resultJobs = jobs([status]);
    assert.ok(response.getAgentImageProgress(round, resultJobs), 'safety summary remains available to details and other consumers');
    assert.equal(imageProgressView(round, resultJobs), null, 'the fully explained result card owns this one outcome');
    const h = cardHarness({ props: { job: resultJobs[0] } });
    assert.ok(h.all().find(node => node.props?.className === 'agent-result-message'));
    assert.ok(h.button('查看生成详情'));
    if (status === 'unknown') assert.match(JSON.stringify(h.all()), /确认结果前不要重复生成/);
  }
});

test('aggregate presentation keeps partial counts, missing tasks, extra calls and separate stop or upstream-unknown warnings', () => {
  const cases = [
    [imageRound(['succeeded', 'failed']), jobs(['succeeded', 'failed']), undefined, /部分.*1 \/ 2/],
    [imageRound(['failed']), [], undefined, /记录不可用/],
    [imageRound([], { status: 'error', failure: { kind: 'authentication' } }), [], undefined, /认证/],
    [imageRound(['failed']), jobs(['failed']), { id: 'request', state: 'stopped', stopRequested: true }, /停止/],
    [imageRound(['unknown']), jobs(['unknown']), { id: 'request', state: 'unknown', upstreamMayContinue: true }, /未知/],
    [imageRound(['failed']), jobs(['failed']), { id: 'request', state: 'unknown' }, /未知/],
    [imageRound(['unknown'], { resultSummary: { requestState: 'stopped', outcomeUnknown: true } }), jobs(['unknown']), undefined, /未知/],
    [imageRound(['failed'], { responseOutput: [{ type: 'function_call', call_id: 'call', name: 'generate_image_batch' }, { type: 'function_call', call_id: 'second', name: 'generate_image' }] }), jobs(['failed']), undefined, /未生成/],
  ];
  for (const [round, resultJobs, request, expected] of cases) {
    const view = imageProgressView(round, resultJobs, request);
    assert.equal(view?.type, 'p'); assert.equal(view.props.role, 'status'); assert.match(view.props.children, expected);
  }
  const duplicate = imageRound(['failed']); duplicate.responseOutput.push({ ...duplicate.responseOutput[0] });
  assert.equal(imageProgressView(duplicate, jobs(['failed'])), null, 'duplicate receipt is not a second image request');
});
test('image progress counts actual tasks once and completed image tools have no visible technical bar', () => {
  assert.equal(typeof response.getAgentImageProgress, 'function');
  const statuses = ['succeeded', 'running'];
  const progress = response.getAgentImageProgress(imageRound(statuses, { status: 'running' }), jobs(statuses), { id: 'request', state: 'waiting_for_jobs', authorization: { maxImageJobs: 10 } });
  assert.equal(progress.text, '正在生成 2 张 · 已完成 1 张');
  assert.equal(response.getAgentImageProgress(imageRound(['succeeded']), jobs(['succeeded'])), null);
  assert.equal(response.getAgentToolLabel('generate_image_batch'), '生成图片');
});

test('real task outcomes preserve partial failure, unknown, stopped and non-image tools', () => {
  assert.equal(typeof response.getAgentImageProgress, 'function');
  for (const [statuses, expected] of [[['succeeded', 'failed'], /部分.*成功/], [['unknown'], /未知.*检查.*不会自动/], [['cancelled'], /停止/], [['failed'], /未生成/]]) {
    assert.match(response.getAgentImageProgress(imageRound(statuses), jobs(statuses)).text, expected);
  }
  const round = imageRound([], { status: 'running', responseOutput: [{ type: 'function_call', call_id: 'skill', name: 'read_agent_skill' }, { type: 'function_call', call_id: 'image', name: 'generate_image_batch', status: 'completed' }] });
  assert.match(response.getAgentImageProgress(round, []).text, /准备/);
  assert.ok(response.getAgentAssistantBlocks(round, [], '').some(block => block.type === 'tool' && block.name === 'read_agent_skill'));
});

test('a later dependent image call cannot disappear behind a successful earlier result', () => {
  const round = imageRound(['succeeded'], { status: 'running', responseOutput: [
    { type: 'function_call', call_id: 'call', name: 'generate_image_batch', status: 'completed' },
    { type: 'function_call', call_id: 'next-call', name: 'generate_image', status: 'completed' },
  ] });
  const result = jobs(['succeeded']);
  assert.match(response.getAgentImageProgress(round, result).text, /准备后续图片请求.*已完成 1 张/);
  round.status = 'done';
  assert.match(response.getAgentImageProgress(round, result).text, /已保留 1 张结果.*另有图片调用未获得结果/);
  const failure = imageRound([], { status: 'error', failure: { kind: 'authentication' } });
  assert.match(response.getAgentImageProgress(failure, []).text, /认证或权限问题.*检查供应商配置/);
});

test('continue_generation is a control receipt, not an image job missing its result', () => {
  const continuation = { type: 'function_call', call_id: 'continue', name: 'continue_generation', status: 'completed' };
  const round = imageRound(['succeeded', 'succeeded'], { responseOutput: [
    { type: 'function_call', call_id: 'call', name: 'generate_image_batch', status: 'completed' },
    continuation,
    { type: 'function_call_output', call_id: 'continue', output: JSON.stringify({ status: 'continued' }) },
    { type: 'function_call', call_id: 'next-call', name: 'generate_image', status: 'completed' },
  ] });
  const result = jobs(['succeeded', 'succeeded']);
  result[1].metadata.agent.agentBatchCallId = 'next-call';
  assert.equal(response.getAgentImageProgress(round, result), null);
  assert.equal(response.isAgentImageTool('continue_generation'), true, 'the control remains grouped with image-related tools');
  assert.equal(response.getAgentImageProgress(imageRound([], { responseOutput: [continuation] }), []), null);
  round.status = 'running';
  assert.equal(response.getAgentImageProgress(round, result), null, 'a control receipt must not invent a pending image request');
  round.responseOutput.push({ type: 'function_call', call_id: 'third-call', name: 'generate_image', status: 'completed' });
  assert.match(response.getAgentImageProgress(round, result).text, /准备后续图片请求.*已完成 2 张/);
  round.status = 'completed';
  assert.match(response.getAgentImageProgress(round, result).text, /另有图片调用未获得结果/);
});

const imageClipboardSource = await readFile(new URL('../frontend/src/utils/imageClipboard.ts', import.meta.url), 'utf8');
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function clipboardHarness(options = {}) {
  const writes = [], fetches = [], conversions = [], canvases = [], closed = [], oldClipboardReads = [];
  const input = options.blob ?? new Blob([pngBytes], { type: 'image/png' });
  class Item { static supports = () => options.supported !== false; constructor(data) { this.data = data; } }
  const clipboard = { write(items) { writes.push(items); if (options.deny) return Promise.reject(new DOMException('denied', 'NotAllowedError')); return Promise.all(items.flatMap(item => Object.values(item.data))).then(() => undefined); }, read() { oldClipboardReads.push(true); throw Error('must not inspect clipboard'); }, readText() { oldClipboardReads.push(true); throw Error('must not inspect clipboard'); }, writeText() { throw Error('image copy must never become text copy'); } };
  const globals = { Blob, Response, URL, DOMException, AbortController, Uint8Array, DataView,
    navigator: { clipboard }, ClipboardItem: Item, location: { origin: 'http://isolated.test' },
    fetch: (url, args) => { fetches.push({ url, args }); return options.fetch?.(url, args) ?? Promise.resolve(new Response(input, { status: options.status || 200 })); },
    createImageBitmap: async (blob, settings) => { conversions.push({ blob, settings }); if (options.decodeError) throw Error('invalid data'); return { width: options.width || 19, height: options.height || 11, close: () => closed.push(true) }; },
    document: { createElement: name => { assert.equal(name, 'canvas'); const canvas = { width: 0, height: 0, getContext: () => ({ drawImage(bitmap, x, y) { assert.equal(canvas.width, bitmap.width); assert.equal(canvas.height, bitmap.height); assert.equal(x, 0); assert.equal(y, 0); } }), toBlob(callback, type) { assert.equal(type, 'image/png'); canvas.writtenSize = [canvas.width, canvas.height]; callback(options.canvasFailure ? null : new Blob([pngBytes], { type: 'image/png' })); } }; canvases.push(canvas); return canvas; } },
  };
  const value = module(imageClipboardSource, globals);
  return { ...value, writes, fetches, conversions, canvases, closed, oldClipboardReads };
}

test('clipboard write starts in the click stack with a Blob Promise and only receives the final PNG bytes', async () => {
  const network = deferred(), h = clipboardHarness({ fetch: () => network.promise });
  let finished = false;
  const copy = h.copyFinalImageToClipboard('/media/generation-results/final.png').then(() => { finished = true; });
  assert.equal(h.writes.length, 1, 'must write before async image fetch settles, preserving user activation');
  const representation = h.writes[0][0].data['image/png']; assert.ok(representation instanceof Promise);
  assert.equal(finished, false); assert.equal(h.conversions.length, 0);
  network.resolve(new Response(new Blob([pngBytes], { type: 'image/png' }))); await copy;
  assert.equal(finished, true); assert.deepEqual(Buffer.from(await (await representation).arrayBuffer()), pngBytes);
  assert.equal(h.fetches[0].url, 'http://isolated.test/media/generation-results/final.png');
  assert.equal(h.fetches[0].args.redirect, 'error'); assert.deepEqual(h.oldClipboardReads, []);
});

test('JPEG and WebP use full visible bitmap dimensions and orientation, release resources and only write memory PNG', async () => {
  for (const [type, bytes] of [['image/jpeg', [255, 216, 255, 224, 1, 2]], ['image/webp', Buffer.from('RIFF0000WEBPimage')]]) {
    const h = clipboardHarness({ blob: new Blob([new Uint8Array(bytes)], { type }), width: 19, height: 11 });
    await h.copyFinalImageToClipboard('/media/actual-result');
    assert.equal(h.conversions.length, 1); assert.equal(h.conversions[0].blob.type, type);
    assert.deepEqual(h.conversions[0].settings, { imageOrientation: 'from-image' });
    assert.deepEqual(h.canvases[0].writtenSize, [19, 11]); assert.equal(h.canvases[0].width, 0); assert.equal(h.canvases[0].height, 0);
    assert.equal(h.closed.length, 1); assert.equal((await h.writes[0][0].data['image/png']).type, 'image/png');
    assert.deepEqual(h.oldClipboardReads, []);
  }
});

test('missing image, unsupported content, decode failure and permission denial stay accurate without a text fallback', async () => {
  for (const [options, code] of [[{ status: 404 }, 'missing'], [{ blob: new Blob(['not an image']) }, 'format'], [{ deny: true }, 'permission'], [{ supported: false }, 'unsupported'], [{ blob: new Blob([new Uint8Array([255, 216, 255])]), decodeError: true }, 'decode']]) {
    const h = clipboardHarness(options);
    await assert.rejects(h.copyFinalImageToClipboard('/media/final'), error => error.code === code);
    assert.deepEqual(h.oldClipboardReads, []);
    if (code === 'unsupported') { assert.equal(h.fetches.length, 0); assert.equal(h.writes.length, 0); }
  }
});

test('a navigation abort rejects pending representation and does not convert or read the clipboard', async () => {
  const network = deferred(), controller = new AbortController(), h = clipboardHarness({ fetch: () => network.promise });
  const copy = h.copyFinalImageToClipboard('/media/final', { signal: controller.signal });
  controller.abort(); network.resolve(new Response(new Blob([pngBytes], { type: 'image/png' })));
  await assert.rejects(copy, error => error.name === 'AbortError');
  assert.equal(h.fetches[0].args.signal.aborted, true); assert.equal(h.conversions.length, 0); assert.deepEqual(h.oldClipboardReads, []);
});

test('copy rejects unsafe origin and excessive decoded dimensions without resizing or writing a new file', async () => {
  const h = clipboardHarness();
  await assert.rejects(h.copyFinalImageToClipboard('https://other.test/private-image'), error => error.code === 'source');
  assert.equal(h.fetches.length, 0); assert.equal(h.writes.length, 0);
  const hugePng = Buffer.from(pngBytes); hugePng.writeUInt32BE(10000, 16); hugePng.writeUInt32BE(10000, 20);
  const large = clipboardHarness({ blob: new Blob([hugePng], { type: 'image/png' }) });
  await assert.rejects(large.copyFinalImageToClipboard('/media/huge'), error => error.code === 'too_large');
  assert.equal(large.conversions.length, 0); assert.deepEqual(large.canvases, []);
});
