// ============================================================================
//  CRYSM · WebGPU render graph
//    path trace (compute) -> TAA/accumulate (compute) -> bloom chain (compute)
//    -> HDR composite + ACES tonemap (render)
// ============================================================================

const UNIFORM_FLOATS = 96;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
const BLOOM_LEVELS = 5;

const STORAGE_USAGE = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;

function makeStorageBuffer(device, data, label) {
  const buffer = device.createBuffer({
    label,
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new data.constructor(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

export class CrysmRenderer {
  constructor({ device, context, format, scene }) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.scene = scene;

    this.width = 0;
    this.height = 0;
    this.frameIndex = 0;
    this.histRead = 0;
    this.prevViewProj = null;

    this.uniformData = new Float32Array(UNIFORM_FLOATS);
    this.uniformBuffer = device.createBuffer({
      label: 'crysm-uniforms',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.buffers = {
      positions: makeStorageBuffer(device, scene.positions, 'positions'),
      normals: makeStorageBuffer(device, scene.normals, 'normals'),
      triMat: makeStorageBuffer(device, scene.triMat, 'triMat'),
      triOrder: makeStorageBuffer(device, scene.triOrder, 'triOrder'),
      bvh: device.createBuffer({
        label: 'bvh',
        size: scene.nodeBuffer.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      }),
      materials: makeStorageBuffer(device, scene.materialData, 'materials'),
    };
    new Uint8Array(this.buffers.bvh.getMappedRange()).set(new Uint8Array(scene.nodeBuffer));
    this.buffers.bvh.unmap();
  }

  async init(shaders) {
    const device = this.device;
    const modules = {};
    for (const [key, code] of Object.entries(shaders)) {
      const mod = device.createShaderModule({ label: 'crysm-' + key, code });
      const info = await mod.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) {
        const msg = errors
          .map((m) => `  ${key}.wgsl ${m.lineNum}:${m.linePos} — ${m.message}`)
          .join('\n');
        throw new Error('WGSL derleme hatası:\n' + msg);
      }
      const warnings = info.messages.filter((m) => m.type === 'warning');
      if (warnings.length) {
        console.warn(
          '[Crysm][WGSL] ' + key + '\n' + warnings.map((m) => `${m.lineNum}: ${m.message}`).join('\n')
        );
      }
      modules[key] = mod;
    }

    this.ptPipeline = device.createComputePipeline({
      label: 'pathtrace',
      layout: 'auto',
      compute: { module: modules.path, entryPoint: 'main' },
    });
    this.taaPipeline = device.createComputePipeline({
      label: 'taa',
      layout: 'auto',
      compute: { module: modules.taa, entryPoint: 'main' },
    });
    this.bloomPipeline = device.createComputePipeline({
      label: 'bloom',
      layout: 'auto',
      compute: { module: modules.bloom, entryPoint: 'main' },
    });
    this.compositePipeline = device.createRenderPipeline({
      label: 'composite',
      layout: 'auto',
      vertex: { module: modules.composite, entryPoint: 'vs' },
      fragment: {
        module: modules.composite,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.ptLayout = this.ptPipeline.getBindGroupLayout(0);
    this.taaLayout = this.taaPipeline.getBindGroupLayout(0);
    this.bloomLayout = this.bloomPipeline.getBindGroupLayout(0);
    this.compositeLayout = this.compositePipeline.getBindGroupLayout(0);
  }

  updateMaterials(materials) {
    // materials: array of material definitions (same order/count)
    const data = new Float32Array(materials.length * 12);
    const tmp = new Float32Array(12);
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i];
      tmp[0] = m.albedo[0]; tmp[1] = m.albedo[1]; tmp[2] = m.albedo[2]; tmp[3] = m.roughness;
      tmp[4] = m.emission[0]; tmp[5] = m.emission[1]; tmp[6] = m.emission[2]; tmp[7] = m.metallic;
      tmp[8] = m.ior; tmp[9] = m.transmission; tmp[10] = 0; tmp[11] = 0;
      data.set(tmp, i * 12);
    }
    this.device.queue.writeBuffer(this.buffers.materials, 0, data);
  }

  _createTargets(w, h) {
    this._destroyTargets();
    this.width = w;
    this.height = h;
    const device = this.device;
    const mk = (width, height, format) =>
      device.createTexture({
        size: [Math.max(1, width), Math.max(1, height), 1],
        format,
        usage: STORAGE_USAGE,
      });

    this.sampleTex = mk(w, h, 'rgba32float');
    this.gbufTex = mk(w, h, 'rgba32float');
    this.hist = [mk(w, h, 'rgba32float'), mk(w, h, 'rgba32float')];

    this.bloom = [];
    this.bloomDims = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const bw = Math.ceil(w / 2 ** (i + 1));
      const bh = Math.ceil(h / 2 ** (i + 1));
      this.bloomDims.push([Math.max(1, bw), Math.max(1, bh)]);
      this.bloom.push(mk(bw, bh, 'rgba16float'));
    }

    this._buildBindGroups();
  }

  _destroyTargets() {
    for (const t of [this.sampleTex, this.gbufTex, ...(this.hist ?? []), ...(this.bloom ?? [])]) {
      t?.destroy();
    }
    this.sampleTex = this.gbufTex = null;
    this.hist = [];
    this.bloom = [];
  }

  _buildBindGroups() {
    const device = this.device;
    const uniformEntry = { binding: 0, resource: { buffer: this.uniformBuffer } };

    this.ptBind = device.createBindGroup({
      label: 'pathtrace-bind',
      layout: this.ptLayout,
      entries: [
        uniformEntry,
        { binding: 1, resource: { buffer: this.buffers.positions } },
        { binding: 2, resource: { buffer: this.buffers.normals } },
        { binding: 3, resource: { buffer: this.buffers.triMat } },
        { binding: 4, resource: { buffer: this.buffers.bvh } },
        { binding: 5, resource: { buffer: this.buffers.triOrder } },
        { binding: 6, resource: { buffer: this.buffers.materials } },
        { binding: 7, resource: this.sampleTex.createView() },
        { binding: 8, resource: this.gbufTex.createView() },
      ],
    });

    this.taaBind = [0, 1].map((read) =>
      device.createBindGroup({
        label: 'taa-bind-' + read,
        layout: this.taaLayout,
        entries: [
          uniformEntry,
          { binding: 1, resource: this.sampleTex.createView() },
          { binding: 2, resource: this.gbufTex.createView() },
          { binding: 3, resource: this.hist[read].createView() },
          { binding: 4, resource: this.hist[1 - read].createView() },
        ],
      })
    );

    this.bloomBind = [0, 1].map((histIdx) => {
      const groups = [];
      let src = this.hist[histIdx];
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        groups.push(
          device.createBindGroup({
            label: `bloom-bind-${histIdx}-${i}`,
            layout: this.bloomLayout,
            entries: [
              uniformEntry,
              { binding: 1, resource: src.createView() },
              { binding: 2, resource: this.bloom[i].createView() },
            ],
          })
        );
        src = this.bloom[i];
      }
      return groups;
    });

    this.compositeBind = [0, 1].map((histIdx) =>
      device.createBindGroup({
        label: 'composite-bind-' + histIdx,
        layout: this.compositeLayout,
        entries: [
          uniformEntry,
          { binding: 1, resource: this.hist[histIdx].createView() },
          ...this.bloom.map((t, i) => ({ binding: 2 + i, resource: t.createView() })),
        ],
      })
    );
  }

  _writeUniforms(s) {
    const F = this.uniformData;
    const cam = s.camera;

    F[0] = cam.position[0]; F[1] = cam.position[1]; F[2] = cam.position[2];
    F[3] = cam.tanHalfFov;
    F[4] = cam.right[0]; F[5] = cam.right[1]; F[6] = cam.right[2];
    F[7] = cam.aspect;
    F[8] = cam.up[0]; F[9] = cam.up[1]; F[10] = cam.up[2];
    F[11] = s.jitter[0];
    F[12] = cam.forward[0]; F[13] = cam.forward[1]; F[14] = cam.forward[2];
    F[15] = s.jitter[1];

    F[16] = s.sunDir[0]; F[17] = s.sunDir[1]; F[18] = s.sunDir[2];
    F[19] = s.sunAngularRadius;
    F[20] = s.sunColor[0]; F[21] = s.sunColor[1]; F[22] = s.sunColor[2];
    F[23] = s.sunIntensity;

    F[24] = s.skyZenith[0]; F[25] = s.skyZenith[1]; F[26] = s.skyZenith[2];
    F[27] = s.exposure;
    F[28] = s.skyHorizon[0]; F[29] = s.skyHorizon[1]; F[30] = s.skyHorizon[2];
    F[31] = s.bloomIntensity;

    F[32] = s.fog.enabled ? s.fog.sigmaT : 0;
    F[33] = s.fog.sigmaS;
    F[34] = s.fog.anisotropy;
    F[35] = s.fog.enabled ? 1 : 0;

    F[36] = s.bounces;
    F[37] = s.aoMode ? 1 : 0;
    F[38] = s.sunEnabled ? 1 : 0;
    F[39] = s.taaAlpha;

    F[40] = this.width; F[41] = this.height;
    F[42] = 1 / this.width; F[43] = 1 / this.height;

    F[44] = s.canvasWidth; F[45] = s.canvasHeight;
    F[46] = 1 / s.canvasWidth; F[47] = 1 / s.canvasHeight;

    F[48] = s.vignette;
    F[49] = s.grain;
    F[50] = s.bloomThreshold;
    F[51] = Math.min(0.95, Math.max(0, (1 - this.width / s.canvasWidth) * 1.45 * (s.sharpen ?? 1)));

    F[52] = s.sampleIndex;
    F[53] = this.frameIndex;
    F[54] = s.time;
    F[55] = 0;

    F.set(this.prevViewProj ?? cam.viewProj, 56);

    const L = this.scene.light;
    if (L) {
      F[72] = L.center[0]; F[73] = L.center[1]; F[74] = L.center[2]; F[75] = L.area;
      F[76] = L.right[0]; F[77] = L.right[1]; F[78] = L.right[2]; F[79] = L.enabled ? 1 : 0;
      F[80] = L.up[0]; F[81] = L.up[1]; F[82] = L.up[2]; F[83] = 0;
      F[84] = L.normal[0]; F[85] = L.normal[1]; F[86] = L.normal[2]; F[87] = 0;
      F[88] = L.color[0]; F[89] = L.color[1]; F[90] = L.color[2]; F[91] = 0;
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, F);
  }

  render(s) {
    if (!this.ptPipeline) return;
    if (this.width !== s.width || this.height !== s.height) {
      this._createTargets(s.width, s.height);
    }

    this._writeUniforms(s);

    const read = this.histRead;
    const write = 1 - read;
    const ox = Math.ceil(this.width / 8);
    const oy = Math.ceil(this.height / 8);

    const enc = this.device.createCommandEncoder({ label: 'crysm-frame' });

    const ptPass = enc.beginComputePass({ label: 'pathtrace' });
    ptPass.setPipeline(this.ptPipeline);
    ptPass.setBindGroup(0, this.ptBind);
    ptPass.dispatchWorkgroups(ox, oy, 1);
    ptPass.end();

    const taaPass = enc.beginComputePass({ label: 'taa' });
    taaPass.setPipeline(this.taaPipeline);
    taaPass.setBindGroup(0, this.taaBind[read]);
    taaPass.dispatchWorkgroups(ox, oy, 1);
    taaPass.end();

    const bloomPass = enc.beginComputePass({ label: 'bloom' });
    bloomPass.setPipeline(this.bloomPipeline);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bloomPass.setBindGroup(0, this.bloomBind[write][i]);
      const [bw, bh] = this.bloomDims[i];
      bloomPass.dispatchWorkgroups(Math.ceil(bw / 8), Math.ceil(bh / 8), 1);
    }
    bloomPass.end();

    const swapView = this.context.getCurrentTexture().createView();
    const compPass = enc.beginRenderPass({
      label: 'composite',
      colorAttachments: [
        {
          view: swapView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    compPass.setPipeline(this.compositePipeline);
    compPass.setBindGroup(0, this.compositeBind[write]);
    compPass.draw(3);
    compPass.end();

    this.device.queue.submit([enc.finish()]);

    this.histRead = write;
    this.frameIndex++;
    this.prevViewProj = Float32Array.from(s.camera.viewProj);
    this.captureW = s.canvasWidth;
    this.captureH = s.canvasHeight;
  }

  /**
   * Renders the current resolved HDR frame through the composite pass into an
   * offscreen texture and reads it back as a PNG blob.
   */
  async capturePng() {
    const w = Math.max(1, Math.round(this.captureW ?? this.width));
    const h = Math.max(1, Math.round(this.captureH ?? this.height));
    const device = this.device;

    const tex = device.createTexture({
      label: 'capture',
      size: [w, h, 1],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const rowPitch = Math.ceil((w * 4) / 256) * 256;
    const readback = device.createBuffer({
      label: 'capture-readback',
      size: rowPitch * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = device.createCommandEncoder({ label: 'capture' });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: tex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, this.compositeBind[this.histRead]);
    pass.draw(3);
    pass.end();
    enc.copyTextureToBuffer(
      { texture: tex },
      { buffer: readback, bytesPerRow: rowPitch, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 }
    );
    device.queue.submit([enc.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(readback.getMappedRange());

    const img = new ImageData(w, h);
    const bgra = this.format === 'bgra8unorm' || this.format === 'bgra8unorm-srgb';
    for (let y = 0; y < h; y++) {
      const srcRow = y * rowPitch;
      const dstRow = y * w * 4;
      if (!bgra) {
        img.data.set(src.subarray(srcRow, srcRow + w * 4), dstRow);
      } else {
        for (let x = 0; x < w; x++) {
          const s = srcRow + x * 4;
          const d = dstRow + x * 4;
          img.data[d + 0] = src[s + 2];
          img.data[d + 1] = src[s + 1];
          img.data[d + 2] = src[s + 0];
          img.data[d + 3] = 255;
        }
      }
    }

    readback.unmap();
    readback.destroy();
    tex.destroy();

    const canvas2 = document.createElement('canvas');
    canvas2.width = w;
    canvas2.height = h;
    canvas2.getContext('2d').putImageData(img, 0, 0);
    return await new Promise((resolve) => canvas2.toBlob(resolve, 'image/png'));
  }

  resetHistory() {
    // Recreate small textures? Cheaper: leave them, TAA with alpha 0.2 converges.
    this.histRead = 0;
    this.prevViewProj = null;
  }
}
