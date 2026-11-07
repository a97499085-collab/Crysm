// ============================================================================
//  CRYSM — WebGPU offline path tracer
//  main: boot, 30 FPS frame pacer, adaptive resolution, UI, camera input
// ============================================================================

import { initWebGPU } from './engine/webgpu/device.js';
import { CrysmRenderer } from './engine/webgpu/renderer.js';
import { OrbitCamera } from './engine/camera.js';
import { buildScene, MATERIAL_SLOTS } from './engine/scene/scene.js';
import { halton, normalize3, clamp, DEG } from './engine/math.js';
import { createHud, showFatal } from './ui/hud.js';

const canvas = document.getElementById('gpu');
const params = new URLSearchParams(location.search);
const TARGET_FPS = 30;

const HERO_PRESETS = {
  chrome: { albedo: [0.96, 0.955, 0.94], roughness: 0.055, metallic: 1 },
  gold: { albedo: [1.0, 0.76, 0.34], roughness: 0.19, metallic: 1 },
  copper: { albedo: [0.95, 0.56, 0.38], roughness: 0.24, metallic: 1 },
  ceramic: { albedo: [0.93, 0.905, 0.87], roughness: 0.16, metallic: 0 },
  graphite: { albedo: [0.15, 0.155, 0.165], roughness: 0.33, metallic: 1 },
};

const settings = {
  bounces: 4,
  taa: true,
  aoMode: false,
  sunEnabled: true,
  sunIntensity: 4.4,
  sunElevation: 32,
  sunAzimuth: 36,
  sunSoftness: 1.3,
  skyIntensity: 0.7,
  fogEnabled: true,
  fogDensity: 0.007,
  fogAnisotropy: 0.55,
  exposure: 0.95,
  bloomIntensity: 0.45,
  bloomThreshold: 1.1,
  vignette: 0.35,
  grain: 0.014,
  sharpen: 1.2,
  heroMaterial: 'chrome',
};

// ---------------------------------------------------------------- test hooks
const fixedScale = params.has('scale') ? clamp(parseFloat(params.get('scale')) || 1, 0.15, 1) : null;
if (params.has('bounces')) settings.bounces = clamp(parseInt(params.get('bounces'), 10) || 4, 1, 8);
if (params.get('fog') === '0') settings.fogEnabled = false;
if (params.get('ui') === '0') document.body.classList.add('ui-hidden');
if (params.get('ao') === '1') settings.aoMode = true;
if (params.get('taa') === '0') settings.taa = false;
if (params.has('sun')) settings.sunIntensity = parseFloat(params.get('sun')) || 0;
if (params.has('sky')) settings.skyIntensity = parseFloat(params.get('sky')) || 0;
if (params.has('exposure')) settings.exposure = parseFloat(params.get('exposure')) || 1;
if (params.has('fogd')) settings.fogDensity = parseFloat(params.get('fogd')) || 0;
if (params.has('sharp')) settings.sharpen = Math.max(0, parseFloat(params.get('sharp')) || 0);
if (fixedScale !== null) settings.taa = params.get('taa') !== '0';

// ------------------------------------------------------------------- state --
const camera = new OrbitCamera({
  target: [0.15, 1.58, -1.9],
  distance: 14.4,
  yaw: 0.03,
  pitch: 0.12,
  fov: 40,
});

let device = null;
let renderer = null;
let hud = null;
let scene = null;

let ready = false;
let busy = false;
let lastSubmit = 0;
let lastDone = 0;
let frameMs = 1000 / TARGET_FPS;
let renderCount = 0;
let bootFrames = 0;

let historySamples = 0;
let resetRequested = true;
let renderW = 0;
let renderH = 0;

let weakGpu = false;
let lastMoved = false;
let gpuMs = 0;
let lastAdapt = 0;

const MIN_SCALE_WEAK = 0.25;
const MIN_SCALE = 0.32;

let scale = fixedScale ?? 1.0;

const stats = { fps: 30, locked: true, samples: 0, width: 0, height: 0, ms: 33.3 };

// ------------------------------------------------------------------ helpers --
function fitCanvas() {
  // Match the physical display 1:1 (no browser-level resampling) — the path
  // tracer's own adaptive scale controls cost, so the final frame stays crisp.
  const maxDpr = weakGpu ? 1.5 : 2.0;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

/**
 * Detects low-power integrated GPUs so we can start conservative instead of
 * freezing at full resolution for the first few frames.
 */
function detectWeakGpu(info) {
  if (params.has('perf')) return params.get('perf') === '1';
  const label = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.device ?? ''} ${info?.description ?? ''}`.toLowerCase();
  if (/intel|uhd|hd graphics|iris|vega|radeon graphics|mali|adreno|swiftshader|llvmpipe|software/.test(label)) {
    return true;
  }
  // fallback heuristic: few logical cores usually means a low-power laptop
  return (navigator.hardwareConcurrency || 8) <= 6;
}

function requestReset() {
  resetRequested = true;
}

function applyHeroMaterial() {
  const preset = HERO_PRESETS[settings.heroMaterial] ?? HERO_PRESETS.chrome;
  const slot = MATERIAL_SLOTS.hero;
  Object.assign(scene.materials[slot], preset, { name: settings.heroMaterial });
  renderer.updateMaterials(scene.materials);
}

function sunDirection() {
  const el = settings.sunElevation * DEG;
  const az = settings.sunAzimuth * DEG;
  return normalize3([
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ]);
}

function quantizeScale(s) {
  return Math.round(s * 64) / 64;
}

function renderFrame(dt) {
  fitCanvas();
  const cw = canvas.width;
  const ch = canvas.height;
  const aspect = cw / ch;

  const moved = camera.update(dt);
  camera.viewProjection(aspect);
  lastMoved = moved;

  const sq = quantizeScale((weakGpu && moved ? 0.8 : 1) * scale);
  const rw = Math.max(160, Math.round(cw * sq));
  const rh = Math.max(120, Math.round(ch * sq));
  if (rw !== renderW || rh !== renderH) {
    renderW = rw;
    renderH = rh;
    resetRequested = true;
  }

  if (resetRequested) {
    historySamples = 0;
    resetRequested = false;
  } else if (moved) {
    historySamples = 6;
  }

  let alpha;
  if (!settings.taa) {
    alpha = 1;
    historySamples = 0;
  } else {
    alpha = 1 / (historySamples + 1);
  }
  if (!moved && settings.taa) historySamples = Math.min(historySamples + 1, 200000);

  const jitterIdx = settings.taa
    ? moved
      ? (renderCount % 16) + 1
      : Math.min(historySamples, 1024) + 1
    : 1;
  const jitter = settings.taa
    ? [halton(jitterIdx, 2) - 0.5, halton(jitterIdx, 3) - 0.5]
    : [0, 0];

  const sunDir = sunDirection();
  const sky = settings.skyIntensity;
  const sunColor = [
    1.0 * settings.sunIntensity,
    0.87 * settings.sunIntensity,
    0.7 * settings.sunIntensity,
  ];

  // Weak-GPU interaction helper: while the camera is moving the result is
  // reprojected/blended anyway; two bounces are visually indistinguishable in
  // motion and roughly halve the ray budget. The still image always uses the
  // full bounce count, so the final render is untouched.
  let bounces = settings.aoMode ? 1 : settings.bounces;
  if (weakGpu && moved && !settings.aoMode && bounces > 2) bounces = 2;

  renderer.render({
    width: renderW,
    height: renderH,
    canvasWidth: cw,
    canvasHeight: ch,
    camera: {
      position: camera.position,
      forward: camera.forward,
      right: camera.right,
      up: camera.up,
      tanHalfFov: camera.tanHalfFov,
      aspect,
      viewProj: camera.viewProj,
    },
    jitter,
    sunDir,
    sunColor,
    sunIntensity: settings.sunIntensity,
    sunAngularRadius: settings.sunSoftness * DEG,
    sunEnabled: settings.aoMode ? false : settings.sunEnabled,
    skyZenith: [0.105 * sky, 0.2 * sky, 0.36 * sky],
    skyHorizon: [0.6 * sky, 0.68 * sky, 0.8 * sky],
    exposure: settings.exposure,
    bloomIntensity: settings.bloomIntensity,
    bloomThreshold: settings.bloomThreshold,
    vignette: settings.vignette,
    grain: settings.grain,
    sharpen: settings.sharpen,
    bounces,
    aoMode: settings.aoMode,
    taaAlpha: alpha,
    sampleIndex: Math.max(0, historySamples - 1),
    time: performance.now() / 1000,
    fog: {
      enabled: settings.fogEnabled,
      sigmaT: settings.fogDensity,
      sigmaS: settings.fogDensity * 0.92,
      anisotropy: settings.fogAnisotropy,
    },
  });

  renderCount++;
  stats.samples = settings.taa ? Math.max(1, historySamples) : 1;
  stats.width = renderW;
  stats.height = renderH;
  stats.scale = quantizeScale(scale);
}

// ------------------------------------------------------------------- pacer --
function loop(now) {
  requestAnimationFrame(loop);
  if (!ready) return;

  const interval = 1000 / TARGET_FPS;
  if (now - lastSubmit < interval - 4) return;
  if (busy) return;

  busy = true;
  lastSubmit = now;
  const dt = Math.min(0.1, Math.max(0.001, (now - (loop.last ?? now - 16)) / 1000));
  loop.last = now;

  try {
    renderFrame(dt);
  } catch (err) {
    console.error('[Crysm] render error', err);
    busy = false;
    return;
  }

  const submitAt = performance.now();
  device.queue.onSubmittedWorkDone().then(
    () => {
      const done = performance.now();
      const previewMs = Math.max(0.1, done - submitAt); // actual GPU work time
      gpuMs = gpuMs === 0 ? previewMs : gpuMs * 0.65 + previewMs * 0.35;

      if (lastDone) {
        frameMs = frameMs * 0.9 + (done - lastDone) * 0.1;
        const fps = Math.min(1000 / frameMs, 999);
        stats.fps = fps;
        stats.ms = gpuMs || frameMs;
        stats.locked = fps >= 28.5;
      }
      lastDone = done;
      busy = false;
      stats.gpuMs = gpuMs;

      // --------------------------------------------------- adaptive quality
      // Goal: hold 30 FPS without ever letting a slow frame snowball into a
      // freeze. One bad frame drops resolution immediately; recovery is slow
      // and only happens when there is real headroom (and the camera is still,
      // so we never fight the motion path).
      if (!fixedScale && renderCount > 1) {
        const minScale = weakGpu ? MIN_SCALE_WEAK : MIN_SCALE;
        if (previewMs > 90 && scale > minScale) {
          // emergency: a frame that took >90 ms is a visible hitch -> cut now
          scale = Math.max(minScale, scale * clamp(Math.sqrt(24 / previewMs), 0.55, 0.8));
          lastAdapt = renderCount;
        } else if (renderCount - lastAdapt >= 6) {
          lastAdapt = renderCount;
          if (gpuMs > 32 && scale > minScale) {
            scale = Math.max(minScale, scale * clamp(Math.sqrt(30 / gpuMs), 0.72, 0.93));
          } else if (!(weakGpu && lastMoved) && gpuMs < 26.5 && scale < 1) {
            // only grow when the camera is still, so motion never fights the
            // adaptive loop; recovery is intentionally gentle. The threshold
            // stays just under the 33.3 ms frame budget, so the engine holds
            // 30 FPS while giving us the highest resolution it can afford.
            scale = Math.min(1, scale * 1.06);
          }
        }
      }

      bootFrames++;
      if (bootFrames === 1) hud.setReady();

      const nowMs = performance.now();
      if (nowMs - (loop.lastHud ?? 0) > 120) {
        loop.lastHud = nowMs;
        hud.setStats(stats);
      }
    },
    (err) => {
      console.error('[Crysm] GPU wait failed', err);
      busy = false;
    }
  );
}

// ------------------------------------------------------------------- capture --
async function saveFrame() {
  if (!renderer) return;
  hud.toast('Kare kaydediliyor…');
  try {
    const blob = await renderer.capturePng();
    if (!blob) throw new Error('PNG oluşturulamadı');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `crysm-${ts}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    hud.toast('PNG kaydedildi · ' + renderW + '×' + renderH);
  } catch (e) {
    console.error(e);
    hud.toast('Kayıt başarısız: ' + e.message);
  }
}

// --------------------------------------------------------------------- input --
function bindInput() {
  let drag = 0;
  let lx = 0;
  let ly = 0;

  canvas.addEventListener('pointerdown', (e) => {
    drag = e.button === 2 ? 2 : 1;
    lx = e.clientX;
    ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - lx;
    const dy = e.clientY - ly;
    lx = e.clientX;
    ly = e.clientY;
    if (drag === 2) camera.pan(dx, dy);
    else camera.orbit(dx, dy);
  });
  const end = (e) => {
    drag = 0;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      camera.zoom(e.deltaY);
    },
    { passive: false }
  );

  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'h') {
      document.body.classList.toggle('ui-hidden');
    } else if (k === 'r') {
      camera.reset();
      renderer?.resetHistory();
      requestReset();
      hud?.toast('Kamera sıfırlandı');
    } else if (k === 'p') {
      saveFrame();
    } else if (k === ' ') {
      camera.autoOrbit = !camera.autoOrbit;
      hud?.toast(camera.autoOrbit ? 'Otomatik yörünge açık' : 'Otomatik yörünge kapalı');
      e.preventDefault();
    }
  });

  window.addEventListener('resize', () => {
    fitCanvas();
    requestReset();
  });
}

// ---------------------------------------------------------------------- boot --
async function main() {
  const bootStatus = (m) => hud?.setBootStatus(m) ?? (document.getElementById('bootStatus').textContent = m);

  try {
    fitCanvas();
    bootStatus('WebGPU adaptörü isteniyor…');
    const gpu = await initWebGPU(canvas);
    device = gpu.device;

    // Detect integrated/low-power GPUs and start conservative so the very
    // first frames never freeze at full resolution. It ramps back up on its
    // own within a second or two if the GPU can afford it.
    weakGpu = detectWeakGpu(gpu.info);
    if (fixedScale === null) scale = weakGpu ? 0.34 : 0.55;
    fitCanvas();
    requestReset();
    console.info('[Crysm] adaptör:', JSON.stringify(gpu.info), '· zayıf GPU modu:', weakGpu);

    bootStatus('Shader’lar derleniyor…');
    const [pathSrc, taaSrc, bloomSrc, compSrc] = await Promise.all([
      fetch('./src/engine/shaders/pathtrace.wgsl').then((r) => r.text()),
      fetch('./src/engine/shaders/taa.wgsl').then((r) => r.text()),
      fetch('./src/engine/shaders/bloom.wgsl').then((r) => r.text()),
      fetch('./src/engine/shaders/composite.wgsl').then((r) => r.text()),
    ]);

    bootStatus('Sahne ve BVH inşa ediliyor…');
    scene = buildScene();
    applyHeroMaterialToScene();

    renderer = new CrysmRenderer({
      device: gpu.device,
      context: gpu.context,
      format: gpu.format,
      scene,
    });
    await renderer.init({ path: pathSrc, taa: taaSrc, bloom: bloomSrc, composite: compSrc });

    hud = createHud({
      settings,
      scene,
      gpu: gpu.info,
      onChange: (key) => {
        if (key === 'heroMaterial') applyHeroMaterial();
        // sharpening is a pure post-process knob; no need to reset history
        if (key !== 'sharpen') requestReset();
      },
      onShot: saveFrame,
      onReset: () => {
        camera.reset();
        settings.sunAzimuth = 36;
        settings.sunElevation = 32;
        settings.sunIntensity = 4.2;
        settings.exposure = 1.0;
        settings.fogDensity = 0.012;
        requestReset();
        hud.toast('Sahne sıfırlandı');
      },
    });

    bindInput();
    ready = true;
    lastSubmit = performance.now();
    requestAnimationFrame(loop);
    hud.setBootStatus('İlk kare render ediliyor…');

    window.__crysm = {
      settings,
      camera,
      stats,
      get renderer() { return renderer; },
      get scene() { return scene; },
      get hud() { return hud; },
      saveFrame,
    };
  } catch (err) {
    console.error(err);
    showFatal('Crysm başlatılamadı', err?.message ?? String(err));
  }
}

function applyHeroMaterialToScene() {
  const preset = HERO_PRESETS[settings.heroMaterial] ?? HERO_PRESETS.chrome;
  Object.assign(scene.materials[MATERIAL_SLOTS.hero], preset, { name: settings.heroMaterial });
}

// temp helper: materials must be uploaded by the renderer after it exists
main();
