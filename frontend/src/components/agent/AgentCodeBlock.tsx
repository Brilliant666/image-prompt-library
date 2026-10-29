import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyTextToClipboard } from '../../utils/clipboard';
import './AgentCodeBlock.css';

export function AgentCodeBlock({ children, prompt = false, copyText, onSelectPrompt, promptSelectionDisabled = false }: { children: ReactNode; prompt?: boolean; copyText?: string; onSelectPrompt?: (text: string) => void; promptSelectionDisabled?: boolean }) {
  const content = useRef<HTMLPreElement>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    // Prompt source preserves original whitespace, including an unfinished
    // streamed fence. Code keeps its normal rendered-text copy behavior.
    const text = copyText ?? content.current?.textContent;
    if (!text) return;
    let copied = false;
    try { copied = await copyTextToClipboard(text); } catch { /* Keep manual selection available. */ }
    if (!mounted.current) return;
    setStatus(copied ? 'copied' : 'failed');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setStatus('idle'); }, 1800);
  }

  const label = prompt ? '复制提示词' : '复制文本';
  return <div className={`agent-code-block${prompt ? ' agent-prompt-block' : ''}`}>
    <div className="agent-code-block-toolbar">
      {prompt && <strong className="agent-prompt-block-title">提示词 <span>· 纯文本</span></strong>}
      {prompt && onSelectPrompt && <button type="button" aria-label="设为当前任务 Prompt" disabled={promptSelectionDisabled || !copyText} onClick={() => { if (copyText) onSelectPrompt(copyText); }}>设为当前 Prompt</button>}
      <button type="button" aria-label={label} onClick={() => void copy()} disabled={prompt && copyText === ''}>
        {status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        <span aria-live="polite">{status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请手动选择' : label}</span>
      </button>
    </div>
    <pre ref={content}>{children}</pre>
  </div>;
}
