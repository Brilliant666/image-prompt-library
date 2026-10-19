import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, LoaderCircle, Search, X } from 'lucide-react';
import { api, mediaUrl } from '../../api/client';
import type { GenerationJobRecord, ItemDetail, ItemSummary } from '../../types';
import { referenceKey, type ReferenceChoice } from '../../utils/playground/agentImageReferences';
import { useModalFocus } from '../../hooks/useModalFocus';

export function AgentReferencePicker({ onClose, onSelect, remaining }: { onClose: () => void; onSelect: (items: ReferenceChoice[]) => void; remaining: number }) {
  const [tab, setTab] = useState<'library' | 'gallery'>('library');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [jobs, setJobs] = useState<GenerationJobRecord[]>([]);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [selected, setSelected] = useState<ReferenceChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const alive = useRef(true);
  const detailSequence = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const { containerRef, handleModalKeyDown } = useModalFocus<HTMLDivElement>(close);
  useEffect(() => { alive.current = true; return () => { alive.current = false; detailSequence.current++; }; }, []);
  function close() { detailSequence.current++; onClose(); }
  function leaveDetail() { detailSequence.current++; setDetail(null); }
  function changeTab(next: 'library' | 'gallery') { leaveDetail(); setTab(next); setPage(0); }
  async function openDetail(id: string) {
    const sequence = ++detailSequence.current;
    setError('');
    try {
      const value = await api.item(id);
      if (alive.current && sequence === detailSequence.current && tabRef.current === 'library') setDetail(value);
    } catch (reason) {
      if (alive.current && sequence === detailSequence.current && tabRef.current === 'library') setError(String(reason));
    }
  }
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError('');
    const timer = setTimeout(async () => {
      try {
        if (tab === 'library') {
          const result = await api.items({ q: query, limit: 60, offset: page * 60, sort: 'created_desc' });
          if (!disposed) { setItems(old => page ? [...old, ...result.items.filter(item => !old.some(existing => existing.id === item.id))] : result.items); setTotal(result.total); }
        } else {
          const result = await api.generationJobs({ limit: 60, offset: page * 60 });
          const available = result.jobs.filter(job => job.result_path && ['succeeded', 'accepted'].includes(job.status));
          if (!disposed) { setJobs(old => page ? [...old, ...available.filter(job => !old.some(existing => existing.id === job.id))] : available); setTotal(result.total); }
        }
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : '读取失败'); }
      finally { if (!disposed) setLoading(false); }
    }, 180);
    return () => { disposed = true; clearTimeout(timer); };
  }, [tab, query, page]);
  const choices: ReferenceChoice[] = detail ? detail.images.map(image => ({ reference: { kind: 'library', imageId: image.id }, label: detail.title, url: mediaUrl(image.thumb_path || image.preview_path || image.original_path) })) : tab === 'library'
    ? items.filter(item => item.first_image).map(item => ({ reference: { kind: 'library', imageId: item.first_image!.id }, label: item.title, url: mediaUrl(item.first_image!.thumb_path || item.first_image!.original_path) }))
    : jobs.filter(job => !query || job.prompt_text.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(job => ({ reference: { kind: 'job', jobId: job.id }, label: job.prompt_text, url: mediaUrl(job.result_path || '') }));
  function toggle(choice: ReferenceChoice) {
    setSelected(old => old.some(item => referenceKey(item.reference) === referenceKey(choice.reference)) ? old.filter(item => referenceKey(item.reference) !== referenceKey(choice.reference)) : old.length < remaining ? [...old, choice] : old);
  }
  return <div className="agent-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="agent-reference-picker" role="dialog" aria-modal="true" aria-label="选择引用图片" ref={containerRef} onKeyDown={handleModalKeyDown}>
      <header><strong>{detail ? detail.title : '选择引用图片'}</strong><button type="button" aria-label="关闭选择图片" onClick={close}><X size={19} /></button></header>
      <div className="agent-picker-toolbar">{detail ? <button onClick={leaveDetail}><ArrowLeft size={16} />返回列表</button> : <>
        <button className={tab === 'library' ? 'selected' : ''} onClick={() => changeTab('library')}>Library</button>
        <button className={tab === 'gallery' ? 'selected' : ''} onClick={() => changeTab('gallery')}>画廊</button>
        <label><Search size={16} /><input aria-label="搜索引用图片" value={query} onChange={event => { leaveDetail(); setQuery(event.target.value); setPage(0); }} placeholder={tab === 'library' ? '搜索 Library' : '筛选已加载的生成结果'} /></label>
      </>}</div>
      <p className="agent-help">仅选中的图片会加入本轮上下文。还可选 {Math.max(0, remaining - selected.length)} 张。</p>
      {error && <p role="alert" className="agent-error">{error}</p>}
      <div className="agent-picker-grid">{choices.map(choice => {
        const key = referenceKey(choice.reference);
        const chosen = selected.some(item => referenceKey(item.reference) === key);
        const item = !detail && tab === 'library' ? items.find(item => item.first_image?.id === (choice.reference as { imageId: string }).imageId) : null;
        return <div key={key} className={chosen ? 'chosen' : ''}>
          <button type="button" onClick={() => toggle(choice)} aria-pressed={chosen} aria-label={`选择 ${choice.label}`}><img src={choice.url} alt={choice.label} loading="lazy" /><span>{chosen && <Check size={15} />}{choice.label}</span></button>
          {item && <button className="agent-text-button" onClick={() => void openDetail(item.id)}>查看此条目的全部图片</button>}
        </div>;
      })}</div>
      {loading && <p className="agent-help"><LoaderCircle size={16} className="spin" />读取中…</p>}
      {!loading && !choices.length && <p className="agent-help">没有可选图片。</p>}
      {!detail && total > (page + 1) * 60 && <button disabled={loading} onClick={() => setPage(value => value + 1)}>加载更多（已读取 {Math.min((page + 1) * 60, total)} / {total} 条）</button>}
      <footer><button onClick={close}>取消</button><button className="agent-primary" disabled={!selected.length} onClick={() => { onSelect(selected); close(); }}>添加 {selected.length} 张</button></footer>
    </div>
  </div>;
}
