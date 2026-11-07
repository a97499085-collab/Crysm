// ============================================================================
//  CRYSM · HDR bloom chain (bright pass + progressive downsample)
//  HDR input is rgba32float, bloom mips are rgba16float (filterable, cheap).
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
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var dstTex: texture_storage_2d<rgba16float, write>;

fn brightPass(c: vec3f, threshold: f32) -> vec3f {
  let knee = threshold * 0.6 + 1e-4;
  let hard = max(c - vec3f(threshold), vec3f(0.0));
  let soft = clamp(c - vec3f(threshold - knee), vec3f(0.0), vec3f(2.0 * knee));
  let soft2 = soft * soft / vec3f(4.0 * knee + 1e-4);
  return max(hard, soft2);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(dstTex);
  let px = gid.xy;
  if (px.x >= dims.x || px.y >= dims.y) { return; }

  let sdim = textureDimensions(srcTex);
  let hi = sdim - vec2u(1u);
  let base = px * 2u;

  var c = vec3f(0.0);
  c += textureLoad(srcTex, min(base, hi), 0).rgb;
  c += textureLoad(srcTex, min(base + vec2u(1u, 0u), hi), 0).rgb;
  c += textureLoad(srcTex, min(base + vec2u(0u, 1u), hi), 0).rgb;
  c += textureLoad(srcTex, min(base + vec2u(1u, 1u), hi), 0).rgb;
  c *= 0.25;

  // level 0 reads the full-res HDR buffer -> apply bright pass
  let halfRes = vec2u((U.res.xy + vec2f(1.0)) * 0.5);
  if (all(dims == halfRes)) {
    c = brightPass(c, U.post.z);
  }

  textureStore(dstTex, px, vec4f(c, 1.0));
}
