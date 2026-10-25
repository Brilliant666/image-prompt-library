import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyTextToClipboard } from '../../utils/clipboard';
import './AgentCodeBlock.css';

export function AgentCodeBlock({ children }: { children: ReactNode }) {
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
    // Read only the displayed code, keeping whitespace and excluding the
    // surrounding explanation, language label and copy control.
    const text = content.current?.textContent;
    if (!text) return;
    let copied = false;
    try { copied = await copyTextToClipboard(text); } catch { /* Keep manual selection available. */ }
    if (!mounted.current) return;
    setStatus(copied ? 'copied' : 'failed');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setStatus('idle'); }, 1800);
  }

  return <div className="agent-code-block">
    <div className="agent-code-block-toolbar">
      <button type="button" aria-label="复制文本" onClick={() => void copy()}>
        {status === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        <span aria-live="polite">{status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请手动选择' : '复制文本'}</span>
      </button>
    </div>
    <pre ref={content}>{children}</pre>
  </div>;
}
