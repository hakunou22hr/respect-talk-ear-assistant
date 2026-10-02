import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  return nested.flat();
}
const files = (await Promise.all(['src', 'scripts', 'tests'].map(filesIn))).flat().filter((file) => file.endsWith('.js'));
let failed = false;
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (/\t| +$/m.test(source)) { console.error(`${file}: tabs or trailing spaces found`); failed = true; }
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) { console.error(check.stderr.trim()); failed = true; }
}
if (failed) process.exitCode = 1; else console.log(`Lint passed (${files.length} JavaScript files)`);
