import type { UiLanguage } from '../../types';
import type { LocalPreferences } from '../../utils/localPreferences';

export default function GeneralSettings({ value, onChange, uiLanguage }: {
  value: LocalPreferences;
  onChange: (value: LocalPreferences) => void;
  uiLanguage: UiLanguage;
}) {
  const en = uiLanguage === 'en';
  const options: [keyof LocalPreferences, string, string][] = [
    ['clearInputAfterSubmit', en ? 'Clear input after submitting' : '提交任务后清空输入框', en ? 'Clear the prompt and references only after a task has been created successfully.' : '成功创建任务后清空提示词与参考图；提交失败时保留输入。'],
    ['persistInputOnRestart', en ? 'Restore input after reopening' : '重启后加载上次的输入框', en ? 'Keep the composer draft on this browser. Turn off to start with an empty composer next time.' : '在此浏览器保存输入草稿。关闭后不再持久化，下次打开使用空输入框。'],
    ['notifyOnCompletion', en ? 'Show completion notices' : '任务完成时显示通知', en ? 'Show a notice inside this page when a task finishes. No system notification permission is requested.' : '任务结束时在当前页面显示提示，不申请系统通知权限。'],
  ];
  return <section className="setting-group local-preferences-settings">
    <h3>{en ? 'Input and workflow' : '输入与使用习惯'}</h3>
    <p className="muted">{en ? 'Saved only in this browser, for Gallery and Agent. Browser capture drafts are unaffected.' : '仅保存在当前浏览器，作用于画廊与 Agent；不会清空浏览器收录插件的草稿。'}</p>
    <label className="settings-field settings-field-row"><span>{en ? 'Submit shortcut' : '任务提交方式'}</span>
      <select value={value.enterSubmit ? 'enter' : 'ctrl-enter'} onChange={event => onChange({ ...value, enterSubmit: event.target.value === 'enter' })}>
        <option value="ctrl-enter">Ctrl / ⌘ + Enter</option><option value="enter">Enter</option>
      </select>
    </label>
    <p className="settings-help">{en ? 'With Enter submission, Shift + Enter inserts a new line. Composition input never submits.' : '选择 Enter 提交时，Shift + Enter 换行；输入法组字期间不会提交。'}</p>
    {options.map(([key, label, help]) => <div className="settings-preference" key={key}>
      <label className="settings-switch-row"><span>{label}</span><input type="checkbox" role="switch" checked={value[key]} onChange={event => onChange({ ...value, [key]: event.target.checked })} /></label>
      <p className="settings-help">{help}</p>
    </div>)}
  </section>;
}
