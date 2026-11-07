import test from 'node:test';
import assert from 'node:assert/strict';
import { GamepadInput } from '../src/inputs/gamepad.js';
import { createRig, JOINTS } from '../src/arm/rig.js';
import { Movement } from '../src/movement.js';

test('gamepad speed is independent of refresh rate and Stop requires neutral input', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const pad = { index: 0, id: 'Test pad', connected: true, axes: [0, 0, .8, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [pad] } });
  try {
    function simulate(fps) {
      let angles = [0, 0, 0, 0];
      const input = new GamepadInput({ onStatus: () => {}, onSelect: () => {}, onMove: next => { angles = next; }, onOrbit: () => {}, onAction: () => {} });
      for (let frame = 0; frame < fps; frame++) input.tick(1 / fps, angles, 0);
      return { input, angle: angles[0] };
    }
    assert.ok(Math.abs(simulate(30).angle - simulate(144).angle) < 1e-10);
    let moved = false;
    const input = new GamepadInput({ onStatus: () => {}, onSelect: () => {}, onMove: () => { moved = true; }, onOrbit: () => {}, onAction: () => {} });
    input.hold();
    input.tick(.016, [0, 0, 0, 0], 0);
    assert.equal(moved, false);
    pad.axes[2] = 0;
    input.tick(.016, [0, 0, 0, 0], 0);
    pad.axes[2] = .8;
    input.tick(.016, [0, 0, 0, 0], 0);
    assert.equal(moved, true);
  } finally { Object.defineProperty(globalThis, 'navigator', original); }
});

test('controller drives the claw at 150 degrees/sec and A aligns instead of homing', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const pad = { index: 0, id: 'Test pad', connected: true, axes: [0, 0, 1, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [pad] } });
  try {
    const rig = createRig();
    rig.setAngles([0, 0, 0, JOINTS[3].min]);
    const movement = new Movement(rig), actions = [];
    const input = new GamepadInput({ onStatus: () => {}, onSelect: () => {}, onMove: angles => movement.setTarget(angles), onOrbit: () => {}, onAction: action => actions.push(action) });
    for (let frame = 0; frame < 24; frame++) { input.tick(1 / 60, rig.getAngles(), 3); movement.tick(1 / 60); }
    assert.ok(Math.abs(rig.getAngles()[3]) < 1e-8);
    pad.buttons[0].pressed = true;
    input.tick(1 / 60, rig.getAngles(), 3);
    assert.deepEqual(actions, ['align']);
  } finally { Object.defineProperty(globalThis, 'navigator', original); }
});

test('shoulder controller input uses the faster rate instead of the old 1.4 rad/sec cap', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const pad = { index: 0, id: 'Shoulder test', connected: true, axes: [0, 0, 1, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads: () => [pad] } });
  try {
    const rig = createRig();
    rig.setAngles([0, JOINTS[1].min, 0, 0]);
    const movement = new Movement(rig);
    const input = new GamepadInput({ onStatus: () => {}, onSelect: () => {}, onMove: angles => movement.setTarget(angles, 'gamepad'), onOrbit: () => {}, onAction: () => {} });
    for (let frame = 0; frame < 30; frame++) { input.tick(1 / 60, rig.getAngles(), 1); movement.tick(1 / 60); }
    const travel = (rig.getAngles()[1] - JOINTS[1].min) * 180 / Math.PI;
    assert.ok(Math.abs(travel - 180) < 1e-8, `Shoulder traveled ${travel} degrees in half a second.`);
    assert.deepEqual(rig.getAngles().filter((_, index) => index !== 1), [0, 0, 0]);
  } finally { Object.defineProperty(globalThis, 'navigator', original); }
});
