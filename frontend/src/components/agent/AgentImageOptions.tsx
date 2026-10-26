import { ChevronDown } from 'lucide-react';
import type { AgentConfigResponse, AgentImageParams } from '../../api/agentClient';
import type { GenerationSetCount } from '../../types';
import ToolbarSelect from '../ToolbarSelect';
import AgentModelPicker from '../settings/AgentModelPicker';
import './AgentImageOptions.css';

export interface AgentImageSelection { profileId?: string | null; model: string }
export interface AgentImageOptionsChange { imageConfig?: AgentImageSelection; params?: AgentImageParams; count?: GenerationSetCount; sizeMode?: 'auto4k' }
export interface AgentImageOptionsProps {
  config: AgentConfigResponse;
  activeProfileId: string;
  selection?: AgentImageSelection;
  params: AgentImageParams;
  sizeMode?: 'auto4k';
  count?: GenerationSetCount;
  shared?: boolean;
  sharedUnavailable?: string;
  disabled?: boolean;
  en?: boolean;
  onChange: (change: AgentImageOptionsChange) => void;
  onChooseSize: () => void;
}

/** The parent synchronizes pending choices and owns the size-dialog lifecycle. */
export default function AgentImageOptions({ config, activeProfileId, selection, params, sizeMode, count = 1, shared = false, sharedUnavailable, disabled = false, en = false, onChange, onChooseSize }: AgentImageOptionsProps) {
  const hybrid = config.config.apiConfigMode === 'hybrid';
  const textProfileId = config.config.apiConfigMode === 'off' ? activeProfileId : config.config.textProfileId;
  const imageProfileId = hybrid ? selection?.profileId ?? config.config.imageProfileId : textProfileId;
  const imageProfile = config.profiles.find(profile => profile.id === imageProfileId);
  const imageModel = selection ? selection.model : config.config.imageModel;
  const effectiveModel = imageModel.trim() || (hybrid ? imageProfile?.model : '') || (en ? 'Provider default' : '接口默认');
  const unavailable = en ? 'Profile unavailable' : '配置不可用';
  const profileOptions = [
    { value: '', label: en ? 'Choose an image API profile' : '选择生图供应商', disabled: true },
    ...(imageProfileId && !imageProfile ? [{ value: imageProfileId, label: unavailable, disabled: true }] : []),
    ...config.profiles.map(profile => ({ value: profile.id, label: `${profile.display_name}${profile.configured ? '' : en ? ' · incomplete' : ' · 待完善'}` })),
  ];
  const changeParams = (patch: Partial<AgentImageParams>) => { if (!disabled) onChange({ params: { ...params, ...patch } }); };
  const changeImage = (patch: Partial<AgentImageSelection>) => {
    if (!disabled) onChange({ imageConfig: { ...(hybrid ? { profileId: imageProfileId ?? null } : {}), model: imageModel, ...patch } });
  };
  const counts: GenerationSetCount[] = [1, 3, 5, 10];
  const qualities = [
    ['auto', en ? 'Auto · auto' : '自动 · auto'], ['low', en ? 'Low · low' : '低 · low'],
    ['medium', en ? 'Medium · medium' : '中 · medium'], ['high', en ? 'High · high' : '高 · high'],
    ['xhigh', en ? 'Extra high · xhigh' : '超高 · xhigh'], ['max', en ? 'Maximum · max' : '最高 · max'],
  ].map(([value, label]) => ({ value, label }));
  return <section className="agent-image-options" aria-label={en ? 'Image generation settings' : '生图设置'}>
    {hybrid && shared && <p className="agent-image-hint">{en ? 'Shared with Gallery. Changes apply to future requests in both workspaces.' : '与画廊同步，修改后用于两边接下来发送的任务。'}</p>}
    <div className="agent-image-provider">
      <span className="agent-image-field-label">{en ? 'Image provider' : '生图供应商'}</span>
      {hybrid ? <ToolbarSelect label={en ? 'Image provider' : '生图供应商'} value={imageProfileId || ''} options={profileOptions} disabled={disabled} onChange={profileId => changeImage({ profileId, model: config.profiles.find(profile => profile.id === profileId)?.model || '' })} />
        : <strong>{imageProfile?.display_name || unavailable}<small>{en ? 'Responses image tool' : 'Responses 生图工具'}</small></strong>}
    </div>
    <AgentModelPicker label={en ? 'Image model' : '生图模型'} value={imageModel} profile={imageProfile} active={!disabled} en={en} disabled={disabled} imageRecommendations={hybrid} onChange={model => changeImage({ model })} />
    <p className="agent-image-model-summary">{en ? 'Will use: ' : '将使用：'}<strong>{effectiveModel}</strong>{hybrid && (imageModel.trim() && imageModel.trim() !== imageProfile?.model ? en ? ' · manual override' : ' · 手动覆盖模型' : en ? ' · profile default' : ' · 供应商默认模型')}</p>
    {hybrid && imageModel.trim() && imageModel.trim() !== imageProfile?.model && <p className="agent-image-hint">{en ? 'Profile default: ' : '供应商默认模型：'}{imageProfile?.model || (en ? 'Not set' : '未设置')}{imageProfile?.model_catalog?.fetched_at && !imageProfile.model_catalog.models.some(model => model.id === imageModel.trim()) && (en ? ' · Manual model is not in the cached catalog; compatibility is unverified.' : ' · 手填模型不在缓存清单中，兼容性未验证。')}</p>}
    {!hybrid && <p className="agent-image-hint">{en ? 'This mode uses the text provider’s Responses image tool. Gallery Images API settings cannot be copied into it.' : '此模式通过文字接口的 Responses 生图工具生成，不能直接套用画廊的 Images API 配置。'}</p>}
    {hybrid && sharedUnavailable && <p className="agent-image-hint" role="status">{sharedUnavailable}</p>}
    <div className="agent-image-parameter-grid">
      <div className="agent-image-size-field"><span className="agent-image-field-label">{en ? 'Size' : '尺寸'}</span><button type="button" className="agent-image-size-button" disabled={disabled} onClick={() => { if (!disabled) onChooseSize(); }} aria-label={en ? 'Set image size' : '设置图像尺寸'}><span>{sizeMode === 'auto4k' ? en ? '4K · automatic ratio' : '4K · 自动比例' : params.size === 'auto' ? en ? 'Auto · provider decides' : '自动 · 服务决定' : params.size.replace('x', ' × ')}</span><ChevronDown size={14} aria-hidden="true" /></button></div>
      <div><span className="agent-image-field-label">{en ? 'Quality' : '质量'}</span><ToolbarSelect label={en ? 'Image quality' : '图片质量'} value={params.quality} options={qualities} disabled={disabled} onChange={quality => changeParams({ quality })} /></div>
      <div><span className="agent-image-field-label">{en ? 'Count' : '数量'}</span><ToolbarSelect label={en ? 'Image count' : '生成数量'} value={String(count)} options={counts.map(value => ({ value: String(value), label: en ? `${value} image${value === 1 ? '' : 's'}` : `${value} 张` }))} disabled={disabled} onChange={value => { const selected = Number(value) as GenerationSetCount; if (!disabled && counts.includes(selected)) onChange({ count: selected }); }} /></div>
      <div><span className="agent-image-field-label">{en ? 'Background' : '背景'}</span><ToolbarSelect label={en ? 'Image background' : '图片背景'} value={params.background || 'auto'} options={[{ value: 'auto', label: en ? 'Auto' : '自动' }, { value: 'opaque', label: en ? 'Opaque' : '不透明' }, { value: 'transparent', label: en ? 'Transparent' : '透明' }]} disabled={disabled} onChange={background => changeParams({ background })} /></div>
      <div><span className="agent-image-field-label">{en ? 'Format' : '格式'}</span><ToolbarSelect label={en ? 'Image format' : '图片格式'} value={params.output_format} options={[{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }]} disabled={disabled} onChange={output_format => changeParams({ output_format })} /></div>
      <div><span className="agent-image-field-label">{en ? 'Moderation' : '审核'}</span><ToolbarSelect label={en ? 'Image moderation' : '图片审核'} value={params.moderation || 'auto'} options={[{ value: 'auto', label: en ? 'Auto · auto' : '自动 · auto' }, { value: 'low', label: en ? 'Low · low' : '低 · low' }]} disabled={disabled} onChange={moderation => changeParams({ moderation })} /></div>
      {params.output_format !== 'png' && <label><span className="agent-image-field-label">{en ? 'Compression quality (0–100)' : '压缩质量（0–100）'}</span><input type="number" min={0} max={100} step={1} disabled={disabled} value={params.output_compression ?? ''} placeholder={en ? 'Provider default' : '接口默认'} onChange={event => changeParams({ output_compression: event.target.value === '' ? null : Number(event.target.value) })} /></label>}
    </div>
  </section>;
}
