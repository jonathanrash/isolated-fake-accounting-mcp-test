import { readFile, lstat, mkdir, copyFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = JSON.parse(await readFile(path.join(root,'publication-allowlist.json'),'utf8'));
const release = path.join(root,'release');
// Refuse any existing output so stale or private files cannot survive a rebuild.
await mkdir(release);
const hashes = {};
for (const file of allowed) {
  if (typeof file !== 'string' || path.isAbsolute(file) || file.split('/').includes('..') || file.startsWith('evidence/') || file.startsWith('.env')) throw new Error('Unsafe publication path');
  const source = path.join(root,file);
  if (!(await lstat(source)).isFile() || !(await realpath(source)).startsWith(root+path.sep)) throw new Error('Publication input must be an ordinary project file');
  const target = path.join(release,file);
  await mkdir(path.dirname(target),{recursive:true});
  await copyFile(source,target);
  hashes[file]=createHash('sha256').update(await readFile(source)).digest('hex');
}
await writeFile(path.join(release,'PUBLICATION_SHA256.json'),JSON.stringify(hashes,null,2)+'\n');
console.log(JSON.stringify({result:'prepared_only_not_published',files:allowed.length,output:release,excluded:'all evidence, client setup records, .env, dependencies and logs'}));
