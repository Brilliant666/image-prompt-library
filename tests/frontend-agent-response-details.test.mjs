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
const dependencies = {
  'react/jsx-runtime': jsxRuntime,
  './AgentResponseDetails.css': {},
  './AgentMarkdown': { AgentMarkdown: ({ text }) => React.createElement('div', null, text) },
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
  assert.doesNotMatch(partial, /输出 token|<dd>0<\/dd>|高级信息/);
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
  assert.match(html, /生成图片<\/dt><dd>1 \/ 2/);
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
  assert.match(primary, /使用的技能/);
  assert.doesNotMatch(primary, /12345678|GPL-3.0|github.com|公开摘要：/);
  assert.match(html, /<details class="agent-response-summary"><summary>公开摘要/);
  assert.doesNotMatch(html, /<details[^>]* open/);
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
