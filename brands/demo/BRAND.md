# demo — brand contract

Compiled from `brand.json`. Injected into every generation prompt. **Never hard-code
colours, fonts, radii, or shadows — reference the tokens below only.**

- **Mood:** confident, bold, high-contrast
- **Composition:** big type, one accent, generous negative space
- **Voice:** direct, plainspoken, no hype

## Tokens — use only these

Link `tokens.css` and reference every value as `var(--brand-*)`:

| Token | Value |
|---|---|
| `var(--brand-bg)` | `#1a1a1a` |
| `var(--brand-surface)` | `#2d2d2d` |
| `var(--brand-accent)` | `#ff5722` |
| `var(--brand-accent-text)` | `#1a1a1a` |
| `var(--brand-text)` | `#ffffff` |
| `var(--brand-text-muted)` | `#9ca3af` |
| `var(--brand-font-display)` | `"Archivo Black", system-ui, -apple-system, "Segoe UI", sans-serif` |
| `var(--brand-weight-display)` | `400` |
| `var(--brand-font-body)` | `"Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif` |
| `var(--brand-weight-body)` | `400` |
| `var(--brand-font-hand)` | `"Gloria Hallelujah", system-ui, -apple-system, "Segoe UI", sans-serif` |
| `var(--brand-weight-hand)` | `400` |
| `var(--brand-space-unit)` | `8px` |
| `var(--brand-space-1)` | `8px` |
| `var(--brand-space-2)` | `16px` |
| `var(--brand-space-3)` | `24px` |
| `var(--brand-space-4)` | `40px` |
| `var(--brand-space-5)` | `64px` |
| `var(--brand-space-6)` | `104px` |
| `var(--brand-radius-sm)` | `8px` |
| `var(--brand-radius-lg)` | `24px` |
| `var(--brand-elevation-card)` | `0 8px 32px rgba(0,0,0,.35)` |

## Do
- one accent colour per artboard, used deliberately
- oversized display type as the focal point
- large section numbers (01, 02) for wayfinding

## Don't
- hard-code hex or px values — reference tokens only
- hot-link Google Fonts (breaks export fidelity)
- more than one accent colour competing for attention
