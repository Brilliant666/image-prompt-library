import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2, Server } from 'lucide-react';
import { api } from '../api/client';
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
  const epoch = useRef(0);
  const chinese = uiLanguage !== 'en';
  const choose = (profile: OpenAICompatibleProfile) => {
    setConfig({ ...profile });
    setApiKey('');
    setMessage('');
    setDeletePending(false);
  };
  useEffect(() => {
    const request = ++epoch.current;
    setBusy(true);
    api.openAICompatibleProfiles().then(value => {
      if (request !== epoch.current) return;
      setCollection(value);
      choose(value.profiles.find(p => p.id === value.default_profile_id) || value.profiles[0] || newProfile());
    }).catch(() => {
      if (request === epoch.current) setMessage(chinese ? '无法读取接口配置，请重新打开设置重试。' : 'Could not load API profiles. Reopen settings to retry.');
    }).finally(() => { if (request === epoch.current) setBusy(false); });
    return () => { epoch.current += 1; };
  }, [chinese]);

  const mutate = async (operation: () => Promise<OpenAICompatibleProfiles>, nextId?: string) => {
    if (busy) return;
    const request = ++epoch.current;
    setBusy(true);
    setMessage('');
    setDeletePending(false);
    try {
      const value = await operation();
      if (request !== epoch.current) return;
      setCollection(value);
      choose(value.profiles.find(p => p.id === nextId) || value.profiles.find(p => p.id === value.default_profile_id) || value.profiles[0] || newProfile());
      setMessage(chinese ? '已保存。尚未验证实际调用，不会发送生图请求。' : 'Saved. Actual API calls remain unverified; no image request was sent.');
      // Refresh status independently: a refresh failure must not report a successful save as failed.
      await onSaved().catch(() => undefined);
    } catch {
      // Never display arbitrary service responses, which may contain credentials.
      if (request === epoch.current) setMessage(chinese ? '操作失败，请检查地址、名称和配置后重试。' : 'Could not save changes. Check the URL, name and settings.');
    } finally {
      if (request === epoch.current) { setApiKey(''); setBusy(false); }
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!config) return;
    const { id, api_key_present: _present, configured: _configured, ...fields } = config;
    void mutate(() => api.saveOpenAICompatibleProfile(id, { ...fields, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) }), id);
  };
  const stored = collection?.profiles.some(p => p.id === config?.id);

  return <section className="provider-card compatible-provider-settings compatible-profiles">
    <header><h4>{chinese ? '第三方 API' : 'Third-party API'}</h4>
      <p className="muted">{chinese ? '登记多个 OpenAI 兼容图片接口，在生成时选择使用哪个接口。每个接口独立保存地址和密钥。' : 'Register multiple OpenAI-compatible image APIs and choose one when generating. Each keeps its own URL and key.'}</p></header>
    {collection && <>
      <div className="compatible-profile-list" aria-label={chinese ? '已登记接口' : 'Registered APIs'}>
        {collection.profiles.map(profile => <button key={profile.id} type="button" className={config?.id === profile.id ? 'compatible-profile-option active' : 'compatible-profile-option'} aria-pressed={config?.id === profile.id} disabled={busy} onClick={() => choose(profile)}>
          <Server size={16} aria-hidden="true" /><span><strong>{profile.display_name}</strong><small>{profile.id === collection.default_profile_id ? (chinese ? '默认接口 · ' : 'Default · ') : ''}{profile.configured ? (chinese ? '配置已完成' : 'Configured') : (chinese ? '配置待完善' : 'Incomplete')}</small></span>
        </button>)}
      </div>
      <button type="button" className="secondary compatible-profile-add" disabled={busy} onClick={() => choose(newProfile())}><Plus size={16} aria-hidden="true" />{chinese ? '添加接口' : 'Add API'}</button>
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
          {stored && config.id !== collection?.default_profile_id && <button type="button" className="secondary" onClick={() => void mutate(() => api.defaultOpenAICompatibleProfile(config.id), config.id)}>{chinese ? '设为默认' : 'Set default'}</button>}
          {stored && <button type="button" className="secondary compatible-profile-delete" onClick={() => setDeletePending(true)}><Trash2 size={16} aria-hidden="true" />{chinese ? '删除接口' : 'Delete API'}</button>}
        </div>
        {deletePending && <div className="compatible-profile-confirm" role="group" aria-label={chinese ? '确认删除接口' : 'Confirm API deletion'}><p>{chinese ? `删除「${config.display_name}」及其密钥？已有图片和历史记录会保留。` : `Delete “${config.display_name}” and its key? Existing images and history will remain.`}</p><div className="compatible-profile-actions"><button type="button" className="secondary" onClick={() => setDeletePending(false)}>{chinese ? '取消' : 'Cancel'}</button><button type="button" className="danger" onClick={() => void mutate(() => api.deleteOpenAICompatibleProfile(config.id))}>{chinese ? '确认删除' : 'Delete'}</button></div></div>}
      </fieldset>
    </form>}
    {message && <p role="status" className="provider-message">{message}</p>}
  </section>;
}
