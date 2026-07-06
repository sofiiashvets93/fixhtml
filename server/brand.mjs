// Brand compiler (brand stage 1). brand.json is the single source; this emits
// tokens.css + BRAND.md. Compile rule: each token leaf becomes --brand-<kebab-path>
// (color.textMuted -> --brand-text-muted; typography.display.family ->
// --brand-font-display). components.html + fonts/ stay hand-authored in v1.

function kebab(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

// Self-hosted-first font stack: the family name (self-hosted via the @font-face
// blocks below) followed by robust system fallbacks so export never hot-links.
function fontStack(family) {
  return `"${family}", system-ui, -apple-system, "Segoe UI", sans-serif`;
}

// Families the brand actually references (so we emit @font-face for those only).
function usedFamilies(brand) {
  const set = new Set();
  for (const spec of Object.values(brand.typography ?? {})) if (spec.family) set.add(spec.family);
  return set;
}

// @font-face blocks for the brand's fonts, self-hosted from fonts/registry.json
// (M12). src is an ABSOLUTE /fonts/... URL so it resolves the same in the editor
// iframe and in Playwright export, regardless of where tokens.css is linked from.
function fontFaceCss(brand, registry) {
  if (!registry) return '';
  const used = usedFamilies(brand);
  const blocks = [];
  for (const fam of registry.families ?? []) {
    if (!used.has(fam.family)) continue;
    for (const face of fam.faces ?? []) {
      blocks.push(
        `@font-face {\n` +
          `  font-family: "${fam.family}";\n` +
          `  font-style: ${face.style};\n` +
          `  font-weight: ${face.weight};\n` +
          `  font-display: swap;\n` +
          `  src: url("/fonts/${fam.source}/${fam.slug}/${face.file}") format("woff2");\n` +
          `}`
      );
    }
  }
  return blocks.join('\n');
}

/** brand.json -> array of [cssVar, value] token pairs. */
export function brandTokens(brand) {
  const t = [];
  for (const [k, v] of Object.entries(brand.color ?? {})) t.push([`--brand-${kebab(k)}`, v]);
  for (const [role, spec] of Object.entries(brand.typography ?? {})) {
    if (spec.family) t.push([`--brand-font-${kebab(role)}`, fontStack(spec.family)]);
    const w = spec.weight ?? (Array.isArray(spec.weights) ? spec.weights[0] : undefined);
    if (w != null) t.push([`--brand-weight-${kebab(role)}`, String(w)]);
  }
  if (brand.spacing) {
    const unit = brand.spacing.unit;
    if (unit != null) t.push([`--brand-space-unit`, `${unit}px`]);
    (brand.spacing.scale ?? []).forEach((m, i) => t.push([`--brand-space-${i + 1}`, `${unit * m}px`]));
  }
  for (const [k, v] of Object.entries(brand.shape?.radius ?? {}))
    t.push([`--brand-radius-${kebab(k)}`, typeof v === 'number' ? `${v}px` : v]);
  for (const [k, v] of Object.entries(brand.elevation ?? {}))
    t.push([`--brand-elevation-${kebab(k)}`, v]);
  return t;
}

function compileTokensCss(brand, registry) {
  const body = brandTokens(brand)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  const faces = fontFaceCss(brand, registry);
  const header = `/* Generated from brand.json by scripts/build-brand.mjs — do not edit by hand. */\n`;
  return header + (faces ? faces + '\n\n' : '') + `:root {\n${body}\n}\n`;
}

function compileBrandMd(brand) {
  const s = brand.style ?? {};
  const tokens = brandTokens(brand);
  const rows = tokens.map(([k, v]) => `| \`var(${k})\` | \`${v}\` |`).join('\n');
  const list = (arr) => (arr ?? []).map((x) => `- ${x}`).join('\n');
  return `# ${brand.name} — brand contract

Compiled from \`brand.json\`. Injected into every generation prompt. **Never hard-code
colours, fonts, radii, or shadows — reference the tokens below only.**

- **Mood:** ${s.mood ?? ''}
- **Composition:** ${s.composition ?? ''}
- **Voice:** ${s.voice ?? ''}

## Tokens — use only these

Link \`tokens.css\` and reference every value as \`var(--brand-*)\`:

| Token | Value |
|---|---|
${rows}

## Do
${list(s.do)}

## Don't
${list(s.dont)}
`;
}

/** Compile a brand.json object into its artifacts. `registry` (fonts/registry.json)
 *  supplies self-hosted @font-face for the families the brand uses. */
export function compileBrand(brand, registry) {
  return { tokensCss: compileTokensCss(brand, registry), brandMd: compileBrandMd(brand) };
}
