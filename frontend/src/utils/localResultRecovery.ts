import type { GenerationJobRecord } from '../types';

export function localResultRecovery(job: GenerationJobRecord): { state: 'pending' | 'blocked'; message: string; can_recover: boolean } | undefined {
  const value = job.metadata?.local_result_recovery;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.state !== 'pending' && record.state !== 'blocked') return;
  return { state: record.state,
    message: typeof record.message === 'string' ? record.message : '图片已取得，本地保存记录待恢复。',
    can_recover: record.state === 'pending' && record.can_recover === true };
}
