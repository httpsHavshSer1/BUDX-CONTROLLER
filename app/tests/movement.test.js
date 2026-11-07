import test from 'node:test';
import assert from 'node:assert/strict';
import { createRig, JOINTS } from '../src/arm/rig.js';
import { Movement, JOINT_SPEEDS } from '../src/movement.js';

test('all inputs use the faster shoulder limit without changing the other joint speeds', () => {
  for (const source of ['manual', 'gamepad', 'hand', 'sequence']) {
    const rig = createRig(), movement = new Movement(rig);
    for (let frame = 0; frame < 60; frame++) {
      movement.setTarget(JOINTS.map(joint => joint.max), source);
      const before = rig.getAngles();
      movement.tick(1 / 60);
      rig.getAngles().forEach((angle, index) => assert.ok(angle - before[index] <= JOINT_SPEEDS[index] / 60 + 1e-9));
    }
    const degrees = rig.getAngles().map(angle => angle * 180 / Math.PI);
    const expected = [75, 90, 75, 60];
    degrees.forEach((angle, index) => assert.ok(Math.abs(angle - expected[index]) < 1e-8));
  }
});

test('claw crosses its full range in 0.8 seconds at ten times its former speed', () => {
  const rig = createRig();
  rig.setAngles([0, 0, 0, JOINTS[3].min]);
  const movement = new Movement(rig);
  movement.setTarget([0, 0, 0, JOINTS[3].max]);
  for (let frame = 0; frame < 24; frame++) movement.tick(1 / 60);
  assert.ok(Math.abs(rig.getAngles()[3]) < 1e-8, 'Half range after 0.4 seconds.');
  for (let frame = 0; frame < 24; frame++) movement.tick(1 / 60);
  assert.ok(Math.abs(rig.getAngles()[3] - JOINTS[3].max) < 1e-8);
  assert.deepEqual(rig.getAngles().slice(0, 3), [0, 0, 0]);
});

test('movement stays consistent across refresh rates and a delayed frame cannot jump to its target', () => {
  function simulate(fps) {
    const rig = createRig(), movement = new Movement(rig);
    movement.setTarget([1, 1, 1, 1]);
    for (let frame = 0; frame < fps; frame++) movement.tick(1 / fps);
    return rig.getAngles();
  }
  simulate(30).forEach((angle, index) => assert.ok(Math.abs(angle - simulate(144)[index]) < (index === 1 ? .0001 : 1e-9)));
  const rig = createRig(), movement = new Movement(rig);
  movement.setTarget([1, 1, 1, 1]);
  movement.tick(10);
  assert.ok(rig.getAngles().every((angle, index) => angle <= JOINT_SPEEDS[index] * .05));
});

test('Stop drops a pending destination, invalid targets are rejected, and small moves never overshoot', () => {
  const rig = createRig(), movement = new Movement(rig);
  movement.setTarget([1, 1, 1, 1]);
  movement.tick(.02);
  movement.hold();
  const held = rig.getAngles();
  for (let frame = 0; frame < 100; frame++) movement.tick(.02);
  assert.deepEqual(rig.getAngles(), held);
  for (const invalid of [[NaN, 0, 0, 0], [Infinity, 0, 0, 0], [], null]) assert.equal(movement.setTarget(invalid), false);
  assert.deepEqual(movement.getTarget(), held);
  const target = held.map(angle => angle + .001);
  movement.setTarget(target);
  for (let frame = 0; frame < 100; frame++) {
    movement.tick(.02);
    assert.ok(rig.getAngles().every((angle, index) => angle >= held[index] - 1e-9 && angle <= target[index] + 1e-9));
  }
  assert.deepEqual(rig.getAngles(), target);
});

test('shoulder responds at full speed and reverses immediately without an acceleration ramp', () => {
  const rig = createRig(), movement = new Movement(rig);
  movement.setTarget([0, Math.PI / 2, 0, 0]);
  movement.tick(.01);
  assert.ok(Math.abs(rig.getAngles()[1] - Math.PI / 180) < 1e-9);
  movement.setTarget([0, -Math.PI / 2, 0, 0]);
  movement.tick(.01);
  assert.ok(Math.abs(rig.getAngles()[1]) < 1e-9, 'Reversal has no acceleration delay.');
  movement.hold();
  movement.tick(.01);
  assert.ok(Math.abs(rig.getAngles()[1]) < 1e-9, 'There is no residual velocity after Stop.');
});

test('shoulder reversal stays within joint limits and Stop cancels its target immediately', () => {
  const rig = createRig(), movement = new Movement(rig);
  movement.setTarget([0, 1, 0, 0]);
  for (let frame = 0; frame < 60; frame++) movement.tick(1 / 60);
  movement.setTarget([0, -1, 0, 0]);
  for (let frame = 0; frame < 120; frame++) {
    const before = rig.getAngles()[1];
    movement.tick(1 / 60);
    const after = rig.getAngles()[1];
    assert.ok(Math.abs(after - before) <= JOINT_SPEEDS[1] / 60 + 1e-9);
    assert.ok(after >= JOINTS[1].min && after <= JOINTS[1].max);
  }
  assert.ok(rig.getAngles()[1] < 0);
  movement.hold();
  const held = rig.getAngles();
  for (let frame = 0; frame < 120; frame++) movement.tick(1 / 60);
  assert.deepEqual(rig.getAngles(), held);
});
