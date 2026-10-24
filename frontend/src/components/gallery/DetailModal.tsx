import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, ImagePlus, RotateCcw, Square, X, MessageSquare } from 'lucide-react';
import { api, mediaUrl } from '../../api/client';
import type { GenerationJobRecord, ItemSummary } from '../../types';
import type { Translator } from '../../utils/i18n';
import { galleryJobPrompt, galleryStatus } from '../../utils/galleryRecipe';
import { agentJobSource } from '../../utils/agentGalleryBridge';
import { recipeInputs } from '../../utils/recipeInputs';
import { copyTextToClipboard } from '../../utils/clipboard';
import { useModalFocus } from '../../hooks/useModalFocus';
import { GenerationResultSummary } from '../GenerationResultSummary';
import './DetailModal.css';

interface Props {
  job: GenerationJobRecord;
  t: Translator;
  onClose: () => void;
  onChange: () => void;
  onAccepted: (itemId: string, autoTitle?: boolean) => void;
  onReuse: (job: GenerationJobRecord, edit?: boolean) => void;
  onSendToAgent?: (job: GenerationJobRecord, intent: 'reference' | 'conversation') => void;
  onLightbox: () => void;
}

const AUTO_TITLE_KEY = 'ipl:gallery-auto-title:v1';

function readAutoTitlePreference() {
  try { return window.localStorage.getItem(AUTO_TITLE_KEY) === 'true'; } catch { return false; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parameter(value: unknown) {
  return typeof value === 'string' && value.trim() || typeof value === 'number' || typeof value === 'boolean'
    ? String(value) : '未记录';
}

export default function DetailModal({ job, t, onClose, onChange, onAccepted, onReuse, onSendToAgent, onLightbox }: Props) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [autoTitle, setAutoTitle] = useState(readAutoTitlePreference);
  const [attachMode, setAttachMode] = useState(false);
  const [target, setTarget] = useState('');
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [itemLimit, setItemLimit] = useState(1000);
  const [itemTotal, setItemTotal] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [copied, setCopied] = useState(0);
  const copyRequestRef = useRef(0);
  const {containerRef,handleModalKeyDown}=useModalFocus<HTMLDivElement>(onClose,{fallbackFocusSelector:'.pg-gallery:not([hidden]) .gallery-history-trigger'});

  useEffect(() => () => { copyRequestRef.current += 1; }, []);

  useEffect(() => {
    if (!saveOpen || !attachMode) return;
    let cancelled = false;
    setItemsLoading(true);
    void (async () => {
      const rows: ItemSummary[] = [];
      let total = 0;
      for (let offset = 0; offset < itemLimit; offset += 1000) {
        const list = await api.items({ limit: 1000, offset });
        if (cancelled) return;
        rows.push(...list.items);
        total = list.total;
        if (rows.length >= total || list.items.length === 0) break;
      }
      setItems(rows);
      setItemTotal(total);
    })().catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setItemsLoading(false); });
    return () => { cancelled = true; };
  }, [saveOpen, attachMode, itemLimit]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(0), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const canUse = Boolean(job.result_path && ['succeeded', 'accepted'].includes(job.status));
  const agentSource = agentJobSource(job);
  const prompt = galleryJobPrompt(job);
  const inputs = recipeInputs(job, mediaUrl);
  const requested = { ...job.parameters, ...record(job.metadata?.requested) };
  const status = galleryStatus[job.status] || job.status;
  const actualSize = canUse && job.result_width && job.result_width > 0 && job.result_height && job.result_height > 0
    ? `${job.result_width} × ${job.result_height}` : '';
  const parameterRows: Array<[string, unknown]> = [
    ['请求尺寸', requested.size ?? requested.requested_aspect_ratio],
    ['请求质量', requested.quality],
    ['格式', requested.output_format],
    ['背景', requested.background],
    ['审核', requested.moderation],
    ['批次数量', job.generation_group_size ?? 1],
  ];

  async function copyPrompt() {
    const request = ++copyRequestRef.current;
    try {
      if (!await copyTextToClipboard(prompt)) throw new Error('copy unavailable');
      if (request !== copyRequestRef.current) return;
      setCopied(value => value + 1);
      setError(value => value === '无法复制，请选择原文复制' ? '' : value);
    } catch {
      if (request !== copyRequestRef.current) return;
      setCopied(0);
      setError('无法复制，请选择原文复制');
    }
  }

  async function accept() {
    if (busy || (attachMode && !target)) return;
    setBusy(true);
    setError('');
    try {
      const result = attachMode
        ? await api.acceptGenerationJobIntoItem(job.id, target)
        : await api.acceptGenerationJobAsNewItem(job.id, {
          ...(title.trim() ? { title: title.trim() } : {}),
          auto_title: autoTitle && !title.trim(),
        });
      onChange();
      onAccepted(result.item.id, !attachMode && autoTitle && !title.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return <div className="pg-overlay pg-detail-overlay" onClick={onClose}>
    <section className="pg-detail pg-detail-refined" ref={containerRef} role="dialog" aria-modal="true" aria-label="生成任务详情" tabIndex={-1} onKeyDown={handleModalKeyDown} onClick={e => e.stopPropagation()}>
      <button className="pg-detail-close" aria-label="关闭生成详情" title="关闭" data-modal-initial-focus onClick={onClose}><X size={20}/></button>
      <div className="pg-detail-body">
        <div className="pg-detail-image">
          {canUse ? <>
            <button className="pg-detail-original" onClick={onLightbox} aria-label="查看原图大图"><img src={mediaUrl(job.result_path!)} alt="生成结果"/></button>
            {actualSize && <span className="pg-detail-image-size" title="实际文件尺寸">{actualSize}</span>}
            <a className="pg-detail-download" href={mediaUrl(job.result_path!)} download aria-label="下载原图" title="下载原图"><Download size={18}/></a>
          </> : <div className={`pg-detail-unavailable ${job.status}`}><span>{status}</span><small>{job.status === 'discarded' ? '图片已清理，已从画廊隐藏。历史记录与原始请求仍保留；清理图片不等于删除记录。' : '此任务尚无可查看的图片。'}</small></div>}
        </div>
        <div className="pg-detail-info">
          <div className="pg-detail-scroll">
            <div className="pg-detail-heading"><span>生成详情</span><span className={`pg-detail-status ${job.status}`}>{status}</span></div>
            {agentSource && (onSendToAgent ? <button className="pg-detail-agent-source" aria-label="返回 Agent 会话" onClick={() => onSendToAgent(job, 'conversation')}><MessageSquare size={14}/>来自 Agent · 返回会话</button> : <p className="pg-detail-agent-source">来自 Agent</p>)}
            <section className="pg-detail-section" aria-label="输入内容">
              <div className="pg-detail-section-heading"><h3>输入内容</h3><button className={`pg-detail-copy${copied ? ' is-copied' : ''}`} aria-label={copied ? '已复制提示词' : '复制提示词'} title={copied ? '已复制提示词' : '复制提示词'} onClick={() => void copyPrompt()}>{copied ? <Check size={16}/> : <Copy size={16}/>}<span role="status" aria-live="polite">{copied ? '已复制' : '复制'}</span></button></div>
              <p className="pg-full-prompt">{prompt}</p>
            </section>
            <section className="pg-detail-section" aria-label="参数配置">
              <h3>参数配置</h3>
              <dl className="pg-detail-parameters">
                <div className="pg-detail-source"><dt>来源 · 请求模型</dt><dd>{parameter(job.parameters?.compatible_profile_name || job.provider)}<span>{parameter(requested.model ?? job.model)}</span></dd></div>
                {parameterRows.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{parameter(value)}</dd></div>)}
              </dl>
            </section>
            {job.error && <p className="pg-error" role="alert">{job.error}</p>}
            <GenerationResultSummary job={job} t={t}/>
            {inputs.length > 0 && <section className="pg-detail-section" aria-label="原始参考"><h3>原始参考</h3><div className="pg-input-images">{inputs.map((input, index) => <div key={input.id}>{input.previewUrl ? <img src={input.previewUrl} alt={`原始参考 ${index + 1}`}/> : <span>参考图缺失</span>}<span title={input.name}>{index + 1}. {input.name}</span></div>)}</div></section>}
            <details className="pg-detail-provenance"><summary>请求配方与来源</summary><dl><dt>供应商</dt><dd>{parameter(job.parameters?.compatible_profile_name || job.provider)}</dd><dt>请求模型</dt><dd>{parameter(job.model)}</dd><dt>任务 ID</dt><dd>{job.id}</dd></dl><pre>{JSON.stringify(job.parameters, null, 2)}</pre></details>
            <p className="pg-detail-created">创建于 <time dateTime={job.created_at}>{new Date(job.created_at).toLocaleString()}</time></p>
            {job.accepted_image_id && <p className="pg-detail-saved"><Check size={14}/>已收录到 Library，重复操作不会再次创建资产。</p>}
            {job.status === 'failed' && <p className="pg-note">需要再次生成时请先恢复配方。重新提交可能收费，不会自动重试。</p>}
          </div>
          <div className="pg-detail-bottom">
            {error && <p role="alert" className="pg-error">{error}</p>}
            {saveOpen && !job.accepted_image_id && <div className="pg-save-form">
              <div className="pg-save-heading">收录到 Library</div>
              {attachMode ? <>
                <p className="pg-save-title-help">将这张图添加到一个已有条目中，沿用该条目的名称，不改变其他图片。</p>
                <label>已有条目<select disabled={busy || itemsLoading} value={target} onChange={e => setTarget(e.target.value)}><option value="">请选择条目</option>{items.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
                {itemsLoading ? <span role="status">正在加载已有条目…</span> : items.length < itemTotal && <button disabled={busy} onClick={() => setItemLimit(value => value + 1000)}>加载更多条目（{items.length} / {itemTotal}）</button>}
              </> : <>
                <p className="pg-save-title-help">单独保存为一个新条目，保留原图与原始提示词。</p>
                <label>名称（可选）<input disabled={busy} value={title} onChange={e => setTitle(e.target.value)} placeholder="留空使用默认名称"/></label>
                <label className="pg-save-auto-title">
                  <input type="checkbox" checked={autoTitle && !title.trim()} disabled={busy || Boolean(title.trim())} onChange={e => {
                    setAutoTitle(e.target.checked);
                    try { window.localStorage.setItem(AUTO_TITLE_KEY, String(e.target.checked)); } catch { /* Collection remains available when browser storage is blocked. */ }
                  }}/>
                  <span>使用采集的“看图与文字模型”自动命名</span>
                </label>
                <p className="pg-save-title-help">{title.trim() ? '将保留你填写的名称，不调用命名模型。' : '记住本浏览器的选择；开启后可能产生模型费用。先保存，再后台命名；失败不影响收录。排队较久时可刷新 Library 查看。'}</p>
              </>}
              <button type="button" className="pg-save-mode" disabled={busy} onClick={() => { setAttachMode(!attachMode); setTarget(''); setError(''); }}>{attachMode ? '改为单独收录' : '添加到已有条目…'}</button>
              <button className="pg-detail-save-confirm" disabled={busy || (attachMode && !target)} onClick={() => void accept()}>{busy ? '保存中…' : '确认保存'}</button>
            </div>}
            <div className="pg-detail-actions">
              <button className="pg-detail-reuse" onClick={() => onReuse(job)}><RotateCcw size={16}/>恢复配方</button>
              <button disabled={!canUse} onClick={() => onReuse(job, true)}><ImagePlus size={16}/>继续编辑</button>
              {canUse && onSendToAgent && <button onClick={() => onSendToAgent(job, 'reference')}><MessageSquare size={16}/>带到 Agent 继续</button>}
              {canUse && !job.accepted_image_id && <button className="pg-detail-save" aria-expanded={saveOpen} onClick={() => setSaveOpen(!saveOpen)}>{saveOpen ? '取消收录' : '保存到 Library'}</button>}
              {['queued', 'running'].includes(job.status) && <button disabled={busy} onClick={() => { setBusy(true); void api.cancelGenerationJob(job.id).then(onChange).catch(e => setError(String(e))).finally(() => setBusy(false)); }}><Square size={14}/>停止任务</button>}
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>;
}
