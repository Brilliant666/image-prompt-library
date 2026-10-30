import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2, Server, Copy, GripVertical, ArrowUp, ArrowDown, RefreshCw, KeyRound } from 'lucide-react';
import { api } from '../api/client';
import { copyApiProfile, reorderApiProfiles } from '../api/profileActions';
import type { ModelCatalog, OpenAICompatibleProfile, OpenAICompatibleProfiles, UiLanguage } from '../types';
import { compatibleEndpointPreview, parseProfileModels, profileValidation } from '../utils/profileSettings';
import { readGenerationPreference, resetGenerationPreference, updateRememberedModel } from '../utils/generationPreferences';
import type { CompatibleRecipe } from '../utils/compatibleRecipe';
import { apiNetworkErrorMessage, apiNetworkIssue, apiNetworkMode, apiNetworkPayload } from '../utils/apiNetwork';
import ApiNetworkSettings from './ApiNetworkSettings';
import './OpenAICompatibleSettings.css';

const newProfile = (): OpenAICompatibleProfile => ({ id: crypto.randomUUID(), display_name: '', base_url: '', model: '', models: [], base_url_mode: 'versioned', stream: false, partial_images: 0, response_format: 'auto', timeout: 300, api_key_present: false, configured: false, network_mode: 'direct' });
const emptyCatalog = (): ModelCatalog => ({ models: [], fetched_at: null, checked_at: null, error: null });
const catalogErrorReasons: Record<string, string> = {
  'Save an API URL and API key before refreshing models.': '请先保存接口地址和密钥。',
  'The provider denied access to its model list. Check the saved API key and permissions.': '接口拒绝读取模型，请检查已保存密钥及权限。',
  'The model list request timed out. Try refreshing again later.': '读取模型列表超时，请稍后重试。',
  'Could not connect to the model list endpoint.': '无法连接模型列表接口，请检查地址和网络。',
  'The provider could not return its model list. Check that this connection supports GET /models.': '接口未能返回模型列表，请确认支持 GET /models。',
  'The provider returned an invalid model list.': '接口返回的模型列表格式无效。',
  'The provider model list exceeded the supported size limit.': '接口返回的模型列表超过大小限制。',
  'The provider returned no models. Any previously fetched models have been kept.': '接口返回了空模型列表，旧清单已保留。',
  'The saved connection changed during refresh. Refresh the current connection again.': '读取期间连接配置发生变化，请刷新当前连接。',
  'A newer model refresh has started. The older response was discarded.': '已有更新的模型请求，旧响应已忽略。',
  'The saved model cache could not be read. Refresh the model list again.': '无法读取模型缓存，请重新刷新。',
};

export default function OpenAICompatibleSettings({ onSaved, uiLanguage, isDefaultConnection = false, onSetDefaultConnection }: { onSaved: () => Promise<void>; uiLanguage: UiLanguage; isDefaultConnection?: boolean; onSetDefaultConnection?: () => void }) {
  const [collection, setCollection] = useState<OpenAICompatibleProfiles>();
  const [config, setConfig] = useState<OpenAICompatibleProfile>();
  const [apiKey, setApiKey] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [removeProxy, setRemoveProxy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [deletePending, setDeletePending] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const [modelsText, setModelsText] = useState('');
  const [remembered, setRemembered] = useState<CompatibleRecipe>();
  const [resetPending, setResetPending] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog>(emptyCatalog());
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const catalogEpoch = useRef(0);
  const catalogReadSequence = useRef(0);
  const selectedProfile = useRef<string | undefined>(undefined);
  const selectedCatalog = useRef<ModelCatalog>(emptyCatalog());
  const catalogFlights = useRef(new Map<string, Promise<ModelCatalog | undefined>>());
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const chinese = uiLanguage !== 'en';
  const readCatalog = async (profileId: string) => {
    const request = ++catalogReadSequence.current;
    const selection = catalogEpoch.current;
    try {
      // Read the canonical local cache, never issue another upstream discovery.
      const value = await api.openAICompatibleModels(profileId);
      if (request !== catalogReadSequence.current || selection !== catalogEpoch.current || selectedProfile.current !== profileId) return;
      selectedCatalog.current = value;
      setCatalog(value);
      setCollection(store => store ? { ...store, profiles: store.profiles.map(profile => profile.id === profileId ? { ...profile, model_catalog: value } : profile) } : store);
      setConfig(profile => profile?.id === profileId ? { ...profile, model_catalog: value } : profile);
    } catch { /* Keep the currently displayed cache and editable form on a local read failure. */ }
  };
  const choose = (profile: OpenAICompatibleProfile) => {
    catalogEpoch.current += 1;
    selectedProfile.current = profile.id;
    selectedCatalog.current = profile.model_catalog || emptyCatalog();
    setCatalog(selectedCatalog.current);
    setCatalogBusy(catalogFlights.current.has(profile.id));
    setShowAllModels(false);
    setConfig({ ...profile });
    setApiKey('');
    setProxyUrl('');
    setRemoveProxy(false);
    setMessage('');
    setDeletePending(false);
    setResetPending(false);
    setModelsText((profile.models || []).join('\n'));
    try { setRemembered(readGenerationPreference(localStorage, profile.id, profile.model)); } catch { setRemembered(undefined); }
    if (profile.configured) void readCatalog(profile.id);
  };
  const load = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++epoch.current;
    setBusy(true);
    api.openAICompatibleProfiles().then(value => {
      if (request !== epoch.current) return;
      setCollection(value);
      choose(value.profiles.find(p => p.id === value.default_profile_id) || value.profiles[0] || newProfile());
    }).catch(() => {
      if (request === epoch.current) setMessage(chinese ? '无法读取接口配置，请重新打开设置重试。' : 'Could not load API profiles. Reopen settings to retry.');
    }).finally(() => { if (request === epoch.current) { inFlight.current = false; setBusy(false); } });
  };
  useEffect(() => {
    const catalogChanged = (event: Event) => {
      const profileId = (event as CustomEvent<{ profileId?: string }>).detail?.profileId;
      if (profileId && selectedProfile.current === profileId) void readCatalog(profileId);
    };
    window.addEventListener('ipl:model-catalog-changed', catalogChanged);
    load();
    return () => { window.removeEventListener('ipl:model-catalog-changed', catalogChanged); epoch.current += 1; inFlight.current = false; catalogEpoch.current += 1; selectedProfile.current = undefined; };
  }, []);

  const refreshCatalog = async (profileId: string, afterSave = false) => {
    const existing = catalogFlights.current.get(profileId);
    if (existing && !afterSave) return;
    const request = ++catalogEpoch.current;
    const previous = selectedCatalog.current;
    const current = () => request === catalogEpoch.current && selectedProfile.current === profileId;
    const pending = (async () => {
      // A saved connection gets one fresh request after any older request ends.
      if (existing) await existing.catch(() => undefined);
      if (!current()) return;
      return api.refreshOpenAICompatibleModels(profileId);
    })();
    catalogFlights.current.set(profileId, pending);
    setCatalogBusy(true);
    const apply = (value: ModelCatalog) => {
      if (!current()) return;
      selectedCatalog.current = value;
      setCatalog(value);
      setCollection(store => store ? { ...store, profiles: store.profiles.map(profile => profile.id === profileId ? { ...profile, model_catalog: value } : profile) } : store);
      setConfig(profile => profile?.id === profileId ? { ...profile, model_catalog: value } : profile);
    };
    try {
      const value = await pending;
      if (!value) return;
      // Completion belongs to the saved profile, not the selected form's lifetime.
      // Consumers re-read the canonical cache rather than trusting a late response.
      window.dispatchEvent(new CustomEvent('ipl:model-catalog-changed', { detail: { profileId } }));
    } catch {
      // Display a local fixed message, never raw responses or credentials.
      apply({ ...previous, checked_at: new Date().toISOString(), error: 'model_catalog_refresh_failed' });
    } finally {
      if (catalogFlights.current.get(profileId) === pending) {
        catalogFlights.current.delete(profileId);
        if (selectedProfile.current === profileId) setCatalogBusy(false);
      }
    }
  };

  const mutate = async (operation: () => Promise<OpenAICompatibleProfiles>, nextId?: string, onConfirmed?: (value: OpenAICompatibleProfiles) => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++epoch.current;
    setBusy(true);
    setMessage('');
    setDeletePending(false);
    try {
      const value = await operation();
      if (request !== epoch.current) return;
      onConfirmed?.(value);
      setCollection(value);
      choose(value.profiles.find(p => p.id === nextId) || value.profiles.find(p => p.id === value.default_profile_id) || value.profiles[0] || newProfile());
      window.dispatchEvent(new Event('ipl:agent-config-changed'));
      setMessage(chinese ? '已保存。尚未验证实际调用，不会发送生图请求。' : 'Saved. Actual API calls remain unverified; no image request was sent.');
      // Refresh status independently: a refresh failure must not report a successful save as failed.
      await onSaved().catch(() => undefined);
      return true;
    } catch {
      // Never display arbitrary service responses, which may contain credentials.
      if (request === epoch.current) setMessage(chinese ? '暂时无法确认操作结果。请重新读取列表核对后再操作。' : 'Could not confirm the result. Reload the profile list before trying again.');
    } finally {
      if (request === epoch.current) { setApiKey(''); setProxyUrl(''); inFlight.current = false; setBusy(false); }
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!config) return;
    const models = parseProfileModels(modelsText);
    const issue = profileValidation({ ...config, models });
    if (issue) {
      setMessage(issue === 'name' ? (chinese ? '请填写配置名称。' : 'Enter a profile name.') : issue === 'url' ? (chinese ? '请填写 HTTP(S) Base URL，不包含密钥、查询参数、片段或 /images/ 接口路径。' : 'Enter an HTTP(S) Base URL without credentials, query parameters, fragments or an /images/ endpoint.') : issue === 'models' ? (chinese ? '最多 100 个模型，每个 ID 不超过 200 字符，不含控制字符。' : 'Use up to 100 model IDs, each at most 200 characters and without control characters.') : issue === 'partial_images' ? (chinese ? '中间预览图数量必须是 0–3 的整数。' : 'Partial images must be a whole number from 0 to 3.') : (chinese ? '超时必须是 1–1800 之间的整数秒。' : 'Timeout must be a whole number from 1 to 1800 seconds.'));
      return;
    }
    const networkMode = apiNetworkMode(config.network_mode);
    const networkDraft = { proxyUrl, removeProxy };
    const networkIssue = apiNetworkIssue(networkMode, networkDraft, config.proxy_url_present === true);
    if (networkIssue) { setMessage(apiNetworkErrorMessage(networkIssue, uiLanguage)); return; }
    const { id, api_key_present: _present, configured: _configured, model_catalog: _catalog, proxy_url_present: _proxyPresent, proxy_endpoint: _proxyEndpoint, ...fields } = config;
    catalogEpoch.current += 1;
    const previousModel = collection?.profiles.find(profile => profile.id === id)?.model || '';
    void mutate(() => api.saveOpenAICompatibleProfile(id, { ...fields, models, ...apiNetworkPayload(networkMode, networkDraft), ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) }), id, value => {
      const saved = value.profiles.find(profile => profile.id === id);
      if (!saved || saved.model === previousModel) return;
      try { updateRememberedModel(localStorage, id, saved.model); } catch { /* A saved profile still applies to the open composer if browser storage is unavailable. */ }
      window.dispatchEvent(new CustomEvent('ipl:profile-model-saved', { detail: { profileId: id, model: saved.model } }));
    }).then(saved => { if (saved && selectedProfile.current === id) void refreshCatalog(id, true); });
  };
  const stored = collection?.profiles.some(p => p.id === config?.id);
  const storedProfile = collection?.profiles.find(p => p.id === config?.id);
  const dirty = Boolean(apiKey || proxyUrl || removeProxy || (config && (storedProfile ? JSON.stringify(config) !== JSON.stringify(storedProfile) || JSON.stringify(parseProfileModels(modelsText)) !== JSON.stringify(storedProfile.models || []) : JSON.stringify({ ...config, id: '' }) !== JSON.stringify({ ...newProfile(), id: '' }) || modelsText.trim())));
  const discoveredModels = [...catalog.models].filter(model => showAllModels || model.image_generation !== false).sort((a, b) => (a.image_generation === true ? 0 : a.image_generation === null ? 1 : 2) - (b.image_generation === true ? 0 : b.image_generation === null ? 1 : 2));
  const modelSuggestions = [...new Set([...parseProfileModels(modelsText), ...catalog.models.map(model => model.id)])];
  const catalogErrorReason = catalog.error && Object.prototype.hasOwnProperty.call(catalogErrorReasons, catalog.error) ? (chinese ? catalogErrorReasons[catalog.error] : catalog.error) : '';
  const timeLabel = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(chinese ? 'zh-CN' : 'en-US'); };
  const move = (sourceId: string, targetId: string) => {
    if (!collection || sourceId === targetId || dirty) return;
    const ids = collection.profiles.map(profile => profile.id);
    const target = ids.indexOf(targetId);
    if (target < 0 || !ids.includes(sourceId)) return;
    const ordered = ids.filter(id => id !== sourceId);
    ordered.splice(target, 0, sourceId);
    void mutate(() => reorderApiProfiles(ordered), config?.id);
  };
  const copy = () => {
    if (!config || !stored || dirty) return;
    const id = crypto.randomUUID();
    const name = `${config.display_name.slice(0, 92)}${chinese ? ' 副本' : ' Copy'}`;
    void mutate(() => copyApiProfile(config.id, id, name), id);
  };
  const resetRecipe = () => {
    if (!config || dirty || busy) return;
    let reset = false;
    try { reset = resetGenerationPreference(localStorage, config.id); } catch { /* Browser storage can be disabled. */ }
    if (!reset) { setMessage(chinese ? '无法重置浏览器参数，请检查浏览器存储权限。' : 'Could not reset parameters. Check browser storage access.'); return; }
    setRemembered(readGenerationPreference(localStorage, config.id, config.model));
    setResetPending(false);
    window.dispatchEvent(new CustomEvent('ipl:generation-preference-reset', { detail: { profileId: config.id } }));
    setMessage(chinese ? '已重置此配置的本浏览器参数；提示词、参考图和已保存任务均保留。' : 'This profile’s browser parameters were reset. Prompts, references and saved tasks are unchanged.');
  };
  const endpoints = config ? compatibleEndpointPreview(config.base_url, config.base_url_mode) : undefined;
  const setDefault = async () => {
    if (!config || !stored || dirty || busy || !config.configured) return;
    if (config.id !== collection?.default_profile_id && !await mutate(() => api.defaultOpenAICompatibleProfile(config.id), config.id)) return;
    onSetDefaultConnection?.();
    setMessage(chinese ? '已设为默认连接。现有草稿和任务保持原配置。' : 'Default connection updated. Existing drafts and tasks keep their configuration.');
  };

  return <section className="provider-card compatible-provider-settings compatible-profiles">
    <header><h4>{chinese ? 'OpenAI 兼容 API' : 'OpenAI-compatible API'}</h4>
      <p className="muted">{chinese ? '「OpenAI 兼容」是接口类型；配置名称可按服务商或用途命名。每个配置独立保存地址、密钥、模型与超时。' : 'OpenAI-compatible is the API format. Name each connection by service or purpose; each profile keeps its own URL, key, model and timeout.'}</p></header>
    {collection && <>
      <span className="compatible-current-label">{chinese ? '当前编辑配置' : 'Profile to edit'}</span>
      <div className="compatible-current-profile">
        <Server size={18} aria-hidden="true" /><span><strong>{config?.display_name || (chinese ? '新配置' : 'New profile')}</strong><small>{config?.id === collection.default_profile_id ? (chinese ? '默认 API 配置' : 'Default API profile') : (chinese ? '独立连接配置' : 'Independent connection')}</small></span><b className="compatible-protocol-badge">OpenAI</b>
      </div>
      <div id="compatible-registered-profiles" className="compatible-profile-list" aria-label={chinese ? '已登记接口' : 'Registered APIs'}>
        {collection.profiles.map((profile, index) => <div key={profile.id} className={`compatible-profile-row${draggedId === profile.id ? ' dragging' : ''}`}
          draggable={!busy && !dirty} onDragStart={event => { setDraggedId(profile.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', profile.id); }}
          onDragOver={event => { if (draggedId && !busy && !dirty) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
          onDrop={event => { event.preventDefault(); if (draggedId) move(draggedId, profile.id); setDraggedId(undefined); }} onDragEnd={() => setDraggedId(undefined)}>
          <GripVertical className="compatible-profile-grip" size={16} aria-hidden="true" />
          <button type="button" className={config?.id === profile.id ? 'compatible-profile-option active' : 'compatible-profile-option'} aria-pressed={config?.id === profile.id} disabled={busy || dirty && config?.id !== profile.id} onClick={() => { if (!dirty) choose(profile); }}>
            <Server size={16} aria-hidden="true" /><span><strong>{profile.display_name}<b className="compatible-protocol-badge">OpenAI</b></strong><small>{profile.id === collection.default_profile_id ? (chinese ? '默认 · ' : 'Default · ') : ''}{profile.configured ? (chinese ? '配置完整' : 'Configured') : (chinese ? '待完善' : 'Incomplete')}</small></span>
          </button>
          <div className="compatible-profile-order"><button type="button" aria-label={`${chinese ? '上移' : 'Move up'} ${profile.display_name}`} disabled={busy || dirty || index === 0} onClick={() => move(profile.id, collection.profiles[index - 1].id)}><ArrowUp size={14} /></button>
            <button type="button" aria-label={`${chinese ? '下移' : 'Move down'} ${profile.display_name}`} disabled={busy || dirty || index === collection.profiles.length - 1} onClick={() => move(profile.id, collection.profiles[index + 1].id)}><ArrowDown size={14} /></button></div>
        </div>)}
      </div>
      <div className="compatible-profile-toolbar"><button type="button" className="secondary compatible-profile-add" disabled={busy || dirty} onClick={() => choose(newProfile())}><Plus size={16} aria-hidden="true" />{chinese ? '新建配置' : 'New profile'}</button>
        <button type="button" className="secondary" disabled={busy || dirty || !stored} onClick={copy}><Copy size={15} aria-hidden="true" />{chinese ? '复制配置' : 'Duplicate'}</button>
        <button type="button" className="secondary" disabled={busy || dirty} onClick={load} aria-label={chinese ? '重新读取接口列表' : 'Reload API profiles'}><RefreshCw size={15} aria-hidden="true" /></button>
      </div>
      {dirty && <p className="settings-help">{chinese ? '当前有未保存更改；保存或放弃后可切换、复制及排序。' : 'Save or discard your changes before switching, duplicating or reordering.'}</p>}
    </>}
    {config && <form className="compatible-profile-form" onSubmit={save} autoComplete="off">
      <fieldset disabled={busy}>
        <legend>{stored ? (chinese ? '连接信息' : 'Connection') : (chinese ? '新配置的连接信息' : 'New connection')}</legend>
        <label>{chinese ? '配置名称' : 'Profile name'}<input required maxLength={100} value={config.display_name} onChange={e => setConfig({ ...config, display_name: e.target.value })} placeholder={chinese ? '例如：我的图片服务' : 'For example: My image service'} /><small>{chinese ? '画廊、Agent 和历史记录通过此名称区分接口。' : 'Identifies this connection in Gallery, Agent and history.'}</small></label>
        <label>Base URL<input required type="url" spellCheck={false} value={config.base_url} onChange={e => setConfig({ ...config, base_url: e.target.value })} placeholder="https://api.example.com/v1" /><small>{chinese ? '填写接口根地址，不包含密钥或完整生图路径。下方显示实际请求地址。' : 'Enter the API root without credentials or a complete image endpoint. Actual request addresses are shown below.'}</small></label>
        <label>{chinese ? '地址拼接方式' : 'Base URL mode'}<select aria-label={chinese ? '地址拼接方式' : 'Base URL mode'} value={config.base_url_mode || 'versioned'} onChange={e => setConfig({ ...config, base_url_mode: e.target.value as 'versioned' | 'custom' })}><option value="versioned">{chinese ? '标准 /v1（兼容已有配置）' : 'Standard /v1 (existing behavior)'}</option><option value="custom">{chinese ? '使用填写的根路径' : 'Use the exact base path'}</option></select><small>{chinese ? '标准方式统一补为一个 /v1；自定义方式不补 /v1。末尾斜杠不改变所选规则。' : 'Standard mode applies one /v1 suffix. Custom mode adds no /v1. A trailing slash does not change the selected rule.'}</small></label>
        <label>API Key<input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={config.api_key_present ? (chinese ? '已保存；留空保留此接口的密钥' : 'Saved; leave blank to keep this API key') : (chinese ? '输入此接口的 API Key' : 'Enter this API key')} /><small className="compatible-key-status"><KeyRound size={12} aria-hidden="true" />{config.api_key_present ? (chinese ? '密钥已保存在服务端，页面不会读取原值' : 'Key saved on the server; its value is never read by this page') : (chinese ? '尚未保存密钥' : 'No saved key')}</small></label>
        <ApiNetworkSettings key={config.id} uiLanguage={uiLanguage} mode={apiNetworkMode(config.network_mode)}
          proxyUrl={proxyUrl} proxyUrlPresent={config.proxy_url_present === true} proxyEndpoint={config.proxy_endpoint}
          removeProxy={removeProxy} disabled={busy} onModeChange={mode => setConfig(current => current ? { ...current, network_mode: mode } : current)}
          onProxyUrlChange={setProxyUrl} onRemoveProxyChange={setRemoveProxy} />
        <div className="compatible-request-settings">
          <h5>{chinese ? '模型与请求' : 'Model and request'}</h5>
          <section className="compatible-model-catalog" aria-label={chinese ? '接口模型清单' : 'API model catalog'}>
            <header><h5>{chinese ? '接口模型清单' : 'API model catalog'}</h5><button type="button" className="secondary" aria-label={chinese ? '刷新接口模型' : 'Refresh API models'} disabled={busy || dirty || !stored || !config.configured || catalogBusy} onClick={() => { if (!busy && !dirty && stored && config.configured && !catalogBusy) void refreshCatalog(config.id); }}><RefreshCw size={14} aria-hidden="true" />{catalogBusy ? (chinese ? '读取中…' : 'Loading…') : (chinese ? '刷新模型' : 'Refresh models')}</button></header>
            <p>{chinese ? '保存配置后自动读取一次。清单使用服务端已保存的连接；能力标签来自接口声明，不代表已完成生图验证。' : 'Fetched once after saving. Uses the saved server connection. Capability labels come from the service and do not verify image generation.'}</p>
            <div className="compatible-catalog-times">{catalog.fetched_at && <span>{chinese ? '上次成功：' : 'Last success: '}<time dateTime={catalog.fetched_at}>{timeLabel(catalog.fetched_at)}</time></span>}{catalog.checked_at && <span>{chinese ? '本次尝试：' : 'Last attempt: '}<time dateTime={catalog.checked_at}>{timeLabel(catalog.checked_at)}</time></span>}</div>
            {catalog.error && <div role="status" className="compatible-catalog-error">{catalog.models.length ? (chinese ? '模型清单刷新失败，保留上次成功清单。仍可手动填写模型。' : 'Refresh failed; the last successful catalog is retained. You can still enter a model manually.') : (chinese ? '暂未获取模型清单，仍可手动填写模型。' : 'No model catalog is available. You can still enter a model manually.')}{catalogErrorReason && <span>{catalogErrorReason}</span>}</div>}
            {catalog.models.length > 0 ? <><div className="compatible-catalog-filters"><button type="button" aria-pressed={!showAllModels} onClick={() => setShowAllModels(false)}>{chinese ? '图片 / 未知' : 'Image / unknown'}</button><button type="button" aria-label={chinese ? '显示全部接口模型' : 'Show all API models'} aria-pressed={showAllModels} onClick={() => setShowAllModels(true)}>{chinese ? `全部 (${catalog.models.length})` : `All (${catalog.models.length})`}</button></div><div className="compatible-catalog-list">{discoveredModels.map(model => <button type="button" key={model.id} data-catalog-model={model.id} aria-pressed={config.model === model.id} onClick={() => setConfig(current => current ? { ...current, model: model.id } : current)}><span>{model.id}</span><small className={model.image_generation === true ? 'is-image' : ''}>{model.image_generation === true ? (chinese ? '声明支持生图' : 'Image output declared') : model.image_generation === false ? (chinese ? '声明不支持生图' : 'No image output declared') : (chinese ? '能力未知' : 'Capability unknown')}</small></button>)}</div>{!discoveredModels.length && <p>{chinese ? '接口未声明图片模型，可查看全部模型或手动填写。' : 'No image-capable or unknown models were listed. View all models or enter one manually.'}</p>}</> : !catalogBusy && !catalog.error && <p>{stored ? (chinese ? '尚未读取模型清单，可刷新或手动填写。' : 'No catalog has been fetched. Refresh it or enter a model manually.') : (chinese ? '先保存连接后读取模型清单。' : 'Save this connection before fetching its models.')}</p>}
          </section>
          <label>{chinese ? '可用图片模型' : 'Available image models'}<textarea aria-label={chinese ? '可用图片模型' : 'Available image models'} rows={3} spellCheck={false} value={modelsText} onChange={e => setModelsText(e.target.value)} placeholder={chinese ? '手动补充模型 ID，每行一个' : 'Additional model IDs, one per line'} /><small>{chinese ? '手动补充清单，每行一个完整模型 ID，也可用逗号分隔。接口发现不会覆盖此列表或默认模型；画廊会合并显示。' : 'Add model IDs manually, one per line or separated by commas. Discovery never overwrites this list or the default model; Gallery combines the choices.'}</small></label>
          <label>{chinese ? '默认图片模型（可选）' : 'Default image model (optional)'}<input list="compatible-known-models" value={config.model} spellCheck={false} onChange={e => setConfig({ ...config, model: e.target.value })} placeholder={chinese ? '填写此接口的默认模型 ID' : 'Default model ID for this API'} /><datalist id="compatible-known-models">{modelSuggestions.map(model => <option key={model} value={model} />)}</datalist><small>{chinese ? '填写接口支持的完整模型 ID，也可输入自定义名称。保存新的默认模型会同步本浏览器记忆；画廊仍可单独选择本次模型。Agent 模型在 Agent 配置中分别设置。' : 'Use an exact model ID supported by your service, including custom aliases. Saving a new default also updates this browser’s remembered model; Gallery can still choose a different model for a request. Agent models are configured separately.'}</small></label>
          <label>{chinese ? '请求超时（秒）' : 'Request timeout (seconds)'}<input required type="number" min="1" max="1800" step="1" value={config.timeout} onChange={e => setConfig({ ...config, timeout: Number(e.target.value) })} /><small>{chinese ? '1–1800 秒。超时不会自动重新发送付费请求，也不代表上游已取消任务。' : '1–1800 seconds. A timeout does not automatically resubmit a paid request or confirm upstream cancellation.'}</small></label>
        </div>
        <div className="compatible-request-settings compatible-transport-settings">
          <h5>{chinese ? '传输选项' : 'Transport options'}</h5>
          <label className="compatible-toggle"><span>{chinese ? '流式传输' : 'Streaming'}</span><input aria-label={chinese ? '流式传输' : 'Streaming'} type="checkbox" role="switch" checked={config.stream || false} onChange={e => setConfig({ ...config, stream: e.target.checked })} /><small>{chinese ? '需当前接口与模型支持。开启后按单图任务接收事件；中间预览只用于查看，最终文件以完成事件为准。' : 'Requires support from this service and model. Each image receives its own event stream. Partial previews are temporary; only completion produces the final file.'}</small></label>
          <label>{chinese ? '中间预览图数量' : 'Partial image count'}<select aria-label={chinese ? '中间预览图数量' : 'Partial image count'} disabled={!config.stream} value={config.partial_images || 0} onChange={e => setConfig({ ...config, partial_images: Number(e.target.value) })}>{[0, 1, 2, 3].map(count => <option key={count} value={count}>{count === 0 ? (chinese ? '0 · 不请求' : '0 · None') : count}</option>)}</select><small>{chinese ? '仅流式模式发送 partial_images（0–3）。服务可能返回更少预览；预览可能额外计费，不保证避免超时。' : 'Sends partial_images (0–3) only when streaming. Services may return fewer previews and charge for them; this does not guarantee avoiding timeouts.'}</small></label>
          <label className="compatible-toggle"><span>{chinese ? '返回 Base64 图片数据' : 'Request Base64 image data'}</span><input aria-label={chinese ? '返回 Base64 图片数据' : 'Request Base64 image data'} type="checkbox" role="switch" checked={config.response_format === 'b64_json'} onChange={e => setConfig({ ...config, response_format: e.target.checked ? 'b64_json' : 'auto' })} /><small>{chinese ? '开启后显式发送 response_format: b64_json；关闭时不发送。GPT Image 本身返回 Base64，此项用于需要显式指定的兼容网关，并非所有接口都接受。' : 'Explicitly sends response_format: b64_json when enabled; otherwise omitted. GPT Image already returns Base64. This is for gateways requiring the explicit field; not all endpoints accept it.'}</small></label>
          <p className="muted">{chinese ? '透明背景使用 API 原生参数，在画廊「更多」中设置；这里不做本地去背景。Agent 文本及工具设置独立管理。' : 'Native API transparency is set under Gallery → More. No local background removal is applied here. Agent text and tools remain separately configured.'}</p>
        </div>
        <section className="compatible-endpoints"><h5>{chinese ? 'API 路径与调用方式' : 'API paths and request modes'}</h5>
          <p>{chinese ? '画廊使用 Images API；Agent 使用 Responses API。是否可用取决于当前接口与模型。' : 'Gallery uses the Images API; Agent uses the Responses API. Availability depends on this service and model.'}</p>
          {endpoints ? <dl>{[[chinese ? '文生图' : 'Generate', endpoints.generate], [chinese ? '参考图 / 编辑' : 'Reference / edit', endpoints.edit], ['Agent', endpoints.responses]].map(([label, url]) => <div key={label}><dt>{label}</dt><dd><code>POST {url}</code></dd></div>)}</dl> : <p>{chinese ? '填写有效 Base URL 后显示实际请求路径。' : 'Enter a valid Base URL to preview request paths.'}</p>}
          <p>{chinese ? '多张生成由本地队列拆为单图任务；并发由现有队列统一管理，当前没有每配置的并发开关。' : 'Multiple images are queued as individual jobs. Concurrency is managed by the local queue; no per-profile concurrency setting is available.'}</p>
        </section>
        <p className="muted compatible-provider-note">{chinese ? '密钥仅存于服务端，不进入图库备份。保存后会读取模型清单，不发送生图请求；读取成功不代表已验证生图能力。' : 'Keys stay on the server, outside library backups. Saving reads the model list without generating images; a successful list request does not verify image generation.'}</p>
        <div className="compatible-profile-actions">
          <button type="submit" className="primary">{chinese ? (busy ? '保存中…' : '保存配置') : (busy ? 'Saving…' : 'Save profile')}</button>
          {dirty && <button type="button" className="secondary" onClick={() => choose(storedProfile || newProfile())}>{chinese ? '放弃修改' : 'Discard changes'}</button>}
          {stored && (config.id !== collection?.default_profile_id || !isDefaultConnection) && <button type="button" className="secondary" disabled={dirty || !config.configured} onClick={() => void setDefault()}>{chinese ? '设为默认连接' : 'Use as default connection'}</button>}
          {stored && config.id === collection?.default_profile_id && isDefaultConnection && <span className="compatible-default-status">{chinese ? '当前默认连接' : 'Current default connection'}</span>}
          {stored && <button type="button" className="secondary compatible-profile-delete" disabled={dirty} onClick={() => setDeletePending(true)}><Trash2 size={16} aria-hidden="true" />{chinese ? '删除接口' : 'Delete API'}</button>}
        </div>
        {deletePending && <div className="compatible-profile-confirm" role="group" aria-label={chinese ? '确认删除接口' : 'Confirm API deletion'}><p>{chinese ? `删除「${config.display_name}」及其密钥？已有图片和历史记录会保留。` : `Delete “${config.display_name}” and its key? Existing images and history will remain.`}</p><div className="compatible-profile-actions"><button type="button" className="secondary" onClick={() => setDeletePending(false)}>{chinese ? '取消' : 'Cancel'}</button><button type="button" className="danger" onClick={() => void mutate(() => api.deleteOpenAICompatibleProfile(config.id))}>{chinese ? '确认删除' : 'Delete'}</button></div></div>}
      </fieldset>
    </form>}
    {stored && remembered && <section className="compatible-remembered"><h5>{chinese ? '此配置在本浏览器的生成参数' : 'Remembered generation parameters'}</h5>
      <p>{chinese ? '画廊会分别记住每个配置的参数，下次选择此配置时继续使用。保存新的默认模型只更新记忆中的模型，其余参数保留。' : 'Gallery remembers parameters for each profile and uses them when you select it again. Saving a new default model updates only the remembered model and keeps the other parameters.'}</p>
      <dl>{[[chinese ? '模型' : 'Model', remembered.model || (chinese ? '未选择' : 'Not selected')], [chinese ? '尺寸' : 'Size', remembered.size_mode === 'auto4k' ? (chinese ? '4K 自动比例' : '4K automatic ratio') : remembered.size], [chinese ? '质量' : 'Quality', remembered.quality], [chinese ? '格式' : 'Format', remembered.output_format.toUpperCase()], [chinese ? '背景' : 'Background', remembered.background], [chinese ? '审核' : 'Moderation', remembered.moderation || 'auto'], ...(remembered.output_format !== 'png' && remembered.output_compression !== undefined ? [[chinese ? '压缩质量' : 'Compression', String(remembered.output_compression)]] : [])].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <button type="button" className="secondary" disabled={busy || dirty} onClick={() => setResetPending(true)}>{chinese ? '重置本浏览器参数' : 'Reset browser parameters'}</button>
      {resetPending && <div className="compatible-profile-confirm"><p>{chinese ? '恢复为此配置的默认模型、自动尺寸与质量、PNG；当前画廊输入框中的此配置也会同步更新。提示词和参考图保留。' : 'Restore the profile’s default model, automatic size and quality, and PNG, including the current Gallery composer for this profile. Keep the prompt and references.'}</p><div className="compatible-profile-actions"><button type="button" className="secondary" onClick={() => setResetPending(false)}>{chinese ? '取消' : 'Cancel'}</button><button type="button" className="secondary" disabled={busy || dirty} onClick={resetRecipe}>{chinese ? '确认重置' : 'Reset parameters'}</button></div></div>}
    </section>}
    {message && <p role="status" className="provider-message">{message}</p>}
    {!collection && !busy && <button type="button" className="secondary" onClick={load}>{chinese ? '重新读取接口列表' : 'Reload API profiles'}</button>}
  </section>;
}
