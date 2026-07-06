// Playwright export (the export spec). Renders each `.hs-page`
// to a PNG/JPEG at a retina scale. The traps the spec encodes are handled here:
//  - ONE warm context PER SCALE — deviceScaleFactor is fixed at context creation,
//    so a single context can't do multiple scales; we pool by scale.
//  - iterate with locator('.hs-page').nth(i) — a bare .screenshot() against
//    multiple matches throws a strict-mode violation.
//  - inject a force-visible style before shooting (legacy decks hide slides).
//  - animations:'disabled' + await document.fonts.ready for deterministic output.
//  - omitBackground for PNG → transparency ONLY where nothing paints.
//  - load the RAW served URL (never ?edit=1): export is the one context where the
//    asset's own scripts SHOULD run, and ?edit strips them.
import path from 'node:path';
import fs from 'node:fs/promises';

let browserPromise = null;
const contextsByScale = new Map();

// Playwright is an OPTIONAL dependency and loaded lazily: the editor/CLI run fine
// without it, and only an export attempt needs chromium. A missing package OR a
// missing browser binary both surface as PLAYWRIGHT_MISSING with the install hint.
function playwrightMissing(detail) {
  const e = new Error('Export needs Chromium. Install it once with:  npx playwright install chromium' + (detail ? `\n(${detail})` : ''));
  e.code = 'PLAYWRIGHT_MISSING';
  return e;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        throw playwrightMissing('playwright package not installed');
      }
      try {
        return await chromium.launch({ headless: true });
      } catch (err) {
        browserPromise = null; // let a later attempt retry after install
        throw playwrightMissing(err?.message);
      }
    })();
  }
  return browserPromise;
}

async function getContext(scale) {
  if (contextsByScale.has(scale)) return contextsByScale.get(scale);
  const browser = await getBrowser();
  const ctx = await browser.newContext({ deviceScaleFactor: scale });
  contextsByScale.set(scale, ctx);
  return ctx;
}

/**
 * @param {{ file: string, pages?: number[], format: 'png'|'jpeg', scale: 1|2|3,
 *           quality?: number, baseUrl: string, exportsDir: string }} opts
 * @returns {Promise<string[]>} export-relative output paths
 */
export async function exportAsset({ file, pages, format, scale, quality, baseUrl, exportsDir }) {
  const ctx = await getContext(scale);
  const page = await ctx.newPage();
  const written = [];
  try {
    await page.goto(`${baseUrl}/assets/${file}`, { waitUntil: 'networkidle' });
    await page.addStyleTag({
      content: '.hs-page{display:block !important;position:relative !important}',
    });
    await page.evaluate(() => document.fonts.ready);

    const all = page.locator('.hs-page');
    const count = await all.count();
    if (count === 0) {
      const err = new Error('no .hs-page found — freeze this asset to contract form first');
      err.code = 'NO_PAGES';
      throw err;
    }
    const indices = pages && pages.length ? pages : Array.from({ length: count }, (_, i) => i);

    const dir = path.dirname(file); // e.g. "sample"
    const name = path.basename(file, path.extname(file)); // e.g. "carousel"
    const outDir = path.join(exportsDir, dir);
    await fs.mkdir(outDir, { recursive: true });
    const ext = format === 'jpeg' ? 'jpg' : 'png';

    for (const i of indices) {
      if (i < 0 || i >= count) continue;
      const num = String(i + 1).padStart(2, '0');
      const outName = `${name}-${num}@${scale}x.${ext}`;
      const shot = { path: path.join(outDir, outName), animations: 'disabled' };
      if (format === 'jpeg') {
        shot.type = 'jpeg';
        shot.quality = quality ?? 90; // JPEG can't be transparent, so no omitBackground
      } else {
        shot.type = 'png';
        shot.omitBackground = true;
      }
      await all.nth(i).screenshot(shot);
      written.push(path.posix.join(dir === '.' ? '' : dir, outName));
    }
  } finally {
    await page.close();
  }
  return written;
}

export async function closeExporter() {
  for (const ctx of contextsByScale.values()) await ctx.close().catch(() => {});
  contextsByScale.clear();
  if (browserPromise) await (await browserPromise).close().catch(() => {});
  browserPromise = null;
}
