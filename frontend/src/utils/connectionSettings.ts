import type { ApiConnectionProfile, ApiProtocol, CatalogModel } from '../types';
import { connectionEndpointPreview } from './profileSettings';

export interface ConnectionType { id: string; protocol: ApiProtocol; service_preset?: 'generic' | 'muse'; url: string; name: string; mark: string }
export const CONNECTION_TYPES: ConnectionType[] = [
  { id: 'openai', protocol: 'openai_compatible', url: 'https://api.openai.com/v1', name: 'OpenAI', mark: 'O' },
  { id: 'gemini', protocol: 'gemini_native', url: 'https://generativelanguage.googleapis.com/v1beta', name: 'Google Gemini', mark: 'G' },
  { id: 'seedream', protocol: 'seedream_native', url: 'https://ark.cn-beijing.volces.com/api/v3', name: 'Seedream', mark: 'S' },
  { id: 'muse', protocol: 'openai_compatible', service_preset: 'muse', url: '', name: 'Muse', mark: 'M' },
];
export const API_PROTOCOLS: ApiProtocol[] = ['openai_compatible','gemini_native','seedream_native'];
export function connectionProtocolLabel(protocol: ApiProtocol, en = false): string {
  return {openai_compatible: en ? 'OpenAI compatible' : 'OpenAI 兼容', gemini_native: 'Gemini GenerateContent', seedream_native: en ? 'Seedream Images' : 'Seedream 图片 API'}[protocol];
}
export function connectionUsage(protocol: ApiProtocol, en = false): string {
  if (protocol === 'openai_compatible') return en ? 'Configure text + image models separately in Agent; service support varies' : '可配置文字 + 图片模型 · 在 Agent 中分别选择，实际支持取决于服务';
  return en ? 'Images · Gallery and Agent Hybrid; use a separate Responses connection for text' : '图片 · 用于画廊和 Agent Hybrid，文字使用独立 Responses 连接';
}
export function connectionVersionLabel(protocol: ApiProtocol, en=false): string {
  return {openai_compatible:'/v1',gemini_native:en?'/v1beta or /v1':'/v1beta（或 /v1）',seedream_native:'/api/v3'}[protocol];
}
export function newConnectionProfile(): ApiConnectionProfile {
  return {id:crypto.randomUUID(),display_name:'',base_url:'',model:'',models:[],protocol:'openai_compatible',service_preset:'generic',service_preset_mode:'auto',
    base_url_mode:'versioned',stream:false,partial_images:0,response_format:'auto',timeout:300,
    api_key_present:false,configured:false,network_mode:'direct'};
}
/** Apply only after the user confirms a type change; never called while hovering/selecting a draft. */
export function applyConnectionType(current: ApiConnectionProfile, choice: ConnectionType): ApiConnectionProfile {
  return {...current, protocol:choice.protocol, service_preset:choice.service_preset||'generic', service_preset_mode:choice.service_preset==='muse'?'manual':'auto', base_url:choice.url, display_name:current.display_name || choice.name,
    model:choice.service_preset==='muse'?'muse-image':'',models:[],base_url_mode:'versioned',stream:false,partial_images:0,response_format:'auto',model_catalog:undefined};
}
export function connectionTargetChanged(draft: ApiConnectionProfile, saved?: ApiConnectionProfile): boolean {
  if (!saved) return false;
  if ((draft.protocol || 'openai_compatible') !== (saved.protocol || 'openai_compatible')) return true;
  const before=connectionEndpointPreview(saved.base_url,saved.base_url_mode,saved.protocol)?.base;
  const after=connectionEndpointPreview(draft.base_url,draft.base_url_mode,draft.protocol)?.base;
  return !after || before !== after;
}
export type ModelFilter = 'all' | 'image' | 'text' | 'unknown';
export function connectionModels(models: CatalogModel[], search: string, filter: ModelFilter): CatalogModel[] {
  const term=search.trim().toLowerCase();
  return models.filter(model => (!term || model.id.toLowerCase().includes(term)) &&
    (filter==='all' || filter==='image' && model.image_generation===true || filter==='text' && model.text_generation===true ||
      filter==='unknown' && model.image_generation==null && model.text_generation==null));
}
/** A declared text model must not replace the image default without an image-output claim.
 * Fully unknown/manual aliases remain selectable, not assumed to support images.
 */
export function canUseAsImageDefault(model: CatalogModel): boolean {
  return model.image_generation === true || (model.image_generation == null && model.text_generation !== true);
}
export function modelCapabilityLabel(model: CatalogModel, en=false): string {
  if (model.image_generation===true && model.text_generation===true) return en?'Text + image output':'文字 + 图片输出';
  if (model.image_generation===true) return en?'Image output':'图片输出';
  if (model.text_generation===true) return en?'Text output':'文字输出';
  if (model.image_generation===false && model.text_generation===false) return en?'Other capability':'其他能力';
  return en?'Capability unknown':'能力待确认';
}
export function discoveryMessage(code: string, en=false): string {
  const messages:Record<string,[string,string]>={
    key_required:['请填写 API Key。','Enter an API key.'], key_reentry_required:['地址或协议已更改，请输入适用于新连接的 Key。','The target changed. Enter a key for the new connection.'],
    profile_missing:['原配置已不存在，请重新读取连接。','The saved connection no longer exists. Reload connections.'],
    busy:['其他模型检查正在进行，请稍后再试。','Other model checks are running. Try again afterwards.'],
    permission:['接口拒绝读取模型，请检查 Key 及权限。','Model-list access was denied. Check the key and permissions.'],
    timeout:['读取模型超时，草稿已保留。','Model discovery timed out. Your draft is retained.'],
    connection:['无法连接模型列表接口，请检查地址和网络。','Could not connect to the model-list endpoint.'],
    http:['接口未提供可读取的模型清单，仍可手动填写。','No supported model list is available. Enter models manually.'],
    invalid:['接口返回的模型清单格式无效。','The model list is invalid.'],
    empty:['接口返回空清单，仍可手动填写。','The model list is empty. Manual models are allowed.'],
    limit:['模型清单超过安全大小限制。','The model list exceeds the size limit.'],
    changed:['读取期间连接已变化，请重新识别。','The connection changed. Run discovery again.'],
    network_config:['请检查网络模式、代理和直连出口。','Check network mode, proxy and direct route.'],
    invalid_draft:['请检查地址、协议和网络设置。','Check the address, protocol and network settings.'],
  };
  return (messages[code] || messages.connection)[en?1:0];
}
