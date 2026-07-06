// Command-log edit model.
//
// Addressing: elements are keyed by an ephemeral `data-eid` that is DERIVED from
// the persistent `data-hs-id` — eid == hs-id when the element already has one,
// else a fresh id above the max (document order for a never-saved file). The
// server's edit view and this save path run the IDENTICAL derivation, so a file's
// element keeps the same id across sessions (M5 cross-session stability): reopening
// derives eids from persisted ids, never by re-tagging document order.
//
// Save = derive eids on a pristine copy, replay the log IN ORDER resolving by
// attribute, persist `data-hs-id = eid` on every `.hs-el`, strip `data-eid`, and
// serialize idempotently. Because the serializer is a fixed point, a re-save with
// no edits reproduces the file byte-for-byte (M5 zero-diff).

export type CssValue = string | null; // null = property absent
export type StyleDelta = Record<string, CssValue>;

export interface ElementSpec {
  eid: number;
  html: string; // outerHTML (carries data-eid; converted to data-hs-id on save)
  pageIndex: number;
  beforeEid: number | null; // the .hs-el it sits before (null = last in page)
  commentBefore: string | null; // adjacent authoring comment (label), if any
}

export type OpState =
  | StyleDelta
  | { html: string }
  | { beforeEid: number | null }
  | { spec: ElementSpec }
  | { removed: true };

export interface ElementDelta {
  eid: number;
  before: OpState;
  after: OpState;
}

export type Op = 'style' | 'html' | 'reorder' | 'insert' | 'delete' | 'font';

// A `font` command is document-level (not eid-keyed): it adds/removes a
// `[data-hs-font="<family>"]` element (a <style> with a data-URI @font-face, or a
// Google-Fonts <link>) in <head> to fix an imported family that fell back (M18).
// `before`/`after` are that element's outerHTML, or null for absent.
export interface FontDelta {
  family: string;
  before: string | null;
  after: string | null;
}

export interface Command {
  op: Op;
  deltas: ElementDelta[];
  fonts?: FontDelta[]; // present only for op:'font'
}

// --- id derivation (mirrored by the server's toEditView) ---------------------

/** Tag each `.hs-el` with a `data-eid`: its `data-hs-id` if present, else a fresh
 *  id above the max existing hs-id (document order for a never-saved file).
 *  MIRROR: server/index.mjs `toEditView` implements the identical rule on the
 *  node-html-parser tree — the two parsers can't share code, so if the rule
 *  changes, BOTH must change together or session ids drift. */
export function deriveEids(doc: Document): void {
  const els = doc.querySelectorAll<HTMLElement>('.hs-el');
  let maxId = -1;
  els.forEach((el) => {
    const h = el.getAttribute('data-hs-id');
    if (h != null) {
      const n = Number(h);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    }
  });
  let counter = maxId + 1;
  els.forEach((el) => {
    const h = el.getAttribute('data-hs-id');
    el.setAttribute('data-eid', h != null ? h : String(counter++));
  });
}

// --- DOM ops (resolve by attribute, never by index) --------------------------

function findEl(doc: Document, eid: number): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`.hs-el[data-eid="${eid}"]`);
}

function applyStyle(el: HTMLElement, delta: StyleDelta): void {
  for (const [prop, val] of Object.entries(delta)) {
    if (val === null || val === '') el.style.removeProperty(prop);
    else el.style.setProperty(prop, val);
  }
}

function precedingComment(el: Element): Comment | null {
  let s = el.previousSibling;
  while (s && s.nodeType === 3 && !s.textContent?.trim()) s = s.previousSibling;
  return s && s.nodeType === 8 ? (s as Comment) : null;
}

function placeBefore(doc: Document, el: HTMLElement, beforeEid: number | null): void {
  const page = el.closest('.hs-page');
  if (!page) return;
  const ref = beforeEid == null ? null : findEl(doc, beforeEid);
  if (ref && ref.parentElement === page) page.insertBefore(el, ref);
  else page.appendChild(el);
}

function insertSpec(doc: Document, spec: ElementSpec): void {
  if (findEl(doc, spec.eid)) return; // idempotent
  const page = doc.querySelectorAll('.hs-page')[spec.pageIndex];
  if (!page) return;
  const tmp = doc.createElement('div');
  tmp.innerHTML = spec.html;
  const el = tmp.firstElementChild as HTMLElement | null;
  if (!el) return;
  const ref = spec.beforeEid == null ? null : findEl(doc, spec.beforeEid);
  if (ref && ref.parentElement === page) page.insertBefore(el, ref);
  else page.appendChild(el);
  if (spec.commentBefore != null) page.insertBefore(doc.createComment(spec.commentBefore), el);
}

/** Add or remove the `[data-hs-font="<family>"]` element in <head> (M18). */
function applyFontDelta(doc: Document, family: string, html: string | null): void {
  const head = doc.head || doc.documentElement;
  head.querySelectorAll('[data-hs-font]').forEach((el) => {
    if (el.getAttribute('data-hs-font') === family) el.remove();
  });
  if (html != null) {
    const tmp = doc.createElement('div');
    tmp.innerHTML = html;
    const el = tmp.firstElementChild;
    if (el) head.appendChild(el);
  }
}

/** Apply one command in the given direction, resolving by attribute. */
export function applyOpToDoc(doc: Document, cmd: Command, dir: 'before' | 'after'): void {
  if (cmd.op === 'font') {
    for (const f of cmd.fonts ?? []) applyFontDelta(doc, f.family, dir === 'after' ? f.after : f.before);
    return;
  }
  for (const d of cmd.deltas) {
    const state = dir === 'after' ? d.after : d.before;
    const el = findEl(doc, d.eid);
    switch (cmd.op) {
      case 'style':
        if (el) applyStyle(el, state as StyleDelta);
        break;
      case 'html':
        if (el) el.innerHTML = (state as { html: string }).html;
        break;
      case 'reorder':
        if (el) placeBefore(doc, el, (state as { beforeEid: number | null }).beforeEid);
        break;
      case 'insert':
      case 'delete':
        if ((state as { removed?: true }).removed) {
          if (el) {
            precedingComment(el)?.remove(); // drop the orphaned label comment too
            el.remove();
          }
        } else {
          insertSpec(doc, (state as { spec: ElementSpec }).spec);
        }
        break;
    }
  }
}

/** Replay the log onto a pristine copy, persist hs-ids, serialize (idempotent). */
export function applyLog(originalHtml: string, log: Command[]): string {
  const dom = new DOMParser().parseFromString(originalHtml, 'text/html');
  deriveEids(dom);
  for (const cmd of log) applyOpToDoc(dom, cmd, 'after');
  // Persist a stable data-hs-id (= eid) on every element, then drop the ephemeral
  // data-eid so it never reaches disk.
  dom.querySelectorAll<HTMLElement>('.hs-el').forEach((el) => {
    const eid = el.getAttribute('data-eid');
    if (eid != null) el.setAttribute('data-hs-id', eid);
    el.removeAttribute('data-eid');
  });
  // No trailing "\n" after </html>: on reparse the HTML "after-body" rule reparents
  // any post-</html> whitespace INTO <body>, so an appended newline would accumulate
  // one per save and break the zero-diff (idempotency) guarantee.
  const doctype = dom.doctype ? '<!doctype html>\n' : '';
  return doctype + dom.documentElement.outerHTML;
}

/** One-line summary of a command for the sidebar / verification. */
export function describeCommand(cmd: Command): string {
  if (cmd.op === 'font') return `font ${(cmd.fonts ?? []).map((f) => f.family).join(',')}`;
  const eids = cmd.deltas.map((d) => `#${d.eid}`).join(',');
  return `${cmd.op} ${eids}`;
}
