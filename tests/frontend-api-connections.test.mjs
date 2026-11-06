import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const cache=new Map();
async function moduleAt(path){
 const url=new URL(path,import.meta.url); if(cache.has(url.href))return cache.get(url.href);
 const code=ts.transpileModule(await readFile(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const deps={};for(const [,name] of code.matchAll(/require\("([^"]+)"\)/g))deps[name]=await moduleAt(new URL(name+'.ts',url).href);
 const mod={exports:{}};new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},mod,mod.exports);cache.set(url.href,mod.exports);return mod.exports;
}
const settings=await moduleAt('../frontend/src/utils/connectionSettings.ts');
const profileSettings=await moduleAt('../frontend/src/utils/profileSettings.ts');
const preferences=await moduleAt('../frontend/src/utils/generationPreferences.ts');
const network=await moduleAt('../frontend/src/utils/apiNetwork.ts');
const component=ts.transpileModule(await readFile(new URL('../frontend/src/components/ApiConnectionsSettings.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const walk=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(walk)];
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):'';
const empty=()=>({models:[],fetched_at:null,checked_at:null,error:null});
const catalog={models:[{id:'chat',image_generation:false,text_generation:true,capability_source:'api'},{id:'picture',image_generation:true,text_generation:false,capability_source:'api'},{id:'mystery-image',image_generation:null,text_generation:null,capability_source:'unknown'}],fetched_at:'2026-01-01T00:00:00Z',checked_at:'2026-01-01T00:00:00Z',error:null};
const result=(extra={})=>({...catalog,source:'remote',connection_checked:true,generation_checked:false,error_code:null,...extra});
function harness(t,overrides={},initial={}){
 const profiles=initial.profiles||[{id:'a',display_name:'Connection A',base_url:'https://a.invalid/v1',model:'old-model',models:[],timeout:300,api_key_present:true,configured:true},{id:'b',display_name:'Connection B',base_url:'https://b.invalid/v1',model:'other-model',models:[],timeout:600,api_key_present:true,configured:true}];
 const store={profiles,default_profile_id:profiles[0]?.id||null};
 if(initial.catalog&&profiles[0])profiles[0].model_catalog=initial.catalog;
 const calls={list:0,cache:[],save:[],discover:[],copy:[],order:[],default:[],remove:[]},events=[],values=new Map();
 const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});
 t.after(()=>descriptor?Object.defineProperty(globalThis,'localStorage',descriptor):delete globalThis.localStorage);
 preferences.writeGenerationPreference(storage,'a',{model:'remembered',quality:'max',size:'2048x2048',background:'transparent',output_format:'png'});
 const apis={
  list:async()=>{calls.list++;return store;},
  catalog:async id=>{calls.cache.push(id);return profiles.find(p=>p.id===id)?.model_catalog||empty();},
  discover:async(payload,signal)=>{calls.discover.push({payload,signal});return result();},
  save:async(id,payload)=>{calls.save.push({id,payload});let p=profiles.find(x=>x.id===id);if(!p){p={id};profiles.push(p);}const {api_key,proxy_url,remove_proxy_url,...fields}=payload;Object.assign(p,fields,{api_key_present:Boolean(api_key||p.api_key_present),configured:true},remove_proxy_url?{proxy_url_present:false,proxy_endpoint:''}:proxy_url?{proxy_url_present:true,proxy_endpoint:network.safeProxyEndpoint(proxy_url)}:{});return store;},
  setDefault:async id=>{calls.default.push(id);store.default_profile_id=id;return store;},remove:async id=>{calls.remove.push(id);store.profiles=store.profiles.filter(p=>p.id!==id);return store;},...overrides,
 };
 if(overrides.discover){apis.discover=(payload,signal)=>{calls.discover.push({payload,signal});return overrides.discover(payload,signal);};}
 const slots=[],effects=[];let cursor=0,changed=false,tree,mounted=true,late=0;
 const hooks={
  useState(value){const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return [slots[i],next=>{if(!mounted){late++;return;}slots[i]=typeof next==='function'?next(slots[i]):next;changed=true;}];},
  useRef(value){const i=cursor++;if(!(i in slots))slots[i]={current:value};return slots[i];},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i].deps[j])){const previous=slots[i];slots[i]={deps,effect:fn};effects.push(()=>{previous?.cleanup?.();slots[i].cleanup=fn();});}},
 };
 const jsx=(type,props)=>{
  if(props.ref&&initial.connectionList){
   if(props.className==='api-connection-list')props.ref.current=initial.connectionList;
   if(props.className==='api-connection-row')props.ref.current={getBoundingClientRect:()=>initial.rowBounds(text(props.children))};
  }
  return {type,props};
 };
 const deps={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,k)=>k}),
 '../api/client':{apiConnections:apis},'../api/profileActions':{copyApiProfile:async(...args)=>{calls.copy.push(args);return store;},reorderApiProfiles:async ids=>{calls.order.push(ids);return store;}},
 '../utils/profileSettings':profileSettings,'../utils/connectionSettings':settings,'../utils/generationPreferences':preferences,'../utils/apiNetwork':network,
 './ApiNetworkSettings':{__esModule:true,default:'ApiNetworkSettings'},'./ApiConnectionsSettings.css':{},
 };
 const mod={exports:{}};new Function('require','module','exports','window',component)(name=>{assert.ok(name in deps,name);return deps[name];},mod,mod.exports,{dispatchEvent:event=>events.push(event)});
 function render(){cursor=0;changed=false;tree=mod.exports.default({onSaved:async()=>{},uiLanguage:initial.language||'zh_hans',onSetDefaultConnection:()=>calls.default.push('global')});effects.splice(0).forEach(fn=>fn());}
 async function flush(){for(let i=0;i<35;i++){if(changed)render();await Promise.resolve();}if(changed)render();}
 const unmount=()=>{mounted=false;slots.forEach(s=>s?.cleanup?.());};t.after(unmount);render();
 const find=(type,predicate=()=>true)=>walk(tree).find(n=>n.type===type&&predicate(n.props))?.props;
 const button=name=>find('button',p=>p['aria-label']===name||text({props:p})===name);
 const input=name=>find('input',p=>p['aria-label']===name);
 return {flush,find,button,input,calls,events,values,storage,store,unmount,replayEffects:()=>{const active=slots.filter(slot=>slot?.effect);active.forEach(slot=>slot.cleanup?.());active.forEach(slot=>{slot.cleanup=slot.effect();});},get late(){return late;},get tree(){return tree;},get text(){return text(tree);}, async click(name){const value=button(name);assert.ok(value,'Missing button '+name);assert.ok(!value.disabled,'Disabled '+name);value.onClick();await flush();},async fill(name,value){const field=input(name);assert.ok(field,'Missing input '+name);field.onChange({target:{value}});await flush();},async submit(){find('form').onSubmit({preventDefault(){}});await flush();}};
}
const ids=h=>walk(h.tree).filter(n=>n.type==='button'&&n.props['data-catalog-model']).map(n=>n.props['data-catalog-model']);
const selectProfile=async(h,id)=>{h.find('button',p=>p.className?.includes('api-connection-option')&&text({props:p}).includes(id)).onClick();await h.flush();};
async function startNew(h,preset='gemini'){
 await h.click('添加连接');assert.equal(h.find('form'),undefined);
 h.find('button',p=>p['data-preset']===preset).onClick();await h.flush();
}

test('opening legacy profiles performs only local reads, shows usage and does not invent a protocol selector',async t=>{
 const h=harness(t);await h.flush();assert.equal(h.input('API Key').value,'');assert.equal(h.find('ApiNetworkSettings').mode,'direct');
 assert.equal(h.find('select',p=>p['aria-label']==='接口协议'),undefined);assert.equal(h.button('放弃修改'),undefined);
 assert.ok(h.text.includes('文字 + 图片'));assert.deepEqual(h.calls.discover,[]);assert.deepEqual(h.calls.save,[]);
});
test('new connection chooses a type once, then shows fields with the chosen protocol',async t=>{
 const h=harness(t);await h.flush();await startNew(h);assert.equal(h.input('Base URL').value,'https://generativelanguage.googleapis.com/v1beta');
 assert.equal(h.find('button',p=>p['data-preset']==='gemini'),undefined);assert.ok(h.text.includes('文字使用独立 Responses 连接'));
 assert.equal(h.find('select',p=>p['aria-label']==='接口协议'),undefined);assert.equal(h.button('识别模型').disabled,true);
});
test('saving a new connection reveals its clipped row in the saved list',async t=>{
 const connectionList={scrollTop:0,getBoundingClientRect:()=>({top:0,bottom:390})};
 const rowBounds=label=>label.startsWith('Official OpenAI')
  ?{top:335-connectionList.scrollTop,bottom:415-connectionList.scrollTop}
  :{top:0,bottom:80};
 const h=harness(t,{}, {connectionList,rowBounds});
 await h.flush();await startNew(h,'openai');
 await h.fill('连接名称','Official OpenAI');await h.submit();
 assert.equal(h.calls.save.length,1);
 assert.equal(h.input('连接名称').value,'Official OpenAI');
 assert.equal(connectionList.scrollTop,25);
});
test('deletion confirmation stays in the action bar and deletes only on confirmation',async t=>{
 const h=harness(t);await h.flush();
 await h.click('删除连接');
 const bar=h.find('div',props=>props.className==='api-save-bar');
 assert.ok(walk({props:bar}).some(node=>node.props?.['aria-label']==='确认删除连接'));
 assert.deepEqual(h.calls.remove,[]);
 await h.click('取消');assert.equal(h.button('确认删除'),undefined);
 await h.click('删除连接');await h.click('确认删除');
 assert.deepEqual(h.calls.remove,['a']);
 assert.equal(h.input('连接名称').value,'Connection B');
});
test('custom services can explicitly select any native protocol without a second selector',async t=>{
 const h=harness(t);await h.flush();await startNew(h,'custom');assert.equal(h.find('form'),undefined);
 h.find('button',p=>p['data-protocol']==='seedream_native').onClick();await h.flush();assert.ok(h.text.includes('Seedream 图片 API'));
 assert.equal(h.input('Base URL').value,'');assert.equal(h.find('select',p=>p['aria-label']==='接口协议'),undefined);
});
test('changing type does not erase a filled address, key or model until explicit confirmation',async t=>{
 const h=harness(t);await h.flush();await startNew(h);await h.fill('API Key','draft-key');await h.fill('Base URL','https://relay.invalid/native');await h.fill('默认图片模型','manual-alias');
 await h.click('更换');h.find('button',p=>p['data-preset']==='seedream').onClick();await h.flush();
 assert.ok(h.find('div',p=>p.role==='alertdialog'));await h.click('取消');
 assert.equal(h.input('API Key').value,'draft-key');assert.equal(h.input('Base URL').value,'https://relay.invalid/native');assert.equal(h.input('默认图片模型').value,'manual-alias');
 await h.click('更换');h.find('button',p=>p['data-preset']==='seedream').onClick();await h.flush();await h.click('确认更换');
 assert.equal(h.input('API Key').value,'');assert.equal(h.input('默认图片模型').value,'');assert.equal(h.input('连接名称').value,'Google Gemini');assert.equal(h.input('Base URL').value,'https://ark.cn-beijing.volces.com/api/v3');
 assert.equal(h.calls.save.length,0);
});
test('unsaved model discovery sends only a transient draft, preserves fields and never saves or generates',async t=>{
 const h=harness(t);await h.flush();await startNew(h);await h.fill('API Key','draft-key');await h.click('识别模型');
 assert.equal(h.calls.discover.length,1);const sent=h.calls.discover[0].payload;
 assert.equal(sent.protocol,'gemini_native');assert.equal(sent.api_key,'draft-key');assert.equal(sent.profile_id,undefined);
 assert.equal(h.calls.save.length,0);assert.equal(h.input('API Key').value,'draft-key');assert.deepEqual(ids(h),['chat','picture','mystery-image']);
 assert.ok(!JSON.stringify([...h.values]).includes('draft-key'));assert.ok(h.text.includes('未测试生成'));
});
test('save after draft discovery keeps results and selected defaults without repeating the network check',async t=>{
 const h=harness(t);await h.flush();await startNew(h);await h.fill('API Key','draft-key');await h.click('识别模型');
 h.find('button',p=>p['data-catalog-model']==='picture').onClick();await h.flush();await h.submit();
 assert.equal(h.calls.save.length,1);assert.equal(h.calls.discover.length,1);assert.equal(h.calls.save[0].payload.model,'picture');
 assert.deepEqual(h.calls.save[0].payload.models,['picture']);assert.equal(h.input('API Key').value,'');assert.deepEqual(ids(h),['chat','picture','mystery-image']);
 assert.equal('model_catalog' in h.calls.save[0].payload,false);assert.ok(h.text.includes('已保存'));
});
test('saving without discovery does not implicitly contact a provider',async t=>{
 const h=harness(t);await h.flush();await h.fill('连接名称','Renamed');await h.submit();assert.equal(h.calls.save.length,1);assert.equal(h.calls.discover.length,0);assert.equal(h.calls.save[0].payload.api_key,undefined);
});
test('saved key is never implicitly reused for a changed URL/protocol',async t=>{
 const h=harness(t);await h.flush();await h.fill('Base URL','https://changed.invalid');assert.equal(h.button('识别模型').disabled,true);await h.submit();assert.equal(h.calls.save.length,0);assert.ok(h.text.includes('新连接的 Key'));
 await h.fill('API Key','new-key');await h.submit();assert.equal(h.calls.save.length,1);assert.equal(h.calls.save[0].payload.api_key,'new-key');
});
test('model metadata distinguishes output from vision input or an unknown name; text selection never changes the image default',async t=>{
 const h=harness(t,{}, {catalog});await h.flush();assert.deepEqual(ids(h),['chat','picture','mystery-image']);
 h.find('button',p=>p['data-catalog-model']==='chat').onClick();await h.flush();assert.equal(h.input('默认图片模型').value,'old-model');assert.ok(h.text.includes('Agent 文字设置'));
 await h.submit();assert.deepEqual(h.calls.save[0].payload.models,['chat']);assert.equal(h.calls.save[0].payload.model,'old-model');
 await h.click('文字');assert.deepEqual(ids(h),['chat']);await h.click('待确认');assert.deepEqual(ids(h),['mystery-image']);
});
test('static reference discovery never displays a passed connection test',async t=>{
 const h=harness(t,{discover:async()=>result({source:'reference',connection_checked:false,checked_at:null,fetched_at:null})});await h.flush();await startNew(h,'seedream');await h.click('识别模型');
 assert.ok(h.text.includes('文档参考 · 未验证权限'));assert.ok(!h.text.includes('已读取接口清单'));
});
for(const field of ['Base URL','API Key'])test(`late discovery cannot overwrite a newer ${field} draft`,async t=>{
 let finish;const h=harness(t,{discover:()=>new Promise(resolve=>finish=resolve)});await h.flush();await h.click('识别模型');
 await h.fill(field,field==='Base URL'?'https://changed.invalid':'new-secret');finish(result());await h.flush();assert.deepEqual(ids(h),[]);assert.ok(!h.text.includes('已读取接口清单'));
});
test('network and protocol edits invalidate in-flight results, not only the selected profile ID',async t=>{
 let finish;const h=harness(t,{discover:()=>new Promise(resolve=>finish=resolve)});await h.flush();await h.click('识别模型');h.find('ApiNetworkSettings').onModeChange('environment');await h.flush();finish(result());await h.flush();assert.deepEqual(ids(h),[]);
});
test('changing model or name during discovery preserves user choices when the list returns',async t=>{
 let finish;const h=harness(t,{discover:()=>new Promise(resolve=>finish=resolve)});await h.flush();await h.click('识别模型');await h.fill('默认图片模型','custom-default');await h.fill('连接名称','New name');finish(result());await h.flush();
 assert.equal(h.input('默认图片模型').value,'custom-default');assert.equal(h.input('连接名称').value,'New name');assert.equal(h.calls.save.length,0);assert.equal(ids(h).length,3);
});
for(const action of ['close','switch','discard'])test(`stale discovery is ignored after ${action}, including close/unmount`,async t=>{
 let finish;const h=harness(t,{discover:()=>new Promise(resolve=>finish=resolve)});await h.flush();await h.click('识别模型');
 if(action==='close')h.unmount();else if(action==='switch')await selectProfile(h,'Connection B');else{await h.fill('连接名称','changed');await h.click('放弃修改');}
 finish(result());await h.flush();assert.equal(h.late,0);assert.deepEqual(ids(h),[]);
});
test('rapid discovery clicks share a single in-flight request and never create a saved profile',async t=>{
 let finish,count=0;const h=harness(t,{discover:()=>{count++;return new Promise(resolve=>finish=resolve);}});await h.flush();const click=h.button('识别模型').onClick;click();click();await h.flush();assert.equal(count,1);finish(result());await h.flush();assert.equal(h.calls.save.length,0);
});
test('discovery denial is sanitized, keeps the key/draft and still permits a manual model',async t=>{
 const h=harness(t,{discover:async()=>{throw {code:'permission',message:'private-upstream-secret'};}});await h.flush();await startNew(h);await h.fill('API Key','typed-key');await h.click('识别模型');assert.equal(h.input('API Key').value,'typed-key');assert.ok(!h.text.includes('private-upstream-secret'));
 await h.fill('默认图片模型','manual');await h.submit();assert.equal(h.calls.save[0].payload.model,'manual');
});
test('network proxy remains write-only, persists independently, and explicit removal is distinct from blank',async t=>{
 const h=harness(t);await h.flush();h.find('ApiNetworkSettings').onModeChange('proxy');h.find('ApiNetworkSettings').onProxyUrlChange('http://u:proxy-secret@proxy.invalid:8080');await h.flush();await h.submit();
 assert.equal(h.calls.save[0].payload.proxy_url,'http://u:proxy-secret@proxy.invalid:8080');assert.equal(h.find('ApiNetworkSettings').proxyUrl,'');assert.equal(h.find('ApiNetworkSettings').proxyEndpoint,'http://proxy.invalid:8080');
 await h.fill('默认图片模型','another');await h.submit();assert.equal('proxy_url' in h.calls.save[1].payload,false);assert.equal('remove_proxy_url' in h.calls.save[1].payload,false);
 h.find('ApiNetworkSettings').onRemoveProxyChange(true);h.find('ApiNetworkSettings').onModeChange('direct');await h.flush();await h.submit();assert.equal(h.calls.save[2].payload.remove_proxy_url,true);assert.ok(!JSON.stringify([...h.values]).includes('proxy-secret'));
});
test('invalid proxy blocks both saving and draft discovery without echoing rejected values',async t=>{
 const h=harness(t);await h.flush();h.find('ApiNetworkSettings').onModeChange('proxy');h.find('ApiNetworkSettings').onProxyUrlChange('ftp://u:secret-value@invalid');await h.flush();await h.submit();await h.click('识别模型');assert.equal(h.calls.save.length,0);assert.equal(h.calls.discover.length,0);assert.ok(!h.text.includes('secret-value'));
});
test('save errors never display server secrets and do not retry automatically',async t=>{
 let count=0;const h=harness(t,{save:async()=>{count++;throw Error('private-value');}});await h.flush();await h.fill('API Key','typed-key');await h.submit();assert.equal(count,1);assert.equal(h.input('API Key').value,'');assert.ok(!h.text.includes('private-value'));assert.ok(h.text.includes('无法确认'));
});
test('confirmed default-model saves update only that browser recipe after success',async t=>{
 let finish;const h=harness(t,{save:(id,payload)=>new Promise(resolve=>finish=()=>resolve({default_profile_id:id,profiles:[{...payload,id,api_key_present:true,configured:true}]}))});await h.flush();const before=preferences.readGenerationPreference(h.storage,'a');await h.fill('默认图片模型','new-default');await h.submit();assert.deepEqual(preferences.readGenerationPreference(h.storage,'a'),before);finish();await h.flush();assert.deepEqual(preferences.readGenerationPreference(h.storage,'a'),{...before,model:'new-default'});assert.equal(h.events.filter(e=>e.type==='ipl:profile-model-saved').length,1);
});
for(const outcome of ['failed','closed'])test(`${outcome} save does not announce a new image default`,async t=>{
 let finish;const h=harness(t,{save:()=>outcome==='failed'?Promise.reject(Error('private')):new Promise(resolve=>finish=resolve)});await h.flush();await h.fill('默认图片模型','new-model');await h.submit();if(outcome==='closed'){h.unmount();finish({profiles:[],default_profile_id:null});await h.flush();}assert.equal(preferences.readGenerationPreference(h.storage,'a').model,'remembered');assert.equal(h.events.filter(e=>e.type==='ipl:profile-model-saved').length,0);assert.equal(h.late,0);
});
test('default connection changes only after a confirmed successful action, never merely by viewing',async t=>{
 const h=harness(t);await h.flush();await selectProfile(h,'Connection B');assert.deepEqual(h.calls.default,[]);await h.click('设为默认连接');assert.deepEqual(h.calls.default,['b','global']);assert.equal(h.calls.discover.length,0);
});

test('expired Muse discovery asks for a new check and preserves the edited form',async t=>{
 const h=harness(t,{save:async()=>{throw Error('Run model discovery again for the changed connection, or choose the Muse adapter manually.');}});
 await h.flush();await h.fill('连接名称','Edited connection');await h.fill('默认图片模型','muse-image');await h.submit();
 assert.ok(h.text.includes('请重新识别模型，或手动选择 Muse 适配后再保存。'));
 assert.equal(h.input('连接名称').value,'Edited connection');assert.equal(h.input('默认图片模型').value,'muse-image');
 assert.equal(h.calls.discover.length,0);assert.equal(h.events.length,0);
 assert.ok(!h.text.includes('已保存，未发送生成请求'));
});
test('uncertain default change cannot switch the global selection',async t=>{
 const h=harness(t,{setDefault:async()=>{throw Error('private');}});await h.flush();await h.click('设为默认连接');assert.deepEqual(h.calls.default,['global'],'current existing default needs no provider mutation');await selectProfile(h,'Connection B');await h.click('设为默认连接');assert.deepEqual(h.calls.default,['global']);assert.ok(!h.text.includes('private'));
});
test('duplicate and order actions keep identity-only contracts',async t=>{
 const h=harness(t);await h.flush();await h.click('复制连接');assert.equal(h.calls.copy.length,1);assert.equal(h.calls.copy[0][0],'a');assert.equal(h.calls.copy[0].length,3);await h.click('下移 Connection A');assert.deepEqual(h.calls.order,[['b','a']]);
});
test('browser parameter reset requires explicit confirmation and leaves all other recipes intact',async t=>{
 const h=harness(t);await h.flush();await h.click('重置本浏览器参数');assert.equal(preferences.readGenerationPreference(h.storage,'a').model,'remembered');await h.click('取消');assert.equal(h.button('确认重置'),undefined);await h.click('重置本浏览器参数');await h.click('确认重置');assert.equal(preferences.readGenerationPreference(h.storage,'a','old-model').model,'old-model');assert.equal(h.calls.save.length,0);assert.equal(h.events[0].type,'ipl:generation-preference-reset');
});
test('all protocol endpoint labels are generated from the selected type, including English',async t=>{
 const h=harness(t,{}, {language:'en',profiles:[{id:'native',display_name:'Native',base_url:'https://api.invalid/v1beta',protocol:'gemini_native',model:'image',models:[],timeout:300,api_key_present:true,configured:true}]});await h.flush();assert.ok(h.text.includes('/v1beta'));assert.ok(!h.text.includes('Standard /v1 (existing behavior)'));assert.ok(h.text.includes('separate Responses'));
});

test('initial load failure has a visible safe error and a working reload action',async t=>{
 let reads=0;const h=harness(t,{list:async()=>{reads++;if(reads===1)throw Error('private-server-payload');return {profiles:[],default_profile_id:null};}});await h.flush();
 assert.ok(h.text.includes('无法读取连接'));assert.ok(!h.text.includes('private-server-payload'));await h.click('重新读取连接');assert.equal(reads,2);assert.ok(h.text.includes('选择要连接的服务'));
});
test('failed legacy catalog reads expose no raw cached error and retain manual editing',async t=>{
 const h=harness(t,{}, {catalog:{...catalog,error:'private-cached-upstream-key'}});await h.flush();assert.ok(h.text.includes('清单暂不可核验'));assert.ok(!h.text.includes('private-cached-upstream-key'));await h.fill('默认图片模型','manual');assert.equal(h.calls.discover.length,0);
});
test('late local cache responses cannot overwrite newer selection, draft discovery or unmount',async t=>{
 const pending=[];const h=harness(t,{catalog:id=>new Promise(resolve=>pending.push({id,resolve}))});await h.flush();await selectProfile(h,'Connection B');await selectProfile(h,'Connection A');
 assert.deepEqual(pending.map(p=>p.id),['a','b','a']);pending[2].resolve({...catalog,models:[{id:'fresh',image_generation:true}]});await h.flush();
 pending[0].resolve({...catalog,models:[{id:'stale-a',image_generation:true}]});pending[1].resolve({...catalog,models:[{id:'stale-b',image_generation:true}]});await h.flush();assert.deepEqual(ids(h),['fresh']);
 await h.click('识别模型');assert.deepEqual(ids(h),['chat','picture','mystery-image']);await selectProfile(h,'Connection B');h.unmount();pending[3].resolve(catalog);await h.flush();assert.equal(h.late,0);
});
test('transport settings stay per connection and preserve partial-preview preference when streaming is disabled',async t=>{
 const h=harness(t);await h.flush();assert.equal(h.find('select',p=>p['aria-label']==='中间预览图数量').disabled,true);
 h.find('input',p=>p['aria-label']==='流式传输').onChange({target:{checked:true}});await h.flush();
 h.find('select',p=>p['aria-label']==='中间预览图数量').onChange({target:{value:'3'}});
 h.find('input',p=>p['aria-label']==='返回 Base64 图片数据').onChange({target:{checked:true}});await h.flush();await h.submit();
 assert.equal(h.calls.save[0].payload.stream,true);assert.equal(h.calls.save[0].payload.partial_images,3);assert.equal(h.calls.save[0].payload.response_format,'b64_json');assert.equal(h.calls.save[0].payload.api_key,undefined);
 h.find('input',p=>p['aria-label']==='流式传输').onChange({target:{checked:false}});await h.flush();await h.submit();assert.equal(h.calls.save[1].payload.partial_images,3);assert.equal(h.calls.save[1].payload.stream,false);assert.equal(h.calls.discover.length,0);
 await selectProfile(h,'Connection B');assert.equal(h.find('input',p=>p['aria-label']==='流式传输').checked,false);
});
test('invalid saved addresses and model IDs are rejected without clearing the unsent draft',async t=>{
 const h=harness(t);await h.flush();await h.fill('Base URL','https://user:private@api.invalid');await h.fill('API Key','new-key');await h.submit();assert.equal(h.calls.save.length,0);assert.ok(h.text.includes('Base URL'));assert.equal(h.input('API Key').value,'new-key');
 await h.fill('Base URL','https://a.invalid/v1');h.find('textarea').onChange({target:{value:'x'.repeat(201)}});await h.flush();await h.submit();assert.equal(h.calls.save.length,0);assert.ok(h.text.includes('100'));
});

test('effect cleanup and replay can reload without a stuck mutation lock or an older response winning',async t=>{
 const pending=[];const h=harness(t,{list:()=>new Promise(resolve=>pending.push(resolve))});await h.flush();assert.equal(pending.length,1);h.replayEffects();await h.flush();assert.equal(pending.length,2);
 pending[0]({profiles:[{id:'old',display_name:'Old response',base_url:'https://old.invalid',timeout:300,api_key_present:false,configured:false,model:''}],default_profile_id:'old'});await h.flush();assert.equal(h.input('连接名称'),undefined);
 pending[1]({profiles:[],default_profile_id:null});await h.flush();assert.ok(h.text.includes('选择要连接的服务'));assert.ok(!h.text.includes('Old response'));assert.equal(h.button('添加连接').disabled,false);
});


test('a positive text claim with unknown image support never overwrites the image default',async t=>{
 const textModel={id:'text-declared-image-unknown',text_generation:true,image_generation:null,capability_source:'api'};
 const h=harness(t,{}, {catalog:{...catalog,models:[textModel]}});await h.flush();
 const action=h.find('button',p=>p['data-catalog-model']===textModel.id);
 action.onClick();await h.flush();
 assert.equal(h.input('默认图片模型').value,'old-model');
 assert.ok(text({props:action}).includes('添加'),'the visible action should describe adding a text model');
 await h.submit();assert.equal(h.calls.save[0].payload.model,'old-model');
 assert.deepEqual(h.calls.save[0].payload.models,[textModel.id]);
 assert.equal(preferences.readGenerationPreference(h.storage,'a').model,'remembered');
 assert.equal(h.events.filter(e=>e.type==='ipl:profile-model-saved').length,0);
});

test('explicit multimodal output and fully unknown aliases remain selectable image defaults',async t=>{
 const both={id:'declared-both',text_generation:true,image_generation:true,capability_source:'api'};
 const unknown={id:'manual-unknown',text_generation:null,image_generation:null,capability_source:'unknown'};
 const h=harness(t,{}, {catalog:{...catalog,models:[both,unknown]}});await h.flush();
 for(const entry of [both,unknown]){
  h.find('button',p=>p['data-catalog-model']===entry.id).onClick();await h.flush();
  assert.equal(h.input('默认图片模型').value,entry.id);
 }
 assert.equal(h.calls.discover.length,0);
});

test('a failed second discovery retains the list without presenting the previous success as current',async t=>{
 let attempts=0;const h=harness(t,{discover:async()=>{attempts++;if(attempts===1)return result();throw Error('private-server-error');}});
 await h.flush();await h.click('识别模型');assert.ok(h.text.includes('已读取接口清单'));
 await h.click('识别模型');assert.deepEqual(ids(h),['chat','picture','mystery-image']);
 assert.ok(!h.text.includes('已读取接口清单'),'the rejected check must invalidate its success label');
 assert.ok(h.text.includes('无法连接'));assert.ok(!h.text.includes('private-server-error'));
 assert.equal(h.calls.save.length,0);assert.equal(h.input('默认图片模型').value,'old-model');
});

test('Muse preset keeps the service URL explicit and offers only supported image transport',async t=>{
 const h=harness(t);await h.flush();await startNew(h,'muse');
 assert.equal(h.input('Base URL').value,'');assert.equal(h.input('默认图片模型').value,'muse-image');
 assert.equal(h.input('流式传输'),undefined);assert.equal(h.find('select',p=>p['aria-label']==='中间预览图数量'),undefined);
 assert.ok(h.input('返回 Base64 图片数据'));assert.ok(h.text.includes('暂不支持视频'));
 await h.fill('Base URL','https://muse.invalid/v1');await h.fill('API Key','synthetic-key');await h.click('识别模型');
 assert.equal(h.calls.discover[0].payload.protocol,'openai_compatible');assert.equal(h.calls.discover[0].payload.service_preset,'muse');
 await h.submit();assert.equal(h.calls.save[0].payload.service_preset,'muse');assert.equal(h.calls.save[0].payload.service_preset_mode,'manual');assert.equal(h.calls.save[0].payload.model,'muse-image');
 assert.equal(h.calls.save[0].payload.stream,false);assert.equal(h.calls.save[0].payload.partial_images,0);assert.equal(h.calls.discover.length,1);
});

test('existing Muse adaptation requires confirmation and preserves same-target saved credentials',async t=>{
 const h=harness(t);await h.flush();await h.fill('API Key','unsaved-key');await h.click('手动 Muse');
 assert.ok(h.find('div',p=>p['aria-label']==='确认服务适配'));await h.click('取消适配');
 assert.equal(h.input('API Key').value,'unsaved-key');assert.ok(h.input('流式传输'));
 await h.click('手动 Muse');await h.click('确认适配');
 assert.equal(h.input('API Key').value,'unsaved-key');assert.equal(h.input('Base URL').value,'https://a.invalid/v1');assert.equal(h.input('连接名称').value,'Connection A');
 assert.equal(h.input('流式传输'),undefined);assert.equal(h.calls.save.length,0);assert.equal(h.calls.discover.length,0);
 await h.fill('API Key','');await h.submit();assert.equal(h.calls.save[0].payload.service_preset,'muse');assert.equal(h.calls.save[0].payload.api_key,undefined);
});

test('Muse capability rows distinguish video from available image output and do not select text as the image default',async t=>{
 const models=[{id:'muse-image',image_generation:true,text_generation:false,capability_source:'documentation'},{id:'muse-spark',image_generation:false,text_generation:true,capability_source:'documentation'},{id:'muse-video',image_generation:false,text_generation:false,capability_source:'documentation'}];
 const h=harness(t,{discover:async()=>result({models})},{profiles:[{id:'muse',display_name:'Muse',base_url:'https://muse.invalid/v1',model:'muse-image',models:[],timeout:300,service_preset:'muse',api_key_present:true,configured:true}]});await h.flush();await h.click('识别模型');
 assert.ok(h.text.includes('视频 · 本项目暂不支持'));h.find('button',p=>p['data-catalog-model']==='muse-spark').onClick();await h.flush();
 assert.equal(h.input('默认图片模型').value,'muse-image');assert.ok(h.text.includes('不能作为 Agent 工具主控'));
 assert.equal(h.find('button',p=>p['data-catalog-model']==='muse-video').disabled,true);assert.equal(h.calls.save.length,0);
});

const museDiscovery=()=>result({models:[
 {id:'muse-image',owned_by:'muse',image_generation:true,text_generation:false,capability_source:'documentation'},
 {id:'muse-spark',owned_by:'muse',image_generation:false,text_generation:true,capability_source:'documentation'},
 {id:'muse-video',owned_by:'muse',image_generation:false,text_generation:false,capability_source:'documentation'},
],detected_service_preset:'muse'});

test('connection brands retain OpenAI, Gemini, Seedream, Muse and custom order',async t=>{
 const h=harness(t);await h.flush();await h.click('添加连接');
 assert.deepEqual(walk(h.tree).filter(n=>n.type==='button'&&n.props['data-preset']).map(n=>n.props['data-preset']),['openai','gemini','seedream','muse','custom']);
});

test('automatic adaptation is the default advanced control and missing legacy mode is not an unsaved change',async t=>{
 const h=harness(t);await h.flush();assert.equal(h.button('添加连接').disabled,false);assert.equal(h.button('放弃修改'),undefined);
 const advanced=h.find('details',p=>p.className==='api-connection-advanced');assert.ok(advanced);
 assert.ok(walk({props:advanced}).some(n=>n.props?.['aria-label']==='服务适配'));
 assert.equal(h.button('自动识别（默认）')['aria-pressed'],true);assert.equal(h.calls.discover.length,0);assert.equal(h.calls.save.length,0);
});

test('verified model discovery applies Muse only to the current draft without changing user fields or saving',async t=>{
 const h=harness(t,{discover:async()=>museDiscovery()});await h.flush();await h.fill('API Key','draft-secret');await h.fill('默认图片模型','user-selected-model');
 h.input('流式传输').onChange({target:{checked:true}});await h.flush();await h.click('识别模型');
 assert.equal(h.calls.discover.length,1);assert.equal(h.calls.discover[0].payload.service_preset_mode,'auto');assert.equal(h.calls.discover[0].payload.service_preset,'generic');
 assert.ok(h.text.includes('已自动识别 Muse'));assert.equal(h.input('流式传输'),undefined);assert.equal(h.input('API Key').value,'draft-secret');
 assert.equal(h.input('默认图片模型').value,'user-selected-model');assert.equal(h.input('连接名称').value,'Connection A');assert.equal(h.input('Base URL').value,'https://a.invalid/v1');
 assert.equal(h.calls.save.length,0);assert.equal(h.calls.cache.length,1);await h.submit();
 assert.equal(h.calls.save.length,1);assert.equal(h.calls.save[0].payload.service_preset,'muse');assert.equal(h.calls.save[0].payload.service_preset_mode,'auto');
 assert.equal(h.calls.save[0].payload.stream,false);assert.equal(h.calls.save[0].payload.partial_images,0);assert.equal(h.calls.discover.length,1);
 assert.ok(h.text.includes('已自动识别 Muse'));assert.ok(!h.text.includes('保存连接后生效'));
});

test('automatic detection preserves newer name and model edits made while discovery is pending',async t=>{
 let complete;const h=harness(t,{discover:()=>new Promise(resolve=>complete=resolve)});await h.flush();h.button('识别模型').onClick();await h.flush();
 await h.fill('连接名称','Name edited during discovery');await h.fill('默认图片模型','new-model');complete(museDiscovery());await h.flush();
 assert.equal(h.input('连接名称').value,'Name edited during discovery');assert.equal(h.input('默认图片模型').value,'new-model');assert.ok(h.text.includes('已自动识别 Muse'));assert.equal(h.calls.save.length,0);
});

test('manual standard override invalidates an older automatic result and is never replaced by a detection marker',async t=>{
 let complete;const h=harness(t,{discover:()=>new Promise(resolve=>complete=resolve)});await h.flush();h.button('识别模型').onClick();await h.flush();
 const request=h.calls.discover[0];await h.click('标准 OpenAI 兼容');await h.click('确认适配');assert.equal(request.signal.aborted,true);
 complete(museDiscovery());await h.flush();assert.ok(!h.text.includes('已自动识别 Muse'));assert.ok(h.input('流式传输'));assert.equal(h.button('标准 OpenAI 兼容')['aria-pressed'],true);
 h.button('识别模型').onClick();await h.flush();complete(museDiscovery());await h.flush();
 assert.equal(h.calls.discover[1].payload.service_preset_mode,'manual');assert.equal(h.calls.discover[1].payload.service_preset,'generic');assert.ok(h.input('流式传输'));assert.ok(!h.text.includes('已自动识别 Muse'));
 assert.equal(h.calls.save.length,0);
});

test('returning to automatic mode keeps current effective adaptation and only the next discovery can confirm it',async t=>{
 const saved={id:'muse',display_name:'Muse',base_url:'https://muse.invalid/v1',model:'muse-image',models:[],timeout:300,service_preset:'muse',service_preset_mode:'manual',api_key_present:true,configured:true};
 const h=harness(t,{discover:async()=>result()},{profiles:[saved]});await h.flush();await h.click('自动识别（默认）');await h.click('确认适配');
 assert.equal(h.input('流式传输'),undefined);assert.equal(h.button('自动识别（默认）')['aria-pressed'],true);assert.equal(h.calls.discover.length,0);assert.ok(!h.text.includes('已自动识别 Muse'));
 await h.click('识别模型');assert.equal(h.input('流式传输'),undefined);assert.ok(!h.text.includes('已自动识别 Muse'));await h.submit();
 assert.equal(h.calls.save[0].payload.service_preset,'muse');assert.equal(h.calls.save[0].payload.service_preset_mode,'auto');
});

test('key prefix is only a local hint, and models without a server detection marker do not choose Muse',async t=>{
 const h=harness(t,{discover:async()=>{const value=museDiscovery();delete value.detected_service_preset;return value;}});await h.flush();await h.fill('API Key','m2a_synthetic');
 assert.ok(h.text.includes('疑似 Muse'));assert.ok(h.input('流式传输'));assert.equal(h.calls.discover.length,0);assert.equal(h.calls.save.length,0);
 await h.click('识别模型');assert.ok(h.input('流式传输'));assert.ok(!h.text.includes('已自动识别 Muse'));assert.equal(h.calls.save.length,0);
});

test('failed rediscovery clears automatic success notice while retaining effective Muse adaptation and user input',async t=>{
 let attempt=0;const h=harness(t,{discover:async()=>{if(++attempt===1)return museDiscovery();throw Error('private failure');}});await h.flush();await h.click('识别模型');assert.ok(h.text.includes('已自动识别 Muse'));
 await h.click('识别模型');assert.ok(!h.text.includes('已自动识别 Muse'));assert.ok(h.text.includes('无法连接'));assert.equal(h.input('流式传输'),undefined);assert.equal(h.input('默认图片模型').value,'old-model');assert.equal(h.calls.save.length,0);
});

for(const field of ['Base URL','API Key'])for(const outcome of ['ordinary','failure'])test(`auto-detected Muse is invalidated by ${field} changes before ${outcome} discovery and cannot contaminate a saved target`,async t=>{
 let attempt=0;const h=harness(t,{discover:async()=>{if(++attempt===1)return museDiscovery();if(outcome==='failure')throw Error('synthetic connection failure');return result();}});
 await h.flush();await h.fill('API Key','first-synthetic-key');await h.click('识别模型');assert.ok(h.text.includes('已自动识别 Muse'));await h.submit();
 assert.equal(h.calls.save[0].payload.service_preset,'muse');assert.equal(h.calls.save[0].payload.service_preset_mode,'auto');
 const originalModel=h.input('默认图片模型').value;await h.fill(field,field==='Base URL'?'https://ordinary.invalid/v1':'changed-synthetic-key');
 if(field==='Base URL')await h.fill('API Key','ordinary-key');
 assert.ok(h.input('流式传输'),'new target uses generic transport until Muse is verified again');assert.ok(!h.text.includes('已自动识别 Muse'));assert.ok(h.text.includes('连接信息已更改'));
 assert.equal(h.input('默认图片模型').value,originalModel);assert.equal(h.calls.discover.length,1,'editing connection details adds no request');
 await h.click('识别模型');await h.submit();assert.equal(h.calls.discover.length,2);assert.equal(h.calls.save.length,2);
 assert.equal(h.calls.discover[1].payload.service_preset,'generic');assert.equal(h.calls.save[1].payload.service_preset,'generic');assert.equal(h.calls.save[1].payload.service_preset_mode,'auto');
 assert.equal(h.calls.save[1].payload.model,originalModel);
});

for(const field of ['Base URL','API Key'])test(`manual Muse survives ${field} edits without automatic demotion`,async t=>{
 const saved={id:'muse',display_name:'Muse',base_url:'https://muse.invalid/v1',model:'muse-image',models:[],timeout:300,service_preset:'muse',service_preset_mode:'manual',api_key_present:true,configured:true};
 const h=harness(t,{}, {profiles:[saved]});await h.flush();await h.fill(field,field==='Base URL'?'https://manual-muse.invalid/v1':'manual-synthetic-key');if(field==='Base URL')await h.fill('API Key','manual-target-key');
 assert.equal(h.input('流式传输'),undefined);assert.equal(h.button('手动 Muse')['aria-pressed'],true);assert.ok(!h.text.includes('连接信息已更改'));await h.submit();
 assert.equal(h.calls.save[0].payload.service_preset,'muse');assert.equal(h.calls.save[0].payload.service_preset_mode,'manual');assert.equal(h.calls.discover.length,0);
});

test('unrelated name/model edits preserve an auto Muse identity while URL mode and network/proxy changes invalidate it',async t=>{
 const saved={id:'muse',display_name:'Muse',base_url:'https://muse.invalid/v1',model:'muse-image',models:[],timeout:300,base_url_mode:'versioned',network_mode:'direct',service_preset:'muse',service_preset_mode:'auto',api_key_present:true,configured:true};
 const h=harness(t,{}, {profiles:[saved]});await h.flush();await h.fill('连接名称','Renamed Muse');await h.fill('默认图片模型','muse-image');
 assert.equal(h.input('流式传输'),undefined);await h.submit();assert.equal(h.calls.save[0].payload.service_preset,'muse');
 h.find('select',p=>p['aria-label']==='地址拼接方式').onChange({target:{value:'custom'}});await h.flush();assert.ok(h.input('流式传输'));assert.equal(h.calls.discover.length,0);
});

for(const change of ['network','proxy','removeProxy'])test(`auto Muse evidence is invalidated by ${change} settings without a network request`,async t=>{
 const saved={id:'muse',display_name:'Muse',base_url:'https://muse.invalid/v1',model:'muse-image',models:[],timeout:300,network_mode:'direct',service_preset:'muse',service_preset_mode:'auto',api_key_present:true,configured:true,proxy_url_present:true,proxy_endpoint:'http://proxy.invalid:8080'};
 const h=harness(t,{}, {profiles:[saved]});await h.flush();const controls=h.find('ApiNetworkSettings');
 if(change==='network')controls.onModeChange('environment');else if(change==='proxy')controls.onProxyUrlChange('http://new-proxy.invalid:8080');else controls.onRemoveProxyChange(true);
 await h.flush();assert.ok(h.input('流式传输'));assert.ok(h.text.includes('连接信息已更改'));assert.equal(h.calls.discover.length,0);await h.submit();
 assert.equal(h.calls.save[0].payload.service_preset,'generic');assert.equal(h.calls.save[0].payload.service_preset_mode,'auto');
});
