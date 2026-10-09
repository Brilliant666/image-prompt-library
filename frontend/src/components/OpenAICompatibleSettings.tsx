import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { OpenAICompatibleConfig, UiLanguage } from '../types';

export default function OpenAICompatibleSettings({ onSaved, uiLanguage }: { onSaved: () => Promise<void>; uiLanguage: UiLanguage }) {
  const [config, setConfig] = useState<OpenAICompatibleConfig>();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const chinese = uiLanguage !== 'en';
  useEffect(() => {
    let cancelled = false;
    api.openAICompatibleConfig().then(value => { if (!cancelled) setConfig(value); })
      .catch(() => { if (!cancelled) setMessage(chinese ? '无法读取供应商配置。' : 'Could not load provider settings.'); });
    return () => { cancelled = true; };
  }, [chinese]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!config || busy) return;
    setBusy(true);
    setMessage('');
    const { api_key_present: _present, ...fields } = config;
    try {
      setConfig(await api.saveOpenAICompatibleConfig({ ...fields, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) }));
      setApiKey('');
      await onSaved();
      setMessage(chinese ? '已保存。保存配置不会发送生图请求。' : 'Saved. Saving settings does not generate an image.');
    } catch {
      // Do not render server responses here: a malformed upstream error may contain secrets.
      setMessage(chinese ? '保存失败，请检查地址、模型和配置。' : 'Save failed. Check the URL, model and settings.');
    } finally {
      setApiKey('');
      setBusy(false);
    }
  };
  return <form className="provider-card" onSubmit={save} autoComplete="off">
    <h4>OpenAI compatible API</h4>
    {config && <>
      <label>{chinese ? '显示名称' : 'Display name'}<input required value={config.display_name} onChange={e => setConfig({ ...config, display_name: e.target.value })} /></label>
      <label>Base URL<input required type="url" value={config.base_url} onChange={e => setConfig({ ...config, base_url: e.target.value })} placeholder="https://api.example.com/v1" /></label>
      <label>API Key<input type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={config.api_key_present ? (chinese ? '已保存；留空保持不变' : 'Saved; leave blank to keep') : (chinese ? '输入 API Key' : 'Enter API key')} /></label>
      <label>{chinese ? '图片模型' : 'Image model'}<input required value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} /></label>
      <label>{chinese ? '请求超时（秒）' : 'Request timeout (seconds)'}<input required type="number" min="1" max="1800" value={config.timeout} onChange={e => setConfig({ ...config, timeout: Number(e.target.value) })} /></label>
      <p className="muted">{chinese ? '凭据仅保存到服务端的独立配置中，不进入图库备份。此供应商仅用于图片生成，标题可手动填写。' : 'Credentials are saved in separate server configuration outside library backups. This provider generates images; enter titles manually.'}</p>
      <button type="submit" className="secondary" disabled={busy}>{chinese ? (busy ? '保存中…' : '保存供应商') : (busy ? 'Saving…' : 'Save provider')}</button>
    </>}
    {message && <p role="status" className="provider-message">{message}</p>}
  </form>;
}
