import type { AgentModelInfo, AgentRequest, AgentResponseDetails as Details, AgentTokenUsage } from '../../api/agentClient';
import { AgentMarkdown } from './AgentMarkdown';
import './AgentResponseDetails.css';

const tokenFields: Array<[keyof AgentTokenUsage, string]> = [
  ['inputTokens', '输入 token'], ['outputTokens', '输出 token'], ['totalTokens', '合计 token'],
  ['cachedInputTokens', '缓存输入 token'], ['reasoningTokens', '推理 token'],
];
const sectionNames: Record<string, string> = { overview: '基础规范', analysis: '图像分析', illustration: '插画风格', composition: '构图', editing: '图片编辑', text: '文字排版' };
const reportedCount = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function sourceLink(source: string) {
  // Skill sources are curated server metadata, never tool-provided HTML.
  try { const url = new URL(source); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

function TokenRows({ usage, fields }: { usage: AgentTokenUsage; fields: typeof tokenFields }) {
  return fields.flatMap(([field, label]) => reportedCount(usage[field]) ? [<div key={field}><dt>{label}</dt><dd>{usage[field].toLocaleString()}</dd></div>] : []);
}

export function AgentResponseDetails({ details, modelInfo, request }: {
  details?: Details;
  modelInfo?: AgentModelInfo;
  request?: AgentRequest | null;
}) {
  const summaries = details?.steps.flatMap(step => step.summaries.filter(text => text.trim()).map(text => ({ id: step.id, step: step.step, text }))) || [];
  const skills = details?.skills || [];
  const skillNames = [...new Set(skills.map(skill => skill.title))];
  const hasUsage = Boolean(details && tokenFields.slice(0, 2).some(([field]) => reportedCount(details.usage[field])));
  const extraUsage = Boolean(details && tokenFields.slice(2).some(([field]) => reportedCount(details.usage[field])));
  const steps = details?.steps.filter(step => step.model || tokenFields.some(([field]) => reportedCount(step.usage[field]))) || [];
  const returnedModels = modelInfo?.returnedModels || [];
  const hasAdvanced = Boolean(returnedModels.length || request || extraUsage || steps.length || skills.length);
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
    {skillNames.length > 0 && <section aria-label="本轮使用的技能"><h4>使用的技能</h4><p>{skillNames.join('、')}</p></section>}
    {summaries.length > 0 && <details className="agent-response-summary"><summary>公开摘要</summary>
      {summaries.map((summary, index) => <div key={`${summary.id}:${index}`}>{summaries.length > 1 && <p className="agent-help">模型步骤 {summary.step}</p>}<AgentMarkdown text={summary.text} /></div>)}
    </details>}
    {hasAdvanced && <details className="agent-response-advanced"><summary>高级信息</summary>
      {(returnedModels.length > 0 || request) && <dl>
        {returnedModels.length > 0 && <div><dt>返回模型</dt><dd>{returnedModels.join('、')}</dd></div>}
        {request && <><div><dt>模型步骤</dt><dd>{request.usage.responseStepsStarted} / {request.authorization.maxToolRounds}</dd></div><div><dt>生成图片</dt><dd>{request.usage.imageJobsCreated} / {request.authorization.maxImageJobs}</dd></div></>}
      </dl>}
      {returnedModels.length > 0 && <p className="agent-help">返回模型为接口报告的名称。</p>}
      {extraUsage && details && <dl><TokenRows usage={details.usage} fields={tokenFields.slice(2)} /></dl>}
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
