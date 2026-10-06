# Pitwall app: design direction

Built with the ui-ux-pro-max skill (design-system pass with variance 9, motion 9, density 5), the
frontend-design-direction checklist, and the operator's own taste on record: Three.js 3D, dark space with an
amber glow (portfolio "The Pilot"), Apple-grade polish with Futura-style type (MakerBhawan), F1 and aerospace.

## Direction
- **Purpose:** call "box or stay out?", then let people watch the model against every real 2025 race.
- **Tone:** cinematic and technical. It should feel like a broadcast graphics package, not a dashboard template.
- **Signature moments:**
  - A start-light intro tied to real load progress: an amber hologram scans into a solid car, then lights out and launch.
  - A garage car whose tyres swap compound when the call is BOX.
  - A 3D race theatre on real circuit geometry with true elevation.
- **F1 semantics:** purple means optimal (timing screens). Tyre rings carry S/M/H letters, so colour is never the only cue. Team colours are the 2025 liveries.

## Tokens (`src/styles.css`)
| Role | Value |
|---|---|
| Space / deck | #05060a / rgba(16,18,26,.72) glass with 20px blur |
| Text / secondary / tertiary | #eef0f4 / #aab1be / #848c9b (all at least 4.5:1 on the deck) |
| Signature glow | amber #ffb547 to #ff8a00 |
| The call (BOX) | F1 red #ff2a1f |
| Optimal / good / caution | #b98cff / #3ddc97 / #f5c518 |
| Type | Jost (Futura-like display), Inter (UI), JetBrains Mono (numbers) |
| Motion | GSAP: expo.out reveals, magnetic hover, typed radio, all disabled under prefers-reduced-motion |

## Rules applied
- Dark-only by intent (cinematic product). Contrast is checked against the real glass surfaces.
- One or two hero animations per view. Everything else is static or a short state transition.
- SVG icons from one family. Visible amber focus rings. Every control is at least 44 px on touch.
- 3D canvases pause when off screen. dpr is capped at 1.5-1.6. The 3.7 MB car loads once, behind the start lights.
- Mobile: bottom-docked nav pill, stacked layouts, no horizontal scroll.

## Assets and licences
- Car: "Ferrari F1-75" by Sketcher (Sketchfab), CC-BY-NC-4.0. Livery, sponsor decals, badges and tyre print are
  removed and the car is re-liveried at runtime. Non-commercial use only. See `public/models/CREDITS.txt`.
- HDRI: Studio Small 08, Poly Haven, CC0.
- Circuits: FastF1 position telemetry (fastest lap of each circuit's latest cached race), with real elevation.
