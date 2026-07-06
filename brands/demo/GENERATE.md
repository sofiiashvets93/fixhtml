# Generate an on-brand, editable asset — demo

Fill in `{{ }}` and give this whole prompt to Claude. Output is a single standalone
HTML file that is **immediately editable in HTML Asset Studio and pixel-exact on export**.

## Task

Create `assets/{{project}}/{{name}}.html` — {{describe the asset, e.g. "a 3-slide
Instagram carousel announcing the launch"}}.

## Hard rules (non-negotiable)

1. **Link the brand tokens** in `<head>`, nothing else for colour/type:
   `<link rel="stylesheet" href="../../brands/demo/tokens.css">`
2. **Use ONLY `var(--brand-*)` tokens** for every colour, font, radius, and shadow.
   Never write a hex value, a font-family name, or a raw shadow. (Positions/sizes in
   `.hs-el` inline styles are layout, not brand — those are fine, but prefer
   `var(--brand-space-*)` for padding/gaps.)
3. **Follow the Asset Contract** so the file is editable:
   - One `<div class="hs-page" data-size="WxH">` per page/slide (e.g. `1080x1350`),
     with the base rule `.hs-page{position:relative;overflow:hidden} .hs-el{position:absolute}`.
   - Every directly-editable object is a direct child `<div class="hs-el" style="left:…;top:…;width:…">`.
     Inside an `.hs-el`, normal flow/flex is fine.
   - A carousel/deck is multiple `.hs-page` elements in one file.
4. **No network resources.** Fonts are self-hosted (see `brands/demo/fonts/`), images
   are local files or data URIs. Never hot-link Google Fonts — it breaks export fidelity.

## Brand contract

Paste the contents of `brands/demo/BRAND.md` here (mood, composition, voice, the full
token list, and the do/don't rules) so generation stays on-brand.

## Reference

See `brands/demo/components.html` for approved patterns (headline block, stat card,
number, CTA chip) — reuse their structure and token usage as few-shot examples.
