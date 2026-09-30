// 烟雾 / 水蒸气粒子系统：实例化公告板，程序化体积云纹理，伪法线光照 + 发动机火光照亮
import * as THREE from 'three';
import { fbm } from '../models/parts.js';

function puffAtlas() {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S * 2;
  const g = c.getContext('2d');
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * S, oy = Math.floor(k / 2) * S;
    const img = g.createImageData(S, S), d = img.data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x / S) * 2 - 1, v = (y / S) * 2 - 1, r = Math.hypot(u, v);
      const n = fbm(x / 22 + k * 7.3, y / 22 + k * 3.1, 5);
      const a = Math.max(0, 1 - r * (1.05 + (n - 0.5) * 0.9)) ;
      const al = Math.pow(Math.min(1, a * 1.8), 1.4) * (0.55 + 0.6 * n);
      const i = (y * S + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255 * (0.7 + 0.3 * n); d[i + 3] = 255 * Math.min(1, al);
    }
    g.putImageData(img, ox, oy);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
}

export class Smoke {
  constructor(max = 7000) {
    this.max = max; this.n = 0; this.head = 0;
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSz = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage); // size, alpha, rot, heat
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage); // rgb, tile
    g.setAttribute('iPos', this.aPos); g.setAttribute('iSz', this.aSz); g.setAttribute('iCol', this.aCol);
    g.instanceCount = 0;
    this.geo = g;
    this.p = []; // CPU 粒子
    this.uniforms = {
      uTex: { value: puffAtlas() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(3, 3, 3) },
      uAmb: { value: new THREE.Color(0.4, 0.45, 0.5) },
      uGlowPos: { value: [new THREE.Vector3(0, -1e9, 0), new THREE.Vector3(0, -1e9, 0), new THREE.Vector3(0, -1e9, 0)] },
      uGlowCol: { value: [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)] },
      uGlowR: { value: [1, 1, 1] },
      fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec4 iSz; attribute vec4 iCol;
        varying vec2 vUv; varying float vA; varying vec3 vCol; varying float vHeat; varying vec3 vWP; varying float vTile; varying float vFogDepth;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          float c = cos(iSz.z), s = sin(iSz.z);
          vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iSz.x;
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          mv.xy += q;
          vUv = uv; vA = iSz.y; vCol = iCol.rgb; vHeat = iSz.w; vWP = iPos; vTile = iCol.a;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uTex; uniform vec3 uSunDir, uSunCol, uAmb;
        uniform vec3 uGlowPos[3]; uniform vec3 uGlowCol[3]; uniform float uGlowR[3];
        uniform vec3 fogColor; uniform float fogDensity;
        varying vec2 vUv; varying float vA; varying vec3 vCol; varying float vHeat; varying vec3 vWP; varying float vTile; varying float vFogDepth;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec2 tuv = (vUv + vec2(mod(vTile, 2.0), floor(vTile / 2.0))) * 0.5;
          vec4 tx = texture2D(uTex, tuv);
          float a = tx.a * vA;
          if (a < 0.004) discard;
          // 伪球面法线（视空间）→ 世界空间近似光照
          vec2 d = vUv * 2.0 - 1.0;
          vec3 nv = normalize(vec3(d, sqrt(max(0.0, 1.0 - dot(d, d))) + 0.3));
          vec3 nw = normalize((vec4(nv, 0.0) * viewMatrix).xyz);
          float sunL = clamp(dot(nw, uSunDir) * 0.6 + 0.45, 0.0, 1.0);
          // 按粒子自身高度计算日照：地影遮挡 + 大气路径衰减（低太阳角偏红）
          vec3 upW = normalize(vWP - vec3(0.0, -6371000.0, 0.0));
          float hK = max(0.0, length(vWP - vec3(0.0, -6371000.0, 0.0)) - 6371000.0) / 1000.0;
          float muS = dot(upW, uSunDir);
          float dipS = acos(6371.0 / (6371.0 + hK));
          float elS = asin(clamp(muS, -1.0, 1.0));
          float visS = smoothstep(-dipS - 0.006, -dipS + 0.006, elS);
          float am = 1.0 / max(0.035, max(muS, 0.0) + 0.06);
          vec3 sunC = 3.2 * exp(-vec3(0.1, 0.2, 0.42) * am * exp(-hK / 8.0) * 1.4) * visS;
          vec3 col = vCol * tx.r * (sunC * sunL * 0.32 + uAmb);
          // 发动机火光照亮烟云（下表面呈橙色）
          for (int i = 0; i < 3; i++) {
            vec3 L = uGlowPos[i] - vWP; float dl = length(L);
            float fall = uGlowR[i] * uGlowR[i] / (dl * dl + uGlowR[i] * uGlowR[i]);
            col += vCol * uGlowCol[i] * fall * (0.55 + 0.45 * clamp(dot(nw, L / max(dl, 1e-3)), 0.0, 1.0));
          }
          col += vec3(1.0, 0.45, 0.12) * vHeat * 6.0;
          float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          col = mix(col, fogColor, fogF);
          gl_FragColor = vec4(col * a, a);
        }`,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  clear() { this.p.length = 0; }

  /** 发射一个粒子 */
  emit(o) {
    if (this.p.length >= this.max) this.p.splice(0, Math.ceil(this.max * 0.02));
    this.p.push({
      x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
      age: 0, life: o.life || 10, s0: o.size || 5, s1: o.size1 || (o.size || 5) * 4,
      a: o.alpha ?? 0.8, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * (o.spin ?? 0.3),
      r: o.r ?? 0.9, g: o.g ?? 0.9, b: o.b ?? 0.92, heat: o.heat || 0, drag: o.drag ?? 0.35, buoy: o.buoy ?? 0.8,
      tile: Math.floor(Math.random() * 4), grow: o.grow ?? 0.55, wind: o.wind ?? 1,
    });
  }

  update(dt, wind = [3, 0, 1.5]) {
    const P = this.p;
    let w = 0;
    for (let i = 0; i < P.length; i++) {
      const q = P[i];
      q.age += dt;
      if (q.age >= q.life) continue;
      const k = Math.exp(-q.drag * dt);
      q.vx = (q.vx - wind[0] * q.wind) * k + wind[0] * q.wind; q.vz = (q.vz - wind[2] * q.wind) * k + wind[2] * q.wind;
      q.vy = q.vy * k + q.buoy * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      q.rot += q.vr * dt;
      q.heat *= Math.exp(-dt * 2.2);
      P[w++] = q;
    }
    P.length = w;
    const n = Math.min(P.length, this.max);
    const pos = this.aPos.array, sz = this.aSz.array, col = this.aCol.array;
    for (let i = 0; i < n; i++) {
      const q = P[i], f = q.age / q.life;
      pos[i * 3] = q.x; pos[i * 3 + 1] = q.y; pos[i * 3 + 2] = q.z;
      const size = q.s0 + (q.s1 - q.s0) * (1 - Math.pow(1 - f, 1 / (q.grow + 0.2)));
      const fadeIn = Math.min(1, q.age / 0.35);
      sz[i * 4] = size; sz[i * 4 + 1] = q.a * fadeIn * (1 - f) * (1 - f * 0.3); sz[i * 4 + 2] = q.rot; sz[i * 4 + 3] = q.heat;
      col[i * 4] = q.r; col[i * 4 + 1] = q.g; col[i * 4 + 2] = q.b; col[i * 4 + 3] = q.tile;
    }
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = this.aSz.needsUpdate = this.aCol.needsUpdate = true;
  }
}
