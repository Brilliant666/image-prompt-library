import { useEffect, useRef, useState } from 'react';
import { Copy, Link, Trash2 } from 'lucide-react';
import type { UiLanguage } from '../types';
import { copyTextToClipboard } from '../utils/clipboard';
import './browser-capture-settings.css';

interface Client { client_id: string; extension_id: string; name: string; created_at: string }
interface Pairing extends Client { token: string; instance_id: string; target_origin: string }

async function pairingRequest<T>(path = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/capture-clients${path}`, {
    credentials: 'same-origin', redirect: 'error', ...init,
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.status === 204 ? undefined as T : response.json();
}

export default function BrowserCaptureSettings({ uiLanguage }: { uiLanguage: UiLanguage }) {
  const en = uiLanguage === 'en';
  const [extensionId, setExtensionId] = useState(() => new URLSearchParams(location.search).get('capture_pair') || '');
  const [name, setName] = useState('Chrome');
  const [clients, setClients] = useState<Client[]>([]);
  const [pairing, setPairing] = useState<Pairing>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const section = useRef<HTMLElement>(null);
  const active = useRef(true);
  const load = async () => {
    const result = await pairingRequest<{ clients: Client[] }>();
    if (active.current) setClients(result.clients);
  };
  useEffect(() => {
    active.current = true;
    load().catch(() => { if (active.current) setMessage(en ? 'Pairing is available on localhost only. Check the local service.' : '配对仅在 localhost 本地服务可用，请检查连接。'); });
    if (new URLSearchParams(location.search).has('capture_pair')) section.current?.scrollIntoView({ block: 'start' });
    return () => { active.current = false; };
  }, []);

  const authorize = async () => {
    if (busy || !/^[a-p]{32}$/.test(extensionId)) return;
    setBusy(true); setMessage(''); setPairing(undefined);
    try {
      const result = await pairingRequest<Pairing>('', { method: 'POST', body: JSON.stringify({ extension_id: extensionId, name }) });
      if (active.current) setPairing(result);
      await load();
    } catch { if (active.current) setMessage(en ? 'Pairing failed. Refresh the list before trying again.' : '配对未完成，请先刷新列表确认后再试。'); }
    finally { if (active.current) setBusy(false); }
  };
  const copy = async () => {
    if (!pairing) return;
    const copied = await copyTextToClipboard(JSON.stringify({ version: 1, base_url: pairing.target_origin,
      extension_id: pairing.extension_id, instance_id: pairing.instance_id, client_id: pairing.client_id, token: pairing.token }));
    setMessage(copied ? (en ? 'Copied. Paste into the extension connection settings.' : '已复制，请粘贴到插件的连接设置。') : (en ? 'Clipboard unavailable. Allow clipboard access and try again.' : '无法复制，请允许剪贴板写入后重试。'));
  };
  const revoke = async (clientId: string) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      await pairingRequest(`/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
      if (pairing?.client_id === clientId) setPairing(undefined);
      await load();
      if (active.current) setMessage(en ? 'Pairing revoked.' : '配对已撤销。');
    } catch { if (active.current) setMessage(en ? 'Could not revoke pairing. Refresh and try again.' : '撤销未完成，请刷新后重试。'); }
    finally { if (active.current) setBusy(false); }
  };

  return <section ref={section} className="setting-group browser-capture-settings" aria-labelledby="capture-pairing-heading">
    <h3 id="capture-pairing-heading"><Link size={18} />{en ? 'Browser capture' : '浏览器快捷收录'}</h3>
    <p className="muted">{en ? 'Authorize a browser extension to save images and prompts to this local library. It cannot browse the library or use generation accounts.' : '授权浏览器插件向此本地图库收录图片与提示词。插件不能浏览整个图库或使用生图账号。'}</p>
    <p className="capture-instance">{location.origin}</p>
    <label>{en ? 'Extension ID' : '扩展 ID'}<input value={extensionId} onChange={event => setExtensionId(event.target.value.trim())} maxLength={32} placeholder={en ? '32 letters from a to p' : '32 位扩展 ID（a–p 字母）'} autoComplete="off" spellCheck={false} /></label>
    <label>{en ? 'Name' : '配对名称'}<input value={name} onChange={event => setName(event.target.value)} maxLength={80} /></label>
    <button className="secondary" type="button" disabled={busy || !/^[a-p]{32}$/.test(extensionId)} onClick={() => void authorize()}>{en ? 'Authorize capture only' : '授权此扩展收录'}</button>
    {pairing && <div className="capture-pairing-ready">
      <p>{en ? 'Pairing created. Copy the secret once; it is not displayed or included in library backups.' : '配对已创建。请复制配对信息到插件；秘密不显示，也不进入图库备份。'}</p>
      <button type="button" className="secondary" onClick={() => void copy()}><Copy size={16} />{en ? 'Copy pairing information' : '复制配对信息'}</button>
      <button type="button" className="ghost" onClick={() => setPairing(undefined)}>{en ? 'Hide' : '收起'}</button>
    </div>}
    <ul className="capture-clients">{clients.map(client => <li key={client.client_id}>
      <div><strong>{client.name}</strong><code>{client.extension_id}</code></div>
      <button className="iconbtn" type="button" disabled={busy} onClick={() => void revoke(client.client_id)} aria-label={`${en ? 'Revoke' : '撤销'} ${client.name}`} title={en ? 'Revoke pairing' : '撤销配对'}><Trash2 size={17} /></button>
    </li>)}</ul>
    <button type="button" className="ghost" disabled={busy} onClick={() => void load().catch(() => setMessage(en ? 'Cannot load pairings.' : '无法读取配对列表。'))}>{en ? 'Refresh pairings' : '刷新配对列表'}</button>
    {message && <p role="status" className="muted">{message}</p>}
  </section>;
}
