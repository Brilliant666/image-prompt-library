import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2, Server, Copy, GripVertical, ArrowUp, ArrowDown, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { copyApiProfile, reorderApiProfiles } from '../api/profileActions';
import type { OpenAICompatibleProfile, OpenAICompatibleProfiles, UiLanguage } from '../types';
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
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const chinese = uiLanguage !== 'en';
  const choose = (profile: OpenAICompatibleProfile) => {
    setConfig({ ...profile });
    setApiKey('');
    setMessage('');
    setDeletePending(false);
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

  return <section className="provider-card compatible-provider-settings compatible-profiles">
    <header><h4>{chinese ? '第三方 API' : 'Third-party API'}</h4>
      <p className="muted">{chinese ? '登记 OpenAI 兼容接口供生图或 Agent 使用；每个配置独立保存地址和密钥。拖动或使用箭头调整顺序。' : 'Register OpenAI-compatible APIs for images or Agent. Each profile keeps its own URL and key. Drag or use the arrows to reorder.'}</p></header>
    {collection && <>
      <div className="compatible-profile-list" aria-label={chinese ? '已登记接口' : 'Registered APIs'}>
        {collection.profiles.map((profile, index) => <div key={profile.id} className={`compatible-profile-row${draggedId === profile.id ? ' dragging' : ''}`}
          draggable={!busy && !dirty} onDragStart={event => { setDraggedId(profile.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', profile.id); }}
          onDragOver={event => { if (draggedId && !busy && !dirty) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
          onDrop={event => { event.preventDefault(); if (draggedId) move(draggedId, profile.id); setDraggedId(undefined); }} onDragEnd={() => setDraggedId(undefined)}>
          <GripVertical className="compatible-profile-grip" size={16} aria-hidden="true" />
          <button type="button" className={config?.id === profile.id ? 'compatible-profile-option active' : 'compatible-profile-option'} aria-pressed={config?.id === profile.id} disabled={busy || dirty && config?.id !== profile.id} onClick={() => { if (!dirty) choose(profile); }}>
            <Server size={16} aria-hidden="true" /><span><strong>{profile.display_name}</strong><small>{profile.id === collection.default_profile_id ? (chinese ? '默认接口 · ' : 'Default · ') : ''}{profile.configured ? (chinese ? '配置已完成 · 未验证调用' : 'Configured · call unverified') : (chinese ? '配置待完善' : 'Incomplete')}</small></span>
          </button>
          <div className="compatible-profile-order"><button type="button" aria-label={`${chinese ? '上移' : 'Move up'} ${profile.display_name}`} disabled={busy || dirty || index === 0} onClick={() => move(profile.id, collection.profiles[index - 1].id)}><ArrowUp size={14} /></button>
            <button type="button" aria-label={`${chinese ? '下移' : 'Move down'} ${profile.display_name}`} disabled={busy || dirty || index === collection.profiles.length - 1} onClick={() => move(profile.id, collection.profiles[index + 1].id)}><ArrowDown size={14} /></button></div>
        </div>)}
      </div>
      <div className="compatible-profile-toolbar"><button type="button" className="secondary compatible-profile-add" disabled={busy || dirty} onClick={() => choose(newProfile())}><Plus size={16} aria-hidden="true" />{chinese ? '添加接口' : 'Add API'}</button>
        <button type="button" className="secondary" disabled={busy || dirty || !stored} onClick={copy}><Copy size={15} aria-hidden="true" />{chinese ? '复制配置' : 'Duplicate'}</button>
        <button type="button" className="secondary" disabled={busy || dirty} onClick={load} aria-label={chinese ? '重新读取接口列表' : 'Reload API profiles'}><RefreshCw size={15} aria-hidden="true" /></button>
      </div>
      {dirty && <p className="settings-help">{chinese ? '当前有未保存更改；保存或放弃后可切换、复制及排序。' : 'Save or discard your changes before switching, duplicating or reordering.'}</p>}
    </>}
    {config && <form className="compatible-profile-form" onSubmit={save} autoComplete="off">
      <fieldset disabled={busy}>
        <legend>{stored ? (chinese ? '编辑接口' : 'Edit API') : (chinese ? '新接口' : 'New API')}</legend>
        <label>{chinese ? '接口名称' : 'API name'}<input required maxLength={100} value={config.display_name} onChange={e => setConfig({ ...config, display_name: e.target.value })} placeholder={chinese ? '例如：我的图片服务' : 'For example: My image service'} /><small>{chinese ? '用于区分你的多个接口，生成菜单中显示此名称。' : 'Identifies this API in the generation menu.'}</small></label>
        <label>Base URL<input required type="url" value={config.base_url} onChange={e => setConfig({ ...config, base_url: e.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label>API Key<input type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={config.api_key_present ? (chinese ? '已保存；留空保留此接口的密钥' : 'Saved; leave blank to keep this API key') : (chinese ? '输入此接口的 API Key' : 'Enter this API key')} /></label>
        <label>{chinese ? '默认图片模型（可选）' : 'Default image model (optional)'}<input value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} placeholder="gpt-image-2.5-sunburst" /><small>{chinese ? '填写该接口支持的完整模型 ID。生成时可以覆盖；留空则每次生成前选择模型。' : 'Use a full model ID supported by this API. Override it per request, or leave blank and choose before generating.'}</small></label>
        <label>{chinese ? '请求超时（秒）' : 'Request timeout (seconds)'}<input required type="number" min="1" max="1800" value={config.timeout} onChange={e => setConfig({ ...config, timeout: Number(e.target.value) })} /></label>
        <p className="muted compatible-provider-note">{chinese ? '密钥仅存于服务端，不进入图库备份。配置完成不代表实际调用成功。标题可手动填写。' : 'Keys stay on the server, outside library backups. Configured does not mean an API call has succeeded. Enter titles manually.'}</p>
        <div className="compatible-profile-actions">
          <button type="submit" className="primary">{chinese ? (busy ? '保存中…' : '保存接口') : (busy ? 'Saving…' : 'Save API')}</button>
          {dirty && <button type="button" className="secondary" onClick={() => choose(storedProfile || newProfile())}>{chinese ? '放弃修改' : 'Discard changes'}</button>}
          {stored && config.id !== collection?.default_profile_id && <button type="button" className="secondary" disabled={dirty} onClick={() => void mutate(() => api.defaultOpenAICompatibleProfile(config.id), config.id)}>{chinese ? '设为默认' : 'Set default'}</button>}
          {stored && <button type="button" className="secondary compatible-profile-delete" disabled={dirty} onClick={() => setDeletePending(true)}><Trash2 size={16} aria-hidden="true" />{chinese ? '删除接口' : 'Delete API'}</button>}
        </div>
        {deletePending && <div className="compatible-profile-confirm" role="group" aria-label={chinese ? '确认删除接口' : 'Confirm API deletion'}><p>{chinese ? `删除「${config.display_name}」及其密钥？已有图片和历史记录会保留。` : `Delete “${config.display_name}” and its key? Existing images and history will remain.`}</p><div className="compatible-profile-actions"><button type="button" className="secondary" onClick={() => setDeletePending(false)}>{chinese ? '取消' : 'Cancel'}</button><button type="button" className="danger" onClick={() => void mutate(() => api.deleteOpenAICompatibleProfile(config.id))}>{chinese ? '确认删除' : 'Delete'}</button></div></div>}
      </fieldset>
    </form>}
    {message && <p role="status" className="provider-message">{message}</p>}
    {!collection && !busy && <button type="button" className="secondary" onClick={load}>{chinese ? '重新读取接口列表' : 'Reload API profiles'}</button>}
  </section>;
}
