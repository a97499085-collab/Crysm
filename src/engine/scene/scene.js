// CRYSM · demo scene "Atrium" — a studio composition built to show off
// PBR, glass, GI colour bleed, soft shadows and volumetric light.

import { MeshBuilder } from './geometry.js';
import { buildBVH } from './bvh.js';

const def = (o) => ({
  albedo: o.albedo ?? [0.8, 0.8, 0.8],
  roughness: o.roughness ?? 0.5,
  metallic: o.metallic ?? 0,
  emission: o.emission ?? [0, 0, 0],
  ior: o.ior ?? 1.5,
  transmission: o.transmission ?? 0,
  name: o.name ?? 'material',
});

export const MATERIAL_SLOTS = {
  floor: 0,
  wall: 1,
  hero: 2,
  gold: 3,
  glass: 4,
  ceramic: 5,
  red: 6,
  plinth: 7,
  emitter: 8,
  pillar: 9,
};

export function createMaterials() {
  return [
    def({ name: 'polished concrete', albedo: [0.295, 0.29, 0.278], roughness: 0.22 }),
    def({ name: 'teal plaster', albedo: [0.088, 0.145, 0.175], roughness: 0.82 }),
    def({ name: 'chrome', albedo: [0.96, 0.955, 0.94], roughness: 0.055, metallic: 1 }),
    def({ name: 'gold', albedo: [1.0, 0.76, 0.34], roughness: 0.19, metallic: 1 }),
    def({ name: 'glass', albedo: [0.72, 0.93, 0.94], roughness: 0.02, transmission: 0.96, ior: 1.52 }),
    def({ name: 'ceramic', albedo: [0.9, 0.885, 0.86], roughness: 0.3 }),
    def({ name: 'lacquer red', albedo: [0.68, 0.045, 0.055], roughness: 0.17 }),
    def({ name: 'basalt', albedo: [0.1, 0.1, 0.11], roughness: 0.42 }),
    def({
      name: 'area emitter',
      albedo: [0.0, 0.0, 0.0],
      roughness: 1.0,
      emission: [10.0, 6.8, 3.6],
    }),
    def({ name: 'gunmetal', albedo: [0.2, 0.21, 0.23], roughness: 0.35, metallic: 1 }),
  ];
}

export function buildScene() {
  const b = new MeshBuilder();
  const materials = createMaterials();
  const S = MATERIAL_SLOTS;

  // ---- room ---------------------------------------------------------------
  b.planeY(0, 26, S.floor);
  b.box([0, 6.5, -13.5], [40, 13, 0.8], S.wall);          // back wall
  b.box([-13.5, 5.0, -4.0], [0.7, 10, 20], S.wall);        // left wall
  b.box([13.5, 5.0, -6.0], [0.7, 10, 16], S.wall);         // right wall

  // ---- hero chrome sphere -------------------------------------------------
  b.sphere([-4.2, 1.8, 0.1], 1.8, S.hero, 56, 28);

  // ---- gold sphere --------------------------------------------------------
  b.sphere([2.35, 0.97, 1.9], 0.97, S.gold, 48, 24);

  // ---- glass sphere -------------------------------------------------------
  b.sphere([5.7, 1.3, -0.9], 1.3, S.glass, 56, 28);

  // ---- red lacquer cube ---------------------------------------------------
  b.box([-0.8, 0.75, -3.2], [1.5, 1.5, 1.5], S.red, 0.42);

  // ---- ceramic ring mounted on the back wall ------------------------------
  b.torus([0.35, 4.55, -12.85], 1.55, 0.26, S.ceramic, 84, 32);

  // ---- columns for depth --------------------------------------------------
  b.cylinder([-8.6, 3.2, -8.2], 0.42, 6.4, S.pillar, 32);
  b.cylinder([8.4, 3.2, -9.4], 0.42, 6.4, S.pillar, 32);

  // ---- emissive light bar (soft visible source + reflections) -------------
  b.box([0.0, 5.1, -8.4], [9.5, 0.16, 0.5], S.emitter);

  // ---- analytic rect emitter used for next-event estimation ---------------
  const light = {
    center: [0.0, 4.98, -8.4],
    right: [4.75, 0, 0],
    up: [0, 0, 0.25],
    normal: [0, 1, 0],
    area: 9.5 * 0.5,
    color: [10.0, 6.8, 3.6],
    enabled: true,
  };

  // ---- serialize ----------------------------------------------------------
  const triCount = b.mats.length;
  const vertCount = triCount * 3;

  const positions = new Float32Array(vertCount * 4);
  const normals = new Float32Array(vertCount * 4);
  for (let i = 0; i < vertCount; i++) {
    positions[i * 4 + 0] = b.positions[i * 3 + 0];
    positions[i * 4 + 1] = b.positions[i * 3 + 1];
    positions[i * 4 + 2] = b.positions[i * 3 + 2];
    normals[i * 4 + 0] = b.normals[i * 3 + 0];
    normals[i * 4 + 1] = b.normals[i * 3 + 1];
    normals[i * 4 + 2] = b.normals[i * 3 + 2];
  }

  const triMat = new Uint32Array(b.mats);
  const bvh = buildBVH(b.positions, triCount);

  const materialData = new Float32Array(materials.length * 12);
  writeMaterials(materialData, materials);

  return {
    positions,
    normals,
    triMat,
    materialData,
    materials,
    light,
    triOrder: bvh.triOrder,
    nodeBuffer: bvh.nodeBuffer,
    stats: {
      triangles: triCount,
      vertices: vertCount,
      nodes: bvh.nodeCount,
      materials: materials.length,
    },
  };
}

export function writeMaterials(dst, materials) {
  const tmp = new Float32Array(12);
  for (let i = 0; i < materials.length; i++) {
    const m = materials[i];
    tmp[0] = m.albedo[0]; tmp[1] = m.albedo[1]; tmp[2] = m.albedo[2]; tmp[3] = m.roughness;
    tmp[4] = m.emission[0]; tmp[5] = m.emission[1]; tmp[6] = m.emission[2]; tmp[7] = m.metallic;
    tmp[8] = m.ior; tmp[9] = m.transmission; tmp[10] = 0; tmp[11] = 0;
    dst.set(tmp, i * 12);
  }
}
