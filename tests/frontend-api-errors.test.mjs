import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source=(await readFile(new URL('../frontend/src/api/client.ts',import.meta.url),'utf8')).replaceAll('import.meta.env','testEnv');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function apiFor(response) {
  const exports={};let calls=0;
  const dependencies={'./readJson':{readJson:()=>{}},'../utils/searchSort':{DEFAULT_ITEM_SORT:'updated_desc'},'../utils/quickCapture':{captureFormData:()=>new FormData()}};
  new Function('exports','require','fetch','testEnv',code)(exports,name=>{
    assert.ok(name in dependencies,`unexpected dependency ${name}`);return dependencies[name];
  },async (url,init)=>{calls++;assert.equal(url,'/api/generation-jobs/synthetic/result');assert.equal(init.method,'POST');return response;},{VITE_DEMO_MODE:'false',BASE_URL:'/'});
  return {api:exports.api,calls:()=>calls};
}
for(const [body,message] of [
  [JSON.stringify({detail:{code:'image_pixels_exceeded',message:'图片为 5000 × 4000，超过 1600 万像素。'}}),'图片为 5000 × 4000，超过 1600 万像素。'],
  [JSON.stringify({detail:'Legacy upload error'}),'Legacy upload error'],
  ['Plain server error','Plain server error'],
]) test(`actual Gallery upload API displays its response message: ${message}`,async()=>{
  const h=apiFor(new Response(body,{status:400}));
  await assert.rejects(h.api.uploadGenerationResult('synthetic',new File(['synthetic'],'fake.jpg')),error=>error.message===message);
  assert.equal(h.calls(),1);
});
