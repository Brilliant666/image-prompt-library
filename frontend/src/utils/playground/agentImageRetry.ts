import type { AgentImageParams } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';

export interface PendingImageRetry { retryId: string; sourceJobId: string; conversationId: string }
const KEY = 'ipl.agent.pending-image-retries.v1';
export function readImageRetries(storage: Pick<Storage, 'getItem'>): PendingImageRetry[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.filter((row): row is PendingImageRetry => Boolean(row && typeof row === 'object' && ['retryId', 'sourceJobId', 'conversationId'].every(key => typeof row[key] === 'string' && row[key]))) : [];
  } catch { return []; }
}
export function saveImageRetry(storage: Pick<Storage, 'getItem' | 'setItem'>, entry: PendingImageRetry) {
  storage.setItem(KEY, JSON.stringify([...readImageRetries(storage).filter(row => row.retryId !== entry.retryId), entry]));
}
export function clearImageRetry(storage: Pick<Storage, 'getItem' | 'setItem'>, retryId: string) {
  storage.setItem(KEY, JSON.stringify(readImageRetries(storage).filter(row => row.retryId !== retryId)));
}
export function imageJobParams(job: GenerationJobRecord): AgentImageParams {
  const requested = job.metadata?.requested;
  const params = { ...job.parameters, ...(requested && typeof requested === 'object' && !Array.isArray(requested) ? requested as Record<string, unknown> : {}) };
  return {
    size: typeof params.size === 'string' ? params.size : 'auto',
    quality: typeof params.quality === 'string' ? params.quality : 'auto',
    output_format: params.output_format === 'jpeg' || params.output_format === 'webp' ? params.output_format : 'png',
    background: typeof params.background === 'string' ? params.background : 'auto',
    ...(typeof params.moderation === 'string' ? { moderation: params.moderation } : {}),
    ...(typeof params.output_compression === 'number' ? { output_compression: params.output_compression } : {}),
  };
}
