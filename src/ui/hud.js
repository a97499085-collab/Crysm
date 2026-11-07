// CRYSM · HUD — generated settings panel + live stats

const FEATURES = [
  ['pbr', 'PBR MATERIALS'],
  ['shadows', 'DYNAMIC SHADOWS'],
  ['gi', 'GLOBAL ILLUMINATION'],
  ['ao', 'AMBIENT OCCLUSION'],
  ['fog', 'VOLUMETRIC FOG'],
  ['bloom', 'BLOOM'],
  ['hdr', 'HDR RENDERING'],
  ['taa', 'TEMPORAL AA'],
  ['webgpu', 'WEBGPU BACKEND'],
];

const SCHEMA = [
  {
    name: 'SAMPLING',
    items: [
      { type: 'range', key: 'bounces', label: 'Path bounces', min: 1, max: 8, step: 1, fmt: (v) => v.toFixed(0) },
      { type: 'toggle', key: 'taa', label: 'Temporal AA' },
      { type: 'toggle', key: 'aoMode', label: 'AO preview mode' },
    ],
  },
  {
    name: 'SUN & SKY',
    items: [
      { type: 'toggle', key: 'sunEnabled', label: 'Sun shadows' },
      { type: 'range', key: 'sunIntensity', label: 'Sun intensity', min: 0, max: 8, step: 0.05, fmt: (v) => v.toFixed(2) },
      { type: 'range', key: 'sunElevation', label: 'Sun elevation', min: 2, max: 84, step: 0.5, fmt: (v) => v.toFixed(0) + '°' },
      { type: 'range', key: 'sunAzimuth', label: 'Sun azimuth', min: 0, max: 360, step: 1, fmt: (v) => v.toFixed(0) + '°' },
      { type: 'range', key: 'sunSoftness', label: 'Shadow softness', min: 0.2, max: 9, step: 0.1, fmt: (v) => v.toFixed(1) + '°' },
      { type: 'range', key: 'skyIntensity', label: 'Sky intensity', min: 0, max: 2.5, step: 0.02, fmt: (v) => v.toFixed(2) },
    ],
  },
  {
    name: 'ATMOSPHERE',
    items: [
      { type: 'toggle', key: 'fogEnabled', label: 'Volumetric fog' },
      { type: 'range', key: 'fogDensity', label: 'Fog density', min: 0, max: 0.06, step: 0.0005, fmt: (v) => v.toFixed(3) },
      { type: 'range', key: 'fogAnisotropy', label: 'Forward scatter', min: 0, max: 0.9, step: 0.01, fmt: (v) => v.toFixed(2) },
    ],
  },
  {
    name: 'POST / HDR',
    items: [
      { type: 'range', key: 'exposure', label: 'Exposure', min: 0.2, max: 3, step: 0.01, fmt: (v) => v.toFixed(2) },
      { type: 'range', key: 'sharpen', label: 'HD keskinlik', min: 0, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
      { type: 'range', key: 'bloomIntensity', label: 'Bloom', min: 0, max: 1.5, step: 0.01, fmt: (v) => v.toFixed(2) },
      { type: 'range', key: 'bloomThreshold', label: 'Bloom threshold', min: 0, max: 3, step: 0.01, fmt: (v) => v.toFixed(2) },
      { type: 'range', key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
      { type: 'range', key: 'grain', label: 'Film grain', min: 0, max: 0.08, step: 0.002, fmt: (v) => v.toFixed(3) },
    ],
  },
  {
    name: 'MATERIAL',
    items: [
      {
        type: 'select',
        key: 'heroMaterial',
        label: 'Hero material',
        options: [
          ['chrome', 'Chrome'],
          ['gold', 'Gold'],
          ['copper', 'Copper'],
          ['ceramic', 'Ceramic'],
          ['graphite', 'Graphite'],
        ],
      },
    ],
  },
];

export function createHud({ settings, scene, gpu, onChange, onShot, onReset }) {
  const $ = (id) => document.getElementById(id);
  const body = $('panelBody');
  const featureList = $('featureList');
  const valEls = new Map();

  // ---- settings panel -----------------------------------------------------
  for (const group of SCHEMA) {
    const g = document.createElement('div');
    g.className = 'group';
    const h = document.createElement('h3');
    h.textContent = group.name;
    g.appendChild(h);

    for (const item of group.items) {
      if (item.type === 'range') {
        const wrap = document.createElement('label');
        wrap.className = 'ctrl';
        const top = document.createElement('div');
        top.className = 'ctrl-top';
        const name = document.createElement('span');
        name.className = 'ctrl-name';
        name.textContent = item.label;
        const val = document.createElement('span');
        val.className = 'ctrl-val';
        val.textContent = item.fmt(settings[item.key]);
        top.append(name, val);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = item.min;
        input.max = item.max;
        input.step = item.step;
        input.value = settings[item.key];
        input.dataset.key = item.key;
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          settings[item.key] = v;
          val.textContent = item.fmt(v);
          onChange(item.key);
        });
        wrap.append(top, input);
        valEls.set(item.key, { el: val, item });
        g.appendChild(wrap);
      } else if (item.type === 'toggle') {
        const wrap = document.createElement('label');
        wrap.className = 'switch';
        const span = document.createElement('span');
        span.textContent = item.label;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!settings[item.key];
        input.dataset.key = item.key;
        input.addEventListener('change', () => {
          settings[item.key] = input.checked;
          onChange(item.key);
          updateFeatures();
        });
        const knob = document.createElement('i');
        wrap.append(span, input, knob);
        g.appendChild(wrap);
      } else if (item.type === 'select') {
        const wrap = document.createElement('label');
        wrap.className = 'ctrl';
        const top = document.createElement('div');
        top.className = 'ctrl-top';
        const name = document.createElement('span');
        name.className = 'ctrl-name';
        name.textContent = item.label;
        top.appendChild(name);
        const sel = document.createElement('select');
        sel.dataset.key = item.key;
        for (const [v, text] of item.options) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = text;
          sel.appendChild(o);
        }
        sel.value = settings[item.key];
        sel.addEventListener('change', () => {
          settings[item.key] = sel.value;
          onChange(item.key);
        });
        wrap.append(top, sel);
        g.appendChild(wrap);
      }
    }
    body.appendChild(g);
  }

  // ---- feature list -------------------------------------------------------
  for (const [id, label] of FEATURES) {
    const li = document.createElement('li');
    li.textContent = label;
    li.dataset.feature = id;
    featureList.appendChild(li);
  }

  function updateFeatures() {
    const map = {
      shadows: settings.sunEnabled,
      gi: settings.bounces > 1,
      fog: settings.fogEnabled,
      bloom: settings.bloomIntensity > 0.001,
      taa: settings.taa,
      ao: true,
      pbr: true,
      hdr: true,
      webgpu: true,
    };
    for (const li of featureList.children) {
      li.classList.toggle('off', !map[li.dataset.feature]);
    }
  }
  updateFeatures();

  // ---- stats --------------------------------------------------------------
  const fpsEl = $('fps');
  const fpsStateEl = $('fpsState');
  const samplesEl = $('samples');
  const resEl = $('res');
  const msEl = $('ms');
  $('gpuName').textContent =
    [gpu.vendor, gpu.architecture].filter(Boolean).join(' · ') ||
    gpu.device ||
    gpu.description ||
    'WebGPU';

  $('sceneInfo').textContent =
    `${scene.stats.triangles.toLocaleString('tr-TR')} tris · ` +
    `${scene.stats.nodes.toLocaleString('tr-TR')} BVH nodes · ${scene.stats.materials} materials`;

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---- panel collapse -----------------------------------------------------
  const panel = $('panel');
  const reopen = document.createElement('button');
  reopen.textContent = 'SETTINGS';
  reopen.style.cssText =
    'position:fixed;top:22px;right:22px;z-index:13;display:none;font-family:var(--mono);' +
    'font-size:8px;letter-spacing:.16em;padding:8px 11px;border-radius:6px;cursor:pointer;' +
    'background:rgba(12,14,19,.8);border:1px solid rgba(255,255,255,.14);color:#c9c7c1;backdrop-filter:blur(10px)';
  document.body.appendChild(reopen);

  $('panelToggle').addEventListener('click', () => {
    panel.classList.add('collapsed');
    reopen.style.display = 'block';
  });
  reopen.addEventListener('click', () => {
    panel.classList.remove('collapsed');
    reopen.style.display = 'none';
  });

  $('btnShot').addEventListener('click', onShot);
  $('btnReset').addEventListener('click', onReset);

  return {
    setReady() {
      $('boot').classList.add('hidden');
      setTimeout(() => ($('boot').style.display = 'none'), 800);
    },
    setBootStatus(msg) {
      $('bootStatus').textContent = msg;
    },
    setStats(s) {
      fpsEl.textContent = s.fps.toFixed(1);
      fpsStateEl.textContent = s.locked ? 'LOCK' : 'ADAPT';
      fpsStateEl.classList.toggle('warn', !s.locked);
      samplesEl.textContent = s.samples >= 1000 ? (s.samples / 1000).toFixed(1) + 'k' : String(s.samples);
      resEl.textContent = `${s.width}×${s.height}`;
      msEl.textContent = s.ms.toFixed(1);
    },
    toast,
    setSceneInfo(text) {
      $('sceneInfo').textContent = text;
    },
    refreshControl(key) {
      const entry = valEls.get(key);
      if (entry) entry.el.textContent = entry.item.fmt(settings[key]);
    },
    updateFeatures,
  };
}

export function showFatal(title, message) {
  const el = document.getElementById('fatal');
  document.getElementById('fatalTitle').textContent = title;
  document.getElementById('fatalMsg').textContent = message;
  el.classList.remove('hidden');
  const boot = document.getElementById('boot');
  if (boot) boot.classList.add('hidden');
}
