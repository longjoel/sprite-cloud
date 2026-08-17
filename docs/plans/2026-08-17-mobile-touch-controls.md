## Problem

On iPhone-sized viewports, the player’s visual layout and touch hit-test layout can diverge. The gamepad canvas/hit islands may be positioned against the full viewport while the video is inside a bounded Room/GameStage, and overlays or clipping ancestors can prevent pointer events from reaching the intended controls. Users report that the D-pad is difficult to use and face buttons often do not register.

## Goal

Make mobile touch input reliable before adding visual polish or haptics.

## Scope

- Establish one authoritative mobile player coordinate root for video, touch canvas, hit islands, and immersive chrome.
- Ensure the hit-test layer is not clipped or occluded by the bounded stage, Room workspace, options overlay, or top chrome.
- Add observable/debuggable production input plumbing sufficient to distinguish pointer delivery, zone resolution, state emission, and browser-player mapping.
- Make D-pad direction hit regions explicit and finger-friendly rather than relying on one rectangular zone with narrow internal thresholds.
- Make face/system hit targets at least 56 CSS px and keep visual controls separate from their touch hit regions.
- Track active pointer ownership so simultaneous D-pad + face-button input is preserved correctly.
- Release all active input on pointer cancellation, lost pointer capture, orientation/viewport changes, page visibility changes, and teardown.
- Add best-effort haptics only after a successful press transition; haptics must be optional and unavailable APIs must not affect gameplay.
- Keep the generated browser runtime bundle synchronized with source.

## Non-goals

- Redesigning the entire player visual theme.
- Adding native iOS/Android applications.
- Requiring haptic support for correctness.
- Changing emulator protocol bit assignments without regression evidence.

## Acceptance criteria

- On narrow portrait and landscape viewports, tapping each visible face button produces a visible pressed state and the expected canonical input state.
- D-pad UP/DOWN/LEFT/RIGHT each register reliably; the hit regions are larger than the visible artwork and do not require pixel-perfect taps.
- Holding one D-pad direction while pressing a face button preserves both inputs until their respective pointers end.
- Pointer cancellation, lost capture, orientation change, visual viewport resize, page hide, and teardown release every active input.
- Player chrome and overlays cannot intercept gameplay touches when hidden, and gameplay hit islands cannot intercept chrome actions when chrome is visible.
- Safe-area insets are honored on all four edges without moving hit targets away from their visual controls.
- Haptic feedback fires at most once per press transition when `navigator.vibrate` is available, and gameplay remains correct when it is absent.
- Focused touch-gamepad tests, TypeScript, production build, generated-bundle parity, and the relevant full web suite pass.

## Likely files

- `sc-web/public/player/touch-gamepad-v2.js`
- `sc-web/public/player/input-mapping.js`
- `sc-web/public/player/play-v2.js`
- `sc-web/components/GamePlayer.tsx`
- `sc-web/components/player/GameStage.tsx`
- `sc-web/components/player/PlayerWorkspace.tsx`
- `sc-web/tests/ui/touch-gamepad-islands.test.ts`
- `sc-web/tests/ui/touch-gamepad-runtime-bundle.test.ts`
- `sc-web/tests/ui/touch-gamepad-release.test.ts`
- `sc-web/tests/ui/player-workspace.test.tsx`
- `sc-web/tests/ui/player-chrome-options.test.tsx`

## Verification journey

1. Launch a game at iPhone portrait dimensions.
2. Enter immersive mode through the approved player gesture.
3. Press each D-pad direction and face/system control.
4. Hold D-pad and face input simultaneously.
5. Rotate to landscape and repeat.
6. Open/close player chrome and an overlay between presses.
7. Confirm cancellation/exit clears input.
8. Confirm audio/haptic enhancement failure does not block gameplay.

Refs #668
