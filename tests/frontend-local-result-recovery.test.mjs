import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const recoverySource = await readFile(new URL('../frontend/src/components/LocalResultRecovery.tsx', import.meta.url), 'utf8');
const utilitySource = await readFile(new URL('../frontend/src/utils/localResultRecovery.ts', import.meta.url), 'utf8');
function evaluate(source, dependencies = {}, globals = {}) {
  const result = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), compile(source))(
    name => { assert.ok(name in dependencies, name); return dependencies[name]; }, result, result.exports, ...Object.values(globals));
  return result.exports;
}
const utility = evaluate(utilitySource);
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise,resolve,reject}; };
const job = () => ({id:'paid-original',status:'failed',prompt_text:'  Exact\n\nPrompt\t ',parameters:{input_images:[{result_path:'generation-references/reference.png'}]},
  metadata:{local_result_recovery:{state:'pending',message:'图片已取得，本地保存记录待恢复。',can_recover:true}}});
function harness(t, response, initial = job()) {
  const slots=[],effects=[],calls=[],restored=[]; let cursor=0,dirty=false,tree,unmounted=false,late=0;
  const jsx=(type,props)=>({type,props});
  const hooks={
    useState(value){const i=cursor++;if(!(i in slots))slots[i]=typeof value==='function'?value():value;return[slots[i],next=>{if(unmounted)late++;slots[i]=typeof next==='function'?next(slots[i]):next;dirty=true;}];},
    useRef(value){const i=cursor++;return slots[i]||=( {current:value});},
    useEffect(effect,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n]))){slots[i]={deps};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});}},
  };
  const Component=evaluate(recoverySource,{react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx},'../utils/localResultRecovery':utility,
    '../api/client':{api:{recoverGenerationJob:id=>{calls.push(['local',id]);return response(id);},retryGenerationJob:()=>{throw Error('No paid retry');},createGenerationJob:()=>{throw Error('No image POST');}}}}).default;
  const props={job:initial,onRecovered:value=>restored.push(value)};
  function render(){cursor=0;dirty=false;tree=Component(props);effects.splice(0).forEach(fn=>fn());}
  async function flush(){for(let i=0;i<16;i++){await Promise.resolve();if(dirty&&!unmounted)render();}}
  function unmount(){unmounted=true;slots.forEach(slot=>slot?.cleanup?.());}
  render();t.after(()=>{if(!unmounted)unmount();});
  return {calls,restored,flush,unmount,get late(){return late;},update(value){Object.assign(props,value);render();},button:()=>nodes(tree).find(n=>n.type==='button')?.props,
    alert:()=>nodes(tree).find(n=>n.props?.role==='alert')?.props.children};
}

test('production recovery callback rejects double-click and returns the same job without changing Prompt or references',async t=>{
  const pending=deferred(),original=job(),before=structuredClone(original),h=harness(t,()=>pending.promise,original);
  const button=h.button();button.onClick();button.onClick();await h.flush();assert.deepEqual(h.calls,[['local','paid-original']]);
  assert.equal(h.button().disabled,true);
  const restored={...before,status:'succeeded',result_path:'generation-results/paid-original/final.png',metadata:{}};
  pending.resolve(restored);await h.flush();assert.deepEqual(h.restored,[restored]);assert.deepEqual(original,before);assert.equal(h.alert(),undefined);
});
test('a lost recovery response only retries local registration on the original job, never paid generation',async t=>{
  let attempts=0;const restored={...job(),status:'succeeded',metadata:{}};
  const h=harness(t,async()=>{if(++attempts===1)throw Error('Response lost; check original result');return restored;});
  h.button().onClick();await h.flush();assert.match(h.alert(),/Response lost/);assert.deepEqual(h.restored,[]);
  h.button().onClick();await h.flush();assert.deepEqual(h.calls,[['local','paid-original'],['local','paid-original']]);assert.deepEqual(h.restored,[restored]);
});
test('blocked evidence is explained and cannot fall through to any request',async t=>{
  const original=job();original.metadata.local_result_recovery={state:'blocked',message:'本地结果需要核对，不会重新生成。',can_recover:false};
  const h=harness(t,()=>{throw Error('No call is allowed');},original);assert.equal(h.button().disabled,true);h.button().onClick();await h.flush();assert.deepEqual(h.calls,[]);
});
test('late local receipts do not change another task or an unmounted component',async t=>{
  for(const mode of ['switch','unmount']){const pending=deferred(),h=harness(t,()=>pending.promise);h.button().onClick();await h.flush();
    if(mode==='switch')h.update({job:{...job(),id:'new-task'}});else h.unmount();
    pending.resolve({...job(),status:'succeeded'});await h.flush();assert.deepEqual(h.restored,[]);assert.equal(h.late,0);}
});
test('the actual API adapter uses only the original-job recovery endpoint, while Demo refuses the mutation',async()=>{
  const source=await readFile(new URL('../frontend/src/api/client.ts',import.meta.url),'utf8');
  const calls=[],fetch=async(url,init)=>{calls.push({url,init});return{ok:true,json:async()=>({id:'job/id',status:'succeeded'})};};
  const deps={'./readJson':{readJson:()=>{throw Error('No history fetch');}},'../utils/searchSort':{DEFAULT_ITEM_SORT:'updated_desc'},'../utils/quickCapture':{}};
  const live=evaluate(source.replaceAll('import.meta.env','({VITE_DEMO_MODE:"false",BASE_URL:"/"})'),deps,{fetch,FormData,URLSearchParams});
  await live.api.recoverGenerationJob('job/id');assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/generation-jobs/job%2Fid/recover-result');assert.equal(calls[0].init.method,'POST');
  const demo=evaluate(source.replaceAll('import.meta.env','({VITE_DEMO_MODE:"true",BASE_URL:"/"})'),deps,{fetch,FormData,URLSearchParams});
  await assert.rejects(()=>demo.api.recoverGenerationJob('job/id'));assert.equal(calls.length,1);
});

test('legacy Library generation callbacks cannot turn pending local evidence into either paid retry path', async()=>{
  const source = await readFile(new URL('../frontend/src/components/GenerationPanel.tsx',import.meta.url),'utf8');
  const parsed=ts.createSourceFile('GenerationPanel.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const callbacks=new Map();
  const walk=node=>{if(ts.isVariableDeclaration(node)&&['retryFailedJob','discardAndRetryJob'].includes(node.name.getText(parsed)))callbacks.set(node.name.getText(parsed),node.initializer.getText(parsed));ts.forEachChild(node,walk);};walk(parsed);
  let paid=0;const messages=[];
  for(const name of ['retryFailedJob','discardAndRetryJob']){
    const action=evaluate(`export const action = ${callbacks.get(name)};`,{}, {setMessage:value=>messages.push(value),api:{retryGenerationJob:()=>paid++,discardAndRetryGenerationJob:()=>paid++}}).action;
    await action(job());
  }
  assert.equal(paid,0);assert.equal(messages.length,2);assert.ok(messages.every(value=>value.includes('恢复本地结果')));
});

test('the actual Agent adapter recovers the original request without calling resume or round submission',async()=>{
  const source=await readFile(new URL('../frontend/src/api/agentClient.ts',import.meta.url),'utf8');
  const calls=[];const client=evaluate(source,{'./agentProgress':{}},{fetch:async(url,init)=>{calls.push({url,init});return{ok:true,json:async()=>({request:{id:'original/request'}})};}});
  await client.agentApi.recoverResults('original/request');assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/agent/requests/original%2Frequest/recover-results');assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.body,undefined);
});
