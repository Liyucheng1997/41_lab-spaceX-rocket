// 各型火箭的程序化三维模型（真实尺寸，单位 m）
// 箭体坐标：y 轴沿箭体向上，原点为一级喷管出口平面；+z 朝向默认相机（涂装正面），+x 为下航程方向
import * as THREE from 'three';
import { ENGINES } from '../physics/engines.js';
import {
  M, TAU, paintTexture, steelMaterial, tileMaterial, buildEngine, bellGeometry, gridFinGeometry, rectGridFinGeometry,
  lathe, ogive, tube, meshOf, mergeGeometries, hotNozzleMaterial, canvasTex, mat,
} from './parts.js';

const FRONT = 180; // 涂装中面向 +z 的角度（tube 几何已绕 y 旋转 180°）

function paintedTube(R, y0, y1, spec, seg = 72) {
  const g = tube(R, y0, y1, seg); g.rotateY(Math.PI);
  const tex = paintTexture({ circ: TAU * R, length: y1 - y0, ...spec });
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: spec.rough ?? 0.45, metalness: spec.metal ?? 0.0 });
  return meshOf(g, m);
}
function disk(R, y, material, flip = false) {
  const g = new THREE.CircleGeometry(R, 48); g.rotateX(flip ? Math.PI / 2 : -Math.PI / 2); g.translate(0, y, 0);
  return meshOf(g, material, false);
}
function ringAt(R, r, y, material) { const g = new THREE.TorusGeometry(R, r, 6, 64); g.rotateX(Math.PI / 2); g.translate(0, y, 0); return meshOf(g, material, false); }

/** 按布局放置发动机，返回可视实例列表（供尾焰与喷管发光使用） */
function addEngines(parent, type, layout, yExit, offset = [0, 0, 0], opts = {}) {
  const e = ENGINES[type];
  const list = [];
  const innerMat = hotNozzleMaterial();
  const outerMat = new THREE.MeshStandardMaterial({ color: e.color, roughness: 0.42, metalness: 0.9, emissive: new THREE.Color(e.glowNozzle ? 0xff4a10 : 0xff5a18), emissiveIntensity: 0 });
  layout.forEach(([x, z], i) => {
    const eng = buildEngine(e, { innerMat, outerMat, exhaustDuct: e.prop === 'kerolox', ...opts });
    eng.position.set(x + offset[0], yExit, z + offset[2]);
    if (opts.rotY != null) eng.rotation.y = opts.rotY;
    parent.add(eng);
    list.push({ pos: new THREE.Vector3(x + offset[0], yExit, z + offset[2]), exitR: (opts.exitD || e.exitD) / 2, obj: eng, index: i });
  });
  return { type, e, list, innerMat, outerMat };
}

// ===========================================================================
// 猎鹰系列通用一级（F9 一级 / FH 芯级 / FH 侧助推器）
// ===========================================================================
function falconCore(opts) {
  const g = new THREE.Group();
  const R = 1.83, off = opts.offset || [0, 0, 0];
  const top = opts.nosecone ? 41.2 : 47.3;
  const inner = new THREE.Group(); inner.position.set(off[0], 0, off[2]); g.add(inner);
  // 发动机：八角网格布局
  const layout = [[0, 0], ...Array.from({ length: 8 }, (_, i) => { const a = Math.PI / 8 + (i * TAU) / 8; return [1.25 * Math.cos(a), 1.25 * Math.sin(a)]; })];
  const engines = addEngines(g, 'merlin1d', layout, 0, off, { noRibs: true });
  // 底部防热板与发动机舱
  inner.add(disk(R, 1.28, M.black(), true));
  inner.add(meshOf(tube(R * 1.005, 0.95, 1.9, 48, true), M.black()));
  // 箭体涂装
  const texts = opts.label !== false ? [{ text: 'SPACEX', y: 26, angle: FRONT, size: 1.55, vertical: true, color: '#101010', spacing: 0.08, font: '"Arial Black",Arial,sans-serif' }] : [];
  inner.add(paintedTube(R, 1.9, 41.2, {
    base: '#f3f3f1', texts, flags: opts.label !== false ? [{ y: 37.2, angle: FRONT, h: 1.05, type: 'us' }] : [],
    soot: { h: opts.sooty ? 16 : 5.5, a: opts.sooty ? 0.55 : 0.28 }, panels: { dy: 3.9, y0: 2.6, color: 'rgba(0,0,0,0.07)' },
  }));
  // 外部电缆槽（raceway）
  const rw = meshOf(new THREE.BoxGeometry(0.34, 38.5, 0.28), M.offwhite()); rw.position.set(R + 0.1, 21.4, 0); inner.add(rw);
  if (opts.nosecone) {
    const nose = meshOf(lathe(ogive(R, 5.8, 41.2, 24, 0.25), 48), M.white()); inner.add(nose);
  } else {
    // 级间段（碳纤维，黑色）+ 内壁
    const ist = meshOf(tube(R * 1.004, 41.2, 47.3, 64), M.carbon()); inner.add(ist);
    const istIn = meshOf(tube(R * 0.99, 41.2, 47.3, 48), new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.9, side: THREE.BackSide })); inner.add(istIn);
    inner.add(ringAt(R * 1.01, 0.05, 47.3, M.darkMetal()));
    // 冷气推力器舱
    for (const a of [0, Math.PI]) { const p = meshOf(new THREE.BoxGeometry(0.5, 0.9, 0.35), M.darkMetal()); p.position.set(Math.cos(a) * (R + 0.12), 46.2, Math.sin(a) * (R + 0.12)); p.rotation.y = -a; inner.add(p); }
  }
  // 栅格翼（钛合金）：收起时贴附箭体，展开时向外水平伸出
  const fins = [];
  const finY = opts.nosecone ? 40.2 : 46.1;
  const finGeo = gridFinGeometry(1.25, 1.55, 0.22, 7, 7, 0.07, 0.022);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4;
    const hinge = new THREE.Group(); hinge.position.set(Math.cos(a) * (R + 0.08), finY, Math.sin(a) * (R + 0.08));
    hinge.rotation.y = -a; // 局部 +x 指向径向外侧
    const fin = meshOf(finGeo, M.titanium()); fin.rotation.y = Math.PI / 2; fin.position.set(0.02, -0.78, 0);
    const pivot = new THREE.Group(); pivot.add(fin); hinge.add(pivot);
    const act = meshOf(new THREE.BoxGeometry(0.18, 0.5, 0.3), M.darkMetal()); act.position.set(0.05, -0.1, 0); hinge.add(act);
    inner.add(hinge); fins.push(pivot);
  }
  // 着陆腿：碳纤维主梁 + 伸缩推杆 + 足垫
  const legs = [];
  if (opts.legs !== false) {
    const L = 8.2, hy = 2.6, hr = R + 0.18;
    const legGeo = new THREE.BoxGeometry(0.34, L, 1.0); legGeo.translate(0, L / 2, 0);
    const pa = legGeo.attributes.position; for (let i = 0; i < pa.count; i++) { const t = pa.getY(i) / L; pa.setZ(i, pa.getZ(i) * (1 - 0.45 * t)); pa.setX(i, pa.getX(i) * (1 - 0.3 * t)); }
    legGeo.computeVertexNormals();
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * TAU) / 4;
      const base = new THREE.Group(); base.position.set(Math.cos(a) * hr, hy, Math.sin(a) * hr); base.rotation.y = -a;
      const pivot = new THREE.Group(); base.add(pivot);
      const leg = meshOf(legGeo, M.carbon()); leg.position.x = 0.17; pivot.add(leg);
      const foot = meshOf(new THREE.CylinderGeometry(0.55, 0.62, 0.22, 20), M.darkMetal()); foot.position.set(0.3, L, 0); pivot.add(foot);
      const stripe = meshOf(new THREE.BoxGeometry(0.36, 0.5, 0.95), M.white()); stripe.position.set(0.17, 6.2, 0); pivot.add(stripe);
      const strut = meshOf(new THREE.CylinderGeometry(0.1, 0.1, 1, 8), M.pipe()); strut.position.set(0, 0, 0); base.add(strut);
      inner.add(base);
      legs.push({ pivot, strut, L });
    }
  }
  const setLegs = (v) => {
    for (const l of legs) {
      const th = v * 2.11; // 0 → 121°
      l.pivot.rotation.z = -th;
      // 推杆：箭体上端点 → 腿中部
      const A = new THREE.Vector3(-0.05, 5.4, 0);
      const Bl = new THREE.Vector3(0.17 + Math.sin(th) * 0.55 * l.L, Math.cos(th) * 0.55 * l.L, 0);
      const mid = A.clone().add(Bl).multiplyScalar(0.5), d = Bl.clone().sub(A);
      l.strut.position.copy(mid); l.strut.scale.set(1, d.length(), 1);
      l.strut.rotation.z = Math.atan2(-d.x, d.y);
    }
  };
  const setFins = (v) => { for (const f of fins) f.rotation.z = (-Math.PI / 2) * (1 - v); };
  setLegs(0); setFins(0);
  // FH 侧助推器与芯级连接桁架
  if (opts.struts) {
    for (const y of [3.2, 40.3]) {
      const s = meshOf(new THREE.BoxGeometry(0.35, 0.35, 0.5), M.darkMetal()); s.position.set(0, y, -Math.sign(off[2]) * (R + 0.25)); inner.add(s);
    }
  }
  return { obj: g, engines: [engines], anim: { legs: setLegs, fins: setFins }, top };
}

function falconS2(yBase = 43.1) {
  const g = new THREE.Group(), R = 1.83;
  const e = ENGINES.mvac;
  const nozInner = hotNozzleMaterial(0x2a2826);
  const nozOuter = new THREE.MeshStandardMaterial({ color: 0x3b3835, roughness: 0.55, metalness: 0.85, emissive: new THREE.Color(0xff3a08), emissiveIntensity: 0 });
  const eng = buildEngine(e, { innerMat: nozInner, outerMat: nozOuter, throat: 0.16, chamber: 0.2, noRibs: false, exhaustDuct: true });
  eng.position.y = yBase; g.add(eng);
  const engines = { type: 'mvac', e, list: [{ pos: new THREE.Vector3(0, yBase, 0), exitR: e.exitD / 2, obj: eng, index: 0 }], innerMat: nozInner, outerMat: nozOuter };
  g.add(disk(R, 47.3, M.darkMetal(), true));
  g.add(paintedTube(R, 47.3, 56.9, { base: '#f2f2f0', bands: [{ y0: 9.2, y1: 9.6, color: '#1a1a1a' }], panels: { dy: 3.2, y0: 0.5, color: 'rgba(0,0,0,0.06)' } }));
  return { obj: g, engines: [engines] };
}

function falconFairing(payloadKind = 'starlink') {
  const halves = [];
  const prof = [[1.83, 56.9], [2.6, 58.0], ...ogive(2.6, 6.7, 63.3, 30, 0.18)];
  prof.splice(2, 0, [2.6, 63.3]);
  for (const side of [-1, 1]) {
    const hg = new THREE.Group();
    // side=-1 → −z 半边；side=+1 → +z 半边（LatheGeometry φ=0 指向 +z）
    const phi0 = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    const geo = lathe(prof, 36, phi0, Math.PI);
    const tex = paintTexture({ circ: TAU * 2.6 / 2, length: 13.1, base: '#f4f4f2', panels: { dy: 13, nx: 0 } });
    const m = meshOf(geo, new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.4, side: THREE.DoubleSide }));
    hg.add(m);
    // 分离面加强筋
    const rail = meshOf(new THREE.BoxGeometry(0.12, 6.4, 0.1), M.offwhite()); rail.position.set(0, 60.4, 0);
    for (const sx of [-1, 1]) { const r = rail.clone(); r.position.x = sx * 2.58; hg.add(r); }
    halves.push(hg);
  }
  const payload = new THREE.Group();
  if (payloadKind === 'starlink') {
    // 星链 V2 Mini 卫星叠放
    const satGeo = new THREE.BoxGeometry(2.8, 0.26, 3.6);
    for (let i = 0; i < 21; i++) {
      const s = meshOf(satGeo, i % 2 ? M.grey() : M.metal()); s.position.y = 57.8 + i * 0.3; payload.add(s);
      const sp = meshOf(new THREE.BoxGeometry(2.7, 0.02, 3.4), mat('solar', () => new THREE.MeshStandardMaterial({ color: 0x14203a, roughness: 0.25, metalness: 0.6 }))); sp.position.y = 57.95 + i * 0.3; payload.add(sp);
    }
    for (const x of [-1.5, 1.5]) { const rod = meshOf(new THREE.CylinderGeometry(0.06, 0.06, 6.6, 8), M.darkMetal()); rod.position.set(x, 61, 0); payload.add(rod); }
  } else {
    const bus = meshOf(new THREE.BoxGeometry(2.2, 3.2, 2.2), M.gold()); bus.position.y = 59.8; payload.add(bus);
    const pa = meshOf(new THREE.CylinderGeometry(0.9, 1.4, 0.8, 24), M.darkMetal()); pa.position.y = 57.8; payload.add(pa);
    for (const s of [-1, 1]) { const p = meshOf(new THREE.BoxGeometry(0.05, 2.8, 1.8), mat('solar', () => new THREE.MeshStandardMaterial({ color: 0x14203a, roughness: 0.25, metalness: 0.6 }))); p.position.set(s * 1.2, 60, 0); payload.add(p); }
  }
  return { halves, payload };
}

function buildFalcon9(veh) {
  const s1 = falconCore({ legs: true });
  const s2 = falconS2();
  const { halves, payload } = falconFairing('starlink');
  const fairing = new THREE.Group(); halves.forEach((h) => fairing.add(h));
  return {
    parts: {
      s1: { obj: s1.obj, engines: s1.engines, anim: s1.anim },
      s2: { obj: s2.obj, engines: s2.engines },
      fairing: { obj: fairing, halves },
      payload: { obj: payload },
    },
  };
}

function buildFalconHeavy() {
  const core = falconCore({ legs: true, label: true });
  const A = falconCore({ legs: true, nosecone: true, offset: [0, 0, -4.0], struts: true, label: false });
  const B = falconCore({ legs: true, nosecone: true, offset: [0, 0, 4.0], struts: true, label: false });
  const s2 = falconS2();
  const { halves, payload } = falconFairing('sat');
  const fairing = new THREE.Group(); halves.forEach((h) => fairing.add(h));
  return {
    parts: {
      core: { obj: core.obj, engines: core.engines, anim: core.anim },
      sideA: { obj: A.obj, engines: A.engines, anim: A.anim },
      sideB: { obj: B.obj, engines: B.engines, anim: B.anim },
      s2: { obj: s2.obj, engines: s2.engines },
      fairing: { obj: fairing, halves },
      payload: { obj: payload },
    },
  };
}

// ===========================================================================
// 星舰 / 超重型
// ===========================================================================
function buildStarship(veh) {
  const R = 4.5;
  // ---------- 超重型助推器 ----------
  const bst = new THREE.Group();
  const shLayout = veh.parts.booster.engines[0].layout;
  const bEng = addEngines(bst, 'raptor2', shLayout, 0, [0, 0, 0], { noPump: false, chamber: 0.33 });
  const steelB = steelMaterial(70.4, TAU * R);
  bst.add(meshOf(tube(R, 0.55, 69.2, 96), steelB));
  bst.add(disk(R, 1.9, M.darkMetal(), true));
  // 尾裙加强筋与发动机遮护
  const ribs = [];
  for (let i = 0; i < 40; i++) { const a = (i / 40) * TAU; const b = new THREE.BoxGeometry(0.12, 3.6, 0.22); b.translate(0, 2.3, 0); b.rotateY(-a); b.translate(Math.cos(a) * (R + 0.08), 0, Math.sin(a) * (R + 0.08)); ribs.push(b); }
  bst.add(meshOf(mergeGeometries(ribs), steelB));
  bst.add(meshOf(tube(R + 0.02, 0.55, 0.85, 96), M.darkMetal()));
  // 气动整流条（chines）
  for (const a of [Math.PI / 2 + 0.35, -Math.PI / 2 - 0.35]) {
    const c = new THREE.BoxGeometry(0.6, 30, 0.3); c.translate(R + 0.2, 47, 0); c.rotateY(-a);
    bst.add(meshOf(c, steelB));
  }
  // 外部导管
  const pipe = meshOf(new THREE.CylinderGeometry(0.32, 0.32, 60, 12), steelB); pipe.position.set(-R - 0.25, 36, 1.6); bst.add(pipe);
  // 热分离环：竖向钢肋 + 排气口
  const hsr = new THREE.Group();
  const hsrRibs = [];
  for (let i = 0; i < 36; i++) { const a = (i / 36) * TAU; const b = new THREE.BoxGeometry(0.28, 1.8, 0.5); b.rotateY(-a); b.translate(Math.cos(a) * (R - 0.1), 70.1, Math.sin(a) * (R - 0.1)); hsrRibs.push(b); }
  hsr.add(meshOf(mergeGeometries(hsrRibs), steelB));
  hsr.add(meshOf(tube(R - 0.35, 69.2, 71.0, 48), new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.9, metalness: 0.4 })));
  hsr.add(ringAt(R, 0.14, 69.25, steelB)); hsr.add(ringAt(R, 0.14, 70.95, steelB));
  const dome = meshOf(new THREE.SphereGeometry(R - 0.4, 40, 10, 0, TAU, 0, Math.PI / 2), M.darkMetal()); dome.scale.y = 0.25; dome.position.y = 69.3; hsr.add(dome);
  bst.add(hsr);
  // 栅格翼（电动作动，固定展开）
  const finGeo = rectGridFinGeometry(3.6, 5.2, 0.55, 7, 9, 0.18, 0.06);
  const fins = [];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4;
    const h = new THREE.Group(); h.position.set(Math.cos(a) * (R + 1.9), 66.0, Math.sin(a) * (R + 1.9)); h.rotation.y = -a;
    const f = meshOf(finGeo, M.titanium()); f.rotation.x = Math.PI / 2; h.add(f);
    const box = meshOf(new THREE.BoxGeometry(1.3, 1.8, 2.2), steelB); box.position.set(-1.7, 0.2, 0); h.add(box);
    bst.add(h); fins.push(f);
  }
  // 捕获销（朝向 ±z，落在筷子机械臂上）
  for (const s of [-1, 1]) { const p = meshOf(new THREE.BoxGeometry(1.1, 0.8, 1.4), M.darkMetal()); p.position.set(0, 64.2, s * (R + 0.6)); bst.add(p); }
  // ---------- 星舰飞船 ----------
  const ship = new THREE.Group();
  const rsl = veh.parts.ship.engines[0].layout, rv = veh.parts.ship.engines[1].layout;
  const e1 = addEngines(ship, 'raptor2', rsl, 71.6, [0, 0, 0], { chamber: 0.33 });
  const e2 = addEngines(ship, 'rvac', rv, 71.05, [0, 0, 0], { throat: 0.2, chamber: 0.22 });
  const steelS = steelMaterial(50, TAU * R);
  const tiles = tileMaterial(50, TAU * R / 2);
  ship.add(meshOf(tube(R, 71.0, 101.3, 96), steelS));
  // 迎风面防热瓦（半周）
  const tg = new THREE.CylinderGeometry(R + 0.04, R + 0.04, 29.6, 64, 1, true, Math.PI / 2, Math.PI); tg.translate(0, 71.9 + 14.8, 0);
  ship.add(meshOf(tg, tiles));
  const noseProf = ogive(R, 20.0, 101.3, 30, 0.9);
  ship.add(meshOf(lathe(noseProf, 96), steelS));
  ship.add(meshOf(lathe(noseProf.map(([r, y]) => [r + 0.04, y]).slice(0, -2), 64, Math.PI / 2, Math.PI), tiles));
  ship.add(disk(R, 71.05, M.darkMetal(), true));
  // 襟翼（前 2、后 2）
  const flapShape = (rootW, tipW, len) => {
    const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(len, rootW * 0.12); s.lineTo(len, rootW * 0.12 + tipW); s.lineTo(0, rootW); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.4, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 1 });
    geo.translate(0, 0, -0.2); return geo;
  };
  const flaps = [];
  const aft = flapShape(10.5, 7.0, 4.2), fwd = flapShape(7.2, 4.4, 3.2);
  for (const s of [-1, 1]) {
    const fa = new THREE.Group(); fa.position.set(0.8, 72.6, s * (R - 0.1));
    const ma = meshOf(aft, tiles); ma.rotation.set(0, s > 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI / 2); fa.add(ma); ship.add(fa); flaps.push(fa);
    const ff = new THREE.Group(); ff.position.set(1.2, 107.2, s * (R - 1.25));
    const mf = meshOf(fwd, tiles); mf.rotation.set(0, s > 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI / 2); ff.add(mf); ship.add(ff); flaps.push(ff);
  }
  return {
    parts: {
      booster: { obj: bst, engines: [bEng], anim: { fins: () => {} } },
      ship: { obj: ship, engines: [e1, e2] },
    },
  };
}

// ===========================================================================
// 土星五号
// ===========================================================================
function buildSaturnV(veh) {
  const R = 5.05;
  // ---------- S-IC ----------
  const sic = new THREE.Group();
  const f1 = addEngines(sic, 'f1', veh.parts.sic.engines[0].layout, 0, [0, 0, 0], { chamber: 0.28, exhaustDuct: false });
  // F-1 涡轮排气歧管（喷管延伸段上的环形集气管）
  for (const it of f1.list) { const t = meshOf(new THREE.TorusGeometry(1.45, 0.18, 8, 32), M.black()); t.rotation.x = Math.PI / 2; t.position.set(it.pos.x, 2.0, it.pos.z); sic.add(t); }
  sic.add(paintedTube(R, 5.4, 42.1, {
    base: '#f4f3ef', res: 18,
    bands: [
      { y0: 0, y1: 4.6, color: '#121212', pattern: 'quad', phase: 0 },           // 推力结构段
      { y0: 18.4, y1: 22.8, color: '#121212', pattern: 'quad', phase: 1 },       // 箱间段
      { y0: 34.2, y1: 36.7, color: '#121212', pattern: 'quad', phase: 0 },       // 前裙
    ],
    texts: [{ text: 'UNITED STATES', y: 14.5, angle: FRONT, size: 1.75, vertical: true, color: '#101010', spacing: 0.25, font: '"Futura","Century Gothic",Arial,sans-serif', weight: 700 },
      { text: 'USA', y: 28.6, angle: FRONT + 90, size: 2.3, vertical: true, color: '#101010', spacing: 0.3, font: '"Futura","Century Gothic",Arial,sans-serif', weight: 700 }],
    flags: [{ y: 26.0, angle: FRONT, h: 2.3, type: 'us', vertical: true }],
    panels: { dy: 1.2, y0: 0.2, color: 'rgba(0,0,0,0.05)' },
  }));
  sic.add(disk(R, 5.4, M.black(), true));
  sic.add(meshOf(tube(R * 1.003, 4.2, 5.45, 64), M.black()));
  // 发动机整流罩与稳定翼
  const finShape = new THREE.Shape(); finShape.moveTo(0, 0); finShape.lineTo(3.6, 0.0); finShape.lineTo(3.6, 1.6); finShape.lineTo(0, 4.9); finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.22, bevelEnabled: false }); finGeo.translate(0, 0, -0.11);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4;
    const fair = meshOf(lathe([[1.45, 1.6], [1.9, 3.6], [1.35, 9.4], [0.3, 11.4]], 20), M.white());
    fair.position.set(Math.cos(a) * 4.45, 0, Math.sin(a) * 4.45); fair.scale.set(1, 1, 0.8); fair.rotation.y = -a; sic.add(fair);
    const fin = meshOf(finGeo, M.white()); fin.position.set(Math.cos(a) * 5.7, 0.9, Math.sin(a) * 5.7); fin.rotation.y = -a; sic.add(fin);
    const tip = meshOf(new THREE.BoxGeometry(0.25, 0.3, 0.26), M.black()); tip.position.set(Math.cos(a) * 9.2, 1.0, Math.sin(a) * 9.2); sic.add(tip);
  }
  // 电缆隧道
  for (const a of [0.3, Math.PI + 0.3]) { const t = meshOf(new THREE.CylinderGeometry(0.32, 0.32, 36, 10), M.white()); t.position.set(Math.cos(a) * (R + 0.18), 23.5, Math.sin(a) * (R + 0.18)); sic.add(t); }
  // ---------- S-II 级间段 ----------
  const inter = new THREE.Group();
  inter.add(paintedTube(R, 42.1, 47.7, { base: '#f1f0ec', bands: [{ y0: 0.1, y1: 1.3, color: '#121212', pattern: 'stripes', n: 8, w: 0.5 }], panels: { dy: 0.9, color: 'rgba(0,0,0,0.06)' } }));
  inter.add(meshOf(tube(R * 0.99, 42.1, 47.7, 48), new THREE.MeshStandardMaterial({ color: 0x3a3a3a, side: THREE.BackSide, roughness: 0.9 })));
  // ---------- S-II ----------
  const sii = new THREE.Group();
  const j2a = addEngines(sii, 'j2', veh.parts.sii.engines[0].layout, 43.8, [0, 0, 0], { chamber: 0.3 });
  sii.add(disk(R * 0.98, 47.4, M.darkMetal(), true));
  sii.add(paintedTube(R, 47.7, 67.0, {
    base: '#f4f3ef', res: 16,
    bands: [{ y0: 17.8, y1: 19.3, color: '#121212', pattern: 'quad', phase: 1 }],
    texts: [{ text: 'USA', y: 10, angle: FRONT, size: 2.6, vertical: true, color: '#101010', spacing: 0.3, font: '"Futura","Century Gothic",Arial,sans-serif', weight: 700 }],
    panels: { dy: 2.4, y0: 0.3, color: 'rgba(0,0,0,0.05)' },
  }));
  // ---------- S-IVB ----------
  const sivb = new THREE.Group();
  const j2b = addEngines(sivb, 'j2', [[0, 0]], 66.2, [0, 0, 0], { chamber: 0.3 });
  const coneInter = meshOf(lathe([[5.05, 67.0], [3.3, 72.2]], 64), new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.5, side: THREE.DoubleSide }));
  sivb.add(coneInter);
  sivb.add(paintedTube(3.3, 72.2, 84.8, {
    base: '#f4f3ef', res: 22,
    bands: [{ y0: 0, y1: 2.6, color: '#121212', pattern: 'quad', phase: 0 }, { y0: 11.9, y1: 12.6, color: '#121212', pattern: 'stripes', n: 4, w: 0.5 }],
    panels: { dy: 1.6, color: 'rgba(0,0,0,0.05)' },
  }));
  for (const s of [-1, 1]) { const aps = meshOf(new THREE.BoxGeometry(0.9, 2.4, 1.6), M.black()); aps.position.set(0, 73.5, s * 3.55); sivb.add(aps); }
  sivb.add(meshOf(tube(3.3, 84.8, 85.7, 64), mat('iu', () => new THREE.MeshStandardMaterial({ color: 0xd9d8d2, roughness: 0.6 })))); // 仪器舱
  // ---------- 阿波罗飞船 ----------
  const apollo = new THREE.Group();
  apollo.add(meshOf(lathe([[3.3, 85.7], [1.95, 94.2]], 64), new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.5 }))); // SLA
  const sm = meshOf(tube(1.95, 94.2, 101.6, 48), M.metal()); apollo.add(sm);
  for (let k = 0; k < 6; k++) { const p = meshOf(new THREE.BoxGeometry(0.05, 6.4, 1.8), M.white()); const a = (k / 6) * TAU; p.position.set(Math.cos(a) * 1.97, 97.9, Math.sin(a) * 1.97); p.rotation.y = -a; apollo.add(p); }
  for (let k = 0; k < 4; k++) { const q = meshOf(new THREE.BoxGeometry(0.4, 0.6, 0.5), M.grey()); const a = Math.PI / 4 + (k / 4) * TAU; q.position.set(Math.cos(a) * 2.05, 100.4, Math.sin(a) * 2.05); apollo.add(q); }
  apollo.add(meshOf(lathe([[1.97, 101.6], [0.35, 104.8], [0.2, 104.9]], 48), M.white())); // BPC
  // ---------- 逃逸塔 ----------
  const les = new THREE.Group();
  const towerMat = mat('lesTower', () => new THREE.MeshStandardMaterial({ color: 0xb2432a, roughness: 0.6, metalness: 0.3 }));
  const tg = [];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * TAU) / 4, a2 = a;
    const p0 = new THREE.Vector3(Math.cos(a) * 0.95, 104.3, Math.sin(a) * 0.95), p1 = new THREE.Vector3(Math.cos(a2) * 0.36, 107.2, Math.sin(a2) * 0.36);
    const v = p1.clone().sub(p0); const c = new THREE.CylinderGeometry(0.05, 0.05, v.length(), 6); c.translate(0, v.length() / 2, 0);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize())); c.translate(p0.x, p0.y, p0.z); tg.push(c);
  }
  les.add(meshOf(mergeGeometries(tg), towerMat));
  const lesMotor = meshOf(new THREE.CylinderGeometry(0.33, 0.33, 3.6, 20), M.white()); lesMotor.position.y = 109.0; les.add(lesMotor);
  const lesTop = meshOf(lathe([[0.33, 110.8], [0.26, 111.4], [0.12, 112.2], [0.02, 112.5]], 20), towerMat); les.add(lesTop);
  const lesNoz = new THREE.Group();
  for (let k = 0; k < 4; k++) { const n = meshOf(new THREE.ConeGeometry(0.16, 0.45, 10, 1, true), M.darkMetal()); const a = (k / 4) * TAU; n.position.set(Math.cos(a) * 0.36, 107.3, Math.sin(a) * 0.36); n.rotation.z = Math.cos(a) * 0.5; n.rotation.x = -Math.sin(a) * 0.5; lesNoz.add(n); }
  les.add(lesNoz);
  const lesEng = { type: 'les', e: { id: 'les', prop: 'solid', exitD: 0.32 }, list: [0, 1, 2, 3].map((k) => { const a = (k / 4) * TAU; return { pos: new THREE.Vector3(Math.cos(a) * 0.36, 107.1, Math.sin(a) * 0.36), exitR: 0.16, index: k, tilt: new THREE.Vector3(Math.cos(a) * 0.45, -1, Math.sin(a) * 0.45).normalize() }; }) };
  return {
    parts: {
      sic: { obj: sic, engines: [f1] }, inter: { obj: inter }, sii: { obj: sii, engines: [j2a] },
      sivb: { obj: sivb, engines: [j2b] }, apollo: { obj: apollo }, les: { obj: les, solid: lesEng },
    },
  };
}

// ===========================================================================
// 长征五号乙
// ===========================================================================
function buildCZ5B(veh) {
  const R = 2.5;
  const core = new THREE.Group();
  const ce = addEngines(core, 'yf77', veh.parts.core.engines[0].layout, 0, [0, 0, 0], { chamber: 0.3 });
  core.add(disk(R, 2.4, M.darkMetal(), true));
  core.add(meshOf(tube(R * 1.003, 1.4, 2.45, 48), M.grey()));
  core.add(paintedTube(R, 2.45, 33.2, {
    base: '#f2f1ec', res: 20,
    texts: [{ text: '中国航天', y: 22, angle: FRONT, size: 1.6, vertical: true, stack: true, color: '#101010', font: '"Microsoft YaHei","PingFang SC","SimHei",sans-serif', weight: 700, lead: 1.15 },
      { text: 'CZ-5B', y: 12, angle: FRONT, size: 1.0, vertical: true, color: '#b01e1e', spacing: 0.1, font: 'Arial,sans-serif', weight: 800 }],
    flags: [{ y: 29.2, angle: FRONT, h: 1.3, type: 'cn' }],
    bands: [{ y0: 16.2, y1: 16.6, color: '#8a8a88' }],
    panels: { dy: 2.8, y0: 1.0, color: 'rgba(0,0,0,0.05)' },
  }));
  const parts = { core: { obj: core, engines: [ce] } };
  // 捆绑助推器（斜切头锥）
  for (const id of ['b1', 'b2', 'b3', 'b4']) {
    const d = veh.parts[id], ang = d.ang, r = 4.28;
    const g = new THREE.Group();
    const cx = Math.cos(ang) * r, cz = Math.sin(ang) * r;
    const tan = [-Math.sin(ang), Math.cos(ang)];
    const layout = [[cx + tan[0] * 0.78, cz + tan[1] * 0.78], [cx - tan[0] * 0.78, cz - tan[1] * 0.78]];
    const be = addEngines(g, 'yf100', layout, 0, [0, 0, 0], { chamber: 0.3 });
    const inner = new THREE.Group(); inner.position.set(cx, 0, cz); inner.rotation.y = -ang - Math.PI / 2; g.add(inner);
    inner.add(disk(1.675, 2.2, M.darkMetal(), true));
    inner.add(paintedTube(1.675, 2.2, 22.9, { base: '#f2f1ec', flags: [{ y: 18.5, angle: FRONT + 90, h: 0.8, type: 'cn' }], texts: [{ text: '中国航天', y: 11, angle: FRONT + 90, size: 0.95, vertical: true, stack: true, color: '#101010', font: '"Microsoft YaHei","PingFang SC","SimHei",sans-serif', weight: 700 }], panels: { dy: 2.5, color: 'rgba(0,0,0,0.05)' } }));
    // 斜头锥：顶点向芯级方向偏移
    const nose = new THREE.ConeGeometry(1.675, 4.7, 48, 6, true); nose.translate(0, 22.9 + 2.35, 0);
    const p = nose.attributes.position;
    for (let i = 0; i < p.count; i++) { const t = (p.getY(i) - 22.9) / 4.7; p.setX(i, p.getX(i) + 0); p.setZ(i, p.getZ(i) - t * 1.3); }
    nose.computeVertexNormals();
    const nm = meshOf(nose, M.white()); nm.rotation.y = 0; inner.add(nm);
    // 前后连接支座
    for (const y of [3.0, 21.0]) { const s = meshOf(new THREE.BoxGeometry(0.4, 0.5, 0.7), M.grey()); s.position.set(0, y, -1.75); inner.add(s); }
    parts[id] = { obj: g, engines: [be] };
  }
  // 整流罩（两半）
  const prof = [[2.5, 33.2], [2.6, 33.7], [2.6, 44.6], ...ogive(2.6, 9.06, 44.6, 30, 0.25)];
  const halves = [];
  for (const side of [-1, 1]) {
    const hg = new THREE.Group();
    const geo = lathe(prof, 40, side > 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI);
    hg.add(meshOf(geo, new THREE.MeshStandardMaterial({ color: 0xf3f3f0, roughness: 0.42, side: THREE.DoubleSide })));
    if (side > 0) {
      const tex = canvasTex(512, 256, (g, w, h) => { g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(0, 0, w, h); g.fillStyle = '#b3191d'; g.font = '700 150px "Microsoft YaHei","SimHei",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('天 和', w / 2, h / 2); });
      const decal = new THREE.Mesh(new THREE.CylinderGeometry(2.62, 2.62, 2.4, 32, 1, true, -0.5, 1.0), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.5 }));
      decal.position.y = 40; hg.add(decal);
    }
    halves.push(hg);
  }
  const fairing = new THREE.Group(); halves.forEach((h) => fairing.add(h));
  parts.fairing = { obj: fairing, halves };
  // 天和核心舱
  const pl = new THREE.Group();
  pl.add(meshOf(lathe([[2.1, 34.2], [2.1, 43.5], [1.4, 44.5], [1.4, 47.8], [1.0, 48.3], [1.0, 49.8]], 40), mat('tianhe', () => new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.55, metalness: 0.1 }))));
  for (const s of [-1, 1]) { const p = meshOf(new THREE.BoxGeometry(0.06, 7.5, 1.9), mat('solar', () => new THREE.MeshStandardMaterial({ color: 0x14203a, roughness: 0.25, metalness: 0.6 }))); p.position.set(s * 2.15, 39, 0); pl.add(p); }
  parts.payload = { obj: pl };
  return { parts };
}

export function buildRocket(veh) {
  switch (veh.model) {
    case 'falcon9': return buildFalcon9(veh);
    case 'falconHeavy': return buildFalconHeavy(veh);
    case 'starship': return buildStarship(veh);
    case 'saturnV': return buildSaturnV(veh);
    case 'cz5b': return buildCZ5B(veh);
  }
  throw new Error('unknown model ' + veh.model);
}
