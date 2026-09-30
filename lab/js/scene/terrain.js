// 发射场局部地形（半径 60 km，按地球曲率下沉）：程序化陆地/海岸/沙滩/潟湖 + 动态海浪
// 基于 MeshStandardMaterial 注入着色器，保留实时阴影、雾与环境反射。
import * as THREE from 'three';
import { ATMO_GLSL } from './atmosphere.js';

export const LOCAL_R = 200000;

const NOISE_GLSL = /* glsl */`
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
float fbm2(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
`;

function discGeometry(R, nr = 150, ns = 220) {
  const pos = [], uv = [], idx = [];
  pos.push(0, 0, 0); uv.push(0.5, 0.5);
  for (let i = 1; i <= nr; i++) {
    const r = R * Math.pow(i / nr, 2.2);
    for (let j = 0; j < ns; j++) {
      const a = (j / ns) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
      uv.push(0.5 + (Math.cos(a) * r) / (2 * R), 0.5 + (Math.sin(a) * r) / (2 * R));
    }
  }
  for (let j = 0; j < ns; j++) idx.push(0, 1 + ((j + 1) % ns), 1 + j);
  for (let i = 1; i < nr; i++) for (let j = 0; j < ns; j++) {
    const a = 1 + (i - 1) * ns + j, b = 1 + (i - 1) * ns + ((j + 1) % ns), c = a + ns, d = b + ns;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

/** site: {coastX, lagoon?, style} */
export function createTerrain(site, earthUniforms, patch = null, azimuth = 90) {
  // 海岸法线（指向大海）在场景坐标中的方向：场景 X = 射向方位角，Z = 其右侧
  const ang = ((site.coastHeading ?? 90) - azimuth) * Math.PI / 180;
  const uni = {
    uCoastDir: { value: new THREE.Vector2(Math.cos(ang), Math.sin(ang)) },
    uPatch: { value: patch ? 1 : 0 },
    uPatchR: { value: patch ? patch.radius : 1 },
    uCoastX: { value: site.coastX },
    uStyle: { value: { LC39A: 0, STARBASE: 1, WENCHANG: 2 }[site.id] ?? 0 },
    uTime: { value: 0 },
    uDay: earthUniforms.uDay, uSpec: earthUniforms.uSpec, uL2E: earthUniforms.uL2E,
    uSunDir: earthUniforms.uSunDir, uCamKm: earthUniforms.uCamKm, uSunE: earthUniforms.uSunE,
    uImg0: { value: null }, uImg1: { value: null }, uImg2: { value: null },
    uRect0: { value: new THREE.Vector4() }, uRect1: { value: new THREE.Vector4() }, uRect2: { value: new THREE.Vector4() },
    uImgOn: { value: new THREE.Vector3() },
  };
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
  uni.uImg0.value = uni.uImg1.value = uni.uImg2.value = blank;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 });
  mat.fog = false;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vTW;
varying vec2 vUvP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float rr = dot(transformed.xz, transformed.xz);
        transformed.y -= rr / (2.0 * 6371000.0);
        vUvP = uv;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vTW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTW;
        varying vec2 vUvP;
        uniform float uCoastX, uStyle, uTime, uPatch, uPatchR; uniform vec2 uCoastDir;
        uniform sampler2D uDay, uSpec; uniform mat3 uL2E;
        uniform sampler2D uImg0, uImg1, uImg2; uniform vec4 uRect0, uRect1, uRect2; uniform vec3 uImgOn;
        ${ATMO_GLSL}
        ${NOISE_GLSL}
        float gWater = 0.0; vec3 gWN = vec3(0.0, 1.0, 0.0);
        // 真实卫星影像采样（Web 墨卡托，三级细节由粗到细融合）
        void imgLevel(sampler2D t, vec4 r, float on, vec2 m, inout vec4 acc) {
          if (on < 0.5) return;
          vec2 uv = (m - r.xy) / (r.zw - r.xy);
          vec2 e2 = min(uv, 1.0 - uv);
          float w = smoothstep(0.0, 0.06, min(e2.x, e2.y));
          if (w <= 0.0) return;
          vec3 c = texture2D(t, vec2(uv.x, 1.0 - uv.y)).rgb;
          acc.rgb = mix(acc.rgb, c, w); acc.a = max(acc.a, w);
        }
        vec4 imagery(vec3 wp) {
          vec3 d = normalize(wp - vec3(0.0, -6371000.0, 0.0));
          vec3 e = normalize(uL2E * d);
          float lat = asin(clamp(e.y, -1.0, 1.0)), lon = atan(-e.z, e.x);
          vec2 m = vec2(lon / 6.2831853 + 0.5, 0.5 - log(tan(0.78539816 + lat * 0.5)) / 6.2831853);
          vec4 acc = vec4(0.0);
          imgLevel(uImg2, uRect2, uImgOn.z, m, acc);
          imgLevel(uImg1, uRect1, uImgOn.y, m, acc);
          imgLevel(uImg0, uRect0, uImgOn.x, m, acc);
          return acc;
        }
        vec3 texAt(sampler2D t, vec2 xz) {
          vec3 d = normalize(vec3(xz.x, 6371000.0, xz.y));
          vec3 e = normalize(uL2E * d);
          vec2 uv = vec2(atan(-e.z, e.x) / 6.2831853 + 0.5, asin(e.y) / 3.14159265 + 0.5);
          return texture2D(t, uv).rgb;
        }`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        vec2 pw = vTW.xz;
        float dist = length(pw);
        float patchA = 1.0;
        // 转到"海岸坐标"：x 沿海岸法线（指向海），y 沿海岸线
        vec2 p = vec2(dot(pw, uCoastDir), dot(pw, vec2(-uCoastDir.y, uCoastDir.x)));
        if (uPatch > 0.5) { p = vec2(1e6, 0.0); dist = 1e5; }
        float cx = uCoastX + (fbm2(vec2(0.0, p.y) * 0.00035) - 0.5) * 900.0 + (fbm2(p * 0.004) - 0.5) * 60.0;
        float sea = smoothstep(cx - 8.0, cx + 8.0, p.x);
        // 远处按真实地球贴图的海陆分布（近处程序化海岸保证发射场地理关系）
        float farW = smoothstep(6000.0, 26000.0, dist);
        float texSea = texAt(uSpec, pw).r + (fbm2(pw * 0.0004) - 0.5) * 0.25;
        sea = mix(sea, smoothstep(0.42, 0.58, texSea), farW);
        float lag = 0.0;
        if (uStyle < 0.5) lag = smoothstep(0.02, -0.02, abs(p.x + 5200.0 + (fbm2(p * 0.0006) - 0.5) * 2500.0) - 1400.0);
        if (uStyle > 0.5 && uStyle < 1.5) lag = smoothstep(0.55, 0.62, fbm2(p * 0.00035 + 3.0)) * smoothstep(2500.0, 4500.0, -p.x);
        float water = max(sea, lag * (1.0 - farW));
        if (uPatch > 0.5) { water = 1.0; sea = 1.0; lag = 0.0; farW = 1.0; }
        // 陆地颜色
        float n1 = fbm2(p * 0.0012), n2 = fbm2(p * 0.018), n3 = fbm2(p * 0.12);
        vec3 scrub = mix(vec3(0.20, 0.25, 0.12), vec3(0.34, 0.33, 0.20), n1);
        vec3 green = mix(vec3(0.13, 0.22, 0.09), vec3(0.24, 0.30, 0.13), n2);
        vec3 land = mix(scrub, green, smoothstep(0.35, 0.7, n2));
        if (uStyle > 0.5 && uStyle < 1.5) land = mix(vec3(0.52, 0.47, 0.36), vec3(0.34, 0.36, 0.22), smoothstep(0.3, 0.75, n1 * 0.7 + n2 * 0.5)); // 得州海岸沙丘与湿地
        if (uStyle > 1.5) land = mix(vec3(0.10, 0.22, 0.08), vec3(0.22, 0.30, 0.12), n2);                                   // 海南热带植被
        land *= 0.85 + 0.3 * n3;
        // 远处用真实贴图颜色
        land = mix(land, texAt(uDay, pw) * 0.9, farW);
        // 沙滩
        float beach = smoothstep(-150.0, -20.0, p.x - cx) * (1.0 - sea) * (1.0 - farW);
        land = mix(land, mix(vec3(0.76, 0.70, 0.56), vec3(0.86, 0.80, 0.66), n3), beach);
        // 发射台混凝土场坪与道路
        float pad = 1.0 - smoothstep(170.0, 185.0, dist);
        float road = (1.0 - smoothstep(16.0, 20.0, abs(p.y + 20.0))) * step(p.x, -150.0) * step(-2600.0, p.x);
        if (uStyle > 0.5 && uStyle < 1.5) road = (1.0 - smoothstep(6.0, 9.0, abs(p.y - 260.0 + p.x * 0.05))) * step(-6000.0, p.x) * step(p.x, cx - 200.0);
        vec3 concrete = mix(vec3(0.46, 0.46, 0.44), vec3(0.58, 0.57, 0.54), n3) * (0.9 + 0.1 * vn(p * 0.5));
        concrete *= 1.0 - 0.35 * (1.0 - smoothstep(10.0, 60.0, dist)); // 发射台附近烟熏
        land = mix(land, concrete, max(pad, road * 0.85));
        // 海水
        vec3 deep = uStyle > 1.5 ? vec3(0.02, 0.10, 0.14) : vec3(0.02, 0.08, 0.12);
        vec3 shallow = uStyle > 0.5 && uStyle < 1.5 ? vec3(0.10, 0.20, 0.20) : vec3(0.05, 0.19, 0.22);
        float shore = smoothstep(0.0, 1400.0, p.x - cx);
        vec3 wcol = mix(shallow, deep, shore);
        if (lag > 0.5 && sea < 0.5) wcol = vec3(0.05, 0.11, 0.12);
        // 浪花（近岸白线）
        float foam = (1.0 - smoothstep(0.0, 40.0, abs(p.x - cx - 25.0 - 12.0 * sin(p.y * 0.02 + uTime * 0.6)))) * sea * (0.5 + 0.5 * n3);
        wcol = mix(wcol, vec3(0.85), foam * 0.6);
        if (uPatch < 0.5 && uImgOn.x + uImgOn.y + uImgOn.z > 0.5) {
          vec4 im = imagery(vTW);
          if (im.a > 0.0) {
            vec3 ic = im.rgb * 1.08;
            // 近距离细节：影像只有 10 m 分辨率，叠加多尺度植被/地表纹理（随像素尺度淡出）
            float fp = length(fwidth(vTW.xz));
            float dA = 1.0 - smoothstep(1.5, 12.0, fp), dB = 1.0 - smoothstep(0.3, 2.5, fp);
            float nd1 = fbm2(vTW.xz * 0.09), nd2 = fbm2(vTW.xz * 0.6 + 11.0), nd3 = vn(vTW.xz * 3.0);
            float shrub = smoothstep(0.52, 0.66, fbm2(vTW.xz * 0.25 + 5.0));
            float lumI = dot(ic, vec3(0.3, 0.59, 0.11));
            float veg = smoothstep(0.02, 0.06, ic.g - ic.b) * smoothstep(0.35, 0.2, lumI); // 仅对植被区域加灌木斑块
            ic *= 1.0 + dA * ((nd1 - 0.5) * 0.9 - shrub * veg * 0.45) + dB * ((nd2 - 0.5) * 0.6 + (nd3 - 0.5) * 0.3);
            float lum = dot(ic, vec3(0.3, 0.59, 0.11));
            float wImg = smoothstep(0.1, 0.055, lum) * smoothstep(-0.015, 0.02, ic.b - ic.r * 0.9);
            land = mix(land, ic, im.a);
            water = mix(water, wImg, im.a);
            wcol = mix(wcol, mix(ic, deep, 0.25), im.a);
          }
        }
        gWater = water;
        if (uPatch > 0.5) { wcol = deep; foam = 0.0; patchA = 1.0 - smoothstep(0.55, 1.0, length(vUvP - 0.5) * 2.0); }
        vec3 col = mix(land, wcol, water);
        vec4 diffuseColor = vec4(col, opacity * patchA);`)
      .replace('#include <tonemapping_fragment>', `{
          // 大气透视（与地球、天空同一散射模型）
          vec3 pK = (vTW - vec3(0.0, -6371000.0, 0.0)) / 1000.0;
          vec3 rdA = normalize(pK - uCamKm); vec3 trA;
          vec3 insA = scatter(uCamKm, rdA, length(pK - uCamKm), trA);
          gl_FragColor.rgb = gl_FragColor.rgb * trA + insA;
        }
        #include <tonemapping_fragment>`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.07, gWater);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (gWater > 0.01) {
          vec2 q = vTW.xz;
          float t = uTime;
          vec2 g = vec2(0.0);
          // 多方向深水波叠加（色散关系 ω = √(g·k)），按像素覆盖尺度逐频段淡出避免闪烁
          float fp = length(fwidth(q));
          float modA = 0.6 + 0.8 * vn(q * 0.004 + t * 0.01);
          for (int i = 0; i < 7; i++) {
            float fi = float(i);
            float ang = fi * 2.399 + 0.35;                       // 黄金角分布的传播方向
            float lam = 90.0 * pow(0.62, fi);                    // 波长 90 m → 5 m
            float k = 6.2831853 / lam;
            vec2 dir = vec2(cos(ang), sin(ang));
            float ph = dot(dir, q) * k - sqrt(9.81 * k) * t + fi * 1.7 + vn(q * 0.01 + fi) * 3.0;
            float aa = 0.075 * modA * (1.0 - smoothstep(lam * 0.15, lam * 0.6, fp));
            g += dir * cos(ph) * aa;
          }
          g += (vec2(vn(q * 1.7 - t * 0.9), vn(q * 1.7 + t * 0.8 + 3.0)) - 0.5) * 0.05 * (1.0 - smoothstep(0.3, 1.2, fp));
          float fadeW = 1.0;
          vec3 wn = normalize(vec3(-g.x * fadeW, 1.0, -g.y * fadeW));
          normal = normalize(mix(normal, (viewMatrix * vec4(wn, 0.0)).xyz, gWater));
        }`);
  };
  const mesh = new THREE.Mesh(discGeometry(patch ? patch.radius : LOCAL_R, patch ? 60 : 150, patch ? 96 : 220), mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = patch ? 1 : -4;
  if (patch) { mat.transparent = true; mat.depthWrite = false; }
  return { mesh, uniforms: uni };
}
