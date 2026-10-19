import { emptyGalleryDraft, type GalleryDraft } from './galleryRecipe';
import { readGenerationPreference } from './generationPreferences';
// One optional composer buffer, never a task/image database. Opening it never submits.
const DATABASE = 'image-prompt-library-workspace-draft';
export function validateGalleryDraft(value: unknown): GalleryDraft | undefined {
  if(!value||typeof value!=='object')return;
  const draft=value as Partial<GalleryDraft>;
  if(typeof draft.prompt!=='string'||draft.prompt.length>200000||!Array.isArray(draft.inputs)||draft.inputs.length>16||!['openai_compatible','openai_codex_oauth_native','xai_grok_oauth'].includes(draft.provider||''))return;
  const fallback=emptyGalleryDraft();
  const recipe=readGenerationPreference({getItem:()=>JSON.stringify(draft.recipe),setItem:()=>undefined},'',draft.recipe?.model||'');
  const templateValues=draft.templateValues&&typeof draft.templateValues==='object'?Object.fromEntries(Object.entries(draft.templateValues).filter(([key,value])=>key.length<=200&&typeof value==='string'&&value.length<=200000)):undefined;
  const inputs:GalleryDraft['inputs']=[];
  for(const input of draft.inputs){
    if(!input||typeof input.id!=='string'||typeof input.name!=='string'||!['uploaded','generated_result','library'].includes(input.source))return;
    const dataUrl=typeof input.dataUrl==='string'&&/^data:image\/(png|jpeg|webp|gif);base64,/i.test(input.dataUrl)&&input.dataUrl.length<42*1024*1024?input.dataUrl:undefined;
    const resultPath=typeof input.resultPath==='string'&&/^generation-(references|results)\/[\w./-]+$/.test(input.resultPath)&&!input.resultPath.includes('..')?input.resultPath:undefined;
    const previewUrl=dataUrl||(resultPath?`/media/${resultPath}`:'');
    inputs.push({id:input.id,name:input.name,source:input.source,dataUrl,resultPath,previewUrl,imageId:typeof input.imageId==='string'?input.imageId:undefined,sourceItemId:typeof input.sourceItemId==='string'?input.sourceItemId:undefined,role:typeof input.role==='string'?input.role:undefined,missing:Boolean(input.missing||!dataUrl&&!resultPath&&!input.imageId)});
  }
  return {...fallback,prompt:draft.prompt,provider:draft.provider!,profileId:typeof draft.profileId==='string'?draft.profileId:'',sourceItemId:typeof draft.sourceItemId==='string'?draft.sourceItemId:undefined,aspectRatio:typeof draft.aspectRatio==='string'&&/^(auto|[1-9]\d*:[1-9]\d*)$/.test(draft.aspectRatio)?draft.aspectRatio:'auto',aspectInjection:typeof draft.aspectInjection==='boolean'?draft.aspectInjection:undefined,resolution:draft.resolution==='2k'?'2k':'1k',promptLanguage:['en','zh_hans','zh_hant'].includes(draft.promptLanguage||'')?draft.promptLanguage:undefined,templateValues,recipe,inputs};
}
function openDraft(): Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{ const request=indexedDB.open(DATABASE,1); request.onupgradeneeded=()=>request.result.createObjectStore('draft'); request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error); });
}
export async function readGalleryDraft(): Promise<GalleryDraft | undefined> {
  const db=await openDraft();
  return new Promise((resolve,reject)=>{const tx=db.transaction('draft');const request=tx.objectStore('draft').get('current');request.onsuccess=()=>resolve(validateGalleryDraft(request.result));tx.oncomplete=()=>db.close();tx.onerror=()=>{db.close();reject(tx.error);};});
}
export async function saveGalleryDraft(value?: GalleryDraft): Promise<void> {
  const db=await openDraft();
  return new Promise((resolve,reject)=>{const tx=db.transaction('draft','readwrite');const store=tx.objectStore('draft');const safe=validateGalleryDraft(value);if(safe) store.put(safe,'current');else store.delete('current');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});
}
