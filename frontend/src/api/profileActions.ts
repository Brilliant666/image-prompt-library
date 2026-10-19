import type { OpenAICompatibleProfiles } from '../types';

async function profileAction(path: string, method: 'POST' | 'PUT', payload: unknown): Promise<OpenAICompatibleProfiles> {
  const response = await fetch(`/api/generation-providers/openai-compatible/profiles${path}`, {
    method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  // Response bodies can contain diagnostics from a proxy. Never display them.
  if (!response.ok) throw new Error('profile_action_failed');
  const value = await response.json() as OpenAICompatibleProfiles;
  if (!Array.isArray(value.profiles)) throw new Error('invalid_profiles');
  return value;
}

export function copyApiProfile(sourceId: string, newId: string, displayName: string) {
  return profileAction(`/${encodeURIComponent(sourceId)}/copy`, 'POST', { id: newId, display_name: displayName });
}

export function reorderApiProfiles(profileIds: string[]) {
  return profileAction('/reorder', 'POST', { profile_ids: profileIds });
}
