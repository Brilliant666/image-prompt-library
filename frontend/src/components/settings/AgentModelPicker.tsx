import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Check, RefreshCw } from 'lucide-react';
import { api } from '../../api/client';
import type { ModelCatalog, OpenAICompatibleProfile } from '../../types';
import { profileModelChoices } from '../../utils/profileSettings';
import './AgentModelPicker.css';

// Sharing an in-flight discovery prevents the text and image fields from
// starting duplicate upstream reads for the same saved connection.
const refreshes = new Map<string, Promise<ModelCatalog>>();
const emptyCatalog = (): ModelCatalog => ({ models: [], fetched_at: null, checked_at: null, error: null });

export default function AgentModelPicker({ label, value, onChange, profile, active, en, disabled = false, unavailableHint, imageRecommendations = false }: {
  label: string; value: string; onChange: (value: string) => void;
  profile?: OpenAICompatibleProfile; active: boolean; en: boolean; disabled?: boolean; unavailableHint?: string; imageRecommendations?: boolean;
}) {
  const id = useId();
  const [catalog, setCatalog] = useState<ModelCatalog>(profile?.model_catalog || emptyCatalog);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const sequence = useRef(0);
  const scope = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const currentProfile = useRef<string | undefined>(profile?.id);
  currentProfile.current = profile?.id;

  useEffect(() => {
    const selection = ++scope.current;
    const profileId = profile?.id;
    setOpen(false); setQuery(''); setRefreshFailed(false);
    setCatalog(profile?.model_catalog || emptyCatalog());
    setRefreshing(Boolean(profileId && refreshes.has(profileId)));
    if (!active || !profileId) return () => { scope.current += 1; sequence.current += 1; };
    const read = async () => {
      const request = ++sequence.current;
      try {
        // This endpoint reads the server's canonical cache, never GET /models upstream.
        const next = await api.openAICompatibleModels(profileId);
        if (selection === scope.current && request === sequence.current && currentProfile.current === profileId) setCatalog(next);
      } catch {
        if (selection === scope.current && request === sequence.current) setCatalog(previous => ({ ...previous, error: 'local_catalog_unavailable' }));
      }
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ profileId?: string }>).detail?.profileId !== profileId) return;
      setRefreshing(refreshes.has(profileId));
      void read();
    };
    window.addEventListener('ipl:model-catalog-changed', changed);
    void read();
    return () => { scope.current += 1; sequence.current += 1; window.removeEventListener('ipl:model-catalog-changed', changed); };
  }, [active, profile?.id, profile?.base_url, profile?.base_url_mode, profile?.api_key_present, profile?.configured]);

  const refresh = async () => {
    const profileId = profile?.id;
    if (!active || disabled || !profileId || !profile.configured || refreshes.has(profileId)) return;
    const selection = scope.current;
    const pending = api.refreshOpenAICompatibleModels(profileId);
    refreshes.set(profileId, pending); setRefreshing(true); setRefreshFailed(false);
    try {
      await pending;
    } catch {
      if (scope.current === selection && currentProfile.current === profileId) setRefreshFailed(true);
    } finally {
      if (refreshes.get(profileId) === pending) refreshes.delete(profileId);
      // Even after close/switch, notify the saved profile's consumers. They read
      // the current cache, so a stale connection's response cannot replace it.
      window.dispatchEvent(new CustomEvent('ipl:model-catalog-changed', { detail: { profileId } }));
      if (scope.current === selection && currentProfile.current === profileId) setRefreshing(false);
    }
  };

  const composing = (event: KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (composing(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); input.current?.focus(); return; }
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') { event.preventDefault(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [])];
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = index < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };
  const candidates = imageRecommendations
    ? profileModelChoices(profile ? { ...profile, model_catalog: catalog } : undefined, value).map(id => catalog.models.find(model => model.id === id) || { id, image_generation: null })
    : catalog.models;
  const options = candidates.filter(model => model.id.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="agent-model-picker" ref={root} onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <label className="settings-field" htmlFor={id}><span>{label}</span></label>
    <div className="agent-model-input-row">
      <input ref={input} id={id} value={value} disabled={disabled} maxLength={120} spellCheck={false} placeholder={en ? 'Full model ID (manual entry supported)' : '完整模型 ID，也可手动填写'} onChange={event => onChange(event.target.value)} />
      <button type="button" className="secondary" disabled={disabled || !profile} aria-label={`${label}${en ? ' catalog' : '目录'}`} aria-expanded={open} aria-controls={`${id}-catalog`} onClick={() => { setOpen(!open); setQuery(''); }}><ChevronDown size={16} aria-hidden="true" /></button>
    </div>
    {profile ? <div className="agent-model-source"><span>{en ? 'Catalog: ' : '模型清单：'}{profile.display_name}</span><button type="button" className="secondary" disabled={disabled || !active || !profile.configured || refreshing} onClick={() => void refresh()}><RefreshCw size={13} aria-hidden="true" />{refreshing ? en ? 'Refreshing…' : '刷新中…' : en ? 'Refresh models' : '刷新模型'}</button></div> : <p className="settings-help">{unavailableHint || (en ? 'Select an API profile to see its cached models. Manual entry is always available.' : '选择 API 配置后显示已缓存的模型，仍可手动填写。')}</p>}
    {(catalog.error || refreshFailed) && profile && <p className="settings-help" role="status">{en ? 'Could not refresh the catalog. Previous models and your entry are kept; manual entry is available.' : '暂时无法更新模型清单，保留已有清单和填写内容，仍可手动输入。'}</p>}
    {open && profile && <div id={`${id}-catalog`} className="agent-model-catalog" onKeyDown={move}>
      <input autoFocus aria-label={en ? 'Filter model catalog' : '搜索模型清单'} value={query} onChange={event => setQuery(event.target.value)} placeholder={en ? 'Search full model ID' : '搜索完整模型 ID'} />
      <div ref={list} className="agent-model-options" role="listbox" aria-label={`${label}${en ? ' catalog' : '目录'}`}>
        {options.map(model => <button type="button" role="option" aria-selected={model.id === value} key={model.id} onClick={() => { onChange(model.id); setOpen(false); input.current?.focus(); }}><span>{model.id}<small>{model.image_generation === true ? en ? 'Image generation declared' : '接口声明支持生图' : model.image_generation === false ? en ? 'Image generation not declared' : '接口未声明支持生图' : en ? 'Capabilities unspecified' : '能力未声明'}</small></span>{model.id === value && <Check size={16} aria-hidden="true" />}</button>)}
      </div>
      {!options.length && <p className="settings-help">{en ? 'No matching cached models. You can enter a model ID above.' : '暂无匹配的缓存模型，可在上方手动填写模型 ID。'}</p>}
      <p className="settings-help">{imageRecommendations ? en ? 'Recommends gpt-image models, keeping your current selection. Manual model IDs are supported. Refresh only reads the catalog.' : '仅推荐 gpt-image 系列，保留当前选择，也可手填完整模型 ID。刷新仅读取模型清单。' : en ? 'The catalog does not verify Responses or image-tool support. Refresh reads only the model list; it does not run the Agent.' : '清单不代表已验证 Responses 或生图工具支持。刷新仅读取模型列表，不运行 Agent。'}</p>
    </div>}
  </div>;
}
