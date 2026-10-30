import { useEffect, useRef, useState } from 'react';
import type { AgentEditingTask, AgentEditingTaskInput, AgentReferenceRole } from '../../api/agentClient';
import { referenceKey, type ReferenceChoice } from '../../utils/playground/agentImageReferences';
import ToolbarSelect from '../ToolbarSelect';
import { AgentActionDialog } from './AgentActionDialog';

const roles = [{ value: '', label: '不作为辅助参考' }, { value: 'lighting', label: '光线参考' }, { value: 'style', label: '风格参考' }, { value: 'subject', label: '主体参考' }, { value: 'composition', label: '构图参考' }, { value: 'other', label: '其他参考' }];
export default function AgentEditingTaskDialog({ task, choices, onSave, onClose }: {
  task?: AgentEditingTask | null; choices: ReferenceChoice[];
  onSave: (value: AgentEditingTaskInput | null) => Promise<void>; onClose: () => void;
}) {
  const [target, setTarget] = useState(task?.target ? referenceKey(task.target.source) : '');
  const [auxiliaries, setAuxiliaries] = useState<Record<string, AgentReferenceRole | ''>>(() => Object.fromEntries((task?.auxiliaries || []).map(row => [referenceKey(row.source), row.role])));
  const [requirements, setRequirements] = useState(task?.requirements || '');
  const [constraints, setConstraints] = useState((task?.constraints || []).join('\n'));
  const [workflow, setWorkflow] = useState<AgentEditingTaskInput['workflow']>(task?.workflow || 'auto');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const selected = choices.find(choice => referenceKey(choice.reference) === target);
  async function save(end = false) {
    if (inFlight.current || !end && (!selected || selected.missing)) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await onSave(end ? null : {
        target: selected!.reference,
        auxiliaries: choices.filter(choice => referenceKey(choice.reference) !== target && auxiliaries[referenceKey(choice.reference)]).map(choice => ({ ref: choice.reference, role: auxiliaries[referenceKey(choice.reference)] as AgentReferenceRole })),
        requirements, constraints: constraints.split('\n').map(value => value.trim()).filter(Boolean), workflow,
      });
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '未保存当前编辑任务'); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  return <AgentActionDialog title="当前编辑任务" onClose={onClose}>
    <div className="agent-action-body">
      <p className="agent-action-help">绑定本会话当前分支的图片与要求。保存或结束任务不调用模型，也不清空输入框和附件。</p>
      {task?.needsTargetSelection && <p role="status">有多张候选图片，请明确选择编辑对象，再设置其他图片的作用。</p>}
      <label>编辑对象<ToolbarSelect label="当前编辑对象" value={target} options={[{ value: '', label: '请选择要修改的图片', disabled: true }, ...choices.map(choice => ({ value: referenceKey(choice.reference), label: `${choice.label}${choice.missing ? ' · 不可用' : ''}`, disabled: choice.missing }))]} disabled={busy} onChange={setTarget} /></label>
      {selected?.url && <div className="agent-task-image"><img src={selected.url} alt="当前编辑对象预览" /><span>{selected.label}</span></div>}
      {choices.filter(choice => referenceKey(choice.reference) !== target).map(choice => <div key={referenceKey(choice.reference)} className="agent-task-reference">
        <div className="agent-task-image">{choice.url && <img src={choice.url} alt={`${choice.label}预览`} />}<span>{choice.label}</span></div>
        <ToolbarSelect label={`${choice.label}的参考作用`} value={auxiliaries[referenceKey(choice.reference)] || ''} options={roles} disabled={busy || choice.missing} onChange={role => setAuxiliaries(old => ({ ...old, [referenceKey(choice.reference)]: role as AgentReferenceRole | '' }))} />
      </div>)}
      <label>当前修改要求<textarea aria-label="当前修改要求" value={requirements} disabled={busy} onChange={event => setRequirements(event.target.value)} /></label>
      <label>已经确认的约束（每行一条）<textarea aria-label="已经确认的约束" value={constraints} disabled={busy} onChange={event => setConstraints(event.target.value)} placeholder="例如：保持人物姿势\n只修改背景" /></label>
      <label>专业工作流<ToolbarSelect label="编辑任务专业工作流" value={workflow} options={[{ value: 'auto', label: '按任务选择' }, { value: 'gpt-image', label: 'GPT Image 提示词与编辑' }, { value: 'image-prompt-reverse', label: '图片反推提示词' }]} disabled={busy} onChange={value => setWorkflow(value as AgentEditingTaskInput['workflow'])} /></label>
      {task?.configIdentity && <p className="agent-action-help">任务记录的生图模型：{task.configIdentity.imageModel || '接口默认'}。下一次发送仍会按当前选定配置确认，已提交请求不受影响。</p>}
      {error && <p className="agent-action-error" role="alert">{error}</p>}
    </div>
    <footer><button type="button" disabled={busy} onClick={() => void save(true)}>结束当前编辑任务</button><button type="button" onClick={onClose}>取消</button><button type="button" className="agent-action-primary" disabled={busy || !selected || selected.missing} onClick={() => void save()}>保存任务</button></footer>
  </AgentActionDialog>;
}
