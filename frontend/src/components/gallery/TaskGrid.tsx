// Adapted from Playground TaskGrid: measured virtual rows and rectangle selection.
import { useRef, useState, type RefObject } from 'react';
import { Check, Copy, Download, RotateCcw, ImagePlus } from 'lucide-react';
import type { GenerationJobRecord } from '../../types';
import { mediaUrl } from '../../api/client';
import { getIndexesInRect } from '../../utils/playground/virtualGrid';
import { useVirtualGrid } from '../../utils/playground/useVirtualGrid';
import { galleryJobPrompt, galleryStatus } from '../../utils/galleryRecipe';
import { copyTextToClipboard } from '../../utils/clipboard';

interface Props {jobs:GenerationJobRecord[];selected:Set<string>;onSelection:(ids:Set<string>)=>void;onOpen:(job:GenerationJobRecord)=>void;onReuse:(job:GenerationJobRecord,edit?:boolean)=>void;onMessage:(message:string)=>void;scrollRef?:RefObject<HTMLElement|null>}
export default function TaskGrid({jobs,selected,onSelection,onOpen,onReuse,onMessage,scrollRef}:Props) {
  const gridRef=useRef<HTMLDivElement>(null),start=useRef<{x:number;y:number;initial:Set<string>}|null>(null);
  const [box,setBox]=useState<{left:number;top:number;width:number;height:number}>();
  const {startIndex,endIndex,paddingTop,paddingBottom,metricsRef}=useVirtualGrid(gridRef,jobs.length,scrollRef);
  return <div className="pg-task-grid" ref={gridRef} style={{paddingTop,paddingBottom}} onPointerDown={event=>{
    if(event.button!==0||(event.target as Element).closest('button,a,input'))return;
    const rect=event.currentTarget.getBoundingClientRect();start.current={x:event.clientX-rect.left,y:event.clientY-rect.top,initial:new Set(event.ctrlKey||event.metaKey?selected:[])};event.currentTarget.setPointerCapture(event.pointerId);
  }} onPointerMove={event=>{if(!start.current)return;const rect=event.currentTarget.getBoundingClientRect(),point={x:event.clientX-rect.left,y:event.clientY-rect.top},origin=start.current;if(Math.hypot(point.x-origin.x,point.y-origin.y)<6)return;const left=Math.min(point.x,origin.x),top=Math.min(point.y,origin.y),right=Math.max(point.x,origin.x),bottom=Math.max(point.y,origin.y);setBox({left,top,width:right-left,height:bottom-top});const next=new Set(origin.initial);getIndexesInRect(jobs.length,metricsRef.current,{left,top,right,bottom}).forEach(index=>next.add(jobs[index].id));onSelection(next);}} onPointerUp={()=>{start.current=null;setBox(undefined);}} onPointerCancel={()=>{start.current=null;setBox(undefined);}}>
    {jobs.slice(startIndex,endIndex).map(job=><article key={job.id} className={`pg-task-card ${selected.has(job.id)?'selected':''}`}>
      <button className="pg-select-card" aria-label={`选择任务 ${job.id}`} aria-pressed={selected.has(job.id)} onClick={()=>{const next=new Set(selected);if(next.has(job.id))next.delete(job.id);else next.add(job.id);onSelection(next);}}>{selected.has(job.id)?<Check size={14}/>:null}</button>
      <button className="pg-card-image" onClick={()=>onOpen(job)}>{job.result_path&&['succeeded','accepted'].includes(job.status)?<img src={mediaUrl(job.result_path)} alt={galleryJobPrompt(job)} loading="lazy"/>:<span className={`pg-job-state ${job.status}`}>{galleryStatus[job.status]||job.status}</span>}</button>
      <div className="pg-card-copy"><p title={galleryJobPrompt(job)}>{galleryJobPrompt(job)}</p><div><span>{galleryStatus[job.status]||job.status}</span><span>{job.result_width&&job.result_height?`${job.result_width} × ${job.result_height}`:'尺寸未返回'}</span></div><small title={job.model||''}>{job.model||'模型未报告'}</small></div>
      <footer><button title="恢复完整配方" aria-label="恢复完整配方" onClick={()=>onReuse(job)}><RotateCcw size={16}/></button><button title="使用结果继续编辑" aria-label="使用结果继续编辑" disabled={!job.result_path||!['succeeded','accepted'].includes(job.status)} onClick={()=>onReuse(job,true)}><ImagePlus size={16}/></button><button title="复制提示词" aria-label="复制提示词" onClick={()=>{void copyTextToClipboard(galleryJobPrompt(job)).then(copied=>onMessage(copied?'已复制提示词':'复制失败，请打开详情手动复制')).catch(()=>onMessage('复制失败，请打开详情手动复制'));}}><Copy size={16}/></button>{job.result_path&&<a href={mediaUrl(job.result_path)} download title="下载原图" aria-label="下载原图"><Download size={16}/></a>}<time>{new Date(job.created_at).toLocaleString()}</time></footer>
    </article>)}
    {box&&<div className="pg-selection-box" style={box}/>}
  </div>;
}
