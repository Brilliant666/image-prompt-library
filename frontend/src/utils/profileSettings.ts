import type { ApiProtocol, OpenAICompatibleProfile } from '../types';

/** Mirrors the backend Base URL contract; never includes URL credentials. */
export function compatibleEndpointPreview(value: string, mode: 'versioned' | 'custom' = 'versioned', protocol:ApiProtocol='openai_compatible', model='MODEL_ID'): { base: string; generate: string; edit: string; responses: string } | undefined {
  try {
    const address = new URL(value.trim());
    if (!['http:', 'https:'].includes(address.protocol) || !address.hostname || address.username || address.password || address.search || address.hash) return;
    let path = address.pathname.replace(/\/+$/, '');
    if (protocol !== 'openai_compatible') {
      if (path.includes('/images/') || path.includes('/models/') || path.includes(':generateContent')) return;
      if (mode === 'versioned') {
        if (protocol === 'gemini_native' && !/(?:\/v1|\/v1beta)$/.test(path)) path += '/v1beta';
        if (protocol === 'seedream_native' && !path.endsWith('/api/v3')) path += '/api/v3';
      }
      const base=`${address.origin}${path}`;
      const endpoint=protocol==='gemini_native'?`${base}/models/${encodeURIComponent(model.replace(/^models\//,''))}:generateContent`:`${base}/images/generations`;
      return {base,generate:endpoint,edit:endpoint,responses:''};
    }
    if (mode === 'versioned') while (path.endsWith('/v1')) path = path.slice(0, -3);
    if (path.includes('/images/')) return;
    const base = `${address.origin}${path}${mode === 'versioned' ? '/v1' : ''}`;
    return { base, generate: `${base}/images/generations`, edit: `${base}/images/edits`, responses: `${base}/responses` };
  } catch { return; }
}

export function profileValidation(profile: Pick<OpenAICompatibleProfile, 'display_name' | 'base_url' | 'timeout' | 'base_url_mode' | 'partial_images' | 'models' | 'protocol'>): 'name' | 'url' | 'timeout' | 'partial_images' | 'models' | undefined {
  if (!profile.display_name.trim()) return 'name';
  if (!compatibleEndpointPreview(profile.base_url, profile.base_url_mode, profile.protocol)) return 'url';
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
export function profileModelChoices(profile: Pick<OpenAICompatibleProfile, 'models' | 'model' | 'model_catalog' | 'protocol' | 'image_capabilities'> | undefined, selected: string, fallback: string[] = []): string[] {
  const configured = profile?.models?.length ? profile.models : fallback;
  if (profile?.protocol && profile.protocol !== 'openai_compatible') return [...new Set([
    selected,profile.model,...configured,...(profile.model_catalog?.models||[]).filter(entry=>entry.image_generation!==false).map(entry=>entry.id),
    ...(profile.image_capabilities?.known_models||[]),
  ].map(value=>value.trim()).filter(Boolean))];
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

/** Neutral name for connection-level callers; the legacy export is retained. */
export const connectionEndpointPreview = compatibleEndpointPreview;
