# Pitwall app: design direction

The frontend in `web/` was built with [Claude Code](https://claude.com/claude-code).

Built with the ui-ux-pro-max skill, the agency-agents ui-designer brief, the frontend-design-direction and
make-interfaces-feel-better checklists and the dataviz skill. Redesigned 2026-10-06 from the amber v2.2 look
to the F1 broadcast-graphics language.

## Direction
- **Purpose:** call "box or stay out?", let people watch the model against every real 2025 race, and answer
  their own "what if" questions with a live rerun.
- **Tone:** F1 TV graphics package on a flat black, telemetry-tool base (the look of f1-race-replay, not its layout):
  pure black, outline track with green DRS zones, team-coloured text and dots, team-bordered driver cards, round
  transport buttons and a segmented lap bar with flag markers. Red accents and condensed headlines stay.
- **Signature moments:**
  - A start-light intro tied to real load progress: a hologram scans into a solid car, then lights out.
  - A garage car that swaps compound on BOX, with numbered spec hotspots cycling like a broadcast explainer.
  - A 3D race theatre and onboard on real circuit geometry with true elevation and a telemetry speed profile.
  - What If: the real car races its white "what if" twin, with a live gap tag.
  - Director camera: braking zones from the real speed trace become broadcast corners, each with a long-lens trackside
    camera and a caption; front wheels steer to the real curvature (Ackermann).
  - A race-engineer guide: profile-aware spotlight tour whose tasks complete only when done, plus Explain mode.
- **F1 semantics:** purple means best (timing screens). Tyre rings carry S/M/H letters, so colour is never the only
  cue. Team colours are the 2025 liveries.

## Tokens (`src/styles.css`)
| Role | Value |
|---|---|
| Background / panel | #000000 / #0c0c0d (flat, no glow or grid) |
| Signature | F1 red #e10600 |
| Real vs what-if, ahead / behind | blue #2a8bdb / red #ff4d45 |
| Best / good | purple #a855f7 / green #2ba84a |
| Type | Barlow Condensed (display), Barlow (UI), JetBrains Mono (numbers, tabular) |
| Motion | GSAP reveals and CSS transitions on named properties; all off under prefers-reduced-motion |

## Rules applied
- Dark-only by intent. Contrast checked against the carbon panels.
- Charts (one `LineChart` component): one y-axis, 2px lines, legend for 2+ series plus de-overlapped end labels,
  crosshair tooltip, progressive reveal synced to playback, viewBox tracks the rendered width so text stays true size.
- Motion stability: cars and cameras use roll-free yaw/pitch poses from a smoothed heading table, a damped shared
  heading and an arc-length-accurate centreline, so nothing flips or wobbles in corners.
- Resilience: every view sits in an error boundary, every 3D canvas in `Safe3D` (no-WebGL message, context-loss
  restore), and low-power devices get no post-processing and a lower pixel ratio (`ui/safety.tsx`).
- 3D canvases pause when off screen. The 3.7 MB car loads once, behind the start lights.
- Mobile: bottom nav with six equal icon tabs, stacked layouts, no horizontal scroll, 44 px touch targets.

## Assets and licences
- Car: "Ferrari F1-75" by Sketcher (Sketchfab), CC-BY-NC-4.0. Livery, sponsor decals, badges and tyre print are
  removed and the car is re-liveried at runtime. Non-commercial use only. See `public/models/CREDITS.txt`.
- HDRI: Studio Small 08, Poly Haven, CC0.
- Circuits and onboard telemetry: FastF1 (fastest lap of each circuit's latest cached race), with real elevation.
