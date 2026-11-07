// ============================================================================
//  CRYSM · HDR composite / tonemap
//  HDR (32-bit float) -> bloom -> exposure -> ACES -> sRGB -> grain/dither
// ============================================================================

struct Uniforms {
  camPos: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  camFwd: vec4f,
  sunDir: vec4f,
  sunColor: vec4f,
  skyZenith: vec4f,
  skyHorizon: vec4f,
  fog: vec4f,
  renderOpt: vec4f,
  res: vec4f,
  canvas: vec4f,
  post: vec4f,
  misc: vec4f,
  prevViewProj: mat4x4f,
  lightCenter: vec4f,
  lightRight: vec4f,
  lightUp: vec4f,
  lightNormal: vec4f,
  lightColor: vec4f,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var bloom0: texture_2d<f32>;
@group(0) @binding(3) var bloom1: texture_2d<f32>;
@group(0) @binding(4) var bloom2: texture_2d<f32>;
@group(0) @binding(5) var bloom3: texture_2d<f32>;
@group(0) @binding(6) var bloom4: texture_2d<f32>;

const PI: f32 = 3.14159265359;

fn clampI(p: vec2i, hi: vec2i) -> vec2i {
  return min(max(p, vec2i(0)), hi);
}

fn sampleBilinear(t: texture_2d<f32>, uv: vec2f) -> vec3f {
  let dimsU = textureDimensions(t);
  let dims = vec2f(dimsU);
  let hi = vec2i(dimsU) - vec2i(1);
  let p = uv * dims - vec2f(0.5);
  let base = vec2i(floor(p));
  let f = fract(p);
  let c00 = textureLoad(t, clampI(base, hi), 0).rgb;
  let c10 = textureLoad(t, clampI(base + vec2i(1, 0), hi), 0).rgb;
  let c01 = textureLoad(t, clampI(base + vec2i(0, 1), hi), 0).rgb;
  let c11 = textureLoad(t, clampI(base + vec2i(1, 1), hi), 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

// Lanczos-2 reconstruction weights (sharper than Catmull-Rom, mild ringing)
fn sinc(x: f32) -> f32 {
  let px = PI * x;
  return select(1.0, sin(px) / px, abs(x) > 1e-5);
}

fn reconWeights(t: f32) -> vec4f {
  let w = vec4f(sinc(1.0 + t), sinc(t), sinc(1.0 - t), sinc(2.0 - t));
  let s = w.x + w.y + w.z + w.w;
  return w / max(s, 1e-5);
}

fn sampleReconstructed(t: texture_2d<f32>, uv: vec2f) -> vec3f {
  let dimsU = textureDimensions(t);
  let dims = vec2f(dimsU);
  let hi = vec2i(dimsU) - vec2i(1);
  let p = uv * dims - vec2f(0.5);
  let base = vec2i(floor(p));
  let f = fract(p);
  let wx = reconWeights(f.x);
  let wy = reconWeights(f.y);

  let r0 =
    textureLoad(t, clampI(base + vec2i(-1, -1), hi), 0).rgb * wx.x +
    textureLoad(t, clampI(base + vec2i(0, -1), hi), 0).rgb * wx.y +
    textureLoad(t, clampI(base + vec2i(1, -1), hi), 0).rgb * wx.z +
    textureLoad(t, clampI(base + vec2i(2, -1), hi), 0).rgb * wx.w;
  let r1 =
    textureLoad(t, clampI(base + vec2i(-1, 0), hi), 0).rgb * wx.x +
    textureLoad(t, clampI(base + vec2i(0, 0), hi), 0).rgb * wx.y +
    textureLoad(t, clampI(base + vec2i(1, 0), hi), 0).rgb * wx.z +
    textureLoad(t, clampI(base + vec2i(2, 0), hi), 0).rgb * wx.w;
  let r2 =
    textureLoad(t, clampI(base + vec2i(-1, 1), hi), 0).rgb * wx.x +
    textureLoad(t, clampI(base + vec2i(0, 1), hi), 0).rgb * wx.y +
    textureLoad(t, clampI(base + vec2i(1, 1), hi), 0).rgb * wx.z +
    textureLoad(t, clampI(base + vec2i(2, 1), hi), 0).rgb * wx.w;
  let r3 =
    textureLoad(t, clampI(base + vec2i(-1, 2), hi), 0).rgb * wx.x +
    textureLoad(t, clampI(base + vec2i(0, 2), hi), 0).rgb * wx.y +
    textureLoad(t, clampI(base + vec2i(1, 2), hi), 0).rgb * wx.z +
    textureLoad(t, clampI(base + vec2i(2, 2), hi), 0).rgb * wx.w;

  return max(r0 * wy.x + r1 * wy.y + r2 * wy.z + r3 * wy.w, vec3f(0.0));
}

// HD upscale: Lanczos reconstruction + contrast-adaptive unsharp mask
// (CAS-like). The internal path-traced image stays cheap/low-res, the final
// display frame is crisp, while the film grain is applied afterwards and is
// therefore unaffected.
fn sharpenUpscaled(t: texture_2d<f32>, uv: vec2f, center: vec3f, amount: f32) -> vec3f {
  if (amount <= 0.001) { return center; }
  let dimsU = textureDimensions(t);
  let hi = vec2i(dimsU) - vec2i(1);
  let p = vec2i(floor(uv * vec2f(dimsU) - vec2f(0.5)));
  let l = textureLoad(t, clampI(p + vec2i(-1, 0), hi), 0).rgb;
  let r = textureLoad(t, clampI(p + vec2i(1, 0), hi), 0).rgb;
  let u = textureLoad(t, clampI(p + vec2i(0, -1), hi), 0).rgb;
  let d = textureLoad(t, clampI(p + vec2i(0, 1), hi), 0).rgb;
  let blur = (l + r + u + d) * 0.25;
  // soft clamp tames halos on bright edges while keeping fine detail
  let delta = clamp(center - blur, vec3f(-2.0), vec3f(2.0));
  return max(center + delta * amount, vec3f(0.0));
}

fn aces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + vec3f(b))) / (x * (c * x + vec3f(d)) + vec3f(e)), vec3f(0.0), vec3f(1.0));
}

fn linearToSRGB(cIn: vec3f) -> vec3f {
  let c = max(cIn, vec3f(0.0));
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash2(p: vec2f) -> f32 {
  var h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var verts = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  return vec4f(verts[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / U.canvas.xy;
  // smooth HD reconstruction from the internal render resolution
  var color = sampleReconstructed(hdrTex, uv);
  color = sharpenUpscaled(hdrTex, uv, color, U.post.w);

  var bloom = vec3f(0.0);
  bloom += sampleBilinear(bloom0, uv) * 0.60;
  bloom += sampleBilinear(bloom1, uv) * 0.45;
  bloom += sampleBilinear(bloom2, uv) * 0.32;
  bloom += sampleBilinear(bloom3, uv) * 0.22;
  bloom += sampleBilinear(bloom4, uv) * 0.14;
  color += bloom * U.skyHorizon.w * 0.35;

  // exposure (HDR -> display)
  color *= U.skyZenith.w;

  // lens vignette
  let d = uv * 2.0 - vec2f(1.0);
  let vig = 1.0 - U.post.x * dot(d, d) * 0.42;
  color *= clamp(vig, 0.0, 1.0);

  color = aces(color);
  color = linearToSRGB(color);

  // fine film grain / dither to break banding
  let n = hash2(frag.xy + vec2f(U.misc.z * 60.0)) - 0.5;
  color += vec3f(n * U.post.y);

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
