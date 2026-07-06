// `npm run fonts` — populate the self-hosted font library from Fontsource
// devDependencies (per fonts/manifest.json), index user-supplied custom fonts, and
// write fonts/registry.json (the single source the brand compiler + style panel read).
// fonts/library/ and fonts/registry.json are generated (gitignored); fonts/manifest.json
// and fonts/custom/ are committed.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.join(ROOT, 'fonts');
const LIB = path.join(FONTS, 'library');
const CUSTOM = path.join(FONTS, 'custom');

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// Copy the default-subset WOFF2s + LICENSE for one Fontsource package into
// fonts/library/<slug>/, returning its registry entry.
async function syncLibraryFamily(family, pkg) {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve(`${pkg}/metadata.json`));
  } catch {
    console.warn(`  ! ${family}: ${pkg} not installed — skipped (npm install it)`);
    return null;
  }
  const meta = JSON.parse(await fs.readFile(path.join(pkgDir, 'metadata.json'), 'utf8'));
  const slug = pkg.replace('@fontsource/', '');
  const subset = meta.defSubset || 'latin';
  const outDir = path.join(LIB, slug);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const faces = [];
  for (const weight of meta.weights) {
    for (const style of meta.styles) {
      const fname = `${slug}-${subset}-${weight}-${style}.woff2`;
      const src = path.join(pkgDir, 'files', fname);
      if (!(await exists(src))) continue;
      await fs.copyFile(src, path.join(outDir, fname));
      faces.push({ weight, style, file: fname });
    }
  }
  for (const lic of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
    if (await exists(path.join(pkgDir, lic))) {
      await fs.copyFile(path.join(pkgDir, lic), path.join(outDir, 'LICENSE'));
      break;
    }
  }
  console.log(`  ✓ ${family} (${faces.length} faces)`);
  return { family: meta.family || family, source: 'library', slug, faces };
}

// Index custom fonts: each fonts/custom/<slug>/ folder needs a font.json
// ({ family, faces:[{weight,style,file}] }) plus its WOFF2 files (and a LICENSE).
async function indexCustom() {
  const out = [];
  if (!(await exists(CUSTOM))) return out;
  for (const entry of await fs.readdir(CUSTOM, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fj = path.join(CUSTOM, entry.name, 'font.json');
    if (!(await exists(fj))) continue;
    const spec = JSON.parse(await fs.readFile(fj, 'utf8'));
    out.push({ family: spec.family, source: 'custom', slug: entry.name, faces: spec.faces });
    console.log(`  ✓ ${spec.family} (custom, ${spec.faces.length} faces)`);
  }
  return out;
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(FONTS, 'manifest.json'), 'utf8'));
  await fs.mkdir(LIB, { recursive: true });

  console.log('Syncing library fonts:');
  const library = [];
  for (const [family, pkg] of Object.entries(manifest.library)) {
    const entry = await syncLibraryFamily(family, pkg);
    if (entry) library.push(entry);
  }
  console.log('Indexing custom fonts:');
  const custom = await indexCustom();

  const registry = { families: [...library, ...custom] };
  await fs.writeFile(path.join(FONTS, 'registry.json'), JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`\nWrote fonts/registry.json — ${registry.families.length} families (${library.length} library + ${custom.length} custom).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
