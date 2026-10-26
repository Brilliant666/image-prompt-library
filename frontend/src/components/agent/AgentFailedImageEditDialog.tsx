import { useEffect, useRef, useState } from 'react';
import type { GenerationJobRecord } from '../../types';
import { AgentActionDialog } from './AgentActionDialog';

export default function AgentFailedImageEditDialog({ job, onApply, onClose }: {
  job: GenerationJobRecord; onApply: (prompt: string) => Promise<void>; onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(job.edited_prompt_text || job.prompt_text);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submitting = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function apply() {
    if (submitting.current || !prompt.trim()) return;
    submitting.current = true; setBusy(true); setError('');
    try { await onApply(prompt); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '无法恢复原始参考图片，草稿保持不变。'); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  return <AgentActionDialog title="修改提示词后重新生成" onClose={onClose}>
    <div className="agent-action-body">
      <p>下方是图片任务实际执行的提示词。确认后，将它与原冻结参考图片填入当前草稿，再由你检查配置并发送。</p>
      <label>执行提示词<textarea aria-label="修改实际执行提示词" value={prompt} disabled={busy} rows={10} onChange={event => setPrompt(event.target.value)} /></label>
      <p className="agent-action-help">填入会替换当前输入框及附件；取消不会更改草稿。读取失败或缺少原图时不替换。此操作不发送模型请求。</p>
      {error && <p className="agent-action-error" role="alert">{error}</p>}
    </div>
    <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="agent-action-primary" disabled={busy || !prompt.trim()} onClick={() => void apply()}>{busy ? '读取冻结参考图…' : '确认填入当前草稿'}</button></footer>
  </AgentActionDialog>;
}
