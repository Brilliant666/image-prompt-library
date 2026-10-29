import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function evaluate(js, dependencies, globals = {}) { const module = { exports: {} }; new Function('require', 'module', 'exports', ...Object.keys(globals), js)(name => { assert.ok(name in dependencies, `unmocked dependency: ${name}`); return dependencies[name]; }, module, module.exports, ...Object.values(globals)); return module.exports; }
const utility = async path => evaluate(await compile(`../frontend/src/utils/${path}.ts`), {});
const workspaceJs = await compile('../frontend/src/components/agent/AgentWorkspace.tsx'), runStateJs = await compile('../frontend/src/components/agent/useAgentRunState.ts'), submissionJs = await compile('../frontend/src/utils/playground/agentSubmission.ts');
const references = await utility('playground/agentImageReferences'), conversation = await utility('playground/agentConversationState'), blocks = await utility('playground/agentAssistantBlocks'), compatible = await utility('compatibleRecipe'), bridge = await utility('agentGalleryBridge'), inputPreferences = await utility('agentInputPreferences');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : '';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const selectedText = '  Selected exact prompt\r\n\r\nKeep pose and texture.\t  \r\n';
const params = { size: '1536x1024', quality: 'high', output_format: 'webp', output_compression: 0, background: 'opaque', moderation: 'low' };
const image = (id, source = { kind: 'upload', uploadId: id }) => ({ id, source, status: 'available', url: `/${id}.png`, thumbnailUrl: `/${id}.png`, width: 1200, height: 800, sha256: `${id}-hash` });
function snapshot(id = 'current', extra = {}) {
  const target = image('target'), auxiliary = image('style');
  const taskContext = { schemaVersion: 1, taskId: 'task', revision: 7, branchRoundId: 'r1', taskType: 'image_edit', targetExplicit: true, target: { assetId: target.id, source: target.source }, auxiliaries: [{ assetId: auxiliary.id, source: auxiliary.source, role: 'style' }],
    promptVersions: [{ id: 'original', text: 'Original', kind: 'original', source: { kind: 'user', roundId: 'r1' } }, { id: 'selected', text: selectedText, kind: 'selected', source: { kind: 'model', roundId: 'r1', messageId: 'a1' }, confirmedBy: 'user' }, { id: 'candidate-last', text: 'Never automatically choose this last codeblock.', kind: 'candidate', source: { kind: 'model', roundId: 'r1' } }],
    originalPromptVersionId: 'original', selectedPromptVersionId: 'selected', executedPromptVersionId: null, latestUserAddition: null, constraints: [], unresolvedItems: [], completeness: 'complete', historyDependencies: [] };
  return { schemaVersion: 1, revision: 12, conversation: { id, title: id, activeRoundId: 'r1', createdAt: 1, updatedAt: 2, rounds: [{ id: 'r1', index: 1, parentRoundId: null, userMessageId: 'u1', assistantMessageId: 'a1', prompt: 'Original', inputImageIds: ['target', 'style'], outputTaskIds: [], status: 'done', requestId: 'old', taskContext }], messages: [{ id: 'a1', roundId: 'r1', role: 'assistant', content: `\`\`\`prompt\r\n${selectedText}\`\`\`\n\n\`\`\`text\nNever automatically choose this last codeblock.\n\`\`\`` }] }, taskContext, contextMode: 'task', editingTask: null, request: null, jobs: [], images: [target, auxiliary], ...extra };
}
function receipt(payload, source = snapshot(), mode = 'hybrid') {
  const id = `execution-${payload.requestId}`, taskContext = { ...source.taskContext, revision: 8, branchRoundId: id };
  const directRecipe = { version: 1, requestId: payload.requestId, sourceBranchRoundId: payload.branchRoundId, taskId: payload.taskId, taskRevision: payload.taskRevision, promptVersionId: payload.promptVersionId, prompt: selectedText, promptSource: source.taskContext.promptVersions[1].source,
    references: [{ ...source.taskContext.target, role: 'target', order: 0, path: '/target.png', sha256: 'target-hash' }, { ...source.taskContext.auxiliaries[0], order: 1, path: '/style.png', sha256: 'style-hash' }], params: { ...payload.params, model: payload.imageConfig.model }, imageCount: payload.imageCount, mode, fingerprint: 'frozen' };
  return { ...source, revision: 13, taskContext, conversation: { ...source.conversation, activeRoundId: id, rounds: [...source.conversation.rounds, { id, index: 2, parentRoundId: payload.branchRoundId, prompt: selectedText, inputImageIds: ['target', 'style'], taskImageIds: [], outputTaskIds: [], userMessageId: `${id}-user`, assistantMessageId: `${id}-assistant`, requestId: payload.requestId, status: 'running', kind: 'prompt_execution', directRecipe, taskContext }] }, request: { id: payload.requestId, conversationId: source.conversation.id, roundId: id, state: 'queued', authorization: { maxImageJobs: payload.imageCount } } };
}

function harness(t, options = {}) {
  const slots = [], effects = [], timers = new Map(), listeners = new Map(), direct = [], receipts = [], submissions = [], watchers = [], updates = [], reads = [];
  const storage = options.storage || new Map([['ipl.agent.active-conversation', 'current']]);
  const drafts = { current: { text: 'Unsent draft\n  keep exact', refs: [{ reference: { kind: 'upload', uploadId: 'composer-only' }, label: 'composer.png', url: 'http://isolated.test/composer.png' }], params: { ...params }, origin: 'send', editId: null }, next: { text: 'Next conversation draft', refs: [], params: { size: 'auto', quality: 'auto', output_format: 'png' }, origin: 'send', editId: null } };
  if (!storage.has('ipl.agent.drafts.v1')) storage.set('ipl.agent.drafts.v1', JSON.stringify(drafts));
  let config = { revision: 4, config: { apiConfigMode: 'hybrid', imageProfileId: 'image-config', imageModel: 'config-image', textProfileId: 'text', textModel: 'text-model', maxImageJobs: 10, maxToolRounds: 5, webSearch: true }, profiles: [{ id: 'image-gallery', display_name: 'Gallery Images', model: 'gallery-image', configured: true }], ready: true, imageReady: true, issues: [], imageIssues: [], capabilities: { maxInputImages: 4, webSearch: true }, ...options.config };
  const initial = options.snapshot || snapshot(), latest = new Map([['current', initial], ['next', snapshot('next', { taskContext: null, contextMode: 'legacy' })]]);
  let cursor = 0, dirty = false, tree, timer = 0, uuid = 0, unmounted = false, late = 0, props = { galleryImageSettings: { provider: 'openai_compatible', profileId: 'image-gallery', model: 'gallery-image', params: { ...params }, count: 3 }, ...options.props };
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], next => { if (unmounted) late++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; dirty = true; }]; },
    useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) { slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); } },
    useMemo(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, index) => !Object.is(value, old.deps[index]))) slots[i] = { value: fn(), deps }; return slots[i].value; }, useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
  };
  const jsx = (type, props) => ({ type, props });
  class AgentApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const globals = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (options.journalFails && key.includes('prompt-executions')) throw Error('storage unavailable'); storage.set(key, value); }, removeItem: key => storage.delete(key) },
    window: { innerWidth: 1200, innerHeight: 900, addEventListener: (key, fn) => { if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(fn); }, removeEventListener: (key, fn) => listeners.get(key)?.delete(fn) }, location: { origin: 'http://isolated.test' }, document: { activeElement: null, body: {}, getElementById: () => null }, crypto: { randomUUID: () => `direct-${++uuid}` }, setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: key => timers.delete(key), requestAnimationFrame: fn => { fn(); return 1; }, Image: class { naturalWidth = 64; naturalHeight = 64; async decode() {} } };
  const submission = evaluate(submissionJs, {}, globals);
  const api = {
    conversation: async id => { reads.push(id); return latest.get(id); },
    updateConversation: async (id, body) => { const value = { ...latest.get(id), revision: 14, conversation: { ...latest.get(id).conversation, activeRoundId: body.activeRoundId } }; latest.set(id, value); return value; },
    executePrompt: (id, payload) => { const reply = deferred(); direct.push({ id, payload, ...reply }); return reply.promise; },
    promptExecutionReceipt: (id, conversationId) => { const reply = deferred(); receipts.push({ id, conversationId, ...reply }); return reply.promise; },
    submit: (id, payload) => { const reply = deferred(); submissions.push({ id, payload, ...reply }); return reply.promise; },
  };
  const base = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../api/agentClient': { agentApi: api, AgentApiError, getAgentConfig: async () => config, watchAgentRequest: (id, onSnapshot) => { watchers.push({ id, onSnapshot }); return () => {}; } }, '../../utils/playground/agentAssistantBlocks': blocks, '../../utils/playground/agentSubmission': submission, '../../utils/localPreferences': { readLocalPreferences: () => ({ persistInputOnRestart: true }) } };
  const runState = evaluate(runStateJs, base, globals);
  const deps = { ...base, 'react-dom': { createPortal: value => value }, 'lucide-react': new Proxy({}, { get: (_, key) => key }), '../../hooks/useModalFocus': { useModalFocus: () => ({ containerRef: {}, handleModalKeyDown() {} }) }, './useAgentConversations': { useAgentConversations: () => ({ rows: [], refresh() {}, upsert() {}, remove() {} }) }, './useAgentScroll': { useAgentScroll: () => () => {} }, './useAgentRunState': runState, '../../api/client': { api: {}, mediaUrl: path => `/media/${path}` }, '../../utils/playground/agentConversationState': conversation, '../../utils/playground/agentImageReferences': references, '../../utils/compatibleRecipe': compatible, '../../utils/agentGalleryBridge': bridge, '../../utils/agentInputPreferences': inputPreferences, '../../utils/clipboard': {}, './AgentMarkdown': { AgentMarkdown: 'markdown' }, './AgentReferencePicker': { AgentReferencePicker: 'picker' }, './AgentImageOptions': { __esModule: true, default: 'image-options' }, '../gallery/SizeDialog': { __esModule: true, default: 'size-dialog' }, './AgentWorkspace.css': {}, './AgentResponseDetails': { AgentResponseDetails: 'response-details' }, './AgentImageRetryButton': { __esModule: true, default: 'image-retry' } };
  const Component = evaluate(workspaceJs, deps, globals).default;
  const render = () => { cursor = 0; dirty = false; tree = Component({ active: true, onOpenSettings() {}, onLibraryChanged() {}, onOpenJob() {}, onJobsChanged: () => updates.push(true), ...props }); effects.splice(0).forEach(fn => fn()); };
  const flush = async () => { for (let i = 0; i < 30; i++) { if (dirty && !unmounted) render(); await Promise.resolve(); } };
  const unmount = () => { if (unmounted) return; unmounted = true; slots.forEach(slot => slot?.cleanup?.()); };
  render(); t.after(unmount);
  return { direct, receipts, submissions, watchers, updates, reads, storage, submission, AgentApiError, latest, flush, unmount, node: (type, label) => nodes(tree).find(node => node.type === type && (!label || node.props['aria-label'] === label))?.props, nodes: () => nodes(tree), text: () => text(tree), update(next) { props = { ...props, ...next }; render(); }, setConfig(next) { config = { ...config, ...next }; listeners.get('ipl:agent-config-changed')?.forEach(fn => fn()); }, get late() { return late; }, get uuidCount() { return uuid; } };
}

test('production direct click freezes the selected Prompt identity, Gallery image settings and role order without a text POST', async t => {
  const h = harness(t); await h.flush();
  assert.equal(h.node('button', '用选定提示词生成').disabled, false);
  assert.match(h.text(), /本次图片参数：3 张 · gallery-image · 1536x1024 · high · webp · opaque · 压缩 0/);
  assert.match(h.text(), /1\. 主要图片2\. 辅助 · 风格/);
  const click = h.node('button', '用选定提示词生成').onClick; click(); click(); await h.flush();
  assert.equal(h.direct.length, 1); assert.equal(h.submissions.length, 0);
  const body = h.direct[0].payload;
  assert.deepEqual(body, { requestId: 'direct-1', expectedRevision: 12, branchRoundId: 'r1', taskId: 'task', taskRevision: 7, promptVersionId: 'selected', configRevision: 4, imageConfig: { profileId: 'image-gallery', model: 'gallery-image' }, params, imageCount: 3, confirmed: true });
  assert.equal(Object.hasOwn(body, 'prompt'), false); assert.equal(Object.hasOwn(body, 'refs'), false);
  const frozen = JSON.parse(h.storage.get('ipl.agent.pending-prompt-executions.v1'))[0]; assert.deepEqual(frozen.payload, body);
  h.update({ galleryImageSettings: { provider: 'openai_compatible', profileId: 'other', model: 'changed', params: { ...params, size: '1024x1024' }, count: 1 } }); await h.flush();
  assert.deepEqual(h.direct[0].payload, body);
  h.direct[0].resolve(receipt(body)); await h.flush();
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Unsent draft\n  keep exact');
  assert.equal(h.node('button', '持续生图模式')['aria-pressed'], false);
  assert.equal(h.submission.readPendingPromptExecutions({ getItem: key => h.storage.get(key) }).length, 0);
  const card = h.node('section', '已确认配方生成记录'); assert.ok(card); assert.match(text(card.children), /按已确认配方生成，未经过额外文字规划/);
  assert.ok(h.nodes().some(node => node.type === 'p' && node.props.className === 'agent-original-text' && node.props.children === selectedText));
});

test('production optimization uses the chosen raw Prompt, normal text only and preserves the entire unsent draft', async t => {
  const h = harness(t); await h.flush();
  h.node('button', '继续优化选定提示词').onClick(); await h.flush();
  assert.equal(h.direct.length, 0); assert.equal(h.submissions.length, 1);
  const payload = h.submissions[0].payload;
  assert.ok(payload.prompt.endsWith(selectedText)); assert.doesNotMatch(payload.prompt, /Never automatically/);
  assert.deepEqual(payload.authorization, { scope: 'this_request', allowImageGeneration: false, allowWebSearch: false, maxToolRounds: 5, maxImageJobs: 0 });
  assert.equal(payload.taskRevision, 7); assert.equal(payload.contextScope, 'task');
  const frozen = JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1'))[0]; assert.equal(frozen.preserveDraft, true);
  h.submissions[0].resolve({ ...snapshot(), revision: 13, request: { id: payload.requestId, conversationId: 'current', roundId: 'r1', state: 'completed', authorization: { maxImageJobs: 0 } } }); await h.flush();
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Unsent draft\n  keep exact');
  assert.equal(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current.refs[0].reference.uploadId, 'composer-only');
  assert.equal(h.node('button', '持续生图模式')['aria-pressed'], false);
});

test('a lost direct acknowledgement retains its immutable identity and all later checks are GET-only', async t => {
  const h = harness(t); await h.flush();
  h.node('button', '用选定提示词生成').onClick(); await h.flush(); const body = h.direct[0].payload;
  h.direct[0].reject(new TypeError('network reset')); await h.flush();
  assert.match(h.text(), /结果尚未确认/); assert.equal(h.direct.length, 1);
  h.node('button', '检查本次直接生成状态').onClick(); await h.flush();
  assert.equal(h.receipts[0].id, body.requestId); assert.equal(h.receipts[0].conversationId, 'current');
  h.receipts[0].reject(new h.AgentApiError(404, 'not_found', '尚未找到原请求')); await h.flush();
  h.node('button', '检查本次直接生成状态').onClick(); await h.flush();
  assert.equal(h.receipts[1].id, body.requestId); assert.equal(h.direct.length, 1); assert.equal(h.uuidCount, 1);
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-prompt-executions.v1'))[0].payload, body);
});

test('refresh restores the frozen direct journal and reads one receipt without replaying a POST', async t => {
  const first = harness(t); await first.flush(); first.node('button', '用选定提示词生成').onClick(); await first.flush();
  const body = first.direct[0].payload; first.direct[0].reject(Error('lost')); await first.flush(); first.unmount();
  const second = harness(t, { storage: first.storage }); await second.flush();
  assert.equal(second.direct.length, 0); assert.equal(second.receipts.length, 1); assert.equal(second.receipts[0].id, body.requestId);
  second.receipts[0].resolve(receipt(body)); await second.flush();
  assert.equal(second.direct.length, 0); assert.equal(second.node('textarea', 'Agent 消息').value, 'Unsent draft\n  keep exact');
  assert.deepEqual(JSON.parse(second.storage.get('ipl.agent.pending-prompt-executions.v1')), []);
});

test('late direct acceptance after switching conversations clears only its journal and cannot replace the selected task', async t => {
  const h = harness(t); await h.flush(); h.node('button', '用选定提示词生成').onClick(); await h.flush();
  h.update({ focusConversationId: 'next', focusToken: 1 }); await h.flush();
  h.direct[0].resolve(receipt(h.direct[0].payload)); await h.flush();
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Next conversation draft'); assert.equal(h.node('section', '已确认配方生成记录'), undefined);
  const saved = JSON.parse(h.storage.get('ipl.agent.drafts.v1')); assert.equal(saved.current.text, 'Unsent draft\n  keep exact'); assert.equal(saved.next.text, 'Next conversation draft');
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-prompt-executions.v1')), []);
});

test('late accepted direct receipt after unmount never changes React state', async t => {
  const h = harness(t); await h.flush(); h.node('button', '用选定提示词生成').onClick(); await h.flush(); h.unmount();
  h.direct[0].resolve(receipt(h.direct[0].payload)); await h.flush();
  assert.equal(h.late, 0); assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-prompt-executions.v1')), []);
});

test('a receipt for a prior branch cannot replace a later selected branch in the same conversation', async t => {
  const value = snapshot(); value.conversation.rounds.push({ ...value.conversation.rounds[0], id: 'sibling', requestId: 'sibling-request', index: 1 });
  const h = harness(t, { snapshot: value }); await h.flush(); h.node('button', '用选定提示词生成').onClick(); await h.flush();
  const body = h.direct[0].payload; h.direct[0].reject(Error('lost')); await h.flush();
  h.node('button', '下一分支').onClick(); await h.flush();
  h.node('button', '检查本次直接生成状态').onClick(); await h.flush();
  const late = receipt(body, value); late.conversation.activeRoundId = 'sibling';
  h.receipts[0].resolve(late); await h.flush();
  assert.equal(h.node('section', '已确认配方生成记录'), undefined);
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Unsent draft\n  keep exact');
  assert.ok(h.reads.length >= 2, 'the current selected branch is refreshed by GET'); assert.equal(h.direct.length, 1);
});

test('another tab with the same durable pending identity can only read the first tab receipt', async t => {
  const first = harness(t); await first.flush(); const second = harness(t, { storage: first.storage }); await second.flush();
  const staleSecondClick = second.node('button', '用选定提示词生成').onClick;
  first.node('button', '用选定提示词生成').onClick(); await first.flush();
  staleSecondClick(); staleSecondClick(); await second.flush();
  assert.equal(first.direct.length, 1); assert.equal(second.direct.length, 0); assert.equal(second.receipts.length, 1);
  assert.equal(second.receipts[0].id, first.direct[0].payload.requestId); assert.equal(second.uuidCount, 0);
  const accepted = receipt(first.direct[0].payload); first.direct[0].resolve(accepted); second.receipts[0].resolve(accepted); await first.flush(); await second.flush();
  assert.equal(first.direct.length + second.direct.length, 1); assert.equal(second.node('textarea', 'Agent 消息').value, 'Unsent draft\n  keep exact');
});

test('explicit direct execution preserves an already enabled sustained image mode and the unsent search choice', async t => {
  const storage = new Map([['ipl.agent.active-conversation', 'current'], ['ipl.agent.image-mode.v1.current', 'true']]);
  const h = harness(t, { storage }); await h.flush();
  h.node('button', '生图设置').onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 400, bottom: 430 }) } }); await h.flush();
  h.node('input', '本轮允许网络搜索').onChange({ target: { checked: true } }); await h.flush();
  h.node('button', '关闭 Agent 面板').onClick(); await h.flush();
  h.node('button', '用选定提示词生成').onClick(); await h.flush();
  const accepted = receipt(h.direct[0].payload); accepted.request.state = 'completed'; h.direct[0].resolve(accepted); await h.flush();
  assert.equal(h.node('button', '持续生图模式')['aria-pressed'], true); assert.equal(storage.get('ipl.agent.image-mode.v1.current'), 'true');
  assert.ok(h.node('button', '取消本轮搜索授权')); assert.equal(h.submissions.length, 0);
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Unsent draft\n  keep exact');
});

test('frozen direct journal identities cannot be overwritten or multiplied for the same conversation', () => {
  const submission = evaluate(submissionJs, {}), map = new Map(), storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
  const payload = { requestId: 'stable', expectedRevision: 1, branchRoundId: 'r1', taskId: 'task', taskRevision: 1, promptVersionId: 'selected', configRevision: 1, imageConfig: { model: 'original-model' }, params, imageCount: 1, confirmed: true };
  submission.savePendingPromptExecution(storage, { conversationId: 'current', payload });
  assert.throws(() => submission.savePendingPromptExecution(storage, { conversationId: 'current', payload: { ...payload, imageCount: 3 } }), /冻结配方不能改变/);
  assert.throws(() => submission.savePendingPromptExecution(storage, { conversationId: 'current', payload: { ...payload, requestId: 'second' } }), /尚未确认的直接生成/);
  assert.equal(submission.readPendingPromptExecutions(storage).length, 1); assert.deepEqual(submission.readPendingPromptExecutions(storage)[0].payload, payload);
});

test('native direct execution keeps native settings and reports its Responses image protocol honestly', async t => {
  const h = harness(t, { config: { config: { apiConfigMode: 'native', imageModel: 'native-tool-model', maxImageJobs: 10, maxToolRounds: 5 } }, props: { galleryImageSettings: undefined } }); await h.flush();
  h.node('button', '用选定提示词生成').onClick(); await h.flush();
  assert.deepEqual(h.direct[0].payload.imageConfig, { profileId: null, model: 'native-tool-model' }); assert.equal(h.direct[0].payload.imageCount, 1);
  h.direct[0].resolve(receipt(h.direct[0].payload, snapshot(), 'native')); await h.flush();
  const card = text(h.node('section', '已确认配方生成记录').children);
  assert.match(card, /原生 Responses 图片协议，本次仍有图片请求/); assert.doesNotMatch(card, /0.*Responses|零.*请求/);
  assert.equal(h.submissions.length, 0); assert.equal(h.node('button', '持续生图模式')['aria-pressed'], false);
});

test('unconfirmed candidates, incomplete task data, missing images and disabled modes cannot trigger direct execution', async t => {
  for (const extra of [{ taskContext: { ...snapshot().taskContext, selectedPromptVersionId: null } }, { taskContext: { ...snapshot().taskContext, completeness: 'partial', unresolvedItems: ['待确认'] } }, { images: snapshot().images.map(row => ({ ...row, status: 'removed' })) }]) {
    const h = harness(t, { snapshot: snapshot('current', extra) }); await h.flush();
    const button = h.node('button', '用选定提示词生成'); assert.ok(!button || button.disabled);
    button?.onClick(); await h.flush(); assert.equal(h.direct.length, 0); assert.equal(h.submissions.length, 0);
  }
  const off = harness(t, { config: { config: { apiConfigMode: 'off', maxToolRounds: 5, maxImageJobs: 10 } } }); await off.flush();
  assert.equal(off.node('button', '用选定提示词生成').disabled, true);
  assert.match(off.text(), /Current API 尚无已验证的直接执行路径/); assert.doesNotMatch(off.text(), /请先.*开启生图模式/);
});

test('history evidence dependencies do not block a user confirming the selected full Prompt and role-bound references as the complete recipe', async t => {
  const taskContext = { ...snapshot().taskContext, completeness: 'history_required', historyDependencies: [{ roundId: 'r1', reason: 'unreconciled_user_addition' }] };
  const h = harness(t, { snapshot: snapshot('current', { taskContext }) }); await h.flush();
  assert.equal(h.node('button', '用选定提示词生成').disabled, false);
  assert.match(h.text(), /作为当前完整配方/); assert.match(h.text(), /不会自动加入聊天历史或额外约束/);
  h.node('button', '用选定提示词生成').onClick(); await h.flush();
  assert.equal(h.direct.length, 1); assert.equal(h.direct[0].payload.confirmed, true);
  assert.equal(h.direct[0].payload.promptVersionId, 'selected'); assert.equal(Object.hasOwn(h.direct[0].payload, 'constraints'), false);
  assert.deepEqual(taskContext.historyDependencies, [{ roundId: 'r1', reason: 'unreconciled_user_addition' }]);
});

test('required legacy evidence, changed-target ambiguity and masks remain blocked before a direct API call', async t => {
  for (const reason of ['legacy_context_missing', 'legacy_requirements_in_history', 'target_changed_requires_prior_evidence']) {
    const taskContext = { ...snapshot().taskContext, completeness: 'history_required', historyDependencies: [{ roundId: 'r1', reason }] };
    const h = harness(t, { snapshot: snapshot('current', { taskContext }) }); await h.flush();
    assert.equal(h.node('button', '用选定提示词生成').disabled, true); h.node('button', '用选定提示词生成').onClick(); await h.flush();
    assert.equal(h.direct.length, 0); assert.match(h.text(), /仍需核对必要历史证据/);
  }
  const value = snapshot(); value.conversation.rounds[0].maskImageId = 'mask';
  const masked = harness(t, { snapshot: value }); await masked.flush(); assert.equal(masked.node('button', '用选定提示词生成').disabled, true);
  assert.match(masked.text(), /暂不支持带蒙版配方/);
});

test('automatic size uses the selected Prompt and recipe target dimensions rather than unsent composer text or attachments', async t => {
  const value = snapshot(); value.taskContext.promptVersions[1].text = '  Selected scene, aspect ratio 16:9.\n';
  const h = harness(t, { snapshot: value, props: { galleryImageSettings: { provider: 'openai_compatible', profileId: 'image-gallery', model: 'gallery-image', params: { ...params, size: 'auto' }, count: 3, sizeMode: 'auto4k' } } }); await h.flush();
  const expected = compatible.resolveAuto4k(value.taskContext.promptVersions[1].text, { width: 1200, height: 800 }).size;
  assert.match(h.text(), new RegExp(`本次图片参数：3 张 · gallery-image · ${expected}`));
  h.node('button', '用选定提示词生成').onClick(); await h.flush();
  assert.equal(h.direct[0].payload.params.size, expected); assert.equal(h.direct[0].payload.promptVersionId, 'selected');
});

test('journal failure stops before the direct POST and a known rejection releases its entry without clearing the draft', async t => {
  const blocked = harness(t, { journalFails: true }); await blocked.flush(); blocked.node('button', '用选定提示词生成').onClick(); await blocked.flush();
  assert.equal(blocked.direct.length, 0); assert.match(blocked.text(), /尚未发送/);
  const h = harness(t); await h.flush(); h.node('button', '用选定提示词生成').onClick(); await h.flush();
  h.direct[0].reject(new h.AgentApiError(409, 'task_revision_conflict', '任务已改变')); await h.flush();
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-prompt-executions.v1')), []); assert.equal(h.direct.length, 1);
  assert.equal(h.node('textarea', 'Agent 消息').value, 'Unsent draft\n  keep exact');
});

test('production execution API uses its dedicated POST and read-only receipt paths with no Prompt overwrite', async () => {
  const calls = [];
  const { agentApi } = evaluate(await compile('../frontend/src/api/agentClient.ts'), { './agentProgress': {} }, { fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(snapshot()), { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
  const payload = { requestId: 'request / 1', expectedRevision: 12, branchRoundId: 'r1', taskId: 'task', taskRevision: 7, promptVersionId: 'selected', configRevision: 4, imageConfig: { model: 'native' }, params, imageCount: 1, confirmed: true };
  await agentApi.executePrompt('chat / 1', payload); await agentApi.promptExecutionReceipt(payload.requestId, 'chat / 1');
  assert.equal(calls.length, 2); assert.equal(calls[0].url, '/api/agent/conversations/chat%20%2F%201/prompt-executions'); assert.equal(calls[0].init.method, 'POST'); assert.deepEqual(JSON.parse(calls[0].init.body), payload);
  assert.equal(calls[1].url, '/api/agent/prompt-executions/request%20%2F%201?conversation_id=chat%20%2F%201'); assert.equal(calls[1].init.body, undefined);
});
