import type { AgentModelInfo, AgentRequest, AgentResponseDetails as Details, AgentTokenUsage, AgentRound } from '../../api/agentClient';
import type { GenerationJobRecord } from '../../types';
import { getAgentFailure, getAgentJobFailure, getAgentRoundSummary } from '../../utils/playground/agentAssistantBlocks';
import { AgentMarkdown } from './AgentMarkdown';
import './AgentResponseDetails.css';

const tokenFields: Array<[keyof AgentTokenUsage, string]> = [
  ['inputTokens', '输入 token'], ['outputTokens', '输出 token'], ['totalTokens', '合计 token'],
  ['cachedInputTokens', '缓存输入 token'], ['reasoningTokens', '推理 token'],
];
const sectionNames: Record<string, string> = { overview: '基础规范', analysis: '图像分析', illustration: '插画风格', composition: '构图', editing: '图片编辑', text: '文字排版' };
const reportedCount = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const missingUsage: AgentTokenUsage = { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null };
function sourceLink(source: string) {
  // Skill sources are curated server metadata, never tool-provided HTML.
  try { const url = new URL(source); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

function TokenRows({ usage, fields, showMissing = false }: { usage: AgentTokenUsage; fields: typeof tokenFields; showMissing?: boolean }) {
  return fields.flatMap(([field, label]) => reportedCount(usage[field]) ? [<div key={field}><dt>{label}</dt><dd>{usage[field].toLocaleString()}</dd></div>] : showMissing ? [<div key={field}><dt>{label}</dt><dd>未知（接口未提供）</dd></div>] : []);
}

const duration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${(value / 1000).toFixed(3)} 秒` : '未记录';
function requestSize(value: number | null | undefined) {
  if (!reportedCount(value)) return '未记录';
  if (value < 1024) return `${value} B`;
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(2)} KiB` : `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}
const timingFields = [['preparationMs', '本地准备'], ['modelResponseMs', '文字模型请求'], ['toolsMs', '工具执行（含图片等待）'], ['resultProcessingMs', '结果处理']] as const;
const transportTimingFields = [['connectionMs', '连接（含 DNS / TCP）'], ['tlsMs', 'TLS 握手'], ['uploadMs', '上传请求体'], ['waitHeadersMs', '上传后等待响应头']] as const;
const jobTimingFields = [['queueMs', '队列等待'], ['preparationMs', '图片准备'], ['providerMs', '图片接口'], ['resultWriteMs', '图片结果写入']] as const;

export function AgentResponseDetails({ details, modelInfo, request, round, jobs = [], terminalObservationMs }: {
  details?: Details;
  modelInfo?: AgentModelInfo;
  request?: AgentRequest | null;
  round?: AgentRound;
  jobs?: GenerationJobRecord[];
  terminalObservationMs?: number;
}) {
  const summaries = details?.steps.flatMap(step => step.summaries.filter(text => text.trim()).map(text => ({ id: step.id, step: step.step, text }))) || [];
  const skills = details?.skills || [];
  const skillNames = [...new Set(skills.map(skill => skill.title))];
  const hasUsage = Boolean(details && tokenFields.slice(0, 2).some(([field]) => reportedCount(details.usage[field])));
  const extraUsage = Boolean(details && tokenFields.slice(2).some(([field]) => reportedCount(details.usage[field])));
  const steps = details?.steps.filter(step => step.model || tokenFields.some(([field]) => reportedCount(step.usage[field]))) || [];
  const returnedModels = modelInfo?.returnedModels || [];
  const summary = round ? getAgentRoundSummary(round, jobs, request) : undefined;
  const roundJobs = round ? jobs.filter(job => round.outputTaskIds.includes(job.id)) : [];
  const hasAdvanced = Boolean(returnedModels.length || request || hasUsage || extraUsage || steps.length || skills.length || round);
  if (!modelInfo?.providerName && !modelInfo?.requestedModel && !hasUsage && !skillNames.length && !summaries.length && !hasAdvanced) return null;

  return <div className="agent-response-details">
    {(modelInfo?.providerName || modelInfo?.requestedModel) && <dl className="agent-response-identity">
      {modelInfo.providerName && <div><dt>供应商</dt><dd>{modelInfo.providerName}</dd></div>}
      {modelInfo.requestedModel && <div><dt>请求模型</dt><dd>{modelInfo.requestedModel}</dd></div>}
    </dl>}
    {hasUsage && details && <section aria-label="接口用量">
      <div className="agent-response-heading"><h4>用量</h4>{!details.usage.complete && <span>部分调用</span>}</div>
      <dl><TokenRows usage={details.usage} fields={tokenFields.slice(0, 2)} /></dl>
    </section>}
    {skillNames.length > 0 && <section aria-label="本轮提供的技能指引"><h4>已提供的技能指引</h4><p>{skillNames.join('、')}</p></section>}
    {summaries.length > 0 && <details className="agent-response-summary"><summary>公开摘要</summary>
      {summaries.map((summary, index) => <div key={`${summary.id}:${index}`}>{summaries.length > 1 && <p className="agent-help">模型步骤 {summary.step}</p>}<AgentMarkdown text={summary.text} /></div>)}
    </details>}
    {hasAdvanced && <details className="agent-response-advanced"><summary>高级信息</summary>
      {(returnedModels.length > 0 || request) && <dl>
        {returnedModels.length > 0 && <div><dt>返回模型</dt><dd>{returnedModels.join('、')}</dd></div>}
        {request && <div><dt>模型步骤</dt><dd>{request.usage.responseStepsStarted} / {request.authorization.maxToolRounds}</dd></div>}
      </dl>}
      {(summary || request) && <section aria-label="图片任务数量"><h4>图片任务</h4><dl>
        <div><dt>已提交</dt><dd>{summary?.imageJobsCreated ?? request?.usage.imageJobsCreated ?? '未记录'}</dd></div>
        <div><dt>成功</dt><dd>{summary?.imageJobsSucceeded ?? '未记录'}</dd></div>
        <div><dt>失败</dt><dd>{summary?.imageJobsFailed ?? '未记录'}</dd></div>
        <div><dt>本轮上限</dt><dd>{summary?.maxImageJobs ?? request?.authorization.maxImageJobs ?? '未记录'}</dd></div>
        {Boolean(summary?.imageJobsAccepted) && <div><dt>其中已收录</dt><dd>{summary!.imageJobsAccepted}</dd></div>}
        {Boolean(summary?.imageJobsCancelled) && <div><dt>已取消</dt><dd>{summary!.imageJobsCancelled}</dd></div>}
        {Boolean(summary?.imageJobsDiscarded) && <div><dt>结果已清理</dt><dd>{summary!.imageJobsDiscarded}</dd></div>}
        {Boolean(summary?.imageJobsMissing) && <div><dt>任务已移除</dt><dd>{summary!.imageJobsMissing}</dd></div>}
      </dl></section>}
      {returnedModels.length > 0 && <p className="agent-help">返回模型为接口报告的名称。</p>}
      {round?.contextDiagnostics && <section aria-label="上下文回执"><h4>上下文回执</h4>
        <dl>
          <div><dt>请求范围</dt><dd>{({ task: '当前任务（自动）', selected: '指定历史', branch: '完整分支' } as Record<string, string>)[round.contextDiagnostics.contextScope || ''] || '未记录'}</dd></div>
          <div><dt>请求附图次数</dt><dd>{reportedCount(round.contextDiagnostics.attachedImageOccurrences) ? round.contextDiagnostics.attachedImageOccurrences : '未记录'}</dd></div>
          <div><dt>带入历史轮次</dt><dd>{reportedCount(round.contextDiagnostics.includedHistoryRoundCount) ? round.contextDiagnostics.includedHistoryRoundCount : '未记录'}</dd></div>
          {round.contextDiagnostics.fallbackReason && <div><dt>扩大范围原因</dt><dd>{round.contextDiagnostics.fallbackReason}</dd></div>}
        </dl>
        {Boolean(round.contextDiagnostics.pixelBindings?.length) && <ol>{round.contextDiagnostics.pixelBindings!.map((binding, index) => <li key={`${binding.ref}:${index}`}>{binding.ref} · {binding.role}</li>)}</ol>}
        {Boolean(round.contextDiagnostics.bindingsOmitted) && <p>其余 {round.contextDiagnostics.bindingsOmitted} 条绑定未展开。</p>}
        <p className="agent-help">来自后端最近一次文字请求的组装回执，图片次数包括必要的重复绑定；连接失败时不代表上游已收齐。此处不使用输入框候选列表推算。</p>
      </section>}
      {round?.taskContext && <section aria-label="任务来源信息"><h4>任务来源</h4><dl>
        <div><dt>任务身份</dt><dd>{round.taskContext.taskId}</dd></div>
        <div><dt>任务版本</dt><dd>{round.taskContext.revision}</dd></div>
        <div><dt>状态</dt><dd>{round.taskContext.completeness}</dd></div>
      </dl>{round.taskContext.historyDependencies.length > 0 && <ul>{round.taskContext.historyDependencies.map((entry, index) => <li key={`${entry.roundId}:${index}`}>{entry.roundId} · {entry.reason}</li>)}</ul>}</section>}
      {(round || details && (hasUsage || extraUsage || steps.length > 0)) && <dl><TokenRows usage={details?.usage || missingUsage} fields={hasUsage ? tokenFields.slice(2) : tokenFields} showMissing /></dl>}
      {round?.failure && <dl><div><dt>请求诊断</dt><dd>{getAgentFailure(round.failure.kind).label} · {getAgentFailure(round.failure.kind).kind}</dd></div></dl>}
      {round && <section aria-label="阶段耗时"><h4>阶段耗时</h4>
        <dl>{timingFields.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{duration(round.execution?.timings[field])}</dd></div>)}</dl>
        <dl><div><dt>本页面发送至收到终态</dt><dd>{duration(terminalObservationMs)}</dd></div></dl>
        {terminalObservationMs !== undefined && <p className="agent-help">本页面的观察耗时包含服务端执行与状态传输，不是额外网络耗时，也不能与下方阶段相加。</p>}
        {(round.execution?.modelSteps || []).map(step => <div className="agent-response-step" key={step.step}>
          <p>文字模型步骤 {step.step}</p><dl>
            <div><dt>本地准备</dt><dd>{duration(step.preparationMs)}</dd></div>
            <div><dt>请求至响应头</dt><dd>{duration(step.headersMs)}</dd></div>
            <div><dt>请求至首个有效事件</dt><dd>{duration(step.firstEventMs)}</dd></div>
            <div><dt>模型请求整体</dt><dd>{duration(step.responseMs)}</dd></div>
            {transportTimingFields.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{duration(step[field])}</dd></div>)}
            <div><dt>请求体大小</dt><dd title={reportedCount(step.requestBytes) ? `${step.requestBytes} 字节` : undefined}>{requestSize(step.requestBytes)}</dd></div>
          </dl>
        </div>)}
        <p className="agent-help">响应头和首个事件是同一次请求的时间节点，不能相加。工具执行包含图片排队与调用，不能再与图片耗时相加。</p>
        {Boolean(round.execution?.modelSteps.length) && <p className="agent-help">上传耗时是客户端写入时间，不代表服务端已收齐；之后等待响应头包含网络与上游处理，并非纯模型耗时。</p>}
        {roundJobs.map((job, index) => {
          const execution = job.metadata?.execution as { timings?: Record<string, unknown> } | undefined;
          const failure = ['failed', 'unknown'].includes(job.status) ? getAgentJobFailure(job) : null;
          return <div className="agent-response-step" key={job.id}><p>图片任务 {index + 1}</p><dl>
            {jobTimingFields.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{duration(execution?.timings?.[field])}</dd></div>)}
            {failure && <div><dt>诊断分类</dt><dd>{failure.label} · {failure.kind}</dd></div>}
          </dl>{job.provider === 'agent_native' && <p className="agent-help">原生图片耗时仅记录图像工具事件至有效终态的观察区间；未收到工具事件时无法单独测量，不能用 Responses 总耗时代替。</p>}</div>;
        })}
      </section>}
      {steps.length > 0 && <section aria-label="各次调用"><h4>各次调用</h4>{steps.map(step => <div className="agent-response-step" key={step.id}>
        <p>模型步骤 {step.step}{step.kind === 'native_image' ? ' · 图片调用' : ''}{step.model ? ` · ${step.model}` : ''}</p>
        <dl><TokenRows usage={step.usage} fields={tokenFields.slice(0, 3)} /></dl>
      </div>)}</section>}
      {skills.length > 0 && <section aria-label="技能来源"><h4>技能来源</h4><ul>{skills.map(skill => <li key={`${skill.skill}:${skill.section}:${skill.revision}`}>
        <span>{skill.title} · {sectionNames[skill.section] || skill.section}</span>
        <small>{skill.revision.slice(0, 8)} · {skill.license}{sourceLink(skill.source) && <> · <a href={sourceLink(skill.source)} target="_blank" rel="noopener noreferrer">来源</a></>}</small>
      </li>)}</ul></section>}
    </details>}
  </div>;
}
