// Three-tab interaction adapted from Playground SizePickerModal (MIT).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useModalFocus } from '../../hooks/useModalFocus';
import { IMAGE25_MODELS, resolveAuto4k, type CompatibleRecipe } from '../../utils/compatibleRecipe';
import { calculateImageSize, customSizeError, findSizePreset, parseSizeRatio, SIZE_RATIOS, SIZE_TIERS, type SizeTier } from '../../utils/gallerySize';
import './SizeDialog.css';

interface Props {
  recipe: CompatibleRecipe;
  prompt: string;
  referenceSize?: {width:number;height:number};
  referenceStatus?: 'loading'|'ready'|'error';
  onApply: (size: Pick<CompatibleRecipe, 'size'|'size_mode'>) => void;
  onClose: () => void;
}
export default function SizeDialog({recipe,prompt,referenceSize,referenceStatus,onApply,onClose}:Props) {
  const preset=findSizePreset(recipe.size), pixels=/^(\d+)x(\d+)$/.exec(recipe.size);
  const [mode,setMode]=useState<'auto'|'ratio'|'custom'>(()=>recipe.size_mode==='auto4k'||recipe.size==='auto'?'auto':preset?'ratio':'custom');
  const [automatic,setAutomatic]=useState<'service'|'auto4k'>(recipe.size_mode==='auto4k'?'auto4k':'service');
  const [tier,setTier]=useState<SizeTier>(preset?.tier||'1K'),[ratio,setRatio]=useState(preset?.ratio||'1:1'),[customRatio,setCustomRatio]=useState('5:4');
  const [width,setWidth]=useState(pixels?.[1]||'1024'),[height,setHeight]=useState(pixels?.[2]||'1024');
  const {containerRef,handleModalKeyDown}=useModalFocus<HTMLDivElement>(onClose);
  useEffect(()=>{const overflow=document.body.style.overflow,app=document.getElementById('root'),wasInert=app?.inert;document.body.style.overflow='hidden';if(app)app.inert=true;return()=>{document.body.style.overflow=overflow;if(app)app.inert=Boolean(wasInert);};},[]);
  const auto=resolveAuto4k(prompt,referenceSize), selectedRatio=ratio==='custom'?customRatio:ratio;
  const needsReference=mode==='auto'&&automatic==='auto4k'&&!('error' in auto)&&auto.source!=='prompt';
  const pending=needsReference&&referenceStatus==='loading';
  const preview=pending?undefined:mode==='auto'?(automatic==='service'?'auto':'error' in auto?undefined:auto.size):mode==='ratio'?calculateImageSize(tier,selectedRatio):`${width}x${height}`;
  const error=mode==='custom'?customSizeError(width,height,recipe.model):mode==='ratio'&&!preview?'请输入有效比例（1:3 至 3:1）。':mode==='auto'&&automatic==='auto4k'&&'error' in auto?'提示词比例无效或冲突，请先明确本轮比例。':needsReference&&referenceStatus==='error'?'无法读取首张参考图比例，请重新选择参考图或使用明确的尺寸。':undefined;
  const apply=()=>{if(error||!preview)return;onApply(mode==='auto'&&automatic==='auto4k'?{size:recipe.size,size_mode:'auto4k'}:{size:preview,size_mode:undefined});onClose();};
  return createPortal(<div className="pg-size-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="pg-size-dialog" role="dialog" aria-modal="true" aria-labelledby="gallery-size-title" ref={containerRef} tabIndex={-1} onKeyDown={handleModalKeyDown}>
      <header><div><h2 id="gallery-size-title">设置图像尺寸</h2><p>当前：{recipe.size_mode==='auto4k'?'4K 自动比例':recipe.size.replace('x',' × ')}</p></div><button type="button" aria-label="关闭尺寸设置" onClick={onClose}><X size={19}/></button></header>
      <div className="pg-size-tabs" role="tablist" aria-label="尺寸模式">{([['auto','自动'],['ratio','按比例'],['custom','自定义宽高']] as const).map(([value,label])=><button type="button" key={value} role="tab" aria-selected={mode===value} aria-controls={`size-${value}-panel`} id={`size-${value}-tab`} onClick={()=>setMode(value)}>{label}</button>)}</div>
      <div className="pg-size-content" role="tabpanel" id={`size-${mode}-panel`} aria-labelledby={`size-${mode}-tab`}>
      {mode==='auto'&&<div className="pg-size-auto-options"><button type="button" aria-pressed={automatic==='service'} onClick={()=>setAutomatic('service')}><b>自动 · 服务决定</b><span>发送 size: auto，由接口决定实际尺寸。</span></button><button type="button" aria-pressed={automatic==='auto4k'} onClick={()=>setAutomatic('auto4k')}><b>4K 目标 · 自动比例</b><span>提示词明确比例优先，其次首张参考图；无依据时使用方形。</span></button></div>}
      {mode==='ratio'&&<><fieldset><legend>基准分辨率</legend><div className="pg-size-tiers">{SIZE_TIERS.map(value=><button type="button" key={value} aria-pressed={tier===value} onClick={()=>setTier(value)}>{value}</button>)}</div></fieldset><fieldset><legend>图像比例</legend><div className="pg-size-ratios">{SIZE_RATIOS.map(value=>{const r=parseSizeRatio(value)!.ratio;return <button type="button" key={value} aria-label={`比例 ${value}`} aria-pressed={ratio===value} onClick={()=>setRatio(value)}><span className="pg-size-ratio-icon"><i style={{width:r>=1?24:24*r,height:r<=1?24:24/r}}/></span><span>{value}</span></button>;})}<button type="button" className="pg-size-custom-ratio" aria-pressed={ratio==='custom'} onClick={()=>setRatio('custom')}>自定义比例</button></div></fieldset>{ratio==='custom'&&<label className="pg-size-field">输入自定义比例<input aria-label="自定义比例" value={customRatio} placeholder="例如 5:4 / 2.39:1" onChange={event=>setCustomRatio(event.target.value)}/></label>}</>}
      {mode==='custom'&&<><div className="pg-size-pixels"><label>宽度 (Width)<input aria-label="尺寸宽度" type="number" min={IMAGE25_MODELS.includes(recipe.model)?16:1} step={IMAGE25_MODELS.includes(recipe.model)?16:1} value={width} onChange={event=>setWidth(event.target.value)}/></label><span>×</span><label>高度 (Height)<input aria-label="尺寸高度" type="number" min={IMAGE25_MODELS.includes(recipe.model)?16:1} step={IMAGE25_MODELS.includes(recipe.model)?16:1} value={height} onChange={event=>setHeight(event.target.value)}/></label></div><p className="pg-size-limits">{IMAGE25_MODELS.includes(recipe.model)?'宽高为 16 的倍数，最大边长 3840，宽高比不超过 3:1；总像素 655,360–8,294,400。':'宽高须为正整数，具体尺寸支持由当前接口决定。'}不合法的输入不会自动改写。</p></>}
      </div>
      <div className="pg-size-preview" aria-live="polite"><span>将请求</span><strong>{pending?'读取首张参考图比例…':error?'尺寸无效':preview?.replace('x',' × ')}</strong>{error&&<p role="alert">{error}</p>}<small>1K / 2K / 4K 是本地尺寸预设；实际输出以服务返回原图为准。</small></div>
      <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="pg-size-confirm" disabled={Boolean(error)||!preview} onClick={apply}>确定</button></footer>
    </div>
  </div>,document.body);
}
