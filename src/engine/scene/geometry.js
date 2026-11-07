// CRYSM · procedural geometry -> triangle soup (3 vertices per triangle,
// smooth normals baked per vertex, material index per triangle)

const PI = Math.PI;
const TAU = Math.PI * 2;

function rotY(p, c, ang) {
  const s = Math.sin(ang), co = Math.cos(ang);
  const x = p[0] - c[0], z = p[2] - c[2];
  return [c[0] + x * co - z * s, p[1], c[2] + x * s + z * co];
}

export class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.mats = [];
  }

  get triangleCount() {
    return this.mats.length;
  }

  tri(p0, p1, p2, n0, n1, n2, mat) {
    this.positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    this.normals.push(n0[0], n0[1], n0[2], n1[0], n1[1], n1[2], n2[0], n2[1], n2[2]);
    this.mats.push(mat);
  }

  quad(p0, p1, p2, p3, n0, n1, n2, n3, mat) {
    this.tri(p0, p1, p2, n0, n1, n2, mat);
    this.tri(p0, p2, p3, n0, n2, n3, mat);
  }

  /** UV sphere with analytic normals */
  sphere(center, radius, mat, segU = 48, segV = 24) {
    const at = (i, j) => {
      const v = (i / segV) * PI;
      const u = (j / segU) * TAU;
      const n = [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)];
      return {
        p: [center[0] + n[0] * radius, center[1] + n[1] * radius, center[2] + n[2] * radius],
        n,
      };
    };
    for (let i = 0; i < segV; i++) {
      for (let j = 0; j < segU; j++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        if (i === 0) this.tri(a.p, c.p, d.p, a.n, c.n, d.n, mat);
        else if (i === segV - 1) this.tri(a.p, b.p, c.p, a.n, b.n, c.n, mat);
        else this.quad(a.p, b.p, c.p, d.p, a.n, b.n, c.n, d.n, mat);
      }
    }
  }

  /** axis aligned (optionally Y-rotated) box with flat face normals */
  box(center, size, mat, yaw = 0) {
    const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
    const raw = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const p = raw.map((v) => rotY([center[0] + v[0], center[1] + v[1], center[2] + v[2]], center, yaw));
    const rotN = (n) => rotY([n[0], n[1], n[2]], [0, 0, 0], yaw);

    const faces = [
      { idx: [4, 5, 6, 7], n: [0, 0, 1] },
      { idx: [1, 0, 3, 2], n: [0, 0, -1] },
      { idx: [5, 1, 2, 6], n: [1, 0, 0] },
      { idx: [0, 4, 7, 3], n: [-1, 0, 0] },
      { idx: [7, 6, 2, 3], n: [0, 1, 0] },
      { idx: [0, 1, 5, 4], n: [0, -1, 0] },
    ];
    for (const f of faces) {
      const n = rotN(f.n);
      const [a, b, c, d] = f.idx.map((i) => p[i]);
      this.quad(a, b, c, d, n, n, n, n, mat);
    }
  }

  /** upward facing plane (2 triangles) */
  planeY(y, halfSize, mat) {
    const s = halfSize;
    const n = [0, 1, 0];
    this.quad([-s, y, s], [s, y, s], [s, y, -s], [-s, y, -s], n, n, n, n, mat);
  }

  /** standing torus: ring in the XY plane, tube around it */
  torus(center, R, r, mat, segU = 72, segV = 28) {
    const at = (i, j) => {
      const u = (i / segU) * TAU;
      const v = (j / segV) * TAU;
      const cu = Math.cos(u), su = Math.sin(u);
      const cv = Math.cos(v), sv = Math.sin(v);
      const radial = [cu, su, 0];
      const n = [cv * cu, cv * su, sv];
      return {
        p: [
          center[0] + radial[0] * (R + r * cv),
          center[1] + radial[1] * (R + r * cv),
          center[2] + r * sv,
        ],
        n,
      };
    };
    for (let i = 0; i < segU; i++) {
      for (let j = 0; j < segV; j++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        this.quad(a.p, b.p, c.p, d.p, a.n, b.n, c.n, d.n, mat);
      }
    }
  }

  /** vertical cylinder (tube + caps) */
  cylinder(center, radius, height, mat, seg = 40) {
    const y0 = center[1] - height / 2;
    const y1 = center[1] + height / 2;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
      const n0 = [Math.cos(a0), 0, Math.sin(a0)];
      const n1 = [Math.cos(a1), 0, Math.sin(a1)];
      const p0 = [center[0] + n0[0] * radius, y0, center[2] + n0[2] * radius];
      const p1 = [center[0] + n1[0] * radius, y0, center[2] + n1[2] * radius];
      const p2 = [center[0] + n1[0] * radius, y1, center[2] + n1[2] * radius];
      const p3 = [center[0] + n0[0] * radius, y1, center[2] + n0[2] * radius];
      this.quad(p0, p1, p2, p3, n0, n1, n1, n0, mat);
      // caps
      this.tri(
        [center[0], y1, center[2]], p3, p2,
        [0, 1, 0], [0, 1, 0], [0, 1, 0], mat
      );
      this.tri(
        [center[0], y0, center[2]], p1, p0,
        [0, -1, 0], [0, -1, 0], [0, -1, 0], mat
      );
    }
  }
}
