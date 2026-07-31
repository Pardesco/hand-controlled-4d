# DESIGN.md — Hand-Controlled 4D

The design system for the frontend of this application. Written before the UI pass,
kept current with it. Everything below the line "Adapted direction" is binding on the
code; the sections above it record where the direction came from and why parts of the
generated recommendation were rejected.

Scope note: this document covers **the interface only**. Webcam capture, hand tracking,
landmark extraction, gesture recognition, the 4-polytope mathematics, projection,
WebGL rendering, rotation-plane behaviour and the acceleration / braking / inertia model
are load-bearing and were not modified.

---

## 1. What UI UX Pro Max returned

Skill installed at `.claude/skills/ui-ux-pro-max/` via `npx uipro-cli init --ai claude`.

`search.py "emerging tech spatial computing gesture-controlled scientific visualization
instrument" --design-system` returned:

| Field | Recommendation |
|---|---|
| Pattern | **Horizontal Scroll Journey** — "Intro (Vertical), The Journey (Horizontal Track), Detail Reveal, Vertical Footer" |
| CTA | "Floating Sticky CTA or End of Horizontal Track" |
| Style | **Spatial UI (VisionOS)** — glass, depth, translucency, `backdrop-filter: blur(40px) saturate(180%)`, `border-radius: 24px`, `--focus-scale: 1.02` |
| Colors | Primary `#00FFFF`, Secondary `#7B61FF`, CTA `#FF00FF`, Background `#050510`, Text `#E0E0FF` |
| Typography | **Inter / Inter**, "spatial, legible, glass, system, clean, neutral" |
| Effects | Parallax depth, dynamic lighting response, gaze-hover, smooth scale on focus |
| Anti-patterns | "2D design", "No spatial depth" |

Supplementary searches:

- `--domain style "scientific data terminal technical monospace instrument"` →
  **HUD / Sci-Fi FUI** (1px lines, neon cyan on black, monospace, decorative brackets;
  flagged *Accessibility: Poor (thin lines)*), **Cyberpunk UI** (scanlines, glitch),
  **Data-Dense Dashboard** (12-col grid, 8px gap, 12px type), **Real-Time Monitoring**
  (status dots, pulse for live, critical-alert prominence).
- `--domain style "realtime computer vision experimental creative tool"` →
  **Interactive Cursor Design**, Spatial UI again, **Anti-Polish / Raw Aesthetic**,
  Claymorphism.
- `--domain typography "technical monospace data engineering precise"` →
  **Dashboard Data** (Fira Code + Fira Sans), **Science/Tech** (Exo + Roboto Mono),
  **Brutalist Raw** (Space Mono), **Tech/HUD Mono** (Share Tech Mono + Fira Code).
- `--domain ux "reduced motion accessibility keyboard focus live region"` → reduced-motion
  (High), focus states (High), keyboard nav (High), excessive motion (High: "animate 1–2
  key elements per view maximum"), easing (ease-out entering / ease-in exiting).

## 2. What is relevant

- **Real-Time Monitoring**'s core claim — status must be *stateful and immediate*: live
  indicators, connection state, critical conditions prominent. This is the single most
  useful thing the skill returned for this product, and it drives §5's status lamps and
  the tracking-loss treatment.
- **Data-Dense Dashboard**'s *metrics*, not its layout: 8px gaps, 12px type, minimal
  padding. An instrument console needs that density; it is the correct antidote to the
  "repeated rounded cards" failure mode.
- **HUD / Sci-Fi FUI**'s structural vocabulary: 1px rules, monospace values, technical
  markers, transparent-over-black. Its own accessibility warning ("Poor — thin lines") is
  taken as a constraint: 1px hairlines are permitted for *structure* (grid, dividers,
  frames) and forbidden for anything that carries state.
- **Science/Tech** typography's mono-for-data / sans-for-labels split.
- The whole **ux** domain result set, adopted verbatim as §10.
- Spatial UI's one good idea: **elevation must be legible**. Adopted as an opacity/border
  ladder rather than as blur.

## 3. What is too generic, and rejected

- **Horizontal Scroll Journey / CTA placement / "Vertical Footer"** — the generator
  answered as if this were a marketing page. There is no scroll, no conversion event, and
  no page. Discarded entirely.
- **Spatial UI (VisionOS) as the style.** Rejected on three grounds:
  1. *Performance.* The skill itself flags "Moderate (blur cost)". This app runs a WebGL
     composite, a 2D overlay canvas and MediaPipe inference on one thread at 60 fps. A
     40px `backdrop-filter` over a continuously-repainting canvas is the most expensive
     thing we could put on screen, and it buys nothing.
  2. *Legibility.* Glass panels take their contrast from whatever is behind them — here, a
     moving webcam image. A tracking-loss warning that becomes unreadable when the user
     moves is a defect, not a style.
  3. *Meaning.* Translucency in visionOS encodes "this floats in your room". Here it would
     encode nothing.
- **`#00FFFF` / `#7B61FF` / `#FF00FF` on `#050510`.** This is the blue-purple AI-startup
  palette the brief names, and it collides head-on with an existing constraint: the app
  already renders **diegetic** colour into the recorded frame — fingertip dots and plane
  tags in `planeDrive.ts` `FINGER_MAP`, hand ring feedback in `app.ts` `HAND_COLORS`. A
  second, unrelated UI palette would mean the same concept ("ZW is selected") has two
  different colours depending on whether you look at the hand or the panel. Rejected in
  favour of §7, which promotes the existing render colours to be the design system.
- **Inter.** Recommended for "system, neutral". Neutral is precisely wrong: this is an
  instrument, and its numerals must be tabular and its labels must read as engineering
  notation. Also rejected because a Google Fonts CDN link would break the app's stated
  guarantee that nothing leaves the machine — fonts are self-hosted instead.
- **Cyberpunk UI** (scanlines, glitch) and **Tech/HUD Mono** (Share Tech Mono). Theatrical.
  Randall has a standing preference against default scanline treatments.
- **Interactive Cursor Design.** The pointer is not the input device here; hands are.
- **Anti-Polish / Raw**, **Claymorphism**, the bento grid. Wrong register.
- "Gaze-hover effects", `--focus-scale: 1.02`. Hover-scale on a dense console causes
  layout shift, which the skill's own checklist forbids two sections later.

---

## 4. Adapted direction — **Optical Bench**

> A precise, experimental, real-time instrument: a *specimen* held in an optical path,
> surrounded by the instrumentation that measures and drives it.

**Dominant influence: laboratory imaging / optical instrumentation.** The premise is taken
literally — the webcam is a sensor, the composited polytope is the specimen on the stage,
and the surrounding UI is the bench: rails of instrumentation flanking an optical axis.
This is why the interface is *bilateral* (left rail / stage / right rail) rather than
stacked, and why the stage is a framed, centred aperture with an inscribed corner frame
rather than a card.

**Supporting influence 1: aerospace telemetry** — for state legibility only. Status lamps
with discrete named states, a fixed-position readout block that never reflows, plain-language
condition words (`ACQUIRED`, `LOST`, `BRAKE`), and the rule that a value's *position* never
moves while its content changes.

**Supporting influence 2: technical drafting notation** — for the plane system. The six
rotation planes are drawn as small axis-pair glyphs, not as text labels or coloured pills;
letterspaced uppercase is reserved for structural section headings, mimicking a drawing's
title block.

Explicitly not used: retro-futurism, vector-display phosphor decay, analog-synth skeuomorph
panels. They were considered and dropped to keep one dominant voice.

### What this direction commits us to

1. **The aperture is the product.** The stage takes all space the layout can give it; the
   rails are sized to their content and collapse before the stage shrinks. No UI is
   permitted inside the stage except the diegetic fingertip markers already rendered by
   `sceneRenderer.ts` and a thin band of state at the top and bottom edges — never over
   the centre where the face and hands are.
2. **Nothing decorative animates.** Every transition encodes a state change (§9).
3. **Control form follows data type** (§8). Six named slider-shaped things in a column is
   the failure mode being corrected.
4. **Colour is the same language on screen and on camera** (§7).

---

## 5. Information hierarchy

Four systems, in descending priority:

**A. Dimensional viewport (centre).** Webcam composite + polytope + hand overlays. Owns the
optical axis. Carries only: a top edge-band with tracking lamp, hand-role lamps and the
active-plane chips; a bottom edge-band with polytope / projection / mode. Both bands are
outside the central 70% where hands and face live.

**B. Gesture instrumentation (left rail).** The two hand roles, as two stacked instruments:
`DRIVE` (pedal hand) and `SELECT` (selector hand). Each shows acquisition lamp, confidence,
contact state, and current gesture. Below them, the motion gauge: aggregate angular speed,
accelerating / coasting / braking condition, and per-plane velocity bars.

**C. Rotation-plane system (left rail, top).** The six-plane matrix — the one component
that had no representation at all before this pass. Every plane shows exactly which of five
states it is in (§8).

**D. Instrument console (right rail).** All settings, grouped by meaning into
GEOMETRY / GESTURE RESPONSE / MOTION / OPTICS / VIEW / SYSTEM / ADVANCED. Every setting that
existed in the lil-gui panel survives, none added silently.

Reading order under one second: *is it tracking* (lamp) → *which hand does what* (role
lamps, colour-matched to the rings on camera) → *which plane* (matrix + chips) → *is it
moving and why* (gauge condition word).

---

## 6. Modes

| Mode | Rails | Stage bands | Landmarks | Console |
|---|---|---|---|---|
| **NORMAL** | Left rail visible, console collapsed to a tab | Both | No | On demand |
| **PRESENTATION** | Hidden | Minimal: plane chips + motion condition, auto-dimming | No | Hidden |
| **DIAGNOSTIC** | Both, plus telemetry block | Both + raw values | Yes | Open, ADVANCED expanded |

Normal mode must not look like diagnostic mode: raw confidences, frame rates, thresholds,
resolutions and landmark clouds appear **only** in diagnostic. Presentation mode is the
artwork — chrome decays to nothing after a few seconds of stillness and returns on input.

---

## 7. Semantic colour system

The generated palette was replaced. These roles are the source of truth; the four plane
hues are *lifted from `planeDrive.ts` `FINGER_MAP`* so that the dot on the fingertip in the
recorded frame, the chip in the stage band, and the cell in the plane matrix are the same
colour by construction.

| Role | Token | Value | Use |
|---|---|---|---|
| Application background | `--bg` | `#05070a` | Outside the aperture |
| Primary surface | `--surface` | `#0a0e13` | Rails |
| Elevated surface | `--surface-raised` | `#111820` | Console sections, popovers |
| Structural grid | `--grid` | `rgba(127,151,163,.10)` | Rail hairlines, matrix rules |
| Border | `--border` | `rgba(127,151,163,.22)` | Control outlines |
| Phosphor (primary text) | `--fg` | `#dff6ff` | Values, headings |
| Neutral telemetry | `--fg-dim` | `#8fa3b0` | Labels, units, inactive |
| **Drive signal** (pedal hand) | `--drive` | `#3dd6ff` | Cyan — DRIVE role, pedal, acceleration |
| **Select signal** (selector hand) | `--select` | `#ffb14d` | Amber — SELECT role, contact |
| Dimensional / active state | `--dim-active` | `#ff4fa3` | Restrained magenta — "a plane is live" |
| Plane ZW | `--plane-zw` | `#ff4fa3` | index finger |
| Plane YW | `--plane-yw` | `#35e0d6` | middle finger |
| Plane XW | `--plane-xw` | `#ff8a3d` | ring finger |
| Plane XY | `--plane-xy` | `#ffd23d` | pinky |
| Plane XZ / YZ | `--plane-view` | `#8fa3b0` | View-orbit only — not tap-selectable |
| Success / healthy | `--ok` | `#4ade80` | System nominal only |
| Warning | `--warn` | `#ffb14d` | Degraded, one hand only |
| Critical / tracking loss | `--crit` | `#ff5c5c` | Errors, stream lost |
| Inactive | `--off` | `rgba(143,163,176,.35)` | Unavailable, disabled |

Rules:
- Green appears **only** when the system is healthy. Red appears **only** for error or
  tracking loss. Neither is ever decorative.
- `--drive` is not the default accent. Most of the console is neutral; cyan means *the
  drive hand is doing something*.
- XZ and YZ are deliberately colourless: they are reachable through view-orbit, never
  through a thumb tap, and the matrix must say so rather than imply a fifth and sixth
  finger exists.
- **No state is signalled by colour alone.** Every lamp carries a text condition, every
  plane cell carries a state glyph, every bar carries a numeral.

---

## 8. Typography

Two voices, self-hosted (no CDN — the app promises nothing leaves the machine).

| Role | Family | Use |
|---|---|---|
| Technical display | **Saira Semi Condensed** 600, uppercase, `letter-spacing: .14em` | Section headings, rail titles, condition words |
| UI / prose | **Saira** 400/500 | Control labels, onboarding text, errors |
| Live values | **Roboto Mono** 400/500, `font-variant-numeric: tabular-nums` | Every number that changes at frame rate |

Adapted from the skill's *Science/Tech* pairing (Exo + Roboto Mono): the mono half is kept
as recommended; Exo is replaced by the Saira superfamily, which gives a condensed engineering
face for the title-block headings **and** a normal-width companion for prose, so the whole
interface has one voice instead of two unrelated ones.

Scale: `10px` micro-labels (uppercase, tracked), `11px` control labels, `12px` values,
`13px` prose, `15px` rail titles, `20px` stage condition words. Uppercase is used only for
section headings, condition words and plane names — never for prose or control labels.

Every frame-rate value is monospace and tabular so digits do not jitter.

---

## 9. Component strategy

Bespoke, no component library. Vanilla TS modules under `src/ui/`, matching the codebase's
existing style (classes with an imperative `update(state)`, no framework, no JSX).

| Component | Responsibility | Form |
|---|---|---|
| `InstrumentShell` | Three-column grid, mode switching, rail collapse | CSS grid |
| `DimensionalViewport` | Owns the aperture; sizes the canvas to the *stage*, not the window | ResizeObserver |
| `StageBands` | Top/bottom edge state bands | Absolute, outside centre 70% |
| `RotationPlaneMatrix` | Six planes × five states | SVG axis-pair glyphs |
| `HandRoleIndicator` | One hand: role, lamp, confidence, contact, gesture | Compact hand schematic (SVG) |
| `GestureStatus` | Both roles + acquisition | — |
| `MotionGauge` | Aggregate speed arc, condition word, per-plane velocity bars | SVG arc + bars |
| `SystemTelemetry` | fps, hands, resolution, camera, thresholds | Diagnostic only |
| `InstrumentConsole` | Settings, seven meaning-grouped sections | Disclosure sections |
| `ConsoleSection` | Collapsible group with a title-block heading | `<details>`-like, ARIA |
| `SegmentedSelector` | Enumerations (projection, aspect, mode, polytope) | Radio group |
| `InstrumentSlider` | Bounded continuous values | Range + inline mono readout |
| `NumericControl` | Precision values (thresholds, gains) | Scrub + type-in |
| `ToggleControl` | Binary states | Switch with on/off word |
| `StatusIndicator` | Lamp + condition word | — |
| `CalibrationFlow` | First-run onboarding | Corner-docked step card |

**Control-form mapping** (the rule that replaces "everything is a slider"):

| Data | Control |
|---|---|
| Polytope, projection, output aspect, control mode, selector side, capture preset, camera | `SegmentedSelector` (device list → native `<select>` when >4 options) |
| Bounded continuous with a felt range (glow, scale, friction, gains) | `InstrumentSlider` |
| Precision thresholds where the exact number matters (pinch engage/release, confidences, reference span) | `NumericControl` |
| Binary (mirror, occlusion, inertia, orbit, debug) | `ToggleControl` |
| Rotation plane | `RotationPlaneMatrix` cell — never a dropdown |
| Live motion | `MotionGauge` — read-only |
| Tracking state | `StatusIndicator` |

Plane-cell states, all five distinguishable without colour:

| State | Glyph | Meaning |
|---|---|---|
| Available | outlined | Tap-selectable, idle |
| Targeted | dashed outline + label | Fingertip approaching contact |
| Active | filled + plane hue | Contact held, receiving drive |
| Spinning | filled outline + velocity bar | Coasting with residual velocity |
| Unavailable | hatched, `--off` | XZ/YZ, or grip mode where taps do not apply |

**High-frequency isolation.** The per-frame path (`app.ts` → `InstrumentHud.update()`) writes
only to pre-resolved element references and `style.setProperty` on a handful of CSS custom
properties, guarded by change detection: a value that has not changed does not touch the DOM.
No panel open/close, console interaction or mode switch reallocates, re-creates, or resizes
the WebGL canvas, the video element or the tracking pipeline. Opening a console section
toggles a class; the rAF loop is untouched.

---

## 10. Motion strategy

Motion is a state channel. Budget: at most two things move at once outside the stage.

| Motion | Encodes | Duration |
|---|---|---|
| Lamp fade to `--ok` | Hand acquired | 180ms ease-out |
| Lamp fade to `--crit` + 2-cycle pulse, then hold | Hand lost | 120ms, pulse 900ms ×2 |
| Plane cell fill sweep | Contact made | 140ms ease-out |
| Plane cell fill drain | Contact released | 220ms ease-in |
| Velocity bar length | Angular velocity | continuous, no easing (it *is* the value) |
| Gauge arc | Aggregate speed | continuous |
| Drive glow intensity on the DRIVE instrument | Pedal held / accelerating | 90ms — must feel immediate |
| Brake flash | Fist detected | 100ms in, 300ms out |
| Rail slide | Mode change | 240ms ease-out |
| Presentation chrome decay | 4s idle | 600ms ease-in |

Nothing loops idly. No scanlines, no glitch, no ambient shimmer. Entering uses ease-out,
exiting ease-in, per the skill's UX result.

`prefers-reduced-motion: reduce` → all transitions collapse to `1ms`, the tracking-loss pulse
becomes a static state, presentation decay becomes instant. Values still update; only
*transitions* are removed, because an instrument that stops reporting is broken, not accessible.

---

## 11. Accessibility strategy

Adopted from the skill's `ux` and `web` domains, plus what a camera instrument specifically needs.

- **Keyboard parity for every gesture-driven action.** The rotation-plane matrix is a
  keyboard-operable group: arrow keys walk the six cells, `Space` latches one. Holding `W`
  accelerates the latched planes and `S` brakes — the same three verbs the hands have,
  routed through a separate `KeyboardDrive` so the gesture pipeline is never asked to serve
  two masters. The instrument is fully operable with no hands in frame.
  `1`–`6`, `P`, `O`, `M`, `Space`, `F`, `V`, `R` and `G` keep their existing meanings.
  `D` and `X` now switch to diagnostic and presentation mode (`D` previously toggled the
  landmark overlay, which diagnostic mode subsumes); `Esc` returns to normal, `?` opens a
  shortcut sheet. `Tab` is deliberately left alone — it belongs to focus navigation.
- **Visible focus** on every control: 2px `--drive` ring with 2px offset, never removed.
- **Logical tab order**: stage → left rail → console sections in visual order. Rails that are
  collapsed are `inert`, not merely hidden, so tab order never enters an invisible panel.
- **Labels**: every control has a real `<label for>`; icon-only buttons carry `aria-label`;
  the plane matrix is a `radiogroup` with `aria-checked`; lamps are `role="status"` with
  `aria-live="polite"`; camera and tracking failures are `aria-live="assertive"`.
- **Contrast**: all text ≥ 4.5:1 against its own surface. Stage-band text sits on an opaque
  scrim, never directly on video, because video luminance is unknowable.
- **Never colour alone**: §7. Every lamp, cell and bar carries a word or numeral.
- **Pointer-precision independence**: sliders accept arrow keys and `Page` keys; numeric
  controls accept typed entry; no control requires a drag; hit targets ≥ 32px in the console
  and ≥ 44px for primary actions.
- **Recoverable failures**: camera denied, camera busy, device unplugged mid-session, model
  load failure and WebGL absence each produce a named condition with a retry affordance and
  a synthetic-mode fallback, rather than a dead screen.
- **Reduced motion**: §10.

---

## 12. Responsive behaviour

The aperture is dominant at every size; rails yield first, always.

| Width | Layout |
|---|---|
| ≥ 2200px (ultrawide) | Both rails expanded, console two columns of sections |
| 1920×1080 | Both rails expanded (`232px` / `300px`) |
| 1440×900 | Left rail expanded, console collapsed to a tab, opens as an overlay drawer |
| 1280×720 | Both rails collapse to icon tabs; stage takes the full width; rails open as drawers over the *gutter*, never over the aperture |
| < 1100px | Drawers only; stage full-bleed |

The canvas is sized from the **stage element**, not the window, so expanding a rail never
crops the composition and collapsing one never leaves dead space. Fixed output aspects
(9:16, 4:5, 1:1, 16:9) still produce an exact letterboxed box for `captureStream()` — that
contract is unchanged, it is just measured against the stage.

---

## 13. Onboarding

A corner-docked step card, not a modal. Five steps, each ≤ 12 words, each auto-advancing on
*detected success* rather than on a Next click:

1. **Grant camera** — explains local-only processing, one button.
2. **Both hands up** — advances when two hands are acquired.
3. **SELECT hand** — highlights the selector rail instrument; advances on first thumb-tap.
4. **DRIVE hand** — highlights the drive instrument; advances on first pedal pinch.
5. **Brake** — advances on first fist.

Skippable at every step; re-openable from the console's SYSTEM section and with `?`. Shown
once, then remembered in the existing settings store. It never covers the stage centre.
