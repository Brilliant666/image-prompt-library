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

/** Names are only UI hints: they never establish an API capability. */
export function isGptImageModelName(id: string): boolean {
  return /(?:^|[/:_\s-])gpt[-_]image(?:[-_]|$)/i.test(id);
}

/** Recommend images without losing a selected historical/custom model. */
export function profileModelChoices(profile: Pick<OpenAICompatibleProfile, 'models' | 'model' | 'model_catalog'> | undefined, selected: string, fallback: string[] = []): string[] {
  const configured = profile?.models?.length ? profile.models : fallback;
  const catalog = profile?.model_catalog?.models || [];
  const byId = new Map(catalog.map(model => [model.id, model]));
  const recommends = (id: string) => {
    const detected = byId.get(id.trim());
    if (detected?.image_generation === false) return false;
    return isGptImageModelName(id);
  };
  const defaultModel = profile?.model?.trim() || '';
  const discovered = catalog.filter(model => recommends(model.id)).sort((a,b) => Number(b.image_generation === true) - Number(a.image_generation === true));
  return [...new Set([selected, recommends(defaultModel) ? defaultModel : '', ...configured.filter(recommends), ...discovered.map(model => model.id)].map(model => model.trim()).filter(Boolean))];
}
