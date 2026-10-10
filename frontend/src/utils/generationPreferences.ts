import type { CompatibleRecipe } from './compatibleRecipe';

const PREFIX = 'image-prompt-library:generation:v1:';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export function readGenerationPreference(storage: StorageLike, profile: string, model = ''): CompatibleRecipe {
  const fallback: CompatibleRecipe = { model, quality: 'auto', size: 'auto', background: 'auto', output_format: 'png' };
  try {
    const value = JSON.parse(storage.getItem(PREFIX + profile) || 'null');
    if (!value || typeof value !== 'object') return fallback;
    return {
      model: typeof value.model === 'string' && value.model.trim() ? value.model : model,
      quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.quality) ? value.quality : 'auto',
      size: typeof value.size === 'string' && /^(auto|[1-9][0-9]*x[1-9][0-9]*)$/.test(value.size) ? value.size : 'auto',
      background: ['auto', 'opaque', 'transparent'].includes(value.background) ? value.background : 'auto',
      output_format: ['png', 'jpeg', 'webp'].includes(value.output_format) ? value.output_format : 'png',
      ...(Number.isInteger(value.output_compression) && value.output_compression >= 0 && value.output_compression <= 100 ? { output_compression: value.output_compression } : {}),
    };
  } catch { return fallback; }
}
export function writeGenerationPreference(storage: StorageLike, profile: string, recipe: CompatibleRecipe): void {
  try {
    // Explicit allowlist: never persist credentials, prompts, images or provider URLs.
    const { model, quality, size, background, output_format, output_compression } = recipe;
    storage.setItem(PREFIX + profile, JSON.stringify({ model, quality, size, background, output_format, output_compression }));
    storage.setItem(PREFIX + 'selected-profile', profile);
  } catch { /* Storage may be unavailable or full; generation still works. */ }
}
export function lastGenerationProfile(storage: StorageLike): string | null {
  try { return storage.getItem(PREFIX + 'selected-profile'); } catch { return null; }
}
