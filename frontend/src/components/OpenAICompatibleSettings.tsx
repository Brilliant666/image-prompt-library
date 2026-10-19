import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2, Server, Copy, GripVertical, ArrowUp, ArrowDown, RefreshCw, ChevronDown, KeyRound } from 'lucide-react';
import { api } from '../api/client';
import { copyApiProfile, reorderApiProfiles } from '../api/profileActions';
import type { OpenAICompatibleProfile, OpenAICompatibleProfiles, UiLanguage } from '../types';
import { compatibleEndpointPreview, profileValidation } from '../utils/profileSettings';
import { readGenerationPreference, resetGenerationPreference } from '../utils/generationPreferences';
import { COMPATIBLE_ENTERPRISE_MODELS, IMAGE25_MODELS, type CompatibleRecipe } from '../utils/compatibleRecipe';
import './OpenAICompatibleSettings.css';

const newProfile = (): OpenAICompatibleProfile => ({ id: crypto.randomUUID(), display_name: '', base_url: '', model: '', timeout: 300, api_key_present: false, configured: false });

export default function OpenAICompatibleSettings({ onSaved, uiLanguage }: { onSaved: () => Promise<void>; uiLanguage: UiLanguage }) {
  const [collection, setCollection] = useState<OpenAICompatibleProfiles>();
  const [config, setConfig] = useState<OpenAICompatibleProfile>();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [deletePending, setDeletePending] = useState(false);
  const [draggedId, setDraggedId] = useState<string>();
  const [listOpen, setListOpen] = useState(false);
  const [remembered, setRemembered] = useState<CompatibleRecipe>();
  const [resetPending, setResetPending] = useState(false);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const chinese = uiLanguage !== 'en';
  const choose = (profile: OpenAICompatibleProfile) => {
    setConfig({ ...profile });
    setApiKey('');
    setMessage('');
    setDeletePending(false);
    setResetPending(false);
    setListOpen(false);
    try { setRemembered(readGenerationPreference(localStorage, profile.id, profile.model)); } catch { setRemembered(undefined); }
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
    load();
    return () => { epoch.current += 1; inFlight.current = false; };
  }, []);

  const mutate = async (operation: () => Promise<OpenAICompatibleProfiles>, nextId?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++epoch.current;
    setBusy(true);
    setMessage('');
    setDeletePending(false);
    try {
      const value = await operation();
      if (request !== epoch.current) return;
      setCollection(value);
      choose(value.profiles.find(p => p.id === nextId) || value.profiles.find(p => p.id === value.default_profile_id) || value.profiles[0] || newProfile());
      window.dispatchEvent(new Event('ipl:agent-config-changed'));
      setMessage(chinese ? '已保存。尚未验证实际调用，不会发送生图请求。' : 'Saved. Actual API calls remain unverified; no image request was sent.');
      // Refresh status independently: a refresh failure must not report a successful save as failed.
      await onSaved().catch(() => undefined);
    } catch {
      // Never display arbitrary service responses, which may contain credentials.
      if (request === epoch.current) setMessage(chinese ? '暂时无法确认操作结果。请重新读取列表核对后再操作。' : 'Could not confirm the result. Reload the profile list before trying again.');
    } finally {
      if (request === epoch.current) { setApiKey(''); inFlight.current = false; setBusy(false); }
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!config) return;
    const issue = profileValidation(config);
    if (issue) {
      setMessage(issue === 'name' ? (chinese ? '请填写配置名称。' : 'Enter a profile name.') : issue === 'url' ? (chinese ? '请填写 HTTP(S) Base URL，不包含密钥、查询参数、片段或 /images/ 接口路径。' : 'Enter an HTTP(S) Base URL without credentials, query parameters, fragments or an /images/ endpoint.') : (chinese ? '超时必须是 1–1800 之间的整数秒。' : 'Timeout must be a whole number from 1 to 1800 seconds.'));
      return;
    }
    const { id, api_key_present: _present, configured: _configured, ...fields } = config;
    void mutate(() => api.saveOpenAICompatibleProfile(id, { ...fields, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) }), id);
  };
  const stored = collection?.profiles.some(p => p.id === config?.id);
  const storedProfile = collection?.profiles.find(p => p.id === config?.id);
  const dirty = Boolean(apiKey || (config && (storedProfile ? JSON.stringify(config) !== JSON.stringify(storedProfile) : config.display_name || config.base_url || config.model || config.timeout !== 300)));
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
  const endpoints = config ? compatibleEndpointPreview(config.base_url) : undefined;

  return <section className="provider-card compatible-provider-settings compatible-profiles">
    <header><h4>{chinese ? 'OpenAI 兼容 API' : 'OpenAI-compatible API'}</h4>
      <p className="muted">{chinese ? '「OpenAI 兼容」是接口类型；配置名称可按服务商或用途命名。每个配置独立保存地址、密钥、模型与超时。' : 'OpenAI-compatible is the API format. Name each connection by service or purpose; each profile keeps its own URL, key, model and timeout.'}</p></header>
    {collection && <>
      <span className="compatible-current-label">{chinese ? '当前编辑配置' : 'Profile to edit'}</span>
      <button type="button" className="compatible-current-profile" aria-expanded={listOpen} aria-controls="compatible-registered-profiles" disabled={busy} onClick={() => setListOpen(value => !value)}>
        <Server size={18} aria-hidden="true" /><span><strong>{config?.display_name || (chinese ? '新配置' : 'New profile')}</strong><small>{config?.id === collection.default_profile_id ? (chinese ? '默认 API 配置' : 'Default API profile') : (chinese ? '独立连接配置' : 'Independent connection')}</small></span><b className="compatible-protocol-badge">OpenAI</b><ChevronDown size={17} aria-hidden="true" className={listOpen ? 'expanded' : ''} />
      </button>
      <div id="compatible-registered-profiles" className="compatible-profile-list" hidden={!listOpen} aria-label={chinese ? '已登记接口' : 'Registered APIs'}>
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
        <label>Base URL<input required type="url" spellCheck={false} value={config.base_url} onChange={e => setConfig({ ...config, base_url: e.target.value })} placeholder="https://api.example.com/v1" /><small>{chinese ? '填写接口根地址；会统一补为一个 /v1。末尾斜杠不改变此规则，请勿填写完整生图路径。' : 'Enter the API base address. One /v1 suffix is applied, including when the address ends with a slash. Do not enter a full image endpoint.'}</small></label>
        <label>API Key<input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={config.api_key_present ? (chinese ? '已保存；留空保留此接口的密钥' : 'Saved; leave blank to keep this API key') : (chinese ? '输入此接口的 API Key' : 'Enter this API key')} /><small className="compatible-key-status"><KeyRound size={12} aria-hidden="true" />{config.api_key_present ? (chinese ? '密钥已保存在服务端，页面不会读取原值' : 'Key saved on the server; its value is never read by this page') : (chinese ? '尚未保存密钥' : 'No saved key')}</small></label>
        <div className="compatible-request-settings">
          <h5>{chinese ? '模型与请求' : 'Model and request'}</h5>
          <label>{chinese ? '默认图片模型（可选）' : 'Default image model (optional)'}<input list="compatible-known-models" value={config.model} spellCheck={false} onChange={e => setConfig({ ...config, model: e.target.value })} placeholder="gpt-image-2.5-sunburst" /><datalist id="compatible-known-models">{['gpt-image-2', ...IMAGE25_MODELS, ...COMPATIBLE_ENTERPRISE_MODELS].map(model => <option key={model} value={model} />)}</datalist><small>{chinese ? '填写接口支持的完整模型 ID，也可输入自定义名称。已有浏览器参数记忆优先；Agent 文本与图片模型在 Agent 配置中分别设置。' : 'Use an exact supported model ID, including custom aliases. Remembered browser parameters take precedence. Agent text and image models are configured separately in Agent settings.'}</small></label>
          <label>{chinese ? '请求超时（秒）' : 'Request timeout (seconds)'}<input required type="number" min="1" max="1800" step="1" value={config.timeout} onChange={e => setConfig({ ...config, timeout: Number(e.target.value) })} /><small>{chinese ? '1–1800 秒。超时不会自动重新发送付费请求，也不代表上游已取消任务。' : '1–1800 seconds. A timeout does not automatically resubmit a paid request or confirm upstream cancellation.'}</small></label>
        </div>
        <details className="compatible-endpoints"><summary>{chinese ? 'API 路径与调用方式' : 'API paths and request modes'}</summary>
          <p>{chinese ? '画廊使用 Images API；Agent 使用 Responses API。是否可用取决于当前接口与模型。' : 'Gallery uses the Images API; Agent uses the Responses API. Availability depends on this service and model.'}</p>
          {endpoints ? <dl>{[[chinese ? '文生图' : 'Generate', endpoints.generate], [chinese ? '参考图 / 编辑' : 'Reference / edit', endpoints.edit], ['Agent', endpoints.responses]].map(([label, url]) => <div key={label}><dt>{label}</dt><dd><code>POST {url}</code></dd></div>)}</dl> : <p>{chinese ? '填写有效 Base URL 后显示实际请求路径。' : 'Enter a valid Base URL to preview request paths.'}</p>}
          <p>{chinese ? '多张生成由本地队列拆为单图任务；并发由现有队列统一管理，当前没有每配置的并发开关。' : 'Multiple images are queued as individual jobs. Concurrency is managed by the local queue; no per-profile concurrency setting is available.'}</p>
        </details>
        <p className="muted compatible-provider-note">{chinese ? '密钥仅存于服务端，不进入图库备份。保存配置只进行本地校验，不代表远端调用成功。' : 'Keys stay on the server, outside library backups. Saving validates the configuration locally and does not verify a remote call.'}</p>
        <div className="compatible-profile-actions">
          <button type="submit" className="primary">{chinese ? (busy ? '保存中…' : '保存配置') : (busy ? 'Saving…' : 'Save profile')}</button>
          {dirty && <button type="button" className="secondary" onClick={() => choose(storedProfile || newProfile())}>{chinese ? '放弃修改' : 'Discard changes'}</button>}
          {stored && config.id !== collection?.default_profile_id && <button type="button" className="secondary" disabled={dirty} onClick={() => void mutate(() => api.defaultOpenAICompatibleProfile(config.id), config.id)}>{chinese ? '设为默认' : 'Set default'}</button>}
          {stored && <button type="button" className="secondary compatible-profile-delete" disabled={dirty} onClick={() => setDeletePending(true)}><Trash2 size={16} aria-hidden="true" />{chinese ? '删除接口' : 'Delete API'}</button>}
        </div>
        {deletePending && <div className="compatible-profile-confirm" role="group" aria-label={chinese ? '确认删除接口' : 'Confirm API deletion'}><p>{chinese ? `删除「${config.display_name}」及其密钥？已有图片和历史记录会保留。` : `Delete “${config.display_name}” and its key? Existing images and history will remain.`}</p><div className="compatible-profile-actions"><button type="button" className="secondary" onClick={() => setDeletePending(false)}>{chinese ? '取消' : 'Cancel'}</button><button type="button" className="danger" onClick={() => void mutate(() => api.deleteOpenAICompatibleProfile(config.id))}>{chinese ? '确认删除' : 'Delete'}</button></div></div>}
      </fieldset>
    </form>}
    {stored && remembered && <details className="compatible-remembered"><summary>{chinese ? '此配置在本浏览器的生成参数' : 'Remembered generation parameters'}</summary>
      <p>{chinese ? '画廊会分别记住每个配置的参数，优先于上方默认图片模型；下次选择此配置时继续使用。' : 'Gallery remembers parameters for each profile and uses them when you select it again. They take precedence over the default model above.'}</p>
      <dl>{[[chinese ? '模型' : 'Model', remembered.model || (chinese ? '未选择' : 'Not selected')], [chinese ? '尺寸' : 'Size', remembered.size_mode === 'auto4k' ? (chinese ? '4K 自动比例' : '4K automatic ratio') : remembered.size], [chinese ? '质量' : 'Quality', remembered.quality], [chinese ? '格式' : 'Format', remembered.output_format.toUpperCase()], [chinese ? '背景' : 'Background', remembered.background], [chinese ? '审核' : 'Moderation', remembered.moderation || 'auto'], ...(remembered.output_format !== 'png' && remembered.output_compression !== undefined ? [[chinese ? '压缩质量' : 'Compression', String(remembered.output_compression)]] : [])].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <button type="button" className="secondary" disabled={busy || dirty} onClick={() => setResetPending(true)}>{chinese ? '重置本浏览器参数' : 'Reset browser parameters'}</button>
      {resetPending && <div className="compatible-profile-confirm"><p>{chinese ? '恢复为此配置的默认模型、自动尺寸与质量、PNG；当前画廊输入框中的此配置也会同步更新。提示词和参考图保留。' : 'Restore the profile’s default model, automatic size and quality, and PNG, including the current Gallery composer for this profile. Keep the prompt and references.'}</p><div className="compatible-profile-actions"><button type="button" className="secondary" onClick={() => setResetPending(false)}>{chinese ? '取消' : 'Cancel'}</button><button type="button" className="secondary" disabled={busy || dirty} onClick={resetRecipe}>{chinese ? '确认重置' : 'Reset parameters'}</button></div></div>}
    </details>}
    {message && <p role="status" className="provider-message">{message}</p>}
    {!collection && !busy && <button type="button" className="secondary" onClick={load}>{chinese ? '重新读取接口列表' : 'Reload API profiles'}</button>}
  </section>;
}
