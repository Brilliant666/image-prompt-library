import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { IDBFactory } from 'fake-indexeddb';

const modules=new Map();
async function load(relative) {
  const url=new URL(relative,import.meta.url);
  if(modules.has(url.href))return modules.get(url.href);
  const code=ts.transpileModule(await readFile(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const dependencies=new Map();
  for(const match of code.matchAll(/require\("([^"]+)"\)/g))dependencies.set(match[1],await load(new URL(`${match[1]}.ts`,url).href));
  const module={exports:{}};new Function('require','module','exports',code)(name=>dependencies.get(name),module,module.exports);
  modules.set(url.href,module.exports);return module.exports;
}
const sizes=await load('../frontend/src/utils/gallerySize.ts');
const compatible=await load('../frontend/src/utils/compatibleRecipe.ts');
const preferences=await load('../frontend/src/utils/generationPreferences.ts');
const gallery=await load('../frontend/src/utils/galleryRecipe.ts');
const drafts=await load('../frontend/src/utils/galleryDraft.ts');
const base={model:'gpt-image-2.5-flare',quality:'auto',size:'auto',background:'auto',output_format:'png'};

test('all 24 tier presets respect exact pixel bounds and custom ratios stay within one percent',()=>{
  for(const tier of sizes.SIZE_TIERS)for(const ratio of [...sizes.SIZE_RATIOS,'5:4','2.39:1','1:3','3:1']){
    const result=sizes.calculateImageSize(tier,ratio);assert.ok(result,`${tier} ${ratio}`);
    const [w,h]=result.split('x');assert.equal(sizes.customSizeError(w,h,base.model),undefined);
    assert.ok(Math.abs(Number(w)/Number(h)/sizes.parseSizeRatio(ratio).ratio-1)<=.01);
    assert.ok(Number(w)*Number(h)<=({'1K':1572864,'2K':4194304,'4K':8294400})[tier]);
  }
  assert.equal(sizes.calculateImageSize('4K','2:3'),'2304x3456');
  assert.equal(sizes.calculateImageSize('4K','3:4'),'2400x3200');
  for(const ratio of ['0:1','4:1','1:4','nope','-2:3','Infinity:1'])assert.equal(sizes.calculateImageSize('4K',ratio),undefined);
});

test('explicit pixels are validated without silently changing them or selecting a nearby preset',()=>{
  assert.equal(sizes.findSizePreset('2000x3008'),undefined);
  assert.equal(sizes.customSizeError('2000','3008',base.model),undefined);
  for(const [w,h] of [['2001','3008'],['4000','2000'],['100','100'],['3840','3840'],['2048','512'],['1e3','1024'],['1024.5','1024']])assert.ok(sizes.customSizeError(w,h,base.model));
  for(const size of ['512','4096'])assert.equal(sizes.customSizeError(size,size,'custom-provider-model'),undefined);
  for(const size of ['0','1.5','9007199254740992'])assert.ok(sizes.customSizeError(size,'1024','custom-provider-model'));
  assert.equal(compatible.compatibleParameters({...base,size:'2000x3008'}).size,'2000x3008');
});

test('moderation preserves omitted defaults, explicit selections, profile preferences, and metadata precedence',()=>{
  assert.equal(Object.hasOwn(compatible.compatibleParameters(base),'moderation'),false);
  const values=new Map(),store={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  for(const moderation of ['auto','low']){
    const recipe={...base,moderation,background:'opaque',output_format:'webp',output_compression:0,size:'2000x3008'};
    preferences.writeGenerationPreference(store,'profile',recipe);
    const restored=preferences.readGenerationPreference(store,'profile');
    assert.deepEqual(compatible.compatibleParameters(restored),compatible.compatibleParameters(recipe));
    const job={provider:'openai_compatible',prompt_text:'  original\n',parameters:{...recipe,moderation:'auto'},metadata:{requested:{moderation}},model:recipe.model};
    const payload=gallery.galleryPayload(gallery.draftFromJob(job,[]),4);
    assert.equal(payload.parameters.moderation,moderation);
    assert.equal(payload.parameters.background,'opaque');assert.equal(payload.parameters.output_compression,0);assert.equal(payload.parameters.size,'2000x3008');
  }
  assert.throws(()=>compatible.compatibleParameters({...base,moderation:'off'}),/auto 或 low/);
  assert.throws(()=>compatible.compatibleParameters({...base,background:'transparent',output_format:'jpeg'}),/imageTransparencyConflict/);
  assert.equal(compatible.compatibleParameters({...base,background:'auto',output_format:'jpeg'}).background,'auto');
});

test('optional composer draft preserves explicit moderation and never invents it for an old draft',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'indexedDB',previous);else delete globalThis.indexedDB;});
  const draft={...gallery.emptyGalleryDraft(),prompt:'original',recipe:{...base,moderation:'low',background:'opaque',output_format:'webp',output_compression:0}};
  await drafts.saveGalleryDraft(draft);assert.deepEqual((await drafts.readGalleryDraft()).recipe,draft.recipe);
  await drafts.saveGalleryDraft({...draft,recipe:base});assert.equal((await drafts.readGalleryDraft()).recipe.moderation,undefined);
});

const dialogJs=ts.transpileModule(await readFile(new URL('../frontend/src/components/gallery/SizeDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const children=node=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(children)];
function harness(t,props={}){
  const slots=[],effects=[],applied=[];let cursor=0,dirty=false,tree,closed=0;
  const root={inert:Boolean(props.initialInert)},body={style:{overflow:'auto'}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{body,getElementById:id=>id==='root'?root:null}});
  const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;dirty=true;}];},useEffect(effect,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){effects.push(()=>{old?.cleanup?.();slots[i].cleanup=effect();});slots[i]={deps};}}};
  const jsx=(type,props)=>({type,props});const deps={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'react-dom':{createPortal:node=>node},'lucide-react':{X:'X'},'../../hooks/useModalFocus':{useModalFocus:close=>({containerRef:{},handleModalKeyDown:event=>{if(event.key==='Escape')close();}})},'../../utils/compatibleRecipe':compatible,'../../utils/gallerySize':sizes,'./SizeDialog.css':{}};
  const module={exports:{}};new Function('require','module','exports',dialogJs)(name=>{assert.ok(name in deps,name);return deps[name];},module,module.exports);
  const actual={recipe:base,prompt:'',onApply:value=>applied.push(value),onClose:()=>closed++,...props};
  const render=()=>{dirty=false;cursor=0;tree=module.exports.default(actual);effects.splice(0).forEach(fn=>fn());};
  const flush=()=>{if(dirty)render();};const dispose=()=>slots.forEach(slot=>slot?.cleanup?.());
  render();t.after(()=>{dispose();if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const find=(type,label)=>{const node=children(tree).find(node=>node.type===type&&(node.props['aria-label']===label||node.props.children===label||children(node).some(child=>child.type==='b'&&child.props.children===label)));assert.ok(node,`${type} ${label}`);return node.props;};
  return{find,flush,applied,root,body,dispose,update:value=>{Object.assign(actual,value);render();},get tree(){return tree;},get closed(){return closed;}};
}

test('actual size dialog preserves custom history exactly, cancel changes nothing, and background inert restores',t=>{
  const h=harness(t,{recipe:{...base,size:'2000x3008'}});
  assert.equal(h.find('input','尺寸宽度').value,'2000');assert.equal(h.find('input','尺寸高度').value,'3008');
  assert.equal(h.root.inert,true);assert.equal(h.body.style.overflow,'hidden');
  h.find('button','取消').onClick();assert.equal(h.closed,1);assert.equal(h.applied.length,0);
  h.find('button','确定').onClick();assert.deepEqual(h.applied,[{size:'2000x3008',size_mode:undefined}]);
  h.dispose();assert.equal(h.root.inert,false);assert.equal(h.body.style.overflow,'auto');
});

test('actual dialog applies source 4K ratio pixels only after confirmation and supports custom ratios',t=>{
  const h=harness(t);h.find('button','按比例').onClick();h.flush();h.find('button','4K').onClick();h.find('button','比例 2:3').onClick();h.flush();
  assert.equal(h.applied.length,0);assert.ok(children(h.tree).some(node=>node.type==='strong'&&node.props.children==='2304 × 3456'));
  h.find('button','确定').onClick();assert.equal(h.applied[0].size,'2304x3456');
  h.find('button','自定义比例').onClick();h.flush();h.find('input','自定义比例').onChange({target:{value:'2.39:1'}});h.flush();
  h.find('button','确定').onClick();assert.equal(h.applied[1].size,sizes.calculateImageSize('4K','2.39:1'));
});

test('actual custom width/height reject invalid input without normalization and auto4k keeps prompt priority',t=>{
  const h=harness(t,{prompt:'宽高比 9:16',referenceSize:{width:400,height:300}});
  h.find('button','自定义宽高').onClick();h.flush();h.find('input','尺寸宽度').onChange({target:{value:'2001'}});h.flush();
  assert.equal(h.find('button','确定').disabled,true);h.find('button','确定').onClick();assert.equal(h.applied.length,0);assert.equal(h.find('input','尺寸宽度').value,'2001');
  h.find('button','自动').onClick();h.flush();h.find('button','4K 目标 · 自动比例').onClick();h.flush();
  assert.ok(children(h.tree).some(node=>node.type==='strong'&&node.props.children==='2160 × 3840'));
  h.find('button','确定').onClick();assert.equal(h.applied[0].size_mode,'auto4k');
  const payload=gallery.galleryPayload({...gallery.emptyGalleryDraft(),prompt:'宽高比 9:16',recipe:{...base,...h.applied[0]}},4,{width:400,height:300});
  assert.equal(payload.parameters.size,'2160x3840');
});

test('actual dialog retains prior inert state and closes through keyboard without applying',t=>{
  const h=harness(t,{initialInert:true});children(h.tree).find(node=>node.props?.role==='dialog').props.onKeyDown({key:'Escape'});
  assert.equal(h.closed,1);assert.equal(h.applied.length,0);h.dispose();assert.equal(h.root.inert,true);
});

for(const size of ['512x512','4096x4096'])test(`actual custom-provider history ${size} remains valid and is submitted verbatim`,t=>{
  const h=harness(t,{recipe:{...base,model:'custom-provider-model',size}});
  assert.equal(h.find('button','确定').disabled,false);h.find('button','确定').onClick();
  assert.equal(h.applied[0].size,size);
  assert.equal(compatible.compatibleParameters({...base,model:'custom-provider-model',...h.applied[0]}).size,size);
});

test('actual auto4k preview waits for reference decoding and reports failure instead of a square',t=>{
  const h=harness(t,{recipe:{...base,size_mode:'auto4k'},referenceStatus:'loading'});
  assert.equal(h.find('button','确定').disabled,true);
  assert.ok(children(h.tree).some(node=>node.type==='strong'&&node.props.children==='读取首张参考图比例…'));
  assert.equal(children(h.tree).some(node=>node.type==='strong'&&node.props.children==='2880 × 2880'),false);
  h.find('button','确定').onClick();assert.equal(h.applied.length,0);
  h.update({referenceStatus:'error'});assert.equal(h.find('button','确定').disabled,true);
  assert.ok(children(h.tree).some(node=>node.props?.role==='alert'&&node.props.children.includes('无法读取')));
  h.update({referenceStatus:'ready',referenceSize:{width:1600,height:900}});
  assert.equal(h.find('button','确定').disabled,false);
  assert.ok(children(h.tree).some(node=>node.type==='strong'&&node.props.children==='3840 × 2160'));
  h.find('button','确定').onClick();assert.equal(h.applied[0].size_mode,'auto4k');
});

test('explicit prompt ratio remains authoritative while reference decoding is pending',t=>{
  const h=harness(t,{recipe:{...base,size_mode:'auto4k'},prompt:'宽高比 9:16',referenceStatus:'loading'});
  assert.equal(h.find('button','确定').disabled,false);
  assert.ok(children(h.tree).some(node=>node.type==='strong'&&node.props.children==='2160 × 3840'));
});
