// Playground InputBar layout adapted to the existing backend queue and recipe contract.
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Plus, ImagePlus, Settings2, X, Layers, ChevronDown, LoaderCircle } from 'lucide-react';
import { api, mediaUrl } from '../../api/client';
import type { GenerationJobRecord, GenerationProviderStatus, GenerationSetCount, ItemDetail, OpenAICompatibleProfile } from '../../types';
import type { Translator } from '../../utils/i18n';
import type { LocalPreferences } from '../../utils/localPreferences';
import { resolveAuto4k, COMPATIBLE_ENTERPRISE_MODELS, IMAGE25_MODELS, IMAGE25_QUALITIES } from '../../utils/compatibleRecipe';
import { readGenerationPreference, writeGenerationPreference, lastGenerationProfile } from '../../utils/generationPreferences';
import { profileModelChoices } from '../../utils/profileSettings';
import { recipeInputs, restoreRecipeInputs, type RecipeInput } from '../../utils/recipeInputs';
import { draftFromJob, emptyGalleryDraft, galleryPayload, libraryRecipeImage, type GalleryDraft } from '../../utils/galleryRecipe';
import { readGalleryDraft, saveGalleryDraft } from '../../utils/galleryDraft';
import ReferencePicker from './ReferencePicker';
import SizeDialog from './SizeDialog';
import { extractPromptTemplateVariableRecords, resolvePromptTemplate } from '../../utils/promptTemplateVariables';
import './InputBar.css';

export interface GalleryCommand {id:number;item?:ItemDetail;imageId?:string;job?:GenerationJobRecord;editResult?:boolean}
interface Props {command?:GalleryCommand;preferences:LocalPreferences;t:Translator;active:boolean;onCreated:()=>void;onOpenSettings:()=>void;configurationRevision:number;promptVariablesEnabled?:boolean;promptLanguage?:string;preferredProvider?:string;onOpenAgent?:(id:string)=>void}
export function imageDataUrl(blob: Blob): Promise<string> {return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(blob);});}
async function verifiedInput(input:RecipeInput) {
  let data=input.dataUrl;
  if(!data){let url=input.resultPath?mediaUrl(input.resultPath):'';if(!url&&input.sourceItemId&&input.imageId){const image=(await api.item(input.sourceItemId)).images.find(candidate=>candidate.id===input.imageId);if(image)url=mediaUrl(image.original_path);}if(!url)throw new Error('参考图缺失');const result=await fetch(url);if(!result.ok)throw new Error('参考图无法读取');data=await imageDataUrl(await result.blob());}
  const image=new Image();image.src=data;await image.decode();return data;
}
export default function InputBar({command,preferences,t,active,onCreated,onOpenSettings,configurationRevision,promptVariablesEnabled=false,promptLanguage,preferredProvider,onOpenAgent}:Props) {
  const [draft,setDraft]=useState<GalleryDraft>(emptyGalleryDraft),[providers,setProviders]=useState<GenerationProviderStatus[]>([]),[profiles,setProfiles]=useState<OpenAICompatibleProfile[]>([]);
  const [loading,setLoading]=useState(true),[reading,setReading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[count,setCount]=useState<GenerationSetCount>(1);
  const [referenceSize,setReferenceSize]=useState<{width:number;height:number}>();
  const [referenceStatus,setReferenceStatus]=useState<'loading'|'ready'|'error'>('loading');
  const referenceSource=useRef<RecipeInput|undefined>(undefined);
  const measuredReferenceSize=draft.inputs[0]&&referenceSource.current===draft.inputs[0]?referenceSize:undefined;
  const [panel,setPanel]=useState(''),[picker,setPicker]=useState(false);
  const fileRef=useRef<HTMLInputElement>(null),textRef=useRef<HTMLTextAreaElement>(null),submitLock=useRef(false),readSequence=useRef(0),initialized=useRef(false),persistSequence=useRef(Promise.resolve());
  const consumedCommand=useRef<number|undefined>(undefined);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;readSequence.current++;};},[]);
  useEffect(()=>{let current=true;setReferenceSize(undefined);setReferenceStatus('loading');if(draft.provider==='openai_compatible'&&(draft.recipe.size_mode==='auto4k'||panel==='size')&&draft.inputs[0])void verifiedInput(draft.inputs[0]).then(async data=>{const image=new Image();image.src=data;await image.decode();if(current){referenceSource.current=draft.inputs[0];setReferenceSize({width:image.naturalWidth,height:image.naturalHeight});setReferenceStatus('ready');}}).catch(()=>{if(current)setReferenceStatus('error');});return()=>{current=false;};},[draft.provider,draft.recipe.size_mode,draft.inputs[0],panel]);
  const provider=providers.find(p=>p.provider===draft.provider),limit=provider?.max_input_images||4;
  const profile=profiles.find(p=>p.id===draft.profileId);
  const ready=draft.provider==='openai_compatible'?Boolean(profile?.configured):Boolean(provider?.can_generate??provider?.available);
  useEffect(()=>{let alive=true;setLoading(true);Promise.all([api.generationProviders(),api.openAICompatibleProfiles()]).then(async([available,store])=>{
    if(!alive)return;setProviders(available.filter(p=>p.provider!=='manual_upload'));setProfiles(store.profiles);
    if(!initialized.current){initialized.current=true;let restored:GalleryDraft|undefined;if(preferences.persistInputOnRestart){try{restored=await readGalleryDraft();}catch{if(alive)setError('无法恢复本地草稿；已保存的任务不受影响');}}if(!alive)return;
      const selected=store.profiles.find(p=>p.id===lastGenerationProfile(localStorage))||store.profiles.find(p=>p.id===store.default_profile_id);
      const preferred=available.find(p=>p.provider===preferredProvider&&p.can_generate);
      const fallback=preferred?.provider||(selected?'openai_compatible':available.find(p=>p.can_generate)?.provider)||'openai_compatible';
      setDraft(restored || {...emptyGalleryDraft(),provider:fallback,profileId:selected?.id||'',recipe:fallback==='openai_compatible'&&selected?readGenerationPreference(localStorage,selected.id,selected.model):{...emptyGalleryDraft().recipe,model:available.find(p=>p.provider===fallback)?.default_image_model||'gpt-image-2',quality:'medium'}});
    }
  }).catch(e=>alive&&setError(String(e))).finally(()=>alive&&setLoading(false));return()=>{alive=false;};},[configurationRevision]);
  useEffect(()=>{if(loading||!initialized.current)return;const timer=setTimeout(()=>{persistSequence.current=persistSequence.current.then(()=>saveGalleryDraft(preferences.persistInputOnRestart?draft:undefined)).catch(()=>setError('草稿未能写入浏览器存储；请保持此页打开'));},300);return()=>clearTimeout(timer);},[draft,preferences.persistInputOnRestart,loading]);
  useEffect(()=>{if(!loading&&draft.provider==='openai_compatible'&&draft.profileId)writeGenerationPreference(localStorage,draft.profileId,draft.recipe);},[draft.profileId,draft.recipe,loading]);
  useEffect(()=>{
    const reset=(event:Event)=>{const id=(event as CustomEvent<{profileId?:string}>).detail?.profileId;if(!id)return;setDraft(current=>current.provider==='openai_compatible'&&current.profileId===id?{...current,recipe:readGenerationPreference(localStorage,id,profiles.find(profile=>profile.id===id)?.model||'')}:current);};
    window.addEventListener('ipl:generation-preference-reset',reset);
    return()=>window.removeEventListener('ipl:generation-preference-reset',reset);
  },[profiles]);
  useEffect(()=>{if(!command||loading||consumedCommand.current===command.id)return;consumedCommand.current=command.id;const sequence=++readSequence.current;const current=()=>mounted.current&&sequence===readSequence.current;setReading(true);setError('');
    void (async()=>{
      let job=command.job;
      const selected=command.item?libraryRecipeImage(command.item,command.imageId):undefined;
      if(!job&&selected?.generation_provider){try{job=await api.generationJobForImage(selected.id);}catch{if(current()){setDraft({...emptyGalleryDraft(),prompt:command.item?.prompts.find(p=>p.is_original)?.text||command.item?.prompts[0]?.text||'',sourceItemId:command.item?.id,inputs:[{id:'missing-recipe',name:'原始参考图不可用',source:'uploaded',previewUrl:'',missing:true}]});throw new Error('历史生成配方缺失；请明确补齐参考图和参数');}return;}}
      if(job&&['agent_native','agent_native_batch'].includes(job.provider)){const agent=job.metadata?.agent as {conversationId?:string}|undefined;if(current()&&agent?.conversationId&&onOpenAgent){onOpenAgent(agent.conversationId);return;}throw new Error('此结果由 Agent Responses 生成，请在 Agent 会话中继续创作，或明确选择图片 API 开始新任务。');}
      if(job){let inputs=recipeInputs(job,mediaUrl);if(command.editResult){if(!job.result_path)throw new Error('结果图片不可用');inputs=[{id:`result-${job.id}`,name:job.id,source:'generated_result',resultPath:job.result_path,previewUrl:mediaUrl(job.result_path)}];}
        const frozen=await restoreRecipeInputs(inputs,verifiedInput);if(current())setDraft(draftFromJob(job,frozen));
      }else if(command.item){const item=command.item;const inputs=selected?[{id:`library-${selected.id}`,name:item.title,source:'library' as const,previewUrl:mediaUrl(selected.original_path),imageId:selected.id,sourceItemId:item.id}]:[];if(current())setDraft(previous=>({...previous,prompt:item.prompts.find(p=>p.is_original)?.text||item.prompts.find(p=>p.is_primary)?.text||item.prompts[0]?.text||'',sourceItemId:item.id,promptLanguage:item.prompts.find(p=>p.is_original)?.language,templateValues:undefined,inputs}));}
      if(current())textRef.current?.focus();
    })().catch(e=>current()&&setError(String(e))).finally(()=>current()&&setReading(false));
  },[command?.id,loading]);
  const recipe=(patch:Partial<GalleryDraft['recipe']>)=>setDraft(current=>({...current,recipe:{...current.recipe,...patch}}));
  async function addFiles(files:File[]) {
    if(busy||reading)return; if(files.length+draft.inputs.filter(input=>!input.missing).length>limit){setError(`最多 ${limit} 张参考图，未截断本次选择`);return;}
    setReading(true);setError('');try{const added=await Promise.all(files.map(async file=>{if(!file.type.startsWith('image/')||file.size>30*1024*1024)throw new Error('请选择 30 MB 内的图片文件');const dataUrl=await imageDataUrl(file);const image=new Image();image.src=dataUrl;await image.decode();return{id:crypto.randomUUID(),name:file.name,source:'uploaded' as const,previewUrl:dataUrl,dataUrl};}));setDraft(current=>{const remaining=[...added];return{...current,inputs:[...current.inputs.map(input=>input.missing&&remaining.length?remaining.shift()!:input),...remaining]};});}catch(e){setError(String(e));}finally{setReading(false);}
  }
  async function submit() {
    if(submitLock.current||busy||reading||loading||uncertain||!ready)return;submitLock.current=true;setBusy(true);setError('');let posted=false;
    try{let dimensions: {width:number;height:number}|undefined;if(draft.provider==='openai_compatible'&&draft.recipe.size_mode==='auto4k'&&draft.inputs[0]){const data=await verifiedInput(draft.inputs[0]);const image=new Image();image.src=data;await image.decode();dimensions={width:image.naturalWidth,height:image.naturalHeight};}
      const payload=galleryPayload({...draft,promptLanguage:draft.promptLanguage||promptLanguage},limit,dimensions,promptVariablesEnabled);posted=true;if(count===1)await api.createGenerationJob(payload);else await api.createGenerationSet({job:payload,count});onCreated();
      if(preferences.clearInputAfterSubmit)setDraft(current=>({...current,prompt:'',inputs:[],sourceItemId:undefined}));setPanel('');
    }catch(e){setError(String(e));if(posted){setUncertain(true);setError(`${String(e)} · 未自动重试。先查看历史确认是否已创建任务，再决定是否再次提交。`);}}
    finally{submitLock.current=false;setBusy(false);}
  }
  const variables=promptVariablesEnabled?extractPromptTemplateVariableRecords(draft.prompt):[];
  const sizePreview=draft.provider==='openai_compatible'&&draft.recipe.size_mode==='auto4k'?resolveAuto4k(variables.length?resolvePromptTemplate(draft.prompt,draft.templateValues||{}):draft.prompt,referenceSize):undefined;
  const models=profileModelChoices(draft.provider==='openai_compatible'?profile:{model:provider?.default_image_model||'',models:provider?.image_models},draft.recipe.model,[...IMAGE25_MODELS,...COMPATIBLE_ENTERPRISE_MODELS]);
  const providerLabel=draft.provider==='openai_compatible'?(profile?.display_name||'API 配置'):(provider?.display_name||'API 配置');
  const sizeValue=draft.provider==='openai_compatible'?(draft.recipe.size_mode==='auto4k'?`4K 自动比例${sizePreview&&!('error' in sizePreview)?` · ${sizePreview.size.replace('x',' × ')}`:''}`:draft.recipe.size.replace('x',' × ')):`${draft.aspectRatio}${draft.provider==='xai_grok_oauth'?` · ${draft.resolution}`:''}`;
  const sizeLabel=draft.provider==='openai_compatible'?(draft.recipe.size_mode==='auto4k'?'4K 自动比例':`请求尺寸 ${draft.recipe.size}`):draft.aspectRatio;
  const backgroundLabel=`透明 ${({auto:'auto',opaque:'false',transparent:'true'} as Record<string,string>)[draft.recipe.background||'auto']||draft.recipe.background}`;
  const moreValue=draft.provider==='openai_compatible'?`${draft.recipe.output_format.toUpperCase()} · ${backgroundLabel} · 审核 ${draft.recipe.moderation||'auto'}${draft.recipe.output_format!=='png'&&draft.recipe.output_compression!==undefined?` · 压缩 ${draft.recipe.output_compression}`:''}`:'供应商默认';
  const chip=(name:string,label:string,value:string,ariaLabel=`${label} ${value}`)=><button type="button" className={`pg-param-chip pg-param-${name}${panel===name?' active':''}`} title={`${label} ${value}`} aria-label={ariaLabel} aria-expanded={panel===name} aria-haspopup={name==='size'&&draft.provider==='openai_compatible'?'dialog':undefined} aria-controls={name==='size'&&draft.provider==='openai_compatible'?'gallery-size-title':'gallery-parameter-panel'} onClick={()=>setPanel(panel===name?'':name)}>{label&&<span className="pg-param-label">{label}</span>}<span className="pg-param-value">{value}</span><ChevronDown size={12}/></button>;
  return <div className="pg-composer" data-input-bar hidden={!active} onKeyDown={event=>{if(event.key==='Escape'&&panel){event.stopPropagation();setPanel('');}}}>
    <div className="pg-composer-body">
    {draft.sourceItemId&&<div className="pg-composer-source">来自 Library 配方 <button onClick={()=>setDraft(current=>({...current,sourceItemId:undefined}))}>解除关联</button></div>}
    {draft.inputs.length>0&&<div className="pg-input-images">{draft.inputs.map((input,index)=><div key={input.id} className={input.missing?'missing':''}>{!input.missing&&<img src={input.previewUrl} alt={input.name}/>}<span>{index+1}. {input.missing?'图片缺失':input.name}</span><button aria-label={`移除参考图 ${index+1}`} disabled={busy||reading} onClick={()=>setDraft(current=>({...current,inputs:current.inputs.filter((_,i)=>i!==index)}))}><X size={14}/></button></div>)}</div>}
    <textarea ref={textRef} aria-label="画廊提示词" placeholder="描述想要的画面，或拖入参考图继续创作…" value={draft.prompt} disabled={busy} onChange={e=>setDraft(current=>({...current,prompt:e.target.value}))} onPaste={e=>{const files=Array.from(e.clipboardData.files).filter(file=>file.type.startsWith('image/'));if(files.length){e.preventDefault();void addFiles(files);}}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const files=Array.from(e.dataTransfer.files);if(files.length)void addFiles(files);else{const text=e.dataTransfer.getData('text/plain');if(text&&!/^https?:\/\//.test(text))setDraft(current=>({...current,prompt:current.prompt+text}));else setError('网页图片请使用复制图片或拖入已下载文件');}}} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&(e.ctrlKey||e.metaKey||(preferences.enterSubmit&&!e.shiftKey))){e.preventDefault();void submit();}}}/>
    {variables.length>0&&<details className="pg-template-fields" open><summary>提示词变量</summary>{variables.map(variable=><label key={variable.key}>{variable.key}<input value={draft.templateValues?.[variable.key]||''} onChange={e=>setDraft(current=>({...current,templateValues:{...current.templateValues,[variable.key]:e.target.value}}))}/></label>)}<pre>{resolvePromptTemplate(draft.prompt,draft.templateValues||{})}</pre></details>}
    {sizePreview&&<p className="pg-note">{'error' in sizePreview?'比例无效或冲突，请先明确本轮比例。':sizePreview.source==='default'&&draft.inputs.length&&!referenceSize?'正在读取参考图比例…':`请求 ${sizePreview.size} · ${sizePreview.ratio} · ${sizePreview.source==='prompt'?'来自提示词':sizePreview.source==='reference'?'来自首张参考图':'默认方形'}，以实际文件尺寸为准。`}</p>}
    {(error||!ready||reading)&&<p className={error?'pg-error':'pg-note'} role="status">{error|| (reading?'正在读取原始参考图…':loading?'加载供应商…':'请选择已完成配置的接口；图库和收录功能不依赖接口。')}</p>}
    {uncertain&&<button onClick={()=>{setUncertain(false);onCreated();}}>我已检查历史，允许新的提交</button>}
    </div>
    <div className="pg-provider-line"><span>供应商</span><button type="button" className="pg-provider-trigger" aria-label={providerLabel} title="选择供应商" aria-expanded={panel==='provider'} aria-controls="gallery-parameter-panel" onClick={()=>setPanel(panel==='provider'?'':'provider')}><Settings2 size={13}/><span>{providerLabel}</span><ChevronDown size={11}/></button></div>
    <div className="pg-composer-toolbar">
      <div className="pg-parameter-chips" aria-label="图片请求参数">
        {chip('model','',draft.recipe.model||'选择模型',`请求模型 ${draft.recipe.model||'未选择'}`)}
        {chip('size','尺寸',sizeValue,sizeLabel)}
        {chip('quality','质量',draft.recipe.quality)}
        <label className="pg-param-chip pg-param-count"><span className="pg-param-label">数量</span><select aria-label="生成数量" value={count} disabled={busy} onChange={e=>setCount(Number(e.target.value) as GenerationSetCount)}>{[1,3,5,10].map(n=><option value={n} key={n}>{n} 张</option>)}</select><ChevronDown size={12}/></label>
        {chip('more','更多',moreValue)}
      </div>
      <div className="pg-composer-actions">
        <button type="button" className={`pg-add-image${panel==='add'?' active':''}`} title="添加参考图" aria-label="添加参考图" aria-expanded={panel==='add'} aria-controls="gallery-parameter-panel" disabled={busy||reading} onClick={()=>setPanel(panel==='add'?'':'add')}><Plus size={21}/></button>
        <button type="button" className="pg-submit" title={busy?'提交中':reading?'读取中':loading?'加载中':count===1?'生成图片':`生成 ${count} 张图片`} disabled={loading||reading||busy||uncertain||!ready||!draft.prompt.trim()||draft.inputs.some(i=>i.missing)} onClick={()=>void submit()} aria-label="生成图片">{busy||reading||loading?<LoaderCircle size={20} className="spin"/>:<ArrowRight size={21}/>}</button>
      </div>
    </div>
    {panel&&!(panel==='size'&&draft.provider==='openai_compatible')&&<div id="gallery-parameter-panel" className="pg-control-popover pg-parameters-panel" data-panel={panel} role="region" aria-label="生成参数">
      <header><b>{{provider:'API 配置',model:'请求模型',size:'请求尺寸',quality:'图片质量',more:'输出设置',add:'添加参考图'}[panel]}</b><button aria-label="关闭参数" onClick={()=>setPanel('')}><X size={16}/></button></header>
      {panel==='add'&&<div className="pg-add-options"><button type="button" aria-label="上传参考图" onClick={()=>{setPanel('');fileRef.current?.click();}}><ImagePlus size={18}/><span>上传图片文件</span></button><button type="button" aria-label="从 Library 或画廊选择参考图" onClick={()=>{setPanel('');setPicker(true);}}><Layers size={18}/><span>从 Library 或画廊选择</span></button><small>也可以粘贴图片或拖入文件，保留原图。</small></div>}
      {panel==='provider'&&<><div className="pg-option-list">{profiles.map(p=><button key={p.id} aria-pressed={draft.provider==='openai_compatible'&&draft.profileId===p.id} onClick={()=>{setDraft(current=>({...current,provider:'openai_compatible',profileId:p.id,recipe:readGenerationPreference(localStorage,p.id,p.model)}));setPanel('');}}>{p.display_name}<small>{p.configured?'已配置 · 调用能力以实际响应为准':'未完成配置'}</small></button>)}{providers.filter(p=>p.provider!=='openai_compatible').map(p=><button key={p.provider} onClick={()=>{setDraft(current=>({...current,provider:p.provider,recipe:{...current.recipe,model:p.default_image_model||p.model||'',quality:'medium'}}));setPanel('');}}>{p.display_name}<small>{p.can_generate?'可用':'未连接'}</small></button>)}</div><button onClick={onOpenSettings}>管理 API 配置</button></>}
      {panel==='model'&&<><input aria-label="请求模型完整 ID" list="gallery-models" value={draft.recipe.model} onChange={e=>recipe({model:e.target.value})}/><datalist id="gallery-models">{models.map(model=><option key={model} value={model}/>)}</datalist><small>保留完整模型 ID，按当前接口支持情况填写。</small></>}
      {panel==='size'&&draft.provider!=='openai_compatible'&&<><select aria-label="宽高比" value={draft.aspectRatio} onChange={e=>setDraft(current=>({...current,aspectRatio:e.target.value}))}>{['auto','1:1','2:3','3:4','9:16','4:3','16:9'].map(r=><option key={r}>{r}</option>)}</select>{draft.provider==='xai_grok_oauth'&&<select aria-label="Grok 分辨率" value={draft.resolution} onChange={e=>setDraft(current=>({...current,resolution:e.target.value}))}><option>1k</option><option>2k</option></select>}</>}
      {panel==='quality'&&<div className="pg-option-list">{(draft.provider==='openai_compatible'?IMAGE25_QUALITIES:draft.provider==='xai_grok_oauth'?['low','medium']:['low','medium','high']).map(quality=><button key={quality} aria-pressed={draft.recipe.quality===quality} onClick={()=>{recipe({quality});setPanel('');}}>{({auto:'自动',low:'低',medium:'中',high:'高',xhigh:'超高',max:'最高'} as Record<string,string>)[quality]} · {quality}</button>)}</div>}
      {panel==='more'&&(draft.provider==='openai_compatible'?<div className="pg-more-fields"><label><span>格式</span><select aria-label="输出格式" value={draft.recipe.output_format} onChange={e=>recipe({output_format:e.target.value})}>{['png','jpeg','webp'].map(value=><option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label><label><span>透明</span><select aria-label="图片背景" value={draft.recipe.background} onChange={e=>recipe({background:e.target.value})}><option value="auto">auto</option><option value="opaque">false</option><option value="transparent">true</option></select></label><label><span>审核</span><select aria-label="审核强度" value={draft.recipe.moderation||'auto'} onChange={e=>recipe({moderation:e.target.value as 'auto'|'low'})}><option value="auto">auto</option><option value="low">low</option></select></label>{draft.recipe.output_format!=='png'&&<label><span>压缩 <small>0–100</small></span><input aria-label="输出压缩" type="number" min={0} max={100} placeholder="默认" value={draft.recipe.output_compression??''} onChange={e=>recipe({output_compression:e.target.value===''?undefined:Number(e.target.value)})}/></label>}<small>透明 auto 由服务决定；参数按当前接口支持情况发送。</small></div>:<p>此供应商使用其原有输出格式。</p>)}
    </div>}
    <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e=>{void addFiles(Array.from(e.target.files||[]));e.target.value='';}}/>
    {panel==='size'&&draft.provider==='openai_compatible'&&active&&<SizeDialog recipe={draft.recipe} prompt={variables.length?resolvePromptTemplate(draft.prompt,draft.templateValues||{}):draft.prompt} referenceSize={measuredReferenceSize} referenceStatus={draft.inputs[0]?(measuredReferenceSize?'ready':referenceStatus==='error'?'error':'loading'):undefined} onApply={recipe} onClose={()=>setPanel('')}/>}
    {picker&&<ReferencePicker onClose={()=>setPicker(false)} onSelect={input=>{if(draft.inputs.length>=limit)setError(`最多 ${limit} 张参考图，请先移除一张`);else setDraft(current=>({...current,inputs:[...current.inputs,input]}));}}/>}
  </div>;
}
