# Pitwall dashboard: design system

Built with the ui-ux-pro-max skill (`--design-system`, product "motorsport race strategy analytics
dashboard", dials variance 6 / motion 4 / density 8) and the frontend-design-direction checklist.

## Direction
- **Purpose:** answer "box or stay out?" and show why, then let people audit the model on real 2025 races.
- **Audience:** F1 fans, engineers and reviewers who scan numbers first.
- **Tone:** data-dense, quiet, technical. The tool is the first screen; no marketing hero.
- **Memorable detail:** F1 timing-screen colour semantics. Purple = optimal, green = within 0.5 s,
  yellow = within 2 s. Tyres are rings with S/M/H letters and a TV-style strategy strip.

## Tokens (`docs/style.css`)
| Role | Dark | Light |
|---|---|---|
| Background / surface / raised | #0b0e13 / #11151c / #171c25 | #f4f5f7 / #ffffff / #f1f3f6 |
| Text / secondary / tertiary | #e6e9ee / #a3acb9 / #8a94a3 | #0f1419 / #4a5361 / #5d6674 |
| Action (BOX, active tab) | #e10600, text #ff5a52 | #e10600, text #c40500 |
| Optimal / good / caution | #b98cff / #3ddc97 / #f5c518 | #7c3aed / #047857 / #a16207 |
| Tyres S / M / H | #ff3b3b / #ffd12e / #f2f2f2 | #ff3b3b / #e0ad00 / #d9dde3 |

Type: Fira Sans for UI, Fira Code for every number (tabular). Spacing: 4/8/12/16/24/32. Radius 10/6.
Motion: 150 ms colour transitions, 220 ms view enter, disabled under `prefers-reduced-motion`.

## Rules applied (pre-delivery checklist)
- SVG icons from one family (Lucide paths), `aria-hidden` beside text; icon-only controls have labels.
- Visible focus ring on every control; tabs follow the WAI-ARIA pattern with arrow-key navigation.
- Touch targets at least 44 px on coarse pointers; 40 px minimum otherwise.
- Normal text at least 4.5:1 in both themes; both themes were checked in a browser.
- Colour is never the only cue: tyre letters, lap labels, legends and text summaries back every colour.
- No cards inside cards: facts are dividers inside a panel, not nested boxes.
- Responsive at 375, 768, 1024 and 1440 px with no horizontal scroll; strips are drawn in real pixels on resize.
