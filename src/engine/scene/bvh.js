// CRYSM · CPU BVH builder (median split, 32-byte nodes)
// Node layout: bmin.xyz (f32 x3) | left/count (u32) | bmax.xyz (f32 x3) | leafCount (u32)

const LEAF_SIZE = 4;

export function buildBVH(positions, triCount) {
  if (triCount <= 0) {
    const buf = new ArrayBuffer(32);
    return { nodeBuffer: buf, triOrder: new Uint32Array(0), nodeCount: 1 };
  }

  const triMin = new Float32Array(triCount * 3);
  const triMax = new Float32Array(triCount * 3);
  const centroid = new Float32Array(triCount * 3);

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    for (let a = 0; a < 3; a++) {
      const c = a + 0;
      const p0 = positions[o + c];
      const p1 = positions[o + 3 + c];
      const p2 = positions[o + 6 + c];
      triMin[t * 3 + a] = Math.min(p0, p1, p2);
      triMax[t * 3 + a] = Math.max(p0, p1, p2);
      centroid[t * 3 + a] = (p0 + p1 + p2) / 3;
    }
  }

  const order = new Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;

  const tree = [];

  function buildRec(start, end) {
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], left: -1, right: -1, start, count: 0 };
    for (let i = start; i < end; i++) {
      const t = order[i];
      for (let a = 0; a < 3; a++) {
        if (triMin[t * 3 + a] < node.min[a]) node.min[a] = triMin[t * 3 + a];
        if (triMax[t * 3 + a] > node.max[a]) node.max[a] = triMax[t * 3 + a];
      }
    }

    const n = end - start;
    if (n <= LEAF_SIZE) {
      node.count = n;
      tree.push(node);
      return node;
    }

    // longest centroid axis
    let cmin = [Infinity, Infinity, Infinity];
    let cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = order[i];
      for (let a = 0; a < 3; a++) {
        const v = centroid[t * 3 + a];
        if (v < cmin[a]) cmin[a] = v;
        if (v > cmax[a]) cmax[a] = v;
      }
    }
    const ext = [cmax[0] - cmin[0], cmax[1] - cmin[1], cmax[2] - cmin[2]];
    const axis = ext[0] > ext[1] ? (ext[0] > ext[2] ? 0 : 2) : (ext[1] > ext[2] ? 1 : 2);

    if (ext[axis] < 1e-7) {
      node.count = n;
      tree.push(node);
      return node;
    }

    const slice = order.slice(start, end);
    slice.sort((a, b) => centroid[a * 3 + axis] - centroid[b * 3 + axis]);
    for (let i = 0; i < slice.length; i++) order[start + i] = slice[i];

    const mid = (start + end) >> 1;
    node.left = buildRec(start, mid);
    node.right = buildRec(mid, end);
    return node;
  }

  const root = buildRec(0, triCount);

  // Flatten breadth-first so internal children are always adjacent (right = left + 1)
  const flat = [null];
  const queue = [{ node: root, index: 0 }];
  while (queue.length) {
    const { node, index } = queue.shift();
    const slot = { min: node.min, max: node.max, left: 0, count: 0 };
    if (node.count > 0) {
      slot.count = node.count;
      slot.left = node.start;
    } else {
      const leftIdx = flat.length;
      flat.push(null, null);
      slot.left = leftIdx;
      queue.push({ node: node.left, index: leftIdx });
      queue.push({ node: node.right, index: leftIdx + 1 });
    }
    flat[index] = slot;
  }

  const nodeCount = flat.length;
  const nodeBuffer = new ArrayBuffer(nodeCount * 32);
  const f32 = new Float32Array(nodeBuffer);
  const u32 = new Uint32Array(nodeBuffer);
  for (let i = 0; i < nodeCount; i++) {
    const s = flat[i];
    const base = i * 8;
    f32[base + 0] = s.min[0];
    f32[base + 1] = s.min[1];
    f32[base + 2] = s.min[2];
    u32[base + 3] = s.left;
    f32[base + 4] = s.max[0];
    f32[base + 5] = s.max[1];
    f32[base + 6] = s.max[2];
    u32[base + 7] = s.count;
  }

  return { nodeBuffer, triOrder: Uint32Array.from(order), nodeCount };
}
