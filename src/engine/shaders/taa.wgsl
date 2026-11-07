// ============================================================================
//  CRYSM · Temporal Anti-Aliasing / progressive accumulation resolve
//  History is reprojected through the previous view-projection matrix using
//  the world position G-buffer. Static camera => exact running average.
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
@group(0) @binding(1) var sampleTex: texture_2d<f32>;
@group(0) @binding(2) var gbufTex: texture_2d<f32>;
@group(0) @binding(3) var histTex: texture_2d<f32>;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba32float, write>;

fn clampI(p: vec2i, hi: vec2i) -> vec2i {
  return min(max(p, vec2i(0)), hi);
}

fn sampleBilinearUV(t: texture_2d<f32>, uv: vec2f) -> vec3f {
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

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2u(U.res.xy);
  let px = gid.xy;
  if (px.x >= dims.x || px.y >= dims.y) { return; }

  let cur = textureLoad(sampleTex, px, 0);
  let g = textureLoad(gbufTex, px, 0);
  let alpha = clamp(U.renderOpt.w, 0.0, 1.0);

  var outC = cur.rgb;

  if (alpha < 0.999) {
    var valid = false;
    var histUV = (vec2f(px) + 0.5) / U.res.xy;

    if (g.a > 0.5) {
      let clip = U.prevViewProj * vec4f(g.xyz, 1.0);
      if (clip.w > 1e-4) {
        let ndc = clip.xy / clip.w;
        histUV = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
        valid = histUV.x > 0.0 && histUV.x < 1.0 && histUV.y > 0.0 && histUV.y < 1.0;
      }
    }

    if (valid) {
      var hist = clamp(sampleBilinearUV(histTex, histUV), vec3f(0.0), vec3f(64.0));
      let lc = luma(cur.rgb);
      let lh = luma(hist);
      // reject ghosting: history must stay in a plausible neighbourhood
      if (abs(lc - lh) > 1.6 * (lc + lh) + 0.35) {
        valid = false;
      } else {
        // brightness clamp against the current sample
        let limit = lc * 3.0 + 0.5;
        if (lh > limit) { hist = hist * (limit / max(lh, 1e-5)); }
        outC = mix(hist, cur.rgb, alpha);
      }
    }

    if (!valid) { outC = cur.rgb; }
  }

  textureStore(outTex, px, vec4f(min(outC, vec3f(64.0)), cur.a));
}
