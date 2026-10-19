import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AgentApiError, getAgentConfig, saveAgentConfig, type AgentConfig, type AgentConfigResponse } from '../../api/agentClient';
import type { UiLanguage } from '../../types';

export default function AgentSettings({ uiLanguage, active }: { uiLanguage: UiLanguage; active: boolean }) {
  const en = uiLanguage === 'en';
  const [saved, setSaved] = useState<AgentConfigResponse>();
  const [form, setForm] = useState<AgentConfig>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const dirty = Boolean(saved && form && JSON.stringify(saved.config) !== JSON.stringify(form));
  const load = async () => {
    if (inFlight.current || dirty) return;
    inFlight.current = true;
    const request = ++epoch.current;
    controller.current = new AbortController();
    setBusy(true); setMessage('');
    try {
      const value = await getAgentConfig(controller.current.signal);
      if (request === epoch.current) { setSaved(value); setForm({ ...value.config }); }
    } catch {
      if (request === epoch.current) setMessage(en ? 'Could not load Agent settings. Check the local service and reload.' : '无法读取 Agent 配置，请检查本地服务后重新读取。');
    } finally {
      if (request === epoch.current) { inFlight.current = false; setBusy(false); }
    }
  };
  useEffect(() => { if (active) void load(); }, [active]);
  useEffect(() => () => { epoch.current += 1; controller.current?.abort(); inFlight.current = false; }, []);
  const change = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => {
    setForm(current => current ? { ...current, [key]: value } : current); setMessage('');
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !form || !saved) return;
    inFlight.current = true;
    const request = ++epoch.current;
    controller.current = new AbortController();
    setBusy(true); setMessage('');
    try {
      const value = await saveAgentConfig(saved.revision, form, controller.current.signal);
      if (request !== epoch.current) return;
      setSaved(value); setForm({ ...value.config });
      window.dispatchEvent(new Event('ipl:agent-config-changed'));
      setMessage(en ? 'Settings saved locally. No model request was sent.' : '已保存本地配置，没有发送模型请求。');
    } catch (error) {
      if (request === epoch.current) setMessage(error instanceof AgentApiError && error.status === 409
        ? en ? 'Settings changed in another window. Discard these edits and reload before saving.' : '配置已在其他窗口更新。请放弃本次修改并重新读取后再保存。'
        : en ? 'Could not confirm the save. Keep your edits and check the local service.' : '暂时无法确认保存结果，请保留当前修改并检查本地服务。');
    } finally {
      if (request === epoch.current) { inFlight.current = false; setBusy(false); }
    }
  };
  const profileField = (key: 'textProfileId' | 'imageProfileId', label: string) => <label className="settings-field">
    <span>{label}</span><select value={form?.[key] || ''} onChange={event => change(key, event.target.value || null)}>
      <option value="">{en ? 'Choose an API profile' : '请选择 API 配置'}</option>
      {form?.[key] && !saved?.profiles.some(profile => profile.id === form[key]) && <option value={form[key] || ''}>{en ? 'Previously selected profile is unavailable' : '原先选择的配置已不可用'}</option>}
      {saved?.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.display_name}{!profile.configured ? en ? ' · incomplete' : ' · 待完善' : ''}</option>)}
    </select>
  </label>;
  return <section className="setting-group agent-settings">
    <h3>{en ? 'Agent configuration' : 'Agent 配置'}</h3>
    <p className="muted">{en ? 'Use the API profiles registered in API settings. Keys remain on the server. Saving settings does not run the Agent.' : '使用「API 配置」中的接口，密钥保留在服务端。保存配置不会运行 Agent。'}</p>
    {saved && <div className="settings-status" role="status">
      <strong>{saved.ready ? en ? 'Configuration complete' : '配置完整' : en ? 'Configuration needs attention' : '配置待完善'}</strong>
      <p>{en ? 'Configuration is not proof of a successful provider call.' : '配置完整不代表实际调用已验证成功。'}</p>
      {saved.issues.length > 0 && <p>{en ? 'Check the selected API profiles and model names before starting a conversation.' : '开始对话前请检查所选接口、模型名称及运行方式。'}</p>}
    </div>}
    {form && saved && <form onSubmit={save} autoComplete="off"><fieldset disabled={busy}>
      <label className="settings-field settings-field-row"><span>{en ? 'Independent API configuration' : '使用独立的 API 配置'}</span>
        <select value={form.apiConfigMode} onChange={event => change('apiConfigMode', event.target.value as AgentConfig['apiConfigMode'])}>
          <option value="off" disabled={!saved.capabilities.modes.includes('off')}>{en ? 'Current API' : '关闭'}</option>
          <option value="native" disabled={!saved.capabilities.modes.includes('native')}>{en ? 'Native' : '原生'}</option>
          <option value="hybrid" disabled={!saved.capabilities.modes.includes('hybrid')}>{en ? 'Hybrid' : '混合'}</option>
        </select>
      </label>
      <p className="settings-help">{en ? 'Current API follows the profile selected in the workspace. Native uses Responses with image generation. Hybrid uses a text model and a separate image API.' : '关闭时跟随工作区当前接口。原生通过 Responses 的生图工具生成图片；混合由文本模型调用独立图片接口。'}</p>
      {form.apiConfigMode !== 'off' && profileField('textProfileId', en ? 'Text model API profile' : '文本模型 API 配置')}
      <label className="settings-field"><span>{en ? 'Text / reasoning model' : '文本 / 推理模型'}</span><input value={form.textModel} maxLength={120} spellCheck={false} onChange={event => change('textModel', event.target.value)} placeholder={en ? 'Full model ID supported by this API' : '此接口支持的完整模型 ID'} /></label>
      <p className="settings-help">{en ? 'The selected endpoint must support the Responses API. Model names are never silently replaced.' : '所选接口必须支持 Responses API；模型名称不会自动替换。'}</p>
      {form.apiConfigMode === 'hybrid' && profileField('imageProfileId', en ? 'Image model API profile' : '图片模型 API 配置')}
      <label className="settings-field"><span>{en ? 'Image model' : '图片模型'}</span><input value={form.imageModel} maxLength={120} spellCheck={false} onChange={event => change('imageModel', event.target.value)} placeholder={en ? 'Full image model ID' : '完整图片模型 ID'} /></label>
      <label className="settings-field settings-field-row"><span>{en ? 'Reasoning effort' : '推理强度'}</span><select value={form.reasoningEffort || ''} onChange={event => change('reasoningEffort', (event.target.value || null) as AgentConfig['reasoningEffort'])}>
        <option value="">{en ? 'Provider default' : '接口默认'}</option>{['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <div className="settings-field-grid">
        <label className="settings-field"><span>{en ? 'Maximum tool rounds' : '最大工具调用轮数'}</span><input type="number" min={1} max={saved.capabilities.maxToolRounds} required value={form.maxToolRounds} onChange={event => change('maxToolRounds', Number(event.target.value))} /></label>
        <label className="settings-field"><span>{en ? 'Maximum image jobs per request' : '每次请求最多生图任务'}</span><input type="number" min={1} max={saved.capabilities.maxImageJobs} required value={form.maxImageJobs} onChange={event => change('maxImageJobs', Number(event.target.value))} /></label>
      </div>
      <div className="settings-preference"><label className="settings-switch-row"><span>{en ? 'Streaming response' : '流式响应'}</span><input type="checkbox" role="switch" checked={form.stream} onChange={event => change('stream', event.target.checked)} /></label></div>
      <label className="settings-field settings-field-row"><span>{en ? 'Partial image previews' : '生成中预览图数量'}</span><select value={form.partialImages} onChange={event => change('partialImages', Number(event.target.value) as AgentConfig['partialImages'])}>{[0, 1, 2, 3].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <div className="settings-preference"><label className="settings-switch-row"><span>{en ? 'Web search' : '网络搜索'}</span><input type="checkbox" role="switch" disabled={!saved.capabilities.webSearch} checked={form.webSearch} onChange={event => change('webSearch', event.target.checked)} /></label><p className="settings-help">{en ? 'Allow web search when you explicitly authorize a conversation request. Provider charges may apply.' : '在你明确授权的对话请求中允许网络搜索，可能消耗接口额度。'}</p></div>
      <div className="settings-preference"><label className="settings-switch-row"><span>{en ? 'Math formatting instructions' : '公式格式提示'}</span><input type="checkbox" role="switch" checked={form.mathFormattingPrompt} onChange={event => change('mathFormattingPrompt', event.target.checked)} /></label><p className="settings-help">{en ? 'Ask the text model to format mathematical expressions consistently.' : '提示文本模型使用统一的数学公式格式。'}</p></div>
      <div className="agent-settings-actions"><button type="submit" className="primary">{busy ? en ? 'Saving…' : '保存中…' : en ? 'Save Agent settings' : '保存 Agent 配置'}</button>
        {dirty && <button type="button" className="secondary" onClick={() => { setForm({ ...saved.config }); setMessage(''); }}>{en ? 'Discard changes' : '放弃修改'}</button>}
      </div>
    </fieldset></form>}
    {message && <p className="provider-message" role="status">{message}</p>}
    <div className="agent-settings-actions"><button type="button" className="secondary" disabled={busy || dirty} onClick={() => void load()}>{busy && !saved ? en ? 'Loading…' : '读取中…' : en ? 'Reload settings' : '重新读取配置'}</button></div>
  </section>;
}
