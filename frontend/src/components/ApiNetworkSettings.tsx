import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { ApiNetworkMode, UiLanguage } from '../types';
import { safeProxyEndpoint } from '../utils/apiNetwork';
import ToolbarSelect from './ToolbarSelect';
import './ApiNetworkSettings.css';

interface Props {
  uiLanguage: UiLanguage;
  mode: ApiNetworkMode;
  proxyUrl: string;
  proxyUrlPresent: boolean;
  proxyEndpoint?: string;
  removeProxy: boolean;
  disabled?: boolean;
  onModeChange: (mode: ApiNetworkMode) => void;
  onProxyUrlChange: (value: string) => void;
  onRemoveProxyChange: (remove: boolean) => void;
}

const labels = {
  zh_hans: {
    title: '网络连接', direct: '直连（默认）', environment: '跟随运行环境', proxy: '指定代理',
    scope: '作用于运行本项目的电脑或服务器。',
    directHelp: '直连不改写系统路由。Windows 自动确认物理出口；无法确认时会报错。',
    environmentHelp: '沿用运行环境的代理、VPN 或部署配置。',
    proxyLabel: '代理地址', proxyHelp: '支持 HTTP / HTTPS / SOCKS5 / SOCKS5H，可包含账号密码。留空保留已保存地址。',
    saved: '已保存', show: '显示代理地址', hide: '隐藏代理地址', clear: '清除已保存代理', undo: '撤销清除',
    clearing: '保存后清除代理地址。',
  },
  zh_hant: {
    title: '網路連線', direct: '直連（預設）', environment: '跟隨執行環境', proxy: '指定代理',
    scope: '作用於執行本專案的電腦或伺服器。',
    directHelp: '直連不改寫系統路由。Windows 自動確認實體出口；無法確認時會報錯。',
    environmentHelp: '沿用執行環境的代理、VPN 或部署設定。',
    proxyLabel: '代理位址', proxyHelp: '支援 HTTP / HTTPS / SOCKS5 / SOCKS5H，可包含帳號密碼。留空保留已儲存位址。',
    saved: '已儲存', show: '顯示代理位址', hide: '隱藏代理位址', clear: '清除已儲存代理', undo: '復原清除',
    clearing: '儲存後清除代理位址。',
  },
  en: {
    title: 'Network connection', direct: 'Direct (default)', environment: 'Follow runtime environment', proxy: 'Use a proxy',
    scope: 'Applies to the computer or server running this application.',
    directHelp: 'Direct mode does not change system routes. Windows selects a confirmed physical connection, or reports an error if none can be confirmed.',
    environmentHelp: 'Use the runtime environment’s proxy, VPN or deployment configuration.',
    proxyLabel: 'Proxy address', proxyHelp: 'Supports HTTP / HTTPS / SOCKS5 / SOCKS5H, including credentials. Leave blank to keep the saved address.',
    saved: 'Saved', show: 'Show proxy address', hide: 'Hide proxy address', clear: 'Clear saved proxy', undo: 'Undo removal',
    clearing: 'The proxy address will be removed when you save.',
  },
};

export default function ApiNetworkSettings({ uiLanguage, mode, proxyUrl, proxyUrlPresent, proxyEndpoint, removeProxy, disabled = false, onModeChange, onProxyUrlChange, onRemoveProxyChange }: Props) {
  const text = labels[uiLanguage];
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const modeBeforeRemoval = useRef<ApiNetworkMode | undefined>(undefined);
  useEffect(() => { if (!proxyUrl) setRevealed(false); }, [proxyUrl]);
  useEffect(() => { if (!removeProxy) modeBeforeRemoval.current = undefined; }, [removeProxy]);
  const endpoint = safeProxyEndpoint(proxyEndpoint);
  const toggleProxyRemoval = () => {
    if (removeProxy) {
      if (modeBeforeRemoval.current !== undefined) onModeChange(modeBeforeRemoval.current);
      modeBeforeRemoval.current = undefined;
    } else {
      modeBeforeRemoval.current = mode;
      if (mode === 'proxy') onModeChange('direct');
    }
    onRemoveProxyChange(!removeProxy);
    onProxyUrlChange('');
  };
  return <section className="api-network-settings" aria-labelledby={`${id}-title`}>
    <div className="api-network-heading"><h5 id={`${id}-title`}>{text.title}</h5>
      <ToolbarSelect value={mode} options={(['direct', 'environment', 'proxy'] as const).map(value => ({ value, label: text[value] }))}
        label={text.title} disabled={disabled} onChange={value => {
          // A later explicit choice must survive undoing the proxy removal.
          modeBeforeRemoval.current = undefined;
          onModeChange(value);
        }} />
    </div>
    <p className="api-network-help">{text.scope} {mode === 'direct' ? text.directHelp : mode === 'environment' ? text.environmentHelp : ''}</p>
    {mode === 'proxy' && <div className="api-network-proxy">
      <label htmlFor={`${id}-proxy`}>{text.proxyLabel}</label>
      <div className="api-network-secret"><input id={`${id}-proxy`} aria-label={text.proxyLabel} type={revealed ? 'text' : 'password'}
        value={proxyUrl} maxLength={2048} autoComplete="new-password" spellCheck={false} autoCapitalize="none" disabled={disabled}
        placeholder={proxyUrlPresent && !removeProxy ? `${text.saved}${endpoint ? ` · ${endpoint}` : ''}` : 'http://127.0.0.1:8080'}
        onChange={event => { onProxyUrlChange(event.target.value); if (event.target.value.trim()) onRemoveProxyChange(false); }} />
        <button type="button" className="secondary" aria-label={revealed ? text.hide : text.show} aria-pressed={revealed} disabled={disabled || !proxyUrl} onClick={() => setRevealed(value => !value)}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button>
      </div>
      <p className="api-network-help">{text.proxyHelp}</p>
    </div>}
    {proxyUrlPresent && <div className="api-network-clear">
      <button type="button" className="secondary" disabled={disabled} onClick={toggleProxyRemoval}>{removeProxy ? text.undo : text.clear}</button>
      {removeProxy && <span role="status">{text.clearing}</span>}
    </div>}
  </section>;
}
