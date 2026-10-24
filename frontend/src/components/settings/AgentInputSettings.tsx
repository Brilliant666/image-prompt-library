import { useEffect, useState } from 'react';
import { AGENT_INPUT_PREFERENCES_EVENT, readAgentInputPreferences, saveAgentInputPreferences, type AgentInputPreferences } from '../../utils/agentInputPreferences';

export default function AgentInputSettings({ en }: { en: boolean }) {
  const [value, setValue] = useState(readAgentInputPreferences);
  const [error, setError] = useState(false);
  useEffect(() => {
    const refresh = () => setValue(readAgentInputPreferences());
    window.addEventListener(AGENT_INPUT_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(AGENT_INPUT_PREFERENCES_EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  function change(next: AgentInputPreferences) {
    const saved = saveAgentInputPreferences(next);
    setError(!saved);
    if (saved) setValue(next);
  }
  return <div className="settings-preference-group">
    <h4>{en ? 'Agent conversations' : 'Agent 对话'}</h4>
    <label className="settings-field settings-field-row"><span>{en ? 'Send shortcut' : '消息发送方式'}</span>
      <select aria-label={en ? 'Agent send shortcut' : 'Agent 消息发送方式'} value={value.enterSubmit ? 'enter' : 'ctrl-enter'} onChange={event => change({ ...value, enterSubmit: event.target.value === 'enter' })}>
        <option value="enter">Enter</option><option value="ctrl-enter">Ctrl / ⌘ + Enter</option>
      </select>
    </label>
    <p className="settings-help">{en ? 'Enter sends by default; Shift + Enter inserts a new line. Composition input never sends. Gallery settings are separate.' : '默认 Enter 发送，Shift + Enter 换行；输入法组字期间不会发送。与画廊设置独立。'}</p>
    <label className="settings-switch-row"><span>{en ? 'Clear Agent input after sending' : '发送后清空 Agent 输入框'}</span><input type="checkbox" role="switch" checked={value.clearInputAfterSubmit} onChange={event => change({ ...value, clearInputAfterSubmit: event.target.checked })} /></label>
    <p className="settings-help">{en ? 'Clear only the sent text and references after acceptance. Image parameters stay unchanged; failed or uncertain submissions keep the draft.' : '成功受理后清空已发送的文字和参考图，保留图片参数；失败或提交结果不确定时保留草稿。'}</p>
    {error && <p role="alert">{en ? 'Could not save this browser preference.' : '未能保存浏览器偏好，请检查浏览器存储权限。'}</p>}
  </div>;
}
