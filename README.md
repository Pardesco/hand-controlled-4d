# Hand-Controlled 4D

Local, real-time webcam app: two tracked hands rotate a 4-dimensional polytope,
live and in-camera. The polytope is composited into the webcam image in one
pass at capture time and is occluded by your own hands. Built to
`../HAND-CONTROLLED-4D-BUILD-SPEC.md`.

**The thesis:** 4D rotation has no good interface. SO(4) has six independent
rotation planes and every existing tool exposes them as sliders. Two hands
supply roughly the right number of degrees of freedom, and the grip-and-pull
mapping is physical enough that a viewer with no mathematical background
understands what is happening from watching alone.

Everything runs locally in the browser. No frame ever leaves the machine.

## Run

```
npm install       # also fetches the MediaPipe model into public/ (one-time)
npm run dev       # http://127.0.0.1:5174
npm test          # 141 unit tests (4D maths, polychora, gesture, occlusion)
npm run build     # production build in dist/
```

`?synthetic=1` boots with a test pattern and scripted hands that pinch, pull
and release on a cycle -- the full pipeline (clutch, rotation, occlusion,
feedback) runs with no webcam.

## The interaction

**Pinch both hands** (thumb to index) to take hold. Rotation accumulates only
while both hands are pinched -- release, reposition, re-pinch to continue,
exactly like lifting a mouse.

| Gesture | Drives | Reads as |
| --- | --- | --- |
| Pull hands apart / together | ZW | turning it inside out (the money shot) |
| Turn the pair like a wheel | XY | turning it like a wheel |
| Raise one hand above the other | YW | tipping it through itself |
| Twist both wrists | XW | screwing it into another axis |
| Move both hands together | XZ / YZ | orbiting around it |

**Inertia (the throw):** release the pinch *mid-motion* and the object keeps
its rotation, decaying with `Motion > Spin friction` (0 = spins forever).
Pull apart, let go, and it keeps turning itself inside out -- like spinning a
globe. Re-gripping catches it and stops the spin. This is how you rotate
further than your arms reach: pull, release, re-grip, pull again, or just
throw it.

**The instrument (default mode): tap + pedal.** Asymmetric two-hand control
(spec §2.4). Roles are assigned by POSITION ON SCREEN -- never by MediaPipe
handedness labels, which are inverted on many webcams. The hand on the
**screen right** is the **selector** (`Gesture response > Selector side` to swap);
the other hand is the **pedal**.

- **Selector: tap a fingertip against your thumb** to pick a plane, hold the
  touch to keep it selected:

  | Thumb taps... | Plane | Fingertip dot |
  | --- | --- | --- |
  | Index | ZW (inside-out) | pink |
  | Middle | YW | teal |
  | Ring | XW | orange |
  | Pinky | XY | yellow |

- **Pedal: one speed control.** Pinch-and-hold to accelerate the selected
  plane (`Pedal accel`, capped at `Max spin rate`); release and it coasts
  down on `Drive friction` (0 = forever). **Fist = full halt** (a fist is
  recognised even though it geometrically contains a pinch).
- Release the tap and the plane keeps its energy; tap another plane and the
  first coasts while the new one drives.
- One hand only in frame: that hand is the selector, and a tap drives its
  plane directly at `One-hand rate`.

The selector's fingertips carry always-on colour-coded dots in the recorded
frame; while tapped, the **plane tag ("ZW", "YW", "XW", "XY") appears right
at the fingertip**, so which plane is live is legible at the hand itself,
to you and to the viewer.

**Grip-and-pull is a separate mode** (`M`, or `Gesture response > Control mode`):
a selector tap is geometrically a pinch, so the two schemes fight if run
together. Switch to grip mode for the two-handed pull with the inertia
throw; switch back for the instrument.

Keys: `1-6` polytope (5-cell, tesseract, 16-cell, 24-cell, 120-cell,
600-cell) · `P` projection · `O` reset orientation · `Space` freeze ·
`M` control mode · `D` diagnostic mode · `X` presentation mode · `Esc` back to
normal · `V` record · `F` fullscreen · `G` console · `R` reset settings ·
`?` shortcut sheet.

**Hands-free fallback:** latch a plane in the rotation-plane matrix (arrow keys,
then `Space`), then hold `W` to accelerate it and `S` to brake. The whole
instrument is operable with no hands in frame.

Dense shapes (120-cell, 600-cell) force stereographic projection -- under
perspective they are an unreadable ball.

## Phones and tablets

The instrument detects a touch-primary device with the
`(hover: none) and (pointer: coarse)` media features (`src/device.ts`), never
the user agent -- iPadOS asks for the desktop site by default, so its UA is a
Mac's. On a handheld:

- **The composition fills the stage.** The desktop factory setting is a 9:16
  box so a creator records a phone-shaped clip; on an actual phone or tablet
  that shrank the viewport to a letterboxed sliver. `Output frame` in the
  console still offers every aspect.
- **Rails that become drawers start closed.** Below 1180 px both rails overlay
  the stage; on a tablet the two open drawers together hid all but a sliver of
  the picture. The tabs on each edge open them.
- **Landscape is hinted, not forced.** The front camera's frame is wide, so a
  portrait viewport cover-crops the sides -- exactly where the hands are. A
  portrait handheld gets a note on the boot screen and a dismissable pill on
  the stage; both vanish when the device is turned. Going fullscreen from the
  console also asks for a landscape lock, which only Android honours.
- Pixel ratio caps at 1 (inference is the bottleneck, not fill rate), controls
  grow to finger size, hover styles are skipped, and the notch is kept off the
  rail tabs with `viewport-fit=cover` plus the safe-area insets.

`?touch=1` forces the handheld profile in a desktop browser so all of this can
be exercised without a device; `?touch=0` forces the desk profile.

Entries saved by builds before 1.2.0 carry the desktop factory values for the
device-dependent keys (finishing the guide persisted every key), so
`loadSettings` ignores those keys from an entry that lacks the profile stamp.
A choice made on this build is stamped and honoured.

## Edge shading

Edges are instanced tubes with a neon-tube shader injected into
`MeshBasicMaterial` (`neonShading` in `src/sceneRenderer.ts`). One term drives
it: how squarely the tube surface faces the camera. The core blends to white
along its centre line so it reads as a lit glass tube with a filament; the
additive halo's alpha falls off with the same term so the glow fades to
nothing instead of ending in a hard band; both dim with view depth so the back
of a 120-cell sits behind its front. The halo is also attenuated by edge count
(inverse square root above 96 edges), because hundreds of additive sleeves
otherwise sum to flat white in the dense polytopes. Per-frame CPU cost: none.

## Occlusion tuning (the feature that sells it)

The hand hulls are written depth-only using palm span as a depth proxy.
`Advanced > Reference span` is the palm span *at the polytope's distance*:

1. Stand where you will shoot, hold a hand at the depth where the object
   floats, press `D` for diagnostic mode.
2. If the polytope wrongly passes in front of that hand, raise the reference
   span; if your hand wrongly covers everything, lower it.
3. Reaching toward the lens should pull your hand in front of the geometry;
   pulling back should let edges pass in front of your hand.

Known limitation (accepted in the spec): the hull closes finger gaps, so edges
do not show through spread fingers.

## Shooting checklist (spec §9)

- Output frame **9:16**, object in the upper two-thirds (`Geometry > Object
  centre Y`), hands entering from the bottom.
- **First two seconds:** hands already in frame, already pinched, object
  already rotating. No title card, no build-up.
- **No cuts in the first three seconds** -- an early cut reads as a
  compositing seam and destroys the proof.
- The beat: settle -> grip -> pull apart -> inside-out reveal -> release.
  7-12 seconds. Last frame matches the first for a clean loop.
- Record with `V` (or OBS Window Capture for higher bitrate), shoot with
  sound.
- Post: ffmpeg for trim, loop point, colour, caption burn only. Never
  composite the subject.
- A Cycles beauty render may be intercut *after* the live take establishes
  causality. Never lead with it.

## Architecture

Shared modules lifted from `../hand-tracked-ascii-portal` (camera, coords,
hand tracking, slot assignment, smoothing, layout, recorder): see that
project's README. `src/coords.ts` is the single coordinate contract -- read it
before touching anything spatial.

New here:

- `polytope4d.ts` -- SO(4) orientation (Float64Array 4x4), six plane
  rotations, Gram-Schmidt renormalisation, 4D->3D projection (perspective +
  stereographic, pole-clamped).
- `polychora.ts` -- procedural generation of all six regular polychora,
  normalised to unit circumradius; edges derived as minimum-distance pairs and
  unit-tested against the known counts.
- `gestureMap.ts` -- grip-and-pull mapping, hysteresis pinch clutch,
  incremental control, rate smoothing (positions are smoothed first, rates
  derived, then rates damped again).
- `handMask.ts` -- convex hull + margin + depth-from-span.
- `sceneRenderer.ts` -- one-canvas composite: video quad, depth-only hand
  hulls, instanced tube edges coloured by pre-projection W, additive halo +
  chromatic split, fingertip rings and engage frame in an ortho overlay pass
  (part of the recording).
- `ui/` -- the instrument frontend. `tokens.css` is the only source of colour,
  type, space and motion; `hud.ts` owns the stage bands and the left rail and
  is handed one preallocated `InstrumentState` per frame (`ui/state.ts`), with
  every component change-detecting before it touches the DOM. `controls.ts`
  builds the console from the primitives in `ui/widgets.ts`. `ui/keyboardDrive.ts`
  is the hands-free fallback -- a separate control path, deliberately not routed
  through the gesture pipeline. See `DESIGN.md` for the design system and the
  reasoning behind it.

## Licence and third-party assets

This project is MIT licensed (see `LICENSE`).

Two things are deliberately *not* in the repository and are fetched or
installed separately:

- **MediaPipe hand-landmarker WASM runtime + `.task` model** (Google, Apache
  2.0) -- pulled into `public/` by `scripts/setup-assets.mjs` on `npm install`.
  Nothing is redistributed here and nothing is sent anywhere at runtime; the
  model runs locally in the browser.
- **The UI/UX Pro Max skill** used for the design pass lives in
  `.claude/skills/` and is gitignored. It is
  [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill),
  not ours to redistribute. Reinstall with `npx uipro-cli init --ai claude`.

`three` and `@mediapipe/tasks-vision` are ordinary npm dependencies.
