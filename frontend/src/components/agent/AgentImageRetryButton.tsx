import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { api, mediaUrl } from '../../api/client';
import { agentApi, AgentApiError, type AgentConfigResponse, type AgentImageParams, type AgentImageRetryReceipt } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';
import { resolveAuto4k } from '../../utils/compatibleRecipe';
import { recipeInputs } from '../../utils/recipeInputs';
import { clearImageRetry, readImageRetries, saveImageRetry } from '../../utils/playground/agentImageRetry';

/** One click is one explicit image request. Uncertain receipts can only be read. */
export default function AgentImageRetryButton({ job, conversationId, config, selection, params, sizeMode, disabled, onReceipt }: {
  job: GenerationJobRecord; conversationId: string; config: AgentConfigResponse;
  selection?: { profileId?: string | null; model: string }; params: AgentImageParams;
  sizeMode?: 'auto4k'; disabled?: boolean; onReceipt: (value: AgentImageRetryReceipt) => void;
}) {
  const [pending, setPending] = useState(() => readImageRetries(localStorage).find(row => row.sourceJobId === job.id && row.conversationId === conversationId));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function retry() {
    if (running.current || disabled && !pending) return;
    running.current = true; setBusy(true); setError('');
    let entry = pending;
    try {
      if (entry) {
        const receipt = await agentApi.imageRetryReceipt(entry.retryId, entry.conversationId);
        clearImageRetry(localStorage, entry.retryId);
        if (alive.current) { setPending(undefined); onReceipt(receipt); }
        return;
      }
      // Freeze the current shared settings at the click, before any async reads.
      const hybrid = config.config.apiConfigMode === 'hybrid';
      const profileId = hybrid ? selection?.profileId ?? config.config.imageProfileId : null;
      const model = selection ? selection.model : config.config.imageModel || (hybrid ? config.profiles.find(p => p.id === profileId)?.model : '') || '';
      let frozenParams = structuredClone(params);
      const revision = config.revision;
      if (sizeMode === 'auto4k') {
        const original = await api.generationJob(job.id);
        let resolved = resolveAuto4k(original.prompt_text);
        if ('error' in resolved) throw new Error('原提示词包含冲突比例，请在生图设置中选择明确尺寸。');
        const inputs = recipeInputs(original, mediaUrl);
        if (resolved.source !== 'prompt' && inputs.length) {
          const first = inputs[0];
          if (first.missing || !first.previewUrl) throw new Error('原参考图缺失，不能改用其他图片重试。');
          const image = new Image(); image.src = first.previewUrl;
          await image.decode();
          resolved = resolveAuto4k(original.prompt_text, { width: image.naturalWidth, height: image.naturalHeight });
        }
        if ('error' in resolved) throw new Error('无法确定重试图片尺寸。');
        frozenParams = { ...frozenParams, size: resolved.size };
      }
      if (!alive.current) return;
      entry = { retryId: crypto.randomUUID(), sourceJobId: job.id, conversationId };
      saveImageRetry(localStorage, entry); setPending(entry);
      const receipt = await agentApi.retryImage(job.id, { retryId: entry.retryId, conversationId, configRevision: revision,
        imageConfig: { profileId, model }, params: frozenParams, confirmed: true });
      clearImageRetry(localStorage, entry.retryId);
      if (alive.current) { setPending(undefined); onReceipt(receipt); }
    } catch (reason) {
      const rejected = !pending && reason instanceof AgentApiError && [400, 401, 403, 404, 409, 422].includes(reason.status);
      if (rejected && entry) clearImageRetry(localStorage, entry.retryId);
      if (alive.current) {
        if (rejected) setPending(undefined);
        setError(entry && !rejected ? '结果尚未确认，再点此按钮仅检查原请求。' : reason instanceof Error ? reason.message : '未能重试图片。');
      }
    } finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <span className="agent-image-retry"><button type="button" aria-label={pending ? '检查图片重试状态' : '重试图片'} title={pending ? '检查原重试状态，不会再次生成' : '重试：保留提示词和参考图，使用当前生图设置'} disabled={busy || Boolean(disabled && !pending)} onClick={() => void retry()}>{busy ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}</button>{error && <span className="agent-error" role="alert">{error}</span>}</span>;
}
