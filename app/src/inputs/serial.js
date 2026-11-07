import { JOINTS, clampAngle } from '../arm/rig.js';
import { JOINT_SPEEDS } from '../movement.js';

// Hardware calibration: the operator confirmed that commands 70–110 cover
// the shoulder's full physical travel, with its direction reversed.
const SHOULDER_MIN = 70;
const SHOULDER_MAX = 110;
const SHOULDER_SPAN = SHOULDER_MAX - SHOULDER_MIN;
const SHOULDER_STEP_INTERVAL = (JOINTS[1].max - JOINTS[1].min) / JOINT_SPEEDS[1] / SHOULDER_SPAN * 1000;
const shoulderValue = message => Number(/(?:^|,)S1:(\d+)/.exec(message)[1]);

export function parseSerialLine(line, angles) {
  if (typeof line !== 'string' || line.length > 256) return null;
  const next = [...angles];
  let changed = false;
  let dx = 0, dy = 0;
  for (const field of line.trim().split(',')) {
    const match = /^(P[0-3]|DX|DY):(-?\d+(?:\.\d+)?)$/.exec(field.trim());
    if (!match) continue;
    const [, key, raw] = match;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (key.startsWith('P')) {
      const index = Number(key[1]);
      const joint = JOINTS[index];
      const amount = index === 1 ? (SHOULDER_MAX - value) / SHOULDER_SPAN : value / 180;
      next[index] = clampAngle(joint.min + Math.min(1, Math.max(0, amount)) * (joint.max - joint.min), index);
      changed = true;
    } else if (key === 'DX') dx = Math.max(-1000, Math.min(1000, value)) * .001;
    else dy = Math.max(-1000, Math.min(1000, value)) * .001;
  }
  return changed || dx || dy ? { angles: changed ? next : null, dx, dy } : null;
}

export function encodeAngles(angles) {
  return JOINTS.map((joint, index) => {
    const angle = clampAngle(angles[index], index);
    if (angle === null) throw new TypeError('Serial angles must be finite.');
    const amount = (angle - joint.min) / (joint.max - joint.min);
    const position = index === 1 ? SHOULDER_MAX - amount * SHOULDER_SPAN : amount * 180;
    return `S${index}:${Math.round(position)}`;
  }).join(',') + '\n';
}

export class SerialConnection {
  constructor({ getAngles = () => [0, 0, 0, 0], onAngles, onOrbit, onStatus, onError, serial = navigator.serial, clock = () => performance.now() }) {
    Object.assign(this, { getAngles, onAngles, onOrbit, onStatus, onError, serial, clock });
    this.port = null;
    this.busy = false;
    this.pending = null;
    this.writing = null;
    this.lastWrite = -Infinity;
    this.lastOtherWrite = -Infinity;
    this.lastMessage = '';
    this.suspended = false;
    this.shoulderTarget = null;
    this.lastShoulderWrite = -Infinity;
  }

  async toggle() {
    if (this.busy) return;
    this.busy = true;
    this.onStatus(!!this.port, true);
    try {
      if (this.port) await this.disconnect();
      else {
        if (!this.serial) throw new Error('USB serial needs Chrome or Edge on localhost or HTTPS.');
        this.suspended = false;
        const port = await this.serial.requestPort();
        try { await port.open({ baudRate: 115200 }); }
        catch (error) { this.port = null; throw error; }
        this.port = port;
        this.lastMessage = '';
        this.lastOtherWrite = -Infinity;
        this.shoulderTarget = shoulderValue(encodeAngles(this.getAngles()));
        this.lastShoulderWrite = -Infinity;
        this.reading = this.read(port);
      }
    } catch (error) {
      if (error.name !== 'NotFoundError') this.onError(error.message || 'Could not connect to the serial port.');
    } finally {
      this.busy = false;
      this.onStatus(!!this.port, false);
    }
  }

  async read(port) {
    let reader;
    const decoder = new TextDecoder();
    let buffer = '';
    let failed = false;
    try {
      reader = port.readable.getReader();
      this.reader = reader;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        if (buffer.length > 1024) buffer = '';
        for (const line of lines) {
          if (this.suspended) continue;
          const message = parseSerialLine(line, this.getAngles());
          if (!message) continue;
          if (message.angles && !this.writing && !this.pending && this.clock() - this.lastWrite > 500) this.onAngles(message.angles, 'serial');
          if (message.dx || message.dy) this.onOrbit(message.dx, message.dy);
        }
      }
    } catch (error) {
      failed = true;
      this.onError(`Serial connection ended: ${error.message}`);
    } finally {
      reader?.releaseLock();
      this.reader = null;
      // Do not await disconnect here: it waits for this read task to finish.
      if ((failed || this.port === port) && !this.busy) void this.disconnect();
    }
  }

  queue(angles) {
    if (!this.port || this.suspended) return;
    const message = encodeAngles(angles);
    this.shoulderTarget ??= shoulderValue(encodeAngles(this.getAngles()));
    this.pending = message === this.lastMessage && !this.writing ? null : message;
  }

  tick(now) {
    if (!this.port?.writable || !this.pending || this.writing || this.suspended) return;
    const requested = this.pending;
    const desired = shoulderValue(requested);
    const previous = this.shoulderTarget ?? desired;
    // USB backpressure can skip many rendered poses. Bound the command that
    // actually goes to the shoulder, not just the on-screen animation.
    const shoulder = previous + (now - this.lastShoulderWrite >= SHOULDER_STEP_INTERVAL ? Math.max(-1, Math.min(1, desired - previous)) : 0);
    // Keep the other joints at 20 Hz while the shoulder takes faster, bounded
    // steps. Retain their last sent values between their regular updates.
    const otherDue = now - this.lastOtherWrite >= 50;
    if (!otherDue && shoulder === previous) return;
    const message = (otherDue ? requested : this.lastMessage).replace(/S1:\d+/, `S1:${shoulder}`);
    this.pending = message === requested ? null : requested;
    if (message === this.lastMessage) return;
    const writer = this.port.writable.getWriter();
    this.lastWrite = now;
    if (otherDue) this.lastOtherWrite = now;
    this.writing = writer.write(new TextEncoder().encode(message))
      .then(() => {
        this.lastMessage = message;
        this.shoulderTarget = shoulder;
        if (shoulder !== previous) this.lastShoulderWrite = Math.max(now, this.clock());
      })
      .catch(error => { this.onError(`Serial write failed: ${error.message}`); this.suspended = true; this.pending = null; })
      .finally(() => { writer.releaseLock(); this.writing = null; });
  }

  hold() { this.suspended = true; this.pending = null; }
  resume() { this.suspended = false; }

  // Adopt the operator's physical pose as our reference, without a USB write.
  adoptPose(angles) {
    if (this.writing || !Array.isArray(angles) || angles.length !== JOINTS.length || !angles.every(Number.isFinite)) return false;
    this.hold();
    this.lastMessage = encodeAngles(angles);
    this.lastOtherWrite = -Infinity;
    this.shoulderTarget = shoulderValue(this.lastMessage);
    this.lastShoulderWrite = -Infinity;
    return true;
  }

  async disconnect() {
    const port = this.port;
    this.port = null;
    this.pending = null;
    try {
      await this.reader?.cancel();
      await this.reading;
      await this.writing;
      await port?.close();
    } catch (error) { this.onError(`Could not close serial cleanly: ${error.message}`); }
    finally { this.shoulderTarget = null; this.lastShoulderWrite = -Infinity; this.onStatus(false, false); }
  }
}
