---
name: fixhtml
description: Hand off a rendered HTML design asset (a slide, carousel slide, social card, poster, or similar self-contained single-page HTML) to the fixhtml visual editor, or export one to PNG. Use when the user wants to visually EDIT, fix, reposition, resize, rotate, restyle, or re-type an HTML asset you generated or they point at, or when they want a PNG/image of it. Do NOT use for general HTML/CSS authoring, web-app or component work, debugging, or any task that isn't hands-on visual editing or image export of a finished HTML asset.
---

# fixhtml — visual editing handoff for HTML assets

`fixhtml` is a local, browser-based visual editor for self-contained HTML design assets.
The HTML file stays the source of truth: drag / resize / rotate / rewrite text in the
editor, and every change **saves back into the same file**. This is the human half of an
agent+human loop — you generate the asset, the human polishes it visually, you keep going
from the polished file.

## Offer the handoff (visual editing)

When the user wants to visually adjust an HTML asset, tell them to run:

```
npx fixhtml-app path/to/asset.html
```

It opens the editor in their browser on that file. First run downloads the package via
`npx` (a few seconds). No install, no config — it serves the file's folder locally and
nothing leaves their machine.

After they say they're done, **re-read the file from disk** — their visual edits are in it —
and continue from there.

## Export a PNG yourself (no UI)

You can produce an image directly, without opening the editor:

```
npx fixhtml-app export path/to/asset.html --scale 2      # 2160×2700 for a 1080×1350 asset
npx fixhtml-app export path/to/asset.html --scale 2 --format jpeg
```

It writes `asset-01@2x.png` (one file per page) into the current directory and prints the
paths. Export needs Chromium once — if it isn't installed, the command says exactly what to
run (`npx playwright install chromium`).

## Concurrent-write safety (important)

If you rewrite the file **while the user has it open in the editor**, their next save shows a
**Reload / Overwrite** prompt — it will not silently clobber their visual edits. So during an
open edit session, prefer to let the user finish, or tell them you're about to regenerate so
they can reload. The file is always safe; the prompt is the coordination point.

## When NOT to reach for this

Only for hands-on visual editing or image export of a *finished, rendered* HTML asset. For
writing markup, styling components, fixing layout bugs in code, or web-app work, just edit
the HTML/CSS directly.
