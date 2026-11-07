# BUDX controller

A browser workbench for the four-axis BUDX arm. Pose the model directly, record movements into three local slots, or connect a gamepad, Arduino, or camera.

The opening view shows the folded arm at −116.6° turntable, 60° shoulder, 61.4° elbow, and 0° claw, with the wider Perspective framing and wrist arrows hidden. Use Move arm handles to show the arrows. The app opens in **Align model** mode; Fit view frames the current pose. Saved theme and panel preferences remain in effect.

## Run it

Run these commands from this `app/` directory. For the Arduino sketch and its different serial protocol, see the [hardware guide](../hardware/README.md).

Use Node 20.19+ or 22.12+ (Node 22 LTS recommended).

```sh
npm ci
npm run dev
```

Open the localhost address printed by Vite. For a production build, run `npm run build`, then `npm run preview`. Serve `dist/` over HTTPS when deploying. For a subdirectory, build with `npm run build -- --base=/your-path/`.

## Align before controlling

1. Connect the Arduino, then match the model to the real arm using the four sliders or angle fields. Alignment changes only the model; no movement commands are sent.
2. Press **Start control**. This adopts the displayed pose without writing it to USB or moving toward zero.
3. Move a slider, controller, or other input to begin control. Return the gamepad to neutral first.

**Align model** (or gamepad A) stops app movement and lets you repeat setup at any time. Every reload and USB connection returns to alignment. Recording, presets, playback, and hand control stay paused until Start control; the camera can still preview. If a USB write is already in flight, alignment waits for it to finish before enabling adjustments. There is no Home action.

This is a manual position reference, not sensor calibration: match the physical pose accurately. Opening USB may reset the board, and firmware can move servos during its own startup. Web alignment cannot prevent firmware startup movement. The Arduino sketch is unchanged.

## Controls

Movement is limited to 75° per second for the turntable and elbow, 400° per second for the shoulder (10× the previous 40°/s limit), and 150° per second for the claw (10× the previous speed). The shoulder responds directly at the speed limit, without acceleration smoothing or braking ramps. These limits apply to sliders, keyboard, model dragging, controller, hand tracking, and playback; alignment adjustments move only the model. Stop cancels any remaining movement target immediately. The original USB connection and serial message format are unchanged.

The shoulder also has a limit at USB output: each `S1` target changes by at most one command unit, spaced at least 11.25 ms apart (4.5 model degrees per unit at the calibrated scale), using the last completed write. A stalled write cannot skip ahead to a distant on-screen pose or release a burst of shoulder commands. A 12 ms USB timer runs independently of display refresh; the other joints retain their 50 ms update pacing. Faster shoulder packets reuse their last completed values. Stop drops remaining shoulder steps; incoming position reports cannot replace an active or queued USB movement. The model remains a command preview and may run ahead while USB is delayed.

| Input | Action |
| --- | --- |
| Joint slider or angle field | Set a joint angle |
| Drag the wrist or its position arrows | Move the whole arm toward the tool position |
| Drag another model part | Move that joint |
| Move arm handles button | Show/hide wrist arrows; while focused, arrow keys move the tool and Page Up/Down adjusts depth |
| Drag the background | Orbit the camera |
| Scroll / pinch | Zoom |
| Shift + click the ground | Move toward a target, within joint limits |
| 1–4 | Select a joint |
| Left / right arrow | Move the selected joint by 1°; hold Shift for 5° |
| F | Fit the current pose in view |
| Escape / Stop motion | Stop playback and control input at the current pose |
| Fullscreen button | Expand the model viewer; Escape or the exit button returns to the workbench |
| Snow checkbox | Toggle the falling snow; the preference is saved locally |

Manual movement takes over from playback and unchecks **Move arm with hand**. Hand and serial input do not interrupt playback. To return to hand control, check that option again. Stop motion pauses serial input until a new manual movement or playback action. A gamepad must return to neutral before it can move the arm again.

Stop motion stops this app's commands; it does not send a hardware emergency-stop packet. The existing Arduino protocol only carries position targets. A controller that has already received a target may continue moving toward it.

Recordings last up to one minute. **Save recording**, changing slots, or stopping saves the current recording. Recordings stay in this browser's local storage under the existing `budx-anim-slots` key, and older valid recordings are supported. Storage failures leave the recording usable for the current session and show a status message.

## Devices

**Gamepad:** Connect a standard gamepad and press a button. Left stick orbits; right stick X moves the selected joint and Y zooms. LB/RB select joints, A enters model alignment, Y fits the camera, X plays/stops, Start records/saves, and D-pad up/down/left starts Wave/Sweep/Salute. Motion speed is independent of the display refresh rate.

**Arduino:** Chrome or Edge on localhost/HTTPS is required for Web Serial. The baud rate and line protocol are unchanged:

```text
Browser → Arduino: S0:90,S1:90,S2:90,S3:90\n
Arduino → browser: P0:90,P1:90,P2:90,P3:90\n
Camera orbit:      DX:20,DY:-10\n
```

The turntable, elbow, and claw map 0–180 to their allowed ranges. The shoulder uses the operator-confirmed usable command window of 70–110, which already covers its full physical 180° travel. It maps −90° / 0° / +90° in the model to 110 / 90 / 70 on USB, correcting both its scale and reversed direction. Incoming `P1` reports use the same calibration; its opening 60° pose is not a travel limit. Other-axis changes are coalesced to at most 20 updates per second; shoulder changes use the faster USB timer. Browser-originated writes suppress incoming position echoes for 500 ms. Invalid fields are ignored and values are clamped. Browser writes are awaited before the writer lock is released. Confirm physical joint calibration in your firmware before connecting the arm; the simulator does not model collisions or hardware feedback.

**Camera:** Enable the camera explicitly. Tracking assets are downloaded from pinned MediaPipe packages on jsDelivr only when needed; video processing runs locally. Smooth motion is enabled by default. Face blur affects the local preview only. Denied permissions, missing cameras, failed downloads, and tracking failures release the camera and show a useful error. Hiding the tab stops motion and releases the camera. Camera access and real Arduino/gamepad operation need verification on your hardware.

## Arm geometry

The four original glTF exports use a shared CAD origin, metres, and Z up. `src/arm/rig.js` converts that coordinate system once, defines the actual bearing heights, and offsets each mesh back around its own pivot. Shoulder and elbow rotations therefore keep their mating bearing centers coincident. The elbow socket export sits 2.032 mm above the upper arm's bearing center; the mount corrects that offset.

The original wrist pivot had no mesh. A small procedural tool flange now makes wrist roll visible and remains attached to the forearm. It represents a tool mount, not an additional supplied CAD part. Joint ranges remain turntable ±180°, shoulder ±90° (180° total), elbow ±90°, and the fourth control ±60°. The control is labeled Claw for the replacement hardware; the supplied CAD still displays the original tool mount.

`src/arm/kinematics.js` uses these same link dimensions and joint limits for inverse kinematics. Targets outside the workspace produce the nearest pose found by the limited solver, with a visible message.

The position arrows at the wrist move the tool along a world axis; the center handle and the wrist flange drag across the camera plane. The turntable, shoulder, and elbow follow automatically while wrist roll stays unchanged. The solver chooses a nearby joint solution on either side of the shoulder to avoid flips during small movements. Manual wrist movement takes over from playback and hand control. Stop or Escape ends the drag at the current pose. Use the Claw slider for the fourth hardware channel, and the Move arm handles button beside Fit view to hide or show the arrows. Keyboard movement from that button uses 3 mm steps, or 15 mm with Shift.

## Code and checks

The interface uses a web adaptation of the [Apple Liquid Glass skill](https://github.com/haider-nawaz/liquid-glass-skill). The reference targets native SwiftUI; this app keeps its JavaScript/Three.js stack. Clear control panels float above the continuous scene and snow, with shared backdrop sampling and locally generated edge refraction. Controls inside a panel use ordinary painted surfaces. The model's framing accounts for the sidebars so it remains centered in the usable space. There are no extra dependencies or downloaded visual assets.

The bottom-right transparency button switches to an opaque appearance and remembers the choice in this browser. System Reduce Transparency, increased contrast, and forced colors take priority. Reduce Motion disables refractive effects and transitions; small screens use blur without SVG refraction. `src/liquid-glass.js` generates edge maps on resize, updates the camera selector, and cleans up observers on disposal. `src/styles/liquid-glass.css` contains the appearance and fallback rules.

`src/fullscreen.js` expands the model viewer using native fullscreen, with an in-page fallback when embedded browsers reject or stall the native request. Both modes provide an exit button, Escape handling, focus containment, and restored joint controls on exit. `src/snow.js` simulates up to 5,200 world-space flakes (3,000 on initial mobile load) in the same WebGL scene as the arm. Flakes have perspective sizing, depth occlusion, tumble, and local pointer-driven gusts. Soft forces divert flakes around the moving arm links, and a feathered screen-space fade keeps the model readable from every camera angle. Move or click through the scene to stir them. Snow pauses when the tab is hidden or Reduce Motion is enabled.

There is no branded header. Controls and Devices toggle independent sidebars and remember desktop preferences; mobile opens with the scene and shows one panel at a time. Start control (or Align model) and Stop remain visible. Joint rows show a name, angle, and slider; recording slots and playback settings live under Recording options. The camera preview and hand controls appear only while tracking is active. Panel dimensions are unchanged. The model changes between graphite and brushed aluminum with neutral lighting, and the ground grid uses four-unit cells (80 mm at the existing display scale).

The sun/moon button at the bottom right switches between the original deep charcoal Dark mode and the brighter slate Light mode. The arm changes from graphite to muted brushed aluminum, and Light mode’s matte ground shares the arm’s base color with reduced glare and darker grid lines. The choice is saved locally and synchronized across open tabs. Palette tokens in `src/styles/liquid-glass.css` drive the controls, page, arm materials, WebGL floor, grid, fog, and snow; changing themes preserves the current pose. `src/theme.js` manages the toggle, storage fallback, and browser chrome color.

`PRODUCT.md` records the confirmed personal robot-controller context. Impeccable's project design detector is enabled in `.impeccable/config.json`; machine-local consent stays ignored.

- `src/arm/`: geometry calibration, model loading, and inverse kinematics.
- `src/viewport.js`: rendering, camera, picking, and pointer interaction.
- `src/motion.js`: recording, validation, persistence, and playback.
- `src/inputs/`: gamepad, serial, and camera lifecycles.
- `src/ui.js`: DOM bindings and display updates.
- `src/main.js`: input ownership and application lifecycle.

```sh
npm test
npm run build
```

Tests cover CAD bearing calibration, attachment through the joint ranges, wrist rotation, inverse kinematics, shared limits, recording persistence and malformed storage, serial parsing, and asynchronous write ordering. GitHub Actions runs tests and the build on pushes and pull requests.

For the browser smoke check, start the dev server and run these commands in another terminal. This uses Playwright CLI and synthetic video, without requesting a physical device. Screenshots are written to the ignored `output/playwright/` directory. Run it in a fresh browser profile: it writes a test recording to Slot 1.

```sh
npx --yes --package @playwright/cli playwright-cli open http://localhost:5173 --headed
npx --yes --package @playwright/cli playwright-cli run-code --filename=scripts/browser-check.js
npx --yes --package @playwright/cli playwright-cli run-code --filename=scripts/alignment-check.js
npx --yes --package @playwright/cli playwright-cli run-code --filename=scripts/glass-check.js
npx --yes --package @playwright/cli playwright-cli run-code --filename=scripts/viewer-check.js
npx --yes --package @playwright/cli playwright-cli run-code --filename=scripts/scene-check.js
npx --yes --package @playwright/cli playwright-cli run-code --filename=scripts/theme-check.js
npx --yes --package @playwright/cli playwright-cli run-code --filename=scripts/wrist-check.js
```

Draco decoding is served locally from `public/draco/`; it does not depend on a third-party CDN to display the arm. See `public/draco/LICENSE` for the decoder license.
