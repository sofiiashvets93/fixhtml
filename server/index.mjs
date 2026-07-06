import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parse } from 'node-html-parser';
import { exportAsset } from './export.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Produce the editable view of an asset (DOMParser-first): parse the
// source, tag `data-eid` on every `.hs-el` in document order, and strip the
// asset's own <script> tags. The editor injects its own scripts, so the plan's
// sandbox=no-scripts can't be used — stripping gives the same guarantee that the
// live DOM matches the parsed source. Served at the asset's REAL path so relative
// image/font/tokens.css URLs still resolve (query string is ignored for that).
function toEditView(html) {
  const root = parse(html, {
    comment: true,
    blockTextElements: { script: true, style: true, pre: true },
  });
  // Derive data-eid from the persistent data-hs-id: eid == hs-id when present,
  // else a fresh id above the max in document order. This keeps element ids stable
  // across sessions. MIRROR of app/src/assetEdit.ts `deriveEids` (different parser,
  // so not shared code) — if this rule changes, change BOTH together.
  const els = root.querySelectorAll('.hs-el');
  let maxId = -1;
  for (const el of els) {
    const h = el.getAttribute('data-hs-id');
    if (h != null) {
      const n = Number(h);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    }
  }
  let counter = maxId + 1;
  for (const el of els) {
    const h = el.getAttribute('data-hs-id');
    el.setAttribute('data-eid', h != null ? h : String(counter++));
  }
  root.querySelectorAll('script').forEach((s) => s.remove());
  return root.toString();
}

// Sidecar draft path: foo/bar.html -> foo/bar.draft.html
function draftPathFor(resolved) {
  return resolved.replace(/\.html$/i, '.draft.html');
}

// Build the Express app rooted at a specific assets directory. The dev server and
// the `fixhtml` CLI both call this; only the directories (and whether a prebuilt
// frontend is served) differ.
export function createApp({ assetsDir, brandsDir, fontsDir, exportsDir, staticDir }) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Recursively collect .html asset files as paths relative to assetsDir.
  async function listAssets(dir = assetsDir, base = '') {
    const out = [];
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        out.push(...(await listAssets(path.join(dir, entry.name), rel)));
      } else if (entry.isFile() && entry.name.endsWith('.html') && !entry.name.endsWith('.draft.html')) {
        out.push(rel);
      }
    }
    return out;
  }

  // Resolve a client-supplied relative path safely INSIDE assetsDir. The CLI serves
  // arbitrary user folders, so `../` traversal (or an absolute path) that escapes the
  // root must resolve to null. path.resolve collapses `..`; the prefix check rejects
  // anything that lands outside.
  function safeAssetPath(rel) {
    if (typeof rel !== 'string' || !rel) return null;
    const resolved = path.resolve(assetsDir, rel);
    const prefix = assetsDir + path.sep;
    if (resolved !== assetsDir && !resolved.startsWith(prefix)) return null;
    return resolved;
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/assets', async (_req, res) => {
    const files = await listAssets();
    files.sort();
    res.json({ assets: files });
  });

  app.get('/api/asset', async (req, res) => {
    const resolved = safeAssetPath(req.query.path);
    if (!resolved) return res.status(400).json({ error: 'invalid path' });
    try {
      const html = await fs.readFile(resolved, 'utf8');
      const stat = await fs.stat(resolved);
      // Sidecar autosave draft (crash recovery), if one is waiting.
      let draft = null;
      try {
        draft = await fs.readFile(draftPathFor(resolved), 'utf8');
      } catch {
        /* no draft */
      }
      res.json({ path: req.query.path, html, mtime: stat.mtimeMs, draft });
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  app.post('/api/asset', async (req, res) => {
    const resolved = safeAssetPath(req.body?.path);
    if (!resolved) return res.status(400).json({ error: 'invalid path' });
    if (typeof req.body?.html !== 'string') {
      return res.status(400).json({ error: 'missing html' });
    }
    try {
      // Stale-file guard: if the file changed on disk since load (an agent writes
      // into this folder), refuse unless the client forces an overwrite.
      if (!req.body.force && req.body.baseMtime != null) {
        let current = null;
        try {
          current = (await fs.stat(resolved)).mtimeMs;
        } catch {
          /* file gone; treat as writable */
        }
        if (current != null && Math.abs(current - req.body.baseMtime) > 1) {
          return res.status(409).json({ error: 'stale', currentMtime: current });
        }
      }
      await fs.writeFile(resolved, req.body.html, 'utf8');
      await fs.rm(draftPathFor(resolved), { force: true }); // clear the sidecar draft
      const stat = await fs.stat(resolved);
      res.json({ ok: true, path: req.body.path, mtime: stat.mtimeMs });
    } catch {
      res.status(500).json({ error: 'write failed' });
    }
  });

  // Import an HTML file/paste into <assetsDir>/imported/<name>.html (drop/paste inlet).
  app.post('/api/import', async (req, res) => {
    const { name, html } = req.body ?? {};
    if (typeof html !== 'string') return res.status(400).json({ error: 'missing html' });
    const base = String(name || 'asset').replace(/\.html?$/i, '').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'asset';
    try {
      await fs.mkdir(path.join(assetsDir, 'imported'), { recursive: true });
      let rel = `imported/${base}.html`;
      let n = 2;
      while (true) {
        try {
          await fs.access(path.join(assetsDir, rel));
          rel = `imported/${base}-${n++}.html`;
        } catch {
          break;
        }
      }
      await fs.writeFile(path.join(assetsDir, rel), html, 'utf8');
      res.json({ path: rel });
    } catch {
      res.status(500).json({ error: 'import failed' });
    }
  });

  // Autosave: write the in-progress state to a sidecar draft (never the source).
  app.post('/api/draft', async (req, res) => {
    const resolved = safeAssetPath(req.body?.path);
    if (!resolved) return res.status(400).json({ error: 'invalid path' });
    if (typeof req.body?.html !== 'string') return res.status(400).json({ error: 'missing html' });
    try {
      await fs.writeFile(draftPathFor(resolved), req.body.html, 'utf8');
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'write failed' });
    }
  });

  // Discard a sidecar draft (user chose not to restore it).
  app.delete('/api/draft', async (req, res) => {
    const resolved = safeAssetPath(req.query.path);
    if (!resolved) return res.status(400).json({ error: 'invalid path' });
    try {
      await fs.rm(draftPathFor(resolved), { force: true });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'delete failed' });
    }
  });

  // Editable view: /assets/<path>.html?edit=1 → processed HTML. Must be registered
  // before express.static so it intercepts the .html request; without ?edit it falls
  // through to raw static serving (used by Playwright export and direct viewing).
  app.get(/^\/assets\/(.+\.html)$/, async (req, res, next) => {
    if (req.query.edit === undefined) return next();
    const resolved = safeAssetPath(req.params[0]);
    if (!resolved) return res.status(400).send('invalid path');
    // ?draft=1 renders the sidecar draft (crash recovery) instead of the source.
    const file = req.query.draft === undefined ? resolved : draftPathFor(resolved);
    try {
      const html = await fs.readFile(file, 'utf8');
      res.type('html').send(toEditView(html));
    } catch {
      res.status(404).send('not found');
    }
  });

  // Pixel-perfect export via Playwright (spec in export.mjs). Loads the RAW served
  // URL so the asset's scripts run and resources resolve exactly as when editing.
  app.post('/export', async (req, res) => {
    const { file, pages, format = 'png', scale = 2, quality } = req.body ?? {};
    if (!safeAssetPath(file)) return res.status(400).json({ error: 'invalid file' });
    if (!['png', 'jpeg'].includes(format)) return res.status(400).json({ error: 'bad format' });
    if (![1, 2, 3].includes(scale)) return res.status(400).json({ error: 'bad scale' });
    try {
      await fs.mkdir(exportsDir, { recursive: true });
      const files = await exportAsset({
        file, pages, format, scale, quality,
        baseUrl: `${req.protocol}://${req.get('host')}`,
        exportsDir,
      });
      res.json({ files });
    } catch (err) {
      if (err?.code === 'NO_PAGES') return res.status(422).json({ error: err.message });
      if (err?.code === 'PLAYWRIGHT_MISSING') return res.status(422).json({ error: err.message });
      console.error('[fixhtml] export failed:', err?.message);
      res.status(500).json({ error: 'export failed', detail: String(err?.message || err) });
    }
  });

  // Raw static serving of asset + brand resources (images, fonts, tokens.css).
  app.use('/assets', express.static(assetsDir));
  if (brandsDir) app.use('/brands', express.static(brandsDir));
  if (exportsDir) app.use('/exports', express.static(exportsDir));
  if (fontsDir) {
    app.use('/fonts', express.static(fontsDir, {
      setHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*'),
    }));
  }

  // Prebuilt frontend (the CLI ships it; dev uses Vite instead). Served last, with an
  // SPA fallback so a deep link resolves to the app shell.
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  return app;
}

// Dev direct-run (`npm run dev:server`): API only, Vite serves the frontend.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const PORT = Number(process.env.PORT) || 5174;
  const app = createApp({
    assetsDir: path.join(ROOT, 'assets'),
    brandsDir: path.join(ROOT, 'brands'),
    fontsDir: path.join(ROOT, 'fonts'),
    exportsDir: path.join(ROOT, 'exports'),
    staticDir: null,
  });
  app.listen(PORT, () => {
    console.log(`[fixhtml] server on http://localhost:${PORT}  (assets: ${path.join(ROOT, 'assets')})`);
  });
}
