import type { AgentImageParams } from '../api/agentClient';
import type { GenerationJobRecord } from '../types';

// An in-memory, explicit handoff. No credentials, prompts, attachments or
// transport overrides travel with the image settings.
export interface GalleryImageSettings {
  provider: string;
  profileId: string;
  model: string;
  params: AgentImageParams;
  unavailable?: string;
}

export interface AgentGalleryCommand {
  id: number;
  job: GenerationJobRecord;
  intent: 'reference' | 'conversation';
}

export function agentJobSource(job: Pick<GenerationJobRecord, 'metadata'>): { conversationId: string; roundId?: string } | undefined {
  const value = job.metadata?.agent;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  if (typeof source.conversationId !== 'string' || !source.conversationId) return;
  return { conversationId: source.conversationId, ...(typeof source.roundId === 'string' && source.roundId ? { roundId: source.roundId } : {}) };
}
