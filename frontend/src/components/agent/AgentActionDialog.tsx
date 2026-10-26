import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useModalFocus } from '../../hooks/useModalFocus';
import './AgentActionDialog.css';

export function AgentActionDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { containerRef, handleModalKeyDown } = useModalFocus<HTMLDivElement>(onClose);
  useEffect(() => {
    const root = document.getElementById('root'), inert = root?.inert, overflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = 'hidden';
    return () => { if (root) root.inert = Boolean(inert); document.body.style.overflow = overflow; };
  }, []);
  return createPortal(<div className="agent-action-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="agent-action-dialog" role="dialog" aria-modal="true" aria-label={title} ref={containerRef} tabIndex={-1} onKeyDown={handleModalKeyDown}>
      <header><h2>{title}</h2><button type="button" aria-label={`关闭${title}`} onClick={onClose}><X size={19} /></button></header>
      {children}
    </div>
  </div>, document.body);
}
