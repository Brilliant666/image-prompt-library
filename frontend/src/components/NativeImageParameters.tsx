import type { ApiProtocol } from '../types';
import type { CompatibleRecipe } from '../utils/compatibleRecipe';
import { nativeParameterIssue, nativeRecipeDefaults, geminiModelOptions, seedreamModelOptions, MUSE_ASPECT_RATIOS, museAspectRatio } from '../utils/compatibleRecipe';
import './NativeImageParameters.css';

export interface NativeImageValues {
  requested_aspect_ratio?: string; size: string; quality: string; background?: string | null; output_format: string;
  output_compression?: number | null; moderation?: string | null;
  provider_options?: Record<string, string | number | boolean>;
}
interface Props {
  servicePreset?: 'generic'|'muse'; protocol: ApiProtocol; model: string; params: NativeImageValues;
  disabled?: boolean; en?: boolean;
  onChange: (value: Partial<NativeImageValues>) => void;
  onReset?: () => void;
}


/** Shared Gallery/Hybrid controls; these are native image options, never endpoints or keys. */
export default function NativeImageParameters({servicePreset,protocol, model, params, disabled=false, en=false, onChange, onReset}: Props) {
  if (servicePreset === 'muse') {
    const ratio = museAspectRatio(params);
    const unsupported = !MUSE_ASPECT_RATIOS.includes(ratio);
    return <section className="native-image-parameters" aria-label={en ? 'Muse image parameters' : 'Muse 图片参数'}>
      <p className="native-image-caption">Muse · muse-image</p>
      <div className="native-image-grid">
        <label>{en ? 'Aspect ratio' : '画面比例'}<select disabled={disabled} aria-label={en ? 'Muse aspect ratio' : 'Muse 画面比例'} value={ratio}
          onChange={event => { if (!disabled) onChange({requested_aspect_ratio:event.target.value,size:'auto',quality:'auto',background:'auto',output_format:'auto',output_compression:undefined,moderation:undefined}); }}>
          {MUSE_ASPECT_RATIOS.map(value => <option key={value} value={value}>{value === 'auto' ? (en ? 'Service default' : '服务默认') : value}</option>)}
          {unsupported && <option value={ratio} disabled>{ratio} · {en ? 'unsupported' : '不支持'}</option>}
        </select></label>
      </div>
      {unsupported && <p role="alert">{en ? 'Choose a supported Muse ratio. The saved parameters are retained.' : '请选择 Muse 支持的比例，原参数已保留。'}</p>}
      <small>{en ? 'Quality, dimensions and file format are decided by Muse. Up to 4 references, 10 MiB each and 24 MiB total.' : '质量、实际尺寸和文件格式由 Muse 决定；最多 4 张参考图，每张 10 MiB、合计 24 MiB。'}</small>
    </section>;
  }
  if (protocol === 'openai_compatible') return null;
  const options = params.provider_options || {};
  const gemini = protocol === 'gemini_native';
  const geminiOptions = geminiModelOptions(model);
  const {ratios,resolutions} = geminiOptions;
  const jpegOnly = ['doubao-seedream-4-5-251128','doubao-seedream-4-0-250828'].includes(model);
  const issue = nativeParameterIssue({...params, model, protocol, background: params.background || 'auto',
    output_compression: params.output_compression ?? undefined, moderation: params.moderation as CompatibleRecipe['moderation'],
    provider_options: params.provider_options || undefined});
  const patchOption = (key: string, value: string | boolean) => { if (!disabled) onChange({provider_options: {...options, [key]: value}}); };
  const choice = (value: string, label: string) => <option key={value} value={value}>{label}</option>;
  const sizes = seedreamModelOptions(model).sizes;
  return <section className="native-image-parameters" aria-label={en ? 'Native image parameters' : '原生图片参数'}>
    <p className="native-image-caption">{gemini ? 'Gemini · GenerateContent' : 'Seedream · Images'}<span>{en ? 'One image per queued task' : '每个队列任务生成一张'}</span></p>
    <div className="native-image-grid">
      {gemini ? <>
        <label>{en ? 'Aspect ratio' : '画面比例'}<select disabled={disabled} aria-label={en ? 'Native aspect ratio' : '原生画面比例'} value={String(options.aspect_ratio || 'auto')} onChange={e=>patchOption('aspect_ratio',e.target.value)}>{ratios.map(value=>choice(value,value==='auto'?(en?'Auto':'自动'):value))}</select></label>
        <label>{en ? 'Resolution' : '分辨率'}<select disabled={disabled} aria-label={en ? 'Native resolution' : '原生分辨率'} value={String(options.resolution || 'auto')} onChange={e=>patchOption('resolution',e.target.value)}>{resolutions.map(value=>choice(value,value==='auto'?(en?'Model default':'模型默认'):value))}{options.resolution&&!resolutions.includes(String(options.resolution))&&<option value={String(options.resolution)} disabled>{String(options.resolution)} · {en?'unsupported':'不适用'}</option>}</select></label>
      </> : <>
        <label>{en ? 'Output size' : '输出尺寸'}<select disabled={disabled} aria-label={en ? 'Seedream size' : 'Seedream 尺寸'} value={sizes.includes(params.size)?params.size:'custom'} onChange={e=>onChange({size:e.target.value==='custom'?'2048x2048':e.target.value})}>{sizes.map(value=>choice(value,value==='auto'?(en?'Model default':'模型默认'):value))}{choice('custom',en?'Custom pixels':'自定义像素')}</select></label>
        {!sizes.includes(params.size)&&<label>{en?'Width × height':'宽 × 高'}<input disabled={disabled} aria-label={en?'Native custom dimensions':'原生自定义尺寸'} value={params.size} placeholder="2048x2048" onChange={e=>onChange({size:e.target.value})}/></label>}
        <label>{en ? 'Output format' : '输出格式'}<select disabled={disabled} aria-label={en ? 'Native output format' : '原生输出格式'} value={params.output_format} onChange={e=>onChange({output_format:e.target.value})}>{(jpegOnly?['auto','jpeg']:['auto','png','jpeg']).map(value=>choice(value,value==='auto'?(en?'Model default':'模型默认'):value.toUpperCase()))}{!['auto','jpeg',...(jpegOnly?[]:['png'])].includes(params.output_format)&&<option value={params.output_format} disabled>{params.output_format} · {en?'unsupported':'不适用'}</option>}</select></label>
        <label>{en ? 'AI watermark' : 'AI 水印'}<select disabled={disabled} aria-label={en ? 'AI watermark' : 'AI 水印'} value={options.watermark === undefined ? 'auto' : String(options.watermark)} onChange={e=>{const next={...options};if(e.target.value==='auto')delete next.watermark;else next.watermark=e.target.value==='true';onChange({provider_options:next});}}>{choice('auto',en?'Model default':'模型默认')}{choice('true',en?'On':'添加')}{choice('false',en?'Off':'不添加')}</select></label>
      </>}
    </div>
    {issue&&<div role="alert" className="native-parameter-conflict"><p>{en?'The saved recipe contains parameters that this native protocol cannot map.':issue}</p><button type="button" disabled={disabled} onClick={()=>{if(disabled)return;if(onReset){onReset();return;}const value=nativeRecipeDefaults(protocol,model);onChange({size:value.size,quality:value.quality,background:value.background,output_format:value.output_format,provider_options:value.provider_options,output_compression:undefined,moderation:undefined});}}>{en?'Use native defaults':'使用原生默认参数'}</button></div>}
    <small>{en ? 'Options are validated for this protocol. Availability of a manually entered model is not verified. Originals are never resized or rewritten.' : '按当前协议校验参数；手填模型的实际支持范围需由服务确认。不会缩放或改写原图。'}</small>
  </section>;
}
