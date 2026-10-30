import type { AgentImageParams } from '../api/agentClient';
import type { GenerationJobRecord, GenerationSetCount } from '../types';
import type { GalleryDraft } from './galleryRecipe';

// Shared pending image choices. Each workspace keeps its own prompt and images,
// resolves automatic dimensions at send time, and freezes its submitted request.
// Credentials and historical transport overrides never travel with these choices.
export interface GalleryImageSettings {
  provider: string;
  profileId: string;
  model: string;
  params: AgentImageParams;
  sizeMode?: 'auto4k';
  // Optional for existing callers/drafts; the historical default is one image.
  count?: GenerationSetCount;
  unavailable?: string;
}

export interface GalleryImageSettingsCommand { id: number; settings: GalleryImageSettings }

export function sharedImageCount(count: unknown): GenerationSetCount {
  return count === 3 || count === 5 || count === 10 ? count : 1;
}

/** Apply only image choices. Never replace the Gallery's text, variables or images. */
export function applyGalleryImageSettings(draft: GalleryDraft, settings: GalleryImageSettings): GalleryDraft {
  if (settings.provider !== 'openai_compatible') return draft;
  const params = settings.params;
  return { ...draft, provider: settings.provider, profileId: settings.profileId,
    // Shared dimensions replace any historical prompt-injected ratio as well.
    aspectRatio: 'auto', aspectInjection: undefined, recipe: {
    model: settings.model, size: params.size, quality: params.quality,
    background: params.background || 'auto', output_format: params.output_format,
    ...(settings.sizeMode === 'auto4k' ? { size_mode: 'auto4k' as const } : {}),
    ...(params.output_format !== 'png' && params.output_compression != null ? { output_compression: params.output_compression } : {}),
    ...(params.moderation === 'auto' || params.moderation === 'low' ? { moderation: params.moderation } : {}),
  } };
}

export interface AgentGalleryCommand {
  id: number;
  job: GenerationJobRecord;
  intent: 'reference' | 'conversation';
}

export function agentJobSource(job: Pick<GenerationJobRecord, 'metadata'>): { conversationId: string; roundId?: string } | undefined {
  const value = job.metadata?.agentRetry || job.metadata?.agent;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  if (typeof source.conversationId !== 'string' || !source.conversationId) return;
  return { conversationId: source.conversationId, ...(typeof source.roundId === 'string' && source.roundId ? { roundId: source.roundId } : {}) };
}
