import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compiled = new Map();
async function utility(path) {
  const url = new URL(path, import.meta.url);
  if (compiled.has(url.href)) return compiled.get(url.href);
  const source = await readFile(url, 'utf8');
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const deps = {};
  for (const [,name] of code.matchAll(/require\("([^"]+)"\)/g)) deps[name] = await utility(new URL(name+'.ts',url).href);
  const module = {exports:{}};
  new Function('require','module','exports',code)(name=>{assert.ok(name in deps);return deps[name];},module,module.exports);
  compiled.set(url.href,module.exports);
  return module.exports;
}
const recipes = await utility('../frontend/src/utils/compatibleRecipe.ts');
const preferences = await utility('../frontend/src/utils/generationPreferences.ts');
const profiles = await utility('../frontend/src/utils/profileSettings.ts');
const bridge = await utility('../frontend/src/utils/agentGalleryBridge.ts');
const componentCode = ts.transpileModule(await readFile(new URL('../frontend/src/components/NativeImageParameters.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const jsx=(type,props)=>({type,props});
const dependencies={'react/jsx-runtime':{jsx,jsxs:jsx},'../utils/compatibleRecipe':recipes,'./NativeImageParameters.css':{}};
const component={exports:{}};
new Function('require','module','exports',componentCode)(name=>{assert.ok(name in dependencies);return dependencies[name];},component,component.exports);
const nodes=value=>!value||typeof value!=='object'?[]:[value,...[value.props?.children].flat(Infinity).flatMap(nodes)];
function view(protocol,model,params,disabled=false) {
  const changes=[];
  const tree=component.exports.default({protocol,model,params,disabled,onChange:value=>changes.push(value)});
  return {tree,changes,find:(type,label)=>nodes(tree).find(node=>node.type===type&&node.props['aria-label']===label)?.props};
}

for (const protocol of ['gemini_native','seedream_native']) test(`${protocol} restores exact recipe, ordered-independent parameters and protocol without credential fields`,()=>{
  const options=protocol==='gemini_native'?{aspect_ratio:'9:16',resolution:'2K'}:{watermark:false};
  const saved={...recipes.nativeRecipeDefaults(protocol,'manual-alias'),provider_options:options};
  const restored=recipes.restoreCompatibleRecipe({parameters:saved,metadata:{},model:'manual-alias'});
  assert.equal(recipes.nativeParameterIssue(restored),undefined);
  const sent=recipes.compatibleParameters(restored);
  assert.equal(sent.protocol,protocol); assert.deepEqual(sent.provider_options,options);
  assert.equal(sent.output_format,'auto'); assert.equal(sent.n,1);
  assert.equal(saved.model,'manual-alias');
  const memory=new Map(); const storage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};
  preferences.writeGenerationPreference(storage,'connection',{...saved,api_key:'must-not-persist',prompt:'private'});
  assert.deepEqual(preferences.readGenerationPreference(storage,'connection','',protocol).provider_options,options);
  assert.ok(![...memory.values()].join('').includes('must-not-persist'));
  assert.ok(![...memory.values()].join('').includes('private'));
  assert.equal(preferences.readGenerationPreference(storage,'connection').output_format,'png','legacy profile preferences are separate');
});

test('Seedream URL return remains explicit and cannot leak into legacy OpenAI transport',()=>{
  assert.deepEqual(recipes.pickCompatibleTransportOverrides({response_format:'url'}),{});
  assert.deepEqual(recipes.pickCompatibleTransportOverrides({protocol:'gemini_native',response_format:'url'}),{});
  assert.deepEqual(recipes.pickCompatibleTransportOverrides({protocol:'seedream_native',response_format:'url'}),{response_format:'url'});
  assert.throws(()=>recipes.compatibleParameters({...recipes.nativeRecipeDefaults('openai_compatible','alias'),response_format:'url'}));
  assert.equal(recipes.compatibleParameters({...recipes.nativeRecipeDefaults('seedream_native','alias'),response_format:'url'}).response_format,'url');
});

for (const [model,resolutions] of [
  ['gemini-2.5-flash-image',['auto']],
  ['models/gemini-3-pro-image',['auto','1K','2K','4K']],
  ['gemini-nano-banana-2.1',['auto','1K','2K','4K']],
  ['gemini-3.1-flash-lite-image',['auto','1K']],
  ['gemini-3.1-flash-image',['auto','512','1K','2K','4K']],
]) test(`actual native controls respect documented resolutions for ${model}`,()=>{
  const params=recipes.nativeRecipeDefaults('gemini_native',model);
  const h=view('gemini_native',model,params);
  const select=h.find('select','原生分辨率');
  assert.deepEqual(nodes({props:select}).filter(node=>node.type==='option').map(node=>node.props.value),resolutions);
  assert.equal(h.changes.length,0,'rendering does not change the recipe');
  select.onChange({target:{value:resolutions.at(-1)}});
  assert.deepEqual(h.changes,[{provider_options:{resolution:resolutions.at(-1)}}]);
});

test('switching to a known incompatible model preserves old values visibly and blocks submission',()=>{
  const recipe={...recipes.nativeRecipeDefaults('gemini_native','gemini-2.5-flash-image'),provider_options:{resolution:'4K'}};
  const h=view(recipe.protocol,recipe.model,recipe);
  assert.match(recipes.nativeParameterIssue(recipe),/分辨率|imageSize/);
  assert.throws(()=>recipes.compatibleParameters(recipe));
  const unsupported=nodes(h.tree).find(node=>node.type==='option'&&node.props.value==='4K');
  assert.equal(unsupported.props.disabled,true);
  assert.equal(h.changes.length,0);
});

test('native partial edits do not erase selected format or change image settings',()=>{
  const recipe={...recipes.nativeRecipeDefaults('seedream_native','doubao-seedream-5-0-pro-260628'),output_format:'png'};
  const h=view(recipe.protocol,recipe.model,recipe);
  h.find('select','AI 水印').onChange({target:{value:'false'}});
  assert.deepEqual(h.changes,[{provider_options:{watermark:false}}]);
  assert.equal(recipe.output_format,'png');
});

test('supported custom Seedream bounds and formats are not a generic OpenAI quality option',()=>{
  const base=recipes.nativeRecipeDefaults('seedream_native','doubao-seedream-5-0-pro-260628');
  assert.equal(recipes.nativeParameterIssue({...base,size:'2048x2048',output_format:'png'}),undefined);
  assert.match(recipes.nativeParameterIssue({...base,size:'4096x4096'}),/尺寸/);
  assert.match(recipes.nativeParameterIssue({...base,quality:'max'}),/质量/);
  assert.throws(()=>recipes.compatibleParameters({...base,provider_options:{arbitrary_header:'secret'}}));
});

test('native profile endpoint previews never duplicate known version suffixes',()=>{
  assert.equal(profiles.compatibleEndpointPreview('https://api.invalid/v1beta/','versioned','gemini_native','models/alias').generate,'https://api.invalid/v1beta/models/alias:generateContent');
  assert.equal(profiles.compatibleEndpointPreview('https://api.invalid/api/v3','versioned','seedream_native').generate,'https://api.invalid/api/v3/images/generations');
  assert.equal(profiles.compatibleEndpointPreview('https://api.invalid/custom','custom','seedream_native').generate,'https://api.invalid/custom/images/generations');
  assert.equal(profiles.compatibleEndpointPreview('https://user:secret@api.invalid','versioned','gemini_native'),undefined);
});

test('native Gallery/Agent sharing contains no prompt or reference transfer and retains protocol options',()=>{
  const draft={prompt:'Exact Gallery draft',inputs:[{id:'own'}],recipe:recipes.nativeRecipeDefaults('openai_compatible','old'),profileId:'old'};
  const shared={provider:'openai_compatible',protocol:'gemini_native',profileId:'gemini',model:'manual',params:{size:'auto',quality:'auto',background:'auto',output_format:'auto',provider_options:{aspect_ratio:'3:4'}}};
  const changed=bridge.applyGalleryImageSettings(draft,shared);
  assert.equal(changed.prompt,draft.prompt); assert.equal(changed.inputs,draft.inputs);
  assert.equal(changed.recipe.protocol,'gemini_native');
  assert.deepEqual(changed.recipe.provider_options,{aspect_ratio:'3:4'});
  assert.equal(draft.profileId,'old');
});

test('Muse controls emit only ratio choices and service defaults without changing the source recipe',()=>{
 const original={model:'muse-image',quality:'max',size:'2048x1536',background:'transparent',output_format:'png',moderation:'low'};
 const changes=[];const tree=component.exports.default({servicePreset:'muse',protocol:'openai_compatible',model:'muse-image',params:original,onChange:value=>changes.push(value)});
 const select=nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='Muse 画面比例');
 assert.deepEqual(nodes(tree).filter(node=>node.type==='option').map(node=>node.props.value),['auto','1:1','16:9','9:16','4:3','3:4']);
 assert.equal(select.props.value,'4:3');assert.equal(nodes(tree).filter(node=>node.type==='select').length,1);assert.equal(changes.length,0);
 select.props.onChange({target:{value:'9:16'}});assert.equal(changes[0].requested_aspect_ratio,'9:16');assert.equal(changes[0].size,'auto');assert.equal(changes[0].output_format,'auto');
 assert.equal(original.quality,'max');assert.equal(original.size,'2048x1536');assert.equal(original.background,'transparent');
});

test('Muse recipes preserve exact ratio, share it with Agent and isolate remembered generic parameters',()=>{
 const recipe={...recipes.museRecipeDefaults(),requested_aspect_ratio:'3:4'};
 const sent=recipes.compatibleParameters(recipe);assert.equal(sent.requested_aspect_ratio,'3:4');assert.equal(sent.output_format,'auto');assert.equal(sent.service_preset,'muse');
 const restored=recipes.restoreCompatibleRecipe({parameters:recipe,metadata:{},model:'muse-image'});assert.equal(restored.requested_aspect_ratio,'3:4');
 const memory=new Map(),storage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};
 preferences.writeGenerationPreference(storage,'same-profile',{model:'generic-image',size:'1024x1024',quality:'high',background:'auto',output_format:'png'});
 preferences.writeGenerationPreference(storage,'same-profile',recipe);
 assert.equal(preferences.readGenerationPreference(storage,'same-profile','muse-image','openai_compatible','muse').requested_aspect_ratio,'3:4');
 assert.equal(preferences.readGenerationPreference(storage,'same-profile').model,'generic-image');
 const old={prompt:'  Original\ntext  ',inputs:[{id:'reference'}],recipe:recipes.nativeRecipeDefaults('openai_compatible','old'),profileId:'old'};
 const shared=bridge.applyGalleryImageSettings(old,{provider:'openai_compatible',service_preset:'muse',profileId:'muse',model:'muse-image',params:sent});
 assert.equal(shared.recipe.requested_aspect_ratio,'3:4');assert.equal(shared.recipe.service_preset,'muse');assert.equal(shared.prompt,old.prompt);assert.equal(shared.inputs,old.inputs);
 assert.throws(()=>recipes.compatibleParameters({...recipe,model:'muse-video'}));assert.throws(()=>recipes.compatibleParameters({...recipe,model:'muse-spark'}));
});

test('unsupported historical Muse ratios remain visible and block submission instead of becoming auto',()=>{
 const saved={...recipes.museRecipeDefaults(),size:'1200x2400'};
 assert.equal(recipes.museAspectRatio(saved),'1:2');assert.throws(()=>recipes.compatibleParameters(saved));
 const tree=component.exports.default({servicePreset:'muse',protocol:'openai_compatible',model:'muse-image',params:saved,onChange(){throw Error('render changed recipe');}});
 assert.ok(nodes(tree).find(node=>node.props?.role==='alert'));
 assert.equal(nodes(tree).find(node=>node.type==='option'&&node.props.value==='1:2').props.disabled,true);
 assert.equal(saved.size,'1200x2400');
});
