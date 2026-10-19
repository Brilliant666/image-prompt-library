import { useEffect, useState } from 'react';
import { api, mediaUrl } from '../../api/client';
import type { GenerationJobRecord, ItemSummary } from '../../types';
import type { Translator } from '../../utils/i18n';
import { galleryJobPrompt, galleryStatus } from '../../utils/galleryRecipe';
import { recipeInputs } from '../../utils/recipeInputs';
import { copyTextToClipboard } from '../../utils/clipboard';
import { useModalFocus } from '../../hooks/useModalFocus';
import { GenerationResultSummary } from '../GenerationResultSummary';

interface Props {job:GenerationJobRecord;t:Translator;onClose:()=>void;onChange:()=>void;onAccepted:(itemId:string)=>void;onReuse:(job:GenerationJobRecord,edit?:boolean)=>void;onLightbox:()=>void}
export default function DetailModal({job,t,onClose,onChange,onAccepted,onReuse,onLightbox}:Props) {
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[title,setTitle]=useState(''),[target,setTarget]=useState(''),[items,setItems]=useState<ItemSummary[]>([]),[saveOpen,setSaveOpen]=useState(false),[itemLimit,setItemLimit]=useState(1000),[itemTotal,setItemTotal]=useState(0),[itemsLoading,setItemsLoading]=useState(false);
  const {containerRef,handleModalKeyDown}=useModalFocus<HTMLDivElement>(onClose,{fallbackFocusSelector:'.pg-gallery:not([hidden]) .gallery-history-trigger'});
  useEffect(()=>{if(!saveOpen)return;let cancelled=false;setItemsLoading(true);void (async()=>{const rows:ItemSummary[]=[];let total=0;for(let offset=0;offset<itemLimit;offset+=1000){const list=await api.items({limit:1000,offset});if(cancelled)return;rows.push(...list.items);total=list.total;if(rows.length>=total||list.items.length===0)break;}setItems(rows);setItemTotal(total);})().catch(e=>{if(!cancelled)setError(String(e));}).finally(()=>{if(!cancelled)setItemsLoading(false);});return()=>{cancelled=true;};},[saveOpen,itemLimit]);
  const canUse=Boolean(job.result_path&&['succeeded','accepted'].includes(job.status));
  async function accept(){if(busy)return;setBusy(true);setError('');try{const result=target?await api.acceptGenerationJobIntoItem(job.id,target):await api.acceptGenerationJobAsNewItem(job.id,title.trim()?{title:title.trim()}:{});onChange();onAccepted(result.item.id);}catch(e){setError(String(e));}finally{setBusy(false);}}
  return <div className="pg-overlay" onClick={onClose}><section className="pg-detail" ref={containerRef} role="dialog" aria-modal="true" aria-label="生成任务详情" tabIndex={-1} onKeyDown={handleModalKeyDown} onClick={e=>e.stopPropagation()}>
    <header><h2>生成详情 <small>{galleryStatus[job.status]||job.status}</small></h2><button onClick={onClose}>关闭</button></header>
    <div className="pg-detail-body"><div className="pg-detail-image">{canUse?<button onClick={onLightbox} aria-label="查看原图大图"><img src={mediaUrl(job.result_path!)} alt="生成结果"/></button>:<p>{galleryStatus[job.status]||job.status}</p>}</div><div className="pg-detail-info"><p className="pg-full-prompt">{galleryJobPrompt(job)}</p><div className="pg-detail-actions"><button onClick={()=>void copyTextToClipboard(galleryJobPrompt(job)).then(ok=>{if(!ok)setError('无法复制，请选择原文复制');}).catch(()=>setError('无法复制，请选择原文复制'))}>复制提示词</button><button onClick={()=>onReuse(job)}>恢复配方</button><button disabled={!canUse} onClick={()=>onReuse(job,true)}>继续编辑</button>{canUse&&<a href={mediaUrl(job.result_path!)} download>下载原图</a>}</div>
      {job.error&&<p className="pg-error" role="alert">{job.error}</p>}
      <GenerationResultSummary job={job} t={t}/>
      <details><summary>请求配方与来源</summary><dl><dt>供应商</dt><dd>{String(job.parameters?.compatible_profile_name||job.provider)}</dd><dt>请求模型</dt><dd>{job.model||'未记录'}</dd><dt>任务 ID</dt><dd>{job.id}</dd></dl><pre>{JSON.stringify(job.parameters,null,2)}</pre></details>
      {recipeInputs(job,mediaUrl).length>0&&<div className="pg-input-images">{recipeInputs(job,mediaUrl).map((input,index)=><div key={input.id}>{input.previewUrl?<img src={input.previewUrl} alt={`原始参考 ${index+1}`}/>:<span>参考图缺失</span>}<span>{index+1}. {input.name}</span></div>)}</div>}
      {job.accepted_image_id?<p className="pg-success">已收录到 Library，重复操作不会再次创建资产。</p>:canUse&&<button className="primary" onClick={()=>setSaveOpen(!saveOpen)}>保存到 Library</button>}
      {saveOpen&&!job.accepted_image_id&&<div className="pg-save-form"><label>保存位置<select value={target} onChange={e=>setTarget(e.target.value)}><option value="">新建参考</option>{items.map(item=><option key={item.id} value={item.id}>附加到：{item.title}</option>)}</select></label>{itemsLoading?<span>正在加载保存位置…</span>:items.length<itemTotal&&<button onClick={()=>setItemLimit(value=>value+1000)}>加载更多参考（{items.length} / {itemTotal}）</button>}{!target&&<label>名称（可选）<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="留空自动命名"/></label>}<button disabled={busy} onClick={()=>void accept()}>{busy?'保存中…':'确认保存'}</button></div>}
      {['queued','running'].includes(job.status)&&<button disabled={busy} onClick={()=>{setBusy(true);void api.cancelGenerationJob(job.id).then(onChange).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>停止任务</button>}
      {job.status==='failed'&&<p className="pg-note">需要再次生成时请先恢复配方。重新提交可能收费，不会自动重试。</p>}
      {error&&<p role="alert" className="pg-error">{error}</p>}
    </div></div>
  </section></div>;
}
