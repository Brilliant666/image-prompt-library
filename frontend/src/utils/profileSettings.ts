import type { OpenAICompatibleProfile } from '../types';

/** Mirrors the existing backend Base URL contract; never includes URL credentials. */
export function compatibleEndpointPreview(value: string): { base: string; generate: string; edit: string; responses: string } | undefined {
  try {
    const address = new URL(value.trim());
    if (!['http:', 'https:'].includes(address.protocol) || !address.hostname || address.username || address.password || address.search || address.hash) return;
    let path = address.pathname.replace(/\/+$/, '');
    while (path.endsWith('/v1')) path = path.slice(0, -3);
    if (path.includes('/images/')) return;
    const base = `${address.origin}${path}/v1`;
    return { base, generate: `${base}/images/generations`, edit: `${base}/images/edits`, responses: `${base}/responses` };
  } catch { return; }
}

export function profileValidation(profile: Pick<OpenAICompatibleProfile, 'display_name' | 'base_url' | 'timeout'>): 'name' | 'url' | 'timeout' | undefined {
  if (!profile.display_name.trim()) return 'name';
  if (!compatibleEndpointPreview(profile.base_url)) return 'url';
  if (!Number.isInteger(profile.timeout) || profile.timeout < 1 || profile.timeout > 1800) return 'timeout';
}
