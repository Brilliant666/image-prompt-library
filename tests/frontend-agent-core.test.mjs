import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

async function compile(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
}
function instantiate(js, deps, globals = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(name => {
    assert.ok(name in deps, `unmocked dependency: ${name}`); return deps[name];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
const markdownJs = await compile('../frontend/src/components/agent/AgentMarkdown.tsx');
const { AgentMarkdown } = instantiate(markdownJs, {
  'react/jsx-runtime': jsxRuntime, 'react-markdown': { __esModule: true, default: ReactMarkdown },
  'remark-gfm': { __esModule: true, default: remarkGfm }, 'remark-math': { __esModule: true, default: remarkMath },
  'rehype-katex': { __esModule: true, default: rehypeKatex }, 'katex/dist/katex.min.css': {},
});
const html = text => renderToStaticMarkup(React.createElement(AgentMarkdown, { text }));
test('actual Agent markdown renders inline/display math and preserves code and ordinary Markdown', () => {
  const output = html('**Answer** $x^2$\n\n$$\n\\frac{a}{b}\n$$\n\n`$not_math$`');
  assert.match(output, /<strong>Answer<\/strong>/);
  assert.match(output, /class="katex"/);
  assert.match(output, /class="katex-display"/);
  assert.match(output, /<math /);
  assert.match(output, /<code>\$not_math\$<\/code>/);
});
test('actual Agent math keeps malformed/unfinished math readable without allowing HTML or remote images', () => {
  const output = html('bad $\\notACommand{x}$ and unfinished $x\n\n<script>alert(1)</script>\n\n![remote](https://untrusted.test/a.png)\n\n$\\includegraphics{https://untrusted.test/math.png}$\n\n$\\href{javascript:alert(1)}{x}$');
  assert.ok(output.includes('notACommand'));
  assert.match(output, /unfinished \$x/);
  assert.doesNotMatch(output, /<script|<img|href="javascript:|src="https:/);
  assert.match(output, /图片链接/);
});
test('math macros cannot leak between messages, and excessive expansion is bounded', () => {
  html('$\\gdef\\persisted{SECRET}\\persisted$');
  assert.doesNotMatch(html('$\\persisted$'), /SECRET/);
  assert.match(html('$\\def\\loop{\\loop}\\loop$'), /katex-error/);
});

const listJs = await compile('../frontend/src/components/agent/useAgentConversations.ts');
const scrollJs = await compile('../frontend/src/components/agent/useAgentScroll.ts');
const workspaceJs = await compile('../frontend/src/components/agent/AgentWorkspace.tsx');
const submissionJs = await compile('../frontend/src/utils/playground/agentSubmission.ts');
const inputPreferencesJs = await compile('../frontend/src/utils/agentInputPreferences.ts');
const conversationState = instantiate(await compile('../frontend/src/utils/playground/agentConversationState.ts'), {});
const assistantBlocks = instantiate(await compile('../frontend/src/utils/playground/agentAssistantBlocks.ts'), {});
const imageReferences = instantiate(await compile('../frontend/src/utils/playground/agentImageReferences.ts'), {});
const compatibleRecipe = instantiate(await compile('../frontend/src/utils/compatibleRecipe.ts'), {});
const galleryBridge = instantiate(await compile('../frontend/src/utils/agentGalleryBridge.ts'), {});
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(t, options = {}) {
  const slots = [], effects = [], timers = new Map(), calls = [], listeners = new Map(), scrollFrames = new Map(), scrollObservers = [];
  const submissions = [], creations = [], requestReads = [], watchers = [], profileChanges = [], panelFocusCalls = [], settingsOpens = [];
  const jobReads = [], jobReplies = [], conversationReads = [], conversationUpdates = [], imageDecodes = [];
  const root = { inert: false };
  const storage = new Map([['ipl.agent.active-conversation', options.activeId === null ? null : 'current']]);
  if (options.inputPreferences) storage.set('ipl.agent.input-preferences.v1', JSON.stringify(options.inputPreferences));
  if (options.pending) storage.set('ipl.agent.pending-submissions.v1', JSON.stringify(options.pending));
  let cursor = 0, dirty = false, tree, timerId = 0, unmounted = false, late = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { if (unmounted) late++; slots[i] = typeof value === 'function' ? value(slots[i]) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } },
    useMemo(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
  };
  const jsx = (type, props) => ({ type, props });
  const globalMocks = {
    setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id),
    window: { innerWidth: 1280, innerHeight: 900, addEventListener: (name, cb) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(cb); }, removeEventListener: (name, cb) => listeners.get(name)?.delete(cb), dispatchEvent: event => { listeners.get(event.type)?.forEach(cb => cb(event)); return true; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    location: { origin: 'http://isolated.test' },
    document: { activeElement: null, body: {}, getElementById: id => id === 'root' ? root : null },
    crypto: { randomUUID: () => `request-${submissions.length}-${creations.length}` }, requestAnimationFrame: callback => { if (options.scrollNodes) { scrollFrames.set(++timerId, callback); return timerId; } callback(); return 1; }, cancelAnimationFrame: id => scrollFrames.delete(id),
    ResizeObserver: class { constructor(callback) { this.callback = callback; scrollObservers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    Image: class { naturalWidth = 1200; naturalHeight = 1800; decode() { const reply = deferred(); imageDecodes.push({ image: this, ...reply }); return reply.promise; } },
  };
  let configReads = 0;
  let config = { revision: 1, config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: false }, ready: true, issues: [], imageReady: false, imageIssues: [{ message: '图片配置已移除' }], profiles: [], capabilities: { maxInputImages: 4 } };
  const snapshot = { conversation: { id: 'current', title: 'Open conversation', rounds: [], messages: [] }, revision: 1, request: null, jobs: [], images: [], ...options.snapshot };
  const snapshots = new Map([['current', snapshot], ...Object.entries(options.snapshots || {})]);
  const agentApi = {
    conversations(cursor, signal, query) { const reply = deferred(); calls.push({ cursor, signal, query, ...reply }); return reply.promise; },
    conversation: async id => { conversationReads.push(id); return options.conversation?.(id) ?? snapshots.get(id) ?? { ...snapshot, conversation: { ...snapshot.conversation, id } }; },
    updateConversation: async (id, body) => { conversationUpdates.push({ id, body }); const current = snapshots.get(id) || snapshot; const value = { ...current, revision: current.revision + 1, conversation: { ...current.conversation, id, activeRoundId: body.activeRoundId } }; snapshots.set(id, value); return options.updateConversation?.(id, body) ?? value; },
    submit(conversationId, payload) { const reply = deferred(); submissions.push({ conversationId, payload, ...reply }); return reply.promise; },
    createConversation() { const reply = deferred(); creations.push(reply); return reply.promise; },
    request(id) { const reply = deferred(); requestReads.push({ id, ...reply }); return reply.promise; },
  };
  class AgentApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const client = { AgentApiError, agentApi, getAgentConfig: async () => { configReads++; return config; }, watchAgentRequest(id, next, error, useSse) { const watcher = { id, next, error, useSse, stopped: false }; watchers.push(watcher); return () => { watcher.stopped = true; }; } };
  const submission = instantiate(submissionJs, {}, globalMocks);
  const inputPreferences = instantiate(inputPreferencesJs, {}, globalMocks);
  const list = instantiate(listJs, { react: hooks, '../../api/agentClient': client }, globalMocks);
  const scroll = instantiate(scrollJs, { react: hooks }, globalMocks);
  const deps = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    'react-dom': { createPortal: node => node },
    '../../hooks/useModalFocus': { useModalFocus: close => ({ containerRef: { current: { querySelector: selector => { assert.equal(selector, '[data-agent-panel-close]'); return { focus: options => panelFocusCalls.push(options) }; } } }, handleModalKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } } }) },
    '../../api/client': { api: { generationJob(id) { jobReads.push(id); return jobReplies.length ? jobReplies.shift().promise : Promise.resolve(options.jobs?.[id] || snapshot.jobs.find(job => job.id === id)); } }, mediaUrl: p => p }, '../../api/agentClient': client,
    './AgentResponseDetails': { AgentResponseDetails: 'response-details' }, './useAgentConversations': list, './useAgentScroll': scroll, './AgentMarkdown': { AgentMarkdown: 'markdown' }, './AgentWorkspace.css': {},
    '../../utils/playground/agentConversationState': conversationState,
    '../../utils/playground/agentAssistantBlocks': assistantBlocks,
    '../../utils/playground/agentImageReferences': imageReferences,
    '../../utils/playground/agentSubmission': {
      ...submission,
      readAgentDrafts: () => ({ [options.activeId === null ? 'new' : 'current']: { text: 'Keep my draft', refs: [{ reference: { kind: 'upload', uploadId: 'u1' }, url: 'http://isolated.test/img.png', label: 'original.png' }], params: { size: 'auto', quality: 'auto', output_format: 'png', background: 'auto' }, editId: null, origin: 'send', ...options.draft }, ...options.drafts }),
    },
    '../../utils/compatibleRecipe': compatibleRecipe,
    '../../utils/agentGalleryBridge': galleryBridge,
    './AgentImageOptions': { __esModule: true, default: 'image-options' }, '../gallery/SizeDialog': { __esModule: true, default: 'size-dialog' },
    '../../utils/localPreferences': { readLocalPreferences: () => ({ persistInputOnRestart: true }) },
    '../../utils/agentInputPreferences': inputPreferences,
    '../../utils/clipboard': {}, './AgentReferencePicker': { AgentReferencePicker: 'reference-picker' },
  };
  const Component = instantiate(workspaceJs, deps, globalMocks).default;
  let active = true;
  let props = { ...options.props };
  const render = () => {
    dirty = false; cursor = 0; tree = Component({ active, onOpenSettings() { settingsOpens.push({ rootInert: root.inert, portalPresent: nodes(tree).some(node => node.props?.id === 'agent-chat-panel') }); }, onProfileChange: value => profileChanges.push(value), ...props });
    if (options.scrollNodes) {
      const region = nodes(tree).find(node => node.props?.['aria-label'] === '对话消息');
      const content = nodes(tree).find(node => node.props?.className === 'agent-content-column' && node.props.ref);
      if (region) region.props.ref.current = options.scrollNodes.container;
      if (content) content.props.ref.current = options.scrollNodes.content;
    }
    effects.splice(0).forEach(fn => fn());
  };
  const flush = async (runTimers = true) => { for (let i = 0; i < 16; i++) { if (dirty && !unmounted) render(); const frames = [...scrollFrames.values()]; scrollFrames.clear(); frames.forEach(fn => fn()); if (runTimers) { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()); } await Promise.resolve(); } };
  const find = (type, predicate = () => true) => nodes(tree).filter(n => n.type === type && predicate(n.props)).map(n => n.props);
  const open = async label => { find('button', p => p['aria-label'] === label)[0].onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 300, top: 500, bottom: 535 }) } }); await flush(); };
  const close = async () => { find('button', p => p['aria-label'] === '关闭 Agent 面板')[0].onClick(); await flush(); };
  const unmount = () => { if (unmounted) return; unmounted = true; slots.forEach(slot => slot?.cleanup?.()); };
  render(); t.after(unmount);
  return { calls, find, open, close, root, profileChanges, panelFocusCalls, settingsOpens, flush, unmount, submissions, creations, requestReads, watchers, snapshot, storage, AgentApiError, inputPreferences, jobReads, conversationReads, conversationUpdates, imageDecodes, scrollObservers,
    updateProps(next) { props = { ...props, ...next }; render(); }, queueJobRead() { const reply = deferred(); jobReplies.push(reply); return reply; },
    resultCard() { const card = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'ResultCard'); assert.ok(card, 'actual result card should be rendered'); const savedCursor = cursor; cursor = slots.length; const content = card.type(card.props); cursor = savedCursor; return nodes(content); },
    setConfig(value) { config = { ...config, ...value }; }, show() { active = true; render(); }, get late() { return late; }, get pendingTimers() { return timers.size; }, get configReads() { return configReads; }, hide() { active = false; render(); } };
}
const row = id => ({ id, title: `Title ${id}`, updatedAt: 10, roundCount: 2 });
const result = (ids, nextCursor = null) => ({ conversations: ids.map(row), nextCursor });

test('actual workspace bottom button follows delayed result geometry without sending or changing draft and references', async t => {
  function node() {
    const listeners = new Map();
    return { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); }, emit(name, event = {}) { listeners.get(name)?.forEach(fn => fn(event)); }, querySelectorAll() { return []; } };
  }
  const container = { ...node(), scrollTop: 0, scrollHeight: 5000, clientHeight: 600, scrollTo({ top, behavior }) { if (behavior !== 'smooth') { this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)); this.emit('scroll'); } } };
  const content = node();
  const h = harness(t, { scrollNodes: { container, content } }); await h.flush();
  const originalDraft = h.storage.get('ipl.agent.drafts.v1');
  assert.equal(container.scrollTop, 4400, 'loaded conversation is positioned at its tail');
  container.emit('wheel', { deltaY: -100 }); container.scrollTop = 100; container.emit('scroll');
  h.find('button', p => p['aria-label'] === '滚动到最新消息')[0].onClick(); await h.flush();
  container.scrollHeight = 6800;
  h.scrollObservers.filter(observer => !observer.disconnected).forEach(observer => observer.callback()); await h.flush();
  assert.equal(container.scrollTop, 6200);
  container.scrollHeight = 7200; content.emit('load'); await h.flush();
  assert.equal(container.scrollTop, 6600, 'a second late image is included after the same single click');
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.equal(h.find('img')[0].src, 'http://isolated.test/img.png');
  assert.equal(h.storage.get('ipl.agent.drafts.v1'), originalDraft);
  assert.equal(h.submissions.length, 0); assert.equal(h.requestReads.length, 0);
});

test('actual message scroll activity expires and is cleared on conversation change, hide and unmount without touching drafts', async t => {
  const h = harness(t); await h.flush(); h.calls[0].resolve(result(['next'])); await h.flush();
  const messages = () => h.find('div', p => p['aria-label'] === '对话消息')[0];
  const visible = () => messages().className.includes('is-scrolling');
  assert.equal(messages().role, 'region'); assert.equal(messages().tabIndex, 0);
  assert.equal(visible(), false);
  messages().onScroll(); await h.flush(false);
  assert.equal(visible(), true); assert.equal(h.pendingTimers, 1);
  messages().onScroll(); await h.flush(false);
  assert.equal(h.pendingTimers, 1, 'continued scrolling replaces the previous idle timer');
  await h.flush(); assert.equal(visible(), false);
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.equal(h.find('img')[0].src, 'http://isolated.test/img.png');
  messages().onScroll(); await h.flush(false); h.hide(); await h.flush(false);
  assert.equal(h.pendingTimers, 0); assert.equal(visible(), false);
  messages().onScroll(); await h.flush(false); assert.equal(h.pendingTimers, 0);
  h.show(); await h.flush(); messages().onScroll(); await h.flush(false);
  h.find('button', p => p.className === 'agent-conversation-link')[0].onClick(); await h.flush(false);
  assert.equal(visible(), false); assert.equal(h.pendingTimers, 0);
  assert.equal(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current.text, 'Keep my draft');
  messages().onScroll(); await h.flush(false); h.unmount(); await h.flush();
  assert.equal(h.pendingTimers, 0); assert.equal(h.late, 0); assert.equal(h.submissions.length, 0);
});

test('actual workspace searches remote history with pagination while preserving open draft and attachments', async t => {
  const h = harness(t); await h.flush(); h.calls[0].resolve(result(['recent'])); await h.flush();
  h.find('input', p => p['aria-label'] === '搜索会话')[0].onChange({ target: { value: 'needle in answer' } }); await h.flush();
  assert.equal(h.calls[1].query, 'needle in answer');
  h.calls[1].resolve(result(['older-with-answer'], '100')); await h.flush();
  assert.equal(h.find('button', p => p.className === 'agent-conversation-link').length, 1);
  assert.match(JSON.stringify(h.find('nav')[0]), /older-with-answer/);
  h.find('button', p => p.children === '加载更多会话')[0].onClick(); await h.flush();
  assert.equal(h.calls[2].query, 'needle in answer'); assert.equal(h.calls[2].cursor, '100');
  h.calls[2].resolve(result(['even-older'])); await h.flush();
  assert.equal(h.find('button', p => p.className === 'agent-conversation-link').length, 2);
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.equal(h.find('img')[0].src, 'http://isolated.test/img.png');
  assert.equal(h.configReads, 1);
  assert.equal(h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].disabled, false);
  await h.open('本轮选项');
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].disabled, true);
  await h.close();
  // Loading a selected conversation uses the same applySnapshot callback as
  // background polling: neither may collapse the server-filtered result window.
  h.find('button', p => p.className === 'agent-conversation-link')[0].onClick(); await h.flush();
  assert.equal(h.find('button', p => p.className === 'agent-conversation-link').length, 2);
  assert.equal(h.calls.length, 3);
  assert.equal(h.find('button', p => p.children === '会话已更新，刷新搜索结果').length, 1);

});
test('actual workspace ignores stale search/page responses after query change, hide and unmount', async t => {
  const h = harness(t); await h.flush(); h.calls[0].resolve(result(['first'], '100')); await h.flush();
  h.find('button', p => p.children === '加载更多会话')[0].onClick(); await h.flush();
  h.find('input', p => p['aria-label'] === '搜索会话')[0].onChange({ target: { value: 'A' } }); await h.flush();
  h.find('input', p => p['aria-label'] === '搜索会话')[0].onChange({ target: { value: 'B' } }); await h.flush();
  h.calls[3].resolve(result(['B'])); await h.flush(); h.calls[2].resolve(result(['A'])); h.calls[1].reject(Error('obsolete page')); await h.flush();
  assert.match(JSON.stringify(h.find('nav')[0]), /Title B/); assert.doesNotMatch(JSON.stringify(h.find('nav')[0]), /Title A/);
  assert.equal(h.find('p', p => p.role === 'alert').length, 0);
  h.find('input', p => p['aria-label'] === '搜索会话')[0].onChange({ target: { value: 'C' } }); await h.flush(); h.hide(); h.calls[4].resolve(result(['C'])); await h.flush();
  h.unmount(); await h.flush(); assert.equal(h.late, 0);
});
test('conversation API URL encodes query and cursor and makes one read-only request', async () => {
  const js = await compile('../frontend/src/api/agentClient.ts'); const requests = [];
  const { agentApi } = instantiate(js, {}, { fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => result([]) }; } });
  await agentApi.conversations('100', undefined, '  A%_ &词  ');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/agent/conversations?limit=100&cursor=100&q=A%25_%20%26%E8%AF%8D');
  assert.equal(requests[0].init.method, undefined);
});


test('reactivating the actual workspace revokes an invalid image permission without losing text or references', async t => {
  const h = harness(t); h.setConfig({ imageReady: true, imageIssues: [] }); await h.flush();
  h.hide(); h.show(); await h.flush();
  await h.open('本轮选项');
  h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].onChange({ target: { checked: true } }); await h.flush();
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].checked, true);
  h.hide(); h.setConfig({ imageReady: false, imageIssues: [{ message: 'Removed image profile' }] }); h.show(); await h.flush();
  await h.open('本轮选项');
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].checked, false);
  assert.equal(h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].disabled, false);
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.equal(h.find('img')[0].src, 'http://isolated.test/img.png');
});

const params = { size: '1536x1024', quality: 'max', background: 'transparent', output_format: 'webp', output_compression: 0 };
const savedDraft = h => JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current;
function keyEvent(extra = {}) {
  const event = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  return event;
}

test('Agent defaults are independent of Gallery and the actual composer sends on Enter but protects Shift and IME', async t => {
  const h = harness(t); await h.flush();
  const galleryKey = 'image-prompt-library.local-preferences.v1';
  const galleryPreferences = JSON.stringify({ enterSubmit: false, clearInputAfterSubmit: false });
  h.storage.set(galleryKey, galleryPreferences);
  assert.deepEqual(h.inputPreferences.readAgentInputPreferences(), { enterSubmit: true, clearInputAfterSubmit: true });
  for (const event of [keyEvent({ shiftKey: true }), keyEvent({ nativeEvent: { isComposing: true, keyCode: 13 } }), keyEvent({ nativeEvent: { isComposing: false, keyCode: 229 } })]) {
    h.find('textarea')[0].onKeyDown(event); await h.flush();
    assert.equal(event.prevented, false); assert.equal(h.submissions.length, 0);
  }
  const enter = keyEvent(); h.find('textarea')[0].onKeyDown(enter); await h.flush();
  assert.equal(enter.prevented, true); assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].payload.prompt, 'Keep my draft');
  h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('textarea')[0].value, '');
  h.inputPreferences.saveAgentInputPreferences({ enterSubmit: false, clearInputAfterSubmit: false }); await h.flush();
  assert.equal(h.storage.get(galleryKey), galleryPreferences);
  assert.match(JSON.stringify(h.find('p', p => p.className === 'agent-input-hint')), /Ctrl\+Enter/);
  h.find('textarea')[0].onChange({ target: { value: 'Next', selectionStart: 4 } }); await h.flush();
  const plain = keyEvent(); h.find('textarea')[0].onKeyDown(plain); await h.flush(); assert.equal(plain.prevented, false);
  h.find('textarea')[0].onKeyDown(keyEvent({ ctrlKey: true })); await h.flush();
  assert.equal(h.submissions.length, 2); h.submissions[1].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('textarea')[0].value, 'Next');
});

test('accepted Agent submission clears text and references while retaining every image parameter', async t => {
  const h = harness(t, { draft: { text: '  exact prompt\n\n', params } }); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.find('textarea')[0].disabled, true);
  await h.open('本轮选项');
  assert.equal(h.find('image-options')[0].disabled, true);
  await h.close();
  assert.equal(h.find('button', p => p.title === '移除参考图')[0].disabled, true);
  assert.equal(h.submissions[0].payload.prompt, '  exact prompt\n\n');
  assert.deepEqual(h.submissions[0].payload.params, params);
  h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('textarea')[0].disabled, false);
  assert.equal(h.find('textarea')[0].value, ''); assert.equal(h.find('img').length, 0);
  assert.deepEqual(savedDraft(h), { text: '', refs: [], params, editId: null, origin: 'send' });
  // Subsequent conversation/state reads cannot clear the next message.
  h.find('textarea')[0].onChange({ target: { value: 'Next draft', selectionStart: 10 } }); await h.flush();
  h.hide(); h.show(); await h.flush(); assert.equal(h.find('textarea')[0].value, 'Next draft');
});

test('a late acceptance cannot clear a newer draft from an already queued composer or picker callback', async t => {
  const h = harness(t, { draft: { params } }); await h.flush();
  await h.open('添加图片或引用');
  h.find('button', p => p.title === '从 Library 或画廊选择图片')[0].onClick(); await h.flush();
  const edit = h.find('textarea')[0].onChange;
  const pick = h.find('reference-picker')[0].onSelect;
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  edit({ target: { value: 'Newer accepted text', selectionStart: 19 } });
  pick([{ reference: { kind: 'upload', uploadId: 'u2' }, url: 'http://isolated.test/new.png', label: 'new.png' }]);
  await h.flush(); h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('textarea')[0].value, 'Newer accepted text');
  assert.deepEqual(h.find('img').map(p => p.src), ['http://isolated.test/img.png', 'http://isolated.test/new.png']);
  assert.deepEqual(savedDraft(h).params, params);
});

test('explicit rejection and an unknown submission retain the draft, and read-only reconciliation preserves parameters', async t => {
  const h = harness(t, { draft: { params } }); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  h.submissions[0].reject(new h.AgentApiError(422, 'Invalid configuration')); await h.flush();
  assert.equal(h.find('textarea')[0].value, 'Keep my draft'); assert.equal(h.find('textarea')[0].disabled, false);
  assert.equal(h.find('img').length, 1); assert.deepEqual(savedDraft(h).params, params);
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  h.submissions[1].reject(Error('network lost')); await h.flush();
  assert.equal(h.find('textarea')[0].value, 'Keep my draft'); assert.equal(h.find('textarea')[0].disabled, true);
  assert.equal(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')).length, 1);
  h.find('button', p => p.children === '检查原请求状态')[0].onClick(); await h.flush();
  assert.equal(h.requestReads.length, 1); assert.equal(h.submissions.length, 2);
  assert.equal(h.requestReads[0].id, h.submissions[1].payload.requestId);
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('textarea')[0].value, ''); assert.equal(h.find('textarea')[0].disabled, false);
  assert.deepEqual(savedDraft(h).params, params); assert.equal(h.submissions.length, 2);
});

test('selected conversation must load before button or Enter can submit, and a failed load retains its draft', async t => {
  const detail = deferred();
  let reply = detail.promise;
  const h = harness(t, { conversation: () => reply }); await h.flush();
  const send = () => h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0];
  assert.equal(send().disabled, true, 'configuration readiness must not unlock an unloaded conversation');
  send().onClick(); h.find('textarea')[0].onKeyDown(keyEvent()); await h.flush();
  assert.equal(h.creations.length, 0); assert.equal(h.submissions.length, 0);
  detail.reject(Error('Conversation could not load')); await h.flush();
  assert.equal(send().disabled, true);
  send().onClick(); h.find('textarea')[0].onKeyDown(keyEvent()); await h.flush();
  assert.equal(h.creations.length, 0); assert.equal(h.submissions.length, 0);
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.deepEqual(h.find('img').map(p => p.src), ['http://isolated.test/img.png']);
  reply = { ...h.snapshot, revision: 7, conversation: { ...h.snapshot.conversation, activeRoundId: 'existing-leaf' } };
  h.find('button', p => p['aria-label'] === '重试读取当前会话')[0].onClick(); await h.flush();
  assert.equal(send().disabled, false);
  send().onClick(); await h.flush();
  assert.equal(h.creations.length, 0); assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].conversationId, 'current');
  assert.equal(h.submissions[0].payload.parentRoundId, 'existing-leaf');
  assert.equal(h.submissions[0].payload.expectedRevision, 7);
  assert.equal(h.submissions[0].payload.prompt, 'Keep my draft');
  assert.deepEqual(h.submissions[0].payload.refs, [{ kind: 'upload', uploadId: 'u1' }]);
  h.submissions[0].resolve(reply); await h.flush();
});

test('late conversation details cannot select a different conversation or update an unmounted workspace', async t => {
  for (const mode of ['switch', 'unmount']) {
    const original = deferred();
    const h = harness(t, { conversation: id => id === 'current' ? original.promise : undefined }); await h.flush();
    if (mode === 'switch') {
      h.calls[0].resolve(result(['next'])); await h.flush();
      h.find('button', p => p.className === 'agent-conversation-link')[0].onClick(); await h.flush();
    } else h.unmount();
    original.resolve(h.snapshot); await h.flush();
    assert.equal(h.late, 0);
    if (mode === 'switch') {
      assert.equal(h.storage.get('ipl.agent.active-conversation'), 'next');
      assert.equal(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current.text, 'Keep my draft');
      assert.equal(h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].disabled, true, 'the other conversation has no draft');
    }
    assert.equal(h.creations.length, 0); assert.equal(h.submissions.length, 0);
  }
});

test('confirming an uncertain request consumes both one-request permissions before the next message', async t => {
  const h = harness(t); await h.flush();
  h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
  h.hide(); h.show(); await h.flush(); await h.open('本轮选项');
  h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].onChange({ target: { checked: true } });
  h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange({ target: { checked: true } });
  await h.flush(); await h.close();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, true);
  assert.equal(h.submissions[0].payload.authorization.allowWebSearch, true);
  h.submissions[0].reject(Error('response lost')); await h.flush();
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮图片授权').length, 0);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 0);
  h.find('textarea')[0].onChange({ target: { value: 'Just a text question', selectionStart: 20 } }); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.creations.length, 0); assert.equal(h.submissions.length, 2);
  assert.equal(h.submissions[1].payload.authorization.allowImageGeneration, false);
  assert.equal(h.submissions[1].payload.authorization.allowWebSearch, false);
  assert.equal(h.submissions[1].payload.authorization.maxImageJobs, 0);
  h.submissions[1].resolve(h.snapshot); await h.flush();
});

test('a late receipt does not revoke a newer explicit permission or clear its draft and reference', async t => {
  for (const recover of [false, true]) {
    const h = harness(t); await h.flush();
    h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
    h.hide(); h.show(); await h.flush(); await h.open('本轮选项');
    const imagePermission = h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].onChange;
    const searchPermission = h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange;
    imagePermission({ target: { checked: true } }); searchPermission({ target: { checked: true } }); await h.flush(); await h.close();
    const edit = h.find('textarea')[0].onChange;
    h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
    if (recover) {
      h.submissions[0].reject(Error('response lost')); await h.flush();
      h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
    }
    // A callback already queued before the disabled state rendered still owns
    // the next draft; a receipt must only consume the submitted choice.
    edit({ target: { value: 'Newer draft', selectionStart: 11 } });
    imagePermission({ target: { checked: false } }); searchPermission({ target: { checked: false } });
    imagePermission({ target: { checked: true } }); searchPermission({ target: { checked: true } }); await h.flush();
    (recover ? h.requestReads[0] : h.submissions[0]).resolve(h.snapshot); await h.flush();
    assert.equal(h.find('textarea')[0].value, 'Newer draft');
    assert.deepEqual(h.find('img').map(p => p.src), ['http://isolated.test/img.png']);
    assert.equal(h.find('button', p => p['aria-label'] === '取消本轮图片授权').length, 1);
    assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 1);
    h.unmount();
  }
});

test('renewing only image permission while receipt reconciliation is pending still consumes the earlier search permission', async t => {
  const h = harness(t); await h.flush();
  h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
  h.hide(); h.show(); await h.flush(); await h.open('本轮选项');
  const imagePermission = h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].onChange;
  imagePermission({ target: { checked: true } });
  h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange({ target: { checked: true } }); await h.flush(); await h.close();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  h.submissions[0].reject(Error('response lost')); await h.flush();
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
  imagePermission({ target: { checked: false } }); imagePermission({ target: { checked: true } }); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮图片授权').length, 1);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 0);
});

test('uncertain reconciliation uses the original send boundary for edits and permissions queued before checking', async t => {
  for (const renewed of ['images', 'both']) {
    const h = harness(t); await h.flush();
    h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
    h.hide(); h.show(); await h.flush(); await h.open('本轮选项');
    const imagePermission = h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].onChange;
    const searchPermission = h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange;
    imagePermission({ target: { checked: true } }); searchPermission({ target: { checked: true } }); await h.flush(); await h.close();
    const edit = h.find('textarea')[0].onChange;
    h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick();
    // These callbacks were queued before the pending/disabled render. Their
    // revisions belong to the next draft, before the user checks the receipt.
    edit({ target: { value: 'Newer draft before confirmation', selectionStart: 31 } });
    imagePermission({ target: { checked: false } }); imagePermission({ target: { checked: true } });
    if (renewed === 'both') { searchPermission({ target: { checked: false } }); searchPermission({ target: { checked: true } }); }
    await h.flush();
    h.submissions[0].reject(Error('response lost')); await h.flush();
    assert.equal(h.find('textarea')[0].value, 'Newer draft before confirmation');
    h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
    h.requestReads[0].resolve(h.snapshot); await h.flush();
    assert.equal(h.find('textarea')[0].value, 'Newer draft before confirmation');
    assert.deepEqual(h.find('img').map(p => p.src), ['http://isolated.test/img.png']);
    assert.equal(h.find('button', p => p['aria-label'] === '取消本轮图片授权').length, 1);
    assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, renewed === 'both' ? 1 : 0);
    assert.equal(h.submissions.length, 1); assert.equal(h.requestReads.length, 1);
    h.unmount();
  }
});

test('restored uncertain submissions acknowledge their frozen draft without restoring tool permissions', async t => {
  const entry = { conversationId: 'current', payload: { requestId: 'restored-uncertain', expectedRevision: 1, parentRoundId: null, origin: 'send', prompt: 'Frozen prompt', refs: [{ kind: 'upload', uploadId: 'u1' }], params, configRevision: 1, activeProfileId: null, authorization: { scope: 'this_request', allowImageGeneration: true, allowWebSearch: true, maxImageJobs: 1, maxToolRounds: 5 } } };
  const h = harness(t, { pending: [entry] }); await h.flush();
  assert.equal(h.find('textarea')[0].value, 'Frozen prompt');
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('textarea')[0].value, '');
  assert.deepEqual(savedDraft(h).refs, []); assert.deepEqual(savedDraft(h).params, params);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮图片授权').length, 0);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 0);
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
  assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0);
});

test('initial conversation creation visibly locks input and failure preserves the original unsent draft', async t => {
  const h = harness(t, { activeId: null, draft: { params } }); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.creations.length, 1); assert.equal(h.submissions.length, 0);
  assert.equal(h.find('textarea')[0].disabled, true);
  assert.equal(h.find('button', p => p['aria-label'] === '添加图片或引用')[0].disabled, true);
  h.creations[0].reject(Error('local storage unavailable')); await h.flush();
  assert.equal(h.find('textarea')[0].disabled, false); assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).new.params, params);
});

test('actual progress callback updates streamed text and historical model information without clearing the next draft or references', async t => {
  const h = harness(t, { draft: { params } });
  h.setConfig({ config: { apiConfigMode: 'hybrid', textModel: 'current-C', textProfileId: 'provider-c', maxToolRounds: 5, maxImageJobs: 2 }, profiles: [{ id: 'provider-c', display_name: 'Current provider C' }], capabilities: { maxInputImages: 4, progressTransport: 'sse' } });
  await h.flush(); h.hide(); h.show(); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  const running = {
    ...h.snapshot, revision: 2,
    request: { id: h.submissions[0].payload.requestId, state: 'running', usage: { responseStepsStarted: 1, imageJobsCreated: 0 }, authorization: { maxToolRounds: 5, maxImageJobs: 0 }, toolCalls: [] },
    conversation: { ...h.snapshot.conversation, activeRoundId: 'r1', rounds: [{ id: 'r1', parentRoundId: null, index: 1, prompt: 'Keep my draft', status: 'running', inputImageIds: [], outputTaskIds: [], requestId: h.submissions[0].payload.requestId, assistantMessageId: 'a1', modelInfo: { requestedModel: 'historical-A', providerName: 'Historical provider A', returnedModels: [] } }], messages: [{ id: 'a1', role: 'assistant', roundId: 'r1', content: '' }] },
  };
  h.submissions[0].resolve(running); await h.flush();
  assert.equal(h.watchers.length, 1); assert.equal(h.watchers[0].useSse, true);
  assert.equal(h.find('textarea')[0].disabled, false);
  h.find('textarea')[0].onChange({ target: { value: 'Next draft while streaming', selectionStart: 26 } });
  await h.flush(); await h.open('添加图片或引用'); h.find('button', p => p.title === '从 Library 或画廊选择图片')[0].onClick(); await h.flush();
  h.find('reference-picker')[0].onSelect([{ reference: { kind: 'upload', uploadId: 'next' }, url: 'http://isolated.test/next.png', label: 'next.png' }]); await h.flush();
  const update = { ...running, revision: 3, conversation: { ...running.conversation, rounds: [{ ...running.conversation.rounds[0], modelInfo: { ...running.conversation.rounds[0].modelInfo, returnedModels: ['returned-B'] } }], messages: [{ ...running.conversation.messages[0], content: 'A partial streamed answer' }] } };
  h.watchers[0].next(update); await h.flush();
  assert.equal(h.find('markdown')[0].text, 'A partial streamed answer');
  await h.open('查看第 1 轮详情');
  const details = JSON.stringify(h.find('response-details')[0].modelInfo);
  assert.match(details, /historical-A/); assert.match(details, /returned-B/); assert.doesNotMatch(details, /current-C/);
  assert.match(JSON.stringify(h.find('button', p => p['aria-label'] === '当前模型与供应商')), /current-C/);
  assert.equal(h.find('div', p => p.className === 'agent-current-model').length, 0);
  await h.close();
  assert.equal(h.find('textarea')[0].value, 'Next draft while streaming');
  assert.deepEqual(h.find('img').map(p => p.src), ['http://isolated.test/next.png']);
  assert.deepEqual(savedDraft(h).params, params);
  h.watchers[0].next({ ...update, revision: 4, request: { ...update.request, state: 'completed' } }); await h.flush();
  assert.equal(h.find('textarea')[0].value, 'Next draft while streaming');
  assert.equal(h.find('img')[0].src, 'http://isolated.test/next.png');
  assert.equal(h.watchers[0].stopped, true); assert.equal(h.submissions.length, 1);
});

test('actual options open, close and cancel preserve draft and parameters without implicitly authorizing any calls', async t => {
  const h = harness(t, { draft: { params } }); await h.flush();
  h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', textModel: 'text-model', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
  h.hide(); h.show(); await h.flush();
  const before = savedDraft(h);
  await h.open('本轮选项');
  assert.equal(h.root.inert, true);
  for (const input of h.find('input', p => p.type === 'checkbox')) assert.equal(input.checked, false);
  h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].onChange({ target: { checked: true } });
  h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange({ target: { checked: true } }); await h.flush();
  h.find('input', p => p['aria-label'] === '本轮图片上限')[0].onChange({ target: { value: '2' } }); await h.flush();
  const escape = { key: 'Escape', preventDefault() {}, stopPropagation() {} };
  h.find('div', p => p.role === 'dialog')[0].onKeyDown(escape); await h.flush();
  assert.equal(h.root.inert, false);
  assert.equal(h.find('div', p => p.role === 'dialog').length, 0);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮图片授权').length, 1);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 1);
  await h.open('本轮选项');
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].checked, true);
  assert.equal(h.find('input', p => p['aria-label'] === '本轮图片上限')[0].value, 2);
  const backdrop = h.find('div', p => p.className === 'agent-popover-layer')[0];
  const target = {}; backdrop.onMouseDown({ target, currentTarget: target }); await h.flush();
  h.find('button', p => p['aria-label'] === '取消本轮图片授权')[0].onClick(); await h.flush();
  assert.deepEqual(savedDraft(h), before);
  await h.open('本轮选项');
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].checked, false);
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].checked, true);
  await h.close();
  assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0); assert.equal(h.requestReads.length, 0);
  assert.equal(h.find('textarea')[0].value, before.text);
  assert.deepEqual(h.find('img').map(p => p.src), ['http://isolated.test/img.png']);
});

test('typing @ keeps the actual composer editable without opening a modal or stealing its focus', async t => {
  const h = harness(t, { draft: { params } }); await h.flush();
  h.find('textarea')[0].onChange({ target: { value: 'hello@', selectionStart: 6 } }); await h.flush();
  assert.equal(h.find('div', p => p['aria-label'] === '图片引用建议').length, 1);
  assert.equal(h.find('div', p => p.role === 'dialog').length, 0); assert.equal(h.root.inert, false);
  assert.equal(h.find('textarea')[0].disabled, false);
  h.find('textarea')[0].onKeyDown(keyEvent({ nativeEvent: { isComposing: true, keyCode: 229 } })); await h.flush();
  h.find('textarea')[0].onChange({ target: { value: 'hello@example.test', selectionStart: 18 } }); await h.flush();
  assert.equal(h.find('textarea')[0].value, 'hello@example.test'); assert.equal(h.submissions.length, 0);
  assert.equal(h.find('div', p => p['aria-label'] === '图片引用建议').length, 0);
  h.find('textarea')[0].onChange({ target: { value: '引用 @', selectionStart: 4 } }); await h.flush();
  const composingEscape = keyEvent({ key: 'Escape', nativeEvent: { isComposing: true, keyCode: 229 } });
  h.find('textarea')[0].onKeyDown(composingEscape); await h.flush();
  assert.equal(composingEscape.prevented, false);
  assert.equal(h.find('div', p => p['aria-label'] === '图片引用建议').length, 1);
  h.find('textarea')[0].onKeyDown({ key: 'Escape', nativeEvent: { isComposing: false, keyCode: 27 }, preventDefault() {}, stopPropagation() {} }); await h.flush();
  assert.equal(h.find('div', p => p['aria-label'] === '图片引用建议').length, 0);
  await h.open('添加图片或引用');
  h.find('button', p => p['aria-label'] === '引用已有图片')[0].onClick(); await h.flush();
  assert.deepEqual(h.panelFocusCalls, [{ preventScroll: true }]);
  assert.equal(h.find('div', p => p.role === 'dialog' && p['aria-label'] === '引用图片').length, 1);
  assert.equal(h.root.inert, true); assert.deepEqual(savedDraft(h).params, params);
  h.find('div', p => p.role === 'dialog')[0].onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); await h.flush();
  assert.equal(h.root.inert, false); assert.equal(h.find('div', p => p.role === 'dialog').length, 0);
});

test('changing the active conversation closes stale panels and inline reference suggestions', async t => {
  const h = harness(t); await h.flush(); h.calls[0].resolve(result(['next', 'third'])); await h.flush();
  await h.open('当前模型与供应商');
  // The same production selection callback can already be queued when a panel
  // opens; its delayed completion must not leave a panel tied to the old thread.
  h.find('button', p => p.className === 'agent-conversation-link')[0].onClick(); await h.flush();
  assert.equal(h.find('div', p => p.role === 'dialog').length, 0); assert.equal(h.root.inert, false);
  h.find('textarea')[0].onChange({ target: { value: '@', selectionStart: 1 } }); await h.flush();
  assert.equal(h.find('div', p => p['aria-label'] === '图片引用建议').length, 1);
  h.find('button', p => p.className === 'agent-conversation-link')[1].onClick(); await h.flush();
  assert.equal(h.find('div', p => p['aria-label'] === '图片引用建议').length, 0);
  assert.equal(JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current.text, 'Keep my draft');
});

test('settings handoff waits for the Agent portal to unmount and release inert before opening the settings drawer', async t => {
  const h = harness(t, { draft: { params } }); await h.flush();
  const before = savedDraft(h);
  for (const [panel, action] of [['当前模型与供应商', '修改 Agent 模型配置'], ['本轮选项', '检查图片配置']]) {
    const count = h.settingsOpens.length;
    await h.open(panel); assert.equal(h.root.inert, true);
    h.find('button', p => p['aria-label'] === action)[0].onClick();
    assert.equal(h.settingsOpens.length, count, 'must not focus the settings drawer inside the still-inert root');
    await h.flush();
    assert.deepEqual(h.settingsOpens.at(-1), { rootInert: false, portalPresent: false });
    assert.equal(h.settingsOpens.length, count + 1);
    assert.deepEqual(savedDraft(h), before);
  }
  assert.equal(h.submissions.length, 0);
});

test('model panel preserves off-mode profile selection and every rendered action has an accessible name', async t => {
  const h = harness(t, { draft: { params } }); await h.flush();
  h.setConfig({ config: { apiConfigMode: 'off', textModel: 'manual-model', maxToolRounds: 5, maxImageJobs: 2 }, profiles: [{ id: 'a', display_name: 'Provider A' }, { id: 'b', display_name: 'Provider B' }] });
  h.hide(); h.show(); await h.flush();
  const before = savedDraft(h);
  for (const label of ['当前模型与供应商', '添加图片或引用', '本轮选项']) {
    await h.open(label);
    for (const button of h.find('button')) assert.ok(button['aria-label']?.trim(), `action without a name: ${JSON.stringify(button)}`);
    await h.close();
  }
  await h.open('当前模型与供应商');
  h.find('select', p => p['aria-label'] === '本轮 API 配置')[0].onChange({ target: { value: 'b' } }); await h.flush();
  assert.match(JSON.stringify(h.find('div', p => p.className === 'agent-model-panel-content')), /Provider B/);
  await h.close(); await h.open('本轮选项');
  assert.equal(h.find('select', p => p['aria-label'] === '本轮 API 配置')[0].value, 'b');
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].checked, false);
  assert.deepEqual(savedDraft(h), before); assert.equal(h.profileChanges.at(-1), 'b'); assert.equal(h.submissions.length, 0);
});

function displaySnapshot(state, extra = {}) {
  return {
    request: { id: 'request-current', state, usage: { responseStepsStarted: 2, imageJobsCreated: 1 }, authorization: { maxToolRounds: 5, maxImageJobs: 2 }, toolCalls: [], ...extra },
    conversation: { id: 'current', title: 'History', activeRoundId: 'r1', rounds: [{ id: 'r1', parentRoundId: null, index: 1, prompt: 'A short message', status: state === 'completed' ? 'done' : 'error', inputImageIds: [], outputTaskIds: [], requestId: 'request-current', assistantMessageId: 'a1', modelInfo: { requestedModel: 'historical-model', providerName: 'Historical provider', returnedModels: ['returned-alias'] } }], messages: [{ id: 'a1', role: 'assistant', roundId: 'r1', content: 'Answer text' }] },
  };
}

test('completed response has compact actions and moves historic provenance and request counts into details', async t => {
  const h = harness(t, { snapshot: displaySnapshot('completed') }); await h.flush();
  assert.equal(h.find('div', p => p.className === 'agent-request-status' || p.className === 'agent-request-attention').length, 0);
  assert.equal(h.find('p', p => p.className === 'agent-live-progress').length, 0);
  const actions = JSON.stringify(h.find('div', p => p.className === 'agent-answer-actions'));
  assert.match(actions, /复制回答/); assert.match(actions, /查看第 1 轮详情/);
  assert.equal(h.find('response-details').length, 0);
  await h.open('查看第 1 轮详情');
  const info = h.find('response-details')[0];
  assert.match(JSON.stringify(info), /historical-model/); assert.match(JSON.stringify(info), /returned-alias/);
  assert.deepEqual(info.request.usage, { responseStepsStarted: 2, imageJobsCreated: 1 });
  assert.deepEqual(info.request.authorization, { maxToolRounds: 5, maxImageJobs: 2 });
  for (const button of h.find('button')) assert.ok(button['aria-label']?.trim());
  await h.close(); assert.equal(h.find('textarea')[0].value, 'Keep my draft');
});

test('actual streamed tool output uses readable captions and renders later structured text without replacing the draft', async t => {
  const base = displaySnapshot('running');
  base.conversation.rounds[0].status = 'running';
  base.conversation.rounds[0].responseOutput = [
    { type: 'message', id: 'before-tool', content: [{ type: 'output_text', text: 'Preparing image.' }] },
    { type: 'function_call', call_id: 'generate-call', name: 'generate_image_batch', status: 'completed' },
  ];
  base.conversation.messages[0].content = 'Preparing image.';
  const h = harness(t, { snapshot: base }); await h.flush();
  assert.equal(h.watchers.length, 1);
  const updated = { ...h.snapshot, ...base, revision: 3, conversation: { ...base.conversation, rounds: [{
    ...base.conversation.rounds[0], responseOutput: [...base.conversation.rounds[0].responseOutput,
      { type: 'function_call_output', call_id: 'generate-call', output: '{}' },
      { type: 'message', id: 'after-tool', content: [{ type: 'output_text', text: 'Image complete, more' }] },
    ],
  }], messages: [{ ...base.conversation.messages[0], content: 'Preparing image.\n\nImage complete, more' }] } };
  h.watchers[0].next(updated); await h.flush();
  assert.deepEqual(h.find('markdown').map(p => p.text), ['Preparing image.', 'Image complete, more']);
  const tool = JSON.stringify(h.find('div', p => p.className === 'agent-tool-status'));
  assert.match(tool, /批量生成图片/);
  assert.doesNotMatch(tool, /generate_image_batch/);
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
});

test('failed and uncertain results retain visible recovery actions outside the details menu', async t => {
  for (const state of ['failed', 'unknown', 'interrupted']) {
    const h = harness(t, { snapshot: displaySnapshot(state, { error: { message: 'Mock failure' }, recoveryReason: 'Check original request', upstreamMayContinue: true, canResume: true }) }); await h.flush();
    const alert = h.find('div', p => p.className === 'agent-request-attention' && p.role === 'alert')[0];
    assert.ok(alert); assert.match(JSON.stringify(alert), /Mock failure/); assert.match(JSON.stringify(alert), /Check original request/); assert.match(JSON.stringify(alert), /计费/);
    assert.equal(h.find('button', p => p['aria-label'] === '继续已确认安全的步骤')[0].disabled, false);
    assert.equal(h.find('div', p => p.role === 'dialog').length, 0);
    assert.equal(h.find('textarea')[0].value, 'Keep my draft'); h.unmount();
  }
});

const imageProfile = id => ({ id, display_name: `Provider ${id}`, model: `gpt-image-${id}`, configured: true });
async function configureImages(h) {
  h.setConfig({ config: { apiConfigMode: 'hybrid', textProfileId: 'text', textModel: 'reasoning-model', imageProfileId: 'image', imageModel: 'gpt-image-configured', maxToolRounds: 5, maxImageJobs: 4 }, profiles: [imageProfile('text'), imageProfile('image'), imageProfile('gallery')], imageReady: true, imageIssues: [] });
  h.hide(); h.show(); await h.flush();
}
const completedJob = (id, metadata = {}) => ({ id, status: 'succeeded', provider: 'openai_compatible', model: 'gpt-image-result', result_path: `http://isolated.test/${id}.png`, metadata, parameters: {}, accepted_image_id: null });
const reference = id => ({ reference: { kind: 'upload', uploadId: id }, url: `http://isolated.test/${id}.png`, label: `${id}.png` });
const allDrafts = h => JSON.parse(h.storage.get('ipl.agent.drafts.v1'));

test('explicit image mode survives accepted and reconciled sends, while search stays single-request and off revokes images', async t => {
  const h = harness(t); await h.flush(); await configureImages(h);
  h.setConfig({ config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 4, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
  h.hide(); h.show(); await h.flush();
  const mode = () => h.find('button', p => p['aria-label'] === '持续生图模式')[0];
  const send = async text => { h.find('textarea')[0].onChange({ target: { value: text, selectionStart: text.length } }); await h.flush(); h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush(); };
  assert.equal(mode()['aria-pressed'], false);
  mode().onClick(); await h.flush(); assert.equal(mode()['aria-pressed'], true); assert.equal(h.submissions.length, 0);
  await h.open('本轮选项');
  const permission = h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0];
  assert.equal(permission.checked, true, 'persistent permission is visibly effective in this request');
  assert.equal(permission.disabled, true, 'persistent permission is controlled by its composer switch');
  assert.ok(h.find('label').some(label => JSON.stringify(label.children).includes('生图模式已授权')));
  h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange({ target: { checked: true } }); await h.flush(); await h.close();
  await send('Image one'); assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, true);
  h.submissions[0].resolve(h.snapshot); await h.flush(); assert.equal(mode()['aria-pressed'], true);
  await send('Image two'); assert.equal(h.submissions[1].payload.authorization.allowImageGeneration, true); assert.equal(h.submissions[1].payload.authorization.allowWebSearch, false);
  h.submissions[1].reject(Error('response lost')); await h.flush();
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush(); h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(mode()['aria-pressed'], true); assert.equal(h.submissions.length, 2);
  mode().onClick(); await h.flush();
  await h.open('本轮选项');
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].checked, false);
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].disabled, false);
  await h.close(); await send('Text only');
  assert.equal(h.submissions[2].payload.authorization.allowImageGeneration, false); assert.equal(h.submissions[2].payload.authorization.maxImageJobs, 0);
  assert.equal(h.submissions[2].payload.authorization.allowWebSearch, false);
  h.submissions[2].resolve(h.snapshot); await h.flush();
});

test('image mode transfers only during first conversation creation, and resets on conversation change and remount', async t => {
  const h = harness(t, { activeId: null }); await h.flush(); await configureImages(h);
  const mode = () => h.find('button', p => p['aria-label'] === '持续生图模式')[0];
  mode().onClick(); await h.flush(); h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.creations.length, 1); h.creations[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, true);
  h.submissions[0].resolve(h.snapshot); await h.flush(); assert.equal(mode()['aria-pressed'], true);
  h.calls.at(-1).resolve(result(['other', 'current'])); await h.flush();
  h.find('button', p => p['aria-label'] === '打开会话 Title other')[0].onClick(); await h.flush(); assert.equal(mode()['aria-pressed'], false);
  h.find('button', p => p['aria-label'] === '打开会话 Title current')[0].onClick(); await h.flush(); assert.equal(mode()['aria-pressed'], false);
  assert.ok(![...h.storage.keys()].some(key => key.includes('image-mode')), 'permission is not persisted');
  const fresh = harness(t); await fresh.flush(); assert.equal(fresh.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
});

test('image mentions show thumbnails and failure status, then attach a deduplicated visual reference without losing draft', async t => {
  const job = completedJob('mention-result'); const snapshot = imageSnapshot(job);
  snapshot.jobs.push({ ...completedJob('failed-result'), status: 'failed', result_path: null });
  snapshot.conversation.rounds[0].outputTaskIds.push('failed-result');
  const h = harness(t, { snapshot, draft: { text: '  Keep spacing\n@', params } }); await h.flush();
  await h.open('添加图片或引用'); h.find('button', p => p['aria-label'] === '引用已有图片')[0].onClick(); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '引用第 1 轮图 2')[0].disabled, true);
  assert.match(JSON.stringify(h.find('button', p => p['aria-label'] === '引用第 1 轮图 2')[0]), /执行失败/);
  assert.equal(h.find('img', p => p.alt === '第 1 轮 · 图 1')[0].src, job.result_path);
  h.find('button', p => p['aria-label'] === '引用第 1 轮图 1')[0].onClick(); await h.flush();
  assert.equal(savedDraft(h).text, '  Keep spacing\n@第1轮图1 '); assert.deepEqual(savedDraft(h).params, params);
  assert.deepEqual(savedDraft(h).refs.map(choice => choice.reference), [{ kind: 'upload', uploadId: 'u1' }, { kind: 'job', jobId: job.id }]);
  assert.ok(h.find('img').some(p => p.src === job.result_path), 'chosen historical image stays visible in composer');
  await h.open('添加图片或引用'); h.find('button', p => p['aria-label'] === '引用已有图片')[0].onClick(); await h.flush();
  h.find('button', p => p['aria-label'] === '引用第 1 轮图 1')[0].onClick(); await h.flush();
  assert.equal(savedDraft(h).refs.length, 2); assert.equal(h.submissions.length, 0);
});

test('reference success notices expire without closing errors or changing text and attachments', async t => {
  const job = completedJob('notice-result'); const h = harness(t, { snapshot: imageSnapshot(job), draft: { params } }); await h.flush();
  h.resultCard().find(node => node.type === 'button' && node.props['aria-label'] === '加入本轮参考图').props.onClick(); await h.flush(false);
  assert.equal(h.find('p', p => p.className === 'agent-notice').length, 1);
  const draft = structuredClone(savedDraft(h)); await h.flush();
  assert.equal(h.find('p', p => p.className === 'agent-notice').length, 0); assert.deepEqual(savedDraft(h), draft);
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  h.submissions[0].reject(new h.AgentApiError(422, 'Keep this error visible')); await h.flush();
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /Keep this error visible/);
});

test('actual workspace explicitly copies Gallery image settings, keeps drafts independent and freezes the per-request selection', async t => {
  const gallery = { provider: 'openai_compatible', profileId: 'gallery', model: 'gpt-image-gallery', params: { ...params, quality: 'medium' } };
  const h = harness(t, { draft: { params }, props: { galleryImageSettings: gallery } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  await h.open('本轮选项');
  assert.deepEqual(savedDraft(h), before, 'opening options must not copy Gallery settings');
  h.find('image-options')[0].onUseGallery(); await h.flush();
  assert.equal(savedDraft(h).text, before.text); assert.deepEqual(savedDraft(h).refs, before.refs);
  assert.deepEqual(savedDraft(h).params, gallery.params);
  assert.deepEqual(savedDraft(h).imageConfig, { profileId: 'gallery', model: 'gpt-image-gallery' });
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].checked, false);
  assert.equal(h.submissions.length, 0);
  h.updateProps({ galleryImageSettings: { ...gallery, model: 'changed-in-gallery', params: { ...params, quality: 'low' } } }); await h.flush();
  assert.deepEqual(savedDraft(h).params, gallery.params); assert.equal(savedDraft(h).imageConfig.model, gallery.model);
  h.find('image-options')[0].onResetSelection(); await h.flush();
  assert.equal(savedDraft(h).imageConfig, undefined); assert.deepEqual(savedDraft(h).params, gallery.params);
  h.find('image-options')[0].onChange({ imageConfig: { profileId: 'image', model: 'manual-image' } }); await h.flush();
  h.find('input', p => p['aria-label'] === '本轮允许生成图片')[0].onChange({ target: { checked: true } }); await h.flush();
  await h.close();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.deepEqual(h.submissions[0].payload.imageConfig, { profileId: 'image', model: 'manual-image' });
  assert.deepEqual(h.submissions[0].payload.refs, before.refs.map(choice => choice.reference));
  assert.equal(h.submissions[0].payload.prompt, before.text); assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, true);
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1'))[0].payload.imageConfig, h.submissions[0].payload.imageConfig);
  h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.deepEqual(savedDraft(h).imageConfig, { profileId: 'image', model: 'manual-image' });
  assert.deepEqual(savedDraft(h).params, gallery.params); assert.equal(savedDraft(h).text, '');
});

test('actual workspace rejects incompatible Gallery settings and changing image options never writes the saved text model', async t => {
  const h = harness(t, { props: { galleryImageSettings: { provider: 'chatgpt', profileId: '', model: 'oauth-model', params } } }); await h.flush(); await configureImages(h);
  const before = savedDraft(h); await h.open('本轮选项');
  h.find('image-options')[0].onUseGallery(); await h.flush(); assert.deepEqual(savedDraft(h), before);
  h.find('image-options')[0].onChange({ imageConfig: { profileId: 'image', model: 'my-image-model' } }); await h.flush();
  assert.equal(h.find('image-options')[0].config.config.textModel, 'reasoning-model');
  assert.equal(h.find('image-options')[0].config.config.imageModel, 'gpt-image-configured');
  assert.equal(h.submissions.length, 0);
});

test('actual workspace size-dialog handoff releases the options modal and resolves auto size from the first image before submission', async t => {
  const h = harness(t, { draft: { params, sizeMode: 'auto4k' } }); await h.flush(); await configureImages(h);
  await h.open('本轮选项'); assert.equal(h.root.inert, true);
  h.find('image-options')[0].onChooseSize(); await h.flush();
  assert.equal(h.find('image-options').length, 0); assert.equal(h.root.inert, false);
  const dialog = h.find('size-dialog')[0]; assert.ok(dialog); assert.equal(dialog.referenceStatus, 'loading');
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 0, 'unknown reference geometry cannot silently fall back to a square');
  for (const decode of h.imageDecodes) { decode.image.naturalWidth = 900; decode.image.naturalHeight = 1600; decode.resolve(); }
  await h.flush(); assert.deepEqual(h.find('size-dialog')[0].referenceSize, { width: 900, height: 1600 });
  h.find('size-dialog')[0].onApply({ size: params.size, size_mode: 'auto4k' }); h.find('size-dialog')[0].onClose(); await h.flush();
  for (const decode of h.imageDecodes) { decode.image.naturalWidth = 900; decode.image.naturalHeight = 1600; decode.resolve(); }
  await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].payload.params.size, compatibleRecipe.resolveAuto4k('Keep my draft', { width: 900, height: 1600 }).size);
  assert.equal(h.submissions[0].payload.params.size_mode, undefined, 'only resolved dimensions go to the image API');
  h.submissions[0].resolve(h.snapshot); await h.flush();
});

function imageSnapshot(job) {
  const value = displaySnapshot('completed');
  value.conversation.rounds[0].outputTaskIds = [job.id];
  return { ...value, jobs: [job], images: [] };
}

test('actual Agent result-card reference button appends once without replacing draft text, parameters or existing references', async t => {
  const job = { ...completedJob('result'), result_width: 1200, result_height: 1800 };
  const h = harness(t, { snapshot: imageSnapshot(job), draft: { params } }); await h.flush();
  const before = savedDraft(h);
  const image = h.resultCard().find(node => node.type === 'img').props;
  assert.equal(image.width, 1200); assert.equal(image.height, 1800, 'known result geometry reserves image space before loading');
  const add = () => h.resultCard().find(node => node.type === 'button' && node.props['aria-label'] === '加入本轮参考图').props.onClick();
  add(); await h.flush();
  assert.equal(savedDraft(h).text, before.text); assert.deepEqual(savedDraft(h).params, before.params);
  assert.deepEqual(savedDraft(h).refs.map(choice => choice.reference), [before.refs[0].reference, { kind: 'job', jobId: 'result' }]);
  add(); await h.flush(); assert.equal(savedDraft(h).refs.length, 2); assert.equal(h.submissions.length, 0);
});

test('actual Agent result-card reference button refuses a full draft without evicting or reordering images', async t => {
  const job = completedJob('result'); const refs = ['one', 'two', 'three', 'four'].map(reference);
  const h = harness(t, { snapshot: imageSnapshot(job), draft: { refs, params } }); await h.flush();
  h.resultCard().find(node => node.type === 'button' && node.props['aria-label'] === '加入本轮参考图').props.onClick(); await h.flush();
  assert.deepEqual(savedDraft(h).refs, refs); assert.equal(savedDraft(h).text, 'Keep my draft'); assert.deepEqual(savedDraft(h).params, params);
  assert.equal(h.submissions.length, 0); assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /最多使用 4 张参考图/);
});

test('Gallery reference handoff rechecks the result then appends to the existing draft without submitting or repeating the handoff', async t => {
  const job = completedJob('gallery-result');
  const h = harness(t, { draft: { params }, jobs: { [job.id]: job } }); await h.flush();
  const before = savedDraft(h);
  h.updateProps({ galleryCommand: { id: 1, job, intent: 'reference' } }); await h.flush();
  assert.deepEqual(h.jobReads, [job.id]); assert.equal(savedDraft(h).text, before.text); assert.deepEqual(savedDraft(h).params, params);
  assert.deepEqual(savedDraft(h).refs.map(choice => choice.reference), [before.refs[0].reference, { kind: 'job', jobId: job.id }]);
  h.hide(); h.show(); await h.flush(); assert.deepEqual(h.jobReads, [job.id]); assert.equal(h.submissions.length, 0);
});

test('Gallery Agent-source handoff selects the precise recorded branch and preserves both source and target drafts', async t => {
  const job = completedJob('from-agent', { agent: { conversationId: 'target', roundId: 'target-first' } });
  const target = { revision: 9, request: null, jobs: [job], images: [], conversation: { id: 'target', title: 'Target', activeRoundId: 'target-second', rounds: [{ id: 'target-first', index: 1, parentRoundId: null, outputTaskIds: [job.id], inputImageIds: [], prompt: 'first', status: 'done' }, { id: 'target-second', index: 2, parentRoundId: 'target-first', outputTaskIds: [], inputImageIds: [], prompt: 'second', status: 'done' }], messages: [] } };
  const targetDraft = { text: 'Unsaved target text', refs: [reference('target-upload')], params, imageConfig: { profileId: 'target-api', model: 'target-model' }, origin: 'send', editId: null };
  const h = harness(t, { jobs: { [job.id]: job }, snapshots: { target }, drafts: { target: targetDraft } }); await h.flush();
  const before = savedDraft(h);
  h.updateProps({ galleryCommand: { id: 2, job, intent: 'reference' } }); await h.flush();
  assert.deepEqual(h.conversationUpdates, [{ id: 'target', body: { expectedRevision: 9, activeRoundId: 'target-first' } }]);
  assert.equal(h.storage.get('ipl.agent.active-conversation'), 'target');
  assert.equal(h.find('textarea')[0].value, 'Unsaved target text');
  assert.deepEqual(allDrafts(h).current, before);
  assert.deepEqual(allDrafts(h).target, { ...targetDraft, refs: [...targetDraft.refs, { reference: { kind: 'job', jobId: job.id }, label: '画廊结果', url: job.result_path }] });
  assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0);
});

test('late Gallery job reads cannot append to a different conversation or revive a hidden workspace', async t => {
  for (const mode of ['switch', 'hide', 'unmount']) {
    const job = completedJob(`late-${mode}`);
    const h = harness(t, { draft: { params } }); await h.flush(); h.calls[0].resolve(result(['next'])); await h.flush();
    const before = savedDraft(h), pending = h.queueJobRead();
    h.updateProps({ galleryCommand: { id: 3, job, intent: 'reference' } }); await h.flush();
    if (mode === 'switch') { h.find('button', p => p.className === 'agent-conversation-link')[0].onClick(); await h.flush(); }
    else if (mode === 'hide') { h.hide(); await h.flush(); }
    else h.unmount();
    pending.resolve(job); await h.flush();
    assert.deepEqual(allDrafts(h).current, before); assert.equal(h.submissions.length, 0);
    if (mode === 'switch') assert.equal(h.find('textarea')[0].value, '');
    assert.equal(h.late, 0, `${mode} must not update an unmounted component`);
  }
});

test('Gallery handoff refuses removed results and full target drafts while retaining every existing reference', async t => {
  for (const mode of ['removed', 'full']) {
    const job = completedJob(mode), refs = ['one', 'two', 'three', 'four'].map(reference);
    const h = harness(t, { jobs: { [job.id]: mode === 'removed' ? { ...job, status: 'discarded', result_path: null } : job }, draft: { params, refs } }); await h.flush();
    const before = savedDraft(h);
    h.updateProps({ galleryCommand: { id: 4, job, intent: 'reference' } }); await h.flush();
    assert.deepEqual(savedDraft(h), before); assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0);
    assert.equal(h.find('p', p => p.role === 'alert').length, 1);
  }
});

test('a delayed Gallery handoff appends after newer text and attachment edits instead of restoring its earlier draft snapshot', async t => {
  const job = completedJob('delayed');
  const h = harness(t, { draft: { params } }); await h.flush();
  const pending = h.queueJobRead(); h.updateProps({ galleryCommand: { id: 10, job, intent: 'reference' } }); await h.flush();
  h.find('textarea')[0].onChange({ target: { value: 'New text typed during handoff', selectionStart: 29 } }); await h.flush();
  await h.open('添加图片或引用'); h.find('button', p => p.title === '从 Library 或画廊选择图片')[0].onClick(); await h.flush();
  h.find('reference-picker')[0].onSelect([reference('new-upload')]); await h.flush();
  pending.resolve(job); await h.flush();
  assert.equal(savedDraft(h).text, 'New text typed during handoff'); assert.deepEqual(savedDraft(h).params, params);
  assert.deepEqual(savedDraft(h).refs.map(choice => choice.reference), [{ kind: 'upload', uploadId: 'u1' }, { kind: 'upload', uploadId: 'new-upload' }, { kind: 'job', jobId: job.id }]);
  assert.equal(h.submissions.length, 0);
});

test('return-to-Agent handoff can locate an image history without adding a reference, but rejects a mismatched recorded round', async t => {
  for (const mismatch of [false, true]) {
    const job = completedJob(`history-${mismatch}`, { agent: { conversationId: 'target', roundId: mismatch ? 'wrong-round' : 'target-first' } });
    const target = { revision: 4, request: null, jobs: [job], images: [], conversation: { id: 'target', title: 'Target', activeRoundId: 'target-first', rounds: [{ id: 'target-first', index: 1, parentRoundId: null, outputTaskIds: [job.id], inputImageIds: [], prompt: 'old', status: 'done' }], messages: [] } };
    const targetDraft = { text: 'Target draft', refs: [reference('target-upload')], params, origin: 'send', editId: null };
    const h = harness(t, { jobs: { [job.id]: { ...job, result_path: null, status: 'discarded' } }, snapshots: { target }, drafts: { target: targetDraft } }); await h.flush();
    const before = savedDraft(h);
    h.updateProps({ galleryCommand: { id: 11, job, intent: 'conversation' } }); await h.flush();
    assert.deepEqual(allDrafts(h).target, targetDraft); assert.deepEqual(allDrafts(h).current, before);
    assert.equal(h.storage.get('ipl.agent.active-conversation'), mismatch ? 'current' : 'target');
    assert.equal(h.find('p', p => p.role === 'alert').length, mismatch ? 1 : 0);
    assert.deepEqual(h.conversationUpdates, []); assert.equal(h.submissions.length, 0);
  }
});

test('an image whose Agent conversation was deleted may still be explicitly added to the current draft', async t => {
  const job = completedJob('orphan', { agent: { conversationId: 'deleted', roundId: 'gone' } });
  let h;
  h = harness(t, { jobs: { [job.id]: job }, draft: { params }, conversation: id => { if (id === 'deleted') return Promise.reject(new h.AgentApiError(404, 'Conversation unavailable')); } }); await h.flush();
  const before = savedDraft(h);
  h.updateProps({ galleryCommand: { id: 12, job, intent: 'reference' } }); await h.flush();
  assert.equal(h.storage.get('ipl.agent.active-conversation'), 'current');
  assert.equal(savedDraft(h).text, before.text); assert.deepEqual(savedDraft(h).params, params);
  assert.deepEqual(savedDraft(h).refs.map(choice => choice.reference), [before.refs[0].reference, { kind: 'job', jobId: job.id }]);
  assert.deepEqual(h.conversationUpdates, []); assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0);
});

test('late reference geometry after hide or unmount cannot update a different visible size preview or clear the draft', async t => {
  for (const mode of ['hide', 'unmount']) {
    const h = harness(t, { draft: { params, sizeMode: 'auto4k' } }); await h.flush();
    const before = savedDraft(h); assert.equal(h.imageDecodes.length, 1);
    if (mode === 'hide') { h.hide(); await h.flush(); } else h.unmount();
    h.imageDecodes[0].resolve(); await h.flush();
    assert.equal(h.late, 0); assert.deepEqual(savedDraft(h), before); assert.equal(h.submissions.length, 0);
  }
});

test('a full source-conversation draft rejects Gallery reference handoff before changing its saved active branch', async t => {
  const job = completedJob('full-target', { agent: { conversationId: 'target', roundId: 'target-first' } });
  const target = { revision: 9, request: null, jobs: [job], images: [], conversation: { id: 'target', title: 'Target', activeRoundId: 'target-second', rounds: [{ id: 'target-first', index: 1, parentRoundId: null, outputTaskIds: [job.id], inputImageIds: [], prompt: 'first', status: 'done' }, { id: 'target-second', index: 2, parentRoundId: 'target-first', outputTaskIds: [], inputImageIds: [], prompt: 'second', status: 'done' }], messages: [] } };
  const targetDraft = { text: 'Full target draft', refs: ['one', 'two', 'three', 'four'].map(reference), params, origin: 'send', editId: null };
  const h = harness(t, { jobs: { [job.id]: job }, snapshots: { target }, drafts: { target: targetDraft } }); await h.flush();
  const before = savedDraft(h);
  h.updateProps({ galleryCommand: { id: 14, job, intent: 'reference' } }); await h.flush();
  assert.deepEqual(allDrafts(h).target, targetDraft); assert.deepEqual(savedDraft(h), before);
  assert.equal(h.storage.get('ipl.agent.active-conversation'), 'current');
  assert.deepEqual(h.conversationUpdates, [], 'rejected image addition must not change the saved branch used by the next request');
  assert.equal(h.submissions.length, 0);
});

test('Gallery handoff cannot change a target conversation branch or frozen draft while that target has an uncertain submission journal', async t => {
  for (const intent of ['reference', 'conversation']) {
    const job = completedJob(`pending-target-${intent}`, { agent: { conversationId: 'target', roundId: 'target-first' } });
    const target = { revision: 9, request: null, jobs: [job], images: [], conversation: { id: 'target', title: 'Target', activeRoundId: 'target-second', rounds: [{ id: 'target-first', index: 1, parentRoundId: null, outputTaskIds: [job.id], inputImageIds: [], prompt: 'first', status: 'done' }, { id: 'target-second', index: 2, parentRoundId: 'target-first', outputTaskIds: [], inputImageIds: [], prompt: 'second', status: 'done' }], messages: [] } };
    const frozen = { conversationId: 'target', payload: { requestId: 'uncertain-target-request', expectedRevision: 9, parentRoundId: 'target-second', origin: 'send', prompt: 'Exact frozen prompt\n\n', refs: [{ kind: 'upload', uploadId: 'target-upload' }], params, configRevision: 1, activeProfileId: null, imageConfig: { profileId: 'image', model: 'frozen-image-model' }, authorization: { scope: 'this_request', allowImageGeneration: true, allowWebSearch: false, maxToolRounds: 5, maxImageJobs: 1 } } };
    const targetDraft = { text: 'Older target draft', refs: [reference('target-upload')], params: { ...params, quality: 'low' }, origin: 'send', editId: null };
    const h = harness(t, { jobs: { [job.id]: job }, snapshots: { target }, drafts: { target: targetDraft }, pending: [frozen] }); await h.flush();
    const before = structuredClone(allDrafts(h)), journalBefore = h.storage.get('ipl.agent.pending-submissions.v1');
    assert.equal(h.find('textarea')[0].disabled, false, 'target journal must not lock the unrelated current draft');
    assert.equal(before.target.text, frozen.payload.prompt, 'target draft is the restored frozen submission');
    h.updateProps({ galleryCommand: { id: 15, job, intent } }); await h.flush();
    assert.deepEqual(h.conversationUpdates, [], 'an unresolved target request cannot have its active branch changed');
    assert.equal(h.storage.get('ipl.agent.active-conversation'), 'current');
    assert.deepEqual(allDrafts(h), before, 'neither target frozen refs nor the current draft can be changed');
    assert.equal(h.storage.get('ipl.agent.pending-submissions.v1'), journalBefore);
    assert.equal(h.submissions.length, 0); assert.equal(h.requestReads.length, 0);
    assert.equal(h.find('p', p => p.role === 'alert').length, 1);
  }
});

test('changing Agent mode from hybrid to native blocks an old image-profile override until explicitly restoring the defaults', async t => {
  const selection = { profileId: 'image', model: 'gpt-image-hybrid-draft' };
  const h = harness(t, { draft: { params, imageConfig: selection } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  h.setConfig({ config: { apiConfigMode: 'native', textProfileId: 'text', textModel: 'native-text-model', imageModel: 'native-tool-model', maxToolRounds: 5, maxImageJobs: 4 }, profiles: [imageProfile('text'), imageProfile('image')], imageReady: true, imageIssues: [] });
  h.hide(); h.show(); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 0, 'an Images API override must never be posted as a native Responses tool selection');
  assert.equal(h.creations.length, 0); assert.deepEqual(savedDraft(h), before);
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /恢复.*默认/);
  assert.equal(h.storage.has('ipl.agent.pending-submissions.v1'), false, 'the local compatibility error does not create an uncertain request');
  await h.open('本轮选项'); h.find('image-options')[0].onResetSelection(); await h.flush(); await h.close();
  assert.equal(savedDraft(h).text, before.text); assert.deepEqual(savedDraft(h).refs, before.refs); assert.deepEqual(savedDraft(h).params, params);
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 1); assert.equal(h.submissions[0].payload.imageConfig, undefined);
  h.submissions[0].resolve(h.snapshot); await h.flush();
});

test('Gallery handoff rechecks capacity after a delayed branch update and never claims success when the picker filled the last slot meanwhile', async t => {
  const job = completedJob('delayed-branch', { agent: { conversationId: 'current', roundId: 'first' } });
  const snapshot = { revision: 9, request: null, jobs: [job], images: [], conversation: { id: 'current', title: 'Current', activeRoundId: 'second', rounds: [{ id: 'first', index: 1, parentRoundId: null, outputTaskIds: [job.id], inputImageIds: [], prompt: 'first', status: 'done' }, { id: 'second', index: 2, parentRoundId: 'first', outputTaskIds: [], inputImageIds: [], prompt: 'second', status: 'done' }], messages: [] } };
  const patch = deferred(), refs = ['one', 'two', 'three'].map(reference);
  const h = harness(t, { snapshot, draft: { text: 'Draft during branch update', refs, params }, updateConversation: () => patch.promise }); await h.flush();
  h.updateProps({ galleryCommand: { id: 17, job, intent: 'reference' } }); await h.flush();
  assert.deepEqual(h.conversationUpdates, [{ id: 'current', body: { expectedRevision: 9, activeRoundId: 'first' } }]);
  await h.open('添加图片或引用'); h.find('button', p => p.title === '从 Library 或画廊选择图片')[0].onClick(); await h.flush();
  h.find('reference-picker')[0].onSelect([reference('four')]); await h.flush();
  const fullDraft = structuredClone(savedDraft(h)); assert.equal(fullDraft.refs.length, 4);
  patch.resolve({ ...snapshot, revision: 10, conversation: { ...snapshot.conversation, activeRoundId: 'first' } }); await h.flush();
  assert.deepEqual(savedDraft(h), fullDraft, 'a delayed handoff cannot displace the newly chosen image or reset text/parameters');
  assert.deepEqual(savedDraft(h).refs, [...refs, reference('four')]);
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /最多|已满|未加入/);
  assert.doesNotMatch(JSON.stringify(h.find('p')), /已带入画廊图片/);
  assert.equal(h.submissions.length, 0);
});

test('initial Gallery reference handoff keeps the new draft visible when a delayed conversation list later arrives', async t => {
  const job = completedJob('first-gallery-handoff');
  const h = harness(t, { activeId: null, jobs: { [job.id]: job }, props: { galleryCommand: { id: 18, job, intent: 'reference' } }, draft: { text: 'New draft kept visible', params } }); await h.flush();
  assert.deepEqual(h.jobReads, [job.id]);
  const beforeList = structuredClone(allDrafts(h).new);
  assert.equal(beforeList.refs.length, 2); assert.equal(h.find('textarea')[0].value, 'New draft kept visible');
  assert.equal(h.storage.get('ipl.agent.active-conversation') ?? null, null);
  h.calls[0].resolve(result(['older-existing-conversation'])); await h.flush();
  assert.equal(h.find('button', p => p.className === 'agent-conversation-link').length, 1);
  assert.equal(h.storage.get('ipl.agent.active-conversation') ?? null, null, 'list arrival cannot steal focus from a Gallery-prepared new draft');
  assert.equal(h.find('textarea')[0].value, 'New draft kept visible');
  assert.deepEqual(allDrafts(h).new, beforeList);
  assert.deepEqual(h.find('img').map(props => props.src), ['http://isolated.test/img.png', job.result_path]);
  assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0); assert.deepEqual(h.conversationReads, []);
});
