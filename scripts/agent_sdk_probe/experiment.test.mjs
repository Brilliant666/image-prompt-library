import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../..');
const virtualPython = resolve(source, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const python = process.env.AGENT_SDK_PROBE_PYTHON || (existsSync(virtualPython) ? virtualPython : process.platform === 'win32' ? 'python' : 'python3');
const output = await mkdtemp(join(tmpdir(), 'ipl-agent-sdk-probe-'));
console.log(`Probe artifacts: ${output}`);

// Discard credentials/tracing variables before importing the SDK. Installation also disables scripts.
for (const key of Object.keys(process.env)) {
  if (!['SYSTEMROOT','WINDIR','PATH','TEMP','TMP','PATHEXT','COMSPEC','NODE_TEST_CONTEXT'].includes(key.toUpperCase())) delete process.env[key];
}
process.env.DO_NOT_TRACK = '1';
process.env.REOVA_ANALYTICS = 'false';
process.env.LANGCHAIN_TRACING_V2 = 'false';
const blockedCalls = [];
const deny = (...args) => { blockedCalls.push(typeof args[0] === 'string' ? args[0] : 'network'); throw new Error('Experiment forbids network'); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
http.request = deny;
https.request = deny;

const { Run, FakeChatModel, Providers, GraphEvents, createContentAggregator, projectAgentContextUsage } = await import('@librechat/agents');
const { HumanMessage } = await import('@librechat/agents/langchain/messages');
const { DynamicStructuredTool } = await import('@librechat/agents/langchain/tools');
const { z } = await import('zod');

class Bridge {
  constructor() {
    this.pending = [];
    this.stderr = '';
    this.child = spawn(python, ['-B', resolve(here,'app_bridge.py'), source, output], {
      cwd: output, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true,
      stdio: ['pipe','pipe','pipe'],
    });
    this.child.stderr.on('data', value => { this.stderr += value; });
    createInterface({input:this.child.stdout}).on('line', line => {
      try { this.pending.shift()?.resolve(JSON.parse(line)); }
      catch (error) { this.pending.shift()?.reject(error); }
    });
    this.child.on('exit', code => {
      for (const promise of this.pending.splice(0)) promise.reject(new Error(`bridge exit ${code}: ${this.stderr}`));
    });
    this.child.on('error', error => {
      for (const promise of this.pending.splice(0)) promise.reject(error);
    });
  }
  request(value) { return new Promise((resolve,reject) => { this.pending.push({resolve,reject}); this.child.stdin.write(JSON.stringify(value)+'\n'); }); }
  async close() { if(this.child.exitCode!==null || !this.child.pid) return; this.child.stdin.end(); await new Promise(resolve => this.child.once('exit',resolve)); }
}

class InspectModel extends FakeChatModel {
  calls = [];
  async *_streamResponseChunks(messages, options, manager) {
    this.calls.push(messages.map(message => ({type:message.getType(), content:message.content, tool_call_id:message.tool_call_id})));
    yield* super._streamResponseChunks(messages,options,manager);
  }
}

test('real SDK image -> prompt -> real application image adapter/queue -> durable result', {timeout:45000}, async () => {
  const bridge = new Bridge();
  try {
    const initial = await bridge.request({action:'init'});
    assert.equal(initial.ok,true,JSON.stringify(initial));
    let adapterResult;
    let toolInvocations = 0;
    const prompt = `<ref id="${initial.value.referenceId}"/> An orange rectangle on a clean blue background, soft studio lighting; preserve the rectangular framing.`;
    const tool = new DynamicStructuredTool({
      name:'generate_image', description:'Generate using the existing authorized Image Prompt Library job queue.',
      schema:z.object({id:z.string(),prompt:z.string()}),
      func:async ({prompt}) => {
        toolInvocations++;
        adapterResult = await bridge.request({action:'execute',prompt});
        assert.equal(adapterResult.ok,true,JSON.stringify(adapterResult));
        return JSON.stringify({status:'done',jobId:adapterResult.value.jobs[0].id});
      },
    });
    const events=[];
    const aggregator=createContentAggregator();
    const customHandlers=Object.fromEntries([GraphEvents.ON_RUN_STEP,GraphEvents.ON_RUN_STEP_DELTA,GraphEvents.ON_RUN_STEP_COMPLETED,GraphEvents.ON_MESSAGE_DELTA].map(event=>[event,{handle:(event,data)=>{
      events.push({event,data}); aggregator.aggregateContent({event,data});
    }}]));
    const run=await Run.create({runId:'sdk-experiment',graphConfig:{type:'standard',llmConfig:{provider:Providers.OPENAI,model:'mock-vision',apiKey:'synthetic-key'},instructions:'Optimize the prompt, call generate_image once, then report the result.',tools:[tool],summarizationEnabled:false},customHandlers,returnContent:true,skipCleanup:true});
    const model=new InspectModel({responses:[`Optimized prompt: ${prompt}`,'The synthetic image is ready in the existing Gallery queue.'],toolCalls:[{id:'call-image-1',name:'generate_image',args:{id:'one',prompt}}]});
    run.Graph.overrideModel=model;
    const input=new HumanMessage({id:'user-round-1',content:[{type:'text',text:`Optimize this synthetic image; ${initial.value.referenceId} is the edit target.`},{type:'image_url',image_url:{url:initial.value.imageDataUri,detail:'high'}}]});
    const before=JSON.stringify(input);
    await run.processStream({messages:[input]},{configurable:{thread_id:'synthetic-thread'},streamMode:'values',version:'v2'});
    assert.equal(JSON.stringify(input),before,'canonical input mutated');
    assert.equal(toolInvocations,1);
    assert.equal(model.calls.length,2);
    assert.ok(model.calls[0].some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'&&part.image_url.url===initial.value.imageDataUri)));
    assert.ok(model.calls[1].some(message=>message.type==='tool'&&message.tool_call_id==='call-image-1'));
    assert.equal(adapterResult.value.jobs[0].status,'succeeded');
    assert.equal(adapterResult.value.jobs[0].exists,true);
    assert.equal(adapterResult.value.jobs[0].model,'gpt-image-2');
    assert.equal(adapterResult.value.currentModel,'changed-after-submit');
    assert.equal(adapterResult.value.posts.length,1);
    assert.equal(adapterResult.value.posts[0].path,'/v1/images/edits');
    const duplicate=await bridge.request({action:'execute',prompt});
    assert.equal(duplicate.ok,true);
    assert.equal(duplicate.value.jobs[0].id,adapterResult.value.jobs[0].id);
    assert.equal(duplicate.value.posts.length,1,'idempotent tool repeated provider POST');
    const finalText=JSON.stringify(aggregator.contentParts);
    assert.ok(finalText.includes('synthetic image is ready'),'SDK display aggregation lacks final answer');
    await bridge.request({action:'unknown'});
    const unknown=await bridge.request({action:'execute',callId:'new-call',prompt});
    assert.equal(unknown.ok,false);
    assert.equal(unknown.error,'interrupted');
    const unknownSnapshot=await bridge.request({action:'snapshot'});
    assert.equal(unknownSnapshot.value.request.canResume,false);
    assert.equal(unknownSnapshot.value.posts.length,1);
    await bridge.request({action:'stop'});
    const stopped=await bridge.request({action:'execute',requestId:'sdk-stop-request',callId:'after-stop',prompt});
    assert.equal(stopped.ok,false);
    assert.equal(stopped.error,'stopped');
    assert.equal(blockedCalls.length,0);
    const evidence={sdk:'@librechat/agents@4.1.1',node:process.version,sourceReference:'c56fc5eb7d141a25976c1886520ab4dac745ae07',scope:'module-level vertical; SDK fake model plus real product queue/provider persistence',modelCalls:model.calls.length,toolInvocations,imagePosts:adapterResult.value.posts,job:adapterResult.value.jobs[0],frozenModel:adapterResult.value.frozenModel,currentModel:adapterResult.value.currentModel,idempotency:'same call returns same job, no second POST',unknownReplay:'blocked by existing product request state; SDK alone not sufficient',stop:'new tool calls blocked by existing product stop flag; in-flight remote cancellation untested',canonicalInputUnchanged:true,assetId:initial.value.assetId,assetSha256:initial.value.assetSha256,events:events.map(x=>x.event),renderedContent:aggregator.contentParts,networkAttempts:blockedCalls};
    await writeFile(resolve(output,'result.json'),JSON.stringify(evidence,null,2));
    const savedImage=await readFile(adapterResult.value.jobs[0].resultPath);
    assert.equal(savedImage.subarray(1,4).toString(),'PNG');
    const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
    await writeFile(resolve(output,'result.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><title>SDK isolated vertical result</title><style>body{font:18px system-ui;background:#f4f5f7;color:#172029;max-width:900px;margin:48px auto;line-height:1.5}article{background:white;padding:28px;border-radius:12px}img{width:300px;image-rendering:pixelated;border:1px solid #ccc}pre{white-space:pre-wrap;font-size:14px}span{color:#16704a}</style><article><h1>Isolated SDK vertical result</h1><p><span>Saved image: succeeded</span> · ${escape(adapterResult.value.jobs[0].id)}</p><img alt="Synthetic orange rectangle saved by existing application provider" src="data:image/png;base64,${savedImage.toString('base64')}"><p>${escape(prompt)}</p><p>2 mock model calls · 1 Images edit POST intercepted in process · frozen model retained · duplicate tool call did not submit again.</p><details><summary>SDK display aggregation</summary><pre>${escape(JSON.stringify(aggregator.contentParts,null,2))}</pre></details><p>This development viewer reads the real isolated job result. It is a module-level experiment, not full LibreChat or product browser acceptance.</p></article></html>`);
  } finally { await bridge.close(); }
});

test('SDK AbortSignal stops before the image tool is dispatched', {timeout:20000}, async()=>{
  const controller=new AbortController();
  let toolsCalled=0;
  let deltas=0;
  const tool=new DynamicStructuredTool({name:'generate_image',description:'Synthetic guard tool',schema:z.object({prompt:z.string()}),func:async()=>{toolsCalled++;return 'unexpected';}});
  const run=await Run.create({runId:'sdk-abort-experiment',graphConfig:{type:'standard',llmConfig:{provider:Providers.OPENAI,model:'mock-vision',apiKey:'synthetic-key'},instructions:'Only use the authorized image tool.',tools:[tool],signal:controller.signal},customHandlers:{[GraphEvents.ON_MESSAGE_DELTA]:{handle:()=>{deltas++;controller.abort();}}},returnContent:true});
  const model=new InspectModel({responses:['Planning this image before dispatching the tool.'],sleep:2,toolCalls:[{id:'call-stop',name:'generate_image',args:{prompt:'Synthetic'}}]});
  run.Graph.overrideModel=model;
  let caught;
  try { await run.processStream({messages:[new HumanMessage({id:'stop-user',content:'Generate a synthetic rectangle.'})]},{signal:controller.signal,configurable:{thread_id:'stop-thread'},streamMode:'values',version:'v2'}); }
  catch(error){caught=error;}
  assert.ok(deltas>0);
  assert.equal(controller.signal.aborted,true);
  assert.equal(toolsCalled,0,'abort allowed an additional image tool call');
  assert.equal(blockedCalls.length,0);
  await writeFile(resolve(output,'abort-result.json'),JSON.stringify({aborted:true,deltas,modelCalls:model.calls.length,toolsCalled,error:caught?.message??null,externalNetworkAttempts:blockedCalls.length,scope:'Stops before tool dispatch; remote cancellation or charge reversal not asserted'},null,2));
});

test('upstream context projection keeps canonical content and unknown windows explicit', async()=>{
  const message=new HumanMessage({id:'projection-user',content:'Synthetic text only; this counter is a test double.'});
  const before=JSON.stringify(message);
  const agent={agentId:'projection-test',provider:Providers.OPENAI,instructions:'Stable core.'};
  const tokenCounter=message=>typeof message.content==='string'?message.content.length:0;
  assert.equal(await projectAgentContextUsage({agent,messages:[message],tokenCounter}),null);
  const usage=await projectAgentContextUsage({agent:{...agent,maxContextTokens:100000},messages:[message],tokenCounter});
  assert.equal(usage.breakdown.messageCount,1);
  assert.equal(usage.breakdown.maxContextTokens,100000);
  assert.equal(JSON.stringify(message),before);
});
