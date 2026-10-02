import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist');
for (const item of ['index.html', 'manifest.json', 'sw.js', 'src', 'icons']) await cp(item, `dist/${item}`, { recursive: true });
console.log('Built static PWA in dist/');
