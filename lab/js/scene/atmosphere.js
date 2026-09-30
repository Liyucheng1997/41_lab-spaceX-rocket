// 大气散射（单次散射 Rayleigh + Mie + 臭氧吸收，含地影），天空穹顶与地球共用
// 所有着色器计算使用 km，相对地心。
import * as THREE from 'three';

export const ATMO_GLSL = /* glsl */`
#ifndef PI
#define PI 3.14159265
#endif
uniform vec3 uSunDir;
uniform vec3 uCamKm;
uniform float uSunE;
const float RE = 6371.0;
const float RA = 6471.0;
const vec3 BR = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float BM = 3.996e-3;
const float BME = 4.44e-3;
const vec3 BO = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const float HR = 8.0;
const float HM = 1.2;
const float GM = 0.8;

vec2 rsi(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d); return vec2(-b - d, -b + d);
}
vec3 dens(float h) { return vec3(exp(-h / HR), exp(-h / HM), max(0.0, 1.0 - abs(h - 25.0) / 15.0)); }
vec3 ext(vec3 d) { return BR * d.x + BME * d.y + BO * d.z; }

vec3 sunTrans(vec3 p) {
  vec2 te = rsi(p, uSunDir, RE - 0.5);
  if (te.x > 0.0) return vec3(0.0);
  float tl = rsi(p, uSunDir, RA).y;
  float ds = tl / 5.0; vec3 od = vec3(0.0);
  for (int i = 0; i < 5; i++) { vec3 q = p + uSunDir * (ds * (float(i) + 0.5)); od += ext(dens(max(length(q) - RE, 0.0))) * ds; }
  return exp(-od);
}

vec3 scatter(vec3 ro, vec3 rd, float tMax, out vec3 trans) {
  vec2 ta = rsi(ro, rd, RA);
  float t0 = max(ta.x, 0.0), t1 = min(ta.y, tMax);
  trans = vec3(1.0);
  if (t1 <= t0) return vec3(0.0);
  const int N = 14;
  float mu = dot(rd, uSunDir);
  float pr = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g2 = GM * GM;
  float pm = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * GM * mu, 1.5));
  vec3 sR = vec3(0.0), sM = vec3(0.0), od = vec3(0.0);
  float tPrev = t0;
  for (int i = 0; i < N; i++) {
    float f = (float(i) + 1.0) / float(N);
    float t = t0 + (t1 - t0) * f * f;            // 近密远疏采样
    float ds = t - tPrev; float tm = 0.5 * (t + tPrev); tPrev = t;
    vec3 p = ro + rd * tm;
    vec3 d = dens(max(length(p) - RE, 0.0));
    od += ext(d) * ds;
    vec3 T = exp(-od) * sunTrans(p);
    sR += T * d.x * ds; sM += T * d.y * ds;
  }
  trans = exp(-od);
  // 1.9：近似补偿多次散射
  return uSunE * (sR * BR * pr * 1.9 + sM * BM * pm + sR * BR * 0.018);
}
`;

// ---------------------------------------------------------------------------
export function createSky() {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uCamKm: { value: new THREE.Vector3(0, 6371.01, 0) },
    uSunE: { value: 3.0 },
    uEarthCenter: { value: new THREE.Vector3(0, -6371000, 0) },
    uStars: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform float uStars;
      ${ATMO_GLSL}
      #include <logdepthbuf_pars_fragment>
      float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 rd = normalize(vDir);
        vec3 ro = uCamKm;
        vec2 tp = rsi(ro, rd, RE);
        float tMax = tp.x > 0.0 ? tp.x : 1e9;
        vec3 tr;
        vec3 col = scatter(ro, rd, tMax, tr);
        // 晨昏多次散射近似：太阳在地平线下时，高层大气散射的蓝光与朝阳方向的暖色辉光
        float muC = dot(normalize(ro), uSunDir);
        float tw = smoothstep(-0.22, 0.02, muC) * (1.0 - smoothstep(0.05, 0.25, muC));
        float opt = 1.0 - tr.b;
        float towardSun = pow(max(dot(normalize(rd - normalize(ro) * dot(rd, normalize(ro))), normalize(uSunDir - normalize(ro) * muC)), 0.0), 3.0);
        float horizon = exp(-max(dot(rd, normalize(ro)), 0.0) * 9.0);
        col += uSunE * tw * (vec3(0.16, 0.3, 0.75) * 0.006 * opt + vec3(1.0, 0.45, 0.18) * 0.012 * towardSun * horizon * opt);
        // 太阳圆盘
        float mu = dot(rd, uSunDir);
        if (tp.x < 0.0) {
          float sd = smoothstep(0.99996, 0.999985, mu);
          col += sd * tr * sunTrans(ro) * uSunE * 2600.0;
          col += pow(max(mu, 0.0), 900.0) * tr * uSunE * 6.0;
          // 星空（大气透明时可见）
          vec3 sp = rd * 420.0; vec3 cell = floor(sp);
          float s = hash3(cell);
          if (s > 0.9965) {
            vec3 c = cell + 0.5 + (vec3(hash3(cell + 1.3), hash3(cell + 2.1), hash3(cell + 3.7)) - 0.5) * 0.6;
            float d = length(sp - c);
            float b = smoothstep(0.32, 0.0, d) * (s - 0.9965) / 0.0035;
            col += vec3(0.9, 0.95, 1.0) * b * 0.9 * uStars * tr;
          }
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat);
  mesh.scale.setScalar(4e7);
  mesh.frustumCulled = false; mesh.renderOrder = -10;
  mesh.onBeforeRender = (r, s, cam) => { mesh.position.copy(cam.position); mesh.updateMatrixWorld(); };
  return { mesh, uniforms, material: mat };
}

// CPU 近似：给定视线方向，估算地平线附近天空颜色（用于雾色与环境光）
export function horizonColor(sunDir, altKm, out = new THREE.Color()) {
  const e = Math.max(-0.2, sunDir.y);
  const day = THREE.MathUtils.smoothstep(e, -0.12, 0.25);
  const warm = THREE.MathUtils.smoothstep(e, -0.1, 0.05) * (1 - THREE.MathUtils.smoothstep(e, 0.05, 0.35));
  const hz = new THREE.Color(0.62, 0.72, 0.86).lerp(new THREE.Color(0.95, 0.62, 0.38), warm * 0.8);
  const thin = Math.exp(-altKm / 9);
  out.copy(hz).multiplyScalar(day * (0.55 + 0.45 * thin));
  out.lerp(new THREE.Color(0.02, 0.03, 0.06), 1 - day);
  return out;
}
