import { emptyCard, isLocked, canSave, shouldAutoSave, freezeCard, failCard, completeCard, parseLocalBase, parsePairing, sameTarget, permissionPattern, publicImageURL, captureBody, LANGUAGES } from './core.mjs';
import { readCard, writeCard, readConfig, writeConfig } from './storage.mjs';
import { localRequest, ApiError, grantHost, downloadPublicImage, pageImage } from './network.mjs';
import { checkedImage, dataImage, transferredImageURL, thumbnail } from './images.mjs';

const $ = id => document.getElementById(id);
let card = emptyCard();
let config = null;
let connected = false;
let connecting = false;
let connectionCheckQueued = false;
let connectionError = '';
let connectionFeedbackVisible = false;
let reading = false;
let busy = false;
let composing = false;
let pendingURL = null; // URL strings are not images and are not persisted as acquired originals.
let operation = Promise.resolve();
let inputGeneration = 0;
let detectionGeneration = 0;
let imageObjectURL = null;
let savedObjectURL = null;
let renderedBlob = null;
let renderedThumbnail = null;
let ownsEditor = false;
let releaseEditor = () => {};
const channel = new BroadcastChannel('image-prompt-library-capture');
const languages = { zh_hans: '简体中文', zh_hant: '繁體中文', en: 'English', und: '不确定 / 混合文本' };

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message || !$('settings').hidden;
  $('pairing-error').textContent = message;
  $('pairing-error').hidden = !message;
}
function enqueue(action) {
  operation = operation.then(action).catch(error => { showError(error.message || '操作未完成，草稿仍保留。'); });
  return operation;
}
async function store(next) {
  next.revision = (card.revision || 0) + 1;
  await writeCard(next); // Durable state always precedes any capture POST.
  card = next;
  channel.postMessage('changed');
}
async function edit(update) {
  if (!ownsEditor) return;
  await navigator.locks.request('image-prompt-library-capture', async () => {
    card = await readCard() || emptyCard();
    if (isLocked(card)) { render(); return; }
    await store({ ...update(card), error: '' });
    render();
  });
}
function render() {
  const locked = isLocked(card) || !ownsEditor;
  const saved = card.status === 'saved';
  $('editor').hidden = saved;
  $('success').hidden = !saved;
  $('save').hidden = saved;
  $('save-hint').hidden = saved;
  $('discard').hidden = saved;
  $('prompt').disabled = locked || busy;
  $('language').disabled = locked || busy;
  $('image-target').disabled = locked || busy || reading;
  $('file-input').disabled = locked || busy || reading;
  // IndexedDB writes can finish after another keystroke/composition event. Never
  // replace an active, editable textarea with an older persisted snapshot.
  if ((document.activeElement !== $('prompt') || locked || saved) && $('prompt').value !== card.prompt) $('prompt').value = card.prompt;
  $('language').value = card.language;
  $('connection-status').textContent = connecting ? '正在检查配对…' : connected ? `已连接 · ${config.base_url}` : config ? '未连接 / 授权待检查' : '尚未配对本地图库';
  $('connection-status').className = connected ? 'connected' : '';
  $('pairing-status').textContent = connecting ? '正在检查配对，请稍候…' : connected ? `已连接 · ${config.base_url}` : '未连接';
  $('connect').textContent = connecting ? '正在连接…' : '连接图库';
  $('reconnect').disabled = connecting || connectionCheckQueued;
  $('connection-feedback').hidden = !connectionFeedbackVisible;
  const checking = connecting || connectionCheckQueued;
  $('connection-feedback').className = `connection-feedback${checking ? '' : connectionError ? ' connection-feedback-failed' : connected ? ' connection-feedback-connected' : ''}`;
  const feedbackTitle = checking ? '正在连接图库…' : connectionError ? '连接失败' : connected ? '已连接图库' : '尚未连接图库';
  const feedbackDetail = connecting ? '正在检查本地地址与配对授权，请稍候。' : connectionCheckQueued ? '等待当前操作完成后检查连接，请稍候。' : connectionError || (connected ? `${config.base_url} · 可以继续收录。连接本身不会保存当前卡片。` : '请在连接设置中粘贴图库提供的配对包。');
  // Ordinary typing also renders the card. Do not re-announce unchanged status.
  if ($('connection-feedback-title').textContent !== feedbackTitle) $('connection-feedback-title').textContent = feedbackTitle;
  if ($('connection-feedback-detail').textContent !== feedbackDetail) $('connection-feedback-detail').textContent = feedbackDetail;
  const image = card.image;
  if (renderedBlob !== image?.blob) {
    if (imageObjectURL) URL.revokeObjectURL(imageObjectURL);
    imageObjectURL = image?.blob ? URL.createObjectURL(image.blob) : null;
    if (imageObjectURL) $('image-preview').src = imageObjectURL;
    else $('image-preview').removeAttribute('src');
    renderedBlob = image?.blob;
  }
  $('image-preview').hidden = !image;
  $('image-placeholder').hidden = Boolean(image);
  $('image-replace').hidden = !image || locked;
  $('image-target').classList.toggle('has-image', Boolean(image));
  $('image-info').textContent = image ? `${image.width} × ${image.height} · ${(image.blob.size / 1024 / 1024).toFixed(2)} MB · ${image.source === 'file' ? '原始文件字节' : image.source === 'clipboard' ? '剪贴板提供的图片字节，不保证是平台下载原图' : '网页提供的可访问图片版本，不保证是平台原图'}` : '保留取得的原始字节，支持 PNG、JPEG、WebP、GIF，最大 30 MB。';
  $('url-actions').hidden = !pendingURL || locked;
  $('download-image').hidden = Boolean(pendingURL?.startsWith('blob:'));
  const thumb = card.receipt?.thumbnail;
  if (renderedThumbnail !== thumb) {
    if (savedObjectURL) URL.revokeObjectURL(savedObjectURL);
    savedObjectURL = thumb ? URL.createObjectURL(thumb) : null;
    if (savedObjectURL) $('saved-preview').src = savedObjectURL;
    else $('saved-preview').removeAttribute('src');
    renderedThumbnail = thumb;
  }
  $('saved-preview').hidden = !thumb;
  $('save').disabled = !ownsEditor || busy || reading || Boolean(pendingURL) || !connected || (!card.frozen && !canSave(card, connected));
  $('save').textContent = busy ? '保存中…' : card.frozen ? '恢复回执 / 重试原请求' : '保存到图库';
  $('status').textContent = saved ? '已保存' : busy ? '保存中…' : reading ? '正在读取和检查图片…' : card.frozen ? '结果未确认 · 原请求和图文已锁定保留' : !image ? '等待图片' : !card.prompt.trim() ? '等待提示词' : !connected ? '图文已保留 · 等待连接图库' : '图文已就绪 · 可手动保存';
  for (const id of ['connect', 'disconnect', 'clear-permissions', 'discard', 'continue']) $(id).disabled = !ownsEditor || busy || connecting || connectionCheckQueued;
  showError(ownsEditor ? connectionError || card.error : '另一窗口正在编辑当前收录卡片。本窗口只读；请回到原窗口，或关闭原侧栏后重新打开这里。');
}
async function detectLanguage() {
  const text = card.prompt;
  const version = ++detectionGeneration;
  if (card.language !== 'auto') { $('language-result').textContent = `原文：${languages[card.language]}`; return; }
  if (!connected || !text.trim()) { $('language-result').textContent = '语言将自动判断，不影响保存'; return; }
  try {
    const result = await localRequest(config, '/api/captures/detect-language', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (version !== detectionGeneration || card.prompt !== text || card.language !== 'auto') return;
    $('language-result').textContent = result.uncertain ? '语言不确定，将保留原文；可纠正，也可直接保存' : `自动判断：${languages[result.language] || '不确定'}`;
  } catch { if (version === detectionGeneration) $('language-result').textContent = '暂未判断语言，保存时仍可自动判断'; }
}
async function verifyConnection() {
  if (connecting) return;
  connecting = Boolean(config);
  connectionError = '';
  connected = false;
  render();
  if (!config) return;
  try {
    // Host-permitted extension GETs may omit Origin. POST keeps the browser's
    // Origin available without weakening the server's paired-origin check.
    const response = await localRequest(config, '/api/captures/connection', { method: 'POST' });
    if (response.instance_id !== config.instance_id || response.client_id !== config.client_id) throw new Error('本地实例或配对身份不一致，请检查配对设置。');
    connected = true;
    void detectLanguage();
  } catch (error) { connectionError = error.message; }
  finally { connecting = false; render(); }
}
async function submit() {
  if (!ownsEditor || busy || reading || pendingURL || composing || !connected || !config) return;
  busy = true;
  render();
  try {
    await navigator.locks.request('image-prompt-library-capture', async () => {
      card = await readCard() || emptyCard();
      if (card.status === 'saved' || !card.frozen && !canSave(card, connected)) return;
      if (card.frozen && !sameTarget(card.frozen, config)) throw new Error('这条未确认请求绑定了原配对客户端。请恢复原配对，或先到原图库人工核对；不会使用新配对重发。');
      const recovering = Boolean(card.frozen);
      const frozen = freezeCard(card, config);
      await store(frozen);
      render();
      let capturePosted = false;
      try {
        let receipt;
        if (recovering) {
          try { receipt = await localRequest(config, `/api/captures/receipts/${card.frozen.request_id}`, { method: 'POST' }); }
          catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
        }
        if (!receipt) { capturePosted = true; receipt = await localRequest(config, '/api/captures', { method: 'POST', body: captureBody(card.frozen) }); }
        const preview = await thumbnail(card.frozen.image);
        await store(completeCard(card, receipt, preview));
        pendingURL = null;
      } catch (error) {
        // No response body, URL, submitted prompt, token, or server traceback is logged/displayed.
        await store(failCard(card, capturePosted && error instanceof ApiError ? error.status : undefined, error instanceof ApiError ? error.message : '保存结果无法确认，已保留同一请求，请恢复回执或重试。'));
        if ([401,403].includes(error.status)) connected = false;
      }
    });
  } finally { busy = false; render(); }
}
async function maybeAuto(event, generation) {
  if (generation === inputGeneration && shouldAutoSave(card, { event, connected, reading, composing })) await submit();
}
async function putImage(blob, source, event, generation) {
  if (isLocked(card)) return;
  reading = true;
  render();
  try {
    const image = await checkedImage(blob, blob.name, source);
    await edit(current => ({ ...current, image }));
    pendingURL = null;
  } finally { reading = false; render(); }
  await maybeAuto(event, generation);
}
function stageURL(url) {
  pendingURL = url;
  $('url-note').textContent = url.startsWith('blob:') ? '这是页面临时图片地址。需要在已授权的图片所在标签页读取；无法读取时请复制图片或拖入文件。' : '尚未取得图片。请明确授权此次图片所在网站，或从当前已授权标签页读取。不会发送图库凭据。';
  render();
}
function captureTransfer(transfer, event, selection) {
  if (!ownsEditor || isLocked(card) || busy || composing) return false;
  const files = Array.from(transfer.files || []);
  const generation = ++inputGeneration;
  if (files.length) {
    if (files.length !== 1) { showError('每次只收录一张图片。请重新放入一个文件。'); return true; }
    const webpageFile = /<img[\s>]/i.test(transfer.getData('text/html')) || /^https?:/i.test(transfer.getData('text/uri-list'));
    enqueue(() => putImage(files[0], event === 'paste' ? 'clipboard' : webpageFile ? 'web' : 'file', event, generation));
    return true;
  }
  let url;
  try { url = transferredImageURL(transfer); }
  catch (error) { showError(error.message); return true; }
  if (url) {
    if (url.startsWith('data:')) enqueue(async () => {
      reading = true; render();
      try { await putImage(await dataImage(url), 'web', event, generation); }
      finally { reading = false; render(); }
    });
    else stageURL(url);
    return true;
  }
  const text = transfer.getData('text/plain');
  if (!text) return false;
  const prior = $('prompt').value;
  const next = selection ? prior.slice(0, selection.start) + text + prior.slice(selection.end) : text;
  if (next.length > 200_000) { showError('提示词超过 200,000 字符限制，未替换当前原文。'); return true; }
  $('prompt').value = next;
  if (selection) $('prompt').setSelectionRange(selection.start + text.length, selection.start + text.length);
  enqueue(async () => {
    await edit(current => ({ ...current, prompt: next }));
    void detectLanguage();
    await maybeAuto(event, generation);
  });
  return true;
}

$('image-target').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  const generation = ++inputGeneration;
  if (file) enqueue(() => putImage(file, 'file', 'choose', generation));
});
document.addEventListener('paste', event => {
  if (event.target.closest('#settings')) return;
  const selection = event.target === $('prompt') ? { start: $('prompt').selectionStart, end: $('prompt').selectionEnd } : null;
  if (event.clipboardData && captureTransfer(event.clipboardData, 'paste', selection)) event.preventDefault();
});
document.addEventListener('dragover', event => { if (!event.target.closest('#settings')) { event.preventDefault(); $('image-target').classList.add('is-dragging'); } });
document.addEventListener('dragleave', () => $('image-target').classList.remove('is-dragging'));
document.addEventListener('drop', event => {
  $('image-target').classList.remove('is-dragging');
  if (event.target.closest('#settings')) return;
  event.preventDefault();
  if (event.dataTransfer) captureTransfer(event.dataTransfer, 'drop', null);
});
$('prompt').addEventListener('compositionstart', () => { composing = true; ++inputGeneration; });
$('prompt').addEventListener('compositionend', () => { composing = false; });
$('prompt').addEventListener('input', () => {
  ++inputGeneration;
  const text = $('prompt').value;
  enqueue(async () => { await edit(current => ({ ...current, prompt: text })); if (!composing) void detectLanguage(); });
});
$('language').addEventListener('change', event => {
  ++inputGeneration;
  const language = event.target.value;
  if (LANGUAGES.includes(language)) enqueue(async () => { await edit(current => ({ ...current, language })); void detectLanguage(); });
});
$('save').addEventListener('click', () => enqueue(submit));
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && !composing && !event.target.closest('#settings')) { event.preventDefault(); enqueue(submit); }
});
$('download-image').addEventListener('click', async () => {
  try {
    const url = publicImageURL(pendingURL);
    const generation = ++inputGeneration;
    if (!await grantHost(url)) throw new Error('未授权该图片网站。请改用复制图片或文件拖入。');
    enqueue(async () => { reading = true; render(); try { await putImage(await downloadPublicImage(url), 'web', 'drop', generation); } finally { reading = false; render(); } });
  } catch (error) { showError(error.message); }
});
$('page-image').addEventListener('click', async () => {
  const url = pendingURL;
  const generation = ++inputGeneration;
  enqueue(async () => { reading = true; render(); try { await putImage(await pageImage(url), 'web', 'drop', generation); } finally { reading = false; render(); } });
});
$('cancel-url').addEventListener('click', () => { ++inputGeneration; pendingURL = null; render(); });
async function clearCurrent() {
  if (!ownsEditor || busy) return;
  await navigator.locks.request('image-prompt-library-capture', async () => {
    card = await readCard() || emptyCard();
    if (card.frozen && !confirm('这条请求可能已在图库保存。清除草稿无法撤销保存，也无法再用原请求恢复回执。请先核对图库；确认仍要清除？')) return;
    ++inputGeneration;
    pendingURL = null;
    await store(emptyCard());
    $('prompt').value = '';
    render();
    $('language-result').textContent = '语言将自动判断，不影响保存';
  });
}
$('discard').addEventListener('click', () => { ++inputGeneration; enqueue(clearCurrent); });
$('continue').addEventListener('click', () => { ++inputGeneration; enqueue(clearCurrent); });
$('view-library').addEventListener('click', () => {
  if (card.receipt) chrome.tabs.create({ url: `${parseLocalBase(card.receipt.base_url)}/?capture_item=${encodeURIComponent(card.receipt.item_id)}` });
});
$('settings-toggle').addEventListener('click', () => {
  $('settings').hidden = !$('settings').hidden;
  $('settings-toggle').setAttribute('aria-expanded', String(!$('settings').hidden));
  render();
});
$('copy-id').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(chrome.runtime.id); $('copy-id').textContent = '已复制'; }
  catch { showError('无法写入剪贴板，请手动选择复制扩展 ID。'); }
});
$('open-pairing').addEventListener('click', () => {
  try { chrome.tabs.create({ url: `${parseLocalBase($('base-url').value)}/?capture_pair=${chrome.runtime.id}` }); }
  catch (error) { showError(error.message); }
});
$('connect').addEventListener('click', async () => {
  if (!ownsEditor || busy || connecting || connectionCheckQueued) return;
  connectionFeedbackVisible = true;
  connecting = true;
  connectionError = '';
  render();
  try {
    const next = parsePairing($('pairing-package').value, chrome.runtime.id, $('base-url').value);
    if (card.frozen && !sameTarget(card.frozen, next)) throw new Error('当前有结果未确认的收录，不能换成新的配对客户端。请恢复原配对包，或先到原图库核对并清除当前草稿。');
    connected = false;
    render();
    if (!await grantHost(next.base_url)) throw new Error('未授权本地图库地址，尚未连接。');
    const result = await localRequest(next, '/api/captures/connection', { method: 'POST' });
    if (result.instance_id !== next.instance_id || result.client_id !== next.client_id) throw new Error('配对包与本地实例不一致。');
    await navigator.locks.request('image-prompt-library-capture', async () => {
      card = await readCard() || emptyCard();
      if (card.frozen && !sameTarget(card.frozen, next)) throw new Error('当前请求已经冻结为原配对客户端，请先恢复原回执。');
      await writeConfig(next);
      config = next;
      connected = true;
    });
    $('pairing-package').value = '';
    $('settings').hidden = true;
    $('settings-toggle').setAttribute('aria-expanded', 'false');
    render();
    void detectLanguage(); // Connection/detection/restoration never initiates a capture.
  } catch (error) { connectionError = error.message; }
  finally { connecting = false; render(); }
});
$('disconnect').addEventListener('click', () => enqueue(async () => { await writeConfig(null); config = null; connected = false; connectionError = ''; connectionFeedbackVisible = false; $('pairing-package').value = ''; render(); }));
$('reconnect').addEventListener('click', () => {
  if (connecting || connectionCheckQueued) return;
  connectionFeedbackVisible = true;
  connectionCheckQueued = true;
  render();
  enqueue(async () => {
    try { await verifyConnection(); }
    finally { connectionCheckQueued = false; render(); }
  });
});
$('dismiss-connection-feedback').addEventListener('click', () => { connectionFeedbackVisible = false; $('connection-feedback').hidden = true; });
$('clear-permissions').addEventListener('click', async () => {
  const permissions = await chrome.permissions.getAll();
  const current = config ? permissionPattern(config.base_url) : null;
  const origins = (permissions.origins || []).filter(origin => origin !== current);
  if (origins.length) await chrome.permissions.remove({ origins });
  showError('已移除图片网站的额外访问权限；下次下载会重新询问。');
});
channel.addEventListener('message', () => { if (!busy) enqueue(async () => { card = await readCard() || emptyCard(); render(); }); });
window.addEventListener('pagehide', () => { releaseEditor(); if (imageObjectURL) URL.revokeObjectURL(imageObjectURL); if (savedObjectURL) URL.revokeObjectURL(savedObjectURL); channel.close(); });

try {
  ownsEditor = await new Promise((resolve, reject) => {
    navigator.locks.request('ipl-capture-editor', { ifAvailable: true }, async lock => {
      resolve(Boolean(lock));
      if (lock) await new Promise(release => { releaseEditor = release; });
    }).catch(reject);
  });
  $('extension-id').textContent = chrome.runtime.id;
  $('extension-version').textContent = `v${chrome.runtime.getManifest().version}`;
  card = await readCard() || emptyCard();
  config = await readConfig();
  if (config) $('base-url').value = config.base_url;
  else { $('settings').hidden = false; $('settings-toggle').setAttribute('aria-expanded', 'true'); }
  render();
  // A persisted submitting request is intentionally not replayed on startup.
  await verifyConnection();
} catch (error) { render(); showError(error.message || '无法恢复草稿，请保留扩展数据并重试。'); }
