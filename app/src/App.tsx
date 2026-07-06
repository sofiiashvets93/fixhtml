import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyLog, describeCommand, type Command } from './assetEdit';
import { getAdapter } from './adapter';
import { isContract, needsRender, renderToStatic } from './editView';
import moveableSource from 'moveable/dist/moveable.min.js?raw';
import iframeRuntimeSource from './iframeRuntime.js?raw';
// Global (window.snapdom) build, injected into the iframe for browser-build export.
// Relative path (not the package specifier) because snapdom's exports map doesn't
// expose the dist subpath — the ?raw text is what we inject into the iframe.
import snapdomSource from '../../node_modules/@zumer/snapdom/dist/snapdom.js?raw';

interface ElStyle {
  fontSize: number;
  fontWeight: string;
  opacity: number;
  lineHeight: string;
  color: string;
  fontFamily: string;
}
interface Snapshot {
  eid: number;
  left: number;
  top: number;
  width: number;
  height: number;
  rotation: number;
  style?: ElStyle;
}
interface TokenItem {
  name: string;
  value: string;
  raw: string;
}
interface Tokens {
  mode: 'brand' | 'demo';
  colors: TokenItem[];
  fonts: TokenItem[];
  weights: TokenItem[];
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface HsEditor {
  select: (el: Element | null) => void;
  deselect: () => void;
  setZoom: (z: number) => void;
  duplicate: () => void;
  remove: () => void;
  bringForward: () => void;
  bringBackward: () => void;
  undo: (cmd: Command) => void;
  redo: (cmd: Command) => void;
  pageCount: () => number;
  freeze: () => Promise<string>;
  tokens: () => Tokens;
  setStyle: (patch: Record<string, string | null>) => void;
  toggleAccent: (color: string, weight?: string) => void;
  detectFonts: () => Promise<string[]>;
  setFont: (family: string, afterHtml: string | null) => void;
}
interface IframeWindow extends Window {
  __hsHost?: {
    onSelect: (snap: Snapshot | null, count: number) => void;
    onLiveChange: (snap: Snapshot | null) => void;
    onCommand: (cmd: Command) => void;
  };
  __hsZoom?: number;
  __hsEditor?: HsEditor;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];

// M18 helpers: escape a family for an HTML attribute, and build a Google-Fonts
// CSS2 URL covering the common weights.
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const googleHref = (family: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap`;

// Bundled samples (M10): the landing page links here as /app/?sample=<name>.
// The files ship with the static site under /assets/ (see scripts/build-site.mjs);
// in dev, vite proxies /assets to the local server.
const SAMPLES: Record<string, string> = {
  carousel: '/assets/sample/carousel.html',
  post: '/assets/demo/post.html',
  legacy: '/assets/legacy/legacy.html',
};

export function App() {
  const adapter = useMemo(() => getAdapter(), []);

  // Direct-manipulation editing needs a pointer and room; on phones we say so
  // instead of rendering an unusable editor. (Decided once at load: rotating a
  // phone mid-session shouldn't teleport the UI.)
  const [desktopGate] = useState(() => window.innerWidth < 760);

  const [assets, setAssets] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.5);
  const [frameSize, setFrameSize] = useState({ w: 1160, h: 1400 });
  const [selection, setSelection] = useState<Snapshot | null>(null);
  const [selectCount, setSelectCount] = useState(0);
  const [log, setLog] = useState<Command[]>([]);
  const [pointer, setPointer] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [conflict, setConflict] = useState(false);
  const [draftHtml, setDraftHtml] = useState<string | null>(null);
  const [useDraft, setUseDraft] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [exportFormat, setExportFormat] = useState<'png' | 'jpeg'>('png');
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string[] | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [freezing, setFreezing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [tokens, setTokens] = useState<Tokens | null>(null);
  // Imported-font fidelity (M18): families the loaded design uses that fell back.
  const [missingFonts, setMissingFonts] = useState<string[]>([]);
  const [fontBusy, setFontBusy] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const rawHtmlRef = useRef<string | null>(null);
  const mtimeRef = useRef<number | null>(null);
  const logRef = useRef<Command[]>([]);
  const pointerRef = useRef(0);
  const zoomRef = useRef(zoom);
  const pendingFreezeRef = useRef<string | null>(null);
  zoomRef.current = zoom;

  const dirty = pointer > 0;
  const editor = () => (iframeRef.current?.contentWindow as IframeWindow | null)?.__hsEditor;

  const refreshAssets = useCallback(async () => {
    try {
      const list = await adapter.listAssets();
      setAssets(list);
      setSelectedPath((cur) => cur ?? list[0] ?? null);
    } catch {
      setError('Could not reach the server.');
    }
  }, [adapter]);

  useEffect(() => {
    refreshAssets();
  }, [refreshAssets]);

  // CLI "open a file" mode: `fixhtml slide.html` opens the app at /?open=slide.html.
  const openedRef = useRef(false);
  useEffect(() => {
    if (adapter.kind !== 'local' || openedRef.current) return;
    const open = new URLSearchParams(window.location.search).get('open');
    if (open) {
      openedRef.current = true;
      setSelectedPath(open);
    }
  }, [adapter]);

  // Sample inlet: fetch the bundled asset once on boot, then behave like a drop.
  const sampleLoadedRef = useRef(false);
  useEffect(() => {
    if (adapter.kind !== 'browser' || sampleLoadedRef.current) return;
    const name = new URLSearchParams(window.location.search).get('sample');
    const src = name ? SAMPLES[name] : undefined;
    if (!src) return;
    sampleLoadedRef.current = true;
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((html) => importFrom(`${name}.html`, html))
      .catch(() => setError(`Could not load the ${name} sample.`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  useEffect(() => {
    if (!selectedPath) return;
    rawHtmlRef.current = null;
    mtimeRef.current = null;
    setSelection(null);
    setSelectCount(0);
    setLog([]);
    setPointer(0);
    logRef.current = [];
    pointerRef.current = 0;
    setSaveStatus('idle');
    setConflict(false);
    setDraftHtml(null);
    setUseDraft(false);
    setMissingFonts([]);
    setFontBusy(null);
    setExportResult(null);
    setExportError(null);
    adapter
      .loadAsset(selectedPath)
      .then((data) => {
        rawHtmlRef.current = data.html;
        mtimeRef.current = data.mtime;
        if (data.draft) setDraftHtml(data.draft);
      })
      .catch(() => setError(`Could not load ${selectedPath}`));
  }, [selectedPath, loadNonce, adapter]);

  useEffect(() => {
    editor()?.setZoom(zoom);
  }, [zoom, reloadNonce]);

  const editView = useMemo(
    () => (selectedPath ? adapter.editView(selectedPath, { draft: useDraft, nonce: reloadNonce }) : null),
    [adapter, selectedPath, useDraft, reloadNonce]
  );

  // Autosave the in-progress state to a draft, debounced.
  useEffect(() => {
    if (pointer === 0 || !selectedPath || !rawHtmlRef.current) return;
    const path = selectedPath;
    const t = setTimeout(() => {
      const html = applyLog(rawHtmlRef.current!, logRef.current.slice(0, pointerRef.current));
      adapter.saveDraft(path, html).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [log, pointer, selectedPath, adapter]);

  // A font fix changes what's available, so re-detect when undo/redo touches one.
  const afterUndoRedo = (cmd: Command | undefined) => {
    if (cmd?.op === 'font') editor()?.detectFonts().then((l) => setMissingFonts(l ?? [])).catch(() => {});
  };
  const doUndo = useCallback(() => {
    if (pointerRef.current <= 0) return;
    const cmd = logRef.current[pointerRef.current - 1];
    editor()?.undo(cmd);
    pointerRef.current -= 1;
    setPointer(pointerRef.current);
    setSaveStatus('idle');
    afterUndoRedo(cmd);
  }, []);
  const doRedo = useCallback(() => {
    if (pointerRef.current >= logRef.current.length) return;
    const cmd = logRef.current[pointerRef.current];
    editor()?.redo(cmd);
    pointerRef.current += 1;
    setPointer(pointerRef.current);
    setSaveStatus('idle');
    afterUndoRedo(cmd);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if (meta && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        doRedo();
      }
    },
    [doUndo, doRedo]
  );
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  // Client-side freeze: run the lift in the iframe, replace the source in place.
  const runFreeze = useCallback(async () => {
    const ed = editor();
    if (!ed?.freeze || !selectedPath) return;
    setFreezing(true);
    try {
      // Measure at a desktop viewport, not whatever width the iframe happens to
      // have: a free-form asset laid out at a narrow viewport wraps/clips, and the
      // freeze would bake that too-small geometry into the page (then
      // overflow:hidden cuts it). Resize the iframe node DIRECTLY and force a
      // synchronous reflow — never wait on requestAnimationFrame here: Chrome
      // starves rAF in unfocused/occluded windows, which left the auto-freeze
      // permanently stalled. React state (frameSize) is corrected on reload.
      const frame = iframeRef.current;
      if (frame) {
        if ((Number(frame.width) || 0) < 1920) frame.width = '1920';
        if ((Number(frame.height) || 0) < 1200) frame.height = '1200';
        void frame.contentDocument?.documentElement.offsetWidth; // force reflow
      }
      const html = await ed.freeze();
      await adapter.saveAsset(selectedPath, html, { baseMtime: mtimeRef.current, force: true, download: false });
      rawHtmlRef.current = html;
      logRef.current = [];
      pointerRef.current = 0;
      setLog([]);
      setPointer(0);
      setReloadNonce((n) => n + 1);
    } finally {
      setFreezing(false);
    }
  }, [adapter, selectedPath]);

  async function importFrom(name: string, html: string) {
    try {
      if (needsRender(html)) {
        setRendering(true);
        try {
          html = await renderToStatic(html);
        } finally {
          setRendering(false);
        }
      }
      const path = await adapter.importHtml(name, html);
      await refreshAssets();
      pendingFreezeRef.current = isContract(html) ? null : path;
      setSelectedPath(path);
    } catch {
      setError('Import failed.');
    }
  }

  // Drop / paste inlets.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = [...e.dataTransfer.files].find((f) => /\.html?$/i.test(f.name) || f.type === 'text/html');
    if (file) {
      file.text().then((html) => importFrom(file.name, html));
      return;
    }
    const html = e.dataTransfer.getData('text/html') || e.dataTransfer.getData('text/plain');
    if (html && /<[a-z!]/i.test(html)) importFrom('pasted', html);
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const html = e.clipboardData?.getData('text/html') || e.clipboardData?.getData('text/plain') || '';
      if (/<(!doctype|html|body|div|section|main|article)/i.test(html)) {
        e.preventDefault();
        importFrom('pasted', html);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  function handleFrameLoad() {
    const frame = iframeRef.current;
    const cdoc = frame?.contentDocument;
    const win = frame?.contentWindow as IframeWindow | null | undefined;
    if (!cdoc?.body || !win || !selectedPath) return;

    const w = Math.max(cdoc.body.scrollWidth, cdoc.documentElement.scrollWidth);
    const h = Math.max(cdoc.body.scrollHeight, cdoc.documentElement.scrollHeight);
    setFrameSize({ w, h });
    const pc = cdoc.querySelectorAll('.hs-page').length;
    setPageCount(pc);

    type Wired = Document & { __hsWired?: boolean };
    if ((cdoc as Wired).__hsWired) return;
    (cdoc as Wired).__hsWired = true;

    win.__hsHost = {
      onSelect: (snap, count) => {
        setSelection(snap);
        setSelectCount(count);
      },
      onLiveChange: (snap) => setSelection(snap),
      onCommand: (cmd) => {
        const next = logRef.current.slice(0, pointerRef.current).concat([cmd]);
        logRef.current = next;
        pointerRef.current = next.length;
        setLog(next);
        setPointer(next.length);
        setSaveStatus('idle');
      },
    };
    win.__hsZoom = zoomRef.current;
    win.addEventListener('keydown', onKeyDown);

    const s1 = cdoc.createElement('script');
    s1.textContent = moveableSource;
    cdoc.body.appendChild(s1);
    // Browser build exports with snapdom, which reads fonts from the global
    // `document` — so it must live in the iframe (window.snapdom), not the parent.
    if (adapter.kind === 'browser') {
      const sf = cdoc.createElement('script');
      sf.textContent = snapdomSource;
      cdoc.body.appendChild(sf);
    }
    const s2 = cdoc.createElement('script');
    s2.textContent = iframeRuntimeSource;
    cdoc.body.appendChild(s2);

    setTokens(win.__hsEditor?.tokens() ?? null);

    // Auto-freeze a freshly imported free-form asset (the demo's front door).
    if (pc === 0 && pendingFreezeRef.current === selectedPath) {
      pendingFreezeRef.current = null;
      setTimeout(() => runFreeze(), 0);
      return; // detection runs on the reload after freeze
    }
    // Flag any imported font that fell back (M18).
    win.__hsEditor?.detectFonts().then((list) => setMissingFonts(list ?? [])).catch(() => {});
  }

  // Re-run detection against the live iframe (after a fix / undo / redo).
  const redetectFonts = useCallback(() => {
    editor()?.detectFonts().then((list) => setMissingFonts(list ?? [])).catch(() => {});
  }, []);

  // Probe the Google Fonts CSS2 API in a throwaway parent-doc <link> (no bundled
  // index): a known family returns a stylesheet (onload); an unknown one 400s
  // (onerror). The stylesheet loading doesn't fetch the face — nothing here USES it —
  // so force the load with document.fonts.load() before deciding. Only commit the
  // link to the asset when the family really exists.
  function googleHasFamily(family: string): Promise<boolean> {
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = googleHref(family);
      let done = false;
      const finish = (v: boolean) => { if (done) return; done = true; link.remove(); resolve(v); };
      link.onload = () =>
        document.fonts
          .load(`16px "${family}"`)
          .then((faces) => finish(faces.length > 0))
          .catch(() => finish(false));
      link.onerror = () => finish(false);
      setTimeout(() => finish(false), 4000);
      document.head.appendChild(link);
    });
  }

  async function uploadFontFor(family: string, file: File) {
    setFontBusy(family);
    try {
      const raw = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('read failed'));
        fr.readAsDataURL(file);
      });
      const [fmt, mime] = /\.woff2$/i.test(file.name) ? ['woff2', 'font/woff2']
        : /\.woff$/i.test(file.name) ? ['woff', 'font/woff']
        : /\.otf$/i.test(file.name) ? ['opentype', 'font/otf'] : ['truetype', 'font/ttf'];
      // Normalise the MIME the browser guessed (often application/octet-stream) to
      // the real font type so the @font-face is valid everywhere, not just via the
      // format() hint.
      const dataUri = raw.replace(/^data:[^;,]*/, `data:${mime}`);
      const css = `@font-face{font-family:"${family.replace(/"/g, '\\"')}";src:url(${dataUri}) format("${fmt}");font-display:swap;}`;
      editor()?.setFont(family, `<style data-hs-font="${escAttr(family)}">${css}</style>`);
      await new Promise((r) => setTimeout(r, 150));
      redetectFonts();
    } catch {
      setError('Could not read that font file.');
    } finally {
      setFontBusy(null);
    }
  }

  async function matchGoogleFor(family: string) {
    setFontBusy(family);
    try {
      if (await googleHasFamily(family)) {
        editor()?.setFont(family, `<link data-hs-font="${escAttr(family)}" rel="stylesheet" href="${googleHref(family)}">`);
        await new Promise((r) => setTimeout(r, 400));
        redetectFonts();
      } else {
        setError(`"${family}" isn't on Google Fonts — upload the file instead.`);
      }
    } finally {
      setFontBusy(null);
    }
  }

  function acceptFallback(family: string) {
    setMissingFonts((m) => m.filter((f) => f !== family));
  }

  async function save(force = false) {
    if (!rawHtmlRef.current || !selectedPath) return;
    setSaveStatus('saving');
    const html = applyLog(rawHtmlRef.current, logRef.current.slice(0, pointerRef.current));
    try {
      const res = await adapter.saveAsset(selectedPath, html, {
        baseMtime: mtimeRef.current,
        force,
        download: adapter.kind === 'browser',
      });
      if (res.conflict) {
        setConflict(true);
        setSaveStatus('idle');
        return;
      }
      mtimeRef.current = res.mtime;
      logRef.current = [];
      pointerRef.current = 0;
      setLog([]);
      setPointer(0);
      setSelection(null);
      setSelectCount(0);
      setSaveStatus('saved');
      setConflict(false);
      rawHtmlRef.current = html;
      setUseDraft(false);
      setDraftHtml(null);
      setReloadNonce((n) => n + 1);
    } catch {
      setSaveStatus('error');
    }
  }

  function restoreDraft() {
    if (!draftHtml) return;
    rawHtmlRef.current = draftHtml;
    logRef.current = [];
    pointerRef.current = 0;
    setLog([]);
    setPointer(0);
    setUseDraft(true);
    setDraftHtml(null);
    setReloadNonce((n) => n + 1);
  }
  function discardDraft() {
    if (selectedPath) adapter.deleteDraft(selectedPath).catch(() => {});
    setDraftHtml(null);
  }
  function reloadFromDisk() {
    setConflict(false);
    setLoadNonce((n) => n + 1);
    setReloadNonce((n) => n + 1);
  }

  async function runExport(scale: 1 | 2 | 3) {
    if (!selectedPath || exporting) return;
    setExporting(true);
    setExportResult(null);
    setExportError(null);
    try {
      const files = await adapter.exportAsset(selectedPath, {
        format: exportFormat,
        scale,
        iframe: iframeRef.current,
      });
      setExportResult(files);
    } catch (e) {
      // Surface the real reason (e.g. the "npx playwright install chromium" hint).
      setExportError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  function goToPage(i: number) {
    const cdoc = iframeRef.current?.contentDocument;
    const stage = stageRef.current;
    if (!cdoc || !stage) return;
    const page = cdoc.querySelectorAll<HTMLElement>('.hs-page')[i];
    if (!page) return;
    stage.scrollTop += page.getBoundingClientRect().top - stage.getBoundingClientRect().top - 20;
  }

  const viewportStyle = useMemo(
    () => ({ transform: `scale(${zoom})`, width: frameSize.w, height: frameSize.h * zoom }),
    [zoom, frameSize]
  );

  function stepZoom(dir: number) {
    setZoom((z) => {
      const i = ZOOM_STEPS.findIndex((s) => Math.abs(s - z) < 0.001);
      const base = i === -1 ? ZOOM_STEPS.findIndex((s) => s >= z) : i;
      return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, base + dir))];
    });
  }

  const saveLabel =
    saveStatus === 'saving' ? 'Saving…'
    : saveStatus === 'saved' ? (adapter.kind === 'browser' ? 'Downloaded ✓' : 'Saved ✓')
    : saveStatus === 'error' ? 'Save failed'
    : dirty ? (adapter.kind === 'browser' ? 'Download HTML' : 'Save')
    : adapter.kind === 'browser' ? 'Download HTML' : 'Saved';

  if (desktopGate) {
    return (
      <div className="gate">
        <h1>FixHTML<span className="tld">.app</span></h1>
        <p><strong>HTML files live on desktop.</strong></p>
        <p>That&rsquo;s where the magic happens. Open fixhtml.app on your computer
        and drop your file there.</p>
      </div>
    );
  }

  const lastCmd = pointer > 0 ? log[pointer - 1] : undefined;
  const redoAvail = log.length - pointer;
  const single = selectCount === 1;
  const any = selectCount >= 1;

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <aside className="sidebar">
        <h1>FixHTML<span className="tld">.app</span></h1>
        <p className="tagline">
          {adapter.kind === 'browser' ? 'Your file never leaves the browser' : 'Local studio'}
        </p>

        <button className="import-btn" onClick={() => document.getElementById('file-input')?.click()}>
          + Import HTML
        </button>
        <input
          id="file-input"
          type="file"
          accept=".html,text/html"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) f.text().then((html) => importFrom(f.name, html));
            e.target.value = '';
          }}
        />

        <p className="section-label" style={{ marginTop: 20 }}>Assets</p>
        {assets.length === 0 && (
          <p className="readout muted">Drop or paste an HTML file to begin.</p>
        )}
        <ul className="asset-list">
          {assets.map((path) => (
            <li key={path}>
              <button className={path === selectedPath ? 'active' : ''} onClick={() => setSelectedPath(path)}>
                {path}
              </button>
            </li>
          ))}
        </ul>

        {pageCount > 1 && (
          <>
            <p className="section-label" style={{ marginTop: 24 }}>Pages</p>
            <div className="pagebar">
              {Array.from({ length: pageCount }, (_, i) => (
                <button key={i} onClick={() => goToPage(i)}>{i + 1}</button>
              ))}
            </div>
          </>
        )}

        {selectedPath && pageCount === 0 && (
          <>
            <p className="section-label" style={{ marginTop: 24 }}>Not editable yet</p>
            <p className="readout muted">
              This design isn&apos;t split into movable elements yet. Edit layers pins each
              block in place — pixel-identical — so you can drag, resize, rotate, and
              restyle them.
            </p>
            <button className="freeze-btn" onClick={runFreeze} disabled={freezing}>
              {freezing ? 'Preparing layers…' : 'Edit layers'}
            </button>
          </>
        )}

        <p className="section-label" style={{ marginTop: 24 }}>Selection</p>
        {selectCount > 1 ? (
          <p className="readout">{selectCount} elements selected</p>
        ) : selection ? (
          <div className="readout">
            <div>#{selection.eid} · {Math.round(selection.width)}×{Math.round(selection.height)}</div>
            <div>left {Math.round(selection.left)} · top {Math.round(selection.top)}</div>
            <div>rotation {Math.round(selection.rotation)}°</div>
          </div>
        ) : (
          <p className="readout muted">
            Click to select (Shift = add). Marquee-drag empty space. Double-click to edit text.
          </p>
        )}

        {selectCount === 1 && selection?.style && tokens && (
          <>
            <p className="section-label" style={{ marginTop: 24 }}>
              Style{tokens.mode === 'demo' ? ' · from document' : ''}
            </p>
            <div className="stylepanel">
              <label>Font</label>
              <select value="" onChange={(e) => e.target.value && editor()?.setStyle({ 'font-family': e.target.value })}>
                <option value="">{selection.style.fontFamily}</option>
                {tokens.fonts.map((f) => <option key={f.name} value={f.value}>{f.name}</option>)}
              </select>

              <label>Weight</label>
              <select value="" onChange={(e) => e.target.value && editor()?.setStyle({ 'font-weight': e.target.value })}>
                <option value="">{selection.style.fontWeight}</option>
                {tokens.weights.map((w) => <option key={w.name} value={w.value}>{w.name}</option>)}
              </select>

              <label>Size</label>
              <div className="nudge">
                <button onClick={() => editor()?.setStyle({ 'font-size': Math.max(4, selection.style!.fontSize - 4) + 'px' })}>−</button>
                <span>{selection.style.fontSize}px</span>
                <button onClick={() => editor()?.setStyle({ 'font-size': selection.style!.fontSize + 4 + 'px' })}>+</button>
              </div>

              <label>Line height</label>
              <div className="nudge">
                <button onClick={() => { const lh = parseFloat(selection.style!.lineHeight) || selection.style!.fontSize * 1.2; editor()?.setStyle({ 'line-height': Math.max(4, lh - 4) + 'px' }); }}>−</button>
                <span>{selection.style.lineHeight}</span>
                <button onClick={() => { const lh = parseFloat(selection.style!.lineHeight) || selection.style!.fontSize * 1.2; editor()?.setStyle({ 'line-height': lh + 4 + 'px' }); }}>+</button>
              </div>

              <label>Color</label>
              <div className="swatches">
                {tokens.colors.map((c) => (
                  <button
                    key={c.name}
                    title={c.name}
                    className="sw"
                    style={{ background: c.raw }}
                    onClick={() => editor()?.setStyle({ color: c.value })}
                  />
                ))}
              </div>

              <label>Opacity</label>
              <input
                type="range" min={0} max={1} step={0.05}
                value={selection.style.opacity}
                onChange={(e) => editor()?.setStyle({ opacity: e.target.value })}
              />

              <button
                className="accent-btn"
                onClick={() => {
                  const a = tokens.colors.find((c) => c.name === 'accent') ?? tokens.colors[0];
                  const w = tokens.weights.find((x) => x.name === 'display');
                  if (a) editor()?.toggleAccent(a.value, w?.value);
                }}
              >
                Accent selected text
              </button>
            </div>
          </>
        )}

        <p className="section-label" style={{ marginTop: 24 }}>Command log</p>
        <p className="readout muted">
          {pointer} command{pointer === 1 ? '' : 's'}{redoAvail ? ` (+${redoAvail} redo)` : ''}
          {lastCmd ? ` · last: ${describeCommand(lastCmd)}` : ''}
        </p>

        {pageCount > 0 && (
          <>
            <p className="section-label" style={{ marginTop: 24 }}>Export</p>
            <div className="pagebar" style={{ marginBottom: 8 }}>
              <button className={exportFormat === 'png' ? 'on' : ''} style={{ width: 'auto', padding: '0 10px' }} onClick={() => setExportFormat('png')}>PNG</button>
              <button className={exportFormat === 'jpeg' ? 'on' : ''} style={{ width: 'auto', padding: '0 10px' }} onClick={() => setExportFormat('jpeg')}>JPEG</button>
            </div>
            <div className="pagebar">
              {([1, 2, 3] as const).map((s) => (
                <button key={s} disabled={exporting} onClick={() => runExport(s)} style={{ width: 'auto', padding: '0 10px' }}>{s}×</button>
              ))}
            </div>
            {exporting && <p className="readout muted">Rendering…</p>}
            {exportError && <p className="error" style={{ whiteSpace: 'pre-line' }}>{exportError}</p>}
            {exportResult && (
              <ul className="export-list">
                {exportResult.length === 0 ? (
                  <li className="muted">Export failed.</li>
                ) : (
                  exportResult.map((f) => (
                    <li key={f}>
                      {adapter.kind === 'local' ? (
                        <a href={`/exports/${f}`} target="_blank" rel="noreferrer">{f}</a>
                      ) : (
                        <span>Downloaded {f}</span>
                      )}
                    </li>
                  ))
                )}
              </ul>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}
      </aside>

      <main className="stage" ref={stageRef}>
        <div className="toolbar">
          <button onClick={() => stepZoom(-1)}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => stepZoom(1)}>+</button>
          <span className="sep" />
          <button title="Undo (⌘Z)" onClick={doUndo} disabled={pointer === 0}>↶</button>
          <button title="Redo (⇧⌘Z)" onClick={doRedo} disabled={redoAvail === 0}>↷</button>
          <span className="sep" />
          <button title="Bring backward" onClick={() => editor()?.bringBackward()} disabled={!single}>⇩</button>
          <button title="Bring forward" onClick={() => editor()?.bringForward()} disabled={!single}>⇧</button>
          <button title="Duplicate" onClick={() => editor()?.duplicate()} disabled={!single}>⧉</button>
          <button title="Delete" onClick={() => editor()?.remove()} disabled={!any}>🗑</button>
          <span className="sep" />
          <button className="save" onClick={() => save()} disabled={!dirty || saveStatus === 'saving'}>
            {saveLabel}
          </button>
        </div>

        {rendering && (
          <div className="banner">
            <span>This file builds itself with JavaScript. Running it once to capture the design…</span>
          </div>
        )}
        {draftHtml && (
          <div className="banner">
            <span>Unsaved draft found for this asset.</span>
            <button onClick={restoreDraft}>Restore</button>
            <button onClick={discardDraft}>Discard</button>
          </div>
        )}
        {conflict && (
          <div className="banner warn">
            <span>This file changed on disk since you opened it.</span>
            <button onClick={reloadFromDisk}>Reload</button>
            <button onClick={() => save(true)}>Overwrite</button>
          </div>
        )}

        {missingFonts.length > 0 && (
          <div className="font-banner">
            <div className="fb-head">
              {missingFonts.length === 1
                ? '1 font in this file isn’t available and is showing a substitute:'
                : `${missingFonts.length} fonts in this file aren’t available and are showing substitutes:`}
            </div>
            <ul>
              {missingFonts.map((f) => (
                <li key={f}>
                  <span className="fb-fam">{f}</span>
                  <span className="fb-actions">
                    {fontBusy === f ? (
                      <span className="fb-busy">working…</span>
                    ) : (
                      <>
                        <label className="fb-btn">
                          Upload font…
                          <input
                            type="file"
                            accept=".woff2,.woff,.ttf,.otf,font/*"
                            hidden
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (file) uploadFontFor(f, file);
                            }}
                          />
                        </label>
                        <button className="fb-btn" onClick={() => matchGoogleFor(f)}>Find on Google Fonts</button>
                        <button className="fb-btn ghost" onClick={() => acceptFallback(f)}>Keep fallback</button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!selectedPath && (
          <div className="empty">
            <div className="drop-hint">Drop an AI-generated HTML file here, or import / paste.</div>
          </div>
        )}

        {editView && selectedPath && (
          <div className="viewport" style={viewportStyle}>
            <iframe
              ref={iframeRef}
              key={`${selectedPath}#${reloadNonce}`}
              title={selectedPath}
              src={editView.src}
              srcDoc={editView.srcDoc}
              onLoad={handleFrameLoad}
              width={frameSize.w}
              height={frameSize.h}
            />
          </div>
        )}

        {dragging && <div className="drop-overlay">Drop HTML to import</div>}
      </main>
    </div>
  );
}
