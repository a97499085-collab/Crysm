// CRYSM · math utilities (column-major, WebGPU clip space z in [0,1])

export const DEG = Math.PI / 180;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function vec3(x = 0, y = 0, z = 0) {
  return [x, y, z];
}
export function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
export function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function normalize3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function mat4Identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a * b (column-major, applies b first then a) */
export function mat4Multiply(out, a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  }
  out.set(r);
  return out;
}

/** WebGPU perspective, z in [0, 1] */
export function mat4Perspective(out, fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

export function mat4LookAt(out, eye, center, up) {
  const zAxis = normalize3(sub3(eye, center));
  let xAxis = cross3(up, zAxis);
  const xl = Math.hypot(xAxis[0], xAxis[1], xAxis[2]);
  if (xl < 1e-6) xAxis = [1, 0, 0];
  else xAxis = [xAxis[0] / xl, xAxis[1] / xl, xAxis[2] / xl];
  const yAxis = cross3(zAxis, xAxis);

  out[0] = xAxis[0]; out[1] = yAxis[0]; out[2] = zAxis[0]; out[3] = 0;
  out[4] = xAxis[1]; out[5] = yAxis[1]; out[6] = zAxis[1]; out[7] = 0;
  out[8] = xAxis[2]; out[9] = yAxis[2]; out[10] = zAxis[2]; out[11] = 0;
  out[12] = -dot3(xAxis, eye);
  out[13] = -dot3(yAxis, eye);
  out[14] = -dot3(zAxis, eye);
  out[15] = 1;
  return out;
}

/** Halton sequence, used for sub-pixel TAA jitter */
export function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}
