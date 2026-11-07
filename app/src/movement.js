import { JOINTS, clampAngle } from './arm/rig.js';

// Turntable, shoulder, elbow, claw: degrees per second, including playback.
export const JOINT_SPEEDS = Object.freeze([75, 400, 75, 150].map(degrees => degrees * Math.PI / 180));
const SHOULDER_ACCELERATION = 3000 * Math.PI / 180;

export class Movement {
  constructor(rig) { this.rig = rig; this.hold(); }
  getTarget() { return [...this.target]; }
  setTarget(angles, source = 'manual') {
    if (!Array.isArray(angles) || angles.length !== JOINTS.length || !angles.every(Number.isFinite)) return false;
    this.target = angles.map(clampAngle);
    this.source = source;
    return true;
  }
  hold() { this.target = this.rig.getAngles(); this.shoulderVelocity = 0; }
  tick(delta) {
    if (!Number.isFinite(delta) || delta <= 0) return;
    // A delayed frame must never turn into a large catch-up movement.
    const elapsed = Math.min(delta, .05);
    const next = this.rig.getAngles().map((angle, index) => {
      const step = JOINT_SPEEDS[index] * elapsed;
      if (index === 1) {
        const distance = this.target[index] - angle;
        // Brake early, leaving enough margin to avoid a hard stop between frames.
        const desired = Math.sign(distance) * Math.min(JOINT_SPEEDS[index], Math.sqrt(SHOULDER_ACCELERATION * Math.abs(distance)));
        const previous = this.shoulderVelocity;
        const change = SHOULDER_ACCELERATION * elapsed;
        this.shoulderVelocity += Math.max(-change, Math.min(change, desired - previous));
        const travel = (previous + this.shoulderVelocity) / 2 * elapsed;
        if (travel * distance >= 0 && Math.abs(travel) >= Math.abs(distance)) {
          this.shoulderVelocity = 0;
          return this.target[index];
        }
        return clampAngle(angle + travel, index);
      }
      return angle + Math.max(-step, Math.min(step, this.target[index] - angle));
    });
    this.rig.setAngles(next, this.source);
  }
}
