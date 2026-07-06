# FixHTML — build journal

How FixHTML was built, milestone by milestone, with the design notes and the traps that
cost real time. Each milestone shipped only after its acceptance check passed and an
independent review reproduced it. It doubles as a portfolio of the engineering decisions.

## Milestones

- **M0 — Fixtures** ✔ `assets/sample/carousel.html` (contract: 2 pages, `data-size`,
  base rule, a local image, a rotated+scaled `.hs-el`, nested `<em>`/`<strong>`) and
  `assets/legacy/legacy.html` (free-form flexbox, for the M7 import/freeze).
- **M1 — Skeleton** ✔ backend serves `assets/` + `brands/` statically; the editor iframe
  loads the asset's **real served URL** (not `srcdoc`), so relative image/font/`tokens.css`
  URLs resolve; renders correctly at 0.5×, 1×, 2×.
- **M2 — Selection + command log + drag** ✔ DOMParser-first `data-eid` tagging (server),
  click-select to nearest `.hs-el` with click-through cycling, drag updates `left`/`top`
  live. Every gesture is one append-only command with `before`/`after` (`prevValue`).
- **M3 — Resize / rotate / snap / multi-select** ✔ 8-handle resize (Shift = lock ratio),
  corner rotate, snapping to page edges/center + sibling guidelines, marquee multi-select
  with group drag/resize/rotate. Position → `left`/`top`, size → `width`/`height`,
  rotation → `transform: rotate()` **preserving other transform parts (e.g. `scale()`)**.
  Verified drag/resize/rotate/snap at both 0.5× and 2× zoom.
- **M4 — Text edit / z-order / duplicate / delete / undo-redo** ✔ double-click edits the
  deepest text block (`contenteditable=plaintext-only`, `pre-wrap`) and records `op:'html'`
  with the `.hs-el`'s innerHTML — nested `<em>`/`<strong>` survive; bring forward/back
  (`op:'reorder'`); duplicate (`op:'insert'`, fresh eid) and delete (`op:'delete'`);
  undo/redo (⌘Z / ⇧⌘Z) apply `before`/`after` in place.
  Verified: undo of every op type restores state exactly.

**Structural correctness (the M4 design note):** `applyLog`/`applyOp` resolve elements by
`data-eid` ATTRIBUTE and replay the log IN ORDER, never by array index. Verified end to
end: delete element #5, then move #6, save → the saved file moved #6 (the chip) and left
#7 (the page number) untouched. Index-based resolution would have shifted #6→#7 and edited
the wrong element. Duplicated elements get fresh eids above the original count, created by
their `insert` command so later references resolve.

- **M5 — Save-back / autosave / stale guard** ✔ idempotent serializer (a re-save with no
  edits is byte-identical — zero diff), `data-hs-id` persistence with cross-session
  stability, sidecar autosave, mtime stale-file guard, orphaned-comment cleanup on delete.
- **M6 — Export (Playwright)** ✔ `POST /export` renders each `.hs-page` to PNG/JPEG at
  1×/2×/3×. Verified: output dimensions = `data-size` × scale (1080×1350 / 2160×2700 /
  3240×4050), all pages in one call with correct numbering (`carousel-01@2x.png`…), and a
  no-background page exports transparent (corner pixel `[0,0,0,0]`, painted pixel opaque).

**Export traps handled (`server/export.mjs`):** one warm browser context **per scale**
(`deviceScaleFactor` is fixed at context creation); iterate with
`locator('.hs-page').nth(i).screenshot()` (a bare `.screenshot()` on multiple matches
throws); inject a force-visible style before shooting; `animations: 'disabled'` +
`await document.fonts.ready`; `omitBackground` for PNG only. Export loads the **raw** served
URL (`/assets/<file>`, never `?edit=1`) — it's the one context where the asset's own scripts
should run, and the edit view strips them.

- **M7 — Import / freeze** ✔ a "lift" converts a free-form asset to contract form: the single
  wrapper (or `<body>`) becomes a `.hs-page` and its direct children become
  absolutely-positioned `.hs-el`s, sized to the rendered page, with the base rule written in.
  The UI shows a "Freeze to contract" button for non-contract assets. (M9 moved the lift
  **client-side** — it runs in the editor iframe, `__hsEditor.freeze()`, and replaces the
  asset in place, so the lift lives in exactly one place.)

**Freeze verified pixel-identical:** using the M6 exporter as the comparison tool, the
original `.card` vs the frozen `.hs-page` diff was **0 pixels** (max channel delta 2/255),
and every frozen block selects with Moveable handles (draggable). The rotated `.stamp`
fixture is the trap: the lift measures the **untransformed** box, so the rotation isn't
applied twice.

**Lift precision detail:** integer `offsetLeft/Top/Width/Height` lose a rotated/fractional
block's sub-pixel width and shift its transform-origin (~0.4% drift on the stamp). To hit
pixel-identical, the lift strips the transform **first**, reads `getBoundingClientRect`
relative to the page's padding box with sub-pixel precision, then restores.

- **M8 — Brand stage-1 scaffolding** ✔ `brand.json` compiles to `tokens.css` + `BRAND.md`
  via `server/brand.mjs` / `npm run build:brand`; a generation prompt template
  (`GENERATE.md`) and a hand-authored `components.html` complete the brand folder. Verified:
  a frontend-slides preset → `brands/demo/brand.json` → a generated sample asset that uses
  **only** `var(--brand-*)` tokens (zero hard-coded colours/fonts) and renders on-brand
  through both the editor and the export path.

**Brand system (`brands/<name>/`):** `brand.json` is the single source. The compiler emits
`--brand-<kebab-path>` custom properties (`color.textMuted` → `--brand-text-muted`,
`typography.display.family` → `--brand-font-display`, `spacing.scale` → `--brand-space-1…N`).
Assets link `../../brands/<name>/tokens.css`; the server serves `/brands` statically so it
resolves identically in the editor iframe and Playwright export. Self-hosted `@font-face`
landed in M12: the compiler emits faces for the brand's fonts from `fonts/registry.json`,
so token font families render the real face (not a system fallback) in editor and export.

- **M9 — Web demo core** ✔ a backend-adapter interface (`app/src/adapter.ts`): one codebase,
  two build targets, never a fork. `LocalAdapter` (Node server) and `BrowserAdapter`
  (in-memory, srcdoc edit view, snapdom export, save = download HTML), picked by
  `VITE_ADAPTER`. Plus import inlets (drop / paste / file picker), **client-side freeze**
  (the same lift run in the iframe — no Playwright), auto-freeze of imported free-form
  assets, and snapdom in-browser export.

**Web demo (`npm run build:demo`):** verified end to end in the **static build with the dev
server killed** — imported a free-form Claude-style slide → it auto-froze to a contract asset
(rotated stamp preserved) → dragged a block → **downloaded the edited HTML** (frozen + edit,
zero editor artifacts) and a **2× PNG (2160×2700)** via snapdom. Two snapdom gotchas handled:
pass `dpr: 1` so `scale` is the sole multiplier (else retina doubles it to 4×), and
`deselect()` before capture so Moveable handles aren't in the image.

- **M11 — Style panel + accents (token-bound)** ✔ a per-selection panel: font family/weight
  (brand fonts ONLY), size + line-height nudges, colour swatches (`tokens.css` ONLY), opacity,
  and accent toggling — select words → wrap in `<span class="hs-accent">` with accent
  colour/weight from tokens, recorded as an `html` op. Every control routes through
  `__hsEditor.setStyle` → the command log → save. Colours/fonts are swatches/dropdowns only,
  so **off-brand values can't be entered**. Token discovery reads `--brand-*` from the linked
  stylesheet in brand mode; in the demo build (no brand) it falls back to the colours and
  fonts already in the imported document — "recolor with what's there".

- **M10 — Landing page** ✔ `landing/index.html` (the hero is a live canvas — the product
  demoing itself), three neutral sample assets wired to the demo via `?sample=`, FAQ, mobile
  stack ≤900px. `npm run build:site` composes `dist-site/` (landing at `/`, demo at `/app/`).
  Deployed to Vercel, live at fixhtml.app.

- **Launch-window hotfixes** (all reviewer-verified): text editing on already-selected
  elements (Moveable's dragArea overlay broke the dblclick target + caret placement);
  wide/desktop imports cut off (render + freeze now use a 1920×1200 desktop probe);
  auto-freeze stalling in unfocused windows (never gate on `requestAnimationFrame`);
  **single-wrapper descent** (freeze descends one-container designs, cap 4, to the first
  multi-sibling level; a styled wrapper becomes the artboard; fixture
  `assets/legacy/wrapped.html` freezes into 5 draggable blocks, before/after export
  pixel-identical, `legacy.html` regression clean).

- **M12 — Brand fonts (self-hosted) + open font library** ✔ two tiers, one mechanism.
  A curated ~17-family library (`fonts/manifest.json` → Fontsource devDependencies) and
  user-supplied `fonts/custom/` folders are both synced by **`npm run fonts`**
  (`scripts/sync-fonts.mjs`): it copies each family's latin WOFF2s + LICENSE into
  `fonts/library/<slug>/`, indexes custom fonts, and writes `fonts/registry.json`. The
  brand compiler emits `@font-face` in `tokens.css` **only for families the brand uses**
  (the demo brand → 7 faces: Archivo Black + Space Grotesk ×5 + a custom handwriting face;
  zero unused), with an absolute `/fonts/...` src the Node server serves — so the same WOFF2
  loads in the editor iframe and in Playwright export. Fresh-clone path verified: delete all
  generated artifacts → `npm run fonts` regenerates library + registry + tokens.css.
  Acceptance (`assets/demo/brand-fonts.html`): `document.fonts.check` true for both Archivo
  Black and the custom face in **editor and export**, the two renders **pixel-identical (0%
  diff)**, and a text-edit-then-undo sequence on the handwritten element keeps the custom
  font throughout. The M11 font picker lists the brand's fonts including the custom one.

- **M18 — Imported-font fidelity** ✔ silent font fallback on imported files is surfaced and
  fixable. **(a) Detection** (`__hsEditor.detectFonts`): the families a design actually uses
  are enumerated from computed styles and each is checked for availability — by **measuring
  rendered width against generic fallbacks**, NOT `document.fonts.check()`, which returns
  `true` for a family with no `@font-face` at all (the custom/handwritten case, this
  milestone's whole point). Missing families raise a banner; a Google-Fonts-linked file
  raises none. **(b) Resolution** per family, recorded as one `font` command (a new,
  document-level op): **upload** a WOFF2/TTF → a data-URI `@font-face` written INTO the asset
  (file never leaves the browser); **name-match** → probe the Google-Fonts CSS2 API on demand
  (no bundled index) and, if the family exists, inject a `<link>`; or **keep fallback**.
  **(c) Persistence**: the `font` op flows through `applyLog`, so the fix survives save AND
  export in **both** targets. Verified local (save → reopen clean → Playwright PNG shows the
  font offline) and demo (Download HTML carries the data-URI face; snapdom PNG shows it),
  plus the undo/redo sequence and no false positive on a Google-linked file.

  **Latent demo-export bug fixed along the way:** snapdom reads `@font-face` from the global
  `document`, but the asset lives in the iframe — so a parent-side capture embedded NO custom
  fonts (they fell back to OS fonts in every demo PNG). The browser export now injects snapdom
  into the iframe (`window.snapdom`) and captures there, so brand, Google-linked, and uploaded
  fonts all render in demo exports.

- **M15 — npx CLI (`fixhtml`)** ✔ the same local studio, shipped as a package. Three modes in
  `bin/fixhtml.mjs`: `fixhtml` serves the current directory and opens the asset list;
  `fixhtml <file.html>` opens that file directly (`/?open=`); `fixhtml export <file>
  [--scale 1|2|3] [--format png|jpeg]` runs a headless, agent-callable export. The Express
  server was refactored into a reusable `createApp({ assetsDir, … , staticDir })` — the CLI
  serves the **prebuilt** frontend (`dist/`, no Vite at runtime; frontend chunks moved to
  `/app-assets/` so they never collide with the user's `/assets/` folder). **Playwright is
  optional + lazy** (`optionalDependencies`, dynamic import): the editor runs without it, and
  an export without Chromium prints `npx playwright install chromium` rather than crashing.
  Acceptance (packed tarball in an empty temp dir): `fixhtml sample.html` opens the editor, a
  drag **saves back into the file**, and `export sample.html --scale 2` writes a 2160×2700 PNG.

  **Path traversal closed:** the CLI serves arbitrary user folders, so the file APIs resolve
  every client path inside the assets root (`../` or absolute → 400); verified no file
  disclosure (traversal attempts hit the SPA fallback, never `/etc/passwd`).

- **M16 — Agent flow packaging** ✔ a Claude Code skill (`skills/fixhtml/`) that, when you ask
  to visually edit or export an HTML asset, offers the `npx fixhtml-app <file>` handoff and can
  run the headless export itself; plus a README "Use with agents" section. Acceptance: an
  agent write during an open edit session triggers the Reload/Overwrite guard (the M5 mtime
  guard) rather than clobbering the human's visual edits.

## Design notes

### Stable ids across sessions (the M5 design note)

The ephemeral `data-eid` is DERIVED from the persistent `data-hs-id` (eid == hs-id when
present, else a fresh id above the max in document order). The server edit view and the save
path (`deriveEids`) run the IDENTICAL derivation, so reopening a saved file assigns eids from
persisted ids, never by re-tagging document order. Save persists `data-hs-id = eid`, strips
`data-eid`, and serializes idempotently — the one-time normalization lands on the first save
and the file is a fixed point thereafter (crucial detail: NO trailing newline after
`</html>`, or HTML's after-body rule reparents it into `<body>` and it accumulates one per
save).

### Autosave + stale guard

Edits debounce-write to a sidecar `<name>.draft.html` (never the source); the source save
clears it. `GET /api/asset` returns the source, its mtime, and any waiting draft; on load a
draft offers Restore/Discard. `POST /api/asset` sends the `baseMtime` it loaded with — if the
file changed on disk (an agent wrote to it), the server 409s and the UI offers Reload /
Overwrite instead of silently clobbering. This is what makes the agent+human loop safe.

### Architecture risk spike (M3) — outcome

Moveable driven **inside** the iframe works for drag + resize + rotate + snap at 0.5× and 2×
zoom. Hard-won specifics (all in `app/src/iframeRuntime.js`):

- Do **not** pass Moveable `bounds` or an explicit `rootContainer` — under the scaled iframe
  both corrupt its matrix math and fling drags to negative coordinates. Page edge/center
  snapping comes from `verticalGuidelines`/`horizontalGuidelines` instead.
- `dragArea: true` gives a reliable drag surface over the selection.
- Moveable renders its control box on the next animation frame — a human's click→drag has the
  needed gap; only back-to-back scripted input outruns it.
- **Zoom approach:** scale the iframe element from the parent while all tooling lives inside
  the iframe — nothing measures across the boundary, so Moveable's `getBoundingClientRect`
  stays in one untransformed space. Verified at 0.5×/1×/2×.
- **Multi-select** uses a hand-rolled rubber-band intersection test rather than Selecto — more
  robust than coordinating Selecto's events with Moveable inside an injected runtime.

### Edit model (command log)

`app/src/assetEdit.ts` + the runtime record **one command per gesture**:
`{ op, deltas: [{ eid, before, after }] }` where `before`/`after` are inline-style snapshots
(a `null` value means the property was absent, so undo can restore removals). Group gestures
produce one command with multiple deltas. Undo/redo applies `before`/`after` in place;
**Save** folds the log and replays it onto a pristine `DOMParser` copy of the *original raw
source* (which still has the asset's scripts), so editor artifacts (Moveable control box,
injected scripts, `data-eid`) never reach the file.

### Resource resolution & script policy

The iframe loads `GET /assets/<path>.html?edit=1` — the server's **edit view**: it parses the
source (DOMParser-first), tags `data-eid` on every `.hs-el` in document order, and **strips
the asset's `<script>` tags** (the editor injects its own scripts, so a no-scripts sandbox
can't be used; stripping gives the same "live DOM == parsed source" guarantee). It's served
at the asset's real path, so relative resources still resolve, and the raw file (no
processing) is what Playwright export and `POST /api/asset` use.

## Known limitations

- **Stale guard is mtime-only** (not a content hash); a same-mtime overwrite by another tool
  would slip past.
- **Orphaned-comment cleanup is a heuristic:** delete removes an immediately-preceding comment
  node (an element's label); a comment that legitimately sits between two layers would also go
  (and is restored on undo).
- **Class-based transforms read as 0° in the editor:** a frozen (or hand-authored) `.hs-el`
  whose rotation comes from a CSS class, not an inline `transform`, shows `rotation 0°` and
  rotating it would replace the class transform. Freeze export stays pixel-identical.
- **Script-built assets render empty in the editor** (fixture `assets/legacy/wide-dashboard.html`
  builds its DOM from a data array). The edit view strips scripts, so a fully script-generated
  asset has no content to lift/edit — the next freeze follow-up is a scripts-allowed initial
  render for free-form imports (then freeze bakes the result).
- **Freeze is in-place** in the demo (correct for throwaway imports); the local build's
  explicit Freeze button should write a `<name>.pre-freeze.html` backup first.
- **Demo assets must be self-contained:** the browser build renders via `srcdoc`, so an
  imported file's *relative* images/fonts won't resolve (AI-generated assets are usually
  inline / data-URI). The local build serves real URLs and has no such limit.
- **Export v2 not built:** ZIP bundling, per-slide PDF, and further brand-authoring tooling.
