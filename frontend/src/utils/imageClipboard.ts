/** Copy a final same-origin image. This never reads the existing clipboard. */
const MAX_COPY_BYTES = 64 * 1024 * 1024;
const MAX_COPY_PIXELS = 32_000_000;

export class ImageClipboardError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ImageClipboardError'; }
}

function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('已取消复制图片。', 'AbortError');
}
function checkDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new ImageClipboardError('decode', '原图片无法解码，未复制。可以下载原文件。');
  }
  if (width * height > MAX_COPY_PIXELS) throw new ImageClipboardError('too_large', '图片过大，无法安全复制。请下载原文件。');
}

async function readImage(response: Response, signal: AbortSignal): Promise<Blob> {
  if (!response.ok) throw new ImageClipboardError(response.status === 404 || response.status === 410 ? 'missing' : 'read',
    response.status === 404 || response.status === 410 ? '原图片已不可用，未复制。请检查生成结果。' : '读取原图片失败，未复制。可以下载原文件。');
  if (Number(response.headers.get('content-length')) > MAX_COPY_BYTES) throw new ImageClipboardError('too_large', '图片过大，无法安全复制。请下载原文件。');
  if (!response.body) {
    const blob = await response.blob(); cancelled(signal);
    if (blob.size > MAX_COPY_BYTES) throw new ImageClipboardError('too_large', '图片过大，无法安全复制。请下载原文件。');
    return blob;
  }
  const reader = response.body.getReader(), chunks: ArrayBuffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      cancelled(signal);
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_COPY_BYTES) throw new ImageClipboardError('too_large', '图片过大，无法安全复制。请下载原文件。');
      chunks.push(new Uint8Array(part.value).buffer);
    }
    cancelled(signal);
    return new Blob(chunks, { type: response.headers.get('content-type') || '' });
  } catch (reason) {
    await reader.cancel().catch(() => {}); throw reason;
  } finally { reader.releaseLock(); }
}

async function pngForClipboard(url: string, signal: AbortSignal): Promise<Blob> {
  const image = await readImage(await fetch(url, { credentials: 'same-origin', redirect: 'error', signal }), signal);
  if (!image.size) throw new ImageClipboardError('decode', '原图片为空，未复制。请检查生成结果。');
  cancelled(signal);
  const header = new Uint8Array(await image.slice(0, 32).arrayBuffer());
  cancelled(signal);
  const png = header.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value);
  if (png) {
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    checkDimensions(view.getUint32(16), view.getUint32(20));
    // Preserve directly supported PNG bytes, including alpha, without a canvas.
    return image.type === 'image/png' ? image : new Blob([image], { type: 'image/png' });
  }
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp = header.length >= 12 && String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  if (!jpeg && !webp) throw new ImageClipboardError('format', '这张图片的格式不支持复制。请下载原文件。');
  if (typeof createImageBitmap !== 'function') throw new ImageClipboardError('unsupported', '当前浏览器不支持转换这张图片，请下载原文件。');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([image], { type: jpeg ? 'image/jpeg' : 'image/webp' }), { imageOrientation: 'from-image' }); }
  catch { throw new ImageClipboardError('decode', '原图片无法解码，未复制。可以下载原文件。'); }
  let canvas: HTMLCanvasElement | undefined;
  try {
    cancelled(signal); checkDimensions(bitmap.width, bitmap.height);
    canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new ImageClipboardError('decode', '无法准备图片剪贴板，未复制。请下载原文件。');
    // The decoded visible orientation and full dimensions are retained. A fresh
    // alpha canvas avoids flattening transparent WebP against a background.
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas!.toBlob(value => value ? resolve(value) : reject(new ImageClipboardError('decode', '无法转换图片，未复制。请下载原文件。')), 'image/png'));
    cancelled(signal);
    if (png.size > MAX_COPY_BYTES) throw new ImageClipboardError('too_large', '图片过大，无法安全复制。请下载原文件。');
    return png;
  } finally {
    bitmap.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

export async function copyFinalImageToClipboard(url: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined'
      || typeof ClipboardItem.supports === 'function' && !ClipboardItem.supports('image/png')) {
    throw new ImageClipboardError('unsupported', '当前浏览器不支持复制图片。请下载原文件。');
  }
  let source: URL;
  try { source = new URL(url, location.origin); }
  catch { throw new ImageClipboardError('source', '图片地址无效，未复制。'); }
  if (source.origin !== location.origin || !['http:', 'https:'].includes(source.protocol) || source.username || source.password) {
    throw new ImageClipboardError('source', '只能复制本项目的生成结果，未复制。');
  }
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    cancelled(controller.signal);
    const representation = pngForClipboard(source.href, controller.signal);
    // ClipboardItem consumes this Promise, including on Safari. Keep the write
    // call in the original click stack instead of awaiting fetch or conversion.
    void representation.catch(() => {});
    const item = new ClipboardItem({ 'image/png': representation });
    await navigator.clipboard.write([item]);
    await representation;
    cancelled(controller.signal);
  } catch (reason) {
    controller.abort();
    if (options.signal?.aborted || reason instanceof DOMException && reason.name === 'AbortError') throw new DOMException('已取消复制图片。', 'AbortError');
    if (reason instanceof ImageClipboardError) throw reason;
    if (reason instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(reason.name)) {
      throw new ImageClipboardError('permission', '没有剪贴板写入权限。请允许后重试，或下载原文件。');
    }
    throw new ImageClipboardError('copy', '复制图片失败，未复制。可以下载原文件。');
  } finally { options.signal?.removeEventListener('abort', abort); }
}
