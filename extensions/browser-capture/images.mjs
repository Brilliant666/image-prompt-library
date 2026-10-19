import { MAX_IMAGE_BYTES, imageSizeCheck, validateImageHeader, originalFilename } from './core.mjs';

export async function checkedImage(blob, name = 'capture', source = 'file') {
  imageSizeCheck(blob.size);
  const type = validateImageHeader(await blob.slice(0, 16).arrayBuffer());
  let decoded;
  try { decoded = await createImageBitmap(blob); } catch { throw new Error('无法解码这张图片，请换用完整的图片文件。'); }
  const { width, height } = decoded;
  decoded.close();
  if (!width || !height || width * height > 16_000_000) throw new Error('图片尺寸无效或超过 1,600 万像素限制。');
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
  // Blob.slice changes the MIME label only; it does not encode or alter the bytes.
  const originalName = originalFilename(name === 'capture' ? '' : name);
  return { blob: blob.slice(0, blob.size, type), name: originalName || `capture.${extension}`, originalName, width, height, source };
}
export async function dataImage(value) {
  if (value.length > MAX_IMAGE_BYTES * 3 + 256 || !/^data:image\/(png|jpeg|webp|gif)(;base64)?,/i.test(value)) throw new Error('图片 data URL 格式或大小不受支持。');
  try {
    const comma = value.indexOf(',');
    const base64 = value.slice(0, comma).toLowerCase().endsWith(';base64');
    const encoded = value.slice(comma + 1);
    if (base64) {
      if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('size');
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      imageSizeCheck(bytes.length);
      return new Blob([bytes]);
    }
    // A percent-encoded PNG contains binary octets such as %89. decodeURIComponent
    // interprets them as UTF-8 text and rejects valid image bytes. Decode each octet
    // directly; neither '+' nor other literal ASCII bytes are form-decoded.
    const bytes = new Uint8Array(Math.min(encoded.length, MAX_IMAGE_BYTES + 1));
    let length = 0;
    for (let index = 0; index < encoded.length; index++) {
      let byte = encoded.charCodeAt(index);
      if (byte === 37) {
        const pair = encoded.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/i.test(pair)) throw new Error('invalid escape');
        byte = Number.parseInt(pair, 16);
        index += 2;
      } else if (byte > 127) throw new Error('non-ASCII byte must be escaped');
      if (length >= MAX_IMAGE_BYTES) throw new Error('size');
      bytes[length++] = byte;
    }
    imageSizeCheck(length);
    return new Blob([bytes.subarray(0, length)]);
  } catch { throw new Error('图片 data URL 无法解码，请复制图片或拖入文件。'); }
}
export function transferredImageURL(transfer) {
  const html = transfer.getData('text/html');
  if (html && html.length <= 1_000_000) {
    // Inert parsing only: never attach pasted nodes or HTML to the extension document.
    const template = document.createElement('template');
    template.innerHTML = html;
    const images = template.content.querySelectorAll('img');
    if (images.length > 1) throw new Error('这次投递包含多张图片，请只拖入一张。');
    const source = images[0]?.getAttribute('src');
    if (source && /^(https?:\/\/|blob:|data:image\/)/i.test(source)) return source;
  }
  const uri = transfer.getData('text/uri-list').split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
  if (uri) return uri.trim();
  const text = transfer.getData('text/plain').trim();
  if (/^(https?:\/\/|blob:|data:image\/)/i.test(text) && !/[\r\n]/.test(text)) return text;
  if (html && /<img[\s>]/i.test(html)) throw new Error('网页未提供可用的绝对图片地址，请使用复制图片或拖入文件。');
  return null;
}
export async function thumbnail(image) {
  try {
    const bitmap = await createImageBitmap(image.blob);
    const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.78 });
  } catch { return null; }
}
