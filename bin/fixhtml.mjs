#!/usr/bin/env node
// fixhtml CLI — three modes:
//   fixhtml                       serve the current directory, open the asset list
//   fixhtml <file.html>           open that file directly in the editor
//   fixhtml export <file> [opts]  headless export (no UI), agent-callable
//     opts: --scale 1|2|3 (default 2), --format png|jpeg (default png)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.mjs';
import { exportAsset } from '../server/export.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(PKG_ROOT, 'dist');
// Brand tokens + the font library aren't part of the lean CLI package; when present
// (running from source) they're served, otherwise those routes are simply absent.
const has = (p) => (fs.existsSync(p) ? p : null);
const BRANDS = has(path.join(PKG_ROOT, 'brands'));
const FONTS = has(path.join(PKG_ROOT, 'fonts'));

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless box: the URL is printed above regardless */
  }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

async function serve({ assetsDir, openPath }) {
  if (!fs.existsSync(DIST)) {
    console.error('This build has no prebuilt UI (dist/ missing). If running from source, `npm run build` first.');
    process.exit(1);
  }
  const exportsDir = path.join(assetsDir, 'exports');
  const app = createApp({ assetsDir, brandsDir: BRANDS, fontsDir: FONTS, exportsDir, staticDir: DIST });
  const server = await listen(app);
  const { port } = server.address();
  const url = `http://localhost:${port}/${openPath ? `?open=${encodeURIComponent(openPath)}` : ''}`;
  console.log(`\n  fixhtml  →  ${url}`);
  console.log(`  serving: ${assetsDir}`);
  console.log(`  (Ctrl-C to stop)\n`);
  openBrowser(url);
}

async function runExport(file, { scale, format }) {
  if (!file) {
    console.error('Usage: fixhtml export <file.html> [--scale 1|2|3] [--format png|jpeg]');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`No such file: ${abs}`);
    process.exit(1);
  }
  const assetsDir = path.dirname(abs);
  // Write the PNG/JPEG into the current working directory so it's easy to find.
  const exportsDir = process.cwd();
  const app = createApp({ assetsDir, brandsDir: BRANDS, fontsDir: FONTS, exportsDir, staticDir: null });
  const server = await listen(app);
  const { port } = server.address();
  try {
    const files = await exportAsset({
      file: path.basename(abs),
      format,
      scale,
      baseUrl: `http://localhost:${port}`,
      exportsDir,
    });
    console.log(files.map((f) => path.join(exportsDir, f)).join('\n'));
  } catch (err) {
    console.error(err?.code === 'PLAYWRIGHT_MISSING' || err?.code === 'NO_PAGES' ? err.message : `Export failed: ${err?.message || err}`);
    process.exitCode = 1;
  } finally {
    server.close();
    process.exit(process.exitCode || 0);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'export') {
    const file = rest.find((a) => !a.startsWith('--'));
    const scale = Math.max(1, Math.min(3, Number(flag(rest, '--scale', '2')) || 2));
    const format = flag(rest, '--format', 'png') === 'jpeg' ? 'jpeg' : 'png';
    await runExport(file, { scale, format });
  } else if (cmd === '--help' || cmd === '-h') {
    console.log('fixhtml               serve the current directory in the editor');
    console.log('fixhtml <file.html>   open that file directly');
    console.log('fixhtml export <file> [--scale 1|2|3] [--format png|jpeg]   headless export');
  } else if (cmd && /\.html?$/i.test(cmd)) {
    const abs = path.resolve(cmd);
    if (!fs.existsSync(abs)) {
      console.error(`No such file: ${abs}`);
      process.exit(1);
    }
    await serve({ assetsDir: path.dirname(abs), openPath: path.basename(abs) });
  } else if (!cmd) {
    await serve({ assetsDir: process.cwd(), openPath: null });
  } else {
    console.error(`Unknown argument: ${cmd}\nTry: fixhtml --help`);
    process.exit(1);
  }
}

main();
