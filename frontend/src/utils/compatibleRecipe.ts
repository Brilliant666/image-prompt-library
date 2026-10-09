import type { Translator } from './i18n';
import type { GenerationJobRecord } from '../types';
export const IMAGE25_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08'];
export const IMAGE25_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
export const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840'];
export const LEGACY_RATIO_SIZES: Record<string, string> = { auto: 'auto', '1:1': '1024x1024', '3:4': '864x1152', '9:16': '720x1280', '4:3': '1152x864', '16:9': '1280x720' };
export interface CompatibleRecipe { model: string; quality: string; size: string; background: string; output_format: string; output_compression?: number; legacyDerived?: boolean }
export function imageQualities(model: string) { return IMAGE25_MODELS.includes(model) ? IMAGE25_QUALITIES : ['auto', 'low', 'medium', 'high']; }
export function restoreCompatibleRecipe(job: Pick<GenerationJobRecord, 'parameters' | 'metadata' | 'model'>): CompatibleRecipe {
  const requested = job.metadata?.requested;
  const values = { ...job.parameters, ...(requested && typeof requested === 'object' ? requested as Record<string, unknown> : {}) };
  const text = (key: string, fallback: string) => typeof values[key] === 'string' ? values[key] as string : fallback;
  return { model: text('model', job.model || ''), quality: text('quality', 'low'), size: text('size', LEGACY_RATIO_SIZES[String(values.requested_aspect_ratio || 'auto')] || 'auto'), background: text('background', 'auto'), output_format: text('output_format', 'png'), ...(typeof values.output_compression === 'number' ? { output_compression: values.output_compression } : {}), legacyDerived: !values.size };
}
export function compatibleValidation(recipe: CompatibleRecipe): Parameters<Translator>[0] | undefined {
  if (!recipe.model.trim()) return 'imageModelRequired';
  if (!imageQualities(recipe.model).includes(recipe.quality)) return 'imageQualityUnsupported';
  if (!['auto', 'opaque', 'transparent'].includes(recipe.background)) return 'imageBackgroundInvalid';
  if (!['png', 'jpeg', 'webp'].includes(recipe.output_format)) return 'imageFormatInvalid';
  if (recipe.background === 'transparent' && recipe.output_format === 'jpeg') return 'imageTransparencyConflict';
  if (recipe.output_format !== 'png' && recipe.output_compression !== undefined && (!Number.isInteger(recipe.output_compression) || recipe.output_compression < 0 || recipe.output_compression > 100)) return 'imageCompressionInvalid';
  if (recipe.size !== 'auto') {
    const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(recipe.size);
    if (!match) return 'imageSizeInvalid';
    const w = Number(match[1]), h = Number(match[2]);
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) return 'imageSizeInvalid';
    if (IMAGE25_MODELS.includes(recipe.model) && (w > 3840 || h > 3840 || w % 16 || h % 16 || Math.max(w, h) / Math.min(w, h) > 3 || w * h < 655360 || w * h > 8294400)) return 'imageSizeInvalid';
  }
}
export function compatibleParameters(recipe: CompatibleRecipe) {
  const error = compatibleValidation(recipe);
  if (error) throw new Error(error);
  return { model: recipe.model, quality: recipe.quality, size: recipe.size, background: recipe.background, output_format: recipe.output_format, ...(recipe.output_format !== 'png' && recipe.output_compression !== undefined ? { output_compression: recipe.output_compression } : {}), n: 1 };
}
export function imageSizeInfo(size: string, ratio: string) {
  const [w, h] = size.split('x').map(Number), [rw, rh] = ratio.split(':').map(Number);
  return { experimental: w * h > 3686400, conflict: Boolean(w && h && rw && rh && w * rh !== h * rw) };
}
export function compatibleMismatches(job: GenerationJobRecord): Parameters<Translator>[0][] {
  const requested = job.metadata?.requested as Record<string, unknown> | undefined;
  const decoded = job.metadata?.decoded_image as Record<string, unknown> | undefined;
  if (!requested || !decoded) return [];
  const issues: Parameters<Translator>[0][] = [];
  if (requested.size && requested.size !== 'auto' && decoded.width && decoded.height && requested.size !== `${decoded.width}x${decoded.height}`) issues.push('imageSizeMismatch');
  if (requested.output_format && decoded.format && String(requested.output_format).toLowerCase().replace('jpg', 'jpeg') !== String(decoded.format).toLowerCase().replace('jpg', 'jpeg')) issues.push('imageFormatMismatch');
  if (requested.background === 'transparent' && decoded.has_transparent_pixels === false) issues.push('imageAlphaMismatch');
  return issues;
}
