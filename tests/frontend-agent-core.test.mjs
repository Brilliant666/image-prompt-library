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
const codeBlockJs = await compile('../frontend/src/components/agent/AgentCodeBlock.tsx');
const clipboardJs = await compile('../frontend/src/utils/clipboard.ts');
const promptBlocks = instantiate(await compile('../frontend/src/utils/playground/agentPromptBlocks.ts'), {});
const { AgentCodeBlock } = instantiate(codeBlockJs, {
  react: React, 'react/jsx-runtime': jsxRuntime,
  'lucide-react': { Copy: () => null, Check: () => null },
  '../../utils/clipboard': { copyTextToClipboard: async () => { throw new Error('Static rendering must not copy'); } },
  './AgentCodeBlock.css': {},
});
const { AgentMarkdown } = instantiate(markdownJs, {
  'react/jsx-runtime': jsxRuntime, 'react-markdown': { __esModule: true, default: ReactMarkdown },
  'remark-gfm': { __esModule: true, default: remarkGfm }, 'remark-math': { __esModule: true, default: remarkMath },
  'rehype-katex': { __esModule: true, default: rehypeKatex }, 'katex/dist/katex.min.css': {},
  './AgentCodeBlock': { AgentCodeBlock },
  '../../utils/playground/agentPromptBlocks': promptBlocks,
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

test('actual markdown offers a separate copy control for each fenced prompt while keeping prose and inline code separate', () => {
  const output = html('原始分析。\n\n```text\n  中文提示词\n\n第二段  \n```\n\n优化说明。\n\n```text\nEnglish prompt.\n```\n\n`inline`');
  assert.equal((output.match(/aria-label="复制提示词"/g) || []).length, 2);
  assert.match(output, /<pre><code class="language-text">  中文提示词\n\n第二段  \n<\/code><\/pre>/);
  assert.match(output, /<p>原始分析。<\/p>/);
  assert.match(output, /<p>优化说明。<\/p>/);
  assert.match(output, /<code>inline<\/code>/);
});

test('actual Markdown gives explicit prompt fences a discoverable plain-text block without converting normal answers or code', () => {
  const output = html('普通分析。\n\n```prompt\nKeep pose.\n```\n\n```plaintext\n换成柔和侧光。\n```\n\n```js\nconst prompt = "Keep pose";\n```\n\n```\nprint("unchanged code")\n```\n\n$x^2$');
  assert.equal((output.match(/class="agent-code-block agent-prompt-block"/g) || []).length, 2);
  assert.equal((output.replace(/<[^>]*>/g, '').match(/提示词 · 纯文本/g) || []).length, 2);
  assert.equal((output.match(/aria-label="复制提示词"/g) || []).length, 2);
  assert.equal((output.match(/aria-label="复制文本"/g) || []).length, 2);
  assert.match(output, /<p>普通分析。<\/p>/); assert.match(output, /class="language-js"/); assert.match(output, /class="katex"/);
});

test('unlabelled fences need an explicit adjacent prompt heading and never inherit a distant prompt topic', () => {
  const output = html('### 优化后的提示词\n\n```\nA portrait with natural light.\n```\n\n下面是普通示例。\n\n```\nfunction example() {}\n```\n\n### Final prompt\n\n```python\nprint("this is code")\n```');
  assert.equal((output.match(/class="agent-code-block agent-prompt-block"/g) || []).length, 1);
  assert.equal((output.match(/aria-label="复制文本"/g) || []).length, 2);
});

test('real Markdown reserves generation and optimization for explicit Prompt fences or adjacent Prompt titles while keeping plain-text copying', () => {
  const generated = [], optimized = [];
  const source = '普通日志。\n\n```text\nINFO request started\n```\n\n```plaintext\nA plain answer example.\n```\n\n```txt\nNot an image recipe.\n```\n\n```prompt\n  Exact image prompt.\n```\n\n### 英文提示词\n\n```text\nA soft-lit portrait.\n```\n\n### Final prompt\n\n```\nKeep the visible texture.\n```\n\n### Final prompt\n\n```python\nprint("still code")\n```';
  const output = renderToStaticMarkup(React.createElement(AgentMarkdown, { text: source, sourceId: 'r1:a1', onGeneratePrompt: value => generated.push(value), onOptimizePrompt: value => optimized.push(value), getGenerationSummary: () => '1 张 · high' }));
  assert.equal((output.match(/aria-label="使用此提示词生成图片"/g) || []).length, 3);
  assert.equal((output.match(/aria-label="继续优化此提示词"/g) || []).length, 3);
  assert.equal((output.match(/aria-label="复制提示词"/g) || []).length, 6);
  assert.equal((output.match(/aria-label="复制文本"/g) || []).length, 1);
  const firstAction = output.indexOf('aria-label="使用此提示词生成图片"');
  assert.ok(firstAction > output.indexOf('Not an image recipe.'));
  assert.match(output, /class="language-python"/); assert.deepEqual(generated, []); assert.deepEqual(optimized, []);
});

test('actual Markdown and copy callbacks preserve source spaces, line endings and streamed text without added newlines', async () => {
  const captured = [];
  const { AgentMarkdown: CaptureMarkdown } = instantiate(markdownJs, {
    'react/jsx-runtime': jsxRuntime, 'react-markdown': { __esModule: true, default: ReactMarkdown },
    'remark-gfm': { __esModule: true, default: remarkGfm }, 'remark-math': { __esModule: true, default: remarkMath },
    'rehype-katex': { __esModule: true, default: rehypeKatex }, 'katex/dist/katex.min.css': {},
    '../../utils/playground/agentPromptBlocks': promptBlocks,
    './AgentCodeBlock': { AgentCodeBlock: props => { captured.push(props); return React.createElement(AgentCodeBlock, props); } },
  });
  const cases = [
    ['```prompt\r\n  Keep pose.\r\n\r\n第二段\t  \r\n```', '  Keep pose.\r\n\r\n第二段\t  \r\n'],
    ['```plaintext\n  Streaming text without a terminal newline', '  Streaming text without a terminal newline'],
    ['```text\nFirst\n\n\n```', 'First\n\n\n'],
    ['```txt\n<literal> & "quotes"\n```', '<literal> & "quotes"\n'],
    ['  ~~~prompt\n    Kept content indent\n  ~~~', '  Kept content indent\n'],
    ['> ```text\r\n> Quoted prompt.\r\n> ```', 'Quoted prompt.\r\n'],
  ];
  const writes = [];
  const jsx = (type, props) => ({ type, props });
  const { AgentCodeBlock: CopyBlock } = instantiate(codeBlockJs, {
    react: { useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect: () => {} },
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': { Copy: 'copy', Check: 'check' },
    '../../utils/clipboard': { copyTextToClipboard: async value => { writes.push(value); return true; } }, './AgentCodeBlock.css': {},
  }, { setTimeout: () => 1, clearTimeout() {} });
  for (const [source, expected] of cases) {
    renderToStaticMarkup(React.createElement(CaptureMarkdown, { text: source }));
    const props = captured.at(-1); assert.equal(props.prompt, true);
    const tree = CopyBlock(props);
    nodes(tree).find(node => node.type === 'pre').props.ref.current = { textContent: 'Wrong renderer fallback\n' };
    nodes(tree).find(node => node.type === 'button').props.onClick(); await Promise.resolve(); await Promise.resolve();
    assert.equal(writes.at(-1), expected);
  }
  assert.deepEqual(writes, cases.map(([, expected]) => expected));
});

test('production code-block callback copies only exact displayed text and retains whitespace; late clipboard receipts do not update an unmounted block', async () => {
  const slots = [], cleanups = [], writes = [], timers = new Map();
  let cursor = 0, tree, timerId = 0, late = 0, unmounted = false;
  const pending = deferred();
  const hooks = {
    useRef(value) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { if (unmounted) late++; slots[index] = next; }]; },
    useEffect(effect) { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanups.push(effect()); } },
  };
  const jsx = (type, props) => ({ type, props });
  const clipboard = instantiate(clipboardJs, {}, { navigator: { clipboard: { writeText: text => { writes.push(text); return writes.length === 1 ? Promise.resolve() : pending.promise; } } } });
  const { AgentCodeBlock: Component } = instantiate(codeBlockJs, {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': { Copy: 'copy', Check: 'check' },
    '../../utils/clipboard': clipboard, './AgentCodeBlock.css': {},
  }, { setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) });
  const text = '  第一段\n\nSecond paragraph  \n\t<literal> & text\n';
  const render = () => { cursor = 0; tree = Component({ children: jsx('code', { children: text }) }); nodes(tree).find(node => node.type === 'pre').props.ref.current = { textContent: text }; };
  render(); nodes(tree).find(node => node.type === 'button').props.onClick(); await Promise.resolve(); await Promise.resolve(); render();
  assert.deepEqual(writes, [text]);
  assert.ok(JSON.stringify(tree).includes('已复制'));
  assert.equal(timers.size, 1);
  nodes(tree).find(node => node.type === 'button').props.onClick();
  unmounted = true; cleanups.forEach(cleanup => cleanup?.()); pending.resolve(true);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(writes, [text, text]); assert.equal(timers.size, 0); assert.equal(late, 0);
});

const listJs = await compile('../frontend/src/components/agent/useAgentConversations.ts');
const scrollJs = await compile('../frontend/src/components/agent/useAgentScroll.ts');
const workspaceJs = await compile('../frontend/src/components/agent/AgentWorkspace.tsx');
const runStateJs = await compile('../frontend/src/components/agent/useAgentRunState.ts');
const progress = instantiate(await compile('../frontend/src/api/agentProgress.ts'), {});
const submissionJs = await compile('../frontend/src/utils/playground/agentSubmission.ts');
const inputPreferencesJs = await compile('../frontend/src/utils/agentInputPreferences.ts');
const conversationState = instantiate(await compile('../frontend/src/utils/playground/agentConversationState.ts'), {});
const assistantBlocks = instantiate(await compile('../frontend/src/utils/playground/agentAssistantBlocks.ts'), {});
const imageReferences = instantiate(await compile('../frontend/src/utils/playground/agentImageReferences.ts'), {});
const compatibleRecipe = instantiate(await compile('../frontend/src/utils/compatibleRecipe.ts'), {});
const galleryBridge = instantiate(await compile('../frontend/src/utils/agentGalleryBridge.ts'), {});
const imageRetry = instantiate(await compile('../frontend/src/utils/playground/agentImageRetry.ts'), {});
const recipeInputs = instantiate(await compile('../frontend/src/utils/recipeInputs.ts'), {});
const imageModeKey = id => `ipl.agent.image-mode.v1.${id}`;
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(t, options = {}) {
  const slots = [], effects = [], timers = new Map(), calls = [], listeners = new Map(), scrollFrames = new Map(), scrollObservers = [];
  const stops = [], resumes = [], jobsChanged = [];
  const submissions = [], creations = [], requestReads = [], watchers = [], profileChanges = [], panelFocusCalls = [], settingsOpens = [], sharedChanges = [];
  const jobReads = [], jobReplies = [], conversationReads = [], conversationUpdates = [], imageDecodes = [], taskUpdates = [], uploads = [], referenceReads = [];
  const root = { inert: false };
  const storage = options.storage || new Map([['ipl.agent.active-conversation', options.activeId === null ? null : 'current']]);
  for (const [id, value] of Object.entries(options.imageModes || {})) storage.set(imageModeKey(id), value);
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
  const jsx = (type, props) => typeof type === 'function' && ['ImageResultProgress', 'RequestFailureCard'].includes(type.name) ? type(props) : ({ type, props });
  const globalMocks = {
    performance: { now: () => options.now?.() ?? 100 },
    fetch: (url, init) => { referenceReads.push([url, init]); return options.fetch?.(url, init) ?? Promise.resolve(new Response(new Blob(['synthetic-image'], { type: 'image/png' }))); },
    setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id),
    window: { innerWidth: 1280, innerHeight: 900, addEventListener: (name, cb) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(cb); }, removeEventListener: (name, cb) => listeners.get(name)?.delete(cb), dispatchEvent: event => { listeners.get(event.type)?.forEach(cb => cb(event)); return true; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (options.imageModeWriteFails && key.startsWith(imageModeKey(''))) throw Error('storage unavailable'); storage.set(key, value); }, removeItem: key => { if (options.imageModeWriteFails && key.startsWith(imageModeKey(''))) throw Error('storage unavailable'); storage.delete(key); } },
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
    stop(id) { const reply = deferred(); stops.push({ id, ...reply }); return reply.promise; },
    resume(id, resumeId) { const reply = deferred(); resumes.push({ id, resumeId, ...reply }); return reply.promise; },
    deleteConversation: async id => options.deleteConversation?.(id),
    upload: async file => { uploads.push(file); return options.upload?.(file) ?? { uploadId: `restored-${uploads.length}`, image: { status: 'available', url: `http://isolated.test/restored-${uploads.length}.png` } }; },
    updateEditingTask: async (id, body) => { taskUpdates.push({ id, body }); return options.updateEditingTask?.(id, body) ?? { ...snapshot, revision: snapshot.revision + 1, editingTask: body.task }; },
    conversations(cursor, signal, query) { const reply = deferred(); calls.push({ cursor, signal, query, ...reply }); return reply.promise; },
    conversation: async id => { conversationReads.push(id); return options.conversation?.(id) ?? snapshots.get(id) ?? { ...snapshot, conversation: { ...snapshot.conversation, id } }; },
    updateConversation: async (id, body) => { conversationUpdates.push({ id, body }); const current = snapshots.get(id) || snapshot; const value = { ...current, revision: current.revision + 1, conversation: { ...current.conversation, id, activeRoundId: body.activeRoundId } }; snapshots.set(id, value); return options.updateConversation?.(id, body) ?? value; },
    submit(conversationId, payload) { const reply = deferred(); submissions.push({ conversationId, payload, ...reply, resolve: value => reply.resolve({ ...value, request: value.request ? { conversationId, roundId: value.conversation.activeRoundId || 'accepted-round', ...value.request } : { id: payload.requestId, conversationId, roundId: value.conversation.activeRoundId || 'accepted-round', state: 'completed' } }) }); return reply.promise; },
    createConversation() { const reply = deferred(); creations.push(reply); return reply.promise; },
    request(id) { const reply = deferred(); requestReads.push({ id, ...reply, resolve: value => reply.resolve({ ...value, request: value.request ? { conversationId: value.conversation.id, roundId: value.conversation.activeRoundId || 'accepted-round', ...value.request } : { id, conversationId: value.conversation.id, roundId: value.conversation.activeRoundId || 'accepted-round', state: 'completed' } }) }); return reply.promise; },
  };
  class AgentApiError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
  const client = { AgentApiError, agentApi, getAgentConfig: async () => { configReads++; return options.getAgentConfig ? options.getAgentConfig() : config; }, watchAgentRequest(id, next, error, useSse) { const watcher = { id, next, error, useSse, stopped: false }; watchers.push(watcher); return () => { watcher.stopped = true; }; } };
  const submission = instantiate(submissionJs, {}, globalMocks);
  const inputPreferences = instantiate(inputPreferencesJs, {}, globalMocks);
  const list = instantiate(listJs, { react: hooks, '../../api/agentClient': client }, globalMocks);
  const scroll = instantiate(scrollJs, { react: hooks }, globalMocks);
  const runState = instantiate(runStateJs, { react: hooks, '../../api/agentClient': client, '../../utils/playground/agentAssistantBlocks': assistantBlocks, '../../utils/playground/agentSubmission': submission, '../../utils/localPreferences': { readLocalPreferences: () => ({ persistInputOnRestart: true }) } }, globalMocks);
  const deps = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    'react-dom': { createPortal: node => node },
    '../../hooks/useModalFocus': { useModalFocus: close => ({ containerRef: { current: { querySelector: selector => { assert.equal(selector, '[data-agent-panel-close]'); return { focus: options => panelFocusCalls.push(options) }; } } }, handleModalKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } } }) },
    '../../api/client': { api: { generationJob(id) { jobReads.push(id); return jobReplies.length ? jobReplies.shift().promise : Promise.resolve(options.jobs?.[id] || snapshot.jobs.find(job => job.id === id)); } }, mediaUrl: p => p }, '../../api/agentClient': client,
    './AgentResponseDetails': { AgentResponseDetails: 'response-details' }, './useAgentConversations': list, './useAgentScroll': scroll, './useAgentRunState': runState, './AgentMarkdown': { AgentMarkdown: 'markdown' }, './AgentWorkspace.css': {},
    '../../utils/playground/agentConversationState': conversationState,
    '../../utils/playground/agentAssistantBlocks': assistantBlocks,
    '../../utils/playground/agentImageReferences': imageReferences,
    '../../utils/playground/agentSubmission': {
      ...submission,
      readAgentDrafts: () => ({ [options.activeId === null ? 'new' : 'current']: { text: 'Keep my draft', refs: [{ reference: { kind: 'upload', uploadId: 'u1' }, url: 'http://isolated.test/img.png', label: 'original.png' }], params: { size: 'auto', quality: 'auto', output_format: 'png', background: 'auto' }, editId: null, origin: 'send', ...options.draft }, ...options.drafts }),
    },
    '../../utils/compatibleRecipe': compatibleRecipe,
    '../../utils/agentGalleryBridge': galleryBridge,
    '../../utils/playground/agentImageRetry': imageRetry,
    '../../utils/recipeInputs': recipeInputs,
    './AgentImageRetryDialog': { __esModule: true, default: 'retry-dialog' },
    './AgentImageRetryButton': { __esModule: true, default: 'retry-button' },
    './AgentEditingTaskDialog': { __esModule: true, default: 'editing-task-dialog' },
    './AgentFailedImageEditDialog': { __esModule: true, default: 'failed-image-edit-dialog' },
    './AgentImageOptions': { __esModule: true, default: 'image-options' }, '../gallery/SizeDialog': { __esModule: true, default: 'size-dialog' },
    '../../utils/localPreferences': { readLocalPreferences: () => ({ persistInputOnRestart: true }) },
    '../../utils/agentInputPreferences': inputPreferences,
    '../../utils/clipboard': {}, '../../utils/imageClipboard': { copyFinalImageToClipboard: async () => { throw Error('Unexpected image copy in this harness'); } }, './AgentReferencePicker': { AgentReferencePicker: 'reference-picker' },
  };
  const Component = instantiate(workspaceJs, deps, globalMocks).default;
  let active = true;
  let props = { ...options.props };
  const render = () => {
    dirty = false; cursor = 0; tree = Component({ active, onJobsChanged: () => jobsChanged.push(true), onOpenSettings() { settingsOpens.push({ rootInert: root.inert, portalPresent: nodes(tree).some(node => node.props?.id === 'agent-chat-panel') }); }, onProfileChange: value => profileChanges.push(value), onGalleryImageSettingsChange(value) { sharedChanges.push(structuredClone(value)); props = { ...props, galleryImageSettings: structuredClone(value) }; dirty = true; }, ...props });
    options.onRender?.(tree);
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
  return { stops, resumes, jobsChanged, calls, find, open, close, root, profileChanges, panelFocusCalls, settingsOpens, sharedChanges, flush, unmount, submissions, creations, requestReads, watchers, snapshot, storage, AgentApiError, inputPreferences, jobReads, conversationReads, conversationUpdates, imageDecodes, taskUpdates, uploads, referenceReads, scrollObservers, window: globalMocks.window,
    updateProps(next) { props = { ...props, ...next }; render(); }, queueJobRead() { const reply = deferred(); jobReplies.push(reply); return reply; },
    resultCard(index = 0) { const card = nodes(tree).filter(node => typeof node.type === 'function' && node.type.name === 'ResultCard')[index]; assert.ok(card, 'actual result card should be rendered'); const savedCursor = cursor; cursor = slots.length; const content = card.type(card.props); cursor = savedCursor; return nodes(content); },
    setConfig(value) { config = { ...config, ...value }; }, dispatch(name) { globalMocks.window.dispatchEvent({ type: name }); }, show() { active = true; render(); }, get late() { return late; }, get pendingTimers() { return timers.size; }, get configReads() { return configReads; }, hide() { active = false; render(); } };
}
const row = id => ({ id, title: `Title ${id}`, updatedAt: 10, roundCount: 2 });

test('editing round eight validates that source branch instead of parent seven or current seventeen', async t => {
  const data = displaySnapshot('completed');
  data.revision=692;
  const rounds=Array.from({length:17},(_,i)=>({...data.conversation.rounds[0],id:`r${i+1}`,index:i+1,
    parentRoundId:i?`r${i}`:null,requestId:`req${i+1}`,prompt:`Question ${i+1}`,
    taskContext:{taskId:'task',revision:i===6?19:i===7?22:47,branchRoundId:`r${i+1}`,target:null,auxiliaries:[],constraints:[],promptVersions:[]},
    branchTaskRevision:i===7?23:(i===6?19:47)}));
  data.conversation={...data.conversation,activeRoundId:'r17',rounds,messages:[]};
  data.taskContext=rounds[16].taskContext;data.request={...data.request,roundId:'r17'};
  const h=harness(t,{snapshot:data});await h.flush();
  h.find('button',p=>p['aria-label']==='编辑重发')[7].onClick();await h.flush();
  h.requestReads[0].resolve({...data,images:[],request:{...data.request,roundId:'r8'}});await h.flush();
  h.find('textarea')[0].onChange({target:{value:'Revised eighth question',selectionStart:22}});await h.flush();
  h.find('button',p=>p['aria-label']==='发送 Agent 消息')[0].onClick();await h.flush();
  assert.equal(h.submissions.length,1);
  assert.equal(h.submissions[0].payload.parentRoundId,'r7');
  assert.equal(h.submissions[0].payload.derivedFromRoundId,'r8');
  assert.equal(h.submissions[0].payload.taskRevision,23);
  assert.equal(h.submissions[0].payload.expectedRevision,692);
});

test('an edited draft retained after another tab selects a sibling resolves mentions from its original ancestors', async t => {
  const data=displaySnapshot('completed');const first=data.conversation.rounds[0];
  const rounds=[{...first,id:'root',index:1,parentRoundId:null},
    {...first,id:'a2',index:2,parentRoundId:'root',outputTaskIds:['a-image']},
    {...first,id:'a3',index:3,parentRoundId:'a2',branchTaskRevision:31},
    {...first,id:'b2',index:2,parentRoundId:'root',outputTaskIds:['b-image']},
    {...first,id:'b3',index:3,parentRoundId:'b2',branchTaskRevision:47}];
  data.conversation={...data.conversation,rounds,activeRoundId:'b3',messages:[]};
  data.request={...data.request,roundId:'b3'};
  data.jobs=[{id:'a-image',status:'succeeded',result_path:'/a.png'},{id:'b-image',status:'succeeded',result_path:'/b.png'}];
  const h=harness(t,{snapshot:data,draft:{text:'Edit @第2轮图1',editId:'a3',origin:'edit',refs:[]}});await h.flush();
  h.find('button',p=>p['aria-label']==='发送 Agent 消息')[0].onClick();await h.flush();
  assert.equal(h.submissions.length,1);
  assert.equal(h.submissions[0].payload.parentRoundId,'a2');
  assert.equal(h.submissions[0].payload.taskRevision,31);
  assert.deepEqual(h.submissions[0].payload.refs,[{kind:'job',jobId:'a-image'}]);
});

test('a partial upload failure keeps the successful new attachment, prior attachments and exact draft', async t => {
  const first={name:'valid-but-unlabelled.bin',type:'application/octet-stream',size:100};
  const second={name:'too-many-pixels.jpg',type:'image/jpeg',size:200};
  const h=harness(t,{draft:{text:'  Preserve my draft\n'},upload:async file=>{
    if(file===second)throw Error('图片分辨率超过 1600 万像素；原文件未修改。');
    return {uploadId:'new-success',image:{url:'http://isolated.test/new.png'}};
  }});await h.flush();
  h.find('input',p=>p.type==='file')[0].onChange({target:{files:[first,second],value:'selected'}});await h.flush();
  assert.equal(h.uploads.length,2,'content, rather than a client MIME guess, is validated by the server');
  assert.equal(h.find('textarea')[0].value,'  Preserve my draft\n');
  assert.deepEqual(savedDraft(h).refs.map(r=>r.reference.uploadId),['u1','new-success']);
  assert.match(JSON.stringify(h.find('p',p=>p.className?.includes('agent-error'))),/1600/);
  assert.equal(h.submissions.length,0);
});

test('Agent byte-size preflight states MiB and leaves all existing composer content untouched', async t => {
  const h=harness(t);await h.flush();const before=structuredClone(savedDraft(h));
  h.find('input',p=>p.type==='file')[0].onChange({target:{files:[{name:'large.png',size:30*1024*1024+1,type:'image/png'}],value:'selected'}});await h.flush();
  assert.equal(h.uploads.length,0);assert.deepEqual(savedDraft(h),before);
  assert.match(JSON.stringify(h.find('p',p=>p.className?.includes('agent-error'))),/30 MiB/);
});
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
  h.find('button', p => p['aria-label'] === '打开会话 Title next')[0].onClick(); await h.flush(false);
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
  await h.open('生图设置');
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0].disabled, true);
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
  const { agentApi } = instantiate(js, { './agentProgress': progress }, { fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, json: async () => result([]) }; } });
  await agentApi.conversations('100', undefined, '  A%_ &词  ');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/agent/conversations?limit=100&cursor=100&q=A%25_%20%26%E8%AF%8D');
  assert.equal(requests[0].init.method, undefined);
});


test('unavailable image configuration blocks image-mode sends while preserving its draft and permitting text after mode is off', async t => {
  const h = harness(t); h.setConfig({ imageReady: true, imageIssues: [] }); await h.flush();
  h.hide(); h.show(); await h.flush();
  const mode = () => h.find('button', p => p['aria-label'] === '持续生图模式')[0];
  mode().onClick(); await h.flush(); assert.equal(mode()['aria-pressed'], true);
  h.hide(); h.setConfig({ imageReady: false, imageIssues: [{ message: 'Removed image profile' }] }); h.show(); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 0); assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.equal(h.find('img')[0].src, 'http://isolated.test/img.png');
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /完善生图设置/);
  assert.equal(mode().disabled, false, 'the user can turn off an unavailable image mode');
  mode().onClick(); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 1); assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, false);
  h.submissions[0].resolve(h.snapshot); await h.flush();
});

const params = { size: '1536x1024', quality: 'max', background: 'transparent', output_format: 'webp', output_compression: 0 };
const neutralParams = { size: 'auto', quality: 'auto', background: 'auto', output_format: 'png' };
const savedDraft = h => JSON.parse(h.storage.get('ipl.agent.drafts.v1')).current;
test('professional workflow config events preserve the current workspace draft, references and image configuration without creating or submitting a conversation', async t => {
  const selection = { profileId: 'image', model: 'manual-image-model' };
  const h = harness(t, { draft: { text: '  Exact prompt\n\nKeep this original.  ', params, imageConfig: selection } });
  const config = { apiConfigMode: 'hybrid', textProfileId: 'text', textModel: 'text-model', imageProfileId: 'image', imageModel: 'gpt-image-default', maxToolRounds: 5, maxImageJobs: 2, webSearch: false, professionalPromptWorkflows: true };
  await h.flush();
  h.setConfig({ config, imageReady: true, imageIssues: [], profiles: [imageProfile('text'), imageProfile('image')] });
  h.dispatch('ipl:agent-config-changed'); await h.flush();
  const before = structuredClone(savedDraft(h));
  const reads = h.configReads;
  for (const enabled of [false, true]) {
    h.setConfig({ config: { ...config, professionalPromptWorkflows: enabled } });
    h.dispatch('ipl:agent-config-changed'); await h.flush();
    assert.deepEqual(savedDraft(h), before);
    assert.equal(h.find('textarea')[0].value, before.text);
    assert.equal(h.find('img')[0].src, before.refs[0].url);
    assert.deepEqual(savedDraft(h).params, params);
    assert.deepEqual(savedDraft(h).imageConfig, selection);
    assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0); assert.equal(h.requestReads.length, 0);
  }
  assert.equal(h.configReads, reads + 2);
});

test('actual settings save receipt after close refreshes workspace revision while preserving draft and attachments until the user sends', async t => {
  const calls = [], receipt = deferred(), marker = () => null;
  const config = { apiConfigMode: 'hybrid', textProfileId: 'text', textModel: 'text-model', imageProfileId: 'image', imageModel: 'gpt-image-default', maxToolRounds: 5, maxImageJobs: 2, webSearch: false, stream: true, professionalPromptWorkflows: true };
  let stored = { revision: 5, config, imageReady: true, imageIssues: [], ready: true, issues: [], profiles: ['text', 'image'].map(id => ({ id, display_name: id, model: `gpt-image-${id}`, configured: true })), capabilities: { modes: ['off', 'native', 'hybrid'], maxToolRounds: 50, maxImageJobs: 20, maxInputImages: 4 } };
  const api = instantiate(await compile('../frontend/src/api/agentClient.ts'), { './agentProgress': progress }, { fetch: async (url, init) => {
    assert.equal(url, '/api/agent/config', 'only saved configuration may be fetched; no provider calls');
    calls.push(init.method || 'GET');
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      assert.equal(body.expectedRevision, 5);
      stored = { ...stored, revision: 6, config: body.config };
      const aborted = new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted response'))));
      await Promise.race([receipt.promise, aborted]);
    }
    return { ok: true, json: async () => structuredClone(stored) };
  } });
  const selection = { profileId: 'image', model: 'manual-image-model' };
  const h = harness(t, { getAgentConfig: api.getAgentConfig, draft: { text: '  Exact prompt\n\nKeep original.  ', params, imageConfig: selection } });
  await h.flush(); const before = structuredClone(savedDraft(h));
  // Mount the production settings component with its own hook lifetime and the
  // same application event target as the already mounted workspace.
  const slots = [], effects = [];
  let cursor = 0, dirty = false, tree, closed = false, late = 0;
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { if (closed) late++; slots[index] = typeof value === 'function' ? value(slots[index]) : value; dirty = true; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect(effect, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, n) => value !== old.deps[n])) { slots[index] = { deps }; effects.push(() => { old?.cleanup?.(); slots[index].cleanup = effect(); }); } },
  };
  const jsx = (type, props) => ({ type, props });
  const Settings = instantiate(await compile('../frontend/src/components/settings/AgentSettings.tsx'), { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../api/agentClient': api, './AgentModelPicker': marker }, { window: h.window }).default;
  const render = () => { cursor = 0; dirty = false; tree = Settings({ uiLanguage: 'zh_hans', active: true }); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let n = 0; n < 30; n++) { if (dirty && !closed) render(); await Promise.resolve(); } };
  const close = () => { if (closed) return; closed = true; slots.forEach(slot => slot?.cleanup?.()); };
  t.after(close); render(); await flush();
  const label = nodes(tree).find(node => node.type === 'label' && node.props.children?.[0]?.props?.children === '启用图片提示词专业工作流');
  nodes(label).find(node => node.type === 'input').props.onChange({ target: { checked: false } }); await flush();
  const saving = nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await flush(); close();
  assert.equal(stored.revision, 6, 'the backend has committed while its receipt is delayed');
  receipt.resolve(); await saving; await flush(); await h.flush();
  assert.equal(late, 0);
  assert.deepEqual(calls, ['GET', 'GET', 'PUT', 'GET'], 'one successful receipt causes one local config refresh, never a replayed PUT');
  assert.deepEqual(savedDraft(h), before);
  assert.equal(h.find('textarea')[0].value, before.text); assert.equal(h.find('img')[0].src, before.refs[0].url);
  assert.deepEqual(savedDraft(h).params, params); assert.deepEqual(savedDraft(h).imageConfig, selection);
  assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0);
  h.find('button', props => props['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  h.find('button', props => props['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 1); assert.equal(h.creations.length, 0);
  assert.equal(h.submissions[0].payload.configRevision, 6);
  assert.equal(h.submissions[0].payload.prompt, before.text);
  assert.deepEqual(h.submissions[0].payload.refs, before.refs.map(ref => ref.reference));
  assert.deepEqual(h.submissions[0].payload.params, params);
  assert.deepEqual(h.submissions[0].payload.imageConfig, selection);
});
function keyEvent(extra = {}) {
  const event = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
  return event;
}

test('normal Enter journals before POST without flashing previous-submission recovery in any render', async t => {
  const recoveryRenders = [];
  const h = harness(t, { onRender: tree => recoveryRenders.push(nodes(tree).some(node => node.props?.className === 'agent-uncertain')) }); await h.flush();
  const enter = keyEvent(); h.find('textarea')[0].onKeyDown(enter); await h.flush();
  assert.equal(enter.prevented, true); assert.equal(h.submissions.length, 1);
  const entry = JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1'))[0];
  assert.equal(entry.payload.requestId, h.submissions[0].payload.requestId, 'write the immutable safety journal before waiting for the receipt');
  assert.equal(h.find('textarea')[0].disabled, true);
  assert.equal(h.find('button', p => p['aria-label'] === '检查原请求状态').length, 0);
  assert.equal(recoveryRenders.includes(true), false, 'no transient render may describe this live POST as an earlier uncertain send');
  h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.equal(recoveryRenders.includes(true), false);
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')), []);
});

test('a different uncertain request remains visible during a live POST and recovery targets its own request ID', async t => {
  const h = harness(t); await h.flush();
  h.find('textarea')[0].onKeyDown(keyEvent()); await h.flush();
  const local = JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1'))[0];
  const other = { conversationId: 'current', preserveDraft: true, payload: { ...local.payload, requestId: 'other-tab-request', prompt: 'Other frozen request' } };
  h.storage.set('ipl.agent.pending-submissions.v1', JSON.stringify([local, other]));
  h.window.dispatchEvent({ type: 'storage', key: 'ipl.agent.pending-submissions.v1' }); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '检查原请求状态').length, 1, 'busy must not hide another pending identity');
  assert.equal(h.find('button', p => p['aria-label'] === '检查原请求状态')[0].disabled, true);
  h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')), [other]);
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
  assert.equal(h.requestReads[0].id, 'other-tab-request'); assert.equal(h.submissions.length, 1);
  assert.equal(h.find('button', p => p['aria-label'] === '检查原请求状态').length, 1, 'a recovery GET keeps the real uncertainty visible');
});

test('a lost Enter receipt reveals recovery and a refreshed component retains same-ID restore', async t => {
  const first = harness(t); await first.flush(); first.find('textarea')[0].onKeyDown(keyEvent()); await first.flush();
  const original = JSON.parse(first.storage.get('ipl.agent.pending-submissions.v1'))[0];
  first.submissions[0].reject(Error('connection lost')); await first.flush();
  assert.equal(first.find('button', p => p['aria-label'] === '检查原请求状态').length, 1);
  assert.equal(first.find('textarea')[0].disabled, true); first.unmount();
  const restored = harness(t, { storage: first.storage }); await restored.flush();
  assert.equal(restored.submissions.length, 0); assert.equal(restored.requestReads.length, 0);
  restored.find('button', p => p['aria-label'] === '用同一请求恢复')[0].onClick(); await restored.flush();
  assert.equal(restored.requestReads[0].id, original.payload.requestId);
  restored.requestReads[0].reject(new restored.AgentApiError(404, 'Not found')); await restored.flush();
  assert.equal(restored.submissions.length, 1); assert.deepEqual(restored.submissions[0].payload, original.payload);
  restored.submissions[0].resolve(restored.snapshot); await restored.flush();
  assert.deepEqual(JSON.parse(restored.storage.get('ipl.agent.pending-submissions.v1')), []);
});

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
  await configureImages(h); h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.find('textarea')[0].disabled, true);
  await h.open('生图设置');
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

test('confirming an uncertain request preserves image mode but consumes search permission before the next message', async t => {
  const h = harness(t); await h.flush();
  h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
  h.hide(); h.show(); await h.flush();
  h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  await h.open('生图设置');
  h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange({ target: { checked: true } }); await h.flush(); await h.close();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, true);
  assert.equal(h.submissions[0].payload.authorization.allowWebSearch, true);
  h.submissions[0].reject(Error('response lost')); await h.flush();
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], true);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 0);
  h.find('textarea')[0].onChange({ target: { value: 'Next image instruction', selectionStart: 22 } }); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.creations.length, 0); assert.equal(h.submissions.length, 2);
  assert.equal(h.submissions[1].payload.authorization.allowImageGeneration, true);
  assert.equal(h.submissions[1].payload.authorization.allowWebSearch, false);
  assert.equal(h.submissions[1].payload.authorization.maxImageJobs, 2);
  h.submissions[1].resolve(h.snapshot); await h.flush();
});

test('a late receipt preserves image mode and a newer explicit search permission, draft and reference', async t => {
  for (const recover of [false, true]) {
    const h = harness(t); await h.flush();
    h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
    h.hide(); h.show(); await h.flush();
    h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
    await h.open('生图设置');
    const searchPermission = h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange;
    searchPermission({ target: { checked: true } }); await h.flush(); await h.close();
    const edit = h.find('textarea')[0].onChange;
    h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
    if (recover) {
      h.submissions[0].reject(Error('response lost')); await h.flush();
      h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
    }
    // Callbacks queued before disabling still belong to the next draft/choice.
    edit({ target: { value: 'Newer draft', selectionStart: 11 } });
    searchPermission({ target: { checked: false } }); searchPermission({ target: { checked: true } }); await h.flush();
    (recover ? h.requestReads[0] : h.submissions[0]).resolve(h.snapshot); await h.flush();
    assert.equal(h.find('textarea')[0].value, 'Newer draft');
    assert.deepEqual(h.find('img').map(p => p.src), ['http://isolated.test/img.png']);
    assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], true);
    assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 1);
    h.unmount();
  }
});

test('a queued image-mode change during receipt reconciliation does not renew search permission', async t => {
  const h = harness(t); await h.flush();
  h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
  h.hide(); h.show(); await h.flush();
  const mode = () => h.find('button', p => p['aria-label'] === '持续生图模式')[0];
  mode().onClick(); await h.flush(); const turnOff = mode().onClick;
  await h.open('生图设置');
  h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange({ target: { checked: true } }); await h.flush(); await h.close();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  h.submissions[0].reject(Error('response lost')); await h.flush();
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
  turnOff(); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(mode()['aria-pressed'], false);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 0);
});

test('uncertain reconciliation uses the original send boundary for newer drafts and single-request search choices', async t => {
  for (const renewSearch of [false, true]) {
    const h = harness(t); await h.flush();
    h.setConfig({ imageReady: true, imageIssues: [], config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
    h.hide(); h.show(); await h.flush();
    h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
    await h.open('生图设置');
    const searchPermission = h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange;
    searchPermission({ target: { checked: true } }); await h.flush(); await h.close();
    const edit = h.find('textarea')[0].onChange;
    h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick();
    edit({ target: { value: 'Newer draft before confirmation', selectionStart: 31 } });
    if (renewSearch) { searchPermission({ target: { checked: false } }); searchPermission({ target: { checked: true } }); }
    await h.flush(); h.submissions[0].reject(Error('response lost')); await h.flush();
    h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
    h.requestReads[0].resolve(h.snapshot); await h.flush();
    assert.equal(h.find('textarea')[0].value, 'Newer draft before confirmation');
    assert.deepEqual(h.find('img').map(p => p.src), ['http://isolated.test/img.png']);
    assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], true);
    assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, renewSearch ? 1 : 0);
    assert.equal(h.submissions.length, 1); assert.equal(h.requestReads.length, 1); h.unmount();
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

test('image settings open and close without sending, expose actual quantity, and retain draft and search choice', async t => {
  const h = harness(t, { draft: { params } }); await h.flush(); await configureImages(h);
  h.setConfig({ config: { apiConfigMode: 'hybrid', textProfileId: 'text', imageProfileId: 'image', textModel: 'reasoning-model', maxToolRounds: 5, maxImageJobs: 4, webSearch: true }, capabilities: { maxInputImages: 4, webSearch: true } });
  h.hide(); h.show(); await h.flush(); const before = savedDraft(h);
  const mode = () => h.find('button', p => p['aria-label'] === '持续生图模式')[0];
  await h.open('生图设置'); assert.equal(h.root.inert, true);
  for (const label of ['本轮允许生成图片', '本轮图片上限', '本轮模型步骤']) assert.equal(h.find('input', p => p['aria-label'] === label).length, 0);
  h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange({ target: { checked: true } });
  h.find('image-options')[0].onChange({ count: 3 }); await h.flush();
  h.find('div', p => p.role === 'dialog')[0].onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); await h.flush();
  assert.equal(h.root.inert, false); assert.equal(mode()['aria-pressed'], false);
  assert.equal(h.find('button', p => p['aria-label'] === '取消本轮搜索授权').length, 1);
  mode().onClick(); await h.flush(); await h.open('生图设置');
  assert.equal(h.find('image-options')[0].count, 3);
  const backdrop = h.find('div', p => p.className === 'agent-popover-layer')[0], target = {};
  backdrop.onMouseDown({ target, currentTarget: target }); await h.flush();
  mode().onClick(); await h.flush(); await h.open('生图设置');
  assert.equal(mode()['aria-pressed'], false);
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].checked, true);
  await h.close(); assert.deepEqual(savedDraft(h), before);
  assert.equal(h.submissions.length, 0); assert.equal(h.creations.length, 0); assert.equal(h.requestReads.length, 0);
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
  for (const [panel, action] of [['当前模型与供应商', '修改 Agent 模型配置'], ['生图设置', '检查图片配置']]) {
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
  for (const label of ['当前模型与供应商', '添加图片或引用', '生图设置']) {
    await h.open(label);
    for (const button of h.find('button')) assert.ok(button['aria-label']?.trim(), `action without a name: ${JSON.stringify(button)}`);
    await h.close();
  }
  await h.open('当前模型与供应商');
  h.find('select', p => p['aria-label'] === '本轮 API 配置')[0].onChange({ target: { value: 'b' } }); await h.flush();
  assert.match(JSON.stringify(h.find('div', p => p.className === 'agent-model-panel-content')), /Provider B/);
  await h.close(); await h.open('生图设置');
  assert.equal(h.find('select', p => p['aria-label'] === '本轮 API 配置')[0].value, 'b');
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
  assert.deepEqual(savedDraft(h), before); assert.equal(h.profileChanges.at(-1), 'b'); assert.equal(h.submissions.length, 0);
});

function displaySnapshot(state, extra = {}) {
  return {
    request: { id: 'request-current', conversationId: 'current', roundId: 'r1', state, usage: { responseStepsStarted: 2, imageJobsCreated: 1 }, authorization: { maxToolRounds: 5, maxImageJobs: 2 }, toolCalls: [], ...extra },
    conversation: { id: 'current', title: 'History', activeRoundId: 'r1', rounds: [{ id: 'r1', parentRoundId: null, index: 1, prompt: 'A short message', status: state === 'completed' ? 'done' : 'error', inputImageIds: [], outputTaskIds: [], requestId: 'request-current', assistantMessageId: 'a1', modelInfo: { requestedModel: 'historical-model', providerName: 'Historical provider', returnedModels: ['returned-alias'] } }], messages: [{ id: 'a1', role: 'assistant', roundId: 'r1', content: 'Answer text' }] },
  };
}
const imageProgress = h => h.find('p', p => p.className?.startsWith('agent-image-progress '));

test('request rejected before an image job exists uses the real spacious failure card and keeps drafts', async t => {
  for (const [kind, label, detail] of [
    ['moderation', '供应商审核拒绝', '代码：moderation_blocked；供应商未提供更具体原因。'],
    ['request_too_large', '请求内容过大', 'HTTP 413：请求内容超过接口或网关允许的大小。'],
  ]) {
    const data = displaySnapshot('failed'), round = data.conversation.rounds[0];
    data.conversation.messages = [];
    round.failure = { kind, detail, outcomeUnknown: false }; round.error = 'RAW_PRIVATE_ERROR';
    const h = harness(t, { snapshot: data }); await h.flush(); const before = savedDraft(h);
    const cards = h.find('article', p => p['aria-label'] === '请求失败');
    assert.equal(cards.length, 1); assert.match(cards[0].className, /agent-result-card-terminal/);
    assert.equal(h.find('strong', p => p.children === label).length, 1);
    assert.equal(h.find('p', p => p.children === detail).length, 1);
    assert.equal(h.find('p', p => p.className === 'agent-round-outcome').length, 0);
    assert.equal(imageProgress(h).length, 0);
    assert.equal(h.find('button', p => p['aria-label'] === '重试回答').length, 1);
    assert.equal(h.find('button', p => p['aria-label'] === '复制生图提示词').length, 0, 'a text planning rejection has no executed image Prompt');
    await h.open('查看失败详情'); assert.equal(h.find('response-details')[0].round.failure.kind, kind);
    await h.close(); assert.deepEqual(savedDraft(h), before);
    assert.equal(h.submissions.length, 0); assert.equal(h.taskUpdates.length, 0);
    h.unmount();
  }
});

test('uncertain or stopped requests keep recovery warnings instead of a definite rejection card', async t => {
  for (const extra of [{ state: 'unknown' }, { upstreamMayContinue: true }, { stopRequested: true }, { state: 'stopped' }]) {
    const data = displaySnapshot('failed', extra);
    data.conversation.rounds[0].failure = { kind: 'moderation', outcomeUnknown: false };
    const h = harness(t, { snapshot: data }); await h.flush();
    assert.equal(h.find('article', p => p['aria-label'] === '请求失败').length, 0);
    assert.equal(h.find('textarea')[0].value, 'Keep my draft'); assert.equal(h.submissions.length, 0);
    h.unmount();
  }
});

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
  assert.equal(h.find('div', p => p.className === 'agent-tool-status').length, 0);
  assert.equal(imageProgress(h).length, 1);
  assert.match(JSON.stringify(imageProgress(h)), /正在准备图片请求/);
  assert.doesNotMatch(JSON.stringify(imageProgress(h)), /generate_image_batch|批量生成/);
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
});

test('historical image tool uses its own failed job rather than completed model arguments or another request', async t => {
  const data = displaySnapshot('completed');
  const old = data.conversation.rounds[0];
  old.status = 'error'; old.outputTaskIds = ['old-failed'];
  old.responseOutput = [{ type: 'function_call', call_id: 'same-call', name: 'generate_image', status: 'completed' }];
  const latest = { ...old, id: 'latest', index: 2, parentRoundId: old.id, requestId: 'request-latest', status: 'done', outputTaskIds: [], responseOutput: [] };
  data.conversation.rounds.push(latest); data.conversation.activeRoundId = latest.id;
  data.request = { ...data.request, id: latest.requestId, roundId: latest.id, toolCalls: [{ callId: 'same-call', state: 'completed' }] };
  data.jobs = [{ id: 'old-failed', status: 'failed', result_path: null, error: 'legacy upstream error', metadata: { agent: { agentToolCallId: 'same-call' } } }];
  const h = harness(t, { snapshot: data }); await h.flush();
  const caption = JSON.stringify(h.find('div', p => p.className === 'agent-tool-status'));
  assert.equal(h.find('div', p => p.className === 'agent-tool-status').length, 0);
  assert.equal(h.find('small', p => p.children === '本次未生成图片').length, 0, 'one image tool does not repeat the round outcome');
  assert.equal(imageProgress(h).length, 0, 'the failed result card already explains the outcome');
  assert.match(JSON.stringify(h.resultCard()), /图片生成失败|agent-result-message/);
  assert.doesNotMatch(caption, /已完成/);
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.equal(h.submissions.length, 0);
});

test('conversation editing state has no separate task editor or redundant failure controls', async t => {
  const data = displaySnapshot('completed');
  data.editingTask = { target: { source: { kind: 'upload', uploadId: 'old-task' } }, requirements: 'Keep pose', constraints: ['Keep lighting'], auxiliaries: [] };
  const h = harness(t, { snapshot: data }); await h.flush(); const before = savedDraft(h);
  assert.equal(h.find('button', p => /当前编辑任务|使用当前生图配置重试|修改提示词后重新生成/.test(p['aria-label'] || '')).length, 0);
  assert.equal(h.find('editing-task-dialog').length, 0);
  await h.open('生图设置'); await h.close();
  assert.deepEqual(savedDraft(h), before); assert.deepEqual(h.taskUpdates, []); assert.equal(h.submissions.length, 0);
});

test('failed images receive current shared settings and retain distinct retry results without replacing the draft', async t => {
  const data = displaySnapshot('failed'); data.revision = 1;
  data.jobs = [{ id: 'failed', provider: 'openai_compatible', status: 'failed', prompt_text: 'execution prompt', parameters: { size: '1024x1024', quality: 'low' }, metadata: {} }];
  data.conversation.rounds[0].outputTaskIds = ['failed'];
  const updated = structuredClone(data); updated.revision = 2; updated.images = [];
  updated.conversation.rounds[0].retryTaskIds = ['retry-result']; updated.jobs.push({ id: 'retry-result', status: 'succeeded', result_path: '/retry.png' });
  const shared = { provider: 'openai_compatible', profileId: 'gallery', model: 'shared-current', params: { ...params, quality: 'medium' }, sizeMode: 'auto4k', count: 5 };
  let reads = 0;
  const h = harness(t, { snapshot: data, props: { galleryImageSettings: shared }, conversation: async () => ++reads === 1 ? { ...data, images: [] } : updated }); await h.flush(); await configureImages(h);
  const before = savedDraft(h), card = h.resultCard();
  assert.equal(card.filter(node => node.type === 'button' && /使用当前生图配置重试|修改提示词后重新生成/.test(node.props['aria-label'] || '')).length, 0);
  assert.equal(card.filter(node => node.type === 'button' && node.props['aria-label'] === '复制生图提示词').length, 1);
  const retry = card.find(node => node.type === 'retry-button').props;
  assert.equal(retry.job.prompt_text, 'execution prompt'); assert.deepEqual(retry.params, shared.params);
  assert.deepEqual(retry.selection, { profileId: 'gallery', model: 'shared-current' }); assert.equal(retry.sizeMode, 'auto4k');
  assert.deepEqual(savedDraft(h), before); assert.equal(h.submissions.length, 0);
  const readsBeforeReceipt = h.conversationReads.length;
  retry.onReceipt({ retryId: 'retry', sourceJobId: 'failed', job: updated.jobs[1] }); await h.flush();
  assert.equal(h.conversationReads.length, readsBeforeReceipt + 1, 'an accepted image retry refreshes once');
  assert.equal(h.find('section', p => p['aria-label'] === '本轮图片的重试结果').length, 1);
  assert.equal(imageProgress(h).length, 0, 'the original failed card explains its error and the successful retry needs no outcome bar');
  assert.match(JSON.stringify(h.resultCard(0)), /图片生成失败|agent-result-message/);
  assert.ok(h.resultCard(1).some(node => node.type === 'img' && node.props.src === '/retry.png'), 'the distinct successful retry retains its actual result');
  assert.deepEqual(savedDraft(h), before); assert.equal(h.submissions.length, 0);
});

test('reply retry immediately resubmits the original message and references while preserving the current draft', async t => {
  const data = displaySnapshot('completed'); data.conversation.rounds[0].inputImageIds = ['original-image'];
  const original = { id: 'original-image', status: 'available', source: { kind: 'upload', uploadId: 'original-upload' }, url: 'http://isolated.test/original.png' };
  const h = harness(t, { snapshot: data, draft: { text: '  Unsent next edit\n', params }, inputPreferences: { clearInputAfterSubmit: true } }); await h.flush();
  const before = structuredClone(savedDraft(h));
  const retry = h.find('button', p => p['aria-label'] === '重试回答')[0].onClick;
  retry(); retry(); await h.flush();
  assert.equal(h.requestReads.length, 1); assert.equal(h.submissions.length, 0);
  h.requestReads[0].resolve({ ...h.snapshot, images: [original] }); await h.flush();
  assert.equal(h.submissions.length, 1, 'no extra send click is needed');
  const sent = h.submissions[0].payload;
  assert.equal(sent.origin, 'regenerate'); assert.equal(sent.derivedFromRoundId, 'r1'); assert.equal(sent.parentRoundId, null);
  assert.equal(sent.prompt, data.conversation.rounds[0].prompt);
  assert.deepEqual(sent.refs, [original.source]); assert.notDeepEqual(sent.refs, before.refs.map(item => item.reference));
  assert.deepEqual(sent.params, neutralParams); assert.equal(sent.imageConfig, undefined);
  assert.deepEqual(sent.authorization, { scope: 'this_request', allowImageGeneration: false, allowWebSearch: false, maxImageJobs: 0, maxToolRounds: 5 });
  assert.equal(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1'))[0].preserveDraft, true);
  assert.deepEqual(savedDraft(h), before);
  h.submissions[0].resolve({ ...h.snapshot, revision: 2, request: { ...h.snapshot.request, id: sent.requestId } }); await h.flush();
  assert.deepEqual(savedDraft(h), before, 'successful retry cannot clear an unrelated composer');
  assert.equal(h.find('textarea')[0].value, before.text); assert.deepEqual(h.find('img').map(p => p.src), before.refs.map(item => item.url));
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')), []);
});

test('an unknown reply retry and reload retain the unsent draft and only reconcile the original request', async t => {
  const shared = { provider: 'openai_compatible', profileId: 'gallery', model: 'current-shared-model', params: { ...params, quality: 'low' }, count: 3 };
  const h = harness(t, { snapshot: displaySnapshot('completed'), draft: { text: 'Different unsent draft', params }, props: { galleryImageSettings: shared } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '重试回答')[0].onClick(); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  h.submissions[0].reject(Error('retry response lost')); await h.flush();
  const journal = JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1'));
  assert.equal(journal.length, 1); assert.equal(journal[0].preserveDraft, true); assert.deepEqual(savedDraft(h), before);
  await h.open('生图设置');
  assert.deepEqual(h.find('image-options')[0].params, shared.params, 'an unrelated retry cannot replace visible shared settings with old draft values');
  assert.deepEqual(h.find('image-options')[0].selection, { profileId: shared.profileId, model: shared.model });
  const newerShared = { ...shared, model: 'newer-shared-model', params: { ...params, quality: 'medium' }, count: 5 };
  h.updateProps({ galleryImageSettings: newerShared }); await h.flush();
  assert.deepEqual(h.find('image-options')[0].params, newerShared.params);
  assert.equal(h.find('image-options')[0].selection.model, newerShared.model); assert.equal(h.find('image-options')[0].count, 5);
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')), journal, 'shared edits do not mutate the pending text retry');
  assert.deepEqual(savedDraft(h), before); await h.close();
  h.unmount();
  const refreshed = harness(t, { snapshot: displaySnapshot('completed'), pending: journal, draft: before, props: { galleryImageSettings: newerShared } }); await refreshed.flush(); await configureImages(refreshed);
  assert.deepEqual(savedDraft(refreshed), before);
  assert.equal(refreshed.submissions.length, 0); assert.equal(refreshed.requestReads.length, 0);
  await refreshed.open('生图设置');
  assert.deepEqual(refreshed.find('image-options')[0].params, newerShared.params);
  assert.equal(refreshed.find('image-options')[0].selection.model, newerShared.model); await refreshed.close();
  refreshed.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await refreshed.flush();
  assert.equal(refreshed.requestReads[0].id, journal[0].payload.requestId);
  refreshed.requestReads[0].resolve({ ...refreshed.snapshot, request: { ...refreshed.snapshot.request, id: journal[0].payload.requestId } }); await refreshed.flush();
  assert.deepEqual(savedDraft(refreshed), before); assert.equal(refreshed.submissions.length, 0);
  assert.deepEqual(JSON.parse(refreshed.storage.get('ipl.agent.pending-submissions.v1')), []);
  await refreshed.open('生图设置');
  assert.deepEqual(refreshed.find('image-options')[0].params, newerShared.params);
  assert.equal(refreshed.find('image-options')[0].selection.model, newerShared.model); await refreshed.close();
});

test('reply retry refuses unavailable original references and a late read cannot send into another conversation', async t => {
  for (const unavailable of [undefined, { id: 'original', status: 'missing', source: { kind: 'upload', uploadId: 'lost' } }]) {
    const data = displaySnapshot('completed'); data.conversation.rounds[0].inputImageIds = ['original'];
    const h = harness(t, { snapshot: data }); await h.flush(); const before = savedDraft(h);
    h.find('button', p => p['aria-label'] === '重试回答')[0].onClick(); await h.flush();
    h.requestReads[0].resolve({ ...h.snapshot, images: unavailable ? [unavailable] : [] }); await h.flush();
    assert.equal(h.submissions.length, 0); assert.deepEqual(savedDraft(h), before);
    assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /原参考图片不可用/);
  }
  const h = harness(t, { snapshot: displaySnapshot('completed') }); await h.flush();
  h.calls[0].resolve(result(['next'])); await h.flush();
  const switchConversation = h.find('button', p => p.className === 'agent-conversation-link')[0].onClick;
  h.find('button', p => p['aria-label'] === '重试回答')[0].onClick(); await h.flush();
  switchConversation(); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.submissions.length, 0); assert.equal(h.storage.get('ipl.agent.active-conversation'), 'next');
  assert.equal(allDrafts(h).current.text, 'Keep my draft');
});

test('reply retry stays independent of changing shared image settings and never grants image or search calls', async t => {
  const first = { provider: 'openai_compatible', profileId: 'gallery', model: 'first', params: { ...params, quality: 'low' }, count: 3 };
  const h = harness(t, { snapshot: displaySnapshot('completed'), props: { galleryImageSettings: first } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  h.find('button', p => p['aria-label'] === '重试回答')[0].onClick(); await h.flush();
  h.updateProps({ galleryImageSettings: { ...first, model: 'later', params: { ...params, quality: 'high' }, count: 10 } }); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.deepEqual(h.submissions[0].payload.params, neutralParams); assert.equal(h.submissions[0].payload.imageConfig, undefined);
  assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, false);
  assert.equal(h.submissions[0].payload.authorization.allowWebSearch, false);
  assert.deepEqual(savedDraft(h), before);
  h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.deepEqual(savedDraft(h), before); assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], true);
});

test('actual result cards classify safe image failures once without exposing old raw upstream JSON', async t => {
  for (const [kind, label] of [['quota', '余额不足'], ['model_unsupported', '模型或接口不支持'], ['moderation', '供应商审核拒绝'], ['authentication', '认证或权限问题'], ['unknown', '图片请求未完成']]) {
    const data = displaySnapshot('failed');
    data.request.error = { code: 'image_job_failed', message: 'RAW_SECRET_JSON' };
    data.request.recoveryReason = 'RAW_SECRET_JSON';
    const round = data.conversation.rounds[0]; round.outputTaskIds = ['fail']; round.error = 'RAW_SECRET_JSON';
    round.responseOutput = [{ type: 'function_call', call_id: 'image', name: 'generate_image_batch', status: 'completed' }];
    data.jobs = [{ id: 'fail', status: 'failed', error: '{"secret":"RAW_SECRET_JSON"}', metadata: { agent: { agentToolCallId: 'image' }, failure: { kind, message: 'RAW_SECRET_JSON' } } }];
    const h = harness(t, { snapshot: data }); await h.flush();
    const visibleText = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(visibleText).join('') : node && typeof node === 'object' ? visibleText(node.props?.children) : '';
    const card = visibleText(h.resultCard()[0]);
    assert.match(card, new RegExp(label)); assert.doesNotMatch(card, /RAW_SECRET_JSON|文件尺寸未知/);
    assert.equal(h.find('div', p => p.className === 'agent-request-attention').length, 0);
    assert.equal(imageProgress(h).length, 0, 'a classified terminal card must not be repeated above the card');
    assert.ok(h.resultCard().some(node => node.props?.['aria-label'] === '查看生成详情'));
    assert.equal(h.submissions.length, 0); h.unmount();
  }
});

test('actual workspace reports mixed results and unknown receipts without losing drafts or treating missing files as success', async t => {
  const data = displaySnapshot('failed'); const round = data.conversation.rounds[0];
  round.outputTaskIds = ['ok', 'fail']; round.responseOutput = [{ type: 'function_call', call_id: 'batch', name: 'generate_image_batch', status: 'completed' }];
  data.jobs = [{ id: 'ok', status: 'accepted', result_path: '/ok.png', metadata: { agent: { agentToolCallId: 'batch' } } }, { id: 'fail', status: 'failed', metadata: { agent: { agentToolCallId: 'batch' } } }];
  const h = harness(t, { snapshot: data }); await h.flush();
  assert.equal(imageProgress(h).length, 1); assert.match(JSON.stringify(imageProgress(h)), /部分图片生成成功.*已完成 1 \/ 2 张.*失败 1 张/);
  assert.equal(h.find('small', p => p.children === '图片部分成功').length, 0);
  h.unmount();
  data.jobs.pop();
  const unknown = harness(t, { snapshot: data }); await unknown.flush();
  assert.equal(imageProgress(unknown).length, 1); assert.match(JSON.stringify(imageProgress(unknown)), /结果未知/);
  assert.equal(unknown.find('small', p => p.children === '结果未知').length, 0);
  assert.equal(unknown.find('textarea')[0].value, 'Keep my draft'); assert.equal(unknown.submissions.length, 0);
  unknown.unmount();
  data.jobs.push({ id: 'fail', status: 'unknown', metadata: { agent: { agentToolCallId: 'batch' } } });
  const uncertainJob = harness(t, { snapshot: data }); await uncertainJob.flush();
  assert.equal(imageProgress(uncertainJob).length, 1); assert.match(JSON.stringify(imageProgress(uncertainJob)), /结果未知/);
  assert.equal(uncertainJob.submissions.length, 0);
});

test('production progress snapshots expose measured phases without fabricating a percentage or changing the draft', async t => {
  const data = { ...displaySnapshot('running'), jobs: [], images: [] }; const round = data.conversation.rounds[0]; round.status = 'running';
  const h = harness(t, { snapshot: data }); await h.flush();
  const before = savedDraft(h);
  for (const [phase, label] of [['preparing', '准备参考图'], ['waiting_model', '等待文字模型'], ['receiving_model', '接收回答'], ['waiting_jobs', '等待图片任务'], ['generating_images', '正在生成图片'], ['processing_results', '保存图片结果']]) {
    const next = structuredClone(data); next.revision = 5 + ['preparing', 'waiting_model', 'receiving_model', 'waiting_jobs', 'generating_images', 'processing_results'].indexOf(phase);
    next.conversation.rounds[0].execution = { version: 1, phase, timings: {}, modelSteps: [] };
    h.watchers[0].next(next); await h.flush();
    const caption = JSON.stringify(h.find('p', p => p.className === 'agent-round-outcome'));
    assert.match(caption, new RegExp(label)); assert.doesNotMatch(caption, /%|正在响应/);
    assert.deepEqual(savedDraft(h), before);
  }
  assert.equal(h.submissions.length, 0);
});

test('different image calls retain individual result cards while one result area reports the combined partial outcome', async t => {
  const data = displaySnapshot('completed'), round = data.conversation.rounds[0];
  round.outputTaskIds = ['success', 'failure'];
  round.responseOutput = ['first', 'second'].map(call_id => ({ type: 'function_call', name: 'generate_image', call_id, status: 'completed' }));
  data.jobs = [{ id: 'success', status: 'succeeded', result_path: '/success.png', metadata: { agent: { agentToolCallId: 'first' } } }, { id: 'failure', status: 'failed', metadata: { agent: { agentToolCallId: 'second' } } }];
  const h = harness(t, { snapshot: data }); await h.flush();
  assert.equal(h.find('div', p => p.className === 'agent-tool-status').length, 0);
  assert.match(JSON.stringify(h.resultCard(0)), /已生成/);
  assert.match(JSON.stringify(h.resultCard(1)), /图片请求未完成/);
  assert.equal(imageProgress(h).length, 1);
  assert.match(JSON.stringify(imageProgress(h)), /部分图片生成成功.*已完成 1 \/ 2 张.*失败 1 张/);
  assert.equal(h.submissions.length, 0);
});

test('actual result area counts running jobs once and removes successful image tool bars without hiding non-image tools', async t => {
  const data = displaySnapshot('waiting_for_jobs'), round = data.conversation.rounds[0]; round.status = 'running';
  round.outputTaskIds = ['ok', 'pending'];
  round.responseOutput = [{ type: 'function_call', call_id: 'skill', name: 'read_agent_skill', status: 'completed' },
    { type: 'function_call_output', call_id: 'skill', output: '{}' },
    { type: 'function_call', call_id: 'batch', name: 'generate_image_batch', status: 'completed' }];
  data.jobs = [{ id: 'ok', status: 'succeeded', result_path: '/ok.png', metadata: { agent: { agentBatchCallId: 'batch' } } }, { id: 'pending', status: 'running', metadata: { agent: { agentBatchCallId: 'batch' } } }];
  data.request.authorization.maxImageJobs = 10;
  const h = harness(t, { snapshot: data }); await h.flush(); const draft = savedDraft(h);
  assert.equal(imageProgress(h).length, 1); assert.match(JSON.stringify(imageProgress(h)), /正在生成 2 张 · 已完成 1 张/);
  assert.doesNotMatch(JSON.stringify(imageProgress(h)), /10|%|批量生成/);
  assert.equal(h.find('p', p => p.className === 'agent-round-outcome').length, 0);
  assert.equal(h.find('div', p => p.className === 'agent-tool-status').length, 1);
  assert.match(JSON.stringify(h.find('div', p => p.className === 'agent-tool-status')), /读取创作技能/);
  const complete = { ...structuredClone(h.snapshot), ...structuredClone(data) }; complete.revision = 20; complete.request.state = 'completed'; complete.conversation.rounds[0].status = 'done'; complete.jobs[1].status = 'succeeded'; complete.jobs[1].result_path = '/second.png';
  h.watchers[0].next(complete); await h.flush();
  assert.equal(imageProgress(h).length, 0); assert.equal(h.find('p', p => p.className === 'agent-round-outcome').length, 0);
  assert.equal(h.find('div', p => p.className === 'agent-tool-status').length, 1);
  assert.equal(h.resultCard(0).some(node => node.props?.['aria-label'] === '复制图片'), true);
  assert.equal(h.resultCard(1).some(node => node.props?.['aria-label'] === '复制图片'), true);
  assert.deepEqual(savedDraft(h), draft); assert.equal(h.submissions.length, 0);
});

test('stopped image work retains upstream uncertainty in its only image status and never claims completion', async t => {
  const data = displaySnapshot('stopped', { stopRequested: true, upstreamMayContinue: true }), round = data.conversation.rounds[0];
  round.outputTaskIds = ['pending']; round.responseOutput = [{ type: 'image_generation_call', id: 'native', status: 'completed' }];
  data.jobs = [{ id: 'pending', status: 'running', metadata: { agent: { agentToolCallId: 'native' } } }];
  const h = harness(t, { snapshot: data }); await h.flush();
  assert.equal(imageProgress(h).length, 1); assert.match(JSON.stringify(imageProgress(h)), /已停止后续调用.*可能仍在继续.*检查原请求状态/);
  assert.doesNotMatch(JSON.stringify(imageProgress(h)), /图片全部成功|已完成|批量生成/);
  assert.equal(h.find('div', p => p.className === 'agent-tool-status').length, 0); assert.equal(h.submissions.length, 0);
});

test('browser terminal observation uses the original send boundary and repeated snapshots cannot extend it; refresh is unknown', async t => {
  let now = 100;
  const h = harness(t, { now: () => now }); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  const data = { ...displaySnapshot('running'), jobs: [], images: [] }; data.revision = 2;
  data.request.id = h.submissions[0].payload.requestId;
  data.conversation.rounds[0].requestId = data.request.id; data.conversation.rounds[0].status = 'running';
  now = 200; h.submissions[0].resolve(data); await h.flush();
  const terminal = structuredClone(data); terminal.revision = 3; terminal.request.state = 'completed'; terminal.conversation.rounds[0].status = 'done';
  now = 1300; h.watchers[0].next(terminal); await h.flush();
  await h.open('查看第 1 轮详情');
  assert.equal(h.find('response-details')[0].terminalObservationMs, 1200);
  now = 2400; h.watchers[0].next({ ...terminal, revision: 4 }); await h.flush();
  assert.equal(h.find('response-details')[0].terminalObservationMs, 1200);
  const refreshed = harness(t, { snapshot: terminal }); await refreshed.flush(); await refreshed.open('查看第 1 轮详情');
  assert.equal(refreshed.find('response-details')[0].terminalObservationMs, undefined);
});

test('failed and uncertain results retain visible recovery actions outside the details menu', async t => {
  for (const state of ['failed', 'unknown', 'interrupted']) {
    const h = harness(t, { snapshot: displaySnapshot(state, { error: { message: 'Mock failure' }, recoveryReason: 'Check original request', upstreamMayContinue: true, canResume: true }) }); await h.flush();
    const alert = h.find('div', p => p.className === 'agent-request-attention' && p.role === 'alert')[0];
    assert.ok(alert); assert.doesNotMatch(JSON.stringify(alert), /Mock failure|Check original request/); assert.match(JSON.stringify(alert), /计费/);
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
  await h.open('生图设置');
  assert.equal(mode()['aria-pressed'], true, 'the composer switch shows the persistent image permission');
  assert.equal(h.find('input', p => p['aria-label'] === '本轮允许生成图片').length, 0, 'there is no duplicate per-turn image permission');
  h.find('input', p => p['aria-label'] === '本轮允许网络搜索')[0].onChange({ target: { checked: true } }); await h.flush(); await h.close();
  await send('Image one'); assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, true);
  h.submissions[0].resolve(h.snapshot); await h.flush(); assert.equal(mode()['aria-pressed'], true);
  await send('Image two'); assert.equal(h.submissions[1].payload.authorization.allowImageGeneration, true); assert.equal(h.submissions[1].payload.authorization.allowWebSearch, false);
  h.submissions[1].reject(Error('response lost')); await h.flush();
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush(); h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(mode()['aria-pressed'], true); assert.equal(h.submissions.length, 2);
  mode().onClick(); await h.flush();
  await h.open('生图设置');
  assert.equal(mode()['aria-pressed'], false);
  assert.equal(mode().disabled, false);
  await h.close(); await send('Text only');
  assert.equal(h.submissions[2].payload.authorization.allowImageGeneration, false); assert.equal(h.submissions[2].payload.authorization.maxImageJobs, 0);
  assert.equal(h.submissions[2].payload.authorization.allowWebSearch, false);
  h.submissions[2].resolve(h.snapshot); await h.flush();
});

test('explicit image mode follows its conversation across switching and remount; new conversations default off', async t => {
  const h = harness(t, { activeId: null }); await h.flush(); await configureImages(h);
  const mode = () => h.find('button', p => p['aria-label'] === '持续生图模式')[0];
  mode().onClick(); await h.flush(); h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.creations.length, 1); h.creations[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, true);
  h.submissions[0].resolve(h.snapshot); await h.flush(); assert.equal(mode()['aria-pressed'], true);
  h.calls.at(-1).resolve(result(['other', 'current'])); await h.flush();
  h.find('button', p => p['aria-label'] === '打开会话 Title other')[0].onClick(); await h.flush(); assert.equal(mode()['aria-pressed'], false);
  h.find('button', p => p['aria-label'] === '打开会话 Title current')[0].onClick(); await h.flush(); assert.equal(mode()['aria-pressed'], true);
  assert.equal(h.storage.get(imageModeKey('current')), 'true'); assert.equal(h.storage.has(imageModeKey('other')), false);
  h.unmount();
  const fresh = harness(t, { storage: h.storage }); await fresh.flush(); await configureImages(fresh);
  assert.equal(fresh.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], true);
  assert.equal(fresh.submissions.length, 0, 'restoring a mode never submits a request');
  fresh.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await fresh.flush();
  assert.equal(fresh.submissions[0].payload.authorization.allowImageGeneration, true, 'the restored UI mode reaches the real submit callback');
  fresh.submissions[0].resolve(fresh.snapshot); await fresh.flush();
  fresh.find('button', p => p['aria-label'] === '新建会话')[0].onClick(); await fresh.flush();
  fresh.creations[0].resolve({ ...fresh.snapshot, conversation: { ...fresh.snapshot.conversation, id: 'brand-new' } }); await fresh.flush();
  assert.equal(fresh.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
  assert.equal(fresh.storage.get(imageModeKey('current')), 'true'); assert.equal(fresh.storage.has(imageModeKey('brand-new')), false);
  assert.equal(fresh.submissions.length, 1);
});

test('turning image mode off persists without clearing drafts or reference images, including after reload', async t => {
  const h = harness(t, { imageModes: { current: 'true', other: 'true' } }); await h.flush(); await configureImages(h);
  const draftBefore = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  assert.deepEqual(savedDraft(h), draftBefore);
  assert.equal(h.storage.has(imageModeKey('current')), false); assert.equal(h.storage.get(imageModeKey('other')), 'true');
  const mode = h.find('button', p => p['aria-label'] === '持续生图模式')[0];
  assert.match(JSON.stringify(mode.children), /生图模式 · 关/); assert.match(mode.title, /已关闭/);
  h.unmount();
  const fresh = harness(t, { storage: h.storage, draft: draftBefore }); await fresh.flush(); await configureImages(fresh);
  assert.equal(fresh.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
  assert.deepEqual(savedDraft(fresh), draftBefore); assert.equal(fresh.submissions.length, 0);
  fresh.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await fresh.flush();
  assert.equal(fresh.submissions[0].payload.authorization.allowImageGeneration, false);
  assert.equal(fresh.submissions[0].payload.authorization.maxImageJobs, 0);
  assert.equal(fresh.submissions[0].payload.prompt, draftBefore.text);
  assert.deepEqual(fresh.submissions[0].payload.refs, draftBefore.refs.map(ref => ref.reference));
});

test('image mode never restores from malformed values or an unsent new draft', async t => {
  for (const value of ['invalid-json', 'null', '["current"]', '{"current":"true"}', '1', '"true"']) {
    const h = harness(t, { imageModes: { current: value } }); await h.flush();
    assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
    assert.equal(h.submissions.length, 0); h.unmount();
  }
  const h = harness(t, { activeId: null, imageModes: { current: 'true', new: 'true' } }); await h.flush(); await configureImages(h);
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
  h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush(); h.unmount();
  const fresh = harness(t, { activeId: null, storage: h.storage }); await fresh.flush();
  assert.equal(fresh.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
  assert.equal(fresh.creations.length, 0); assert.equal(fresh.submissions.length, 0);
});

test('mode changes from another tab affect future sends only, not a frozen request or its receipt', async t => {
  const h = harness(t, { imageModes: { current: 'true' } }); await h.flush(); await configureImages(h);
  const draftBefore = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  const submitted = JSON.stringify(h.submissions[0].payload);
  h.storage.delete(imageModeKey('current')); h.window.dispatchEvent({ type: 'storage', key: imageModeKey('current') }); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
  assert.equal(JSON.stringify(h.submissions[0].payload), submitted);
  assert.deepEqual(savedDraft(h), draftBefore);
  h.submissions[0].reject(Error('response lost')); await h.flush();
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
  h.requestReads[0].resolve(h.snapshot); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], false);
  assert.equal(h.submissions.length, 1, 'receipt reconciliation does not re-enable or repeat a paid request');
});

test('image mode storage errors are visible and do not discard the current preference, draft or attachments', async t => {
  const h = harness(t, { imageModeWriteFails: true }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0]['aria-pressed'], true);
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /浏览器无法保存此选择/);
  assert.deepEqual(savedDraft(h), before); assert.equal(h.submissions.length, 0);
});

test('interleaved mode updates in different tabs cannot restore another conversation that was switched off', () => {
  const { readAgentImageMode, saveAgentImageMode } = instantiate(submissionJs, {});
  const values = new Map([[imageModeKey('current'), 'true']]);
  const plainStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const interleaved = {
    ...plainStorage,
    setItem(key, value) {
      saveAgentImageMode(plainStorage, 'current', false);
      plainStorage.setItem(key, value);
    },
  };
  saveAgentImageMode(interleaved, 'other', true);
  assert.equal(readAgentImageMode(plainStorage, 'current'), false);
  assert.equal(readAgentImageMode(plainStorage, 'other'), true);
});

test('deleting a conversation removes only its remembered image mode', async t => {
  const removed = [];
  const h = harness(t, { imageModes: { current: 'true', other: 'true' }, deleteConversation: id => removed.push(id) }); await h.flush();
  h.calls[0].resolve(result(['current', 'other'])); await h.flush();
  h.find('button', p => p['aria-label'] === '删除 Title current')[0].onClick(); await h.flush();
  h.find('button', p => p['aria-label'] === '确认删除会话')[0].onClick(); await h.flush();
  assert.deepEqual(removed, ['current']);
  assert.equal(h.storage.has(imageModeKey('current')), false); assert.equal(h.storage.get(imageModeKey('other')), 'true');
  assert.equal(h.submissions.length, 0);
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

test('historical task images use frozen reference aliases after original attachments and never impersonate those attachments', async t => {
  const data = displaySnapshot('completed');
  data.conversation.rounds[0].inputImageIds = ['original'];
  data.conversation.rounds[0].taskImageIds = ['task-image', 'missing-task'];
  data.images = [{ id: 'original', source: { kind: 'upload', uploadId: 'original' }, status: 'available', url: '/original.png' }, { id: 'task-image', source: { kind: 'library', imageId: 'mutable-source' }, status: 'available', url: '/frozen-task.png' }, { id: 'missing-task', source: { kind: 'upload', uploadId: 'gone' }, status: 'missing', url: '' }];
  const h = harness(t, { snapshot: data, draft: { text: 'Keep lighting @', params } }); await h.flush();
  const before = savedDraft(h);
  assert.equal(h.find('img', p => p.alt === '参考图 1').length, 1);
  assert.equal(h.find('img', p => p.alt === '参考图 2').length, 0);
  await h.open('添加图片或引用'); h.find('button', p => p['aria-label'] === '引用已有图片')[0].onClick(); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '引用第 1 轮编辑任务参考 2')[0].disabled, true);
  h.find('button', p => p['aria-label'] === '引用第 1 轮编辑任务参考 1')[0].onClick(); await h.flush();
  assert.equal(savedDraft(h).text, 'Keep lighting <ref id="round-1-reference-2" /> ');
  assert.deepEqual(savedDraft(h).refs, before.refs, 'historical frozen pixels must not be replaced by a fresh mutable Library lookup');
  assert.deepEqual(savedDraft(h).params, params); assert.equal(h.submissions.length, 0);
});

test('shared image settings follow Gallery automatically, synchronize Agent changes, and freeze sent values without rewriting drafts', async t => {
  const gallery = { provider: 'openai_compatible', profileId: 'gallery', model: 'gpt-image-gallery', params: { ...params, quality: 'medium' }, count: 3 };
  const h = harness(t, { draft: { params }, props: { galleryImageSettings: gallery } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  await h.open('生图设置');
  let options = h.find('image-options')[0];
  assert.equal(options.shared, true); assert.equal(options.count, 3); assert.deepEqual(options.params, gallery.params);
  assert.deepEqual(options.selection, { profileId: 'gallery', model: gallery.model }); assert.deepEqual(savedDraft(h), before);
  assert.equal(h.sharedChanges.length, 0, 'opening or observing settings is not an edit');
  const changedGallery = { ...gallery, model: 'changed-in-gallery', params: { ...params, quality: 'low' }, count: 1 };
  h.updateProps({ galleryImageSettings: changedGallery }); await h.flush();
  options = h.find('image-options')[0]; assert.deepEqual(options.params, changedGallery.params);
  assert.equal(options.selection.model, changedGallery.model); assert.equal(options.count, 1); assert.deepEqual(savedDraft(h), before);
  options.onChange({ imageConfig: { profileId: 'image', model: 'manual-image' }, params: { ...params, quality: 'high' }, count: 3 }); await h.flush();
  const shared = h.sharedChanges.at(-1);
  assert.equal(shared.profileId, 'image'); assert.equal(shared.model, 'manual-image'); assert.equal(shared.count, 3);
  assert.equal(shared.params.quality, 'high'); assert.deepEqual(savedDraft(h), before);
  assert.equal(shared.prompt, undefined); assert.equal(shared.refs, undefined);
  await h.close(); h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  const frozen = structuredClone(h.submissions[0].payload);
  assert.deepEqual(frozen.imageConfig, { profileId: 'image', model: 'manual-image' }); assert.deepEqual(frozen.params, shared.params);
  assert.equal(frozen.imageCount, 3); assert.equal(frozen.authorization.maxImageJobs, 4, 'requested count is separate from the protection ceiling');
  assert.deepEqual(frozen.refs, before.refs.map(choice => choice.reference)); assert.equal(frozen.prompt, before.text);
  h.updateProps({ galleryImageSettings: { ...gallery, model: 'future-gallery', params: { ...params, size: '1024x1024' }, count: 5 } }); await h.flush();
  assert.deepEqual(h.submissions[0].payload, frozen);
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1'))[0].payload, JSON.parse(JSON.stringify(frozen)));
  h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.deepEqual(savedDraft(h).params, before.params); assert.equal(savedDraft(h).text, '');
  await h.open('生图设置'); assert.equal(h.find('image-options')[0].selection.model, 'future-gallery');
  assert.equal(h.find('image-options')[0].count, 5); await h.close();
});

test('incompatible Gallery settings disable image mode and can be repaired without changing saved text-model configuration', async t => {
  const h = harness(t, { props: { galleryImageSettings: { provider: 'chatgpt', profileId: '', model: 'oauth-model', params } } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h)); await h.open('生图设置');
  assert.match(h.find('image-options')[0].sharedUnavailable, /供应商不支持/);
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0].disabled, true);
  h.find('image-options')[0].onChange({ imageConfig: { profileId: 'image', model: 'my-image-model' } }); await h.flush();
  assert.equal(h.sharedChanges.at(-1).provider, 'openai_compatible'); assert.equal(h.sharedChanges.at(-1).model, 'my-image-model');
  assert.equal(h.find('image-options')[0].config.config.textModel, 'reasoning-model');
  assert.equal(h.find('image-options')[0].config.config.imageModel, 'gpt-image-configured');
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0].disabled, false);
  assert.deepEqual(savedDraft(h), before); assert.equal(h.submissions.length, 0);
});

test('text discussion remains available with unresolved auto4k references and unavailable shared image configuration', async t => {
  const shared = { provider: 'openai_compatible', profileId: 'gone', model: '', params: { ...params, quality: 'unsupported', size: 'invalid' }, sizeMode: 'auto4k', count: 10, unavailable: 'Image configuration unavailable' };
  const h = harness(t, { draft: { text: 'Discuss this reference without generating', params }, props: { galleryImageSettings: shared } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  assert.ok(h.imageDecodes.length, 'reference measurement is still unresolved');
  assert.equal(h.find('button', p => p['aria-label'] === '持续生图模式')[0].disabled, true);
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0].payload.prompt, before.text);
  assert.deepEqual(h.submissions[0].payload.refs, before.refs.map(item => item.reference));
  assert.deepEqual(h.submissions[0].payload.params, neutralParams);
  assert.equal(h.submissions[0].payload.imageConfig, undefined);
  assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, false);
  assert.equal(h.submissions[0].payload.authorization.maxImageJobs, 0);
  h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.deepEqual(savedDraft(h).params, before.params);
});

test('shared actual image count cannot silently truncate at the configured protection ceiling', async t => {
  const shared = { provider: 'openai_compatible', profileId: 'gallery', model: 'gallery-model', params, count: 5 };
  const h = harness(t, { props: { galleryImageSettings: shared } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 0); assert.deepEqual(savedDraft(h), before);
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /5.*4.*上限/);
  assert.equal(h.storage.has('ipl.agent.pending-submissions.v1'), false);
  await h.open('生图设置'); assert.equal(h.find('image-options')[0].count, 5);
  h.find('image-options')[0].onChange({ count: 3 }); await h.flush(); await h.close();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 1); assert.equal(h.submissions[0].payload.imageCount, 3);
  assert.equal(h.submissions[0].payload.authorization.maxImageJobs, 4);
  assert.equal(h.sharedChanges.at(-1).count, 3);
  h.submissions[0].resolve(h.snapshot); await h.flush();
});

test('actual workspace size-dialog handoff releases the options modal and resolves auto size from the first image before submission', async t => {
  const h = harness(t, { draft: { params, sizeMode: 'auto4k' } }); await h.flush(); await configureImages(h);
  h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  await h.open('生图设置'); assert.equal(h.root.inert, true);
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

test('Gallery retry results return to their recorded Agent branch without replacing the original failed task', async t => {
  const job = completedJob('retried-image', { agentRetry: { conversationId: 'target', roundId: 'target-first', sourceJobId: 'failed-original' } });
  const target = { revision: 4, request: null, jobs: [job], images: [], conversation: { id: 'target', title: 'Target', activeRoundId: 'target-first', rounds: [{ id: 'target-first', index: 1, parentRoundId: null, outputTaskIds: ['failed-original'], retryTaskIds: [job.id], inputImageIds: [], prompt: 'old', status: 'done' }], messages: [] } };
  const h = harness(t, { jobs: { [job.id]: job }, snapshots: { target } }); await h.flush(); const before = savedDraft(h);
  h.updateProps({ galleryCommand: { id: 20, job, intent: 'reference' } }); await h.flush();
  assert.equal(h.storage.get('ipl.agent.active-conversation'), 'target');
  assert.deepEqual(allDrafts(h).current, before);
  assert.deepEqual(allDrafts(h).target.refs.map(row => row.reference), [{ kind: 'job', jobId: job.id }]);
  assert.deepEqual(target.conversation.rounds[0].outputTaskIds, ['failed-original']);
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

test('native image mode rejects an old Images profile until selecting a native tool model without a profile override', async t => {
  const selection = { profileId: 'image', model: 'gpt-image-hybrid-draft' };
  const h = harness(t, { draft: { params, imageConfig: selection } }); await h.flush(); await configureImages(h);
  const before = structuredClone(savedDraft(h));
  h.setConfig({ config: { apiConfigMode: 'native', textProfileId: 'text', textModel: 'native-text-model', imageModel: 'native-tool-model', maxToolRounds: 5, maxImageJobs: 4 }, profiles: [imageProfile('text'), imageProfile('image')], imageReady: true, imageIssues: [] });
  h.hide(); h.show(); await h.flush();
  h.find('button', p => p['aria-label'] === '持续生图模式')[0].onClick(); await h.flush();
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 0, 'an Images API profile cannot be sent as a native tool selection');
  assert.equal(h.creations.length, 0); assert.deepEqual(savedDraft(h), before);
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /重新选择生图模型/);
  assert.equal(h.storage.has('ipl.agent.pending-submissions.v1'), false);
  await h.open('生图设置'); h.find('image-options')[0].onChange({ imageConfig: { model: 'native-new-model' } }); await h.flush(); await h.close();
  assert.equal(savedDraft(h).text, before.text); assert.deepEqual(savedDraft(h).refs, before.refs); assert.deepEqual(savedDraft(h).params, params);
  assert.equal(h.sharedChanges.length, 0, 'native choices cannot update Gallery Images routing');
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 1); assert.deepEqual(h.submissions[0].payload.imageConfig, { model: 'native-new-model' });
  assert.equal(h.submissions[0].payload.authorization.allowImageGeneration, true);
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


test('actual run hook detaches on page leave, ignores late callbacks and restores the same request without stopping or submitting', async t => {
  const h = harness(t, { snapshot: displaySnapshot('running') }); await h.flush();
  const before = structuredClone(savedDraft(h)), first = h.watchers[0];
  h.hide(); await h.flush(); assert.equal(first.stopped, true);
  first.next({ ...h.snapshot, revision: 100, request: { ...h.snapshot.request, state: 'completed' } }); first.error(Error('late observer error')); await h.flush();
  assert.equal(h.stops.length, 0); assert.equal(h.submissions.length, 0); assert.deepEqual(savedDraft(h), before);
  h.show(); await h.flush(); assert.equal(h.watchers.length, 2); assert.equal(h.watchers[1].id, first.id);
  assert.equal(h.find('p', p => p.role === 'alert').length, 0);
  h.unmount(); h.watchers[1].next(h.snapshot); h.watchers[1].error(Error('after unmount')); await h.flush(); assert.equal(h.late, 0);
});

test('actual hook stop is one explicit command and its receipt invalidates the old observer baseline', async t => {
  const h = harness(t, { snapshot: displaySnapshot('running') }); await h.flush();
  const before = structuredClone(savedDraft(h)), first = h.watchers[0];
  const stop = h.find('button', p => p['aria-label'] === '停止后续调用')[0].onClick;
  stop(); stop(); await h.flush(); assert.equal(h.stops.length, 1); assert.equal(h.stops[0].id, 'request-current');
  const stopping = { ...h.snapshot, revision: 2, request: { ...h.snapshot.request, state: 'stop_requested', stopRequested: true, upstreamMayContinue: true } };
  h.stops[0].resolve(stopping); await h.flush();
  assert.equal(first.stopped, true); assert.equal(h.watchers.length, 2);
  first.next({ ...h.snapshot, revision: 999 }); first.error(Error('old baseline')); await h.flush();
  assert.equal(h.find('p', p => p.role === 'alert').length, 0); assert.equal(h.jobsChanged.length, 1);
  const second = h.watchers[1]; second.next({ ...stopping, revision: 3, request: { ...stopping.request, state: 'stopped' } }); await h.flush();
  assert.equal(second.stopped, true); assert.equal(h.find('button', p => p['aria-label'] === '发送 Agent 消息').length, 1);
  assert.deepEqual(savedDraft(h), before); assert.equal(h.submissions.length, 0);
});

test('late stop failures and receipts cannot alter a newly selected conversation or an unmounted hook', async t => {
  for (const mode of ['switch-failure', 'switch-receipt', 'unmount']) {
    const h = harness(t, { snapshot: displaySnapshot('running'), snapshots: { next: { schemaVersion: 1, revision: 1, conversation: { id: 'next', title: 'Next', rounds: [], messages: [] }, request: null, jobs: [], images: [] } }, drafts: { next: { text: 'New draft', refs: [], params, editId: null, origin: 'send' } } }); await h.flush();
    h.find('button', p => p['aria-label'] === '停止后续调用')[0].onClick(); await h.flush();
    if (mode === 'unmount') h.unmount(); else { h.updateProps({ focusConversationId: 'next', focusToken: 1 }); await h.flush(); }
    if (mode === 'switch-failure') h.stops[0].reject(Error('old stop failed')); else h.stops[0].resolve({ ...h.snapshot, revision: 2, request: { ...h.snapshot.request, state: 'stopped' } });
    await h.flush(); assert.equal(h.late, 0);
    if (mode !== 'unmount') { assert.equal(h.find('textarea')[0].value, 'New draft'); assert.equal(h.find('p', p => p.role === 'alert').length, 0); }
    assert.equal(h.submissions.length, 0);
  }
});

test('safe continuation keeps its persisted resume ID and never silently retries an uncertain command', async t => {
  const h = harness(t, { snapshot: displaySnapshot('interrupted', { canResume: true }) }); await h.flush();
  const resume = () => h.find('button', p => p['aria-label'] === '继续已确认安全的步骤')[0].onClick();
  resume(); resume(); await h.flush(); assert.equal(h.resumes.length, 1);
  h.resumes[0].reject(Error('response lost')); await h.flush(); assert.equal(h.resumes.length, 1);
  resume(); await h.flush(); assert.equal(h.resumes.length, 2); assert.equal(h.resumes[1].resumeId, h.resumes[0].resumeId);
  h.resumes[1].resolve({ ...h.snapshot, revision: 2, request: { ...h.snapshot.request, state: 'running', canResume: false } }); await h.flush();
  assert.equal(h.watchers.length, 1); assert.equal(h.submissions.length, 0); assert.equal(h.find('textarea')[0].value, 'Keep my draft');
});

test('late accepted submit clears its durable journal after unmount without touching component state', async t => {
  const h = harness(t); await h.flush(); h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 1); h.unmount(); h.submissions[0].resolve(h.snapshot); await h.flush();
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')), []); assert.equal(h.late, 0);
});

test('a mismatched submit receipt retains frozen input and cannot acknowledge the draft', async t => {
  const h = harness(t); await h.flush(); const before = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  h.submissions[0].resolve({ ...h.snapshot, request: { id: 'another-request', state: 'completed' } }); await h.flush();
  assert.equal(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')).length, 1); assert.deepEqual(savedDraft(h), before);
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /身份不匹配/);
});

test('cross-tab pending journal changes lock only that conversation and never replay on storage notifications', async t => {
  const h = harness(t); await h.flush(); const before = structuredClone(savedDraft(h));
  const entry = { conversationId: 'current', payload: { requestId: 'from-other-tab', prompt: 'Other frozen draft', refs: [], params, authorization: { allowImageGeneration: false } } };
  h.storage.set('ipl.agent.pending-submissions.v1', JSON.stringify([entry]));
  h.window.dispatchEvent({ type: 'storage', key: 'ipl.agent.pending-submissions.v1' }); await h.flush();
  assert.equal(h.find('textarea')[0].disabled, true); assert.equal(h.submissions.length, 0); assert.equal(h.requestReads.length, 0); assert.deepEqual(savedDraft(h), before);
  h.storage.set('ipl.agent.pending-submissions.v1', '[]'); h.window.dispatchEvent({ type: 'storage', key: 'ipl.agent.pending-submissions.v1' }); await h.flush();
  assert.equal(h.find('textarea')[0].disabled, false); assert.equal(h.submissions.length, 0);
});

test('ordinary text observation does not refresh Gallery; job status changes do', async t => {
  const h = harness(t, { snapshot: displaySnapshot('running') }); await h.flush(); const watcher = h.watchers[0];
  for (let n = 0; n < 4; n++) watcher.next({ ...h.snapshot, revision: n + 2, conversation: { ...h.snapshot.conversation, messages: [{ ...h.snapshot.conversation.messages[0], content: 'word '.repeat(n + 1) }] } });
  await h.flush(); assert.equal(h.jobsChanged.length, 0);
  watcher.next({ ...h.snapshot, revision: 6, jobs: [{ id: 'job', status: 'running' }] }); await h.flush(); assert.equal(h.jobsChanged.length, 1);
  watcher.next({ ...h.snapshot, revision: 7, jobs: [{ id: 'job', status: 'running' }] }); await h.flush(); assert.equal(h.jobsChanged.length, 1);
});


test('new-conversation receipt wins over its delayed initial GET for both the main view and sidebar', async t => {
  for (const failure of [false, true]) {
    const delayed = deferred(); const h = harness(t, { activeId: null, conversation: () => delayed.promise }); await h.flush();
    h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
    const created = { ...h.snapshot, revision: 0, conversation: { ...h.snapshot.conversation, id: 'created', title: 'Empty title' } };
    h.creations[0].resolve(created); await h.flush(); assert.equal(h.submissions.length, 1);
    const accepted = { ...h.snapshot, ...displaySnapshot('running'), revision: 1 };
    accepted.conversation = { ...accepted.conversation, id: 'created', title: 'Accepted title' };
    accepted.request = { ...accepted.request, id: h.submissions[0].payload.requestId, conversationId: 'created' };
    h.submissions[0].resolve(accepted); await h.flush();
    if (failure) delayed.reject(Error('old detail load failed')); else delayed.resolve(created);
    await h.flush();
    assert.equal(h.find('button', p => p['aria-label'] === '打开会话 Accepted title').length, 1);
    assert.equal(h.find('button', p => p['aria-label'] === '打开会话 Empty title').length, 0);
    assert.equal(h.find('button', p => p['aria-label'] === '停止后续调用').length, 1);
    assert.equal(h.find('p', p => p.role === 'alert').length, 0); assert.equal(h.submissions.length, 1);
  }
});

test('an idle tab discovers another tab accepted run by read-only storage refresh', async t => {
  let live;
  const h = harness(t, { conversation: () => live }); await h.flush();
  const before = structuredClone(savedDraft(h));
  const accepted = { ...h.snapshot, ...displaySnapshot('running'), revision: 2 };
  live = accepted;
  h.storage.set('ipl.agent.pending-submissions.v1', '[]');
  h.window.dispatchEvent({ type: 'storage', key: 'ipl.agent.pending-submissions.v1' }); await h.flush();
  assert.equal(h.conversationReads.length, 2); assert.equal(h.watchers.length, 1); assert.equal(h.watchers[0].id, accepted.request.id);
  assert.equal(h.submissions.length, 0); assert.equal(h.stops.length, 0); assert.deepEqual(savedDraft(h), before);
  h.hide(); await h.flush(); live = { ...accepted, revision: 3, request: { ...accepted.request, state: 'completed' } };
  h.show(); await h.flush(); h.watchers.at(-1).next(live); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '发送 Agent 消息').length, 1);
  assert.equal(h.conversationReads.length, 2, 'active runs reattach through their observer baseline');
  assert.equal(h.submissions.length, 0); assert.deepEqual(savedDraft(h), before);
});


test('two actual run hooks observe a single accepted cross-tab submission without replaying it or stopping each other', async t => {
  const storage = new Map([['ipl.agent.active-conversation', 'current']]); let live;
  const a = harness(t, { storage, conversation: () => live });
  const b = harness(t, { storage, conversation: () => live }); await a.flush(); await b.flush();
  b.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await b.flush();
  a.window.dispatchEvent({ type: 'storage', key: 'ipl.agent.pending-submissions.v1' }); await a.flush();
  assert.equal(a.find('textarea')[0].disabled, true);
  live = { ...b.snapshot, ...displaySnapshot('running'), revision: 2 };
  live.request.id = b.submissions[0].payload.requestId;
  b.submissions[0].resolve(live); await b.flush();
  a.window.dispatchEvent({ type: 'storage', key: 'ipl.agent.pending-submissions.v1' }); await a.flush();
  assert.equal(a.submissions.length + b.submissions.length, 1);
  assert.equal(a.watchers.at(-1).id, live.request.id); assert.equal(b.watchers.at(-1).id, live.request.id);
  a.unmount(); assert.equal(a.watchers.at(-1).stopped, true); assert.equal(b.watchers.at(-1).stopped, false);
  b.watchers.at(-1).next({ ...live, revision: 3, request: { ...live.request, state: 'completed' } }); await b.flush();
  assert.equal(a.stops.length + b.stops.length, 0); assert.equal(a.late, 0);
});

test('a wrong stop receipt cannot replace the active request or its next draft', async t => {
  const h = harness(t, { snapshot: displaySnapshot('running') }); await h.flush(); const before = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '停止后续调用')[0].onClick(); await h.flush();
  h.stops[0].resolve({ ...h.snapshot, revision: 10, request: { ...h.snapshot.request, id: 'foreign', state: 'stopped' } }); await h.flush();
  assert.equal(h.find('button', p => p['aria-label'] === '停止后续调用').length, 1); assert.deepEqual(savedDraft(h), before);
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /身份不匹配/); assert.equal(h.submissions.length, 0);
});


test('reconciling a historical pending request cannot replace a later selected run even at the same revision', async t => {
  const current = displaySnapshot('running');
  const pending = [{ conversationId: 'current', preserveDraft: true, payload: { requestId: 'old-request', prompt: 'Old prompt', refs: [], params } }];
  const h = harness(t, { snapshot: current, pending }); await h.flush();
  h.find('button', p => p['aria-label'] === '检查原请求状态')[0].onClick(); await h.flush();
  h.requestReads[0].resolve({ ...h.snapshot, request: { ...h.snapshot.request, id: 'old-request', roundId: 'old-round', state: 'completed' } }); await h.flush();
  assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')), []);
  assert.equal(h.watchers.some(watcher => watcher.id === 'old-request'), false);
  h.find('button', p => p['aria-label'] === '停止后续调用')[0].onClick(); await h.flush();
  assert.equal(h.stops[0].id, 'request-current'); assert.equal(h.submissions.length, 0);
});


test('the first explicit send after stop refreshes late metadata revision before its only POST and preserves newer queued draft edits', async t => {
  const pendingRead = deferred(); let reads = 0;
  const h = harness(t, { snapshot: displaySnapshot('stopped', { stopRequested: true }), conversation: () => ++reads === 1 ? undefined : pendingRead.promise }); await h.flush();
  const original = structuredClone(savedDraft(h)); const edit = h.find('textarea')[0].onChange;
  await h.open('添加图片或引用'); h.find('button', p => p['aria-label'] === '从 Library 或画廊选择图片')[0].onClick(); await h.flush();
  const pick = h.find('reference-picker')[0].onSelect;
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 0); assert.equal(h.conversationReads.length, 2);
  assert.equal(h.storage.has('ipl.agent.pending-submissions.v1'), false, 'preflight does not freeze a submission that has not been dispatched');
  edit({ target: { value: 'Newer queued draft', selectionStart: 18 } }); pick([reference('later-file')]); await h.flush();
  const latest = { ...h.snapshot, revision: 27, conversation: { ...h.snapshot.conversation, rounds: h.snapshot.conversation.rounds.map(round => ({ ...round, execution: { phase: 'stopped', timings: { resultProcessingMs: 8 } } })) } };
  pendingRead.resolve(latest); await h.flush(); assert.equal(h.submissions.length, 1);
  const sent = h.submissions[0]; assert.equal(sent.payload.expectedRevision, 27); assert.equal(sent.payload.prompt, original.text);
  assert.deepEqual(sent.payload.refs, original.refs.map(choice => choice.reference)); assert.equal(sent.payload.configRevision, 1);
  assert.equal(sent.payload.authorization.allowImageGeneration, false); assert.equal(sent.payload.parentRoundId, 'r1');
  sent.resolve({ ...latest, request: { ...latest.request, id: sent.payload.requestId, state: 'completed' } }); await h.flush();
  assert.equal(savedDraft(h).text, 'Newer queued draft'); assert.equal(savedDraft(h).refs.length, 2); assert.equal(h.submissions.length, 1);
});

test('post-stop refresh cannot silently submit into a changed branch, target, mask or image binding', async t => {
  for (const change of ['branch', 'target', 'input', 'mask', 'parent']) {
    let latest; const h = harness(t, { snapshot: displaySnapshot('stopped', { stopRequested: true }), conversation: () => latest }); await h.flush();
    const before = structuredClone(savedDraft(h)); latest = structuredClone(h.snapshot); latest.revision = 4;
    if (change === 'branch') latest.conversation.activeRoundId = 'another-leaf';
    if (change === 'target') latest.editingTask = { target: { assetId: 'changed-target' }, auxiliaries: [], requirements: 'new edit', constraints: [] };
    if (change === 'input') latest.conversation.rounds[0].inputImageIds = ['different-input'];
    if (change === 'mask') latest.conversation.rounds[0].maskImageId = 'different-mask';
    if (change === 'parent') latest.conversation.rounds[0].parentRoundId = 'different-parent';
    h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
    assert.equal(h.submissions.length, 0, change); assert.deepEqual(savedDraft(h), before, change);
    assert.equal(h.storage.has('ipl.agent.pending-submissions.v1'), false);
    assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /请确认后再发送/);
  }
});

test('a late post-stop revision read cannot send after switching conversations or unmounting', async t => {
  for (const mode of ['switch', 'unmount']) {
    const pendingRead = deferred(); let reads = 0;
    const h = harness(t, { snapshot: displaySnapshot('stopped', { stopRequested: true }), conversation: id => id === 'current' && ++reads > 1 ? pendingRead.promise : undefined }); await h.flush();
    h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
    if (mode === 'switch') { h.updateProps({ focusConversationId: 'next', focusToken: 1 }); await h.flush(); } else h.unmount();
    pendingRead.resolve({ ...h.snapshot, revision: 30 }); await h.flush();
    assert.equal(h.submissions.length, 0); assert.equal(h.late, 0); assert.equal(h.storage.has('ipl.agent.pending-submissions.v1'), false);
  }
});

test('a real revision conflict refreshes only through GET and requires another explicit send', async t => {
  let latest; const h = harness(t, { conversation: () => latest }); await h.flush(); const before = structuredClone(savedDraft(h));
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush(); assert.equal(h.submissions.length, 1);
  latest = { ...h.snapshot, revision: 9, conversation: { ...h.snapshot.conversation, activeRoundId: 'new-selected-branch' } };
  h.submissions[0].reject(new h.AgentApiError(409, '对话已改变，请重新加载。', 'revision_conflict')); await h.flush();
  assert.equal(h.conversationReads.length, 2); assert.equal(h.submissions.length, 1, 'GET recovery must not replay the rejected POST');
  assert.deepEqual(savedDraft(h), before); assert.deepEqual(JSON.parse(h.storage.get('ipl.agent.pending-submissions.v1')), []);
  assert.match(JSON.stringify(h.find('p', p => p.role === 'alert')), /请确认后再次发送/);
  h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].onClick(); await h.flush();
  assert.equal(h.submissions.length, 2); assert.equal(h.submissions[1].payload.expectedRevision, 9); assert.equal(h.submissions[1].payload.parentRoundId, 'new-selected-branch');
  assert.equal(h.submissions[1].payload.prompt, before.text); assert.deepEqual(h.submissions[1].payload.refs, before.refs.map(choice => choice.reference));
});
