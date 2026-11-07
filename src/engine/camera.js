// CRYSM · damped orbit camera

import { clamp, mat4LookAt, mat4Multiply, mat4Perspective, DEG } from './math.js';

export class OrbitCamera {
  constructor(opts = {}) {
    this.target = opts.target ? [...opts.target] : [0, 1.6, -2];
    this.tTarget = [...this.target];
    this.distance = opts.distance ?? 13.5;
    this.tDistance = this.distance;
    this.yaw = opts.yaw ?? 0.0;
    this.tYaw = this.yaw;
    this.pitch = opts.pitch ?? 0.16;
    this.tPitch = this.pitch;
    this.fov = (opts.fov ?? 38) * DEG;
    this.autoOrbit = false;
    this.autoSpeed = 0.055;

    this.position = [0, 0, 0];
    this.forward = [0, 0, -1];
    this.right = [1, 0, 0];
    this.up = [0, 1, 0];
    this.viewProj = new Float32Array(16);
    this._moving = false;
    this._tmp = new Float32Array(16);
    this._proj = new Float32Array(16);
    this._view = new Float32Array(16);
    this._update();
  }

  orbit(dx, dy) {
    this.tYaw -= dx * 0.0055;
    this.tPitch = clamp(this.tPitch + dy * 0.0045, -0.06, 1.32);
  }

  zoom(delta) {
    this.tDistance = clamp(this.tDistance * Math.exp(delta * 0.0012), 3.2, 42);
  }

  pan(dx, dy) {
    const s = this.tDistance * 0.0016;
    // pan in camera space
    for (let i = 0; i < 3; i++) {
      this.tTarget[i] += (-this.right[i] * dx + this.up[i] * dy) * s;
    }
    this.tTarget[1] = clamp(this.tTarget[1], 0.2, 8);
  }

  reset() {
    this.tTarget = [0.15, 1.58, -1.9];
    this.tDistance = 14.4;
    this.tYaw = 0.03;
    this.tPitch = 0.12;
  }

  update(dt) {
    if (this.autoOrbit) this.tYaw += dt * this.autoSpeed;
    const k = 1 - Math.exp(-dt * 16);
    const before = [this.yaw, this.pitch, this.distance, ...this.target];

    this.yaw += (this.tYaw - this.yaw) * k;
    this.pitch += (this.tPitch - this.pitch) * k;
    this.distance += (this.tDistance - this.distance) * k;
    for (let i = 0; i < 3; i++) this.target[i] += (this.tTarget[i] - this.target[i]) * k;

    this._moving =
      Math.abs(before[0] - this.yaw) > 2e-5 ||
      Math.abs(before[1] - this.pitch) > 2e-5 ||
      Math.abs(before[2] - this.distance) > 2e-4 ||
      Math.abs(before[3] - this.target[0]) > 2e-4 ||
      Math.abs(before[4] - this.target[1]) > 2e-4 ||
      Math.abs(before[5] - this.target[2]) > 2e-4;

    this._update();
    return this._moving;
  }

  _update() {
    const cp = Math.cos(this.pitch);
    this.position = [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
    const f = [
      this.target[0] - this.position[0],
      this.target[1] - this.position[1],
      this.target[2] - this.position[2],
    ];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    this.forward = [f[0] / fl, f[1] / fl, f[2] / fl];
    const r = [-this.forward[2], 0, this.forward[0]];
    const rl = Math.hypot(r[0], r[2]) || 1;
    this.right = [r[0] / rl, 0, r[2] / rl];
    this.up = [
      this.right[1] * this.forward[2] - this.right[2] * this.forward[1],
      this.right[2] * this.forward[0] - this.right[0] * this.forward[2],
      this.right[0] * this.forward[1] - this.right[1] * this.forward[0],
    ];
  }

  viewProjection(aspect) {
    mat4Perspective(this._proj, this.fov, aspect, 0.08, 300);
    mat4LookAt(this._view, this.position, this.target, [0, 1, 0]);
    mat4Multiply(this.viewProj, this._proj, this._view);
    return this.viewProj;
  }

  get tanHalfFov() {
    return Math.tan(this.fov / 2);
  }
}
