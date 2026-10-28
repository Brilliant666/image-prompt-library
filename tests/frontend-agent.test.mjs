import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';

async function sourceModule(path) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8');
  if (path.endsWith('/agentClient.ts')) {
    const progress = ts.transpileModule(await readFile(new URL('../frontend/src/api/agentProgress.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    source = source.replace("'./agentProgress'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(progress).toString('base64')}`));
  }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const graph = await sourceModule('../frontend/src/utils/playground/agentConversationState.ts');
const refs = await sourceModule('../frontend/src/utils/playground/agentImageReferences.ts');
const response = await sourceModule('../frontend/src/utils/playground/agentAssistantBlocks.ts');
const submission = await sourceModule('../frontend/src/utils/playground/agentSubmission.ts');
const client = await sourceModule('../frontend/src/api/agentClient.ts');
const round = (id, parentRoundId = null, outputTaskIds = []) => ({ id, parentRoundId, index: 1, prompt: `prompt ${id}`, outputTaskIds });
const conversation = { title: 'branches', activeRoundId: 'old-leaf', messages: [], rounds: [round('root'), round('old', 'root', ['a']), round('new', 'root', ['b']), round('old-leaf', 'old', ['c']), round('new-leaf', 'new', ['d'])] };

test('source branch paths retain the selected branch and exclude sibling images', () => {
  assert.deepEqual(graph.getActiveAgentRounds(conversation).map(item => item.id), ['root', 'old', 'old-leaf']);
  assert.deepEqual(graph.getAgentSiblingRounds(conversation, conversation.rounds[1]).map(item => item.id), ['old', 'new']);
  assert.equal(graph.getAgentBranchLeafId(conversation, 'new'), 'new-leaf');
  assert.deepEqual(graph.getAgentRoundPath(conversation, 'new-leaf').map(item => item.id), ['root', 'new', 'new-leaf']);
});

test('branch traversal is bounded for malformed parent cycles and missing parents', () => {
  const cyclic = { ...conversation, rounds: [round('a', 'b'), round('b', 'a')] };
  assert.deepEqual(graph.getAgentRoundPath(cyclic, 'a').map(item => item.id), ['b', 'a']);
  assert.equal(graph.getAgentBranchLeafId(cyclic, 'a'), 'a');
  assert.deepEqual(graph.getAgentRoundPath({ ...conversation, rounds: [round('orphan', 'gone')] }, 'orphan').map(item => item.id), ['orphan']);
});

test('reading live rounds never rewrites running status as an error', () => {
  const data = { ...conversation, rounds: [ { ...round('running'), status: 'running' } ], activeRoundId: 'running' };
  assert.equal(graph.getActiveAgentRounds(data)[0].status, 'running');
});

test('explicit mentions resolve only current branch output slots without renumbering missing results', () => {
  const result = refs.resolveAgentPromptImageReferences('use @第1轮图2, not @第1轮图1', [round('one', null, ['deleted', 'kept'])], new Set(['kept']), []);
  assert.deepEqual(result.refs, [{ kind: 'job', jobId: 'kept' }]);
  assert.deepEqual(result.missing, ['@第1轮图1']);
  assert.deepEqual(refs.resolveAgentPromptImageReferences('@第2轮图1', [round('one', null, ['a'])], new Set(['a', 'b']), []).refs, []);
});

test('selected reference order and stable identities survive duplicate mentions', () => {
  const selected = [{ kind: 'upload', uploadId: 'u' }, { kind: 'job', jobId: 'b' }];
  const value = refs.resolveAgentPromptImageReferences('@图1 @第1轮图1 @第1轮图1 @图3', [round('one', null, ['b'])], new Set(['b']), selected);
  assert.deepEqual(value.refs, selected);
  assert.deepEqual(value.missing, ['@图3']);
  assert.notEqual(refs.referenceKey({ kind: 'library', imageId: 'same' }), refs.referenceKey({ kind: 'upload', uploadId: 'same' }));
});

test('mention insertion preserves exact surrounding whitespace and replaces the typed @', () => {
  assert.deepEqual(refs.insertMention('原文\n  @尾巴', 6, 6, '@第1轮图1'), { text: '原文\n  @第1轮图1 尾巴', caret: 12 });
});

test('assistant output follows text/tool/text order and never renders hidden reasoning', () => {
  const data = { ...round('r', null, ['job']), responseOutput: [
    { type: 'reasoning', content: [{ type: 'text', text: 'private reasoning' }] },
    { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'Before' }] },
    { type: 'function_call', call_id: 'c1', name: 'generate_image' },
    { type: 'message', id: 'm2', content: [{ type: 'output_text', text: 'After' }] },
  ] };
  const blocks = response.getAgentAssistantBlocks(data, [{ id: 'job', metadata: { agent: { agentToolCallId: 'c1' } } }], 'Before\nAfter');
  assert.deepEqual(blocks.map(item => item.type), ['text', 'tool', 'image-task', 'text']);
  assert.deepEqual(blocks.filter(item => item.type === 'text').map(item => item.content), ['Before', 'After']);
  assert.ok(!JSON.stringify(blocks).includes('private reasoning'));
});

test('tool captions use readable labels without exposing internal function names', () => {
  for (const [name, label] of [['generate_image', '生成图片'], ['generate_image_batch', '批量生成图片'], ['image_generation', '生成图片'], ['continue_generation', '继续生成图片'], ['web_search', '网络搜索'], ['read_agent_skill', '读取创作技能']]) {
    assert.equal(response.getAgentToolLabel(name), label);
  }
  assert.equal(response.getAgentToolLabel('unknown_internal_function'), '执行工具');
});

test('structured later-step deltas preserve text/tool/image order through the final snapshot', () => {
  const data = { ...round('stream', null, ['job']), responseOutput: [
    { type: 'message', id: 'before', content: [{ type: 'output_text', text: '正在生成。' }] },
    { type: 'function_call', call_id: 'image-call', name: 'generate_image_batch' },
    { type: 'function_call_output', call_id: 'image-call', output: '{}' },
    { type: 'message', id: 'after', content: [{ type: 'output_text', text: '图片已' }] },
  ] };
  const tasks = [{ id: 'job', metadata: { agent: { agentBatchCallId: 'image-call' } } }];
  const streamed = response.getAgentAssistantBlocks(data, tasks, '正在生成。\n\n图片已');
  assert.deepEqual(streamed.map(item => item.type), ['text', 'tool', 'image-task', 'text']);
  assert.deepEqual(streamed.filter(item => item.type === 'text').map(item => item.content), ['正在生成。', '图片已']);
  data.responseOutput.push({ type: 'message', id: 'after', content: [{ type: 'output_text', text: '图片已完成。' }] });
  const completed = response.getAgentAssistantBlocks(data, tasks, '正在生成。\n\n图片已完成。');
  assert.deepEqual(completed.map(item => item.type), ['text', 'tool', 'image-task', 'text']);
  assert.deepEqual(completed.filter(item => item.type === 'text').map(item => item.content), ['正在生成。', '图片已完成。']);
  assert.equal(completed.at(-1).key, streamed.at(-1).key);
});

test('duplicate tool events do not duplicate image cards, missing slots stay visible', () => {
  const data = { ...round('r', null, ['gone', 'j1', 'j1']), responseOutput: [
    { type: 'function_call', call_id: 'c', name: 'generate_image_batch' },
    { type: 'function_call', call_id: 'c', name: 'generate_image_batch' },
  ] };
  const blocks = response.getAgentAssistantBlocks(data, [{ id: 'j1', metadata: { agent: { agentBatchCallId: 'c' } } }], '');
  assert.deepEqual(blocks.map(item => item.type), ['tool', 'deleted-image-task', 'image-task']);
});

test('read-only skill progress completes only after a matching local tool receipt', () => {
  const call = { type: 'function_call', call_id: 'skill-1', name: 'read_agent_skill' };
  const data = { ...round('skill'), responseOutput: [call] };
  assert.notEqual(response.getAgentAssistantBlocks(data, [], '')[0].state, 'completed');
  data.responseOutput.push({ type: 'function_call_output', call_id: 'skill-1', output: '{}' });
  const blocks = response.getAgentAssistantBlocks(data, [], '');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, 'read_agent_skill');
  assert.equal(blocks[0].state, 'completed');
  assert.ok(!blocks.some(block => block.type === 'image-task'));
});

test('replayed message snapshots replace partial text in place instead of duplicating it', () => {
  const data = { ...round('r'), responseOutput: [
    { type: 'message', id: 'same', content: [{ type: 'output_text', text: 'Partial' }] },
    { type: 'function_call', call_id: 'call', name: 'generate_image' },
    { type: 'message', id: 'same', content: [{ type: 'output_text', text: 'Final complete text' }] },
  ] };
  const blocks = response.getAgentAssistantBlocks(data, [], 'Final complete text');
  assert.equal(blocks.filter(item => item.type === 'text').length, 1);
  assert.equal(blocks[0].content, 'Final complete text');
});

test('web search progress reflects the final event without fabricating an image task', () => {
  const blocks = response.getAgentAssistantBlocks({ ...round('r'), responseOutput: [
    { type: 'web_search_call', id: 'search', status: 'in_progress' },
    { type: 'web_search_call', id: 'search', status: 'completed' },
  ] }, [], '');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].name, 'web_search');
  assert.equal(blocks[0].state, 'completed');
});

test('web citations survive ordered response blocks and render only safe source links', () => {
  const title = 'Source] [fake](https://fake.test) <img src=x> **bold**';
  const data = { ...round('r'), responseOutput: [
    { type: 'message', id: 'before', content: [{ type: 'output_text', text: 'Before search' }] },
    { type: 'web_search_call', id: 'search', status: 'completed' },
    { type: 'message', id: 'answer', content: [{ type: 'output_text', text: 'Answer with sources', annotations: [
      { type: 'url_citation', title, url: 'https://source.test/a(b)' },
      { type: 'url_citation', title: 'duplicate', url: 'https://source.test/a(b)' },
      { type: 'url_citation', title: 'Second', url: 'http://second.test/page' },
      { type: 'url_citation', title: 'bad', url: 'javascript:alert(1)' },
      { type: 'url_citation', title: 'relative', url: '/private' },
      { type: 'url_citation', title: 'credentials', url: 'https://user:secret@source.test/' },
      { type: 'file_citation', title: 'file', url: 'https://ignored.test/' },
      null,
    ] }] },
  ] };
  const blocks = response.getAgentAssistantBlocks(data, [], 'fallback must not replace ordered text');
  assert.deepEqual(blocks.map(block => block.type), ['text', 'tool', 'text']);
  assert.equal(blocks[0].content, 'Before search');
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, { skipHtml: true }, blocks[2].content));
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.match(html, /href="https:\/\/source\.test\/a%28b%29"/);
  assert.match(html, /href="http:\/\/second\.test\/page"/);
  assert.ok(html.includes('Source] [fake](https://fake.test) &lt;img src=x&gt; **bold**'));
  assert.ok(!html.includes('<img') && !html.includes('<strong') && !html.includes('secret'));
});

test('native tool outputs point to an existing shared job and do not invent jobs from text', () => {
  const data = { ...round('r', null, ['native']), responseOutput: [{ type: 'image_generation_call', id: 'ig' }] };
  const blocks = response.getAgentAssistantBlocks(data, [{ id: 'native', metadata: { agent: { agentToolCallId: 'ig' } } }], 'done');
  assert.equal(blocks.filter(item => item.type === 'image-task').length, 1);
  assert.deepEqual(response.getAgentAssistantBlocks(round('r'), [], '![fake](https://example.test/image.png)').map(item => item.type), ['text']);
});

function storage() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; }
const pending = { conversationId: 'conversation', payload: { requestId: 'frozen', prompt: '  原文\n\n', refs: [{ kind: 'upload', uploadId: 'img' }], params: { output_compression: 0 }, authorization: { allowImageGeneration: false, maxImageJobs: 0 } } };

test('uncertain submission restoration preserves frozen request ID, exact original and compression zero', () => {
  const store = storage();
  submission.savePendingAgentSubmission(store, pending);
  assert.deepEqual(submission.readPendingAgentSubmissions(store), [pending]);
  submission.savePendingAgentSubmission(store, pending);
  assert.equal(submission.readPendingAgentSubmissions(store).length, 1);
  assert.throws(() => submission.savePendingAgentSubmission(store, { ...pending, payload: { ...pending.payload, prompt: 'changed' } }), /不能改变/);
  submission.clearPendingAgentSubmission(store, 'frozen');
  assert.deepEqual(submission.readPendingAgentSubmissions(store), []);
});

test('acknowledging an Agent draft clears only the submitted content and retains full image settings', () => {
  const draft = { text: '  exact\n', refs: [{ reference: { kind: 'upload', uploadId: 'u' }, label: 'image', url: '/preview' }], params: { size: '1536x1024', quality: 'max', background: 'transparent', output_format: 'webp', output_compression: 0 }, origin: 'edit', editId: 'old-round' };
  const snapshot = structuredClone(draft);
  assert.deepEqual(submission.acknowledgeAgentDraft(draft, true), { ...draft, text: '', refs: [], origin: 'send', editId: null });
  assert.deepEqual(submission.acknowledgeAgentDraft(draft, false), { ...draft, origin: 'send', editId: null });
  assert.deepEqual(draft, snapshot);
});

test('pending restoration is read-only and does not submit or mint IDs', () => {
  const store = storage(); submission.savePendingAgentSubmission(store, pending);
  let writes = 0;
  assert.deepEqual(submission.readPendingAgentSubmissions({ getItem: store.getItem, setItem: () => { writes++; } }), [pending]);
  assert.equal(writes, 0);
  assert.deepEqual(submission.readPendingAgentSubmissions({ getItem: () => '[null,{},"bad"]' }), []);
});

test('uncertain request restores visible original text, refs and parameters even when draft restoration is off', () => {
  const entry = { ...pending, payload: { ...pending.payload, params: { size: '2048x3072', quality: 'max', output_format: 'webp', output_compression: 0 }, origin: 'edit', derivedFromRoundId: 'original-round' } };
  const store = storage(); submission.savePendingAgentSubmission(store, entry);
  assert.deepEqual(submission.readAgentDrafts(store, false), {});
  const draft = submission.draftFromPendingAgentSubmission(submission.readPendingAgentSubmissions(store)[0]);
  assert.equal(draft.text, '  原文\n\n');
  assert.deepEqual(draft.refs.map(choice => choice.reference), entry.payload.refs);
  assert.deepEqual(draft.params, entry.payload.params);
  assert.equal(draft.editId, 'original-round'); assert.equal(draft.origin, 'edit');
  draft.text = 'edited'; draft.params.quality = 'low';
  assert.deepEqual(submission.readPendingAgentSubmissions(store), [entry]);
});

test('safe-continuation retry reuses original resume ID at the same saved boundary', () => {
  const store = storage(); let created = 0;
  assert.equal(submission.getAgentResumeId(store, 'request:2:1', () => `id-${++created}`), 'id-1');
  assert.equal(submission.getAgentResumeId(store, 'request:2:1', () => `id-${++created}`), 'id-1');
  assert.equal(submission.getAgentResumeId(store, 'request:3:2', () => `id-${++created}`), 'id-2');
});

test('Chinese composition, regular Enter and multiline input cannot accidentally submit', () => {
  const key = { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false };
  assert.equal(submission.shouldSubmitAgentOnKey(key, false), false);
  assert.equal(submission.shouldSubmitAgentOnKey({ ...key, ctrlKey: true }, false), true);
  assert.equal(submission.shouldSubmitAgentOnKey({ ...key, isComposing: true, ctrlKey: true }, false), false);
  assert.equal(submission.shouldSubmitAgentOnKey({ ...key, keyCode: 229 }, true), false);
  assert.equal(submission.shouldSubmitAgentOnKey({ ...key, shiftKey: true }, true), false);
  assert.equal(submission.shouldSubmitAgentOnKey(key, true), true);
});

test('optional draft restoration validates stored shape and never restores when disabled', () => {
  const valid = { text: '\nexact original  ', refs: [{ reference: { kind: 'upload', uploadId: 'original' }, label: 'source.png', url: '/media/original.png' }], params: { size: '2048x2048', quality: 'max', output_format: 'webp', output_compression: 0 }, editId: null, origin: 'send' };
  const store = { getItem: () => JSON.stringify({ good: valid, bad: { refs: 'invalid' }, invalidRef: { ...valid, refs: [null] } }) };
  assert.deepEqual(submission.readAgentDrafts(store, true), { good: valid });
  assert.deepEqual(submission.readAgentDrafts(store, false), {});
});

test('uncertain network outcomes are not mistaken for active or completed tasks', () => {
  for (const value of ['queued', 'running', 'waiting_for_jobs', 'stop_requested']) assert.equal(response.isAgentRequestActive(value), true);
  for (const value of ['unknown', 'failed', 'completed', 'stopped', 'interrupted']) assert.equal(response.isAgentRequestActive(value), false);
});

test('Agent client performs only one POST on a network failure and preserves request body', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); throw new TypeError('network lost'); };
  try {
    await assert.rejects(client.agentApi.submit('conversation', pending.payload), /network lost/);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/agent/conversations/conversation/rounds');
    assert.deepEqual(JSON.parse(calls[0].init.body), pending.payload);
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.ok(!('Authorization' in calls[0].init.headers));
  } finally { globalThis.fetch = original; }
});

test('Agent client reads structured validation errors and GET status never sends a body', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ detail: { code: 'reference_missing', message: '引用已不存在' } }), { status: 409 }); };
  try {
    await assert.rejects(client.agentApi.request('a/b'), error => error.status === 409 && error.code === 'reference_missing' && error.message === '引用已不存在');
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/agent/requests/a%2Fb'); assert.equal(calls[0].init.body, undefined);
  } finally { globalThis.fetch = original; }
});

test('configuration reads and saves do not dispatch model requests', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ revision: 2, config: {}, ready: false })); };
  try {
    await client.getAgentConfig(); await client.saveAgentConfig(1, { textModel: 'text-model' });
    assert.deepEqual(calls.map(item => [item.url, item.init.method || 'GET']), [['/api/agent/config', 'GET'], ['/api/agent/config', 'PUT']]);
    assert.deepEqual(JSON.parse(calls[1].init.body), { expectedRevision: 1, config: { textModel: 'text-model' } });
  } finally { globalThis.fetch = original; }
});

// Execute the actual picker callbacks with mocked React hooks and local API.
// Deferred replies exercise ordering without browser timing or model calls.
const pickerSource = await readFile(new URL('../frontend/src/components/agent/AgentReferencePicker.tsx', import.meta.url), 'utf8');
const pickerJs = ts.transpileModule(pickerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function pickerNodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(pickerNodes)]; }
function pickerDeferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function pickerHarness(t) {
  const slots = [], effects = [], timers = new Map(), replies = [];
  let cursor = 0, dirty = false, tree, timerId = 0, unmounted = false;
  const state = { closed: 0, lateUpdates: 0 };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { if (unmounted) state.lateUpdates++; slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps, cleanup: undefined }; } },
  };
  const jsx = (type, props) => ({ type, props });
  const items = ['a', 'b'].map(id => ({ id, title: id.toUpperCase(), first_image: { id: `img-${id}`, original_path: `${id}.png` } }));
  const deps = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../api/client': { api: { items: async () => ({ items, total: 2 }), generationJobs: async () => ({ jobs: [], total: 0 }), item: () => replies.shift().promise }, mediaUrl: path => `/media/${path}` },
    '../../utils/playground/agentImageReferences': refs, '../../hooks/useModalFocus': { useModalFocus: () => ({ containerRef: null, handleModalKeyDown() {} }) },
    './AgentReferencePicker.css': {},
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', pickerJs)(name => { assert.ok(name in deps, `unmocked picker dependency: ${name}`); return deps[name]; }, module, module.exports, callback => { timers.set(++timerId, callback); return timerId; }, id => timers.delete(id));
  const render = () => { dirty = false; cursor = 0; tree = module.exports.AgentReferencePicker({ remaining: 4, onClose: () => state.closed++, onSelect() {} }); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let i = 0; i < 20; i++) { if (dirty && !unmounted) render(); const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await Promise.resolve(); } };
  const nodes = (type, predicate = () => true) => pickerNodes(tree).filter(node => node.type === type && predicate(node.props)).map(node => node.props);
  const unmount = () => { if (!unmounted) { unmounted = true; slots.forEach(slot => slot?.cleanup?.()); } };
  render(); t.after(unmount);
  return { state, flush, nodes, unmount, enqueue() { const reply = pickerDeferred(); replies.push(reply); return reply; } };
}

test('actual Agent picker ignores late detail replies after a newer item, tab switch, close or unmount', async t => {
  const harness = pickerHarness(t); await harness.flush();
  const detail = id => ({ id, title: id.toUpperCase(), images: [{ id: `img-${id}`, original_path: `${id}.png` }] });
  const detailButtons = () => harness.nodes('button', props => props.children === '查看此条目的全部图片');
  const first = harness.enqueue(), second = harness.enqueue();
  detailButtons()[0].onClick(); detailButtons()[1].onClick();
  second.resolve(detail('b')); await harness.flush(); first.resolve(detail('a')); await harness.flush();
  assert.equal(harness.nodes('strong')[0].children, 'B');
  harness.nodes('button', props => [props.children].flat().includes('返回列表'))[0].onClick(); await harness.flush();
  const afterBack = harness.enqueue(), shownBeforeBack = harness.enqueue();
  detailButtons()[0].onClick(); detailButtons()[1].onClick(); shownBeforeBack.resolve(detail('b')); await harness.flush();
  harness.nodes('button', props => [props.children].flat().includes('返回列表'))[0].onClick(); await harness.flush();
  afterBack.resolve(detail('a')); await harness.flush(); assert.equal(harness.nodes('strong')[0].children, '选择引用图片');
  const afterTab = harness.enqueue(); detailButtons()[0].onClick();
  harness.nodes('button', props => props.children === '画廊')[0].onClick(); await harness.flush();
  afterTab.reject(Error('obsolete detail failure')); await harness.flush();
  assert.equal(harness.nodes('strong')[0].children, '选择引用图片'); assert.equal(harness.nodes('p', props => props.role === 'alert').length, 0);
  harness.nodes('button', props => props.children === 'Library')[0].onClick(); await harness.flush();
  const afterClose = harness.enqueue(); detailButtons()[0].onClick(); harness.nodes('button', props => props['aria-label'] === '关闭选择图片')[0].onClick();
  afterClose.resolve(detail('a')); await harness.flush(); assert.equal(harness.state.closed, 1); assert.equal(harness.nodes('strong')[0].children, '选择引用图片');
  const afterUnmount = harness.enqueue(); detailButtons()[0].onClick(); harness.unmount(); afterUnmount.resolve(detail('a')); await harness.flush();
  assert.equal(harness.state.lateUpdates, 0);
});
