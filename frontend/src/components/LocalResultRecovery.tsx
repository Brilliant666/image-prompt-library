import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { GenerationJobRecord } from '../types';
import { localResultRecovery } from '../utils/localResultRecovery';

/** This action only registers retained bytes on the same job; it never generates. */
export default function LocalResultRecovery({ job, disabled = false, onRecovered }: {
  job: GenerationJobRecord; disabled?: boolean; onRecovered?: (job: GenerationJobRecord) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), alive = useRef(true), identity = useRef(job.id);
  identity.current = job.id;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setError(''); }, [job.id]);
  const recovery = localResultRecovery(job);
  if (!recovery) return null;
  async function recover() {
    if (lock.current || disabled || !recovery?.can_recover) return;
    const id = job.id;
    lock.current = true; setBusy(true); setError('');
    try {
      const restored = await api.recoverGenerationJob(id);
      if (restored.id !== id) throw new Error('恢复记录与原任务不一致，请检查原结果。');
      if (alive.current && identity.current === id) onRecovered?.(restored);
    } catch (reason) {
      if (alive.current && identity.current === id) setError(reason instanceof Error ? reason.message : '未能恢复本地结果；不会重新生成。');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return <div className="generation-result-recovery">
    <p role="status">{recovery.message}</p>
    <button type="button" aria-label="恢复本地结果" title="仅登记已保留的图片，不调用图片或文字模型" disabled={disabled || busy || !recovery.can_recover} onClick={() => void recover()}>{busy ? '正在恢复本地结果…' : '恢复本地结果'}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
