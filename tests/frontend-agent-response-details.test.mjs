import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const source = await readFile(new URL('../frontend/src/components/agent/AgentResponseDetails.tsx', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const mod = { exports: {} };
const resultSource = await readFile(new URL('../frontend/src/utils/playground/agentAssistantBlocks.ts', import.meta.url), 'utf8');
const resultJs = ts.transpileModule(resultSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const resultModule = { exports: {} };
new Function('require', 'module', 'exports', resultJs)(name => { throw new Error(name); }, resultModule, resultModule.exports);
const dependencies = {
  'react/jsx-runtime': jsxRuntime,
  './AgentResponseDetails.css': {},
  './AgentMarkdown': { AgentMarkdown: ({ text }) => React.createElement('div', null, text) },
  '../../utils/playground/agentAssistantBlocks': resultModule.exports,
};
new Function('require', 'module', 'exports', js)(name => {
  assert.ok(name in dependencies, name); return dependencies[name];
}, mod, mod.exports);
const render = (details, props = {}) => renderToStaticMarkup(React.createElement(mod.exports.AgentResponseDetails, { details, ...props }));
const missing = { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null };
const details = () => ({ version: 1, steps: [], skills: [], usage: { ...missing, reportedSteps: 0, totalSteps: 1, complete: false } });

test('legacy and missing metadata render no empty sections or invented zero counts', () => {
  assert.equal(render(undefined), '');
  assert.equal(render(details()), '');
  const data = details();
  data.steps = [{ id: 'model:1', step: 1, kind: 'model', responseId: null, model: null, usage: missing, summaries: ['  '] }];
  assert.equal(render(data), '');
  const html = render(data, { modelInfo: { providerName: 'QA provider', requestedModel: 'qa-model', returnedModels: [] } });
  assert.match(html, /QA provider/);
  assert.match(html, /qa-model/);
  assert.doesNotMatch(html, /未提供|未记录|未读取|接口用量|公开摘要|高级信息|<dd>0<\/dd>/);
});

test('only reported input and output appear by default and a reported zero is preserved', () => {
  const data = details();
  data.usage = { ...data.usage, inputTokens: 120, outputTokens: 0, totalTokens: 120, complete: true };
  const html = render(data);
  const primary = html.split('<details')[0];
  assert.match(primary, /输入 token<\/dt><dd>120/);
  assert.match(primary, /输出 token<\/dt><dd>0/);
  assert.doesNotMatch(primary, /合计 token|缓存输入|推理 token|未提供/);
  assert.match(html, /<details class="agent-response-advanced"><summary>高级信息/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  data.usage = { ...data.usage, outputTokens: null, totalTokens: null, complete: false };
  const partial = render(data);
  assert.match(partial, /部分调用/);
  assert.doesNotMatch(partial, /输出 token|<dd>0<\/dd>/);
  assert.match(partial, /缓存输入 token<\/dt><dd>未知（接口未提供）/);
});

test('returned model and call budgets stay in collapsed advanced information', () => {
  const html = render(undefined, {
    modelInfo: { providerName: 'QA provider', requestedModel: 'requested-model', returnedModels: ['returned-model'] },
    request: { state: 'completed', usage: { responseStepsStarted: 2, imageJobsCreated: 1 }, authorization: { maxToolRounds: 5, maxImageJobs: 2 } },
  });
  const primary = html.split('<details')[0];
  assert.match(primary, /QA provider/);
  assert.match(primary, /requested-model/);
  assert.doesNotMatch(primary, /returned-model|模型步骤|生成图片|已完成|状态/);
  assert.match(html, /返回模型<\/dt><dd>returned-model/);
  assert.match(html, /模型步骤<\/dt><dd>2 \/ 5/);
  assert.match(html, /已提交<\/dt><dd>1/);
  assert.match(html, /成功<\/dt><dd>未记录/);
  assert.match(html, /本轮上限<\/dt><dd>2/);
});

test('round details count actual jobs, preserve reported cache zero, and show only measured stage durations', () => {
  const data = details(); data.usage = { ...data.usage, inputTokens: 40, cachedInputTokens: 0 };
  const round = {
    id: 'old', requestId: 'old-request', status: 'error', outputTaskIds: ['ok', 'fail'],
    execution: { version: 1, phase: 'failed', timings: { preparationMs: 20, modelResponseMs: 900, toolsMs: 300, resultProcessingMs: null }, modelSteps: [{ step: 1, state: 'completed', preparationMs: 20, headersMs: 100, firstEventMs: 250, responseMs: 900 }] },
  };
  const jobs = [
    { id: 'ok', status: 'accepted' },
    { id: 'fail', status: 'failed', error: '{"secret":"NEVER_RENDER"}', metadata: { failure: { kind: 'quota', message: 'NEVER_RENDER' }, execution: { timings: { queueMs: 50, providerMs: 200, resultWriteMs: null } } } },
    { id: 'unrelated', status: 'succeeded' },
  ];
  const html = render(data, { round, jobs });
  assert.match(html, /已提交<\/dt><dd>2/); assert.match(html, /成功<\/dt><dd>1/); assert.match(html, /失败<\/dt><dd>1/);
  assert.match(html, /缓存输入 token<\/dt><dd>0/); assert.match(html, /推理 token<\/dt><dd>未知（接口未提供）/);
  assert.match(html, /请求至响应头<\/dt><dd>0.100 秒/); assert.match(html, /请求至首个有效事件<\/dt><dd>0.250 秒/);
  assert.match(html, /结果处理<\/dt><dd>未记录/); assert.match(html, /图片接口<\/dt><dd>0.200 秒/);
  assert.match(html, /余额不足 · quota/); assert.doesNotMatch(html, /NEVER_RENDER|secret/);
  const legacy = render(undefined, { round: { ...round, execution: null }, jobs });
  assert.match(legacy, /本地准备<\/dt><dd>未记录/); assert.doesNotMatch(legacy, /0.000 秒/);
});

test('details show reported tokens, attributed skills and public summary without rendering hidden output', () => {
  const data = details();
  data.usage = { inputTokens: 120, outputTokens: 40, totalTokens: 160, cachedInputTokens: 0, reasoningTokens: 10, reportedSteps: 1, totalSteps: 1, complete: true };
  data.steps = [{ id: 'model:1', step: 1, kind: 'model', responseId: 'r', model: 'qa-model', usage: data.usage, summaries: ['公开摘要：比较两种构图。'], content: ['SECRET RAW REASONING'] }];
  data.skills = [{ skill: 'reverse', section: 'general', title: '图片反推', revision: '123456789', license: 'GPL-3.0', source: 'https://github.com/LunarXuan/image-prompt-reverse' }];
  const html = render(data);
  assert.match(html, /<dd>160<\/dd>/);
  assert.match(html, /<dd>0<\/dd>/);
  assert.match(html, /图片反推/);
  assert.match(html, /12345678/);
  assert.match(html, /公开摘要：比较两种构图/);
  assert.doesNotMatch(html, /SECRET RAW REASONING/);
  assert.match(html, /https:\/\/github.com\/LunarXuan\/image-prompt-reverse/);
  const primary = html.split('<details')[0];
  assert.match(primary, /已提供的技能指引/);
  assert.doesNotMatch(primary, /12345678|GPL-3.0|github.com|公开摘要：/);
  assert.match(html, /<details class="agent-response-summary"><summary>公开摘要/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test('transport phases and exact request bytes stay inside collapsed advanced details for each step', () => {
  const round = {
    id: 'transport', requestId: 'transport-request', status: 'done', outputTaskIds: [],
    execution: { version: 1, phase: 'completed', timings: {}, modelSteps: [
      { step: 1, state: 'completed', preparationMs: 20, headersMs: 12500, firstEventMs: 12600, responseMs: 15000,
        connectionMs: 15, tlsMs: 485, uploadMs: 4000, waitHeadersMs: 8000, requestBytes: 3145728 },
      { step: 2, state: 'completed', preparationMs: 5, headersMs: 900, firstEventMs: 950, responseMs: 1300,
        connectionMs: null, tlsMs: null, uploadMs: 0, waitHeadersMs: 800, requestBytes: 2048 },
    ] },
  };
  const html = render(undefined, { round });
  const primary = html.split('<details')[0];
  assert.doesNotMatch(primary, /连接|TLS|上传|请求体大小|3.00 MiB|2.00 KiB/);
  assert.match(html, /<details class="agent-response-advanced"><summary>高级信息/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  const first = html.split('文字模型步骤 1')[1].split('文字模型步骤 2')[0];
  assert.match(first, /连接（含 DNS \/ TCP）<\/dt><dd>0.015 秒/);
  assert.match(first, /TLS 握手<\/dt><dd>0.485 秒/);
  assert.match(first, /上传请求体<\/dt><dd>4.000 秒/);
  assert.match(first, /上传后等待响应头<\/dt><dd>8.000 秒/);
  assert.match(first, /请求体大小<\/dt><dd title="3145728 字节">3.00 MiB/);
  assert.match(first, /请求至响应头<\/dt><dd>12.500 秒/);
  assert.match(first, /请求至首个有效事件<\/dt><dd>12.600 秒/);
  const second = html.split('文字模型步骤 2')[1];
  assert.match(second, /连接（含 DNS \/ TCP）<\/dt><dd>未记录/);
  assert.match(second, /TLS 握手<\/dt><dd>未记录/);
  assert.match(second, /上传请求体<\/dt><dd>0.000 秒/);
  assert.match(second, /上传后等待响应头<\/dt><dd>0.800 秒/);
  assert.match(second, /请求体大小<\/dt><dd title="2048 字节">2.00 KiB/);
  assert.match(html, /不代表服务端已收齐/);
  assert.match(html, /并非纯模型耗时/);
});

test('legacy or partial transport measurements do not invent zero durations or byte counts', () => {
  const step = { step: 1, state: 'interrupted', preparationMs: 20, headersMs: null, firstEventMs: null, responseMs: 1500 };
  const round = {
    id: 'legacy', requestId: 'legacy-request', status: 'error', outputTaskIds: [],
    execution: { version: 1, phase: 'unknown', timings: {}, modelSteps: [step] },
  };
  const legacy = render(undefined, { round });
  for (const label of ['连接（含 DNS / TCP）', 'TLS 握手', '上传请求体', '上传后等待响应头', '请求体大小']) {
    assert.ok(legacy.includes(`${label}</dt><dd>未记录</dd>`), label);
  }
  assert.doesNotMatch(legacy, /0.000 秒|>0 B</);
  Object.assign(step, { connectionMs: 10, tlsMs: null, uploadMs: null, waitHeadersMs: null, requestBytes: null });
  const partial = render(undefined, { round });
  assert.match(partial, /连接（含 DNS \/ TCP）<\/dt><dd>0.010 秒/);
  assert.match(partial, /上传后等待响应头<\/dt><dd>未记录/);
  assert.match(partial, /请求体大小<\/dt><dd>未记录/);
  step.requestBytes = 0;
  assert.match(render(undefined, { round }), /请求体大小<\/dt><dd title="0 字节">0 B/);
  for (const invalid of [-1, NaN, Infinity, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
    step.requestBytes = invalid;
    assert.match(render(undefined, { round }), /请求体大小<\/dt><dd>未记录/);
  }
});

test('several sections of the same skill have one compact skill name and retain source details', () => {
  const data = details();
  data.skills = ['overview', 'analysis'].map(section => ({ skill: 'reverse', section, title: '图片反推', revision: '123456789', license: 'GPL-3.0', source: 'https://github.com/LunarXuan/image-prompt-reverse' }));
  const html = render(data);
  assert.equal((html.split('<details')[0].match(/图片反推/g) || []).length, 1);
  assert.match(html, /基础规范/);
  assert.match(html, /图像分析/);
});

test('untrusted skill sources and text cannot create active HTML or javascript links', () => {
  const data = details();
  data.skills = [{ skill: 'x', section: '<img src=x onerror=alert(1)>', title: '<script>bad()</script>', revision: 'abc', license: 'MIT', source: 'javascript:alert(1)' }];
  const html = render(data);
  assert.doesNotMatch(html, /href=|<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  data.skills[0].source = 'https://user:password@github.com/example/skill';
  assert.doesNotMatch(render(data), /href=|user:password/);
});
