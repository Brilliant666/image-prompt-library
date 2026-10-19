import { organizerMetadata } from './organizer.mjs';
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_PROMPT_LENGTH = 200_000;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const LANGUAGES = ['auto', 'zh_hans', 'zh_hant', 'en', 'und'];

export function emptyCard() {
  return { version: 1, status: 'draft', image: null, prompt: '', title: '', language: 'auto', frozen: null, receipt: null, error: '', revision: 0 };
}
export function isLocked(card) { return Boolean(card.frozen) || card.status === 'saved'; }
export function canSave(card, connected, reading = false) {
  return connected && !reading && card.status === 'draft' && Boolean(card.image?.blob?.size) && Boolean(card.prompt.trim());
}
export function shouldAutoSave(card, { event, connected, reading = false, composing = false }) {
  return ['paste', 'drop'].includes(event) && !composing && canSave(card, connected, reading);
}
export function freezeCard(card, config, makeId = () => crypto.randomUUID()) {
  if (card.status === 'saved') throw new Error('此卡片已经保存，请继续收录下一条。');
  if (card.frozen) return { ...card, status: 'submitting', error: '' };
  if (!canSave(card, true)) throw new Error('请放入一张有效图片和非空提示词。');
  return { ...card, status: 'submitting', error: '', frozen: {
    request_id: makeId(), prompt: card.prompt, language: card.language,
    title: card.title || '', original_filename: card.image.originalName || '',
    image: card.image, base_url: config.base_url, instance_id: config.instance_id,
    extension_id: config.extension_id, client_id: config.client_id,
  } };
}
export function failCard(card, status, message) {
  if (card.status === 'saved') return card;
  const editable = [400, 413, 415, 422].includes(status);
  return { ...card, status: editable ? 'draft' : 'uncertain', frozen: editable ? null : card.frozen, error: message };
}
export function completeCard(card, receipt, thumbnail = null) {
  if (!card.frozen || !receipt?.item_id || receipt.request_id !== card.frozen.request_id) throw new Error('未收到可确认的收录回执。');
  // Original bytes exist only in the library after success. Keep a small local receipt preview.
  return { ...emptyCard(), revision: card.revision, status: 'saved', receipt: {
    request_id: receipt.request_id, item_id: receipt.item_id, base_url: card.frozen.base_url,
    instance_id: card.frozen.instance_id, thumbnail,
    title: typeof receipt.title === 'string' ? receipt.title.slice(0, 300) : card.frozen.title || '已保存的收录',
    created_at: typeof receipt.created_at === 'string' && Number.isFinite(Date.parse(receipt.created_at)) ? receipt.created_at : new Date().toISOString(),
    ...(organizerMetadata(receipt.organizer) ? { organizer: organizerMetadata(receipt.organizer) } : {}),
  } };
}
export function parseLocalBase(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入完整的本地地址，例如 http://127.0.0.1:8013。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('仅支持明确的 localhost / 127.0.0.1 地址和端口，不支持路径、账号或远程服务。');
  }
  return url.origin;
}
export function parsePairing(text, extensionId, expectedBase) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('配对包必须是图库提供的 JSON。'); }
  if (value?.version !== 1 || value.extension_id !== extensionId || !/^[a-p]{32}$/.test(extensionId) || typeof value.token !== 'string' || value.token.length < 24 || value.token.length > 4096 || !/^[\x21-\x7e]+$/.test(value.token) || typeof value.instance_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.instance_id) || typeof value.client_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.client_id)) throw new Error('配对包无效，或不属于当前扩展。请在图库重新配对。');
  const base_url = parseLocalBase(value.base_url);
  if (base_url !== parseLocalBase(expectedBase)) throw new Error('配对包地址与当前指定的本地图库不一致。');
  return { version: 1, base_url, extension_id: extensionId, instance_id: value.instance_id, client_id: value.client_id, token: value.token };
}
export function sameTarget(frozen, config) {
  return Boolean(config) && ['base_url', 'instance_id', 'extension_id', 'client_id'].every(key => frozen[key] === config[key]);
}
export function permissionPattern(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}
export function publicImageURL(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('图片地址无效，请改用复制图片或文件拖入。'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port) || !host.includes('.') || host.endsWith('.') || /(^|\.)(localhost|local|internal|lan|test|invalid)$/.test(host) || host.startsWith('[')) throw new Error('该地址不属于可下载的公共图片地址，请复制图片或拖入文件。');
  if (/^[\d.]+$/.test(host)) {
    const [a,b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0,168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18,19,51].includes(b) || a === 203 && b === 0 || a >= 224) throw new Error('不下载本地、保留或专用网络中的图片 URL。');
  }
  url.hash = '';
  return url.href;
}
export function validateImageHeader(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const starts = values => values.every((value, index) => data[index] === value);
  if (starts([137,80,78,71,13,10,26,10])) return 'image/png';
  if (starts([255,216,255])) return 'image/jpeg';
  if (starts([71,73,70,56]) && [55,57].includes(data[4]) && data[5] === 97) return 'image/gif';
  if (starts([82,73,70,70]) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return 'image/webp';
  throw new Error('仅支持真实的 PNG、JPEG、WebP 或 GIF 图片。');
}
export function imageSizeCheck(size) {
  if (!size || size > MAX_IMAGE_BYTES) throw new Error('图片不能为空，且不得超过 30 MB。');
}
export function captureBody(frozen) {
  const body = new FormData();
  body.set('file', frozen.image.blob, frozen.image.name || 'capture.png');
  body.set('request_id', frozen.request_id);
  body.set('prompt_text_json', JSON.stringify(frozen.prompt));
  body.set('language', frozen.language);
  // Old frozen requests must replay exactly; never backfill new metadata.
  if (frozen.title !== undefined) body.set('title', frozen.title);
  if (frozen.original_filename !== undefined) body.set('original_filename', frozen.original_filename);
  return body;
}

export function originalFilename(value) {
  if (typeof value !== 'string' || /^(?:https?:|blob:|data:)/i.test(value)) return '';
  const basename = value.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return basename.length <= 300 ? basename : '';
}
export function receiptKey(receipt) {
  return JSON.stringify([receipt.base_url, receipt.instance_id, receipt.item_id]);
}
export function recentForTarget(recent, config) {
  return config ? recent.filter(entry => entry.base_url === config.base_url && entry.instance_id === config.instance_id) : [];
}
export function appendRecent(recent, receipt) {
  if (recent.some(entry => receiptKey(entry) === receiptKey(receipt))) return recent.slice(0, 20);
  // Explicit projection: never persist credentials, original bytes or prompt text here.
  const entry = { item_id: receipt.item_id, request_id: receipt.request_id, base_url: receipt.base_url,
    instance_id: receipt.instance_id, title: receipt.title || '已保存的收录', created_at: receipt.created_at,
    thumbnail: receipt.thumbnail || null };
  if (organizerMetadata(receipt.organizer)) entry.organizer = organizerMetadata(receipt.organizer);
  return [entry, ...recent].slice(0, 20);
}
export function safeFailure(status) {
  if ([401,403].includes(status)) return '配对无效、已撤销或没有权限。请检查图库中的配对，再重试原请求。';
  if (status === 409) return '请求标识或内容发生冲突。请保留卡片，检查图库中是否已有这条收录。';
  if (status === 413) return '图片超过大小限制，请更换图片。';
  if ([400,415,422].includes(status)) return `收录内容未通过校验（HTTP ${status}）。请检查图片格式、提示词和语言后重试。`;
  if (status) return `本地服务未能确认结果（HTTP ${status}）。内容已保留，重试将先恢复同一条回执。`;
  return '连接中断、超时或响应不完整，结果尚未确认。内容已保留；重试使用同一个请求，不会自动重新创建。';
}
