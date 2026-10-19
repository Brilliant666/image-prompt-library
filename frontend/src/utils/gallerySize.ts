// Size presets and candidate search adapted from CookSleep/gpt-image-playground
// src/lib/size.ts (MIT, 1e9d5af60aadd9117a835cc2da43908b8e3370dd).
import { IMAGE25_MODELS } from './compatibleRecipe';
export type SizeTier = '1K' | '2K' | '4K';
export const SIZE_TIERS: SizeTier[] = ['1K', '2K', '4K'];
export const SIZE_RATIOS = ['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9'];
const BUDGET = { '1K': 1572864, '2K': 4194304, '4K': 8294400 };
const PRESETS: Record<SizeTier, string[]> = {
  '1K': ['1024x1024', '1536x1024', '1024x1536', '1280x720', '720x1280', '1024x768', '768x1024', '1280x544'],
  '2K': ['2048x2048', '2160x1440', '1440x2160', '2560x1440', '1440x2560', '2048x1536', '1536x2048', '2560x1088'],
  '4K': ['2880x2880', '3456x2304', '2304x3456', '3840x2160', '2160x3840', '3200x2400', '2400x3200', '3840x1648'],
};

export function parseSizeRatio(value: string) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:xX×]\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return;
  const width = Number(match[1]), height = Number(match[2]);
  const ratio = width / height;
  if (!Number.isFinite(ratio) || width <= 0 || height <= 0 || ratio < 1 / 3 || ratio > 3) return;
  return { width, height, ratio };
}

/** Calculate requested canvas pixels only; never resize reference or result bytes. */
export function calculateImageSize(tier: SizeTier, ratio: string): string | undefined {
  const parsed = parseSizeRatio(ratio);
  if (!parsed) return;
  const preset = SIZE_RATIOS.findIndex(value => Math.abs(parseSizeRatio(value)!.ratio - parsed.ratio) < 1e-10);
  if (preset >= 0) return PRESETS[tier][preset];
  let bestPixels = 0, result: string | undefined;
  for (let width = 16; width <= 3840; width += 16) {
    const ideal = width / parsed.ratio;
    for (const height of [Math.floor(ideal / 16) * 16, Math.ceil(ideal / 16) * 16]) {
      const pixels = width * height;
      if (height < 16 || height > 3840 || pixels < 655360 || pixels > BUDGET[tier] || Math.max(width / height, height / width) > 3) continue;
      if (Math.abs(width / height / parsed.ratio - 1) > 0.01 || pixels <= bestPixels) continue;
      bestPixels = pixels; result = `${width}x${height}`;
    }
  }
  return result;
}

/** Exact lookup: opening a historical size must never silently normalize it. */
export function findSizePreset(size: string) {
  for (const tier of SIZE_TIERS) {
    const index = PRESETS[tier].indexOf(size);
    if (index >= 0) return { tier, ratio: SIZE_RATIOS[index] };
  }
}

export function customSizeError(width: string, height: string, model: string) {
  if (!/^[1-9]\d*$/.test(width) || !/^[1-9]\d*$/.test(height)) return '宽高须为正整数。';
  const w = Number(width), h = Number(height);
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || !Number.isSafeInteger(w * h)) return '像素值过大。';
  // 自定义网关模型能力未知；与当前前后端相同，仅对已知 Image 2.5 模型施加专有限制。
  if (!IMAGE25_MODELS.includes(model)) return;
  if (w % 16 || h % 16) return '宽高均须为 16 的倍数。';
  if (w > 3840 || h > 3840) return '最大边长为 3840 像素。';
  if (Math.max(w, h) > 3 * Math.min(w, h)) return '宽高比须在 1:3 到 3:1 之间。';
  if (w * h < 655360 || w * h > 8294400) return '总像素须在 655,360 到 8,294,400 之间。';
}
