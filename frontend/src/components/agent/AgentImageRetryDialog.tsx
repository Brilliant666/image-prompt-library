import { useEffect, useRef, useState } from 'react';
import { AgentApiError, agentApi, type AgentConfigResponse, type AgentImageParams, type AgentImageRetryReceipt } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';
import { clearImageRetry, imageJobParams, readImageRetries, saveImageRetry, type PendingImageRetry } from '../../utils/playground/agentImageRetry';
import ToolbarSelect from '../ToolbarSelect';
import AgentModelPicker from '../settings/AgentModelPicker';
import { AgentActionDialog } from './AgentActionDialog';

export default function AgentImageRetryDialog({ job, conversationId, config, selection, onClose, onReceipt, onEdit }: {
  job: GenerationJobRecord; conversationId: string; config: AgentConfigResponse;
  selection?: { profileId?: string | null; model: string };
  onClose: () => void; onReceipt: (receipt: AgentImageRetryReceipt) => void; onEdit: () => void;
}) {
  const [profileId, setProfileId] = useState(selection?.profileId || config.config.imageProfileId || '');
  const [model, setModel] = useState(selection ? selection.model : config.config.imageModel);
  const [params, setParams] = useState(() => imageJobParams(job));
  const [pending, setPending] = useState<PendingImageRetry | undefined>(() => readImageRetries(localStorage).find(row => row.sourceJobId === job.id && row.conversationId === conversationId));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState<AgentImageRetryReceipt>();
  const inFlight = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const profile = config.profiles.find(row => row.id === profileId);
  const effectiveModel = model.trim() || profile?.model || '';
  const native = job.provider === 'agent_native' || job.provider === 'agent_native_batch';
  const unsupported = native || job.provider !== 'openai_compatible' || config.config.apiConfigMode !== 'hybrid';
  const locked = busy || Boolean(pending) || Boolean(receipt);
  const accept = (value: AgentImageRetryReceipt) => {
    clearImageRetry(localStorage, value.retryId);
    if (!alive.current) return;
    setPending(undefined); setReceipt(value); setError(''); onReceipt(value);
  };
  async function submit() {
    if (inFlight.current || locked || unsupported || !profile?.configured || !effectiveModel || !params.size.trim()) return;
    inFlight.current = true; setBusy(true); setError('');
    const entry = { retryId: crypto.randomUUID(), sourceJobId: job.id, conversationId };
    try {
      // Persist before POST. Render, reopen and refresh never replay this entry.
      saveImageRetry(localStorage, entry); setPending(entry);
      accept(await agentApi.retryImage(job.id, { retryId: entry.retryId, conversationId, configRevision: config.revision, imageConfig: { profileId, model: effectiveModel }, params, confirmed: true }));
    } catch (reason) {
      const rejected = reason instanceof AgentApiError && [400, 401, 403, 404, 409, 422].includes(reason.status);
      if (rejected) clearImageRetry(localStorage, entry.retryId);
      if (alive.current) { if (rejected) setPending(undefined); setError(rejected ? reason.message : '提交结果未知，请检查原重试状态；不会自动再次提交。'); }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function check() {
    if (!pending || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { accept(await agentApi.imageRetryReceipt(pending.retryId, pending.conversationId)); }
    catch { if (alive.current) setError('尚未确认重试结果，请稍后再次检查；原重试身份保持不变。'); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  const changeParams = (patch: Partial<AgentImageParams>) => { if (!locked) setParams(old => ({ ...old, ...patch })); };
  return <AgentActionDialog title="使用当前生图配置重试" onClose={onClose}>
    <div className="agent-action-body">
      <p>沿用原图片任务的执行提示词和冻结参考图，创建一张新图片。原失败记录保留，不重新调用文字模型。</p>
      {unsupported && <p className="agent-action-error" role="status">此任务或当前模式使用原生 Responses 协议，暂不支持直接换配置重试。可以修改提示词后通过原 Agent 模式重新生成，不会静默转换为 Images API。</p>}
      <label>生图供应商<ToolbarSelect label="重试生图供应商" value={profileId} options={[{ value: '', label: '选择生图供应商', disabled: true }, ...config.profiles.map(row => ({ value: row.id, label: row.display_name }))]} disabled={locked || unsupported} onChange={id => { if (!locked) { setProfileId(id); setModel(config.profiles.find(row => row.id === id)?.model || ''); } }} /></label>
      <AgentModelPicker label="重试生图模型" value={model} profile={profile} active={!locked && !unsupported} en={false} disabled={locked || unsupported} imageRecommendations onChange={value => { if (!locked) setModel(value); }} />
      <p className="agent-action-help">将使用：{profile?.display_name || '未选择供应商'} · {effectiveModel || '未选择模型'}{model.trim() && model.trim() !== profile?.model ? ' · 手动覆盖模型' : ' · 供应商默认模型'}</p>
      <div className="agent-action-params">
        <label>尺寸<input aria-label="重试尺寸" value={params.size} disabled={locked || unsupported} onChange={event => changeParams({ size: event.target.value })} /></label>
        <label>质量<ToolbarSelect label="重试质量" value={params.quality} options={[...new Set(['auto','low','medium','high','xhigh','max', params.quality])].map(value => ({ value, label: value }))} disabled={locked || unsupported} onChange={quality => changeParams({ quality })} /></label>
        <label>格式<ToolbarSelect label="重试格式" value={params.output_format} options={['png','jpeg','webp'].map(value => ({ value, label: value.toUpperCase() }))} disabled={locked || unsupported} onChange={value => changeParams({ output_format: value as AgentImageParams['output_format'] })} /></label>
        <label>背景<ToolbarSelect label="重试背景" value={params.background || 'auto'} options={['auto','opaque','transparent'].map(value => ({ value, label: value }))} disabled={locked || unsupported} onChange={background => changeParams({ background })} /></label>
        <label>审核<ToolbarSelect label="重试审核" value={params.moderation || 'auto'} options={['auto','low'].map(value => ({ value, label: value }))} disabled={locked || unsupported} onChange={moderation => changeParams({ moderation })} /></label>
        {params.output_format !== 'png' && <label>压缩质量<input aria-label="重试压缩质量" type="number" min={0} max={100} value={params.output_compression ?? ''} disabled={locked || unsupported} onChange={event => changeParams({ output_compression: event.target.value === '' ? null : Number(event.target.value) })} /></label>}
      </div>
      <p>点击确认将调用所选图片接口，可能产生费用。具体费用以供应商为准；不会自动换接口或再次重试。</p>
      {pending && <p role="status">已有重试提交待确认。关闭或刷新后仍只检查这次提交，不重复生成。</p>}
      {receipt && <p role="status">已创建重试任务；原失败记录和草稿保持不变。</p>}
      {error && <p className="agent-action-error" role="alert">{error}</p>}
    </div>
    <footer><button type="button" onClick={onClose}>关闭</button>{unsupported && !pending && <button type="button" onClick={onEdit}>修改提示词后重新生成</button>}{pending ? <button type="button" className="agent-action-primary" disabled={busy} onClick={() => void check()}>检查原重试状态</button> : !receipt && <button type="button" className="agent-action-primary" disabled={locked || unsupported || !profile?.configured || !effectiveModel || !params.size.trim()} onClick={() => void submit()}>确认重试一张图片</button>}</footer>
  </AgentActionDialog>;
}
