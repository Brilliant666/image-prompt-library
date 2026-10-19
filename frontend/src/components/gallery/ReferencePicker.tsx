import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl } from '../../api/client';
import type { ItemDetail, ItemSummary, GenerationJobRecord } from '../../types';
import type { RecipeInput } from '../../utils/recipeInputs';
import { useModalFocus } from '../../hooks/useModalFocus';

export default function ReferencePicker({onSelect,onClose}:{onSelect:(input:RecipeInput)=>void;onClose:()=>void}) {
  const [tab,setTab]=useState<'library'|'gallery'>('library');
  const [items,setItems]=useState<ItemSummary[]>([]),[jobs,setJobs]=useState<GenerationJobRecord[]>([]),[detail,setDetail]=useState<ItemDetail>();
  const [query,setQuery]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[itemTotal,setItemTotal]=useState(0),[jobTotal,setJobTotal]=useState(0);
  const alive=useRef(true),detailSequence=useRef(0),paging=useRef(false);
  const [loadingMore,setLoadingMore]=useState(false);
  const close=()=>{alive.current=false;detailSequence.current++;onClose();};
  const {containerRef,handleModalKeyDown}=useModalFocus<HTMLDivElement>(close,{fallbackFocusSelector:'.pg-gallery:not([hidden]) .pg-add-image'});
  useEffect(()=>{alive.current=true;setLoading(true);setError('');Promise.all([api.items({limit:1000}),api.generationJobs({limit:1000})]).then(([list,history])=>{if(alive.current){setItems(list.items);setJobs(history.jobs);setItemTotal(list.total);setJobTotal(history.total);}}).catch(e=>alive.current&&setError(String(e))).finally(()=>alive.current&&setLoading(false));return()=>{alive.current=false;detailSequence.current++;};},[]);
  const changeTab=(next:'library'|'gallery')=>{detailSequence.current++;setTab(next);setDetail(undefined);setError('');};
  const openDetail=async(id:string)=>{const sequence=++detailSequence.current;setError('');try{const value=await api.item(id);if(alive.current&&sequence===detailSequence.current)setDetail(value);}catch(e){if(alive.current&&sequence===detailSequence.current)setError(String(e));}};
  async function loadMore(){if(paging.current)return;paging.current=true;setLoadingMore(true);try{if(tab==='library'){const list=await api.items({limit:1000,offset:items.length});if(alive.current){setItems(current=>[...current,...list.items]);setItemTotal(list.total);}}else{const list=await api.generationJobs({limit:1000,offset:jobs.length});if(alive.current){setJobs(current=>[...current,...list.jobs]);setJobTotal(list.total);}}}catch(e){if(alive.current)setError(String(e));}finally{paging.current=false;if(alive.current)setLoadingMore(false);}}
  const pick=(input:RecipeInput)=>{onSelect(input);close();};
  return <div className="pg-overlay" onClick={close}><div className="pg-picker" ref={containerRef} onKeyDown={handleModalKeyDown} onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label="选择参考图" tabIndex={-1}>
    <header><h2>选择参考图</h2><button onClick={close}>关闭</button></header>
    <nav><button aria-pressed={tab==='library'} onClick={()=>changeTab('library')}>Library</button><button aria-pressed={tab==='gallery'} onClick={()=>changeTab('gallery')}>画廊</button><input aria-label="搜索参考图" placeholder="搜索" value={query} onChange={e=>setQuery(e.target.value)}/></nav>
    {loading&&<p>加载中…</p>}{error&&<p role="alert">{error}</p>}
    {detail&&tab==='library'?<><button onClick={()=>changeTab('library')}>返回参考列表</button><div className="pg-picker-grid">{detail.images.map(image=><button key={image.id} onClick={()=>pick({id:`library-${image.id}`,name:detail.title,source:'library',imageId:image.id,sourceItemId:detail.id,previewUrl:mediaUrl(image.preview_path||image.original_path),role:image.role})}><img src={mediaUrl(image.preview_path||image.original_path)} alt={detail.title}/><span>{image.role==='reference_image'?'参考图':'结果图'}</span></button>)}</div></>:<div className="pg-picker-grid">{tab==='library'?items.filter(item=>[item.title,item.prompt_snippet].join(' ').toLowerCase().includes(query.toLowerCase())).map(item=><button key={item.id} onClick={()=>void openDetail(item.id)}>{item.first_image&&<img loading="lazy" src={mediaUrl(item.first_image.thumb_path||item.first_image.original_path)} alt=""/>}<span>{item.title}</span></button>):jobs.filter(job=>job.result_path&&['succeeded','accepted'].includes(job.status)&&job.prompt_text.toLowerCase().includes(query.toLowerCase())).map(job=><button key={job.id} onClick={()=>pick({id:`result-${job.id}`,name:job.id,source:'generated_result',resultPath:job.result_path!,previewUrl:mediaUrl(job.result_path!)})}><img loading="lazy" src={mediaUrl(job.result_path!)} alt=""/><span>{job.prompt_text}</span></button>)}</div>}
    {!detail&&((tab==='library'&&items.length<itemTotal)||(tab==='gallery'&&jobs.length<jobTotal))&&<button disabled={loadingMore} onClick={()=>void loadMore()}>加载更多参考（搜索已加载结果）</button>}
  </div></div>;
}
