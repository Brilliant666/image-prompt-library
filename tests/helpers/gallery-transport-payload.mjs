/** stdin: { job, promptText?, inputs? }; stdout: real Gallery GenerationJobCreate JSON.
 * No HTTP, browser state, provider config or credentials are accessed here.
 */
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const modules = new Map();
async function loadTs(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const source = await readFile(url, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dependencies = new Map();
  for (const match of js.matchAll(/require\("([^"]+)"\)/g)) dependencies.set(match[1], await loadTs(new URL(`${match[1]}.ts`, url)));
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => dependencies.get(name), module, module.exports);
  modules.set(url.href, module.exports);
  return module.exports;
}

process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const { draftFromJob, galleryPayload } = await loadTs(new URL('../../frontend/src/utils/galleryRecipe.ts', import.meta.url));
const draft = draftFromJob(request.job, request.inputs || []);
if (typeof request.promptText === 'string') draft.prompt = request.promptText;
process.stdout.write(JSON.stringify(galleryPayload(draft, 4)));
