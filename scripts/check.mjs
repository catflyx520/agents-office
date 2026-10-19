import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
const files = ['server', 'client/src', 'tests', 'scripts'].flatMap(walk)
  .filter(file => /\.(?:js|cjs|mjs)$/.test(file));
for (const file of files) {
  const args = file.startsWith(`client${path.sep}`) || file.endsWith('.mjs')
    ? ['--input-type=module', '--check'] : ['--check'];
  const result = spawnSync(process.execPath, args, { input: readFileSync(file), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file}\n${result.stderr}`);
}
console.log(`Syntax checked: ${files.length} JavaScript modules.`);
