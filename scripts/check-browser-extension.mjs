// Native MV3 sources are loaded directly; validate instead of producing a second copy.
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../extensions/browser-capture/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.type, 'module');
assert.ok(manifest.side_panel.default_path);
assert.ok(!manifest.action.default_popup, 'Use the native side panel, not an action popup');
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path]) {
  assert.ok(!file.includes('..') && !file.includes(':'));
  await access(new URL(file, root));
}
const html = await readFile(new URL(manifest.side_panel.default_path, root), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (/^https?:/.test(match[1])) throw new Error('Extension assets must be local');
  await access(new URL(match[1], root));
}
for (const file of await readdir(root)) {
  if (!/\.(mjs|js)$/.test(file)) continue;
  const check = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(check.stderr || `Syntax check failed: ${file}`);
}
console.log('MV3 source and local entry points verified. Load extensions/browser-capture directly; no build artifacts needed.');
