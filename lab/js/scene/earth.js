// 地球：以发射场为"北极"的非均匀网格球体（发射场附近网格极密），着色器中换算经纬度采样真实地表贴图，
// 叠加云层、城市灯光、海面高光与大气透视（与天空同一散射模型）。
import * as THREE from 'three';
import { ATMO_GLSL } from './atmosphere.js';

const TEX = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/';
export const RE = 6371000;

/** 发射场局部坐标系（X=射向，Y=天顶，Z=X×Y）到"地心地固系（three 风格：Y 指北极）"的旋转矩阵 */
export function localToEcef(latDeg, lonDeg, azDeg) {
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180, az = (azDeg * Math.PI) / 180;
  const up = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
  const east = new THREE.Vector3(-Math.sin(lo), 0, -Math.cos(lo));
  const north = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo));
  const fwd = north.clone().multiplyScalar(Math.cos(az)).add(east.clone().multiplyScalar(Math.sin(az)));
  const right = new THREE.Vector3().crossVectors(fwd, up);
  return new THREE.Matrix3().set(fwd.x, up.x, right.x, fwd.y, up.y, right.y, fwd.z, up.z, right.z);
}

function padPolarSphere(nr = 180, ns = 256) {
  const pos = [], idx = [];
  for (let i = 0; i <= nr; i++) {
    const th = Math.PI * Math.pow(i / nr, 2.3);
    for (let j = 0; j <= ns; j++) {
      const ph = (j / ns) * Math.PI * 2;
      pos.push(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
    }
  }
  for (let i = 0; i < nr; i++) for (let j = 0; j < ns; j++) {
    const a = i * (ns + 1) + j, b = a + ns + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function createEarth(renderer) {
  const loader = new THREE.TextureLoader();
  const blank = new THREE.DataTexture(new Uint8Array([40, 70, 110, 255]), 1, 1); blank.needsUpdate = true;
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uCamKm: { value: new THREE.Vector3(0, 6371.01, 0) },
    uSunE: { value: 3.0 },
    uDay: { value: blank }, uNight: { value: black }, uClouds: { value: black }, uSpec: { value: black },
    uL2E: { value: new THREE.Matrix3() },
    uHole: { value: 0.0 },       // 发射场附近局部地形覆盖的角半径（rad）
    uCloudRot: { value: 0 },
    uTime: { value: 0 },
  };
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const load = (name, key, srgb) => loader.load(TEX + name, (t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = maxAniso;
    t.wrapS = THREE.RepeatWrapping; uniforms[key].value = t;
  });
  load('earth_atmos_4096.jpg', 'uDay', true);
  load('earth_lights_2048.png', 'uNight', true);
  load('earth_clouds_2048.png', 'uClouds', false);
  load('earth_specular_2048.jpg', 'uSpec', false);

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vLocal;
      varying vec3 vWorld;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vLocal;
      varying vec3 vWorld;
      uniform sampler2D uDay, uNight, uClouds, uSpec;
      uniform mat3 uL2E;
      uniform float uHole, uCloudRot, uTime;
      ${ATMO_GLSL}
      #include <logdepthbuf_pars_fragment>
      vec2 llUV(vec3 e) {
        float lat = asin(clamp(e.y, -1.0, 1.0));
        float lon = atan(-e.z, e.x);
        return vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
      }
      vec4 samp(sampler2D t, vec2 uv) {
        // 经度接缝处使用连续导数，避免 mip 断裂
        vec2 uv2 = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
        vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
        if (abs(dx2.x) + abs(dy2.x) < abs(dx.x) + abs(dy.x)) { dx = dx2; dy = dy2; }
        return textureGrad(t, uv, dx, dy);
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 nL = normalize(vLocal);
        float ang = acos(clamp(nL.y, -1.0, 1.0));
        if (ang < uHole) discard;                       // 发射场附近由高精度局部地形接管
        vec3 e = normalize(uL2E * nL);
        vec2 uv = llUV(e);
        vec3 day = samp(uDay, uv).rgb;
        float spec = samp(uSpec, uv).r;
        vec2 cuv = uv + vec2(uCloudRot, 0.0);
        float cl = samp(uClouds, cuv).a;
        vec3 n = nL;
        vec3 pKm = nL * RE;
        float ndl = dot(n, uSunDir);
        vec3 Ts = sunTrans(pKm + n * 0.05);
        // 地表：漫反射 + 海面镜面高光
        vec3 V = normalize(uCamKm - pKm);
        vec3 H = normalize(V + uSunDir);
        float gl = pow(max(dot(n, H), 0.0), 180.0) * spec * 1.4 + pow(max(dot(n, H), 0.0), 14.0) * spec * 0.06;
        vec3 ground = day * 0.92;
        ground = mix(ground, ground * vec3(0.55, 0.75, 1.0), spec * 0.35);
        vec3 lit = ground * max(ndl, 0.0) / PI * uSunE * Ts + vec3(gl) * uSunE * Ts * max(ndl, 0.0);
        // 天空环境光（按大气散射的天顶亮度近似）
        lit += ground * uSunE * 0.03 * smoothstep(-0.25, 0.3, ndl);
        // 云层
        float cd = smoothstep(0.12, 0.85, cl);
        vec3 cloudLit = vec3(0.96) * (max(ndl, 0.0) * 0.9 + 0.08 * smoothstep(-0.2, 0.2, ndl)) / PI * uSunE * Ts + vec3(0.02) * uSunE * smoothstep(-0.25, 0.3, ndl);
        lit = mix(lit, cloudLit, cd * 0.92);
        // 城市灯光（夜侧）
        vec3 lights = samp(uNight, uv).rgb;
        lit += lights * (1.0 - smoothstep(-0.12, 0.08, ndl)) * (1.0 - cd * 0.8) * 1.4;
        // 大气透视
        vec3 ro = uCamKm, rd = normalize(pKm - ro);
        float dist = length(pKm - ro);
        vec3 tr;
        vec3 ins = scatter(ro, rd, dist, tr);
        vec3 col = lit * tr + ins;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: false,
  });
  const mesh = new THREE.Mesh(padPolarSphere(), mat);
  mesh.scale.setScalar(RE);
  mesh.position.set(0, -RE, 0);
  mesh.frustumCulled = false;
  mesh.renderOrder = -5;
  return { mesh, uniforms };
}
