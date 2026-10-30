import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Legacy parent-component fixtures keep child boundaries opaque, while using
// the real production evidence parser. The child callbacks have their own suite.
const source = await readFile(new URL('../../frontend/src/utils/localResultRecovery.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const parser = {};
new Function('exports', javascript)(parser);
const child = { __esModule: true, default: 'local-result-recovery' };
export const localRecoveryDependencies = {
  '../../utils/localResultRecovery': parser,
  '../utils/localResultRecovery': parser,
  '../LocalResultRecovery': child,
  './LocalResultRecovery': child,
};
