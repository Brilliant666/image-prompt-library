import type { ApiNetworkMode, ApiNetworkUpdate, UiLanguage } from '../types';

export interface ApiNetworkDraft { proxyUrl: string; removeProxy: boolean }
export type ApiNetworkIssue = 'proxy_required' | 'proxy_url';

export function apiNetworkMode(value: unknown): ApiNetworkMode {
  return value === 'environment' || value === 'proxy' ? value : 'direct';
}

function parseProxy(value: string): URL | undefined {
  const text = value.trim();
  if (!text || text.length > 2048 || /[^\x21-\x7e]/.test(text) || text.includes('\\')) return;
  try {
    const url = new URL(text);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname
      || url.search || url.hash || !['', '/'].includes(url.pathname)
      || url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) return;
    return url;
  } catch { return; }
}

/** Never put user info or an arbitrary server value into a saved-endpoint label. */
export function safeProxyEndpoint(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = parseProxy(value);
  return url ? `${url.protocol}//${url.host}` : '';
}

export function apiNetworkIssue(mode: ApiNetworkMode, draft: ApiNetworkDraft, proxyPresent: boolean): ApiNetworkIssue | undefined {
  if (draft.proxyUrl.trim() && !parseProxy(draft.proxyUrl)) return 'proxy_url';
  if (mode === 'proxy' && !draft.proxyUrl.trim() && (!proxyPresent || draft.removeProxy)) return 'proxy_required';
}

/** A blank input preserves the server secret. Removal is always explicit. */
export function apiNetworkPayload(mode: ApiNetworkMode, draft: ApiNetworkDraft): ApiNetworkUpdate {
  const proxy = draft.proxyUrl.trim();
  return { network_mode: mode, ...(proxy ? { proxy_url: proxy } : draft.removeProxy ? { remove_proxy_url: true } : {}) };
}

export function apiNetworkErrorMessage(issue: ApiNetworkIssue, language: UiLanguage): string {
  if (language === 'en') return issue === 'proxy_required'
    ? 'Enter a proxy address or choose another connection mode.'
    : 'Enter an HTTP, HTTPS, SOCKS5 or SOCKS5H proxy URL with a valid host and port, without a path, query or fragment. Encode non-ASCII credentials in the URL.';
  if (language === 'zh_hant') return issue === 'proxy_required'
    ? '請填寫代理位址，或選擇其他連線方式。'
    : '請填寫 HTTP、HTTPS、SOCKS5 或 SOCKS5H 代理位址，使用有效主機與連接埠，不含路徑、查詢或片段；非 ASCII 帳號密碼需 URL 編碼。';
  return issue === 'proxy_required'
    ? '请填写代理地址，或选择其他连接方式。'
    : '请填写 HTTP、HTTPS、SOCKS5 或 SOCKS5H 代理地址，使用有效主机与端口，不含路径、查询或片段；非 ASCII 账号密码需 URL 编码。';
}
