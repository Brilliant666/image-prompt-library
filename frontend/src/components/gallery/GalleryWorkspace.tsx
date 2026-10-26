import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Search, Trash2, RefreshCw, X } from 'lucide-react';
import { zipSync } from 'fflate';
import { api, mediaUrl } from '../../api/client';
import type { GenerationJobRecord } from '../../types';
import type { Translator } from '../../utils/i18n';
import type { LocalPreferences } from '../../utils/localPreferences';
import { galleryMatches } from '../../utils/galleryRecipe';
import { agentJobSource, type GalleryImageSettings, type GalleryImageSettingsCommand } from '../../utils/agentGalleryBridge';
import { readGalleryFilter, saveGalleryFilter, galleryFilterStatuses, readGalleryHistory, saveGalleryHistory, clearGalleryHistory } from '../../utils/galleryHistory';
import InputBar, { type GalleryCommand } from './InputBar';
import TaskGrid from './TaskGrid';
import DetailModal from './DetailModal';
import Lightbox from './Lightbox';
import { clearGenerationQueueHistory } from '../../utils/generationQueueHistory';
import GenerationQueueDrawer, { groupGenerationQueueJobs } from '../GenerationQueueDrawer';
import { mapGenerationRetryJob } from '../../utils/generationSiblings';
import ToolbarSelect from '../ToolbarSelect';
import './GalleryWorkspace.css';

interface Props {active:boolean;queueOpen:boolean;onQueueOpenChange:(open:boolean)=>void;t:Translator;preferences:LocalPreferences;libraryScope?:string;command?:GalleryCommand;imageSettingsCommand?:GalleryImageSettingsCommand;focusJobId?:string;refreshKey:number;configurationRevision:number;promptVariablesEnabled?:boolean;promptLanguage?:string;preferredProvider?:string;onOpenAgent?:(id:string)=>void;onImageSettingsChange?:(settings:GalleryImageSettings)=>void;onSendToAgent?:(job:GenerationJobRecord,intent:'reference'|'conversation')=>void;onOpenSettings:()=>void;onAccepted:(id:string,autoTitle?:boolean)=>void;onQueueChanged:()=>void;onCloseDetail?:()=>void}
export default function GalleryWorkspace({active,queueOpen,onQueueOpenChange,t,preferences,libraryScope,command,imageSettingsCommand,focusJobId,refreshKey,configurationRevision,promptVariablesEnabled,promptLanguage,preferredProvider,onOpenAgent,onImageSettingsChange,onSendToAgent,onOpenSettings,onAccepted,onQueueChanged,onCloseDetail}:Props) {
  const [jobs,setJobs]=useState<GenerationJobRecord[]>([]),[total,setTotal]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[message,setMessage]=useState('');
  const [query,setQuery]=useState(''),[status,setStatus]=useState(readGalleryFilter),[selected,setSelected]=useState<Set<string>>(new Set()),[detail,setDetail]=useState<GenerationJobRecord>(),[lightbox,setLightbox]=useState<string>(),[localCommand,setLocalCommand]=useState<GalleryCommand>(),[busy,setBusy]=useState(false);
  const [refreshing,setRefreshing]=useState(false),[fromCache,setFromCache]=useState(false);
  const pageLimit=useRef(48),readLock=useRef<string|undefined>(undefined),readSequence=useRef(0),previous=useRef(new Map<string,string>()),completionCount=useRef<number|undefined>(undefined),alive=useRef(true),detailSequence=useRef(0);
  const resultsRef=useRef<HTMLDivElement>(null);
  const [batchOpenVersion,setBatchOpenVersion]=useState(0),[mutationRevision,setMutationRevision]=useState(0);
  const displayedScope=useRef<{value:string|undefined}|undefined>(undefined),forceFresh=useRef(false);
  // Keep each visited filter's authoritative page in memory. The persisted snapshot is
  // intentionally just one small, display-only page and cannot serve a round trip to All.
  const filterPages=useRef(new Map<string,{jobs:GenerationJobRecord[];total:number;limit:number}>());
  const lastRefreshKey=useRef(refreshKey);
  const invalidateHistory=()=>{filterPages.current.clear();clearGalleryHistory();clearGenerationQueueHistory();readSequence.current++;readLock.current=undefined;forceFresh.current=true;};
  const [batch,setBatch]=useState<{id:string;jobs:GenerationJobRecord[];total:number}>();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(lastRefreshKey.current!==refreshKey){lastRefreshKey.current=refreshKey;invalidateHistory();}
  },[refreshKey]);
  useEffect(()=>{
    readSequence.current++;readLock.current=undefined;
    const scopeChanged=displayedScope.current?.value!==libraryScope;
    const firstRead=!displayedScope.current;
    if(scopeChanged)filterPages.current.clear();
    displayedScope.current={value:libraryScope};
    const cached=filterPages.current.get(status)||(libraryScope?readGalleryHistory(libraryScope,status):undefined);
    pageLimit.current=cached&&'limit' in cached?cached.limit:Math.max(48,cached?.jobs.length||0);
    if(cached)filterPages.current.set(status,{jobs:cached.jobs,total:cached.total,limit:pageLimit.current});
    if(firstRead||scopeChanged){
      forceFresh.current=scopeChanged;
      setJobs(cached?.jobs||[]);setTotal(cached?.total||0);setLoading(!cached);setFromCache(Boolean(cached));
      if(scopeChanged){setBatch(undefined);setDetail(undefined);setLightbox(undefined);detailSequence.current++;}
      previous.current=new Map();completionCount.current=undefined;
    }else{
      forceFresh.current=true;
      // Filter the cards already on screen immediately; refresh the authoritative page in the background.
      if(cached){setJobs(cached.jobs);setTotal(cached.total);setFromCache(true);}
      else{setTotal(0);setFromCache(true);}
      setLoading(false);
    }
    setSelected(new Set());setLoadError('');
  },[libraryScope,status]);
  const refresh=useCallback(async(fresh=false)=>{
    const key=JSON.stringify([libraryScope,status,batch?.id]);if(readLock.current===key)return;
    readLock.current=key;const sequence=++readSequence.current;fresh=fresh||forceFresh.current;forceFresh.current=false;setRefreshing(true);
    const current=()=>alive.current&&sequence===readSequence.current;
    try{const params={statuses:galleryFilterStatuses(status),prepare_references:false};
    const firstPage=await api.generationJobs({...params,limit:Math.min(1000,pageLimit.current)},{fresh});const result={...firstPage,jobs:[...firstPage.jobs]};for(let offset=result.jobs.length;offset<Math.min(result.total,pageLimit.current);){if(!current())return;const page=await api.generationJobs({...params,limit:Math.min(1000,pageLimit.current-offset),offset},{fresh});if(!page.jobs.length)break;result.jobs.push(...page.jobs);offset+=page.jobs.length;}if(!current())return;
    const completed=result.status_counts?result.status_counts.succeeded+result.status_counts.accepted+result.status_counts.failed:undefined;
    if(preferences.notifyOnCompletion&&(result.jobs.some(job=>previous.current.get(job.id)==='running'&&['succeeded','failed'].includes(job.status))||(completed!==undefined&&completionCount.current!==undefined&&completed>completionCount.current)))setMessage('生成任务已有新结果');
    completionCount.current=completed;
    result.jobs=result.jobs.filter(job=>job.status!=='discarded');
    previous.current=new Map(result.jobs.map(job=>[job.id,job.status]));setJobs(result.jobs);setTotal(result.total);setFromCache(false);setLoading(false);setDetail(current=>{const updated=result.jobs.find(job=>job.id===current?.id);return current&&updated?{...updated,parameters:current.parameters}:current;});setLoadError('');
    filterPages.current.set(status,{jobs:result.jobs,total:result.total,limit:pageLimit.current});
    if(libraryScope)saveGalleryHistory(libraryScope,status,result);
    if(batch?.id){const expanded=await api.generationSet(batch.id,{fresh});if(!current())return;const mapped=expanded.jobs.map(mapGenerationRetryJob);const group=groupGenerationQueueJobs(mapped).find(candidate=>candidate.generationGroupId===batch.id);const updated=(group?.jobs||mapped).filter(job=>job.status!=='discarded');setBatch(current=>current?.id===batch.id?{id:batch.id,jobs:updated,total:expanded.total}:current);setDetail(current=>{const fresh=updated.find(job=>job.id===current?.id);return current&&fresh?{...fresh,parameters:current.parameters}:current;});}
  }catch(e){if(current())setLoadError(String(e));}finally{if(current()){readLock.current=undefined;setLoading(false);setRefreshing(false);}}},[preferences.notifyOnCompletion,batch?.id,status,libraryScope]);
  const refreshAfterChange=()=>{invalidateHistory();return refresh(true);};
  useEffect(()=>{if(!active)return;void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},4000);return()=>clearInterval(timer);},[active,refresh,refreshKey,mutationRevision]);
  useEffect(()=>{if(!focusJobId)return;const sequence=++detailSequence.current;void api.generationJob(focusJobId).then(job=>alive.current&&sequence===detailSequence.current&&setDetail(job)).catch(e=>alive.current&&sequence===detailSequence.current&&setError(String(e)));return()=>{detailSequence.current++;};},[focusJobId]);
  useEffect(()=>{if(command)setLocalCommand(command);},[command?.id]);
  useEffect(()=>{if(!message)return;const timer=setTimeout(()=>setMessage(''),3500);return()=>clearTimeout(timer);},[message]);
  useEffect(()=>{if(batchOpenVersion){resultsRef.current?.scrollTo({top:0});resultsRef.current?.focus({preventScroll:true});}},[batchOpenVersion]);
  const visibleJobs=(batch?.jobs||jobs).filter(job=>job.status!=='discarded');
  const selectedJobs=visibleJobs.filter(job=>selected.has(job.id));
  const cleanupJobs=selectedJobs.filter(job=>job.status==='succeeded'&&!job.accepted_image_id&&job.result_path);
  const downloadJobs=selectedJobs.filter(job=>job.result_path&&['succeeded','accepted'].includes(job.status));
  const cleanupHint=cleanupJobs.length?'清理图片后从画廊隐藏，历史保留任务记录。':'没有可清理的未收录图片。';
  const filtered=useMemo(()=>visibleJobs.filter(job=>galleryMatches(job,query,status)),[visibleJobs,query,status]);
  const resultJobs=filtered.filter(job=>job.result_path&&['succeeded','accepted'].includes(job.status));
  if(detail?.result_path&&['succeeded','accepted'].includes(detail.status)&&!resultJobs.some(job=>job.id===detail.id))resultJobs.push(detail);
  const largeIndex=resultJobs.findIndex(job=>job.id===lightbox),largeJob=resultJobs[largeIndex];
  const closeDetail=()=>{detailSequence.current++;setDetail(undefined);setLightbox(undefined);onCloseDetail?.();};
  const sendToAgent=onSendToAgent?((job:GenerationJobRecord,intent:'reference'|'conversation')=>{closeDetail();onSendToAgent(job,intent);}):undefined;
  const openJob=async(job:GenerationJobRecord)=>{const sequence=++detailSequence.current;try{const fresh=await api.generationJob(job.id);if(alive.current&&sequence===detailSequence.current)setDetail(fresh);}catch(e){if(alive.current&&sequence===detailSequence.current)setError(String(e));}};
  const reuse=async(job:GenerationJobRecord,editResult=false)=>{const sequence=++detailSequence.current;try{
    const fresh=await api.generationJob(job.id);if(!alive.current||sequence!==detailSequence.current)return;
    if(['agent_native','agent_native_batch'].includes(fresh.provider)){if(sendToAgent){sendToAgent(fresh,editResult?'reference':'conversation');return;}const agent=agentJobSource(fresh);if(agent&&onOpenAgent){closeDetail();onOpenAgent(agent.conversationId);return;}setError('此原生 Responses 结果的 Agent 会话已不可用，请从 Agent 开始新会话并主动选择该图。');return;}
    setLocalCommand({id:Date.now(),job:fresh,editResult});closeDetail();
  }catch(e){if(alive.current&&sequence===detailSequence.current)setError(String(e));}};
  async function downloadSelected(){if(busy)return;setBusy(true);setError('');try{const files:Record<string,Uint8Array>={};let bytes=0;for(const job of visibleJobs.filter(job=>selected.has(job.id)&&job.result_path&&['succeeded','accepted'].includes(job.status))){const result=await fetch(mediaUrl(job.result_path!));if(!result.ok)throw new Error(`无法下载 ${job.id}`);const data=new Uint8Array(await result.arrayBuffer());bytes+=data.byteLength;if(bytes>300*1024*1024)throw new Error('本次下载超过 300 MB，请减少选择后重试');files[`${job.id}.${job.result_path!.split('.').pop()}`]=data;}if(!Object.keys(files).length)throw new Error('没有可下载的结果');const archive=zipSync(files,{level:0});const url=URL.createObjectURL(new Blob([archive as BlobPart],{type:'application/zip'}));const link=document.createElement('a');link.href=url;link.download='generation-results.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function cleanup(){if(busy||!cleanupJobs.length)return;if(!window.confirm(`清理 ${cleanupJobs.length} 项未收录的结果图片？图片将从画廊隐藏，任务记录和原始请求仍保留在历史中；这不会删除记录。已收录的 Library 资产不会清理。${selected.size>cleanupJobs.length?`\n其余 ${selected.size-cleanupJobs.length} 项不适用，将跳过。`:''}\n被其他任务或 Agent 引用的结果会受到保护。`))return;setBusy(true);setError('');invalidateHistory();const failures:string[]=[];for(const job of cleanupJobs){try{await api.discardGenerationJob(job.id);setJobs(current=>current.filter(row=>row.id!==job.id));if(jobs.some(row=>row.id===job.id))setTotal(current=>Math.max(0,current-1));setBatch(current=>current?{...current,jobs:current.jobs.filter(row=>row.id!==job.id)}:current);setDetail(current=>current?.id===job.id?undefined:current);}catch(e){failures.push(String(e));}}setSelected(new Set());await refreshAfterChange();setBusy(false);if(failures.length)setError(failures.join('\n'));onQueueChanged();}
  return <section className="pg-gallery" hidden={!active} aria-label="画廊工作区">
    <header className="pg-gallery-header"><div className={`pg-gallery-filters ${selected.size?'is-inactive':''}`} inert={selected.size>0} aria-hidden={selected.size>0||undefined}><ToolbarSelect className="pg-status-filter" label="任务状态筛选" value={status} disabled={!active||selected.size>0} onChange={value=>{setStatus(value);saveGalleryFilter(value);setSelected(new Set());}} options={[{value:'',label:'全部状态'},{value:'active',label:'进行中'},{value:'successful',label:'成功'},{value:'accepted',label:'已收录'},{value:'failed',label:'失败'}]}/><label><Search size={17}/><input aria-label="搜索生成历史" placeholder="搜索提示词、模型或任务…" value={query} onChange={e=>setQuery(e.target.value)}/></label><button aria-label="刷新生成历史" title={fromCache?'上次列表 · 正在后台更新':refreshing?'正在更新生成历史':'刷新生成历史'} aria-busy={refreshing} onClick={()=>void refresh()}><RefreshCw size={17} className={refreshing?'pg-history-refreshing':undefined}/></button>
      {active&&<GenerationQueueDrawer t={t} libraryScope={libraryScope} placement="gallery" open={queueOpen} refreshKey={refreshKey} onChanged={(updated?:GenerationJobRecord)=>{invalidateHistory();if(updated?.status==='discarded'){setJobs(current=>current.filter(job=>job.id!==updated.id));if(jobs.some(job=>job.id===updated.id))setTotal(current=>Math.max(0,current-1));setBatch(current=>current?{...current,jobs:current.jobs.filter(job=>job.id!==updated.id)}:current);setDetail(current=>current?.id===updated.id?updated:current);setLightbox(current=>current===updated.id?undefined:current);setSelected(current=>{const next=new Set(current);next.delete(updated.id);return next;});}setMutationRevision(value=>value+1);}} onOpen={()=>onQueueOpenChange(true)} onClose={()=>{onQueueOpenChange(false);void refresh();}} onOpenJob={job=>{onQueueOpenChange(false);void openJob(job);}} onOpenBatch={(batchJobs,batchTotal,groupId)=>{onQueueOpenChange(false);closeDetail();setBatch({id:groupId,jobs:batchJobs.filter(job=>job.status!=='discarded'),total:batchTotal});setBatchOpenVersion(value=>value+1);setSelected(new Set());setQuery('');setStatus('');resultsRef.current?.scrollTo({top:0});}} onOpenProviders={()=>{onQueueOpenChange(false);onOpenSettings();}}/>}
    </div>
    <div className={`pg-selection-toolbar ${selected.size?'is-active':''}`} role="group" aria-label="批量操作" aria-hidden={!selected.size||undefined} inert={!selected.size}>
      <span className="pg-selection-count" role="status" aria-live="polite">已选择 <b>{selected.size}</b> 项</span><button className="pg-select-all" onClick={()=>setSelected(new Set(filtered.map(job=>job.id)))}>全选当前列表</button><button className="pg-selection-cancel" onClick={()=>{setSelected(new Set());resultsRef.current?.focus({preventScroll:true});}}>取消选择</button>
      <span className="pg-selection-note" title={cleanupHint}>{cleanupHint}</span>
      <div className="pg-bulk-actions"><button disabled={busy||!downloadJobs.length} onClick={()=>void downloadSelected()}><Download size={16}/>打包原图</button><button disabled={busy||!cleanupJobs.length} title={cleanupHint} className="pg-cleanup-action" onClick={()=>void cleanup()}><Trash2 size={16}/>清理图片</button></div>
    </div></header>
    <div className="pg-gallery-results" ref={resultsRef} tabIndex={0} role="region" aria-label="画廊结果列表">
    {batch&&<div className="pg-batch-scope"><span>生成批次 · 显示 {batch.jobs.length} 项 / 原批次 {batch.total} 项</span><button onClick={()=>{setBatch(undefined);setStatus(readGalleryFilter());setSelected(new Set());}}>返回全部历史</button></div>}
    {loading?<div className="pg-empty">加载生成历史…</div>:filtered.length?<TaskGrid active={active} scrollRef={resultsRef} jobs={filtered} selected={selected} onSelection={setSelected} onOpen={job=>void openJob(job)} onReuse={reuse} onMessage={setError} onSendToAgent={sendToAgent}/>:<div className="pg-empty"><h2>{batch?'此批次暂无可显示的图片或任务':refreshing&&fromCache?'正在更新生成历史':jobs.length?'没有匹配的任务':'从一个想法开始'}</h2><p>{batch?'已清理图片的任务仍可在历史中查看。':refreshing&&fromCache?'正在获取该状态的最新任务。':jobs.length?'试试其他关键词或状态。':'输入提示词，或从 Library 带入配方。快捷收录无需配置生成接口。'}</p></div>}
    {!batch&&jobs.length<total&&<button className="pg-load-more" disabled={refreshing} onClick={()=>{pageLimit.current+=48;void refresh();}}>已加载 {jobs.length} / {total} · 加载更多</button>}
    </div>
    {(error||loadError||message)&&<div className={`pg-gallery-feedback ${error||loadError?'is-error':''}`} role={error||loadError?'alert':'status'}><span>{error||(loadError?`${fromCache?'当前显示上次列表，历史更新失败：':''}${loadError}`:message)}</span><button aria-label="关闭画廊提示" onClick={()=>{setError('');setLoadError('');setMessage('');}}><X size={15}/></button></div>}
    <InputBar active={active} command={localCommand} imageSettingsCommand={imageSettingsCommand} preferences={preferences} t={t} onCreated={(created?:GenerationJobRecord[])=>{
      invalidateHistory();
      if(created?.length){
        const ids=new Set(created.map(job=>job.id));
        setJobs(current=>[...created,...current.filter(job=>!ids.has(job.id))]);
        setTotal(current=>current+created.filter(job=>!jobs.some(existing=>existing.id===job.id)).length);
        setLoading(false);setFromCache(false);setStatus('');saveGalleryFilter('');setQuery('');
      }
      setBatch(undefined);setSelected(new Set());setMessage('');resultsRef.current?.scrollTo({top:0});setMutationRevision(value=>value+1);onQueueChanged();
    }} onOpenSettings={onOpenSettings} configurationRevision={configurationRevision} promptVariablesEnabled={promptVariablesEnabled} promptLanguage={promptLanguage} preferredProvider={preferredProvider} onOpenAgent={onOpenAgent} onImageSettingsChange={onImageSettingsChange} onSendToAgent={sendToAgent}/>
    {detail&&active&&!largeJob&&<DetailModal key={detail.id} job={detail} t={t} onClose={closeDetail} onChange={()=>void refreshAfterChange()} onAccepted={(id,autoTitle)=>{invalidateHistory();closeDetail();onAccepted(id,autoTitle);}} onReuse={reuse} onSendToAgent={sendToAgent} onLightbox={()=>setLightbox(detail.id)}/ >}
    {largeJob&&active&&<Lightbox src={mediaUrl(largeJob.result_path!)} currentIndex={largeIndex} total={resultJobs.length} onClose={()=>setLightbox(undefined)} onPrev={()=>setLightbox(resultJobs[(largeIndex-1+resultJobs.length)%resultJobs.length].id)} onNext={()=>setLightbox(resultJobs[(largeIndex+1)%resultJobs.length].id)}/>}
  </section>;
}
