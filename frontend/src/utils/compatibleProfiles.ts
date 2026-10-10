import type { GenerationJobRecord, GenerationProviderStatus, OpenAICompatibleProfile } from '../types';

export type GenerationProviderChoice = GenerationProviderStatus & { profile_id?: string };

/** Legacy recipes belong to the original endpoint, never to a newly selected default. */
export function recipeProfileId(job: Pick<GenerationJobRecord, 'parameters' | 'metadata'>): string {
  const requested = job.metadata?.requested as Record<string, unknown> | undefined;
  const id = requested?.compatible_profile_id ?? job.parameters?.compatible_profile_id;
  return typeof id === 'string' && id ? id : 'legacy';
}

export function generationProviderChoices(providers: GenerationProviderStatus[], profiles: OpenAICompatibleProfile[]): GenerationProviderChoice[] {
  return providers.flatMap(provider => {
    if (provider.provider !== 'openai_compatible') return [provider];
    if (!profiles.length) return [{ ...provider, configured: false, available: false, authenticated: false, can_generate: false }];
    return profiles.map(profile => ({
      ...provider, profile_id: profile.id, display_name: profile.display_name,
      configured: profile.configured, authenticated: profile.api_key_present,
      available: profile.configured, can_generate: profile.configured,
      state: profile.configured ? 'connected' : 'not_connected',
      status: profile.configured ? 'ready' as const : 'login_required' as const,
      model: profile.model, default_image_model: profile.model,
      features: { ...provider.features, text_to_image: profile.configured, image_edit: profile.configured, text_reference_to_image: profile.configured },
    }));
  });
}
