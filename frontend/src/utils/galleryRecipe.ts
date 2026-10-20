import type { GenerationJobCreate, GenerationJobRecord, ItemDetail } from '../types';
import { clearCompatibleTransportOverrides, compatibleParameters, resolveAuto4k, restoreCompatibleRecipe, type CompatibleRecipe } from './compatibleRecipe';
import { recipeProfileId } from './compatibleProfiles';
import type { RecipeInput } from './recipeInputs';
import { extractPromptTemplateVariableRecords, resolvePromptTemplate } from './promptTemplateVariables';

export interface GalleryDraft {
  prompt: string; provider: string; profileId: string; recipe: CompatibleRecipe;
  inputs: RecipeInput[]; sourceItemId?: string; aspectRatio: string; aspectInjection?: boolean; resolution: string; promptLanguage?: string; templateValues?: Record<string,string>;
}
export const emptyGalleryDraft = (): GalleryDraft => ({prompt:'',provider:'openai_compatible',profileId:'',recipe:{model:'',quality:'auto',size:'auto',background:'auto',output_format:'png'},inputs:[],aspectRatio:'auto',resolution:'1k'});
export function galleryJobPrompt(job: GenerationJobRecord) { return job.edited_prompt_text ?? job.prompt_text; }
export function draftFromJob(job: GenerationJobRecord, inputs: RecipeInput[]): GalleryDraft {
  const returned=job.metadata?.requested;
  const requested={...job.parameters,...(returned&&typeof returned==='object'?returned as Record<string,unknown>:{})};
  const template=typeof job.parameters?.prompt_template==='string'?job.parameters.prompt_template:undefined;
  const values=job.parameters?.prompt_template_values;
  const restored=restoreCompatibleRecipe(job);
  const recipe=job.provider==='openai_compatible'?restored:clearCompatibleTransportOverrides(restored);
  return {prompt:template??galleryJobPrompt(job),promptLanguage:job.prompt_language||undefined,templateValues:values&&typeof values==='object'?Object.fromEntries(Object.entries(values).filter((entry):entry is [string,string]=>typeof entry[1]==='string')):undefined,provider:job.provider,profileId:recipeProfileId(job) || '',recipe,inputs,sourceItemId:job.source_item_id,aspectRatio:String(requested.requested_aspect_ratio || 'auto'),aspectInjection:typeof requested.aspect_ratio_prompt_injection==='boolean'?requested.aspect_ratio_prompt_injection:undefined,resolution:String(requested.resolution || '1k')};
}
export function galleryPayload(draft: GalleryDraft, maxInputs: number, referenceSize?: {width:number;height:number}, templatesEnabled=false): GenerationJobCreate {
  if (!draft.prompt.trim()) throw new Error('请先填写提示词');
  if (draft.inputs.length > maxInputs) throw new Error(`此供应商最多接受 ${maxInputs} 张参考图，请手动移除多余图片`);
  if (draft.inputs.some(input => input.missing || !(input.dataUrl || input.imageId || input.resultPath))) throw new Error('参考图缺失，请补齐或明确移除后再提交');
  const variables=templatesEnabled?extractPromptTemplateVariableRecords(draft.prompt):[];
  if(variables.some(variable=>!draft.templateValues?.[variable.key]?.trim()))throw new Error('请填写所有提示词变量');
  const resolved=variables.length?resolvePromptTemplate(draft.prompt,draft.templateValues||{}):draft.prompt;
  let recipe = draft.recipe;
  if (draft.provider === 'openai_compatible' && recipe.size_mode === 'auto4k') {
    const target = resolveAuto4k(resolved, referenceSize);
    if ('error' in target) throw new Error('提示词存在多个冲突比例，请先确定本轮比例');
    recipe = {...recipe,size:target.size!};
  }
  return {
    provider:draft.provider,source_item_id:draft.sourceItemId,model:recipe.model || undefined,
    mode:draft.inputs.length?'image_edit':'text_to_image',prompt_text:draft.prompt,prompt_language:draft.promptLanguage,edited_prompt_text:resolved===draft.prompt?undefined:resolved,reference_image_ids:[],
    parameters:{
      ...(draft.provider === 'openai_compatible' ? {...compatibleParameters(recipe),compatible_profile_id:draft.profileId,...(recipe.size_mode ? {size_mode:recipe.size_mode}: {}),...(draft.aspectRatio!=='auto'?{requested_aspect_ratio:draft.aspectRatio,aspect_ratio_prompt_injection:draft.aspectInjection??(recipe.size==='auto'&&recipe.size_mode!=='auto4k')}:{})} : {quality:recipe.quality,requested_aspect_ratio:draft.aspectRatio,aspect_ratio_prompt_injection:draft.aspectInjection??(draft.provider==='openai_codex_oauth_native'&&draft.aspectRatio!=='auto'),...(draft.provider==='xai_grok_oauth'?{resolution:draft.resolution}:{})}),
      input_images:draft.inputs.map(input=>({id:input.id,name:input.name,source:input.source,data_url:input.dataUrl,result_path:input.resultPath,image_id:input.imageId,source_item_id:input.sourceItemId,role:input.role})),
      ...(variables.length?{prompt_template:draft.prompt,prompt_template_values:Object.fromEntries(variables.map(variable=>[variable.key,draft.templateValues?.[variable.key]||''])),prompt_template_resolved_text:resolved}:{}),
    },
  };
}
export function libraryRecipeImage(item: ItemDetail, imageId?: string) {
  return imageId ? item.images.find(image=>image.id===imageId) : item.images.find(image=>image.role==='reference_image');
}
export const galleryStatus: Record<string,string> = {queued:'排队中',running:'生成中',succeeded:'待收录',accepted:'已收录',failed:'失败',cancelled:'已停止',discarded:'已清理'};
export function galleryMatches(job: GenerationJobRecord, query:string, status:string) {
  const haystack=[galleryJobPrompt(job),job.model,job.provider,job.parameters?.compatible_profile_name,job.id].join('\n').toLowerCase();
  const matchesStatus=status==='active'?['queued','running'].includes(job.status):status==='successful'?['succeeded','accepted'].includes(job.status):status==='completed'?['succeeded','accepted','failed'].includes(job.status):!status||job.status===status;
  return job.status!=='discarded'&&matchesStatus&&(!query.trim()||haystack.includes(query.trim().toLowerCase()));
}
