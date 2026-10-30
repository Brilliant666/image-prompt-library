import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../frontend/src/utils/playground/agentAssistantBlocks.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function('module', 'exports', compiled)(module, module.exports);
const api = module.exports;

test('result presentation carries the sanitized provider reason instead of raw job errors', () => {
  const detail = '供应商说明：Input image did not pass the safety check. 错误码：moderation_blocked；审核阶段：输入。';
  const job = { status: 'failed', error: 'RAW_PRIVATE_VALUE', metadata: { failure: { kind: 'moderation', detail, reasonProvided: true } } };
  const view = api.getAgentJobFailure(job);
  assert.equal(view.detail, detail);
  assert.equal(view.label, '供应商审核拒绝');
  assert.doesNotMatch(JSON.stringify(view), /RAW_PRIVATE_VALUE/);
  assert.match(api.getAgentJobFailure({ status: 'failed', metadata: { failure: { kind: 'moderation' } } }).detail, /未提供更具体/);
  const unknown = api.getAgentJobFailure({ ...job, status: 'unknown' });
  assert.equal(unknown.label, '图片结果未知');
  assert.match(unknown.action, /不要重复生成/);
});

test('known pre-connect configuration failure is not presented as an unfinished image job', () => {
  const failure = { kind: 'configuration', outcomeUnknown: false, detail: '无法确认 Windows 物理直连出口，本次请求尚未提交。' };
  const round = { id: 'round', status: 'error', outputTaskIds: [], failure };
  const text = api.getAgentRoundStatus(round, { requestState: 'failed', outcomeUnknown: false, imageJobsCreated: 0 });
  assert.match(text, /配置需要检查.*Windows.*尚未提交/);
  assert.doesNotMatch(text, /图片请求未完成/);
  assert.equal(api.getAgentImageProgress(round, []), null, 'no fictitious image progress without jobs or image calls');
  const calls = { ...round, responseOutput: [{ type: 'function_call', name: 'generate_image_batch', call_id: 'call' }] };
  assert.match(api.getAgentImageProgress(calls, []).text, /Windows.*尚未提交/);
});

test('request cards preserve failure identity, exclude jobs and never infer moderation from prose', () => {
  const base = { id: 'round', requestId: 'original', status: 'error', outputTaskIds: [],
    failure: { kind: 'unknown', outcomeUnknown: false, detail: 'moderation_blocked in an unclassified explanation' } };
  assert.equal(api.getAgentRequestFailure(base).label, '本次请求未完成');
  assert.equal(api.getAgentRequestFailure({ ...base, failure: { kind: 'request_too_large', outcomeUnknown: false } }).label, '请求内容过大');
  assert.equal(api.getAgentRequestFailure({ ...base, failure: { kind: 'moderation', outcomeUnknown: false } }, { id: 'another', state: 'running' }).label, '供应商审核拒绝', 'another request cannot change this historical failure');
  for (const patch of [
    { outputTaskIds: ['missing-job'] }, { retryTaskIds: ['retry-job'] },
    { failure: { kind: 'moderation', outcomeUnknown: true } },
    { resultSummary: { requestState: 'failed', outcomeUnknown: true } },
    { status: 'running' }, { failure: null },
  ]) assert.equal(api.getAgentRequestFailure({ ...base, ...patch }), null);
  for (const state of ['queued', 'running', 'waiting_for_jobs', 'unknown', 'stop_requested', 'stopped'])
    assert.equal(api.getAgentRequestFailure(base, { id: 'original', state }), null, state);
});
