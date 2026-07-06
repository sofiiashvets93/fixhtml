// Composes the deployable static site into dist-site/:
//   /            landing page (landing/index.html)
//   /app/        browser demo build (VITE_ADAPTER=browser, base /app/)
//   /assets/     sample assets — the landing previews them, /app/?sample= imports them
// Deploy: `npx vercel deploy dist-site` (static output, no backend).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist-site');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

execSync('npx tsc -b', { cwd: root, stdio: 'inherit' });
execSync('npx vite build --outDir ../dist-site/app --base=/app/', {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_ADAPTER: 'browser' },
});

// landing page + its local assets (vendor/, img/), docs stay out of the site
for (const entry of fs.readdirSync(path.join(root, 'landing'))) {
  if (entry.endsWith('.md')) continue;
  fs.cpSync(path.join(root, 'landing', entry), path.join(out, entry), { recursive: true });
}
fs.cpSync(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
// Contract assets reference their brand tokens (/brands/<name>/tokens.css) absolutely.
fs.cpSync(path.join(root, 'brands'), path.join(out, 'brands'), { recursive: true });

console.log('dist-site/ ready: landing at /, demo at /app/, samples at /assets/');
