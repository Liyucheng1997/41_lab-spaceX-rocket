// 体积光线步进尾焰
// 每个发动机组一个包围圆柱体，片元着色器沿视线积分：逐台发动机的射流核心 + 混合层 + 马赫环（激波菱形），
// 喷流宽度随环境压强下降而膨胀（欠膨胀射流），多台发动机的尾焰在下游自然融合。
import * as THREE from 'three';

const MAXE = 33;

const VS = /* glsl */`
  varying vec3 vPosL;
  uniform float uRb, uLb;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vPosL = position * vec3(uRb, uLb, uRb);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;

const FS = /* glsl */`
  #define MAXE ${MAXE}
  varying vec3 vPosL;
  uniform vec3 uCamL;
  uniform vec2 uPos[MAXE];
  uniform float uThr[MAXE];
  uniform int uCount;
  uniform float uRe, uLen, uExp, uDiam, uTime, uInt, uType, uRb, uLb, uSoot, uMachSweep;
  uniform vec4 uGround;      // 本地坐标下的地面平面 (n, d)：dot(n,p)+d>0 为地面以上
  #include <logdepthbuf_pars_fragment>
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  // 返回 (核心密度, 外层密度, 马赫环亮度)
  vec3 field(vec3 p) {
    float s = -p.y;
    if (s < 0.0) return vec3(0.0);
    float re = uRe;
    float w = re * (1.0 + uExp * s / re + 0.012 * s / re);
    float lam = re * 2.2;
    float ph = s / lam;
    float neck = 1.0 - 0.16 * uDiam * (0.5 + 0.5 * cos(6.2831853 * ph)) * exp(-s / (lam * 6.0));
    float wc = w * neck;
    float core = 0.0, sheath = 0.0, dia = 0.0;
    // 质量守恒：喷流截面扩大时单位体积的发光强度按 (re/w)^2 下降
    float cons = pow(re / w, 1.8);
    float wEnv = w * 2.4;
    for (int i = 0; i < MAXE; i++) {
      if (i >= uCount) break;
      float th = uThr[i];
      if (th <= 0.001) continue;
      vec2 d2 = p.xz - uPos[i];
      float dd = dot(d2, d2);
      if (dd > wEnv * wEnv * 4.0) continue;
      float q = dd / (wc * wc);
      core += th * exp(-q * 2.2);
      sheath += th * exp(-dd / (w * w * 5.0));
      // 马赫环：沿轴向的一串亮斑
      float k = fract(ph + 0.35) - 0.5;
      dia += th * exp(-k * k * 60.0) * exp(-q * 5.0) * exp(-s / (lam * 5.5));
    }
    // 包围体边界处平滑归零，避免高曝光时出现几何轮廓
    float edge = (1.0 - smoothstep(0.6 * uRb, 0.98 * uRb, length(p.xz))) * (1.0 - smoothstep(0.7 * uLb, 0.98 * uLb, s));
    return vec3(core * cons, sheath * cons, dia) * edge;
  }

  vec3 palette(float c, float sh, float s) {
    float tailK = exp(-s / uLen);
    // 0 煤油液氧  1 甲烷液氧  2 液氢液氧  3 固体  4 F-1
    if (uType < 0.5) {
      vec3 hot = vec3(1.0, 0.86, 0.62), mid = vec3(1.0, 0.52, 0.16), cool = vec3(0.75, 0.22, 0.05);
      return mix(mix(cool, mid, smoothstep(0.0, 0.5, c)), hot, smoothstep(0.45, 1.2, c)) * (c * 2.2 + sh * 0.55) ;
    } else if (uType < 1.5) {
      vec3 hot = vec3(0.92, 0.86, 1.0), mid = vec3(0.62, 0.42, 1.0), edge = vec3(1.0, 0.45, 0.28);
      return (mix(mid, hot, smoothstep(0.5, 1.2, c)) * c * 1.6 + edge * sh * 0.5 * (0.4 + 0.6 * tailK));
    } else if (uType < 2.5) {
      vec3 hot = vec3(0.85, 0.82, 1.0), mid = vec3(0.45, 0.5, 1.0);
      return mix(mid, hot, smoothstep(0.6, 1.3, c)) * (c * 0.55 + sh * 0.12);
    } else if (uType < 3.5) {
      return vec3(1.0, 0.8, 0.5) * (c * 2.8 + sh * 0.8);
    }
    vec3 hot = vec3(1.0, 0.8, 0.5), mid = vec3(1.0, 0.48, 0.12);
    return mix(mid, hot, smoothstep(0.4, 1.1, c)) * (c * 2.4 + sh * 0.7);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 ro = uCamL;
    vec3 rd = normalize(vPosL - ro);
    // 与包围圆柱求交
    float a = dot(rd.xz, rd.xz), b = dot(ro.xz, rd.xz), c = dot(ro.xz, ro.xz) - uRb * uRb;
    float disc = b * b - a * c;
    if (disc < 0.0 || a < 1e-8) discard;
    disc = sqrt(disc);
    float t0 = (-b - disc) / a, t1 = (-b + disc) / a;
    float ty0 = (0.0 - ro.y) / rd.y, ty1 = (-uLb - ro.y) / rd.y;
    t0 = max(t0, min(ty0, ty1)); t1 = min(t1, max(ty0, ty1));
    t0 = max(t0, 0.0);
    // 地面截断
    float gn = dot(uGround.xyz, rd);
    float g0 = dot(uGround.xyz, ro) + uGround.w;
    if (abs(gn) > 1e-5) { float tg = -g0 / gn; if (gn < 0.0) t1 = min(t1, tg); else t0 = max(t0, tg); }
    else if (g0 < 0.0) discard;
    if (t1 <= t0) discard;
    const int N = 40;
    float dt = (t1 - t0) / float(N);
    float t = t0 + dt * hash(gl_FragCoord.xy + fract(uTime * 7.0));
    vec3 col = vec3(0.0);
    float T = 1.0;
    float flick = 0.94 + 0.06 * sin(uTime * 61.0) * sin(uTime * 23.0 + 1.3);
    for (int i = 0; i < N; i++) {
      vec3 p = ro + rd * t;
      float s = -p.y;
      vec3 f = field(p);
      if (f.x + f.y > 1e-3) {
        float tail = exp(-s / uLen);
        float core = f.x * tail;
        float sh = f.y * exp(-s / (uLen * 1.6));
        vec3 e = palette(core, sh, s) + vec3(1.0, 0.95, 0.85) * f.z * uDiam * (uType > 1.5 && uType < 2.5 ? 1.2 : 2.2);
        // 煤油发动机尾部的碳烟（吸收）；F-1 喷口附近的燃气发生器废气暗层
        float soot = uSoot * f.y * smoothstep(uLen * 0.5, uLen * 2.0, s) * 0.02;
        if (uType > 3.5) soot += uSoot * f.y * (1.0 - smoothstep(0.0, uRe * 3.0, s)) * (1.0 - smoothstep(0.2, 0.9, f.x)) * 0.25;
        col += T * e * dt * flick * uInt / uRe;
        T *= exp(-soot * dt);
      }
      t += dt;
    }
    float alpha = 1.0 - T;
    gl_FragColor = vec4(col, alpha);
  }`;

const TYPE = { kerolox: 0, methalox: 1, hydrolox: 2, solid: 3 };

export class Plume {
  /** engines: [{pos: Vector3 (箭体坐标), exitR}], e: 发动机定义 */
  constructor(engines, e, opts = {}) {
    this.engines = engines;
    this.e = e;
    let cx = 0, cy = 0, cz = 0;
    engines.forEach((it) => { cx += it.pos.x; cy += it.pos.y; cz += it.pos.z; });
    cx /= engines.length; cy /= engines.length; cz /= engines.length;
    this.center = new THREE.Vector3(cx, cy, cz);
    this.clusterR = Math.max(...engines.map((it) => Math.hypot(it.pos.x - cx, it.pos.z - cz))) + engines[0].exitR;
    this.re = engines[0].exitR;
    const pos = Array.from({ length: MAXE }, (_, i) => (engines[i] ? new THREE.Vector2(engines[i].pos.x - cx, engines[i].pos.z - cz) : new THREE.Vector2()));
    this.uniforms = {
      uCamL: { value: new THREE.Vector3() },
      uPos: { value: pos },
      uThr: { value: new Array(MAXE).fill(0) },
      uCount: { value: engines.length },
      uRe: { value: this.re }, uLen: { value: 10 }, uExp: { value: 0.03 }, uDiam: { value: 1 },
      uTime: { value: 0 }, uInt: { value: 1 }, uType: { value: e.soot ? 4 : TYPE[e.prop] ?? 0 },
      uRb: { value: 10 }, uLb: { value: 50 }, uSoot: { value: e.prop === 'kerolox' ? 1 : 0 },
      uMachSweep: { value: 0 }, uGround: { value: new THREE.Vector4(0, 1, 0, 1e9) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VS, fragmentShader: FS,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const geo = new THREE.CylinderGeometry(1, 1, 1, 28, 1, false);
    geo.translate(0, -0.5, 0);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.copy(this.center);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this._inv = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._n = new THREE.Vector3();
  }

  /**
   * lit: 每台发动机的油门数组（0 表示熄火），pAmb: 环境压强 Pa，camera: 相机，groundY: 世界坐标地面高度
   */
  update(lit, pAmb, camera, time, groundY = -1e9, vAir = 0) {
    let any = false;
    for (let i = 0; i < this.engines.length; i++) { this.uniforms.uThr.value[i] = lit[i] || 0; if (lit[i] > 0.01) any = true; }
    this.mesh.visible = any;
    if (!any) return;
    const pr = Math.max(pAmb / 101325, 0);
    const e = this.e;
    // 欠膨胀射流的扩张：环境压强越低，喷流越宽（真空下呈巨大钟形羽流）
    const lowP = Math.pow(1 - Math.min(pr, 1), 3);
    const vac = THREE.MathUtils.clamp(-Math.log10(pr + 1e-7) / 5, 0, 1);
    let exp = 0.015 + 0.12 * lowP + 0.9 * vac * vac;
    if (e.prop === 'hydrolox') exp *= 1.1;
    const baseLen = { kerolox: 18, methalox: 16, hydrolox: 13, solid: 10 }[e.prop] ?? 15;
    let len = this.re * baseLen * (1 + 2.2 * lowP + 4 * vac);
    if (e.soot) len *= 1.25;
    const diam = THREE.MathUtils.smoothstep(pr, 0.12, 0.55);
    // 高速飞行时尾焰被来流压缩（仅低空明显）
    const sweep = THREE.MathUtils.clamp(vAir / 900, 0, 1) * THREE.MathUtils.smoothstep(pr, 0.05, 0.5);
    len *= 1 - 0.35 * sweep;
    const u = this.uniforms;
    u.uExp.value = exp; u.uLen.value = len; u.uDiam.value = diam; u.uTime.value = time;
    const intensity = { kerolox: 1.0, methalox: 0.85, hydrolox: 0.55, solid: 1.4 }[e.prop] ?? 1;
    u.uInt.value = intensity * (0.55 + 0.45 * Math.min(1, pr * 4 + 0.4)) * (e.soot ? 1.1 : 1);
    const Lb = Math.min(len * 3.2, 25000);
    const Rb = this.clusterR + this.re * (1 + exp * Lb / this.re) * 2.6;
    u.uLb.value = Lb; u.uRb.value = Rb;
    this.mesh.scale.set(Rb, Lb, Rb);
    // 相机转换到尾焰本地坐标（未缩放）
    this.mesh.updateMatrixWorld();
    const m = this.mesh.matrixWorld.clone();
    const sx = new THREE.Matrix4().makeScale(1 / Rb, 1 / Lb, 1 / Rb);
    m.multiply(sx);
    this._inv.copy(m).invert();
    u.uCamL.value.copy(camera.position).applyMatrix4(this._inv);
    // 地面平面：世界 y = groundY
    const p0 = this._v.set(camera.position.x, groundY, camera.position.z).applyMatrix4(this._inv);
    const nl = new THREE.Vector3(0, 1, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(m).transpose()).normalize();
    u.uGround.value.set(nl.x, nl.y, nl.z, -nl.dot(p0));
    // 相机是否在包围体内：切换正/背面渲染
    const cl = u.uCamL.value;
    const inside = cl.y < 0.5 && cl.y > -Lb - 0.5 && Math.hypot(cl.x, cl.z) < Rb * 1.02;
    this.material.side = inside ? THREE.BackSide : THREE.FrontSide;
    return { len, exp, Lb, Rb };
  }
}
