import type { OpenAICompatibleProfile } from '../types';

/** Mirrors the backend Base URL contract; never includes URL credentials. */
export function compatibleEndpointPreview(value: string, mode: 'versioned' | 'custom' = 'versioned'): { base: string; generate: string; edit: string; responses: string } | undefined {
  try {
    const address = new URL(value.trim());
    if (!['http:', 'https:'].includes(address.protocol) || !address.hostname || address.username || address.password || address.search || address.hash) return;
    let path = address.pathname.replace(/\/+$/, '');
    if (mode === 'versioned') while (path.endsWith('/v1')) path = path.slice(0, -3);
    if (path.includes('/images/')) return;
    const base = `${address.origin}${path}${mode === 'versioned' ? '/v1' : ''}`;
    return { base, generate: `${base}/images/generations`, edit: `${base}/images/edits`, responses: `${base}/responses` };
  } catch { return; }
}

export function profileValidation(profile: Pick<OpenAICompatibleProfile, 'display_name' | 'base_url' | 'timeout' | 'base_url_mode' | 'partial_images' | 'models'>): 'name' | 'url' | 'timeout' | 'partial_images' | 'models' | undefined {
  if (!profile.display_name.trim()) return 'name';
  if (!compatibleEndpointPreview(profile.base_url, profile.base_url_mode)) return 'url';
  if (!Number.isInteger(profile.timeout) || profile.timeout < 1 || profile.timeout > 1800) return 'timeout';
  if (profile.partial_images !== undefined && (!Number.isInteger(profile.partial_images) || profile.partial_images < 0 || profile.partial_images > 3)) return 'partial_images';
  if (profile.models && (profile.models.length > 100 || profile.models.some(model => !model.trim() || model.trim().length > 200 || /[\u0000-\u001f]/.test(model)))) return 'models';
}

export function parseProfileModels(value: string): string[] {
  return [...new Set(value.split(/[,，\r\n]+/).map(model => model.trim()).filter(Boolean))];
}

/** The selected historical/custom model remains available after a profile changes. */
export function profileModelChoices(profile: Pick<OpenAICompatibleProfile, 'models' | 'model' | 'model_catalog'> | undefined, selected: string, fallback: string[] = []): string[] {
  const configured = profile?.models?.length ? profile.models : fallback;
  const discovered = [...(profile?.model_catalog?.models || [])].sort((a,b) => Number(b.image_generation === true) - Number(a.image_generation === true));
  return [...new Set([selected, profile?.model || '', ...configured, ...discovered.map(model => model.id)].map(model => model.trim()).filter(Boolean))];
}
