import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as core from '../extensions/browser-capture/core.mjs';
import { ApiError, apiOptions, downloadOptions, downloadPublicImage, localRequest, readBounded } from '../extensions/browser-capture/network.mjs';
import { checkedImage, dataImage, transferredImageURL } from '../extensions/browser-capture/images.mjs';

const pairing = { version: 1, base_url: 'http://127.0.0.1:8013', extension_id: 'a'.repeat(32), instance_id: 'instance_123', client_id: 'client_123', token: 'synthetic-test-token-not-a-real-secret' };
const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const image = { blob: new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3])], { type: 'image/png' }), name: 'capture.png', width: 1, height: 1, source: 'file' };
const draft = () => ({ ...core.emptyCard(), image, prompt: '  原始提示词\r\n第二行\n\n', language: 'auto' });

test('automatic save needs a completed drop/paste, decoded image, prompt and connection', () => {
  for (const event of ['typing', 'choose', 'language', 'restore', 'tab-switch', 'connect']) assert.equal(core.shouldAutoSave(draft(), { event, connected: true }), false);
  for (const event of ['paste', 'drop']) assert.equal(core.shouldAutoSave(draft(), { event, connected: true }), true);
  for (const options of [{ connected: false }, { connected: true, reading: true }, { connected: true, composing: true }]) assert.equal(core.shouldAutoSave(draft(), { event: 'paste', ...options }), false);
  assert.equal(core.canSave({ ...draft(), image: null }, true), false);
  assert.equal(core.canSave({ ...draft(), prompt: ' \n ' }, true), false);
});

test('frozen request survives uncertain result and retains image bytes, raw text, identity and ID', async () => {
  const frozen = core.freezeCard(draft(), pairing, () => requestId);
  const restored = structuredClone(core.failCard(frozen, 503, 'uncertain'));
  const retried = core.freezeCard(restored, { ...pairing, base_url: 'http://localhost:9999' }, () => assert.fail('must not allocate another ID'));
  assert.deepEqual(retried.frozen, restored.frozen);
  assert.equal(retried.frozen.client_id, pairing.client_id);
  const body = core.captureBody(retried.frozen);
  assert.equal(body.get('prompt_text_json'), JSON.stringify(draft().prompt));
  assert.equal(body.get('request_id'), requestId);
  assert.deepEqual(await body.get('file').arrayBuffer(), await image.blob.arrayBuffer());
  assert.equal(core.sameTarget(retried.frozen, { ...pairing, client_id: 'different_client' }), false);
});

test('success removes original and prompt buffer, duplicate events cannot submit, next starts empty', () => {
  const frozen = core.freezeCard(draft(), pairing, () => requestId);
  const saved = core.completeCard(frozen, { request_id: requestId, item_id: 'item_1' }, new Blob(['thumb']));
  assert.equal(saved.image, null);
  assert.equal(saved.prompt, '');
  assert.equal(saved.frozen, null);
  assert.equal(saved.receipt.item_id, 'item_1');
  assert.equal(core.shouldAutoSave(saved, { event: 'paste', connected: true }), false);
  assert.throws(() => core.freezeCard(saved, pairing));
  assert.equal(core.canSave(core.emptyCard(), true), false);
});

test('only definitive validation failures unlock content; auth/server/conflict failures retain request', () => {
  const frozen = core.freezeCard(draft(), pairing, () => requestId);
  for (const status of [400,413,415,422]) assert.equal(core.failCard(frozen, status, 'error').frozen, null);
  for (const status of [undefined,401,403,409,429,500,503]) assert.equal(core.failCard(frozen, status, 'error').frozen.request_id, requestId);
});

test('pairing validates local target, actual extension, instance and client identity', () => {
  assert.deepEqual(core.parsePairing(JSON.stringify(pairing), pairing.extension_id, pairing.base_url), pairing);
  for (const base of ['https://example.com', 'http://127.0.0.2:8013', 'http://localhost:8013/path', 'http://user:password@localhost:8013', 'http://localhost:8013/?key=bad']) assert.throws(() => core.parseLocalBase(base));
  for (const invalid of [{ ...pairing, client_id: '' }, { ...pairing, extension_id: 'b'.repeat(32) }, { ...pairing, token: 'bad\nheader' }]) assert.throws(() => core.parsePairing(JSON.stringify(invalid), pairing.extension_id, pairing.base_url));
  assert.throws(() => core.parsePairing(JSON.stringify(pairing), pairing.extension_id, 'http://127.0.0.1:8000'));
});

test('public URL rejects local/private IPs, nonweb URLs and embedded credentials', () => {
  for (const url of ['http://localhost/a.png', 'http://127.0.0.1/a', 'http://2130706433/a', 'http://10.1.2.3/a', 'http://172.20.0.1/a', 'http://192.168.1.1/a', 'http://169.254.169.254/a', 'http://100.64.0.1/a', 'http://[::1]/a', 'http://service.internal/a', 'file:///a.png', 'https://user:pass@example.com/a', 'https://example.com:8000/a']) assert.throws(() => core.publicImageURL(url), url);
  assert.equal(core.publicImageURL('https://cdn.example.com/image.png#fragment'), 'https://cdn.example.com/image.png');
});

test('image network and local API credentials are separated, redirects and cookies disabled', async () => {
  const local = apiOptions(pairing, { method: 'POST' });
  assert.equal(local.headers['X-Capture-Token'], pairing.token);
  assert.equal(local.redirect, 'error');
  assert.equal(local.credentials, 'omit');
  const download = downloadOptions(new AbortController().signal);
  assert.equal(JSON.stringify(download).includes(pairing.token), false);
  assert.equal(Object.keys(download.headers).some(key => /token|authorization|instance/i.test(key)), false);
  assert.equal(download.redirect, 'error');
  assert.equal(download.credentials, 'omit');
  let count = 0;
  await assert.rejects(() => localRequest(pairing, '/api/providers', {}, () => { count++; }), /其他接口/);
  assert.equal(count, 0);
  await assert.rejects(() => localRequest(pairing, '/api/captures', { method: 'POST' }, async () => { count++; throw new Error('secret server details'); }), /结果尚未确认/);
  assert.equal(count, 1, 'capture POST never loops or retries itself');
});

test('bounded response streaming rejects declared and actual oversized data', async () => {
  await assert.rejects(() => readBounded(new Response('abc', { headers: { 'content-length': '100' } }), 5));
  await assert.rejects(() => readBounded(new Response('abcdef'), 5));
  assert.deepEqual(Array.from(await readBounded(new Response('abc'), 5)), [97,98,99]);
});

test('public image download returns bytes without pairing headers; errors do not expose URLs', async () => {
  let options;
  const blob = await downloadPublicImage('https://images.example.com/private-token-url.png', async (_, opts) => { options = opts; return new Response(image.blob, { headers: { 'content-type': 'image/png' } }); });
  assert.deepEqual(await blob.arrayBuffer(), await image.blob.arrayBuffer());
  assert.equal(options.credentials, 'omit');
  assert.equal(Object.keys(options.headers).length, 1);
  await assert.rejects(() => downloadPublicImage('https://images.example.com/private-token-url.png', async () => { throw new Error('private-token-url'); }), error => !error.message.includes('private-token-url'));
});

test('manifest requests only used capabilities; network access is optional and secrets never sync', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extensions/browser-capture/manifest.json', import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['activeTab','scripting','sidePanel','storage'].sort());
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.action.default_popup, undefined);
});

test('HTML relative image uses the absolute URI from the same transfer; multiple images are refused', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ set innerHTML(html) { this.html = html; }, content: { querySelectorAll: () => [] } }) };
  let sources = ['/images/preview.png'];
  globalThis.document.createElement = () => ({ content: { querySelectorAll: () => sources.map(src => ({ getAttribute: () => src })) } });
  const transfer = values => ({ getData: type => values[type] || '' });
  try {
    assert.equal(transferredImageURL(transfer({ 'text/html': '<img src="/images/preview.png">', 'text/uri-list': 'https://cdn.example.com/preview.png' })), 'https://cdn.example.com/preview.png');
    assert.throws(() => transferredImageURL(transfer({ 'text/html': '<img src="/images/preview.png">' })), /绝对/);
    sources = ['https://cdn.example.com/one.png', 'https://cdn.example.com/two.png'];
    assert.throws(() => transferredImageURL(transfer({ 'text/html': '<img><img>' })), /多张/);
    sources = ['data:image/png;base64,AAAA'];
    assert.equal(transferredImageURL(transfer({ 'text/html': '<img>', 'text/plain': 'do not paste this as prompt' })), sources[0]);
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('image intake invokes decode, retains every original byte and enforces backend pixel limit', async () => {
  const previous = globalThis.createImageBitmap;
  let calls = 0;
  globalThis.createImageBitmap = async () => { calls++; return { width: 32, height: 48, close() {} }; };
  try {
    const checked = await checkedImage(image.blob, 'original.png', 'clipboard');
    assert.equal(calls, 1);
    assert.deepEqual(await checked.blob.arrayBuffer(), await image.blob.arrayBuffer());
    assert.equal(checked.source, 'clipboard');
    globalThis.createImageBitmap = async () => ({ width: 4096, height: 4096, close() {} });
    await assert.rejects(() => checkedImage(image.blob), /1,600/);
    globalThis.createImageBitmap = async () => { throw new Error('invalid compressed data'); };
    await assert.rejects(() => checkedImage(image.blob), /无法解码/);
    await assert.rejects(() => checkedImage(new Blob(['<html>not an image</html>'])), /真实/);
    await assert.rejects(() => checkedImage(new Blob([])), /不能为空/);
  } finally { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; }
});

test('percent-encoded binary data image preserves non-UTF8 octets and literal plus bytes', async () => {
  const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0,255,128,43,37]);
  const data = 'data:image/png,%89PNG%0D%0a%1A%0A%00%ff%80+%25';
  assert.deepEqual(new Uint8Array(await (await dataImage(data)).arrayBuffer()), bytes);
  const base64 = `data:image/png;BASE64,${Buffer.from(bytes).toString('base64')}`;
  assert.deepEqual(new Uint8Array(await (await dataImage(base64)).arrayBuffer()), bytes);
  for (const malformed of ['data:image/png,%89%GG', 'data:image/png,%89%8', 'data:image/png,', 'data:image/png,未编码']) {
    await assert.rejects(() => dataImage(malformed), /无法解码/);
  }
});

// This adapter executes the production event handlers and asynchronous queue, not
// OS drag/drop or Chrome sidePanel APIs. Native browser acceptance is documented separately.
class Element {
  constructor(id, document) { this.id = id; this.document = document; this.value = ''; this.hidden = false; this.disabled = false; this.listeners = {}; this.classList = { add() {}, remove() {}, toggle() {} }; this.selectionStart = this.selectionEnd = 0; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {}, ...extra }); }
  setAttribute() {}
  removeAttribute() {}
  closest() { return null; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  click() { this.emit('click'); }
}
async function panelHarness({ initial, disconnected = false, postFailure, persistDelay = 0, receiptExists = false, imageDelay = 5, editorAvailable = true, transferError = false } = {}) {
  const document = { elements: {}, listeners: {}, activeElement: null, getElementById(id) { return this.elements[id] ||= new Element(id, this); }, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, emit(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ target: this.getElementById('image-target'), preventDefault() {}, ...extra }); } };
  let stored = initial ? structuredClone(initial) : undefined;
  let posts = 0;
  let receipts = 0;
  let failed = false;
  const posted = [];
  let savedConfig = disconnected ? null : { ...pairing };
  let releasePage;
  const lockQueues = new Map();
  const navigator = { locks: { request(name, options, callback) {
    const fn = callback || options;
    if (name === 'ipl-capture-editor') return fn(editorAvailable ? { name } : null);
    const result = (lockQueues.get(name) || Promise.resolve()).then(() => fn({ name }));
    lockQueues.set(name, result.catch(() => {}));
    return result;
  } }, clipboard: { writeText: async () => {} } };
  const window = { addEventListener(type, fn) { if (type === 'pagehide') releasePage = fn; } };
  const chrome = { runtime: { id: pairing.extension_id }, tabs: { create() {} } };
  const fakeRequest = async (_, path, options) => {
    if (path.endsWith('/connection')) return { instance_id: pairing.instance_id, client_id: pairing.client_id };
    if (path.endsWith('/detect-language')) return { language: 'und', uncertain: true };
    if (path.includes('/receipts/')) { receipts++; if (!receiptExists) throw new ApiError(404); return { request_id: stored.frozen.request_id, item_id: 'recovered_item' }; }
    posts++;
    posted.push({ prompt: JSON.parse(options.body.get('prompt_text_json')), request_id: options.body.get('request_id'), blob: options.body.get('file') });
    if (postFailure && !failed) { failed = true; throw new ApiError(postFailure === 'network' ? undefined : postFailure); }
    return { request_id: options.body.get('request_id'), item_id: `item_${posts}` };
  };
  const dependencies = {
    ...core, freezeCard: (card, config) => core.freezeCard(card, config, randomUUID), readCard: async () => structuredClone(stored), writeCard: async next => { if (persistDelay) await new Promise(resolve => setTimeout(resolve, persistDelay)); stored = structuredClone(next); },
    readConfig: async () => savedConfig, writeConfig: async next => { savedConfig = next; },
    localRequest: fakeRequest, ApiError, grantHost: async () => true, downloadPublicImage: async () => image.blob, pageImage: async () => image.blob,
    checkedImage: async blob => { await new Promise(resolve => setTimeout(resolve, imageDelay)); return { ...image, blob }; }, dataImage: async () => image.blob,
    transferredImageURL: () => { if (transferError) throw new Error('这次投递包含多张图片'); return null; }, thumbnail: async () => new Blob(['thumb']),
    document, window, navigator, chrome, BroadcastChannel: class { postMessage() {} addEventListener() {} close() {} }, confirm: () => true,
  };
  const source = (await readFile(new URL('../extensions/browser-capture/sidepanel.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  await new AsyncFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
  return {
    document, get: id => document.getElementById(id), state: () => stored, posts: () => posts, receipts: () => receipts, posted,
    close: () => releasePage?.(),
    paste({ file, text = '', intoPrompt = false } = {}) {
      const target = document.getElementById(intoPrompt ? 'prompt' : 'image-target');
      if (intoPrompt) { document.activeElement = target; target.selectionStart = target.selectionEnd = target.value.length; }
      document.emit('paste', { target, clipboardData: { files: file ? [file] : [], getData: type => type === 'text/plain' ? text : '' } });
    },
  };
}
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('event did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('actual sidepanel handlers accept either order, save once and clear both fields for next card', async () => {
  for (const imageFirst of [true, false]) {
    const panel = await panelHarness();
    if (imageFirst) { panel.paste({ file: image.blob }); await until(() => panel.state()?.image); panel.paste({ text: '  简体原文\n第二行  ' }); }
    else { panel.paste({ text: '  简体原文\n第二行  ' }); await until(() => panel.state()?.prompt); panel.paste({ file: image.blob }); }
    await until(() => panel.state()?.status === 'saved');
    assert.equal(panel.posts(), 1);
    assert.equal(panel.posted[0].prompt, '  简体原文\n第二行  ');
    panel.paste({ text: 'another event' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(panel.posts(), 1);
    panel.get('continue').click();
    await until(() => panel.state()?.status === 'draft');
    assert.equal(panel.state().prompt, '');
    assert.equal(panel.state().image, null);
    panel.paste({ file: image.blob });
    await until(() => panel.state()?.image);
    assert.equal(panel.posts(), 1, 'previous prompt must never pair with next image');
    panel.paste({ text: 'second original' });
    await until(() => panel.posts() === 2 && panel.state()?.status === 'saved');
    assert.equal(panel.posted[1].prompt, 'second original');
    panel.close();
  }
});

test('typing and IME keep newest DOM text during slow storage and never auto-save', async () => {
  const panel = await panelHarness({ initial: { ...core.emptyCard(), image }, persistDelay: 15 });
  const prompt = panel.get('prompt');
  panel.document.activeElement = prompt;
  prompt.emit('compositionstart');
  for (const text of ['中', '中文', '中文输入法\n完整原文']) { prompt.value = text; prompt.emit('input'); }
  prompt.emit('compositionend');
  await until(() => panel.state()?.prompt === '中文输入法\n完整原文');
  assert.equal(prompt.value, '中文输入法\n完整原文');
  assert.equal(panel.posts(), 0);
  panel.document.emit('keydown', { target: prompt, ctrlKey: true, key: 'Enter', isComposing: true });
  assert.equal(panel.posts(), 0);
  panel.document.emit('keydown', { target: prompt, ctrlKey: true, key: 'Enter', isComposing: false });
  await until(() => panel.state()?.status === 'saved');
  assert.equal(panel.posts(), 1);
  assert.equal(panel.posted[0].prompt, '中文输入法\n完整原文');
  panel.close();
});

test('offline paste keeps draft; reconnect alone does not auto-save', async () => {
  const panel = await panelHarness({ disconnected: true });
  panel.paste({ file: image.blob });
  await until(() => panel.state()?.image);
  panel.paste({ text: 'the original text' });
  await until(() => panel.state()?.prompt);
  assert.equal(panel.posts(), 0);
  assert.equal(panel.state().image.blob.size, image.blob.size);
  panel.close();
});

test('uncertain submit restored in a new panel never auto-posts; receipt recovery clears original', async () => {
  const panel = await panelHarness({ initial: draft(), postFailure: 'network' });
  panel.get('save').click();
  await until(() => panel.state()?.status === 'uncertain');
  const persisted = structuredClone(panel.state());
  assert.equal(panel.posts(), 1);
  assert.equal(persisted.frozen.request_id, panel.posted[0].request_id);
  panel.close();
  const restored = await panelHarness({ initial: persisted, receiptExists: true });
  assert.equal(restored.posts(), 0);
  assert.equal(restored.receipts(), 0);
  restored.get('save').click();
  await until(() => restored.state()?.status === 'saved');
  assert.equal(restored.posts(), 0);
  assert.equal(restored.receipts(), 1);
  assert.equal(restored.state().receipt.item_id, 'recovered_item');
  assert.equal(restored.state().image, null);
  restored.close();
});

test('receipt absent after lost response retries identical request and frozen content once', async () => {
  const initial = core.failCard(core.freezeCard(draft(), pairing, () => requestId), undefined, 'uncertain');
  const panel = await panelHarness({ initial });
  panel.get('save').click();
  panel.get('save').click();
  await until(() => panel.state()?.status === 'saved');
  assert.equal(panel.posts(), 1);
  assert.equal(panel.posted[0].request_id, requestId);
  assert.equal(panel.posted[0].prompt, draft().prompt);
  panel.close();
});

test('draft whose frozen client identity differs cannot be resubmitted under a new pairing', async () => {
  const initial = core.failCard(core.freezeCard(draft(), { ...pairing, client_id: 'old_client' }, () => requestId), undefined, 'uncertain');
  const panel = await panelHarness({ initial });
  panel.get('save').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(panel.posts(), 0);
  assert.equal(panel.receipts(), 0);
  assert.equal(panel.state().frozen.client_id, 'old_client');
  assert.match(panel.get('error').textContent, /原配对/);
  panel.close();
});

test('clearing during slow image read invalidates pending auto-save before queued clear', async () => {
  const panel = await panelHarness({ initial: { ...core.emptyCard(), prompt: 'existing prompt' }, imageDelay: 50 });
  panel.paste({ file: image.blob });
  await new Promise(resolve => setTimeout(resolve, 10));
  panel.get('discard').click();
  await until(() => panel.state()?.status === 'draft' && panel.state().prompt === '' && !panel.state().image);
  assert.equal(panel.posts(), 0);
  panel.close();
});

test('second window without the editor lease cannot edit or submit the current card', async () => {
  const panel = await panelHarness({ initial: draft(), editorAvailable: false });
  panel.paste({ text: 'must not replace original' });
  panel.get('save').click();
  panel.get('discard').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(panel.state().prompt, draft().prompt);
  assert.equal(panel.posts(), 0);
  assert.equal(panel.get('prompt').disabled, true);
  assert.match(panel.get('error').textContent, /另一窗口/);
  panel.close();
});

test('HTML transfer error is displayed, prevents default paste and keeps existing card intact', async () => {
  const panel = await panelHarness({ initial: draft(), transferError: true });
  let prevented = false;
  panel.document.emit('paste', { clipboardData: { files: [], getData: () => '' }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(panel.state().prompt, draft().prompt);
  assert.equal(panel.posts(), 0);
  assert.match(panel.get('error').textContent, /多张图片/);
  panel.close();
});

test('all language choices preserve the exact text and detection completion never submits', async () => {
  for (const text of ['简体中文提示词', 'the soft light in a forest', '繁體中文提示詞', '中文 mixed English', '...']) {
    const panel = await panelHarness({ initial: { ...core.emptyCard(), image } });
    panel.paste({ text });
    await until(() => panel.state()?.status === 'saved');
    assert.equal(panel.posts(), 1);
    assert.equal(panel.posted[0].prompt, text);
    panel.close();
  }
  const panel = await panelHarness({ initial: draft() });
  await new Promise(resolve => setTimeout(resolve, 10));
  panel.get('language').value = 'zh_hant';
  panel.get('language').emit('change');
  await until(() => panel.state()?.language === 'zh_hant');
  assert.equal(panel.posts(), 0);
  assert.equal(panel.state().prompt, draft().prompt);
  panel.close();
});

test('a persisted submitting card is recovered without replay and revoked auth retains frozen content', async () => {
  const initial = core.freezeCard(draft(), pairing, () => requestId);
  const panel = await panelHarness({ initial, postFailure: 403 });
  assert.equal(panel.posts(), 0);
  panel.get('save').click();
  await until(() => panel.state()?.status === 'uncertain');
  assert.equal(panel.state().frozen.request_id, requestId);
  assert.equal(panel.state().frozen.prompt, draft().prompt);
  assert.equal(panel.get('save').disabled, true);
  panel.close();
});
