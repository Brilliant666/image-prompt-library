import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function evaluate(js, deps, globals = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(name => { assert.ok(name in deps, `unmocked dependency: ${name}`); return deps[name]; }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
const utility = async path => evaluate(await compile(`../frontend/src/utils/${path}.ts`), {});
const workspaceJs = await compile('../frontend/src/components/agent/AgentWorkspace.tsx');
const runStateJs = await compile('../frontend/src/components/agent/useAgentRunState.ts');
const submissionJs = await compile('../frontend/src/utils/playground/agentSubmission.ts');
const imageReferences = await utility('playground/agentImageReferences');
const conversationState = await utility('playground/agentConversationState');
const assistantBlocks = await utility('playground/agentAssistantBlocks');
const compatibleRecipe = await utility('compatibleRecipe');
const bridge = await utility('agentGalleryBridge');
const inputPreferences = await utility('agentInputPreferences');
const progress = evaluate(await compile('../frontend/src/api/agentProgress.ts'), {});
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const content = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(content).join('') : node && typeof node === 'object' ? content(node.props?.children) : '';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const originalPrompt = '  Original prompt\r\n\r\nKeep texture.  \r\n';
const pickedPrompt = '  Selected prompt\r\n\r\nKeep pose.\t  \r\n';
const round = (id = 'r1', parentRoundId = null) => ({ id, index: 1, parentRoundId, prompt: originalPrompt, inputImageIds: ['old-image'], outputTaskIds: [], userMessageId: `${id}-user`, assistantMessageId: `${id}-assistant`, requestId: `${id}-request`, status: 'done', error: null, createdAt: 1, finishedAt: 2 });
function snapshot(id = 'current', extra = {}) {
  const first = round();
  return { schemaVersion: 1, revision: 4, conversation: { id, title: id, activeRoundId: first.id, createdAt: 1, updatedAt: 2, rounds: [first], messages: [{ id: 'r1-assistant', roundId: 'r1', role: 'assistant', content: `Analysis.\n\n\`\`\`prompt\r\n${pickedPrompt}\`\`\`\n\n\`\`\`text\nDo not silently select this last block.\n\`\`\`` }] },
    request: null, jobs: [], images: [{ id: 'old-image', source: { kind: 'upload', uploadId: 'history' }, status: 'available', url: '/history.png', thumbnailUrl: '/history.png' }], contextMode: 'task',
    taskContext: { schemaVersion: 1, taskId: 'task-one', revision: 2, branchRoundId: 'r1', taskType: 'prompt', target: null, auxiliaries: [], promptVersions: [{ id: 'v1', text: originalPrompt, kind: 'original', source: { kind: 'user', roundId: 'r1' } }, { id: 'v2', text: pickedPrompt, kind: 'selected', source: { kind: 'model', roundId: 'r1' } }], originalPromptVersionId: 'v1', selectedPromptVersionId: 'v2', executedPromptVersionId: null, constraints: [], latestUserAddition: null, unresolvedItems: ['需确认背景'], completeness: 'history_required', historyDependencies: [{ roundId: 'r1', reason: '用户仍引用上一轮图片' }] }, ...extra };
}

function harness(t, options = {}) {
  const slots = [], effects = [], timers = new Map(), listeners = new Map(), submissions = [], mutations = [], reads = [], watchers = [];
  const storage = new Map([['ipl.agent.active-conversation', 'current']]);
  const drafts = { current: { text: 'Keep my unsent draft', refs: [{ reference: { kind: 'upload', uploadId: 'draft-image' }, label: 'draft.png', url: 'http://isolated.test/draft.png' }], params: { size: 'auto', quality: 'auto', background: 'auto', output_format: 'png' }, origin: 'send', editId: null, ...options.draft }, next: { text: 'Other draft', refs: [], params: { size: 'auto', quality: 'auto', output_format: 'png' }, origin: 'send', editId: null } };
  storage.set('ipl.agent.drafts.v1', JSON.stringify(drafts));
  const initial = options.snapshot || snapshot(), latest = new Map([['current', initial], ['next', snapshot('next', { taskContext: null, contextMode: 'legacy' })]]);
  let cursor = 0, dirty = false, tree, timerId = 0, unmounted = false, late = 0, props = {};
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], next => { if (unmounted) late++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; dirty = true; }]; },
    useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
    useMemo(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
  };
  const jsx = (type, props) => ({ type, props });
  class AgentApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const globalMocks = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { innerWidth: 1200, innerHeight: 900, addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeEventListener: (name, fn) => listeners.get(name)?.delete(fn) },
    document: { activeElement: null, body: {}, getElementById: () => null }, location: { origin: 'http://isolated.test' },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => { fn(); return 1; }, crypto: { randomUUID: () => `new-${submissions.length}` },
  };
  const api = {
    conversation: async id => { reads.push(id); return options.conversation?.(id, latest) ?? latest.get(id); },
    updateTaskContext: async (id, body) => { const reply = deferred(); mutations.push({ id, body, ...reply }); return reply.promise; },
    submit: async (id, body) => { const reply = deferred(); submissions.push({ id, body, ...reply }); return reply.promise; },
    updateConversation: async (id, body) => { const value = { ...latest.get(id), revision: 8, conversation: { ...latest.get(id).conversation, activeRoundId: body.activeRoundId } }; latest.set(id, value); return value; },
  };
  const submission = evaluate(submissionJs, {}, globalMocks);
  const baseDeps = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../api/agentClient': { AgentApiError, agentApi: api, watchAgentRequest: (id, onSnapshot) => { watchers.push({ id, onSnapshot }); return () => {}; }, getAgentConfig: async () => ({ revision: 1, config: { apiConfigMode: 'native', maxToolRounds: 5, maxImageJobs: 3 }, profiles: [], ready: true, imageReady: true, issues: [], capabilities: { maxInputImages: 4 } }) }, '../../utils/playground/agentAssistantBlocks': assistantBlocks, '../../utils/playground/agentSubmission': submission, '../../utils/localPreferences': { readLocalPreferences: () => ({ persistInputOnRestart: true }) } };
  const runState = evaluate(runStateJs, baseDeps, globalMocks);
  const deps = { ...baseDeps, 'react-dom': { createPortal: value => value }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../hooks/useModalFocus': { useModalFocus: () => ({ containerRef: {}, handleModalKeyDown() {} }) }, './useAgentConversations': { useAgentConversations: () => ({ rows: [], upsert() {}, refresh() {}, remove() {} }) }, './useAgentScroll': { useAgentScroll: () => () => {} }, './useAgentRunState': runState,
    '../../api/client': { api: {}, mediaUrl: path => `/media/${path}` }, '../../utils/playground/agentConversationState': conversationState, '../../utils/playground/agentImageReferences': imageReferences, '../../utils/compatibleRecipe': compatibleRecipe, '../../utils/agentGalleryBridge': bridge, '../../utils/agentInputPreferences': inputPreferences, '../../utils/clipboard': { copyTextToClipboard: async () => true },
    './AgentMarkdown': { AgentMarkdown: 'markdown' }, './AgentReferencePicker': { AgentReferencePicker: 'picker' }, './AgentImageOptions': { __esModule: true, default: 'image-options' }, '../gallery/SizeDialog': { __esModule: true, default: 'size-dialog' }, './AgentWorkspace.css': {}, './AgentResponseDetails': { AgentResponseDetails: 'details' }, './AgentImageRetryButton': { __esModule: true, default: 'retry' },
  };
  const Component = evaluate(workspaceJs, deps, globalMocks).default;
  const render = () => { dirty = false; cursor = 0; tree = Component({ active: true, onOpenSettings() {}, onOpenJob() {}, onLibraryChanged() {}, ...props }); effects.splice(0).forEach(fn => fn()); };
  const flush = async () => { for (let i = 0; i < 25; i++) { if (dirty && !unmounted) render(); await Promise.resolve(); } };
  render();
  t.after(() => { unmounted = true; slots.forEach(slot => slot?.cleanup?.()); });
  return { flush, submissions, mutations, reads, watchers, storage, latest, AgentApiError, nodes: () => nodes(tree), text: () => content(tree), node: (type, label) => nodes(tree).find(node => node.type === type && (!label || node.props?.['aria-label'] === label))?.props,
    update(next) { props = { ...props, ...next }; render(); }, get late() { return late; } };
}

test('production scope controls default to task, preserve drafts and send only explicitly selected history', async t => {
  const h = harness(t); await h.flush();
  assert.equal(h.node('select', '发送上下文范围').value, 'task');
  assert.match(content(h.node('p', '上下文范围提示').children), /仍依赖历史内容/);
  h.node('select', '发送上下文范围').onChange({ target: { value: 'selected' } }); await h.flush();
  h.node('input', '带入第 1 轮历史').onChange({ target: { checked: true } }); await h.flush();
  assert.match(content(h.node('p', '上下文范围提示').children), /已选择 1 轮历史/);
  h.node('button', '发送 Agent 消息').onClick(); await h.flush();
  assert.equal(h.submissions.length, 1);
  assert.deepEqual(h.submissions[0].body.historyRoundIds, ['r1']);
  assert.equal(h.submissions[0].body.contextScope, 'selected'); assert.equal(h.submissions[0].body.taskRevision, 2);
  assert.equal(h.submissions[0].body.prompt, 'Keep my unsent draft');
  assert.deepEqual(h.submissions[0].body.refs, [{ kind: 'upload', uploadId: 'draft-image' }]);
});

test('production full branch choice warns about cost and latency while legacy snapshots stay explicit', async t => {
  const h = harness(t, { snapshot: snapshot('current', { taskContext: null, contextMode: 'legacy' }) }); await h.flush();
  assert.match(h.text(), /旧会话，尚无结构化任务/);
  assert.match(content(h.node('p', '上下文范围提示').children), /兼容规则读取当前分支历史/);
  h.node('select', '发送上下文范围').onChange({ target: { value: 'branch' } }); await h.flush();
  assert.match(h.text(), /响应可能更慢、费用更高/);
  h.node('button', '发送 Agent 消息').onClick(); await h.flush();
  assert.equal(h.submissions[0].body.contextScope, 'branch'); assert.equal(h.submissions[0].body.taskRevision, null);
});

test('explicit production Prompt callback keeps exact source; restoring and resetting never consume composer data', async t => {
  const h = harness(t); await h.flush();
  assert.match(h.text(), /用户仍引用上一轮图片/); assert.match(h.text(), /Agent 回答，由你明确选择/);
  h.node('markdown').onSelectPrompt(pickedPrompt); await h.flush();
  assert.deepEqual(h.mutations[0].body, { expectedRevision: 4, branchRoundId: 'r1', taskRevision: 2, operations: [{ op: 'set_prompt', text: pickedPrompt, kind: 'selected', source: { kind: 'model', roundId: 'r1', messageId: 'r1-assistant' } }] });
  h.mutations[0].resolve(snapshot('current', { revision: 5 })); await h.flush();
  h.node('button', '恢复 Prompt v1').onClick(); await h.flush();
  assert.deepEqual(h.mutations[1].body.operations, [{ op: 'restore_prompt', id: 'v1' }]);
  h.mutations[1].resolve(snapshot('current', { revision: 6, taskContext: { ...snapshot().taskContext, selectedPromptVersionId: 'v1' } })); await h.flush();
  h.node('button', '重置当前任务').onClick(); await h.flush();
  assert.deepEqual(h.mutations[2].body.operations, [{ op: 'new_task' }]);
  h.mutations[2].resolve(snapshot('current', { revision: 7, taskContext: null })); await h.flush();
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Keep my unsent draft');
  assert.ok(h.nodes().some(node => node.type === 'img' && node.props.src === 'http://isolated.test/draft.png')); assert.equal(h.submissions.length, 0);
});

test('production task CAS conflict reads the latest state without replaying a mutation or replacing draft attachments', async t => {
  const h = harness(t); await h.flush();
  h.node('button', '重置当前任务').onClick(); await h.flush();
  const fresh = snapshot('current', { revision: 20, taskContext: { ...snapshot().taskContext, revision: 10, taskId: 'other-tab-task' } }); h.latest.set('current', fresh);
  h.mutations[0].reject(new h.AgentApiError(409, 'task_revision_conflict', 'changed')); await h.flush();
  assert.equal(h.mutations.length, 1); assert.match(h.text(), /已在其他页面或后续轮次中改变/);
  assert.match(h.text(), /任务版本 10/); assert.equal(h.node('textarea', 'Agent 消息').value, 'Keep my unsent draft');
  assert.equal(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current.refs[0].reference.uploadId, 'draft-image');
});

test('late production task receipt after conversation selection cannot overwrite the visible task or either draft', async t => {
  const h = harness(t); await h.flush();
  h.node('button', '重置当前任务').onClick(); await h.flush();
  h.update({ focusConversationId: 'next', focusToken: 1 }); await h.flush();
  h.mutations[0].resolve(snapshot('current', { revision: 99, taskContext: { ...snapshot().taskContext, revision: 99 } })); await h.flush();
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Other draft'); assert.doesNotMatch(h.text(), /任务版本 99/);
  assert.equal(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current.text, 'Keep my unsent draft');
});

test('a queued production task callback from the previous conversation cannot start a mutation after selection changes', async t => {
  const h = harness(t); await h.flush();
  const staleReset = h.node('button', '重置当前任务').onClick;
  h.update({ focusConversationId: 'next', focusToken: 1 }); await h.flush();
  staleReset(); await h.flush();
  assert.equal(h.mutations.length, 0); assert.equal(h.submissions.length, 0);
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Other draft');
  const saved = JSON.parse(h.storage.get('ipl.agent.drafts.v1'));
  assert.equal(saved.current.text, 'Keep my unsent draft'); assert.equal(saved.current.refs[0].reference.uploadId, 'draft-image');
  assert.equal(saved.next.text, 'Other draft');
});

test('production history image re-addition is explicit, deduplicated and preserves draft text', async t => {
  const h = harness(t); await h.flush();
  h.node('button', '重新加入第 1 轮图片 old-image').onClick(); await h.flush();
  assert.equal(h.node('button', '重新加入第 1 轮图片 old-image').disabled, true);
  assert.equal(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current.refs.length, 2);
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Keep my unsent draft'); assert.equal(h.submissions.length, 0);
});

test('production target picker binds the explicit target while retaining every existing draft attachment', async t => {
  const h = harness(t); await h.flush();
  h.node('button', '更换任务主要图片').onClick(); await h.flush();
  assert.equal(h.node('picker').remaining, 1);
  const reference = { kind: 'library', imageId: 'replacement' };
  h.node('picker').onSelect([{ reference, url: '/replacement.png', label: 'replacement' }]); await h.flush();
  assert.deepEqual(h.mutations[0].body.operations, [{ op: 'set_target', ref: reference }]);
  const value = snapshot('current', { revision: 5, taskContext: { ...snapshot().taskContext, revision: 3, targetExplicit: true, target: { assetId: 'replacement', source: reference } }, images: [...snapshot().images, { id: 'replacement', source: reference, status: 'available', url: '/replacement.png' }] });
  h.mutations[0].resolve(value); await h.flush();
  assert.match(h.text(), /主要图片：当前任务主要图片/);
  assert.equal(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current.refs[0].reference.uploadId, 'draft-image');
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Keep my unsent draft'); assert.equal(h.submissions.length, 0);
});

test('production selected scope rejects missing or out-of-branch history before creating a submission', async t => {
  const h = harness(t, { draft: { contextScope: 'selected', historyRoundIds: ['other-branch'] } }); await h.flush();
  h.node('button', '发送 Agent 消息').onClick(); await h.flush();
  assert.equal(h.submissions.length, 0); assert.match(h.text(), /请选择当前分支中需要带入的历史轮次/);
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Keep my unsent draft');
});

test('production implicit target replacement lists old evidence and the new main image without claiming an exact send count', async t => {
  const value = snapshot();
  value.taskContext = { ...value.taskContext, taskType: 'image_edit', target: { assetId: 'old-image', source: { kind: 'upload', uploadId: 'history' } }, auxiliaries: [{ assetId: 'old-aux', source: { kind: 'upload', uploadId: 'aux' }, role: 'style' }], completeness: 'complete', unresolvedItems: [], historyDependencies: [] };
  value.images.push({ id: 'old-aux', source: { kind: 'upload', uploadId: 'aux' }, status: 'available', url: '/aux.png' });
  const h = harness(t, { snapshot: value }); await h.flush();
  const list = h.node('div', '本次图片对象'); assert.equal(list.children.length, 3);
  assert.match(content(list.children), /旧目标图片 · 任务证据候选/); assert.match(content(list.children), /旧辅助图片 · 任务证据候选/);
  assert.match(content(h.node('span', '发送图片范围').children), /^3 个图片候选 · 实际发送数量待核对 · 主要图片：draft.png$/);
  assert.match(content(h.node('p', '图片候选范围说明').children), /新附件作为主要图片，旧目标与旧辅助图片仍可能作为任务证据/);
  h.node('button', '发送 Agent 消息').onClick(); await h.flush();
  assert.deepEqual(h.submissions[0].body.refs, [{ kind: 'upload', uploadId: 'draft-image' }]);
  assert.equal(h.submissions[0].body.contextScope, 'task'); assert.equal(h.submissions[0].body.taskRevision, 2);
});

test('production legacy and unresolved scopes expose branch image candidates with a matching list count', async t => {
  for (const taskContext of [null, { ...snapshot().taskContext, target: null, auxiliaries: [], completeness: 'partial', unresolvedItems: ['Need target'], historyDependencies: [] }]) {
    const h = harness(t, { snapshot: snapshot('current', { taskContext, contextMode: taskContext ? 'task' : 'legacy' }) }); await h.flush();
    const list = h.node('div', '本次图片对象'); assert.equal(list.children.length, 2);
    assert.match(content(h.node('span', '发送图片范围').children), /^2 个图片候选 · 实际发送数量待核对/);
    assert.match(content(h.node('p', '图片候选范围说明').children), /当前分支 1 轮历史中的已知候选/);
    assert.match(content(list.children), /第 1 轮参考图 · 历史候选/);
    assert.equal(h.submissions.length, 0);
  }
});

test('a complete new prompt task keeps an exact explicit-object preview and does not add old pictures', async t => {
  const h = harness(t, { snapshot: snapshot('current', { taskContext: { ...snapshot().taskContext, completeness: 'complete', unresolvedItems: [], historyDependencies: [] } }) }); await h.flush();
  assert.equal(h.node('div', '本次图片对象').children.length, 1);
  assert.match(content(h.node('span', '发送图片范围').children), /^1 个图片对象 · 主要图片：draft.png$/);
  assert.equal(h.node('p', '图片候选范围说明'), undefined);
  h.node('button', '发送 Agent 消息').onClick(); await h.flush();
  assert.deepEqual(h.submissions[0].body.refs, [{ kind: 'upload', uploadId: 'draft-image' }]);
  assert.equal(h.submissions[0].body.contextScope, 'task');
});

test('persisted and uncertain drafts restore the explicit context choice while malformed scopes default to task', () => {
  const submission = evaluate(submissionJs, {});
  const base = { text: 'draft', refs: [], params: { size: 'auto', quality: 'auto' }, editId: null, origin: 'send' };
  const read = value => submission.readAgentDrafts({ getItem: () => JSON.stringify({ current: { ...base, ...value } }) }, true).current;
  assert.equal(read({ contextScope: 'branch' }).contextScope, 'branch');
  assert.equal(read({ contextScope: 'unexpected' }).contextScope, 'task');
  assert.deepEqual(read({ contextScope: 'selected', historyRoundIds: ['r1', 5, null] }).historyRoundIds, ['r1']);
  const frozen = submission.draftFromPendingAgentSubmission({ payload: { prompt: 'frozen', refs: [], params: base.params, origin: 'send', contextScope: 'selected', historyRoundIds: ['r1'] } });
  assert.equal(frozen.contextScope, 'selected'); assert.deepEqual(frozen.historyRoundIds, ['r1']);
});

test('production task API sends one branch and task revision guarded PATCH with the exact original Prompt', async () => {
  const calls = [];
  const { agentApi } = evaluate(await compile('../frontend/src/api/agentClient.ts'), { './agentProgress': {} }, { fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
  const body = { expectedRevision: 4, branchRoundId: 'r1', taskRevision: 2, operations: [{ op: 'set_prompt', text: pickedPrompt, kind: 'selected', source: { kind: 'model', roundId: 'r1', messageId: 'r1-assistant' } }] };
  await agentApi.updateTaskContext('chat / one', body);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/agent/conversations/chat%20%2F%20one/task-context');
  assert.equal(calls[0].init.method, 'PATCH'); assert.deepEqual(JSON.parse(calls[0].init.body), body);
});

test('production code block only selects its exact Prompt when its own explicit button is clicked', async () => {
  const selected = [], jsx = (type, props) => ({ type, props });
  const { AgentCodeBlock } = evaluate(await compile('../frontend/src/components/agent/AgentCodeBlock.tsx'), { react: { useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect() {} }, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {}, '../../utils/clipboard': {}, './AgentCodeBlock.css': {} });
  const tree = AgentCodeBlock({ children: 'renderer text with different whitespace', prompt: true, copyText: pickedPrompt, onSelectPrompt: text => selected.push(text) });
  assert.deepEqual(selected, []);
  nodes(tree).find(node => node.props?.['aria-label'] === '设为当前任务 Prompt').props.onClick();
  assert.deepEqual(selected, [pickedPrompt]);
});

function progressInitial(legacyView = false) {
  const value = snapshot();
  value.request = { id: 'r1-request', conversationId: 'current', roundId: 'r1', state: 'running', authorization: { maxImageJobs: 0 } };
  value.conversation.rounds[0].taskContext = value.taskContext;
  const { rounds, messages, ...conversation } = value.conversation;
  value.stream = { version: 1, epoch: 'task-epoch', sequence: 0, requestId: 'r1-request', conversationId: 'current', roundId: 'r1', view: {
    revision: value.revision, conversation, round: rounds[0], messages, request: value.request, editingTask: null, jobs: value.jobs, images: value.images,
    ...(legacyView ? {} : { taskContext: value.taskContext, contextMode: value.contextMode }),
  } };
  return value;
}
const taskPatch = (sequence, operations) => ({ version: 1, epoch: 'task-epoch', sequence, baseSequence: sequence - 1, requestId: 'r1-request', conversationId: 'current', roundId: 'r1', operations });
const replace = (path, value) => ({ op: 'replace', path, value });

test('new bounded progress updates the visible task and context mode without replacing either draft', async t => {
  const value = progressInitial(), accepted = progress.acceptAgentSnapshot(value, 'r1-request');
  assert.equal(accepted.kind, 'applied');
  const h = harness(t, { snapshot: value }); await h.flush();
  const revised = { ...value.taskContext, revision: 3, selectedPromptVersionId: 'v1', completeness: 'complete', historyDependencies: [], unresolvedItems: [] };
  const changed = progress.applyAgentProgress(accepted.state, taskPatch(1, [replace(['revision'], 5), replace(['taskContext'], revised), replace(['round', 'taskContext'], revised)]), 'r1-request');
  assert.equal(changed.kind, 'applied');
  assert.equal(changed.state.snapshot.taskContext.revision, 3); assert.equal(changed.state.snapshot.contextMode, 'task');
  assert.equal(changed.state.snapshot.conversation.rounds[0].taskContext, revised);
  h.watchers[0].onSnapshot(changed.state.snapshot); await h.flush();
  assert.match(h.text(), /任务状态 · 完整 · Prompt v1/); assert.match(h.text(), /任务版本 3/);
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Keep my unsent draft');
  const saved = JSON.parse(h.storage.get('ipl.agent.drafts.v1'));
  assert.equal(saved.current.refs[0].reference.uploadId, 'draft-image'); assert.equal(saved.next.text, 'Other draft');
  const cleared = progress.applyAgentProgress(changed.state, taskPatch(2, [replace(['revision'], 6), replace(['taskContext'], null), replace(['contextMode'], 'legacy'), replace(['round', 'taskContext'], null)]), 'r1-request');
  assert.equal(cleared.kind, 'applied'); assert.equal(cleared.state.snapshot.taskContext, null);
  h.watchers[0].onSnapshot(cleared.state.snapshot); await h.flush();
  assert.match(h.text(), /旧会话，尚无结构化任务/); assert.equal(h.node('textarea', 'Agent 消息').value, 'Keep my unsent draft');
});

test('older bounded views preserve full-snapshot task fields, while old snapshots without task fields stay compatible', async t => {
  const value = progressInitial(true), accepted = progress.acceptAgentSnapshot(value, 'r1-request');
  const changed = progress.applyAgentProgress(accepted.state, taskPatch(1, [replace(['revision'], 5), replace(['messages', 0, 'content'], 'continued')]), 'r1-request');
  assert.equal(changed.kind, 'applied'); assert.equal(changed.state.snapshot.taskContext, value.taskContext); assert.equal(changed.state.snapshot.contextMode, 'task');
  const legacy = progressInitial(true); delete legacy.taskContext; delete legacy.contextMode; delete legacy.conversation.rounds[0].taskContext;
  const oldAccepted = progress.acceptAgentSnapshot(legacy, 'r1-request'); assert.equal(oldAccepted.kind, 'applied');
  const oldChanged = progress.applyAgentProgress(oldAccepted.state, taskPatch(1, [replace(['revision'], 5)]), 'r1-request');
  assert.equal(oldChanged.kind, 'applied'); assert.equal(Object.hasOwn(oldChanged.state.snapshot, 'taskContext'), false); assert.equal(Object.hasOwn(oldChanged.state.snapshot, 'contextMode'), false);
  const h = harness(t, { snapshot: oldChanged.state.snapshot }); await h.flush();
  assert.match(h.text(), /旧会话，尚无结构化任务/); assert.equal(h.node('select', '发送上下文范围').value, 'task');
});

test('task assets survive preview replacement and invalid context modes require read-only resync', () => {
  const value = progressInitial();
  value.taskContext = { ...value.taskContext, target: { assetId: 'preview-old', source: { kind: 'upload', uploadId: 'history' } }, targetExplicit: true };
  value.images.push({ id: 'preview-old', source: { kind: 'upload', uploadId: 'history' }, status: 'available', url: '/old.png' });
  value.jobs.push({ id: 'image-job', metadata: { agent: { partialImageId: 'preview-old' } } });
  value.stream.view.taskContext = value.taskContext;
  const accepted = progress.acceptAgentSnapshot(value, 'r1-request');
  const changed = progress.applyAgentProgress(accepted.state, taskPatch(1, [replace(['images'], [{ id: 'preview-new' }]), replace(['jobs', 0, 'metadata', 'agent', 'partialImageId'], 'preview-new')]), 'r1-request');
  assert.equal(changed.kind, 'applied'); assert.ok(changed.state.snapshot.images.some(image => image.id === 'preview-old'));
  const invalid = progress.applyAgentProgress(accepted.state, taskPatch(1, [replace(['contextMode'], 'unsupported')]), 'r1-request');
  assert.equal(invalid.kind, 'resync');
  const duplicate = progress.applyAgentProgress(changed.state, taskPatch(1, [replace(['taskContext'], null)]), 'r1-request');
  assert.equal(duplicate.kind, 'ignore'); assert.equal(changed.state.snapshot.taskContext.taskId, 'task-one');
});
