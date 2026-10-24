import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/components/ConfigPanel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

// Run the production component effects and keyboard callback. The DOM fixture
// rejects focus during hidden motion, as browsers do, without model/API calls.
function harness(t, options = {}) {
  const slots = [], effects = [], frames = new Map();
  let cursor = 0, dirty = false, tree, frameId = 0, closed = 0, open = false;
  const doc = { body: { style: {}, }, activeElement: null, querySelectorAll: () => [] };
  class Element {
    constructor(name) { this.name = name; this.isConnected = true; this.listeners = new Map(); this.focusAttempts = 0; }
    addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
    removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
    emit(name, target = this) { this.listeners.get(name)?.forEach(handler => handler({ target })); }
    focus() { this.focusAttempts++; if (drawer.visible) doc.activeElement = this; }
    contains(element) { return element === this || element?.owner === this; }
    closest() { return this.owner || null; }
    getAttribute(name) { return name === 'aria-hidden' ? 'false' : null; }
    scrollIntoView() {}
  }
  const drawer = new Element('drawer'); drawer.visible = false;
  const closeButton = new Element('close'); closeButton.owner = drawer;
  const providers = new Element('providers'); providers.owner = drawer;
  const editor = new Element('editor'); editor.owner = drawer;
  doc.activeElement = doc.body;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) { effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); slots[i] = { deps }; } },
    useCallback(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) slots[i] = { deps, value: fn }; return slots[i].value; },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const jsx = (type, props) => {
    if (props.ref) props.ref.current = props.id === 'config-drawer' ? drawer : props.className === 'panel-close' ? closeButton : props.className === 'setting-group provider-section' ? providers : { scrollTop: 0 };
    return { type, props };
  };
  const api = { config: async () => ({}), generationProviders: async () => [] };
  const deps = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../api/client': { api, isDemoMode: false }, '../hooks/useModalFocus': { restoreFocusAfterMotion: () => () => {} },
    '../utils/i18n': { UI_LANGUAGE_LABELS: {} }, '../utils/prompts': { getPromptCopyLanguageLabel: value => value },
    '../utils/localPreferences': { readLocalPreferences: () => ({}), saveLocalPreferences: () => true }, './ConfigPanel.css': {},
  };
  for (const path of ['./OpenAICompatibleSettings', './BrowserCaptureSettings', './CaptureOrganizerSettings', './settings/GeneralSettings', './settings/AgentSettings']) deps[path] = { default: 'stub' };
  const win = { requestAnimationFrame: cb => { frames.set(++frameId, cb); return frameId; }, cancelAnimationFrame: id => frames.delete(id), matchMedia: () => ({ matches: false }) };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'document', 'location', 'HTMLElement', compiled)(name => { assert.ok(name in deps, name); return deps[name]; }, module, module.exports, win, doc, { search: '' }, Element);
  const Component = module.exports.default;
  const tLabel = key => key;
  const render = () => { dirty = false; cursor = 0; tree = Component({ open, focusProviders: options.focusProviders, focusSection: options.focusSection, t: tLabel, onClose: () => { closed++; }, uiLanguage: 'zh_hans', preferredLanguage: 'origin', appearance: 'pure_white', defaultAiProvider: 'openai_compatible' }); effects.splice(0).forEach(effect => effect()); };
  const flush = async () => { for (let i = 0; i < 10; i++) { if (dirty) render(); await Promise.resolve(); } };
  const all = node => node && typeof node === 'object' ? [node, ...[node.props?.children].flat(Infinity).flatMap(all)] : [];
  render();
  t.after(() => slots.forEach(slot => slot?.cleanup?.()));
  return { doc, drawer, closeButton, providers, editor, Element, flush, get closed() { return closed; }, get pendingFrames() { return frames.size; }, show() { open = true; render(); }, hide() { open = false; render(); }, runFrames() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); }, key(event) { all(tree).find(node => node.props?.id === 'config-drawer').props.onKeyDown(event); } };
}

test('production settings drawer retries rejected first-frame focus when opening motion ends and Escape can close it', async t => {
  const h = harness(t, { focusSection: 'agent' }); await h.flush(); h.show(); await h.flush();
  h.runFrames(); assert.equal(h.closeButton.focusAttempts, 1); assert.equal(h.doc.activeElement, h.doc.body);
  h.drawer.visible = true; h.drawer.emit('transitionend');
  assert.equal(h.doc.activeElement, h.closeButton);
  let prevented = false; h.key({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.closed, 1);
});

test('settings focus retry preserves an existing user focus and ignores descendant or late closing motion', async t => {
  const h = harness(t); await h.flush(); h.show(); await h.flush(); h.runFrames();
  h.drawer.visible = true; h.drawer.emit('transitionend', h.editor);
  assert.equal(h.doc.activeElement, h.doc.body);
  h.doc.activeElement = h.editor; h.drawer.emit('transitionend');
  assert.equal(h.doc.activeElement, h.editor); assert.equal(h.closeButton.focusAttempts, 1);
  h.hide(); await h.flush(); h.doc.activeElement = h.doc.body;
  h.drawer.emit('transitionend'); h.drawer.emit('animationend');
  assert.equal(h.doc.activeElement, h.doc.body); assert.equal(h.pendingFrames, 0);
});

test('provider shortcut focuses its section and opening motion does not steal focus from another modal', async t => {
  const h = harness(t, { focusProviders: true }); await h.flush(); h.drawer.visible = true; h.show(); await h.flush(); h.runFrames();
  assert.equal(h.doc.activeElement, h.providers);
  const otherModal = new h.Element('other dialog'), otherField = new h.Element('other input'); otherField.owner = otherModal;
  h.doc.activeElement = otherField; h.drawer.emit('animationend');
  assert.equal(h.doc.activeElement, otherField);
});
