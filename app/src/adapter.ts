import { clientEditView } from './editView';

// Backend-adapter interface: ONE codebase, two build targets — never a
// fork. LocalAdapter talks to the Node server; BrowserAdapter keeps assets in memory,
// renders the edit view via srcdoc, exports with snapdom, and "saves" by downloading
// the HTML. `import.meta.env.VITE_ADAPTER === 'browser'` picks the browser build.

export interface LoadResult {
  html: string;
  mtime: number | null;
  draft: string | null;
}
export interface EditView {
  src?: string;
  srcDoc?: string;
}
export interface SaveResult {
  mtime: number | null;
  conflict: boolean;
}
export interface ExportOpts {
  format: 'png' | 'jpeg';
  scale: 1 | 2 | 3;
  iframe: HTMLIFrameElement | null;
}
export interface SaveOpts {
  baseMtime: number | null;
  force?: boolean;
  download?: boolean; // browser: explicit Save downloads; freeze/autosave don't
}

export interface Adapter {
  readonly kind: 'local' | 'browser';
  listAssets(): Promise<string[]>;
  loadAsset(path: string): Promise<LoadResult>;
  editView(path: string, opts: { draft?: boolean; nonce: number }): EditView;
  saveAsset(path: string, html: string, opts: SaveOpts): Promise<SaveResult>;
  saveDraft(path: string, html: string): Promise<void>;
  deleteDraft(path: string): Promise<void>;
  importHtml(name: string, html: string): Promise<string>;
  exportAsset(path: string, opts: ExportOpts): Promise<string[]>;
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeName(name: string): string {
  return (name || 'asset')
    .replace(/\.html?$/i, '')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'asset';
}

// --- LocalAdapter: the existing Node server -------------------------------------

class LocalAdapter implements Adapter {
  readonly kind = 'local';

  async listAssets() {
    const r = await fetch('/api/assets').then((x) => x.json());
    return r.assets as string[];
  }
  async loadAsset(path: string): Promise<LoadResult> {
    const r = await fetch(`/api/asset?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error('load failed');
    const d = await r.json();
    return { html: d.html, mtime: d.mtime ?? null, draft: d.draft ?? null };
  }
  editView(path: string, opts: { draft?: boolean; nonce: number }): EditView {
    return { src: `/assets/${path}?edit=1${opts.draft ? '&draft=1' : ''}&n=${opts.nonce}` };
  }
  async saveAsset(path: string, html: string, opts: SaveOpts): Promise<SaveResult> {
    const r = await fetch('/api/asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, html, baseMtime: opts.baseMtime, force: opts.force }),
    });
    if (r.status === 409) return { mtime: null, conflict: true };
    if (!r.ok) throw new Error('save failed');
    const d = await r.json();
    return { mtime: d.mtime ?? null, conflict: false };
  }
  async saveDraft(path: string, html: string) {
    await fetch('/api/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, html }),
    });
  }
  async deleteDraft(path: string) {
    await fetch(`/api/draft?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  }
  async importHtml(name: string, html: string): Promise<string> {
    const r = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, html }),
    });
    if (!r.ok) throw new Error('import failed');
    return (await r.json()).path as string;
  }
  async exportAsset(path: string, opts: ExportOpts): Promise<string[]> {
    const r = await fetch('/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: path, format: opts.format, scale: opts.scale }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'export failed');
    return d.files as string[];
  }
}

// --- BrowserAdapter: in-memory, no server ---------------------------------------

interface MemAsset {
  html: string;
  draft: string | null;
}

class BrowserAdapter implements Adapter {
  readonly kind = 'browser';
  private assets = new Map<string, MemAsset>();

  constructor(seed: Record<string, string> = {}) {
    for (const [p, html] of Object.entries(seed)) this.assets.set(p, { html, draft: null });
  }

  async listAssets() {
    return [...this.assets.keys()].sort();
  }
  async loadAsset(path: string): Promise<LoadResult> {
    const a = this.assets.get(path);
    if (!a) throw new Error('not found');
    return { html: a.html, mtime: null, draft: a.draft };
  }
  editView(path: string, opts: { draft?: boolean }): EditView {
    const a = this.assets.get(path);
    if (!a) return { srcDoc: '<!doctype html><body>' };
    return { srcDoc: clientEditView(opts.draft && a.draft ? a.draft : a.html) };
  }
  async saveAsset(path: string, html: string, opts: SaveOpts): Promise<SaveResult> {
    const a = this.assets.get(path) ?? { html, draft: null };
    a.html = html;
    a.draft = null;
    this.assets.set(path, a);
    if (opts.download) download(`${safeName(path.split('/').pop() || path)}.html`, new Blob([html], { type: 'text/html' }));
    return { mtime: null, conflict: false };
  }
  async saveDraft(path: string, html: string) {
    const a = this.assets.get(path);
    if (a) a.draft = html;
  }
  async deleteDraft(path: string) {
    const a = this.assets.get(path);
    if (a) a.draft = null;
  }
  async importHtml(name: string, html: string): Promise<string> {
    let base = safeName(name);
    let path = `imported/${base}.html`;
    let i = 2;
    while (this.assets.has(path)) path = `imported/${base}-${i++}.html`;
    this.assets.set(path, { html, draft: null });
    return path;
  }
  async exportAsset(path: string, opts: ExportOpts): Promise<string[]> {
    const cdoc = opts.iframe?.contentDocument;
    const cwin = opts.iframe?.contentWindow as IframeExportWindow | undefined;
    if (!cdoc) throw new Error('no rendered asset');
    const ed = cwin?.__hsEditor;
    if (!ed?.capture) throw new Error('editor not ready');
    const pages = cdoc.querySelectorAll<HTMLElement>('.hs-page');
    if (pages.length === 0) throw new Error('no .hs-page found — freeze this asset first');
    const name = safeName(path.split('/').pop() || path);
    const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
    const out: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      // Capture INSIDE the iframe: snapdom reads fonts from the global `document`,
      // so it must run where the asset (and its @font-face — brand, Google, or an
      // M18 data-URI upload) actually lives. Running it in the parent embeds nothing.
      const blob = await ed.capture(i, {
        scale: opts.scale,
        type: opts.format === 'jpeg' ? 'jpg' : 'png',
        backgroundColor: opts.format === 'jpeg' ? '#ffffff' : undefined,
      });
      if (!blob) throw new Error('capture failed');
      const fname = `${name}-${String(i + 1).padStart(2, '0')}@${opts.scale}x.${ext}`;
      download(fname, blob);
      out.push(fname);
    }
    return out;
  }
}

interface IframeExportWindow extends Window {
  __hsEditor?: {
    capture?: (i: number, opts: { scale: number; type: string; backgroundColor?: string }) => Promise<Blob | null>;
  };
}

let cached: Adapter | null = null;
export function getAdapter(): Adapter {
  if (cached) return cached;
  // Browser build starts empty — the drop/paste inlet is the front door. (Bundled
  // sample assets arrive with M10's landing page.)
  cached = import.meta.env.VITE_ADAPTER === 'browser' ? new BrowserAdapter() : new LocalAdapter();
  return cached;
}
