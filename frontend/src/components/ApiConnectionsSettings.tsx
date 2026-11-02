import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2, Copy, ArrowUp, ArrowDown, RefreshCw, KeyRound, Check, ChevronLeft } from 'lucide-react';
import { apiConnections as connections } from '../api/client';
import { copyApiProfile, reorderApiProfiles } from '../api/profileActions';
import type { ApiConnectionProfile, ApiConnectionProfiles, ApiProtocol, CatalogModel, ConnectionModelDiscovery, ModelCatalog, UiLanguage } from '../types';
import { connectionEndpointPreview, parseProfileModels, profileValidation } from '../utils/profileSettings';
import { CONNECTION_TYPES, API_PROTOCOLS, applyConnectionType, connectionModels, connectionProtocolLabel, connectionTargetChanged, connectionUsage, connectionVersionLabel, discoveryMessage, canUseAsImageDefault, modelCapabilityLabel, newConnectionProfile, type ConnectionType, type ModelFilter } from '../utils/connectionSettings';
import { readGenerationPreference, resetGenerationPreference, updateRememberedModel } from '../utils/generationPreferences';
import type { CompatibleRecipe } from '../utils/compatibleRecipe';
import { apiNetworkErrorMessage, apiNetworkIssue, apiNetworkMode, apiNetworkPayload } from '../utils/apiNetwork';
import ApiNetworkSettings from './ApiNetworkSettings';
import './ApiConnectionsSettings.css';

const emptyCatalog = (): ModelCatalog => ({ models: [], fetched_at: null, checked_at: null, error: null });
const sameForm = (a: ApiConnectionProfile, b: ApiConnectionProfile) => {
  const {model_catalog: _a, ...left}=a, {model_catalog: _b, ...right}=b;
  const comparable=(value:typeof left)=>Object.fromEntries(Object.entries({...value,service_preset_mode:value.service_preset_mode||'auto'}).sort(([a],[b])=>a.localeCompare(b)));
  return JSON.stringify(comparable(left))===JSON.stringify(comparable(right));
};

export default function ApiConnectionsSettings({ onSaved, uiLanguage, isDefaultConnection=false, onSetDefaultConnection }: {
  onSaved: () => Promise<void>; uiLanguage: UiLanguage; isDefaultConnection?: boolean; onSetDefaultConnection?: () => void;
}) {
  const en=uiLanguage==='en';
  const [collection,setCollection]=useState<ApiConnectionProfiles>();
  const [config,setConfig]=useState<ApiConnectionProfile>();
  const [apiKey,setApiKey]=useState('');
  const [proxyUrl,setProxyUrl]=useState('');
  const [removeProxy,setRemoveProxy]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [picker,setPicker]=useState(false);
  const [custom,setCustom]=useState(false);
  const [adaptationNeedsCheck,setAdaptationNeedsCheck]=useState(false);
  const [pendingPreset,setPendingPreset]=useState<'auto'|'generic'|'muse'>();
  const [pendingType,setPendingType]=useState<ConnectionType>();
  const [deletePending,setDeletePending]=useState(false);
  const [resetPending,setResetPending]=useState(false);
  const [modelsText,setModelsText]=useState('');
  const [remembered,setRemembered]=useState<CompatibleRecipe>();
  const [catalog,setCatalog]=useState<ModelCatalog>(emptyCatalog());
  const [discovery,setDiscovery]=useState<ConnectionModelDiscovery>();
  const [catalogBusy,setCatalogBusy]=useState(false);
  const [catalogError,setCatalogError]=useState('');
  const [search,setSearch]=useState('');
  const [filter,setFilter]=useState<ModelFilter>('all');
  const [dragged,setDragged]=useState<string>();
  const mutation=useRef(false), mounted=useRef(true), epoch=useRef(0), catalogEpoch=useRef(0);
  const selected=useRef<string | undefined>(undefined);
  const discoveryFlight=useRef<AbortController | undefined>(undefined);
  const modelInput=useRef<HTMLInputElement>(null);
  const stored=collection?.profiles.find(value=>value.id===config?.id);
  const selectedProtocol=config?.protocol || 'openai_compatible';
  const muse=config?.service_preset==='muse';
  const presetMode=config?.service_preset_mode||'auto';
  const presetChoice=presetMode==='auto'?'auto':config?.service_preset||'generic';
  const detectedMuse=selectedProtocol==='openai_compatible'&&presetMode==='auto'&&discovery?.detected_service_preset==='muse';
  const museKeyHint=selectedProtocol==='openai_compatible'&&presetMode==='auto'&&apiKey.trim().startsWith('m2a_')&&!detectedMuse;
  const targetChanged=Boolean(config&&connectionTargetChanged(config,stored));
  const dirty=Boolean(apiKey||proxyUrl||removeProxy||(config&&(stored?!sameForm(config,stored)||JSON.stringify(parseProfileModels(modelsText))!==JSON.stringify(stored.models||[]):
    JSON.stringify({...config,id:''})!==JSON.stringify({...newConnectionProfile(),id:''})||modelsText.trim())));
  const endpoints=config?connectionEndpointPreview(config.base_url,config.base_url_mode,selectedProtocol,config.model||'MODEL_ID'):undefined;
  const canDiscover=Boolean(config&&endpoints&&(apiKey.trim()||!targetChanged&&stored?.api_key_present||selectedProtocol==='seedream_native'&&!targetChanged));
  const invalidateCatalog=(clear=true,connectionChanged=false)=>{
    ++catalogEpoch.current; discoveryFlight.current?.abort(); discoveryFlight.current=undefined;
    setCatalogBusy(false); setDiscovery(undefined); setCatalogError('');
    if(clear) setCatalog(emptyCatalog());
    if(connectionChanged&&config?.service_preset==='muse'&&(config.service_preset_mode||'auto')==='auto'){
      const id=config.id;
      setConfig(current=>current?.id===id&&(current.service_preset_mode||'auto')==='auto'?{...current,service_preset:'generic'}:current);
      setAdaptationNeedsCheck(true);
    }
  };
  const edit=(patch:Partial<ApiConnectionProfile>,changesConnection=false)=>{
    if(changesConnection) invalidateCatalog(true,Object.entries(patch).some(([key,value])=>config?.[key as keyof ApiConnectionProfile]!==value));
    setConfig(value=>value?{...value,...patch}:value); setMessage('');
  };
  const choose=(profile:ApiConnectionProfile,preserved?:ModelCatalog,verified?:ConnectionModelDiscovery)=>{
    invalidateCatalog(); setPendingPreset(undefined); setAdaptationNeedsCheck(false); selected.current=profile.id;
    setConfig({...profile}); setApiKey(''); setProxyUrl(''); setRemoveProxy(false);
    setModelsText((profile.models||[]).join('\n')); setSearch(''); setFilter('all'); setMessage('');
    setDeletePending(false); setResetPending(false); setPendingType(undefined); setCustom(false);
    setPicker(!profile.configured&&!profile.base_url&&!profile.display_name);
    setCatalog(preserved||profile.model_catalog||emptyCatalog()); setDiscovery(verified);
    try{setRemembered(readGenerationPreference(localStorage,profile.id,profile.model,profile.protocol,profile.service_preset));}catch{setRemembered(undefined);}
    if(profile.configured&&!preserved){
      const ticket=++catalogEpoch.current;
      void connections.catalog(profile.id).then(value=>{
        if(mounted.current&&ticket===catalogEpoch.current&&selected.current===profile.id) setCatalog(value);
      }).catch(()=>undefined);
    }
  };
  const load=()=>{
    if(mutation.current)return;
    mutation.current=true;const ticket=++epoch.current;setBusy(true);
    void connections.list().then(value=>{
      if(!mounted.current||ticket!==epoch.current)return;
      setCollection(value); choose(value.profiles.find(p=>p.id===value.default_profile_id)||value.profiles[0]||newConnectionProfile());
    }).catch(()=>{if(mounted.current&&ticket===epoch.current)setMessage(en?'Could not load connections.':'无法读取连接，请重新打开设置。');})
      .finally(()=>{if(mounted.current&&ticket===epoch.current){mutation.current=false;setBusy(false);}});
  };
  useEffect(()=>{
    mounted.current=true;load();
    return()=>{mounted.current=false;mutation.current=false;++epoch.current;++catalogEpoch.current;discoveryFlight.current?.abort();selected.current=undefined;};
  },[]);

  const mutate=async(operation:()=>Promise<ApiConnectionProfiles>,nextId?:string,onConfirmed?:(value:ApiConnectionProfiles)=>void,preserveDiscovery=false)=>{
    if(mutation.current)return false;
    mutation.current=true;const ticket=++epoch.current;setBusy(true);setMessage('');setDeletePending(false);
    const retained=preserveDiscovery?catalog:undefined, retainedDiscovery=preserveDiscovery?discovery:undefined;
    invalidateCatalog(false);
    try{
      const value=await operation();
      if(!mounted.current||ticket!==epoch.current)return false;
      onConfirmed?.(value);setCollection(value);
      choose(value.profiles.find(p=>p.id===nextId)||value.profiles.find(p=>p.id===value.default_profile_id)||value.profiles[0]||newConnectionProfile(),retained,retainedDiscovery);
      window.dispatchEvent(new Event('ipl:agent-config-changed'));
      setMessage(en?'Saved. No generation request was sent.':'已保存，未发送生成请求。');
      await onSaved().catch(()=>undefined);return true;
    }catch(reason){
      if(mounted.current&&ticket===epoch.current){
        const keyRequired=reason instanceof Error&&reason.message.startsWith('Enter the API key again');
        setMessage(keyRequired?discoveryMessage('key_reentry_required',en):en?'Could not confirm the result. Reload connections before retrying.':'暂时无法确认操作结果，请重新读取连接后再操作。');
      }
      return false;
    }finally{
      if(mounted.current&&ticket===epoch.current){setApiKey('');setProxyUrl('');mutation.current=false;setBusy(false);}
    }
  };
  const networkIssue=()=>apiNetworkIssue(apiNetworkMode(config?.network_mode),{proxyUrl,removeProxy},config?.proxy_url_present===true);
  const discover=async()=>{
    if(!config||busy||discoveryFlight.current||!canDiscover)return;
    const problem=networkIssue();
    if(problem){setCatalogError(apiNetworkErrorMessage(problem,uiLanguage));return;}
    const controller=new AbortController();discoveryFlight.current=controller;
    const ticket=++catalogEpoch.current, id=config.id;
    setCatalogBusy(true);setCatalogError('');setDiscovery(undefined);setMessage('');
    try{
      const value=await connections.discover({...(stored?{profile_id:id}:{}),protocol:selectedProtocol,service_preset:config.service_preset||'generic',service_preset_mode:config.service_preset_mode||'auto',base_url:config.base_url,
        base_url_mode:config.base_url_mode||'versioned',...(apiKey.trim()?{api_key:apiKey.trim()}:{}),
        ...apiNetworkPayload(apiNetworkMode(config.network_mode),{proxyUrl,removeProxy})},controller.signal);
      if(!mounted.current||controller.signal.aborted||ticket!==catalogEpoch.current||selected.current!==id)return;
      if(value.error_code){setCatalogError(discoveryMessage(value.error_code,en));setDiscovery(undefined);return;}
      setCatalog(value);setDiscovery(value);setAdaptationNeedsCheck(false);
      if(value.detected_service_preset==='muse'&&selectedProtocol==='openai_compatible'&&(config.service_preset_mode||'auto')==='auto'){
        setConfig(current=>current?.id===id&&(current.service_preset_mode||'auto')==='auto'?{...current,service_preset:'muse',stream:false,partial_images:0}:current);
      }
    }catch(reason){
      if(mounted.current&&!controller.signal.aborted&&ticket===catalogEpoch.current){
        const code=reason&&typeof reason==='object'&&'code' in reason?String(reason.code):'connection';
        setCatalogError(discoveryMessage(code,en));
      }
    }finally{
      if(discoveryFlight.current===controller){discoveryFlight.current=undefined;if(mounted.current)setCatalogBusy(false);}
    }
  };
  const save=(event:FormEvent)=>{
    event.preventDefault();if(!config||picker)return;
    const models=parseProfileModels(modelsText), issue=profileValidation({...config,models});
    if(issue){setMessage(issue==='name'?(en?'Enter a connection name.':'请填写连接名称。'):issue==='url'?(en?'Enter a valid Base URL without a key or full endpoint.':'请填写有效 Base URL，不含密钥或完整接口路径。'):issue==='models'?(en?'Use at most 100 valid model IDs.':'最多填写 100 个有效模型 ID。'):(en?'Check timeout and transport values.':'请检查超时和传输参数。'));return;}
    if(targetChanged&&stored?.api_key_present&&!apiKey.trim()){setMessage(discoveryMessage('key_reentry_required',en));return;}
    const problem=networkIssue();if(problem){setMessage(apiNetworkErrorMessage(problem,uiLanguage));return;}
    const {id,api_key_present:_key,configured:_configured,model_catalog:_catalog,proxy_url_present:_proxy,proxy_endpoint:_endpoint,image_capabilities:_capabilities,...fields}=config;
    const previous=stored?.model||'';
    void mutate(()=>connections.save(id,{...fields,service_preset_mode:config.service_preset_mode||'auto',models,...apiNetworkPayload(apiNetworkMode(config.network_mode),{proxyUrl,removeProxy}),...(apiKey.trim()?{api_key:apiKey.trim()}: {})}),id,value=>{
      const saved=value.profiles.find(p=>p.id===id);if(!saved||saved.model===previous)return;
      try{updateRememberedModel(localStorage,id,saved.model,saved.protocol,saved.service_preset);}catch{/* local storage may be disabled */}
      window.dispatchEvent(new CustomEvent('ipl:profile-model-saved',{detail:{profileId:id,model:saved.model}}));
    },true);
  };
  const selectType=(choice:ConnectionType)=>{
    if(!config||busy)return;
    if(stored||dirty){setPendingType(choice);return;}
    confirmType(choice);
  };
  const confirmType=(choice:ConnectionType)=>{
    if(!config)return;
    invalidateCatalog();setConfig(applyConnectionType(config,choice));setApiKey('');setModelsText('');
    setPicker(false);setCustom(false);setPendingType(undefined);setPendingPreset(undefined);setAdaptationNeedsCheck(false);setMessage('');
  };
  const selectModel=(model:CatalogModel)=>{
    if(!config||busy)return;
    if(muse&&model.id==='muse-video'){setMessage(en?'Video is not supported in this project.':'视频暂未接入本项目。');return;}
    const values=parseProfileModels(modelsText);
    if(!values.includes(model.id)){
      if(values.length>=100){setMessage(en?'At most 100 selected models.':'最多保存 100 个模型。');return;}
      setModelsText([...values,model.id].join('\n'));
    }
    if(canUseAsImageDefault(model)) edit({model:model.id});
    else setMessage(muse?(en?'Recorded as a text model; Muse Responses cannot control Agent tools.':'已记录文字模型；Muse Responses 不能作为 Agent 工具主控。'):(en?'Added to available models. Select it in Agent text settings.':'已加入可用模型，可在 Agent 文字设置中选择。'));
  };
  const move=(from:string,to:string)=>{
    if(!collection||dirty||busy||from===to)return;
    const ids=collection.profiles.map(p=>p.id);if(!ids.includes(from)||!ids.includes(to))return;
    const next=ids.filter(id=>id!==from);next.splice(ids.indexOf(to),0,from);
    void mutate(()=>reorderApiProfiles(next),config?.id);
  };
  const duplicate=()=>{
    if(!stored||dirty||busy)return;
    const id=crypto.randomUUID();void mutate(()=>copyApiProfile(stored.id,id,stored.display_name.slice(0,92)+(en?' Copy':' 副本')),id);
  };
  const setDefault=async()=>{
    if(!stored||!config||dirty||busy||!config.configured)return;
    if(config.id!==collection?.default_profile_id&&!await mutate(()=>connections.setDefault(config.id),config.id))return;
    onSetDefaultConnection?.();setMessage(en?'Default updated; existing drafts and jobs are unchanged.':'默认连接已更新，现有草稿和任务保持原配置。');
  };
  const resetRecipe=()=>{
    if(!config||dirty||busy)return;
    try{
      if(!resetGenerationPreference(localStorage,config.id,config.protocol,config.service_preset))throw Error();
      setRemembered(readGenerationPreference(localStorage,config.id,config.model,config.protocol,config.service_preset));setResetPending(false);
      window.dispatchEvent(new CustomEvent('ipl:generation-preference-reset',{detail:{profileId:config.id}}));
      setMessage(en?'Browser image settings reset; prompts and references are unchanged.':'本浏览器参数已重置，提示词和参考图保留。');
    }catch{setMessage(en?'Browser storage is unavailable.':'浏览器存储不可用，未重置参数。');}
  };
  const visibleModels=connectionModels(catalog.models,search,filter);
  const choices=parseProfileModels(modelsText);

  return <section className="api-connections">
    <header className="api-connections-heading"><div><h4>{en?'API connections':'API 连接'}</h4><p>{en?'Connect a service, discover models, then save.':'连接服务，识别模型，保存使用。'}</p></div>
      <button type="button" className="secondary" disabled={busy||dirty} aria-label={en?'Reload connections':'重新读取连接'} onClick={load}><RefreshCw size={16}/></button></header>
    {collection&&<div className="api-connections-layout">
      <aside className="api-connection-sidebar" aria-label={en?'Saved connections':'已保存连接'}>
        <div className="api-connection-list">{collection.profiles.map((profile,index)=><div key={profile.id} className="api-connection-row" draggable={!busy&&!dirty}
          onDragStart={event=>{setDragged(profile.id);event.dataTransfer.setData('text/plain',profile.id);}}
          onDragOver={event=>{if(dragged&&!dirty)event.preventDefault();}}
          onDrop={event=>{event.preventDefault();if(dragged)move(dragged,profile.id);setDragged(undefined);}} onDragEnd={()=>setDragged(undefined)}>
          <button type="button" className={`api-connection-option${config?.id===profile.id?' active':''}`} aria-pressed={config?.id===profile.id}
            disabled={busy||dirty&&config?.id!==profile.id} onClick={()=>{if(!dirty)choose(profile);}}>
            <strong>{profile.display_name}</strong><span>{profile.service_preset==='muse'?'Muse · ':''}{connectionProtocolLabel(profile.protocol||'openai_compatible',en)}</span>
            <small>{profile.id===collection.default_profile_id?(en?'Default · ':'默认 · '):''}{profile.configured?(en?'Saved':'已保存'):(en?'Incomplete':'待完善')}</small>
          </button><div className="api-connection-order"><button type="button" aria-label={`${en?'Move up':'上移'} ${profile.display_name}`} disabled={busy||dirty||index===0} onClick={()=>move(profile.id,collection.profiles[index-1].id)}><ArrowUp size={13}/></button><button type="button" aria-label={`${en?'Move down':'下移'} ${profile.display_name}`} disabled={busy||dirty||index===collection.profiles.length-1} onClick={()=>move(profile.id,collection.profiles[index+1].id)}><ArrowDown size={13}/></button></div>
        </div>)}</div>
        <button type="button" className="secondary api-connection-add" disabled={busy||dirty} onClick={()=>choose(newConnectionProfile())}><Plus size={15}/>{en?'Add connection':'添加连接'}</button>
        {stored&&<button type="button" className="api-link" disabled={busy||dirty} onClick={duplicate}><Copy size={13}/>{en?'Duplicate connection':'复制连接'}</button>}
      </aside>
      <div className="api-connection-editor">
        {config&&picker?<section className="api-type-picker" aria-label={en?'Choose connection type':'选择连接类型'}>
          <header><div><span className="api-step">01 / {en?'CONNECTION TYPE':'连接类型'}</span><h5>{en?'Choose your service':'选择要连接的服务'}</h5></div>
            {(stored||dirty)&&<button type="button" className="api-link" onClick={()=>{setPicker(false);setCustom(false);setPendingType(undefined);}}><ChevronLeft size={14}/>{en?'Back':'返回表单'}</button>}</header>
          {!custom?<div className="api-type-grid">{CONNECTION_TYPES.map(choice=><button key={choice.id} data-preset={choice.id} type="button" disabled={busy} onClick={()=>selectType(choice)}><span className="api-type-mark">{choice.mark}</span><strong>{choice.name}</strong><small>{connectionProtocolLabel(choice.protocol,en)}</small></button>)}
            <button type="button" data-preset="custom" onClick={()=>setCustom(true)}><span className="api-type-mark">+</span><strong>{en?'Custom service':'自定义服务'}</strong><small>{en?'Relay or local endpoint':'中转或本地接口'}</small></button></div>:
            <div className="api-custom-protocols"><p>{en?'Choose the protocol in your service documentation.':'选择服务文档规定的协议。'}</p>{API_PROTOCOLS.map(protocol=><button type="button" key={protocol} data-protocol={protocol} onClick={()=>selectType({id:'custom',protocol,url:'',name:en?'Custom connection':'自定义连接',mark:'+'})}>{connectionProtocolLabel(protocol,en)}</button>)}<button type="button" className="api-link" onClick={()=>setCustom(false)}>{en?'Back to services':'返回服务商'}</button></div>}
          {pendingType&&<div className="api-change-confirm" role="alertdialog" aria-label={en?'Confirm connection type change':'确认更换连接类型'}><strong>{en?'Replace connection fields?':'确认更换连接类型？'}</strong><p>{en?'The name and network settings stay. The address changes; the key, selected models and protocol transport options are reset. Nothing changes until you confirm.':'保留名称和网络设置；将更换地址，清空已填写的 Key 和模型，并恢复协议传输默认值。确认前不会改变当前内容。'}</p><div><button type="button" className="secondary" onClick={()=>{setPendingType(undefined);setPicker(false);}}>{en?'Cancel':'取消'}</button><button type="button" className="primary" onClick={()=>confirmType(pendingType)}>{en?'Confirm change':'确认更换'}</button></div></div>}
        </section>:config&&<form onSubmit={save} className="api-connection-form" autoComplete="off"><fieldset disabled={busy}>
          <div className="api-type-summary"><div><strong>{muse?'Muse · ':''}{connectionProtocolLabel(selectedProtocol,en)}</strong><p>{muse?(en?'Images: muse-image. Muse text Responses does not support Agent tools; video is not supported here.':'生图使用 muse-image；Muse 文字 Responses 不支持 Agent 工具调用，本项目暂不支持视频。'):connectionUsage(selectedProtocol,en)}</p></div><button type="button" className="api-link" onClick={()=>{setPicker(true);setCustom(false);}}>{en?'Change':'更换'}</button></div>
          <div className="api-basic-fields">
            <label>{en?'Name':'名称'}<input aria-label={en?'Connection name':'连接名称'} required maxLength={100} value={config.display_name} onChange={e=>edit({display_name:e.target.value})} placeholder={en?'e.g. My image service':'例如：我的图片服务'}/></label>
            <label>Base URL<input aria-label="Base URL" required type="url" spellCheck={false} value={config.base_url} onChange={e=>edit({base_url:e.target.value},true)} placeholder="https://api.example.com"/></label>
            <label>API Key<input aria-label="API Key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={e=>{invalidateCatalog(true,e.target.value!==apiKey);setApiKey(e.target.value);}} placeholder={stored?.api_key_present&&!targetChanged?(en?'Saved; leave blank to retain':'已保存，留空保留'):(en?'Enter an API key':'填写 API Key')}/></label>
          </div>
          {museKeyHint&&<p className="api-field-hint">{en?'This key may belong to Muse. Discover models to confirm.':'疑似 Muse，识别模型后确认。'}</p>}
          {adaptationNeedsCheck&&presetMode==='auto'&&<p role="status" className="api-field-hint">{en?'Connection details changed. Discover models again to confirm service adaptation.':'连接信息已更改，请重新识别模型以确认服务适配。'}</p>}
          {detectedMuse&&<p role="status" className="api-field-hint">{en?(dirty?'Muse detected automatically. Save the connection to apply.':'Muse detected automatically.'):(dirty?'已自动识别 Muse，保存连接后生效。':'已自动识别 Muse。')}</p>}
          {targetChanged&&stored?.api_key_present&&!apiKey&&<p className="api-field-warning"><KeyRound size={13}/>{discoveryMessage('key_reentry_required',en)}</p>}
          <div className="api-discovery-action"><button type="button" className="primary" aria-label={en?'Discover models':'识别模型'} disabled={!canDiscover||catalogBusy} onClick={()=>void discover()}><RefreshCw size={15} className={catalogBusy?'spin':''}/>{catalogBusy?(en?'Reading models…':'正在读取…'):selectedProtocol==='seedream_native'?(en?'Load reference models':'查看参考模型'):(en?'Discover models':'识别模型')}</button><button type="button" className="api-link" onClick={()=>modelInput.current?.focus()}>{en?'Enter a model manually':'手动填写模型'}</button></div>
          <section className="api-models" aria-label={en?'Models':'模型清单'}>
            <header><h5>{en?'Models':'模型'}</h5><small>{discovery?.source==='reference'||selectedProtocol==='seedream_native'&&catalog.models.length?(en?'Documentation reference · access not tested':'文档参考 · 未验证权限'):discovery?.connection_checked?(en?'Service list received · generation not tested':'已读取接口清单 · 未测试生成'):catalog.models.length?(en?'Retained list · not a current check':'保留清单 · 非本次验证'):(en?'Discovery is optional':'可识别，也可手动填写')}</small></header>
            {(catalogError||catalog.error)&&<p role="status" className="api-catalog-error">{catalogError||(en?'The saved catalog could not be verified. Discover again or enter a model manually.':'已保存清单暂不可核验，可重新识别或手动填写模型。')}</p>}
            {catalog.models.length>0&&<><input type="search" aria-label={en?'Search models':'搜索模型'} placeholder={en?'Search model IDs':'搜索模型 ID'} value={search} onChange={e=>setSearch(e.target.value)}/><div className="api-model-filters">{(['all','image','text','unknown'] as ModelFilter[]).map(value=><button key={value} type="button" aria-pressed={filter===value} onClick={()=>setFilter(value)}>{({all:en?'All':'全部',image:en?'Image':'图片',text:en?'Text':'文字',unknown:en?'Unknown':'待确认'})[value]}</button>)}</div>
              <div className="api-model-list">{visibleModels.map(model=><button key={model.id} type="button" data-catalog-model={model.id} aria-pressed={config.model===model.id||choices.includes(model.id)}
                disabled={busy||!canUseAsImageDefault(model)&&(selectedProtocol!=='openai_compatible'||model.text_generation===false)} onClick={()=>selectModel(model)}>
                <span><strong>{model.id}</strong><small>{muse&&model.id==='muse-video'?(en?'Video · not supported here':'视频 · 本项目暂不支持'):modelCapabilityLabel(model,en)}{model.capability_source==='documentation'?(en?' · reference':' · 文档参考'):''}</small></span><span className="api-model-choice">{config.model===model.id?<><Check size={13}/>{en?'Image default':'图片默认'}</>:choices.includes(model.id)?<Check size={14}/>:!canUseAsImageDefault(model)?(en?'Add':'添加'):(en?'Use':'选择')}</span>
              </button>)}</div>{!visibleModels.length&&<p className="api-empty">{en?'No matching models.':'没有匹配的模型。'}</p>}</>}
            <label className="api-default-model">{en?'Default image model (optional)':'默认图片模型（可选）'}<input ref={modelInput} list="connection-known-models" aria-label={en?'Default image model':'默认图片模型'} value={config.model} onChange={e=>edit({model:e.target.value})} spellCheck={false} placeholder={en?'Select above or enter an exact ID':'从上方选择，或填写完整模型 ID'}/><datalist id="connection-known-models">{[...new Set([...choices,...catalog.models.map(m=>m.id)])].map(id=><option key={id} value={id}/>)}</datalist></label>
            {choices.length>0&&<div className="api-selected-models" aria-label={en?'Selected models':'已选择模型'}>{choices.map(id=><span key={id}>{id}<button type="button" aria-label={`${en?'Remove model':'移除模型'} ${id}`} onClick={()=>setModelsText(choices.filter(value=>value!==id).join('\n'))}>×</button></span>)}</div>}
          </section>
          <details className="api-connection-advanced"><summary>{en?'Advanced settings':'高级设置'}</summary><div>
            {selectedProtocol==='openai_compatible'&&<section><h5>{en?'Service adaptation':'服务适配'}</h5>
              <div className="api-model-filters" role="group" aria-label={en?'Service adaptation':'服务适配'}>
                {(['auto','generic','muse'] as const).map(value=><button type="button" key={value} aria-pressed={presetChoice===value} disabled={busy}
                  onClick={()=>{if(presetChoice!==value)setPendingPreset(value);}}>{value==='auto'?(en?'Automatic (default)':'自动识别（默认）'):value==='muse'?(en?'Manual Muse':'手动 Muse'):(en?'Standard OpenAI compatible':'标准 OpenAI 兼容')}</button>)}
              </div>
              {pendingPreset&&<div className="api-change-confirm" role="alertdialog" aria-label={en?'Confirm service adaptation':'确认服务适配'}>
                <p>{en?'Change service adaptation? Address, key, prompt and images are retained. Automatic mode keeps the current adaptation until the next model discovery.':'切换服务适配？地址、密钥、提示词和图片保留。自动模式会保留当前适配，待下次识别模型时确认。'}</p>
                <button type="button" onClick={()=>setPendingPreset(undefined)}>{en?'Cancel adaptation':'取消适配'}</button>
                <button type="button" onClick={()=>{edit({service_preset_mode:pendingPreset==='auto'?'auto':'manual',...(pendingPreset==='auto'?{}:{service_preset:pendingPreset}),...(pendingPreset==='muse'?{stream:false,partial_images:0}:{})},true);setPendingPreset(undefined);setAdaptationNeedsCheck(false);}}>{en?'Apply adaptation':'确认适配'}</button>
              </div>}
            </section>}

            <section><h5>{en?'Address rules':'地址规则'}</h5><label>{en?'Base URL mode':'地址拼接方式'}<select aria-label={en?'Base URL mode':'地址拼接方式'} value={config.base_url_mode||'versioned'} onChange={e=>edit({base_url_mode:e.target.value as 'versioned'|'custom'},true)}><option value="versioned">{en?'Protocol version path':'协议标准路径'} · {connectionVersionLabel(selectedProtocol,en)}</option><option value="custom">{en?'Use exact base path':'使用填写的根路径'}</option></select></label>
              {endpoints&&<dl className="api-endpoints">{[[en?'Generate':'生成',endpoints.generate],[en?'Edit':'编辑',endpoints.edit],['Responses',endpoints.responses]].filter(([,url])=>url).map(([name,url])=><div key={name}><dt>{name}</dt><dd><code>POST {url}</code></dd></div>)}</dl>}</section>
            <section><h5>{en?'Network':'网络'}</h5><ApiNetworkSettings key={config.id} uiLanguage={uiLanguage} mode={apiNetworkMode(config.network_mode)} proxyUrl={proxyUrl} proxyUrlPresent={config.proxy_url_present===true} proxyEndpoint={config.proxy_endpoint} removeProxy={removeProxy} disabled={busy} onModeChange={mode=>edit({network_mode:mode},true)} onProxyUrlChange={value=>{invalidateCatalog(true,value!==proxyUrl);setProxyUrl(value);}} onRemoveProxyChange={value=>{invalidateCatalog(true,value!==removeProxy);setRemoveProxy(value);}}/>
              <label>{en?'Timeout (seconds)':'请求超时（秒）'}<input required type="number" min="1" max="1800" step="1" value={config.timeout} onChange={e=>edit({timeout:Number(e.target.value)})}/></label></section>
            <section><h5>{en?'Protocol transport':'协议传输'}</h5>{selectedProtocol==='openai_compatible'?<>
              {!muse&&<><label className="api-switch">{en?'Streaming':'流式传输'}<input type="checkbox" role="switch" aria-label={en?'Streaming':'流式传输'} checked={config.stream||false} onChange={e=>edit({stream:e.target.checked})}/></label>
              <label>{en?'Partial preview count':'中间预览图数量'}<select aria-label={en?'Partial preview count':'中间预览图数量'} disabled={!config.stream} value={config.partial_images||0} onChange={e=>edit({partial_images:Number(e.target.value)})}>{[0,1,2,3].map(n=><option key={n} value={n}>{n}</option>)}</select></label></>}
              <label className="api-switch">{en?'Request Base64 result':'返回 Base64 图片数据'}<input type="checkbox" role="switch" aria-label={en?'Request Base64 result':'返回 Base64 图片数据'} checked={config.response_format==='b64_json'} onChange={e=>edit({response_format:e.target.checked?'b64_json':'auto'})}/></label>
              <p>{muse?(en?'Muse returns a final image without streaming previews. No automatic retry.':'Muse 返回最终图片，不使用流式预览；不会自动重试。'):(en?'Requires service support; previews may be billed. No automatic retry after a timeout.':'需要服务支持；中间预览可能计费，超时不自动重试。')}</p></>:selectedProtocol==='seedream_native'?<label>{en?'Result delivery':'生成结果返回方式'}<select value={config.response_format||'auto'} onChange={e=>edit({response_format:e.target.value as 'auto'|'b64_json'|'url'})}><option value="auto">{en?'Service default':'服务默认'}</option><option value="b64_json">Base64</option><option value="url">URL</option></select></label>:<p>{en?'Non-streaming GenerateContent; final image returned as inlineData.':'非流式 GenerateContent，最终图片由 inlineData 返回。'}</p>}</section>
            <section><h5>{en?'Additional model IDs':'补充模型 ID'}</h5><textarea aria-label={en?'Available models':'可用模型'} rows={3} value={modelsText} onChange={e=>setModelsText(e.target.value)} placeholder={en?'One model ID per line':'每行一个完整模型 ID'} spellCheck={false}/></section>
            {(catalog.checked_at||catalog.fetched_at)&&<section className="api-catalog-diagnostics"><h5>{en?'Model discovery details':'模型识别详情'}</h5><dl className="api-endpoints">{[[en?'Last successful list':'上次成功清单',catalog.fetched_at],[en?'Last attempt':'上次尝试',catalog.checked_at]].filter(([,stamp])=>stamp).map(([label,stamp])=><div key={label}><dt>{label}</dt><dd><time dateTime={stamp!}>{new Date(stamp!).toLocaleString(en?'en-US':'zh-CN')}</time></dd></div>)}</dl><p>{en?'Model-list access does not verify generation or billing.':'模型清单读取成功不代表生成能力或费用已经验证。'}</p></section>}
            {stored&&remembered&&<section className="api-remembered"><h5>{en?'This browser’s image settings':'本浏览器记忆的生图参数'}</h5><dl><div><dt>{en?'Model':'模型'}</dt><dd>{remembered.model||'—'}</dd></div><div><dt>{en?'Size / quality':'尺寸 / 质量'}</dt><dd>{remembered.size} · {remembered.quality}</dd></div></dl><button type="button" className="secondary" disabled={dirty||busy} onClick={()=>setResetPending(true)}>{en?'Reset browser parameters':'重置本浏览器参数'}</button>{resetPending&&<div className="api-change-confirm"><p>{en?'Reset this connection’s image settings? Prompts, references and jobs remain.':'重置此连接的生图参数？提示词、参考图和任务都会保留。'}</p><button type="button" onClick={()=>setResetPending(false)}>{en?'Cancel':'取消'}</button><button type="button" onClick={resetRecipe}>{en?'Reset parameters':'确认重置'}</button></div>}</section>}
          </div></details>
          <div className="api-save-bar"><button type="submit" className="primary">{busy?(en?'Saving…':'保存中…'):(en?'Save connection':'保存连接')}</button>{dirty&&<button type="button" className="secondary" onClick={()=>choose(stored||newConnectionProfile())}>{en?'Discard changes':'放弃修改'}</button>}
            {stored&&(config.id!==collection.default_profile_id||!isDefaultConnection)&&<button type="button" className="api-link" disabled={dirty||!config.configured} onClick={()=>void setDefault()}>{en?'Use as default':'设为默认连接'}</button>}
            {stored&&<button type="button" className="api-delete" aria-label={en?'Delete connection':'删除连接'} disabled={dirty} onClick={()=>setDeletePending(true)}><Trash2 size={15}/></button>}</div>
          {deletePending&&<div className="api-change-confirm" role="alertdialog"><p>{en?`Delete “${config.display_name}” and its key? Images and history remain.`:`删除「${config.display_name}」及其 Key？图片和历史仍会保留。`}</p><button type="button" onClick={()=>setDeletePending(false)}>{en?'Cancel':'取消'}</button><button type="button" onClick={()=>void mutate(()=>connections.remove(config.id))}>{en?'Delete':'确认删除'}</button></div>}
        </fieldset></form>}
        {message&&<p role="status" className="api-connection-message">{message}</p>}
      </div>
    </div>}
    {!collection&&message&&<p role="status" className="api-connection-message">{message}</p>}
    {!collection&&!busy&&<button type="button" className="secondary" onClick={load}>{en?'Reload connections':'重新读取连接'}</button>}
  </section>;
}
