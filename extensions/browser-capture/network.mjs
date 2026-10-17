import { MAX_IMAGE_BYTES, parseLocalBase, permissionPattern, publicImageURL, safeFailure } from './core.mjs';

export class ApiError extends Error {
  constructor(status) { super(safeFailure(status)); this.status = status; }
}
export function apiOptions(config, options = {}) {
  return { ...options, mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: {
    ...(options.headers || {}), 'X-Capture-Token': config.token, 'X-Capture-Instance': config.instance_id,
  } };
}
export async function localRequest(config, path, options = {}, fetcher = fetch) {
  const base = parseLocalBase(config.base_url);
  if (!/^\/api\/captures(?:\/detect-language|\/connection|\/receipts\/[a-f0-9-]{36})?$/.test(path)) throw new Error('该收录凭据不能用于其他接口。');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetcher(base + path, apiOptions(config, { ...options, signal: controller.signal }));
    if (!response.ok) throw new ApiError(response.status);
    const bytes = await readBounded(response, 256 * 1024);
    let result;
    try { result = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ApiError(); }
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError();
  } finally { clearTimeout(timeout); }
}
export async function readBounded(response, maximum = MAX_IMAGE_BYTES) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximum) throw new Error('内容超过允许大小。');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('响应没有可读取的内容。');
  let total = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error('内容超过允许大小。');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export function downloadOptions(signal) {
  // This function deliberately has no access to local pairing or provider credentials.
  return { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal, headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } };
}
export async function downloadPublicImage(input, fetcher = fetch) {
  const url = publicImageURL(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetcher(url, downloadOptions(controller.signal));
    if (!response.ok) throw new Error('download failed');
    const bytes = await readBounded(response);
    return new Blob([bytes], { type: response.headers.get('content-type')?.split(';')[0] || '' });
  } catch {
    throw new Error('无法取得公共图片字节（地址可能需登录、跳转、已过期或超过限制）。请复制图片或拖入下载的文件。');
  } finally { clearTimeout(timer); }
}
export async function grantHost(url) {
  const origins = [permissionPattern(url)];
  // Request directly inside the gesture; an earlier async contains() check can
  // expire Chrome's user activation. Already-granted origins resolve immediately.
  return chrome.permissions.request({ origins });
}
export async function pageImage(input) {
  const url = new URL(input);
  if (!['blob:', 'http:', 'https:'].includes(url.protocol)) throw new Error('此地址不能从当前标签页读取。');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !['http:', 'https:'].includes(new URL(tab.url).protocol) || url.origin !== new URL(tab.url).origin) throw new Error('图片不属于已授权的当前标签页。请在图片所在页面点击扩展图标，或使用复制图片／文件拖入。');
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', args: [url.href, MAX_IMAGE_BYTES], func: async (imageURL, maximum) => {
      // Runs only after a user's explicit button click, for exactly one supplied visible image.
      if (new URL(imageURL).origin !== location.origin || !Array.from(document.images).some(image => {
        const bounds = image.getBoundingClientRect();
        return (image.src === imageURL || image.currentSrc === imageURL) && bounds.width > 0 && bounds.height > 0 && getComputedStyle(image).visibility !== 'hidden';
      })) return { error: true };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(imageURL, { credentials: imageURL.startsWith('blob:') ? 'omit' : 'same-origin', redirect: 'error', signal: controller.signal });
        if (!response.ok || Number(response.headers.get('content-length')) > maximum) return { error: true };
        const reader = response.body.getReader();
        const parts = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > maximum) { await reader.cancel(); return { error: true }; }
          parts.push(value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        let binary = '';
        for (let start = 0; start < bytes.length; start += 16_384) binary += String.fromCharCode(...bytes.subarray(start, start + 16_384));
        return { data: btoa(binary), type: response.headers.get('content-type')?.split(';')[0] || '' };
      } catch { return { error: true }; } finally { clearTimeout(timeout); }
    } });
  } catch { throw new Error('无法读取当前标签页。请先在图片所在页面点击扩展图标授权，或使用复制图片／文件拖入。'); }
  const result = results?.[0]?.result;
  if (!result?.data || result.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('当前页面未提供可安全读取的这张图片。请使用复制图片或拖入文件。');
  return new Blob([Uint8Array.from(atob(result.data), character => character.charCodeAt(0))], { type: result.type });
}
