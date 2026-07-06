// Compile brand.json -> tokens.css + BRAND.md for one brand or all of them.
//   node scripts/build-brand.mjs [name]
import { compileBrand } from '../server/brand.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANDS_DIR = path.join(ROOT, 'brands');

// fonts/registry.json (from `npm run fonts`) supplies self-hosted @font-face. Absent
// on a clone that hasn't run the sync yet — fonts then fall back to system stacks.
async function loadRegistry() {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, 'fonts', 'registry.json'), 'utf8'));
  } catch {
    console.warn('  (no fonts/registry.json — run `npm run fonts`; using system fallbacks)');
    return null;
  }
}

async function buildOne(name, registry) {
  const dir = path.join(BRANDS_DIR, name);
  const brand = JSON.parse(await fs.readFile(path.join(dir, 'brand.json'), 'utf8'));
  const { tokensCss, brandMd } = compileBrand(brand, registry);
  await fs.writeFile(path.join(dir, 'tokens.css'), tokensCss, 'utf8');
  await fs.writeFile(path.join(dir, 'BRAND.md'), brandMd, 'utf8');
  console.log(`built brand "${name}" -> tokens.css + BRAND.md`);
}

async function main() {
  const registry = await loadRegistry();
  const name = process.argv[2];
  if (name) return buildOne(name, registry);
  const entries = await fs.readdir(BRANDS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await fs.access(path.join(BRANDS_DIR, e.name, 'brand.json'));
      await buildOne(e.name, registry);
    } catch {
      /* no brand.json here */
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
