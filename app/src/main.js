import './style.css';
import './styles/liquid-glass.css';
import { createLiquidGlass } from './liquid-glass.js';
import { createFullscreen } from './fullscreen.js';
import { createPanels } from './panels.js';
import { createTheme } from './theme.js';
import { createRig } from './arm/rig.js';
import { Movement } from './movement.js';
import { disposeObject, loadModels } from './arm/models.js';
import { createViewport } from './viewport.js';
import { MotionLibrary, PRESETS } from './motion.js';
import { SerialConnection } from './inputs/serial.js';
import { GamepadInput } from './inputs/gamepad.js';
import { HandTracking } from './inputs/hand-tracking.js';
import { createUI, element } from './ui.js';

export const rig = createRig();
const movement = new Movement(rig);
let selected = 3;
let ready = false;
let loading = false;
let disposed = false;
let source = 'manual';
let controlRevision = 0;
let aligning = true;
let alignmentBusy = false;
let viewport;
const events = new AbortController();
const ui = createUI({
  onSelect: selectJoint,
  onJoint: moveJoint,
  onAction: action,
  onSlot: index => { motion.select(index); movement.hold(); ui.motion(motion); },
  onView: name => viewport?.fit(name),
});
const reportError = message => ui.activity(message, true);
const glass = createLiquidGlass();
const fullscreen = createFullscreen({ target: element('viewport'), button: element('fullscreen'), onExpand: () => ui.activity('Viewer expanded. Press Esc to return.') });
const panels = createPanels({ onChange: () => viewport?.resize() });
const theme = createTheme({ onChange: () => viewport?.setTheme() });
let storage;
try { storage = window.localStorage; }
catch { reportError('Browser storage is unavailable. Recordings will last for this session.'); }
const motion = new MotionLibrary({ getAngles: rig.getAngles, applyAngles, storage, onError: reportError });
const serial = new SerialConnection({
  getAngles: rig.getAngles,
  onAngles: applyAngles,
  onOrbit: (dx, dy) => viewport?.orbit(dx, dy, 0, 1),
  onStatus: (connected, busy) => {
    if (aligning) serial.hold();
    ui.serial(connected, busy);
  },
  onError: reportError,
});
// Shoulder output needs a faster clock than display refresh. SerialConnection
// still paces the other axes and prevents overlapping or catch-up writes.
const serialTimer = setInterval(() => {
  if (ready && !aligning && !disposed && !document.hidden) serial.tick(performance.now());
}, 12);
const tracker = new HandTracking({
  video: element('camera-video'),
  canvas: element('camera-overlay'),
  getAngles: rig.getAngles,
  onAngles: applyAngles,
  onState: state => {
    ui.camera(state);
    if ((state === 'off' || state === 'detecting') && source === 'hand') movement.hold();
    if (state === 'off' && source === 'hand') setSource('manual');
  },
  onError: reportError,
});
const gamepad = new GamepadInput({
  onStatus: ui.gamepad,
  onSelect: selectJoint,
  onMove: applyAngles,
  onOrbit: (...args) => viewport?.orbit(...args),
  onAction: action,
});

function setSource(next) {
  if (next === source) return;
  source = next;
  ui.source(next);
}

function pauseHand() {
  tracker.setControl(false);
  element('hand-control').checked = false;
}

function applyAngles(angles, input = 'manual') {
  if (!ready || disposed) return;
  if (aligning) {
    if (alignmentBusy || serial.busy || !['manual', 'gamepad'].includes(input)) return;
    rig.setAngles(angles, 'alignment');
    movement.hold();
    return;
  }
  if (motion.mode === 'playing' && (input === 'hand' || input === 'serial')) return;
  if (input !== 'sequence' && motion.mode === 'playing') motion.stop();
  if (input === 'manual' || input === 'gamepad') controlRevision++;
  if (input !== 'hand') pauseHand();
  serial.resume();
  setSource(input);
  movement.setTarget(angles, input);
}

function moveJoint(index, value) {
  const angles = movement.getTarget();
  angles[index] = value;
  applyAngles(angles);
}

function selectJoint(index) {
  selected = index;
  ui.select(index);
  viewport?.select(index);
}

function stop() {
  controlRevision++;
  motion.stop();
  movement.hold();
  pauseHand();
  gamepad.hold();
  serial.hold();
  viewport?.cancelDrag();
  setSource(aligning ? 'alignment' : 'stopped');
  ui.motion(motion);
  ui.activity(aligning ? 'Align the model to the real arm, then start control.' : 'Motion stopped. The arm is holding its current pose.');
}

async function beginAlignment() {
  aligning = true;
  stop();
  alignmentBusy = true;
  ui.alignment(true, true);
  // A write already accepted by USB cannot be recalled. Let it finish before
  // the operator sets the new reference; discard all queued movement now.
  await serial.writing;
  if (disposed) return;
  alignmentBusy = false;
  ui.alignment(true);
  ui.activity('Match the model to the real arm. Only the model moves during alignment.');
}

function startControl() {
  if (!aligning || alignmentBusy || serial.busy || !serial.adoptPose(rig.getAngles())) return;
  movement.hold();
  gamepad.hold();
  aligning = false;
  ui.alignment(false);
  setSource('manual');
  ui.motion(motion);
  ui.activity('Control ready at the aligned pose. Move a joint to begin.');
}

async function action(name) {
  if (name === 'stop') { stop(); return; }
  if (name === 'retry') { await load(); return; }
  if (name === 'fullscreen') { await fullscreen.toggle(); return; }
  if (!ready) return;
  if (name === 'align') { await beginAlignment(); return; }
  if (name === 'start-control') { startControl(); return; }
  if (aligning && (name === 'record' || name === 'play' || PRESETS[name])) return;
  if (name === 'fit') viewport.fit();
  else if (name === 'record') {
    motion.record();
    if (source === 'sequence') setSource('manual');
    ui.activity(motion.mode === 'recording' ? 'Recording your movements. Press Save recording to keep them.' : 'Recording saved to this slot.');
  } else if (name === 'play' || PRESETS[name]) {
    controlRevision++;
    pauseHand();
    serial.resume();
    motion.play(PRESETS[name] ? name : undefined);
    if (motion.mode !== 'playing') movement.hold();
    setSource(motion.mode === 'playing' ? 'sequence' : 'manual');
    ui.activity(motion.mode === 'playing' ? `Playing ${PRESETS[name] ? name : `slot ${motion.activeSlot + 1}`}.` : 'Playback stopped.');
  } else if (name === 'serial') {
    if (serial.busy || alignmentBusy) return;
    await beginAlignment();
    await serial.toggle();
  }
  else if (name === 'camera') {
    const revision = controlRevision;
    await tracker.toggle();
    if (!aligning && tracker.enabled && revision === controlRevision) {
      motion.stop();
      tracker.setControl(true);
      element('hand-control').checked = true;
      setSource('hand');
      if (element('face-blur').checked) await tracker.setBlur(true);
    }
  }
  ui.motion(motion);
}

ui.listen('loop', 'change', event => { motion.loop = event.target.checked; });
ui.listen('speed', 'change', event => { motion.speed = Number(event.target.value); });
ui.listen('show-grid', 'change', event => viewport?.setGrid(event.target.checked));
ui.listen('smoothing', 'change', event => { tracker.smoothing = event.target.checked; });
ui.listen('face-blur', 'change', async event => { await tracker.setBlur(event.target.checked); event.target.checked = tracker.blur; });
ui.listen('hand-control', 'change', event => {
  if (aligning) { pauseHand(); return; }
  motion.stop();
  movement.hold();
  tracker.setControl(event.target.checked);
  serial.resume();
  setSource(tracker.control ? 'hand' : 'manual');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { stop(); return; }
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) || event.target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
  if (/^[1-4]$/.test(event.key)) selectJoint(Number(event.key) - 1);
  if (event.key.toLowerCase() === 'f') viewport?.fit();
  if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    moveJoint(selected, movement.getTarget()[selected] + (event.key === 'ArrowLeft' ? -1 : 1) * Math.PI / 180 * (event.shiftKey ? 5 : 1));
  }
}, { signal: events.signal });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stop();
    void tracker.stop();
  }
}, { signal: events.signal });

rig.subscribe((angles, input) => {
  ui.angles(angles, rig.toolPosition());
  if (!aligning && input !== 'serial') serial.queue(angles);
});

async function load() {
  if (loading || ready || !viewport) return;
  loading = true;
  ui.retry();
  try {
    await loadModels(rig, ui.loading);
    if (disposed) { disposeObject(rig.root); return; }
    ready = true;
    viewport.setReady();
    // Use upright bounds for a stable opening scale, then show the folded pose.
    rig.setAngles([-116.6, 60, 61.4, 0].map(value => value * Math.PI / 180));
    movement.hold();
    selectJoint(selected);
    ui.ready();
    ui.angles(rig.getAngles(), rig.toolPosition());
    await beginAlignment();
  } catch (error) { ui.loadError(error.message); reportError(error.message); }
  finally { loading = false; }
}

let frame = 0;
let previous = performance.now();
function tick(now) {
  if (disposed) return;
  const delta = Math.min((now - previous) / 1000, .1);
  previous = now;
  if (!document.hidden && ready) {
    gamepad.tick(delta, rig.getAngles(), selected);
    motion.tick(delta);
    movement.tick(delta);
    if (motion.mode === 'idle' && source === 'sequence') setSource('manual');
    ui.motion(motion);
  }
  viewport?.render(delta);
  frame = requestAnimationFrame(tick);
}

function dispose() {
  if (disposed) return;
  stop();
  disposed = true;
  cancelAnimationFrame(frame);
  clearInterval(serialTimer);
  events.abort();
  ui.dispose();
  glass.dispose();
  fullscreen.dispose();
  panels.dispose();
  theme.dispose();
  void tracker.stop();
  void serial.disconnect();
  viewport?.dispose();
}
window.addEventListener('pagehide', event => {
  if (!event.persisted) dispose();
  else { stop(); void tracker.stop(); void serial.disconnect(); }
}, { signal: events.signal });
import.meta.hot?.dispose(dispose);

selectJoint(selected);
ui.angles(rig.getAngles(), rig.toolPosition());
ui.motion(motion);
ui.alignment(true);
try {
  viewport = createViewport({
    canvas: element('arm-canvas'),
    rig,
    onSelect: selectJoint,
    onMove: applyAngles,
    onViewChange: ui.view,
    onError: message => { stop(); reportError(message); },
    onReach: error => ui.activity(error < .1 ? 'Tool moved to target.' : 'Closest reachable pose. This target is outside the joint limits.'),
  });
  frame = requestAnimationFrame(tick);
  void load();
} catch (error) {
  ui.loadError('The 3D view needs WebGL. Enable hardware acceleration in your browser, then reload.');
  reportError(error.message);
}
