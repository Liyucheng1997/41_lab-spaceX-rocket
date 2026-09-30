// 火箭发射仿真实验室 · 主程序
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FlightSim, planMission, DT } from './physics/flight.js';
import { VEHICLES, SITES } from './physics/vehicles.js';
import { RE } from './physics/constants.js';
import { atmosphere } from './physics/atmosphere.js';
import { buildRocket } from './models/rockets.js';
import { createSky, horizonColor } from './scene/atmosphere.js';
import { createEarth, localToEcef } from './scene/earth.js';
import { createTerrain, LOCAL_R } from './scene/terrain.js';
import { buildPad, buildLandingZone, buildDroneship } from './scene/pads.js';
import { loadSiteImagery, IMAGERY_CREDIT } from './scene/imagery.js';
import { Plume } from './fx/plume.js';
import { Smoke } from './fx/particles.js';
import { CameraRig, CAM_MODES } from './camera.js';
import { HUD, fmtT } from './ui/hud.js';

const $ = (id) => document.getElementById(id);
const V3 = THREE.Vector3;

// ---------------------------------------------------------------------------
// 渲染器与后期
// ---------------------------------------------------------------------------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, 1.6);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.4, 3e8);
camera.position.set(80, 40, 160);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.55, 1.6);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// 天空、地球
const sky = createSky(); scene.add(sky.mesh);
const earth = createEarth(renderer); scene.add(earth.mesh);
earth.uniforms.uHole.value = LOCAL_R / RE;

// 灯光
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x4a4436, 0.6); scene.add(hemi);
const glowLights = [0, 1, 2].map(() => { const l = new THREE.PointLight(0xff9a50, 0, 0, 2); scene.add(l); return l; });

// 环境反射贴图（由天空着色器实时生成）
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new THREE.Mesh(sky.mesh.geometry, sky.material); envSky.scale.setScalar(50); envSky.frustumCulled = false; envScene.add(envSky);
let envRT = null, envKey = '';
function updateEnv(altKm, todKey) {
  const key = todKey + ':' + Math.round(altKm < 30 ? altKm / 3 : 10 + altKm / 25);
  if (key === envKey) return; envKey = key;
  const saveCam = sky.uniforms.uCamKm.value.clone();
  const nrt = pmrem.fromScene(envScene, 0, 0.1, 100);
  if (envRT) envRT.dispose();
  envRT = nrt; scene.environment = envRT.texture;
  sky.uniforms.uCamKm.value.copy(saveCam);
}

const smoke = new Smoke(14000); scene.add(smoke.mesh);
scene.fog = new THREE.FogExp2(0x9fb4cc, 0.00002);

const rig = new CameraRig(camera, canvas);
const hud = new HUD();

// ---------------------------------------------------------------------------
// 光照（时段）
// ---------------------------------------------------------------------------
const TOD = {
  dawn: { el: -3.5, az: 70 }, morning: { el: 22, az: 105 }, noon: { el: 68, az: 150 },
  sunset: { el: 5, az: 250 }, night: { el: -24, az: 110 },
};
let todKey = 'morning';
const sunDir = new V3();
function setTOD(k) {
  todKey = k; const t = TOD[k];
  const el = (t.el * Math.PI) / 180, az = (t.az * Math.PI) / 180;
  sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  sky.uniforms.uSunDir.value.copy(sunDir); earth.uniforms.uSunDir.value.copy(sunDir);
  smoke.uniforms.uSunDir.value.copy(sunDir);
  envKey = '';
}

// ---------------------------------------------------------------------------
// 世界（当前型号 / 任务）
// ---------------------------------------------------------------------------
let W = null;
const planCache = new Map();
const imageryData = new Map();
async function loadSiteImageryCached(site, uni) {
  // 每个发射场只下载一次影像，之后在各个任务间复用
  if (!imageryData.has(site.id)) {
    const holder = { uImg0: { value: null }, uImg1: { value: null }, uImg2: { value: null }, uRect0: { value: new THREE.Vector4() }, uRect1: { value: new THREE.Vector4() }, uRect2: { value: new THREE.Vector4() }, uImgOn: { value: new THREE.Vector3() } };
    imageryData.set(site.id, loadSiteImagery(site, holder, renderer.capabilities.getMaxAnisotropy()).then(() => holder));
  }
  const h = await imageryData.get(site.id);
  for (const k of ['uImg0', 'uImg1', 'uImg2']) if (h[k].value) uni[k].value = h[k].value;
  for (const k of ['uRect0', 'uRect1', 'uRect2']) uni[k].value.copy(h[k].value);
  uni.uImgOn.value.copy(h.uImgOn.value);
}

function sceneFromSim(sim, s, h, z, out = new V3()) {
  const phi = s / RE, r = RE + h;
  return out.set(r * Math.sin(phi), r * Math.cos(phi) - RE, z);
}
function bodyScenePos(sim, b, out = new V3()) {
  const phi = Math.atan2(b.x, b.y) - sim.omega * sim.t;
  const r = Math.hypot(b.x, b.y);
  return out.set(r * Math.sin(phi), r * Math.cos(phi) - RE, b.z);
}

class BodyVis {
  constructor(body) {
    this.body = body; this.group = new THREE.Group(); this.inner = new THREE.Group(); this.group.add(this.inner);
    this.tumbleQ = new THREE.Quaternion(); this.plumes = []; this.partIds = new Set(); this.lastTrail = null; this.hidden = false;
    this.inner.position.set(-body.pivot[0], -body.pivot[1], -body.pivot[2]);
    W.root.add(this.group);
  }
  attach(part) {
    const rp = W.rocket.parts[part.id];
    if (!rp) return;
    let obj = rp.obj;
    if (part.half) obj = rp.halves[part.half < 0 ? 0 : 1];
    const key = part.id + (part.half ? ':' + part.half : '');
    if (this.partIds.has(key)) return;
    this.partIds.add(key);
    this.inner.add(obj);
    if (!part.half && rp.engines) rp.engines.forEach((set, gi) => {
      const pl = new Plume(set.list, set.e); pl.partId = part.id; pl.gi = gi; pl.set = set;
      this.inner.add(pl.mesh); this.plumes.push(pl);
    });
    if (rp.solid) { const pl = new Plume(rp.solid.list, { prop: 'solid', exitD: 0.32, id: 'les' }); pl.partId = part.id; pl.gi = -1; pl.set = rp.solid; this.inner.add(pl.mesh); this.plumes.push(pl); }
  }
  detachMissing() {
    const ids = new Set(this.body.parts.map((p) => p.id + (p.half ? ':' + p.half : '')));
    for (const k of [...this.partIds]) if (!ids.has(k)) this.partIds.delete(k);
    this.plumes = this.plumes.filter((pl) => { const keep = this.body.parts.some((p) => p.id === pl.partId); if (!keep) pl.mesh.removeFromParent(); return keep; });
  }
}

function disposeWorld() {
  if (!W) return;
  scene.remove(W.root);
  W.root.traverse((o) => { if (o.geometry) o.geometry.dispose?.(); });
  smoke.clear();
  W = null;
}

async function loadWorld(vid, mid) {
  $('loading').classList.remove('hide');
  $('loadText').textContent = '正在进行飞行预演计算（完整任务的确定性仿真）…';
  await new Promise((r) => setTimeout(r, 30));
  disposeWorld();
  const veh = VEHICLES[vid], mission = veh.missions[mid], site = SITES[veh.site];
  const pk = vid + '/' + mid;
  if (!planCache.has(pk)) planCache.set(pk, planMission(vid, mid, 1000));
  const plan = planCache.get(pk);
  $('loadText').textContent = '正在构建三维场景…';
  await new Promise((r) => setTimeout(r, 10));
  const sim = new FlightSim(vid, mid, { plan });
  const root = new THREE.Group(); scene.add(root);
  W = { vid, mid, veh, mission, site, sim, plan, root, vis: new Map(), running: false, speed: 1, acc: 0, target: 1, lz: [], newEvents: [] };
  // 地球朝向与局部地形
  earth.uniforms.uL2E.value.copy(localToEcef(site.lat, site.lon, mission.azimuth));
  const terrain = createTerrain(site, earth.uniforms, null, mission.azimuth); root.add(terrain.mesh); W.terrain = terrain;
  loadSiteImageryCached(site, terrain.uniforms);
  // 发射台
  const pad = buildPad(vid, veh); root.add(pad.group); W.pad = pad;
  // 发射台建筑按真实地理方位摆放（局部 X 轴朝东；星际基地的塔臂需与捕获销对齐，保持不转）
  if (vid !== 'starship') {
    pad.group.rotation.y = ((mission.azimuth - 90) * Math.PI) / 180;
    pad.group.updateMatrixWorld(true);
    pad.trenchExits = pad.trenchExits.map((p) => p.clone().applyAxisAngle(new V3(0, 1, 0), pad.group.rotation.y));
  }
  // 着陆区 / 回收船
  for (const [key, rc] of Object.entries(mission.recovery || {})) {
    if (rc.type === 'rtls') {
      const lz = buildLandingZone(rc.target.z > 9800 ? 'LZ-2' : 'LZ-1');
      const p = sceneFromSim(sim, rc.target.s, 0, rc.target.z); lz.position.copy(p); lz.rotation.z = -rc.target.s / RE; root.add(lz); W.lz.push(lz);
    } else if (rc.type === 'asds' && plan.targets[key]) {
      const t = plan.targets[key];
      const ds = buildDroneship(vid === 'falconHeavy' ? 'OF COURSE I STILL LOVE YOU' : 'A SHORTFALL OF GRAVITAS');
      const p = sceneFromSim(sim, t.s, 0, t.z);
      ds.position.copy(p); ds.rotation.z = -t.s / RE; root.add(ds); W.lz.push(ds); ds.userData.ship = true;
      const patch = createTerrain(site, earth.uniforms, { radius: 16000 }, mission.azimuth);
      patch.mesh.position.copy(sceneFromSim(sim, t.s, 0.2, t.z)); patch.mesh.rotation.z = -t.s / RE; root.add(patch.mesh);
      W.patch = patch;
    }
  }
  // 火箭模型
  W.rocket = buildRocket(veh);
  W.rocket.parts && Object.values(W.rocket.parts).forEach((p) => p.obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }));
  syncBodies();
  rig.setStations(site, veh.deckH);
  const st = sim.stack;
  const info = targetInfo(st);
  rig.setMode(rig.mode === 'onboard' ? 'orbit' : rig.mode, info);
  if (rig.mode === 'orbit') {
    const d = veh.height * 1.7;
    camera.position.copy(info.center).add(vid === 'falconHeavy' ? new V3(d, -veh.height * 0.18, d * 0.45) : new V3(d * 0.55, -veh.height * 0.18, d));
    rig.controls.target.copy(info.center);
  }
  // UI
  hud.buildEvents(plan.log, mission);
  hud.specs(veh, mission);
  sim.on((type, data) => { if (type === 'event') W.newEvents.push(data); if (type === 'separate') W.sepFx = data; });
  updateGoButton(); buildTargetSeg();
  $('clock').textContent = fmtT(sim.t);
  $('phase').textContent = '待命 · 准备发射';
  setTimeout(() => $('loading').classList.add('hide'), 150);
}

function syncBodies() {
  const sim = W.sim;
  for (const b of sim.bodies) {
    let v = W.vis.get(b.id);
    if (!v) { v = new BodyVis(b); W.vis.set(b.id, v); }
    v.inner.position.set(-b.pivot[0], -b.pivot[1], -b.pivot[2]);
    for (const p of b.parts) v.attach(p);
    v.detachMissing();
  }
}

// ---------------------------------------------------------------------------
// 每帧：箭体姿态、尾焰、动画
// ---------------------------------------------------------------------------
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion();
const AX = new V3(1, 0, 0), AZ = new V3(0, 0, 1);
function bodyQuat(sim, b, v, out) {
  const beta = b.att - sim.omega * sim.t;
  qA.setFromAxisAngle(AZ, -beta);
  qB.setFromAxisAngle(AX, b.zTilt || 0);
  return out.copy(qA).multiply(qB).multiply(v.tumbleQ);
}

function targetInfo(b) {
  const sim = W.sim; const v = W.vis.get(b.id);
  const q = bodyQuat(sim, b, v, new THREE.Quaternion());
  const origin = bodyScenePos(sim, b, new V3());
  let ymin = 1e9, ymax = -1e9, rmax = 1;
  for (const p of b.parts) { ymin = Math.min(ymin, p.def.y0 ?? 0); ymax = Math.max(ymax, (p.def.y0 ?? 0) + (p.def.len || 1)); rmax = Math.max(rmax, (p.def.diam || 1) / 2 + Math.hypot(p.def.offset?.[0] || 0, p.def.offset?.[2] || 0)); }
  const cy = (ymin + ymax) / 2;
  const center = new V3(-b.pivot[0], cy - b.pivot[1], -b.pivot[2]).applyQuaternion(q).add(origin);
  const phi = Math.atan2(origin.x, origin.y + RE);
  const up = new V3(Math.sin(phi), Math.cos(phi), 0);
  // 助推器回收：地面跟踪时镜头适当放大一些
  return { center, size: ymax - ymin, quat: q, origin: origin.clone().add(new V3(-b.pivot[0], -b.pivot[1], -b.pivot[2]).applyQuaternion(q)), up, bodyR: rmax, onboardY: Math.min(ymax - 4, ymin + (ymax - ymin) * 0.85), frame: 1.3 };
}

const tmpV = new V3(), tmpV2 = new V3();
function updateVisuals(dtReal, dtSim, time) {
  const sim = W.sim;
  syncBodies();
  const camPos = camera.position;
  let glows = [];
  for (const b of sim.bodies) {
    const v = W.vis.get(b.id);
    if (!v) continue;
    // 翻滚（被动物体的可视化角速度）
    if (b.tumble && b.status === 'flying') {
      const [wx, wy, wz] = b.tumble;
      qC.setFromEuler(new THREE.Euler(wx * dtSim, wy * dtSim, wz * dtSim)); v.tumbleQ.multiply(qC);
    }
    if (!v.prevPos) v.prevPos = new V3();
    v.prevPos.copy(v.group.position);
    bodyScenePos(sim, b, v.group.position);
    if (!v.vel) v.vel = new V3();
    if (dtSim > 0) v.vel.subVectors(v.group.position, v.prevPos).divideScalar(dtSim);
    bodyQuat(sim, b, v, v.group.quaternion);
    v.inner.position.set(-b.pivot[0], -b.pivot[1], -b.pivot[2]);
    // 落海的被动物体在数秒后隐藏
    const gone = b.status === 'impact' && b.kind !== 'stack' && sim.t - b.impactT > 4;
    v.group.visible = !gone && b.alive !== false || b.kind === 'stack';
    if (!v.group.visible) continue;
    // 可动部件
    for (const p of b.parts) {
      const rp = W.rocket.parts[p.id]; if (!rp || !rp.anim) continue;
      rp.anim.legs?.(b.legs); rp.anim.fins?.(b.fins);
    }
    // 尾焰
    const atm = atmosphere(Math.max(0, b.tel.hPivot));
    // 尾焰截断平面：发射台面 / 着陆区 / 回收船甲板 / 发射台台面（筷子捕获）
    let surf = 0;
    if (b.kind === 'stack') surf = W.vid === 'starship' ? 2 : W.veh.deckH * 0.6;
    else if (b.ctl?.target) surf = b.ctl.cfg.landing?.catchH ? W.veh.deckH : b.ctl.target.h - 1.6;
    const groundY = -(v.group.position.x ** 2 + v.group.position.z ** 2) / (2 * RE) + surf;
    for (const pl of v.plumes) {
      const part = b.parts.find((p) => p.id === pl.partId);
      const lit = [];
      if (pl.gi === -1) {
        const on = b.fx.motorUntil && sim.t < b.fx.motorUntil ? 1 : 0;
        for (let i = 0; i < 4; i++) lit.push(on);
      } else if (part) {
        const g = part.groups[pl.gi];
        const thr = g.thrAct * (b.kind === 'stack' ? b.thrFactor : 1);
        const litSet = new Set(g.order.slice(0, g.lit));
        for (let i = 0; i < g.n; i++) lit.push(litSet.has(i) ? thr : 0);
        // 喷管内壁 / 真空喷管延伸段发热
        const hot = g.lit > 0 ? Math.min(1, thr) : 0;
        if (pl.set.innerMat) pl.set.innerMat.emissiveIntensity = hot * 2.5;
        if (pl.set.outerMat && pl.set.e.glowNozzle) {
          pl.heat = THREE.MathUtils.lerp(pl.heat || 0, hot * (1 - Math.min(1, atm.p / 5000)), 1 - Math.exp(-dtSim / 25));
          pl.set.outerMat.emissiveIntensity = pl.heat * 1.4;
        }
      }
      pl.update(lit, atm.p, camera, time, groundY, b.tel.vSurf);
      if (pl.mesh.visible && pl.gi !== -1) {
        const F = b.tel.thrust || 0;
        pl.mesh.getWorldPosition(tmpV);
        glows.push({ pos: tmpV.clone(), F, prop: pl.set.e.prop, dist: tmpV.distanceTo(camPos), axis: new V3(0, -1, 0).applyQuaternion(v.group.quaternion), body: b, vis: v, pl });
      }
    }
    // 着陆腿 / 机械臂
    if (b.ctl && b.ctl.cfg.landing?.catchH && W.pad.setArms) {
      W.armClose = THREE.MathUtils.lerp(W.armClose || 0, b.status === 'caught' || (b.arms && b.tel.h - b.ctl.cfg.landing.catchH < 25) ? 1 : 0, 1 - Math.exp(-dtSim * 0.9));
      W.pad.setArms(W.armClose);
    }
  }
  // 发射前后：起竖架后倾、摆臂收回
  if (W.vid !== 'starship') {
    const t = sim.t;
    const armV = THREE.MathUtils.clamp((t + 1.5) / 5, 0, 1);
    W.pad.setArms(armV);
    W.pad.setTE(THREE.MathUtils.clamp((t + 20) / 12, 0, 1));
  }
  // 火光：取最近 3 个
  glows.sort((a, b) => a.dist - b.dist);
  const glowPos = smoke.uniforms.uGlowPos.value, glowCol = smoke.uniforms.uGlowCol.value, glowR = smoke.uniforms.uGlowR.value;
  for (let i = 0; i < 3; i++) {
    const gl = glows[i], L = glowLights[i];
    if (gl) {
      const mn = gl.F / 1e6;
      const colr = gl.prop === 'methalox' ? new THREE.Color(1.0, 0.62, 0.45) : gl.prop === 'hydrolox' ? new THREE.Color(0.8, 0.75, 1.0) : new THREE.Color(1.0, 0.62, 0.3);
      const k = gl.prop === 'hydrolox' ? 0.35 : 1;
      L.position.copy(gl.pos).addScaledVector(gl.axis, 6 + gl.pl.clusterR * 3);
      L.color.copy(colr); L.intensity = Math.sqrt(mn) * 2600 * k; L.distance = 0; L.decay = 2;
      glowPos[i].copy(L.position); glowCol[i].copy(colr).multiplyScalar(0.7 * k * Math.min(1, Math.sqrt(mn) / 4)); glowR[i] = 15 + gl.pl.clusterR * 8;
    } else { L.intensity = 0; glowPos[i].set(0, -1e9, 0); glowCol[i].setRGB(0, 0, 0); }
  }
  emitParticles(dtSim, glows);
  smoke.update(dtSim);
}

// ---------------------------------------------------------------------------
// 粒子发射：导流槽蒸汽、尾迹、着陆扬尘、RCS、分离
// ---------------------------------------------------------------------------
const rnd = (a, b) => a + Math.random() * (b - a);
function emitParticles(dt, glows) {
  if (dt <= 0) return;
  const sim = W.sim, veh = W.veh;
  const fast = W.speed > 12;
  for (const gl of glows) {
    const b = gl.body, T = b.tel;
    const prop = gl.prop;
    const thrMN = (T.thrust || 0) / 1e6;
    const col = prop === 'kerolox' ? [0.78, 0.76, 0.73] : [0.93, 0.93, 0.94];
    const baseAlt = T.h - (b.kind === 'stack' ? veh.deckH : 0);
    // 1) 发射台：导流槽喷出的蒸汽与烟尘
    if (b.kind === 'stack' && baseAlt < 420 && !fast) {
      const k = THREE.MathUtils.clamp(1 - baseAlt / 420, 0, 1);
      const rate = Math.min(90, thrMN * 2.2) * k;
      const n = Math.floor(rate * dt + Math.random());
      const exits = W.pad.trenchExits;
      for (let i = 0; i < n; i++) {
        if (exits.length) {
          const ex = exits[i % exits.length];
          const dir = tmpV2.set(ex.x, 0, ex.z).normalize();
          smoke.emit({ x: ex.x + rnd(-8, 8), y: ex.y + rnd(0, 6), z: ex.z + rnd(-8, 8), vx: dir.x * rnd(25, 70) + rnd(-10, 10), vy: rnd(4, 16), vz: dir.z * rnd(25, 70) + rnd(-10, 10), size: rnd(10, 18), size1: rnd(60, 110), life: rnd(14, 24), alpha: 0.75, r: col[0] + 0.12, g: col[1] + 0.12, b: col[2] + 0.12, heat: 0.25, drag: 0.35, buoy: 2.2 });
        } else {
          const a = rnd(0, Math.PI * 2);
          smoke.emit({ x: Math.cos(a) * 8, y: rnd(2, 6), z: Math.sin(a) * 8, vx: Math.cos(a) * rnd(40, 90), vy: rnd(2, 12), vz: Math.sin(a) * rnd(40, 90), size: rnd(10, 16), size1: rnd(55, 100), life: rnd(12, 22), alpha: 0.7, r: 0.86, g: 0.82, b: 0.74, heat: 0.3, drag: 0.4, buoy: 1.8 });
        }
      }
      // 发射台上方翻滚的火光烟云
      const m = Math.floor(rate * 0.4 * dt + Math.random());
      for (let i = 0; i < m; i++) {
        const a = rnd(0, Math.PI * 2), r = rnd(4, 20);
        smoke.emit({ x: gl.pos.x + Math.cos(a) * r, y: veh.deckH + rnd(-2, 10), z: gl.pos.z + Math.sin(a) * r, vx: Math.cos(a) * rnd(8, 25), vy: rnd(3, 14), vz: Math.sin(a) * rnd(8, 25), size: rnd(8, 14), size1: rnd(40, 70), life: rnd(8, 14), alpha: 0.6, r: 0.9, g: 0.88, b: 0.86, heat: 0.8, drag: 0.5, buoy: 3 });
      }
    }
    // 2) 着陆 / 捕获时的扬尘与水汽
    if (b.kind === 'recovery' && b.ctl?.state === 'landing' && b.ctl.target) {
      const hRel = T.h - b.ctl.target.h;
      if (hRel < 120 && !fast) {
        const n = Math.floor(thrMN * 6 * (1 - hRel / 120) * dt + Math.random());
        const gy = gl.pos.y - hRel - 2;
        for (let i = 0; i < n; i++) {
          const a = rnd(0, Math.PI * 2);
          smoke.emit({ x: gl.pos.x + Math.cos(a) * 3, y: gy + rnd(0, 3), z: gl.pos.z + Math.sin(a) * 3, vx: Math.cos(a) * rnd(25, 55), vy: rnd(1, 8), vz: Math.sin(a) * rnd(25, 55), size: rnd(4, 8), size1: rnd(25, 45), life: rnd(5, 9), alpha: 0.55, r: 0.9, g: 0.9, b: 0.9, heat: 0.4, drag: 0.6, buoy: 1.5 });
        }
      }
    }
    // 3) 飞行尾迹（大气层内）：按飞行距离均匀布点
    if (T.h < 42000 && baseAlt > 30 && prop !== 'solid') {
      const plLen = gl.pl.uniforms.uLen.value;
      const tail = gl.pos.clone().addScaledVector(gl.axis, Math.min(plLen * 1.1, 400));
      const v = gl.vis;
      if (!v.lastTrail) v.lastTrail = tail.clone();
      const d = tail.distanceTo(v.lastTrail);
      const hk = T.h / 1000;
      const s0 = gl.pl.clusterR * 3.2 * (1 + hk / 10), s1 = s0 * (hk > 25 ? 12 : 6);
      const spacing = Math.max(2.5, s0 * 0.3);
      let steps = Math.min(60, Math.floor(d / spacing));
      const a0 = prop === 'hydrolox' ? 0.3 : prop === 'methalox' ? 0.5 : 0.62;
      for (let i = 1; i <= steps; i++) {
        const p = v.lastTrail.clone().lerp(tail, i / steps);
        smoke.emit({ x: p.x + rnd(-1, 1) * s0 * 0.2, y: p.y, z: p.z + rnd(-1, 1) * s0 * 0.2, vx: rnd(-2, 2), vy: rnd(-2, 2), vz: rnd(-2, 2), size: s0, size1: s1, life: rnd(50, 80), alpha: a0 * (1 - THREE.MathUtils.smoothstep(hk, 14, 42)), r: col[0], g: col[1], b: col[2], heat: 0.35, drag: 0.08, buoy: 0.05, grow: 0.35, wind: hk < 15 ? 1 : 0.3 });
      }
      if (steps > 0) v.lastTrail.copy(tail);
    } else if (gl.vis) gl.vis.lastTrail = null;
  }
  // 4) RCS 冷气喷流 / 分离火箭 / 排气
  for (const b of sim.bodies) {
    const v = W.vis.get(b.id); if (!v || !v.group.visible) continue;
    const info = targetInfo(b);
    if (b.fx.rcs && Math.random() < dt * 20) {
      const top = new V3(0, info.size * 0.45, 0).applyQuaternion(info.quat).add(info.center);
      const side = new V3(Math.sign(b.attRate) * (info.bodyR + 0.5), 0, 0).applyQuaternion(info.quat);
      smoke.emit({ x: top.x + side.x, y: top.y + side.y, z: top.z + side.z, vx: side.x * 12 + v.vel.x, vy: side.y * 12 + v.vel.y, vz: side.z * 12 + v.vel.z, size: 0.8, size1: 7, life: 1.4, alpha: 0.5, r: 0.95, g: 0.95, b: 0.97, drag: 1.5, buoy: 0, wind: 0 });
    }
    if ((b.fx.retroUntil && sim.t < b.fx.retroUntil) || (b.fx.ullageUntil && sim.t < b.fx.ullageUntil)) {
      for (let i = 0; i < 6; i++) {
        const top = new V3(rnd(-1, 1) * info.bodyR, info.size * (b.fx.retroUntil ? 0.48 : -0.45), rnd(-1, 1) * info.bodyR).applyQuaternion(info.quat).add(info.center);
        const dir = new V3(0, b.fx.retroUntil ? 1 : -1, 0).applyQuaternion(info.quat).multiplyScalar(rnd(60, 120));
        smoke.emit({ x: top.x, y: top.y, z: top.z, vx: dir.x + v.vel.x, vy: dir.y + v.vel.y, vz: dir.z + v.vel.z, size: 1.5, size1: 16, life: 3, alpha: 0.7, r: 1, g: 0.95, b: 0.85, heat: 1.2, drag: 1.2, buoy: 0, wind: 0 });
      }
    }
    if (b.fx.motorUntil && sim.t < b.fx.motorUntil) {
      for (let i = 0; i < 4; i++) {
        const p = new V3(rnd(-0.3, 0.3), 5.2, rnd(-0.3, 0.3)).applyQuaternion(info.quat).add(info.center);
        const dir = new V3(rnd(-0.5, 0.5), -1, rnd(-0.5, 0.5)).applyQuaternion(info.quat).multiplyScalar(80);
        smoke.emit({ x: p.x, y: p.y, z: p.z, vx: dir.x + v.vel.x, vy: dir.y + v.vel.y, vz: dir.z + v.vel.z, size: 1, size1: 14, life: 4, alpha: 0.6, r: 1, g: 0.97, b: 0.92, heat: 1, drag: 1.4, buoy: 0, wind: 0 });
      }
    }
    // 星舰热分离：飞船发动机在与助推器连接时点火，火焰从热分离环排气口径向喷出
    const shipP = b.parts.find((p) => p.id === 'ship'), boosterP = b.parts.find((p) => p.id === 'booster');
    if (shipP && boosterP && shipP.groups.some((g) => g.lit && g.thrAct > 0.05)) {
      const nv = Math.min(12, Math.floor(dt * 160 + Math.random()));
      for (let i = 0; i < nv; i++) {
        const a = rnd(0, Math.PI * 2);
        const loc = new V3(Math.cos(a) * 4.6, 70.1 - b.pivot[1], Math.sin(a) * 4.6);
        const p = loc.clone().applyQuaternion(info.quat).add(v.group.position);
        const dir = new V3(Math.cos(a), rnd(-0.25, 0.1), Math.sin(a)).applyQuaternion(info.quat).multiplyScalar(rnd(90, 180));
        smoke.emit({ x: p.x, y: p.y, z: p.z, vx: dir.x + v.vel.x, vy: dir.y + v.vel.y, vz: dir.z + v.vel.z, size: 1.5, size1: 16, life: 0.9, alpha: 0.55, r: 1, g: 0.8, b: 0.65, heat: 0.45, drag: 1.5, buoy: 0, wind: 0 });
      }
    }
    // 发射前推进剂蒸发排气（液氧低温排放形成的白色冷凝雾）
    if (b.clamped && sim.t < 0 && !fast && Math.random() < dt * 14) {
      const y = info.size * rnd(-0.1, 0.42);
      const a = rnd(0, Math.PI * 2);
      const p = new V3(Math.cos(a) * info.bodyR * 0.9, y, Math.sin(a) * info.bodyR * 0.9).applyQuaternion(info.quat).add(info.center);
      smoke.emit({ x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * 1.5, vy: -rnd(1, 3), vz: Math.sin(a) * 1.5, size: 1.5, size1: 9, life: 5, alpha: 0.28, r: 0.97, g: 0.98, b: 1, drag: 0.8, buoy: -0.4, wind: 0.6 });
    }
  }
  if (W.sepFx) {
    const { src } = W.sepFx; W.sepFx = null;
    if (src && !fast) {
      const info = targetInfo(src);
      for (let i = 0; i < 30; i++) {
        const p = new V3(rnd(-1, 1) * info.bodyR, -info.size * 0.5 + rnd(-2, 2), rnd(-1, 1) * info.bodyR).applyQuaternion(info.quat).add(info.center);
        const a = rnd(0, Math.PI * 2);
        smoke.emit({ x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * rnd(5, 15), vy: rnd(-5, 5), vz: Math.sin(a) * rnd(5, 15), size: 1.5, size1: 12, life: 3, alpha: 0.5, r: 0.95, g: 0.95, b: 0.96, drag: 1, buoy: 0, wind: 0 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 环境：天空、光照、雾、地影
// ---------------------------------------------------------------------------
const earthCenter = new V3(0, -RE, 0);
const hzCol = new THREE.Color();
function updateEnvironment(time, tgt) {
  const camKm = tmpV.copy(camera.position).sub(earthCenter).multiplyScalar(0.001);
  sky.uniforms.uCamKm.value.copy(camKm); earth.uniforms.uCamKm.value.copy(camKm);
  const altKm = camKm.length() - 6371;
  // 太阳入射按"观察目标"所在高度计算：高空的火箭在地面已日落时仍被阳光照亮（晨昏"水母"效应）
  const tp = tgt ? tmpV2.copy(tgt).sub(earthCenter) : camKm.clone().multiplyScalar(1000);
  const tAlt = Math.max(0, tp.length() / 1000 - 6371);
  const mu = sunDir.dot(tp.normalize());
  const elev = Math.asin(THREE.MathUtils.clamp(mu, -1, 1));
  const dip = Math.acos(6371 / (6371 + tAlt));                       // 该高度的地平线下倾角
  const zen = 90 - (Math.max(elev, -dip * 0.5) * 180) / Math.PI;
  const airmass = 1 / Math.max(0.02, Math.cos((Math.min(zen, 90) * Math.PI) / 180) + 0.15 * Math.pow(Math.max(0.5, 93.885 - zen), -1.253));
  const thin = Math.exp(-tAlt / 8);
  const tau = [0.1, 0.2, 0.42].map((k) => Math.exp(-k * airmass * thin * 1.4));
  const shadow = THREE.MathUtils.smoothstep(elev, -dip - 0.006, -dip + 0.006);
  sun.color.setRGB(tau[0], tau[1], tau[2]);
  sun.intensity = 3.2 * shadow;
  horizonColor(sunDir, altKm, hzCol);
  hemi.color.copy(hzCol).multiplyScalar(1.1); hemi.groundColor.setRGB(0.25, 0.22, 0.18).multiplyScalar(Math.max(0.05, THREE.MathUtils.smoothstep(sunDir.y, -0.15, 0.3)));
  const thinC = Math.exp(-Math.max(0, altKm) / 8);
  hemi.intensity = 0.5 * (0.15 + 0.85 * thinC) + 0.04;
  scene.fog.color.copy(hzCol);
  scene.fog.density = 2.2e-5 * Math.exp(-Math.max(0, altKm) / 7);
  smoke.uniforms.fogColor.value.copy(hzCol); smoke.uniforms.fogDensity.value = scene.fog.density;
  smoke.uniforms.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
  smoke.uniforms.uAmb.value.copy(hzCol).multiplyScalar(0.55).addScalar(0.02);
  sky.uniforms.uStars.value = THREE.MathUtils.smoothstep(altKm, 20, 70) * 0.9 + (1 - THREE.MathUtils.smoothstep(sunDir.y, -0.25, -0.05)) * 0.7;
  earth.uniforms.uCloudRot.value = time * 1e-6;
  if (W?.terrain) W.terrain.uniforms.uTime.value = time;
  if (W?.patch) W.patch.uniforms.uTime.value = time;
  updateEnv(Math.max(0, altKm), todKey);
  // 曝光：太空中略降，夜间略升
  // 自动曝光：按相机处太阳高度角（晨昏与夜间提高曝光，类似真实相机）
  const elC = (Math.asin(THREE.MathUtils.clamp(sunDir.dot(camKm.clone().normalize()), -1, 1)) * 180) / Math.PI;
  const dipC = (Math.acos(6371 / (6371 + Math.max(altKm, 0))) * 180) / Math.PI;
  const e = elC + dipC;
  const target = e > 6 ? 1 : e > -10 ? THREE.MathUtils.lerp(9, 1, Math.pow((e + 10) / 16, 1.5)) : 9;
  renderer.toneMappingExposure += (target - renderer.toneMappingExposure) * 0.08;
  // 泛光与曝光联动：保持屏幕上的泛光观感一致（避免高曝光时模糊核截断成方形光晕）
  const ex = renderer.toneMappingExposure;
  bloom.threshold = 1.6 / ex; bloom.strength = 0.55 / Math.pow(ex, 0.85);
}

function updateShadows(center, size) {
  const d = Math.max(60, Math.min(size * 2.2, 900));
  sun.target.position.copy(center);
  sun.position.copy(center).addScaledVector(sunDir, 2000);
  const sc = sun.shadow.camera;
  if (sc.right !== d) { sc.left = -d; sc.right = d; sc.top = d; sc.bottom = -d; sc.near = 10; sc.far = 4000; sc.updateProjectionMatrix(); }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const SPEEDS = [1, 2, 5, 10, 25, 50];
function buildSelectors() {
  const sv = $('selVeh');
  sv.innerHTML = Object.values(VEHICLES).map((v) => `<option value="${v.id}">${v.nameCN}</option>`).join('');
  sv.onchange = () => { fillMissions(); start(sv.value, $('selMis').value); };
  $('selMis').onchange = () => start(sv.value, $('selMis').value);
  fillMissions();
  $('speedSeg').innerHTML = SPEEDS.map((s) => `<button data-s="${s}">${s}×</button>`).join('');
  $('speedSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => setSpeed(+b.dataset.s)));
  $('camSeg').innerHTML = CAM_MODES.map((m) => `<button data-m="${m.id}" title="快捷键 ${m.key}">${m.name}</button>`).join('');
  $('camSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => setCam(b.dataset.m)));
  $('selTod').onchange = (e) => setTOD(e.target.value);
  $('btnGo').onclick = toggleGo;
  $('btnReset').onclick = () => start(W.vid, W.mid);
  $('btnNext').onclick = skipToNext;
}
function fillMissions() {
  const v = VEHICLES[$('selVeh').value];
  $('selMis').innerHTML = Object.entries(v.missions).map(([k, m]) => `<option value="${k}">${m.short}</option>`).join('');
}
let uiOn = true;
function toggleUI(v) { uiOn = v ?? !uiOn; document.body.classList.toggle('noui', !uiOn); }
function setSpeed(s) { if (!W) return; W.speed = s; $('speedSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.s === s)); }
function setCam(m) {
  if (!W) return;
  const b = W.sim.bodies.find((x) => x.id === W.target) || W.sim.stack;
  rig.setMode(m, targetInfo(b));
  $('camSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.m === m));
}
function toggleGo() {
  if (!W) return;
  W.running = !W.running; updateGoButton();
}
function updateGoButton() {
  const b = $('btnGo');
  if (!W) return;
  if (!W.started && !W.running) { b.textContent = '▶ 开始倒计时'; b.classList.remove('hold'); }
  else if (W.running) { b.textContent = '❚❚ 暂停'; b.classList.add('hold'); W.started = true; }
  else { b.textContent = '▶ 继续'; b.classList.remove('hold'); }
  document.body.classList.toggle('prelaunch', !W.started);
}
function skipToNext() {
  if (!W) return;
  const sim = W.sim; const n0 = sim.log.length; const tEnd = sim.t + 900;
  W.started = true;
  while (sim.log.length === n0 && sim.t < tEnd) sim.step();
  smoke.clear();
  for (const v of W.vis.values()) v.lastTrail = null;
  if (!W.running) W.running = true;
  updateGoButton();
}
function buildTargetSeg() {
  if (!W) return;
  const key = W.sim.bodies.filter(isTargetable).map((b) => b.id).join(',');
  if (key === W.tgtKey) return; W.tgtKey = key;
  const seg = $('tgtSeg');
  seg.innerHTML = W.sim.bodies.filter(isTargetable).map((b) => `<button data-b="${b.id}">${b.kind === 'stack' ? '主箭' : b.name}</button>`).join('');
  seg.querySelectorAll('button').forEach((x) => (x.onclick = () => setTarget(+x.dataset.b)));
  markTarget();
}
function isTargetable(b) { return !b.parts.some((p) => p.half) && (b.kind !== 'passive' || b.parts.some((p) => p.prop0 > 0 || p.id === 'payload' || p.id === 'les')); }
function setTarget(id) {
  W.target = id; markTarget();
  const b = W.sim.bodies.find((x) => x.id === id);
  rig.setMode(rig.mode, targetInfo(b));
  const info = targetInfo(b);
  if (rig.mode === 'orbit') { const d = info.size * 1.8; camera.position.copy(info.center).add(new V3(d * 0.5, d * 0.05, d)); rig.controls.target.copy(info.center); rig.prevTarget.copy(info.center); }
}
function markTarget() { $('tgtSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.b === W.target)); }

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); toggleGo(); }
  const m = CAM_MODES.find((x) => x.key === e.key); if (m) setCam(m.id);
  if (e.key === 'n' || e.key === 'N') skipToNext();
  if (e.key === 'h' || e.key === 'H') toggleUI();
  if (e.key === 'r' || e.key === 'R') start(W.vid, W.mid);
  if (e.key === ']') setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(W.speed) + 1)]);
  if (e.key === '[') setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(W.speed) - 1)]);
  if (e.key === 't' || e.key === 'T') { const list = W.sim.bodies.filter(isTargetable); const i = list.findIndex((b) => b.id === W.target); setTarget(list[(i + 1) % list.length].id); }
});

let sizeW = 0, sizeH = 0;
function syncSize() {
  // 窗口被最小化/隐藏时尺寸为 0，此时不调整，避免创建零尺寸渲染目标
  if (innerWidth < 2 || innerHeight < 2 || (innerWidth === sizeW && innerHeight === sizeH)) return;
  sizeW = innerWidth; sizeH = innerHeight;
  camera.aspect = sizeW / sizeH; camera.updateProjectionMatrix();
  renderer.setSize(sizeW, sizeH, false); composer.setSize(sizeW, sizeH);
}
addEventListener('resize', syncSize);

async function start(vid, mid) {
  const prevCam = rig.mode;
  await loadWorld(vid, mid);
  setSpeed(1);
  setCam(prevCam || 'orbit');
  $('selVeh').value = vid; $('selMis').value = mid;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
let last = performance.now(), hudAcc = 0, chartAcc = 0, fpsAcc = 0, fpsN = 0, simTime0 = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.1, (now - last) / 1000); last = now;
  tick(dtReal, now);
}
function tick(dtReal, now, draw = true) {
  const time = (now - simTime0) / 1000;
  if (!W) return;
  const sim = W.sim;
  let dtSim = 0;
  if (W.running) {
    W.acc += dtReal * W.speed;
    const t0 = sim.t;
    let guard = 0;
    while (W.acc >= DT && guard++ < 4000) { sim.step(); W.acc -= DT; }
    dtSim = sim.t - t0;
  }
  // 事件
  while (W.newEvents.length) { const e = W.newEvents.shift(); hud.event(e); }
  // 目标箭体
  let tb = sim.bodies.find((b) => b.id === W.target);
  if (!tb || (!tb.alive && tb.kind !== 'stack')) { tb = sim.stack; W.target = tb.id; }
  syncBodies();
  const info = targetInfo(tb);
  updateVisuals(dtReal, dtSim, time);
  rig.update(dtReal, info);
  updateShadows(info.center, info.size);
  updateEnvironment(time, info.center);
  // HUD
  hudAcc += dtReal; chartAcc += dtReal;
  if (hudAcc > 0.08) {
    hudAcc = 0;
    $('clock').textContent = fmtT(sim.t);
    const lastEv = sim.log[sim.log.length - 1];
    $('phase').textContent = !W.started ? '待命 · 准备发射' : sim.t < 0 ? '发射倒计时' : lastEv ? lastEv.label.replace(/ · [\d.]+ kPa/, '') : '';
    hud.telemetry(tb, sim); hud.engines(tb, W.veh); hud.props(sim);
    buildTargetSeg();
  }
  if (chartAcc > 0.25) { chartAcc = 0; hud.chart(sim, tb); }
  syncSize();
  if (draw && sizeW > 0) composer.render(dtReal);
  // 自适应分辨率
  fpsAcc += dtReal; fpsN++;
  if (fpsAcc > 2) {
    const fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
    if (fps < 34 && pixelRatio > 0.75) { pixelRatio = Math.max(0.75, pixelRatio - 0.2); renderer.setPixelRatio(pixelRatio); composer.setPixelRatio(pixelRatio); }
    else if (fps > 57 && pixelRatio < Math.min(devicePixelRatio, 1.6)) { pixelRatio = Math.min(Math.min(devicePixelRatio, 1.6), pixelRatio + 0.1); renderer.setPixelRatio(pixelRatio); composer.setPixelRatio(pixelRatio); }
  }
}

buildSelectors();
setTOD('morning');
$('credit').textContent = IMAGERY_CREDIT + ' · 地球贴图：NASA Blue Marble（three.js 示例资源）';
const params = new URLSearchParams(location.search);
const v0 = params.get('v') && VEHICLES[params.get('v')] ? params.get('v') : 'falcon9';
$('selVeh').value = v0; fillMissions();
const m0 = params.get('m') && VEHICLES[v0].missions[params.get('m')] ? params.get('m') : Object.keys(VEHICLES[v0].missions)[0];
start(v0, m0).then(() => { if (params.get('cam')) setCam(params.get('cam')); if (params.get('tod')) { $('selTod').value = params.get('tod'); setTOD(params.get('tod')); } });
requestAnimationFrame(frame);

// 调试接口
window.__lab = {
  get W() { return W; }, camera, scene, renderer, rig, setCam, setTarget, skipToNext, setSpeed, setTOD, toggleUI,
  // 手动推进若干帧（调试 / 后台截图用）
  view(dx, dy, dz) { const c = rig.controls.target.clone(); camera.position.set(c.x + dx, c.y + dy, c.z + dz); rig.prevTarget.copy(c); this.advance(0.1, 10); },
  god(x, y, z, tx, ty, tz, fov = 50) { rig.mode = 'none'; camera.fov = fov; camera.updateProjectionMatrix(); camera.up.set(0, 1, 0); camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); this.advance(0.05, 20); },
  go(t) { W.running = true; W.started = true; updateGoButton(); if (t != null) this.advance(t - W.sim.t, 10); return W.sim.t; },
  advance(sec, fps = 30) { const n = Math.round(sec * fps); let now = performance.now(); for (let i = 0; i < n; i++) { now += 1000 / fps; tick(1 / fps, now, i === n - 1); } return W.sim.t; },
};
