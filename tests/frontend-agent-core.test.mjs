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
const workspaceJs = await compile('../frontend/src/components/agent/AgentWorkspace.tsx');
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(t) {
  const slots = [], effects = [], timers = new Map(), calls = [], listeners = new Map();
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
    window: { addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener: name => listeners.delete(name) },
    localStorage: { getItem: key => key === 'ipl.agent.active-conversation' ? 'current' : null, setItem() {}, removeItem() {} },
    location: { origin: 'http://isolated.test' },
  };
  let configReads = 0;
  let config = { revision: 1, config: { apiConfigMode: 'hybrid', maxToolRounds: 5, maxImageJobs: 2, webSearch: false }, ready: true, issues: [], imageReady: false, imageIssues: [{ message: '图片配置已移除' }], profiles: [], capabilities: { maxInputImages: 4 } };
  const snapshot = { conversation: { id: 'current', title: 'Open conversation', rounds: [], messages: [] }, revision: 1, request: null, jobs: [], images: [] };
  const agentApi = {
    conversations(cursor, signal, query) { const reply = deferred(); calls.push({ cursor, signal, query, ...reply }); return reply.promise; },
    conversation: async id => ({ ...snapshot, conversation: { ...snapshot.conversation, id } }),
  };
  const client = { agentApi, getAgentConfig: async () => { configReads++; return config; } };
  const list = instantiate(listJs, { react: hooks, '../../api/agentClient': client }, globalMocks);
  const deps = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../../api/client': { api: {}, mediaUrl: p => p }, '../../api/agentClient': client,
    './useAgentConversations': list, './AgentMarkdown': { AgentMarkdown: 'markdown' }, './AgentWorkspace.css': {},
    '../../utils/playground/agentConversationState': { getActiveAgentRounds: () => [] },
    '../../utils/playground/agentAssistantBlocks': { isAgentRequestActive: () => false },
    '../../utils/playground/agentImageReferences': { referenceKey: ref => ref.uploadId },
    '../../utils/playground/agentSubmission': {
      readAgentDrafts: () => ({ current: { text: 'Keep my draft', refs: [{ reference: { kind: 'upload', uploadId: 'u1' }, url: 'http://isolated.test/img.png', label: 'original.png' }], params: { size: 'auto', quality: 'auto', output_format: 'png', background: 'auto' }, editId: null } }),
      readPendingAgentSubmissions: () => [],
    },
    '../../utils/compatibleRecipe': { COMPATIBLE_SIZE_OPTIONS: [], IMAGE25_QUALITIES: [] },
    '../../utils/localPreferences': { readLocalPreferences: () => ({ persistInputOnRestart: true }) },
    '../../utils/clipboard': {}, './AgentReferencePicker': {},
  };
  const Component = instantiate(workspaceJs, deps, globalMocks).default;
  let active = true;
  const render = () => { dirty = false; cursor = 0; tree = Component({ active, onOpenSettings() {} }); effects.splice(0).forEach(fn => fn()); };
  const flush = async (runTimers = true) => { for (let i = 0; i < 16; i++) { if (dirty && !unmounted) render(); if (runTimers) { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()); } await Promise.resolve(); } };
  const find = (type, predicate = () => true) => nodes(tree).filter(n => n.type === type && predicate(n.props)).map(n => n.props);
  const unmount = () => { if (unmounted) return; unmounted = true; slots.forEach(slot => slot?.cleanup?.()); };
  render(); t.after(unmount);
  return { calls, find, flush, unmount, setConfig(value) { config = { ...config, ...value }; }, show() { active = true; render(); }, get late() { return late; }, get configReads() { return configReads; }, hide() { active = false; render(); } };
}
const row = id => ({ id, title: `Title ${id}`, updatedAt: 10, roundCount: 2 });
const result = (ids, nextCursor = null) => ({ conversations: ids.map(row), nextCursor });

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
  assert.equal(h.find('input', p => p.type === 'checkbox')[0].disabled, true);
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
  h.find('input', p => p.type === 'checkbox')[0].onChange({ target: { checked: true } }); await h.flush();
  assert.equal(h.find('input', p => p.type === 'checkbox')[0].checked, true);
  h.hide(); h.setConfig({ imageReady: false, imageIssues: [{ message: 'Removed image profile' }] }); h.show(); await h.flush();
  assert.equal(h.find('input', p => p.type === 'checkbox')[0].checked, false);
  assert.equal(h.find('button', p => p['aria-label'] === '发送 Agent 消息')[0].disabled, false);
  assert.equal(h.find('textarea')[0].value, 'Keep my draft');
  assert.equal(h.find('img')[0].src, 'http://isolated.test/img.png');
});
