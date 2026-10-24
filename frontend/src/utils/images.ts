import type { ImageRecord } from '../types';

export function selectPrimaryImage(images: Array<ImageRecord | undefined>) {
  return images.find(image => image?.role === 'result_image') || images.find(Boolean);
}

export function imageDisplayPath(image?: ImageRecord) {
  return image?.preview_path || image?.original_path || image?.thumb_path || '';
}

export function imageCardSources(image?: ImageRecord) {
  const fallback = { src: imageDisplayPath(image), candidates: [] as Array<{ path: string; width: number }> };
  const width = image?.width, height = image?.height;
  if (!image?.thumb_path || !width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return fallback;

  // Match image_store's bounded, aspect-preserving derivatives. Width descriptors
  // let the browser choose a thumbnail or preview for the actual card size/DPR.
  const scaledWidth = (bound: number) => Math.max(1, Math.round(width * Math.min(1, bound / Math.max(width, height))));
  const thumbWidth = scaledWidth(420);
  const largerPath = image.preview_path || image.original_path;
  const largerWidth = image.preview_path ? scaledWidth(1400) : width;
  const src = image.thumb_path;
  if (!largerPath || largerPath === src || largerWidth <= thumbWidth) return { src, candidates: [] };
  return { src, candidates: [{ path: src, width: thumbWidth }, { path: largerPath, width: largerWidth }] };
}

export function imageThumbnailPath(image?: ImageRecord) {
  return image?.thumb_path || image?.preview_path || '';
}

export function imageHeroPath(image?: ImageRecord) {
  return image?.preview_path || image?.original_path || image?.thumb_path || '';
}

export function imageOriginalPath(image?: ImageRecord) {
  return image?.original_path || image?.preview_path || image?.thumb_path || '';
}

export function downloadFileName(title: string, path?: string | null) {
  const extension = path?.split('?')[0]?.split('#')[0]?.split('.').pop() || 'png';
  const safeTitle = title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf]+/gi, '-').replace(/^-+|-+$/g, '') || 'image';
  return `${safeTitle}.${extension}`;
}
