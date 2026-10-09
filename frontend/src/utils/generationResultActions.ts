import type { GenerationJobRecord } from '../types';

export function generationResultActions(job?: Pick<GenerationJobRecord, 'id' | 'status' | 'result_path' | 'accepted_image_id'>) {
  const reusable = Boolean(job?.result_path && ['succeeded', 'accepted'].includes(job.status));
  const pending = reusable && job?.status === 'succeeded' && !job.accepted_image_id;
  return {
    reusable,
    save: pending,
    discardAndRetry: pending,
    discard: Boolean(pending && job?.result_path?.startsWith(`generation-results/${job.id}/`)),
    restoreDraft: reusable && !pending,
  };
}
