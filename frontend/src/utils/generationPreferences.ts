import type { ApiProtocol } from '../types';
import type { CompatibleRecipe } from './compatibleRecipe';

const PREFIX = 'image-prompt-library:generation:v1:';
const preferenceKey = (profile:string,protocol:ApiProtocol='openai_compatible',preset='generic') => PREFIX + profile + (protocol === 'openai_compatible' ? '' : ':' + protocol) + (preset==='muse'?':muse':'');
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export function readGenerationPreference(storage: StorageLike, profile: string, model = '', protocol:ApiProtocol='openai_compatible', preset:'generic'|'muse'='generic'): CompatibleRecipe {
  // Request transport stays with a restored history card, not these ordinary
  // image choices. Future tasks must continue using their API profile defaults.
  const native=protocol!=='openai_compatible';
  const fallback: CompatibleRecipe = preset==='muse'?{service_preset:'muse',model,requested_aspect_ratio:'auto',quality:'auto',size:'auto',background:'auto',output_format:'auto'}:{ model, quality: 'auto', size: 'auto', background: 'auto', output_format: native?'auto':'png', ...(native?{protocol,provider_options:{}}:{}) };
  try {
    const value = JSON.parse(storage.getItem(preferenceKey(profile,protocol,preset)) || 'null');
    if (!value || typeof value !== 'object') return fallback;
    if(preset==='muse')return {...fallback,model:typeof value.model==='string'&&value.model.trim()?value.model:model,requested_aspect_ratio:typeof value.requested_aspect_ratio==='string'?value.requested_aspect_ratio:'auto'};
    return {
      ...(native?{protocol,provider_options:Object.fromEntries(Object.entries(value.provider_options||{}).filter((entry):entry is [string,string|number|boolean]=>(protocol==='gemini_native'?['aspect_ratio','resolution']:['watermark']).includes(entry[0])&&['string','number','boolean'].includes(typeof entry[1])))}:{}),
      model: typeof value.model === 'string' && value.model.trim() ? value.model : model,
      quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.quality) ? value.quality : 'auto',
      size: typeof value.size === 'string' && (native?/^(auto|1K|1\.5K|2K|3K|4K|[1-9][0-9]*x[1-9][0-9]*)$/:/^(auto|[1-9][0-9]*x[1-9][0-9]*)$/).test(value.size) ? value.size : 'auto',
      ...(value.size_mode === 'auto4k' ? { size_mode: 'auto4k' as const } : {}),
      background: ['auto', 'opaque', 'transparent'].includes(value.background) ? value.background : 'auto',
      output_format: (native?['auto','png','jpeg','webp']:['png','jpeg','webp']).includes(value.output_format) ? value.output_format : fallback.output_format,
      ...(value.moderation === 'auto' || value.moderation === 'low' ? { moderation: value.moderation } : {}),
      ...(Number.isInteger(value.output_compression) && value.output_compression >= 0 && value.output_compression <= 100 ? { output_compression: value.output_compression } : {}),
    };
  } catch { return fallback; }
}
export function writeGenerationPreference(storage: StorageLike, profile: string, recipe: CompatibleRecipe): void {
  try {
    // Explicit allowlist: never persist credentials, prompts, images, provider URLs,
    // or a historical card's transport overrides as defaults for future requests.
    const { model, quality, size, background, output_format, output_compression, moderation, size_mode, protocol, provider_options,service_preset,requested_aspect_ratio } = recipe;
    const safeOptions=protocol&&protocol!=='openai_compatible'?Object.fromEntries(Object.entries(provider_options||{}).filter(([key,value])=>(protocol==='gemini_native'?['aspect_ratio','resolution']:['watermark']).includes(key)&&['string','number','boolean'].includes(typeof value))):undefined;
    storage.setItem(preferenceKey(profile,protocol,service_preset), JSON.stringify({ service_preset,requested_aspect_ratio,model, quality, size, background, output_format, output_compression, moderation, size_mode, ...(safeOptions?{protocol,provider_options:safeOptions}:{}) }));
    storage.setItem(PREFIX + 'selected-profile', profile);
  } catch { /* Storage may be unavailable or full; generation still works. */ }
}
/** A saved profile model changes no other choices and never selects that profile. */
export function updateRememberedModel(storage: StorageLike, profile: string, model: string, protocol:ApiProtocol='openai_compatible',preset:'generic'|'muse'='generic'): boolean {
  try {
    storage.setItem(preferenceKey(profile,protocol,preset), JSON.stringify({ ...readGenerationPreference(storage, profile, '', protocol,preset), model }));
    return true;
  } catch { return false; }
}
export function lastGenerationProfile(storage: StorageLike): string | null {
  try { return storage.getItem(PREFIX + 'selected-profile'); } catch { return null; }
}

/** Reset only this profile's recipe. Keep the selected profile, drafts and other APIs. */
export function resetGenerationPreference(storage: Pick<Storage, 'removeItem'>, profile: string, protocol:ApiProtocol='openai_compatible',preset:'generic'|'muse'='generic'): boolean {
  try { storage.removeItem(preferenceKey(profile,protocol,preset)); return true; } catch { return false; }
}
