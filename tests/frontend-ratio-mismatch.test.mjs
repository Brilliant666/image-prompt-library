import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
const toModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const recipeModule = toModule(compile(await readFile(new URL('../frontend/src/utils/compatibleRecipe.ts', import.meta.url), 'utf8')));
const { compatibleMismatches, ASPECT_RATIO_RELATIVE_TOLERANCE } = await import(recipeModule);
const require = createRequire(import.meta.url);
const summarySource = compile(await readFile(new URL('../frontend/src/components/GenerationResultSummary.tsx', import.meta.url), 'utf8'))
  .replace(/(['"])react\/jsx-runtime\1/g, JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href))
  .replace(/(['"])\.\.\/utils\/compatibleRecipe\1/g, JSON.stringify(recipeModule));
const { GenerationResultSummary } = await import(toModule(summarySource));
const cases = [
  ['square output', 'auto', '9:16', 1024, 1024, ['imageAspectRatioMismatch']],
  ['correct portrait', 'auto', '9:16', 900, 1600, []],
  ['rounded pixels within 1 percent', 'auto', '9:16', 941, 1672, []],
  ['outside 1 percent', 'auto', '9:16', 910, 1600, ['imageAspectRatioMismatch']],
  ['auto ratio', 'auto', 'auto', 1024, 1024, []],
  ['invalid ratio', 'auto', '0:16', 1024, 1024, []],
  ['explicit size matches', '900x1600', '9:16', 900, 1600, []],
  ['explicit size differs', '900x1600', '9:16', 1024, 1024, ['imageSizeMismatch']],
  ['settings conflict alone', '1024x1024', '9:16', 1024, 1024, ['imageRatioConflict']],
  ['settings conflict and output mismatch', '1024x1024', '9:16', 900, 1600, ['imageRatioConflict', 'imageSizeMismatch']],
  ['not decoded', 'auto', '9:16', undefined, undefined, []],
];
function job(size, ratio, width, height) {
  return {provider:'openai_compatible',status:'succeeded',result_path:'fixture.png',metadata:{requested:{size,requested_aspect_ratio:ratio},decoded_image:{width,height,format:'PNG'}}};
}
for (const [name, size, ratio, width, height, expected] of cases) test(name, () => {
  assert.equal(ASPECT_RATIO_RELATIVE_TOLERANCE, 0.01);
  assert.deepEqual(compatibleMismatches(job(size, ratio, width, height)), expected);
});
test('ratio warning and actual pixels are visible outside collapsed diagnostics', () => {
  const html = renderToStaticMarkup(createElement(GenerationResultSummary,{job:job('auto','9:16',1024,1024),t:key=>key}));
  const visible = html.split('<details')[0];
  assert.match(visible,/imageAspectRatioMismatch/);
  assert.match(visible,/9:16/);
  assert.match(visible,/1024 × 1024/);
  assert.match(visible,/is-warning/);
});
test('self-reported dimensions do not establish a decoded result', () => {
  const pending = job('auto','9:16');
  pending.metadata.response = {size:'900x1600'};
  const html = renderToStaticMarkup(createElement(GenerationResultSummary,{job:pending,t:key=>key}));
  assert.match(html,/imageResultUnverified/);
  assert.doesNotMatch(html,/imageResultDecoded|imageAspectRatioMismatch|is-success/);
});
test('format, transparency and quality warnings coexist with ratio warning', () => {
  const result = job('auto','9:16',1024,1024);
  Object.assign(result.metadata.requested,{output_format:'webp',background:'transparent',quality:'max'});
  Object.assign(result.metadata.decoded_image,{has_transparent_pixels:false});
  result.metadata.response = {quality:'medium'};
  assert.deepEqual(compatibleMismatches(result),['imageAspectRatioMismatch','imageFormatMismatch','imageAlphaMismatch','imageQualityMismatch']);
});
