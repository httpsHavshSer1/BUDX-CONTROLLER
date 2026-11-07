import { JOINT_SPEEDS } from '../movement.js';

const deadzone = value => Math.abs(value ?? 0) < .14 ? 0 : (Math.abs(value) - .14) / .86 * Math.sign(value);

export class GamepadInput {
  constructor({ onStatus, onSelect, onMove, onOrbit, onAction }) {
    Object.assign(this, { onStatus, onSelect, onMove, onOrbit, onAction });
    this.previous = [];
    this.index = null;
    this.id = null;
    this.suspended = false;
  }

  hold() { this.suspended = true; }

  tick(delta, angles, selected) {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find(gamepad => gamepad?.connected);
    if (!pad) {
      if (this.index !== null) this.onStatus(null);
      this.index = this.id = null;
      this.previous = [];
      return;
    }
    if (this.index !== pad.index || this.id !== pad.id) {
      this.index = pad.index;
      this.id = pad.id;
      this.previous = pad.buttons.map(button => button.pressed);
      this.onStatus(pad.id);
    }
    const axes = [0, 1, 2, 3].map(index => deadzone(pad.axes[index]));
    const pressed = index => pad.buttons[index]?.pressed && !this.previous[index];
    // After Stop, return sticks and buttons to neutral before accepting input.
    if (this.suspended) {
      if (axes.every(value => value === 0) && pad.buttons.every(button => !button.pressed)) this.suspended = false;
    } else {
      if (pressed(5)) { selected = (selected + 1) % 4; this.onSelect(selected); }
      if (pressed(4)) { selected = (selected + 3) % 4; this.onSelect(selected); }
      if (axes[2]) { const next = [...angles]; next[selected] += axes[2] * delta * ([1, 3].includes(selected) ? JOINT_SPEEDS[selected] : 1.4); this.onMove(next, 'gamepad'); }
      this.onOrbit(axes[0], axes[1], axes[3], delta);
      const actions = { 0: 'align', 3: 'fit', 2: 'play', 9: 'record', 12: 'Wave', 13: 'Sweep', 14: 'Salute' };
      for (const [index, action] of Object.entries(actions)) if (pressed(Number(index))) this.onAction(action);
    }
    this.previous = pad.buttons.map(button => button.pressed);
  }
}
