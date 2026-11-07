// ============================================================================
//  CRYSM · WebGPU Path Tracer
//  Physically based, unbiased Monte-Carlo path tracing:
//    · GGX metallic-roughness PBR  · smooth dielectric glass
//    · next-event estimation (sun cone) => soft dynamic shadows
//    · multi-bounce global illumination
//    · homogeneous participating media (volumetric fog, HG phase)
//    · stochastic AA (per-frame jitter, accumulated temporally)
// ============================================================================

struct Uniforms {
  camPos: vec4f,        // xyz pos            | w tanHalfFovY
  camRight: vec4f,      // xyz right          | w aspect
  camUp: vec4f,         // xyz up             | w jitterX (px)
  camFwd: vec4f,        // xyz forward        | w jitterY (px)
  sunDir: vec4f,        // xyz dir to sun     | w angular radius (rad)
  sunColor: vec4f,      // rgb = tint*irradiance | w intensity
  skyZenith: vec4f,     // rgb                | w exposure
  skyHorizon: vec4f,    // rgb                | w bloom intensity
  fog: vec4f,           // sigmaT, sigmaS, anisotropy, enabled
  renderOpt: vec4f,     // maxBounces, aoMode, sunEnabled, taaAlpha
  res: vec4f,           // w, h, 1/w, 1/h
  canvas: vec4f,
  post: vec4f,          // vignette, grain, bloomThreshold, unused
  misc: vec4f,          // sampleIndex, frameIndex, time, unused
  prevViewProj: mat4x4f,
  lightCenter: vec4f,   // xyz center | w area
  lightRight: vec4f,    // xyz half width vector | w enabled
  lightUp: vec4f,       // xyz half depth vector
  lightNormal: vec4f,   // xyz normal
  lightColor: vec4f,    // rgb emitted radiance
};

struct BvhNode {
  bmin: vec3f,
  left: u32,
  bmax: vec3f,
  count: u32,
};

struct Material {
  albedo: vec3f,
  roughness: f32,
  emission: vec3f,
  metallic: f32,
  params: vec4f,        // x ior, y transmission, z/w reserved
};

struct Hit {
  t: f32,
  tri: u32,
  u: f32,
  v: f32,
  p: vec3f,
  n: vec3f,
  front: bool,
};

struct Ray {
  o: vec3f,
  d: vec3f,
};

struct BsdfSample {
  wi: vec3f,
  weight: vec3f,
  pdf: f32,
  specular: bool,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> positions: array<vec3f>;
@group(0) @binding(2) var<storage, read> normals: array<vec3f>;
@group(0) @binding(3) var<storage, read> triMat: array<u32>;
@group(0) @binding(4) var<storage, read> bvh: array<BvhNode>;
@group(0) @binding(5) var<storage, read> triOrder: array<u32>;
@group(0) @binding(6) var<storage, read> materials: array<Material>;
@group(0) @binding(7) var sampleOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(8) var gbufOut: texture_storage_2d<rgba32float, write>;

const PI: f32 = 3.14159265359;
const INF: f32 = 1e30;
const EPS: f32 = 5e-4;

// ---------------------------------------------------------------------------
//  RNG (PCG hash, per pixel / per frame)
// ---------------------------------------------------------------------------
var<private> rngState: u32;

fn pcgHash(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn seedRng(s: u32) {
  rngState = pcgHash(s ^ 0x9e3779b9u);
}

fn rnd() -> f32 {
  rngState = rngState * 747796405u + 2891336453u;
  var w = rngState;
  w = ((w >> ((w >> 28u) + 4u)) ^ w) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) * 2.3283064365386963e-10;
}

fn rnd2() -> vec2f {
  return vec2f(rnd(), rnd());
}

// ---------------------------------------------------------------------------
//  Math helpers
// ---------------------------------------------------------------------------
fn buildBasis(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  return mat3x3f(
    vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x),
    vec3f(s * b, s + n.y * n.y * a, -n.y),
    n
  );
}

fn sampleCosine(n: vec3f) -> vec3f {
  let u = rnd2();
  let r = sqrt(u.x);
  let phi = 2.0 * PI * u.y;
  let local = vec3f(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u.x)));
  return normalize(buildBasis(n) * local);
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// ---------------------------------------------------------------------------
//  BVH
// ---------------------------------------------------------------------------
fn boxHit(node: BvhNode, ro: vec3f, inv: vec3f, tmax: f32) -> f32 {
  let t0 = (node.bmin - ro) * inv;
  let t1 = (node.bmax - ro) * inv;
  let lo = min(t0, t1);
  let hi = max(t0, t1);
  let tnear = max(max(lo.x, lo.y), max(lo.z, 0.0));
  let tfar = min(min(hi.x, hi.y), min(hi.z, tmax));
  return select(INF, tnear, tfar >= tnear);
}

fn triHit(tri: u32, ro: vec3f, rd: vec3f, tmax: f32) -> vec3f {
  let i0 = tri * 3u;
  let p0 = positions[i0];
  let p1 = positions[i0 + 1u];
  let p2 = positions[i0 + 2u];
  let e1 = p1 - p0;
  let e2 = p2 - p0;
  let pv = cross(rd, e2);
  let det = dot(e1, pv);
  if (abs(det) < 1e-9) { return vec3f(INF, 0.0, 0.0); }
  let invDet = 1.0 / det;
  let tv = ro - p0;
  let u = dot(tv, pv) * invDet;
  if (u < 0.0 || u > 1.0) { return vec3f(INF, 0.0, 0.0); }
  let qv = cross(tv, e1);
  let v = dot(rd, qv) * invDet;
  if (v < 0.0 || u + v > 1.0) { return vec3f(INF, 0.0, 0.0); }
  let t = dot(e2, qv) * invDet;
  if (t < EPS || t > tmax) { return vec3f(INF, 0.0, 0.0); }
  return vec3f(t, u, v);
}

fn traceScene(ro: vec3f, rd: vec3f, tmaxIn: f32) -> Hit {
  var best = tmaxIn;
  var tri = 0xffffffffu;
  var bu = 0.0;
  var bv = 0.0;

  var stack: array<u32, 48>;
  var sp = 1u;
  stack[0] = 0u;

  let inv = vec3f(
    select(1.0 / rd.x, 1e30, abs(rd.x) < 1e-9),
    select(1.0 / rd.y, 1e30, abs(rd.y) < 1e-9),
    select(1.0 / rd.z, 1e30, abs(rd.z) < 1e-9)
  );

  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let node = bvh[stack[sp]];
    if (node.count > 0u) {
      for (var i = 0u; i < node.count; i = i + 1u) {
        let ti = triOrder[node.left + i];
        let r = triHit(ti, ro, rd, best);
        if (r.x < best) {
          best = r.x;
          tri = ti;
          bu = r.y;
          bv = r.z;
        }
      }
    } else {
      let c0 = node.left;
      let c1 = node.left + 1u;
      let d0 = boxHit(bvh[c0], ro, inv, best);
      let d1 = boxHit(bvh[c1], ro, inv, best);
      let hit0 = d0 < INF;
      let hit1 = d1 < INF;
      if (d0 < d1) {
        if (hit1 && sp < 48u) { stack[sp] = c1; sp = sp + 1u; }
        if (hit0 && sp < 48u) { stack[sp] = c0; sp = sp + 1u; }
      } else {
        if (hit0 && sp < 48u) { stack[sp] = c0; sp = sp + 1u; }
        if (hit1 && sp < 48u) { stack[sp] = c1; sp = sp + 1u; }
      }
    }
  }

  var h: Hit;
  h.t = best;
  h.tri = tri;
  h.u = bu;
  h.v = bv;
  h.p = ro + rd * min(best, 1000.0);
  h.n = vec3f(0.0, 1.0, 0.0);
  h.front = true;

  if (tri != 0xffffffffu) {
    let i0 = tri * 3u;
    let n0 = normals[i0];
    let n1 = normals[i0 + 1u];
    let n2 = normals[i0 + 2u];
    let nn = normalize(n0 * (1.0 - bu - bv) + n1 * bu + n2 * bv);
    h.n = nn;
    let geo = cross(positions[i0 + 1u] - positions[i0], positions[i0 + 2u] - positions[i0]);
    h.front = dot(geo, rd) < 0.0;
  }
  return h;
}

// Any-hit traversal: shadow rays only need to know IF something blocks them,
// so we exit on the first intersection instead of searching for the closest
// one. Same result, significantly cheaper (no closest-hit bookkeeping).
fn anyHit(ro: vec3f, rd: vec3f, tmax: f32) -> bool {
  var stack: array<u32, 48>;
  var sp = 1u;
  stack[0] = 0u;

  let inv = vec3f(
    select(1.0 / rd.x, 1e30, abs(rd.x) < 1e-9),
    select(1.0 / rd.y, 1e30, abs(rd.y) < 1e-9),
    select(1.0 / rd.z, 1e30, abs(rd.z) < 1e-9)
  );

  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let node = bvh[stack[sp]];
    if (node.count > 0u) {
      for (var i = 0u; i < node.count; i = i + 1u) {
        let ti = triOrder[node.left + i];
        if (triHit(ti, ro, rd, tmax).x < tmax) { return true; }
      }
    } else {
      let c0 = node.left;
      let c1 = node.left + 1u;
      if (boxHit(bvh[c0], ro, inv, tmax) < INF && sp < 48u) {
        stack[sp] = c0;
        sp = sp + 1u;
      }
      if (boxHit(bvh[c1], ro, inv, tmax) < INF && sp < 48u) {
        stack[sp] = c1;
        sp = sp + 1u;
      }
    }
  }
  return false;
}

fn occluded(ro: vec3f, rd: vec3f, tmax: f32) -> bool {
  return anyHit(ro, rd, tmax);
}

// ---------------------------------------------------------------------------
//  PBR / BRDF  (GGX + Lambert, metallic-roughness)
// ---------------------------------------------------------------------------
fn D_GGX(NoH: f32, a2: f32) -> f32 {
  let d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn G_Smith(NoV: f32, NoL: f32, a: f32) -> f32 {
  let k = a * 0.5;
  let gv = NoV / (NoV * (1.0 - k) + k);
  let gl = NoL / (NoL * (1.0 - k) + k);
  return gv * gl;
}

fn F_Schlick(f0: vec3f, cosT: f32) -> vec3f {
  let f = pow(1.0 - clamp(cosT, 0.0, 1.0), 5.0);
  return f0 + (vec3f(1.0) - f0) * f;
}

fn evalOpaque(m: Material, n: vec3f, wo: vec3f, wi: vec3f) -> vec3f {
  let NoL = dot(n, wi);
  if (NoL <= 0.0) { return vec3f(0.0); }
  let NoV = max(dot(n, wo), 1e-4);
  let h = normalize(wo + wi);
  let NoH = max(dot(n, h), 0.0);
  let VoH = max(dot(wo, h), 0.0);
  let rough = max(m.roughness, 0.02);
  let a2 = rough * rough * rough * rough;
  let D = D_GGX(NoH, a2);
  let G = G_Smith(NoV, NoL, rough * rough);
  let f0 = mix(vec3f(0.04), m.albedo, m.metallic);
  let F = F_Schlick(f0, VoH);
  let spec = D * G * F / max(4.0 * NoV * NoL, 1e-6);
  let kd = (vec3f(1.0) - F) * (1.0 - m.metallic);
  return kd * m.albedo * (1.0 / PI) + spec;
}

fn ggxPdf(n: vec3f, wo: vec3f, wi: vec3f, rough: f32) -> f32 {
  let h = normalize(wo + wi);
  let NoH = max(dot(n, h), 0.0);
  let VoH = max(dot(wo, h), 1e-4);
  let a2 = max(rough * rough * rough * rough, 1e-6);
  return D_GGX(NoH, a2) * NoH / (4.0 * VoH);
}

fn sampleGGX(n: vec3f, wo: vec3f, rough: f32) -> vec3f {
  let a = max(rough * rough, 1e-3);
  let u = rnd2();
  let phi = 2.0 * PI * u.x;
  let cosTheta = sqrt((1.0 - u.y) / (1.0 + (a * a - 1.0) * u.y));
  let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  let hl = vec3f(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
  let h = normalize(buildBasis(n) * hl);
  return reflect(-wo, h);
}

fn sampleOpaque(m: Material, n: vec3f, wo: vec3f) -> BsdfSample {
  var s: BsdfSample;
  let specChance = mix(0.5, 1.0, m.metallic);
  if (rnd() < specChance) {
    let wi = sampleGGX(n, wo, m.roughness);
    let NoL = dot(n, wi);
    if (NoL <= 0.0) {
      s.wi = sampleCosine(n);
      s.weight = vec3f(0.0);
      s.pdf = 1.0;
      s.specular = false;
      return s;
    }
    let pdf = ggxPdf(n, wo, wi, m.roughness) * specChance;
    s.wi = wi;
    s.pdf = pdf;
    // only near-mirror lobes may "see" the solar disk directly; rough lobes
    // rely on next-event estimation (prevents caustic-style fireflies)
    s.specular = m.roughness < 0.1;
    s.weight = evalOpaque(m, n, wo, wi) * NoL / max(pdf, 1e-6);
    return s;
  }
  let wi = sampleCosine(n);
  let NoL = max(dot(n, wi), 1e-4);
  let pdf = NoL / PI * (1.0 - specChance);
  s.wi = wi;
  s.pdf = pdf;
  s.specular = false;
  s.weight = evalOpaque(m, n, wo, wi) * NoL / max(pdf, 1e-6);
  return s;
}

fn fresnelDielectric(cosI: f32, eta: f32) -> f32 {
  // eta = n1 / n2
  let sin2T = eta * eta * (1.0 - cosI * cosI);
  if (sin2T >= 1.0) { return 1.0; }
  let cosT = sqrt(1.0 - sin2T);
  let rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  let rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

fn refractDir(i: vec3f, n: vec3f, eta: f32) -> vec3f {
  let cosI = -dot(n, i);
  let sin2T = eta * eta * (1.0 - cosI * cosI);
  if (sin2T > 1.0) { return reflect(i, n); }
  let cosT = sqrt(1.0 - sin2T);
  return normalize(eta * i + (eta * cosI - cosT) * n);
}

fn sampleGlass(m: Material, n: vec3f, wo: vec3f, rd: vec3f, entering: bool) -> BsdfSample {
  var s: BsdfSample;
  let ior = max(m.params.x, 1.01);
  let eta = select(ior, 1.0 / ior, entering);
  let cosI = max(dot(n, wo), 0.0);
  let F = fresnelDielectric(cosI, eta);
  if (rnd() < F) {
    s.wi = reflect(rd, n);
    s.weight = vec3f(1.0);
  } else {
    s.wi = refractDir(rd, n, eta);
    s.weight = mix(vec3f(1.0), m.albedo, m.params.y);
  }
  s.pdf = 1.0;
  s.specular = true;
  return s;
}

// ---------------------------------------------------------------------------
//  Lighting
// ---------------------------------------------------------------------------
fn skyRadiance(d: vec3f) -> vec3f {
  if (U.renderOpt.y > 0.5) { return vec3f(0.9); }
  let t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  let g = pow(t, 0.9);
  var c = mix(U.skyHorizon.rgb, U.skyZenith.rgb, g);
  // ground bounce haze
  c = mix(c, U.skyHorizon.rgb * 0.55, smoothstep(0.0, -0.25, d.y));
  return c;
}

// Visible solar disk — only added on specular paths, next-event estimation
// handles the diffuse contribution (cheap one-sample MIS).
fn sunDisk(d: vec3f) -> vec3f {
  if (U.renderOpt.z < 0.5) { return vec3f(0.0); }
  let r = clamp(U.sunDir.w, 0.0004, 1.2);
  let cosA = dot(d, normalize(U.sunDir.xyz));
  let edge = smoothstep(cos(r * 1.18), cos(r * 0.82), cosA);
  if (edge <= 0.0) { return vec3f(0.0); }
  let omega = 6.2831853 * (1.0 - cos(r));
  return U.sunColor.rgb * edge / max(omega, 1e-5);
}

fn sampleSunDir() -> vec3f {
  let cosMax = cos(clamp(U.sunDir.w, 1e-4, 1.55));
  let u = rnd2();
  let ct = 1.0 - u.x * (1.0 - cosMax);
  let st = sqrt(max(0.0, 1.0 - ct * ct));
  let phi = 2.0 * PI * u.y;
  let local = vec3f(st * cos(phi), st * sin(phi), ct);
  return normalize(buildBasis(normalize(U.sunDir.xyz)) * local);
}

// Next event estimation against the sun cone. sunColor stores irradiance,
// so the cone solid angle cancels out in the estimator (stable soft shadows).
fn sunDirect(h: Hit, m: Material, n: vec3f, wo: vec3f) -> vec3f {
  if (U.renderOpt.z < 0.5) { return vec3f(0.0); }
  let L = sampleSunDir();
  let NoL = dot(n, L);
  if (NoL <= 0.0) { return vec3f(0.0); }
  let f = evalOpaque(m, n, wo, L);
  if (luminance(f) <= 1e-6) { return vec3f(0.0); }
  if (occluded(h.p + n * 0.0015, L, INF)) { return vec3f(0.0); }
  return U.sunColor.rgb * f * NoL;
}

fn hgPhase(cosT: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = pow(max(1.0 + g2 - 2.0 * g * cosT, 1e-4), 1.5);
  return (1.0 - g2) / (4.0 * PI * denom);
}

// Next event estimation against a rectangular emitter (the light bar).
fn areaLightDirect(h: Hit, m: Material, n: vec3f, wo: vec3f) -> vec3f {
  if (U.lightRight.w < 0.5 || U.renderOpt.z < 0.5) { return vec3f(0.0); }
  let u = rnd2();
  let p = U.lightCenter.xyz
    + U.lightRight.xyz * (u.x * 2.0 - 1.0)
    + U.lightUp.xyz * (u.y * 2.0 - 1.0);
  let toL = p - h.p;
  let dist2 = dot(toL, toL);
  if (dist2 <= 1e-6) { return vec3f(0.0); }
  let dist = sqrt(dist2);
  let wi = toL / dist;
  let cosS = dot(n, wi);
  if (cosS <= 0.0) { return vec3f(0.0); }
  let cosL = abs(dot(normalize(U.lightNormal.xyz), wi));
  if (cosL < 1e-4) { return vec3f(0.0); }
  let f = evalOpaque(m, n, wo, wi);
  if (luminance(f) <= 1e-6) { return vec3f(0.0); }
  let area = max(U.lightCenter.w, 1e-4);
  let pdf = dist2 / (cosL * area);
  if (occluded(h.p + n * 0.0015, wi, dist - 0.02)) { return vec3f(0.0); }
  return U.lightColor.rgb * f * cosS / max(pdf, 1e-6);
}

// Single scattering estimator for a homogeneous medium.
fn fogContribution(ro: vec3f, rd: vec3f, tmax: f32) -> vec3f {
  let sigmaT = U.fog.x;
  let sigmaS = U.fog.y;
  let g = clamp(U.fog.z, -0.95, 0.95);
  if (sigmaT <= 1e-5) { return vec3f(0.0); }

  let tm = min(tmax, 120.0);
  let P = 1.0 - exp(-sigmaT * tm);
  if (P <= 1e-5) { return vec3f(0.0); }

  let u = rnd();
  let t = -log(max(1e-6, 1.0 - u * P)) / sigmaT;
  let p = ro + rd * t;

  var lit = vec3f(0.0);
  if (U.renderOpt.z > 0.5) {
    let L = normalize(U.sunDir.xyz);
    if (!occluded(p, L, INF)) {
      lit += U.sunColor.rgb * hgPhase(dot(rd, L), g);
    }
  }
  // ambient sky in-scatter
  lit += skyRadiance(vec3f(0.0, 1.0, 0.0)) * 0.22;
  return lit * (sigmaS / sigmaT) * P;
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec2u(vec2f(U.res.xy));
  let px = gid.xy;
  if (px.x >= dims.x || px.y >= dims.y) { return; }

  seedRng(px.x * 1973u + px.y * 9277u + u32(U.misc.y) * 26699u + u32(U.renderOpt.y) * 7919u);

  // --- camera ray with sub-pixel jitter (temporal AA) ----------------------
  let jitter = vec2f(U.camUp.w, U.camFwd.w);
  let uv = (vec2f(px) + 0.5 + jitter) / U.res.xy;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let tanHalf = U.camPos.w;
  let aspect = U.camRight.w;
  var ray: Ray;
  ray.o = U.camPos.xyz;
  ray.d = normalize(
    U.camFwd.xyz +
    U.camRight.xyz * (ndc.x * tanHalf * aspect) +
    U.camUp.xyz * (ndc.y * tanHalf)
  );

  var radiance = vec3f(0.0);
  var throughput = vec3f(1.0);
  var lastSpecular = true;

  let maxBounces = u32(max(U.renderOpt.x, 1.0));
  let fogOn = U.fog.w > 0.5;
  let aoMode = U.renderOpt.y > 0.5;

  let primaryO = ray.o;
  let primaryD = ray.d;
  var primaryT = INF;
  var primaryWorld = ray.o;
  var primaryHit = false;

  for (var bounce = 0u; bounce <= maxBounces; bounce = bounce + 1u) {
    let h = traceScene(ray.o, ray.d, INF);
    var segT = h.t;
    if (h.tri == 0xffffffffu) { segT = 60.0; }

    // ---- participating media ---------------------------------------------
    if (fogOn && !aoMode && bounce < 2u) {
      let inScatter = fogContribution(ray.o, ray.d, segT);
      radiance += throughput * inScatter;
      throughput *= exp(-U.fog.x * segT);
    }

    if (h.tri == 0xffffffffu) {
      var sky = skyRadiance(ray.d);
      if (lastSpecular) { sky += sunDisk(ray.d); }
      radiance += throughput * sky;
      break;
    }

    if (bounce == 0u) {
      primaryT = h.t;
      primaryWorld = h.p;
      primaryHit = true;
    }

    let m = materials[triMat[h.tri]];
    let geoN = normalize(h.n);
    let n = select(-geoN, geoN, dot(geoN, ray.d) < 0.0);
    let wo = -ray.d;

    // ---- emission ---------------------------------------------------------
    // Emitters are sampled explicitly (NEE); their radiance is only added on
    // primary/specular paths so we don't double count or create fireflies.
    if (lastSpecular) {
      radiance += throughput * m.emission;
    }

    // ---- smooth dielectric glass -----------------------------------------
    if (m.params.y > 0.01) {
      if (bounce == maxBounces) { break; }
      let s = sampleGlass(m, n, wo, ray.d, h.front);
      throughput *= s.weight;
      ray.o = h.p + n * EPS * select(-1.0, 1.0, dot(s.wi, n) > 0.0);
      ray.d = normalize(s.wi);
      lastSpecular = true;
      continue;
    }

    // ---- next event estimation (sun + light bar) --------------------------
    radiance += throughput * sunDirect(h, m, n, wo);
    if (luminance(m.emission) < 1e-4) {
      radiance += throughput * areaLightDirect(h, m, n, wo);
    }

    // ---- indirect: sample the BRDF ---------------------------------------
    if (bounce == maxBounces) { break; }
    let s = sampleOpaque(m, n, wo);
    if (luminance(s.weight) <= 1e-6) { break; }
    throughput *= s.weight;
    lastSpecular = s.specular;

    // Russian roulette
    if (bounce >= 3u) {
      let p = clamp(max(s.weight.r, max(s.weight.g, s.weight.b)), 0.02, 1.0);
      if (rnd() > p) { break; }
      throughput /= p;
    }

    ray.o = h.p + n * 0.0015;
    ray.d = normalize(s.wi);

    // guard against fireflies from ultra-sharp caustics
    throughput = min(throughput, vec3f(24.0));
  }

  // slight firefly suppression, keeps HDR range but tames outliers
  radiance = min(radiance, vec3f(48.0));

  textureStore(sampleOut, px, vec4f(radiance, primaryT));
  textureStore(
    gbufOut, px,
    select(vec4f(0.0), vec4f(primaryWorld, 1.0), primaryHit)
  );
}
