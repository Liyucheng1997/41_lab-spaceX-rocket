// 发射设施、着陆区与无人回收船
import * as THREE from 'three';
import { M, latticeTower, meshOf, mergeGeometries, lathe, canvasTex, mat, fbm } from '../models/parts.js';

// 混凝土：程序化污渍、接缝与烧蚀痕迹
function concreteTex() {
  return canvasTex(512, 512, (g, w, h) => {
    const img = g.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = fbm(x / 70, y / 70, 5), m = fbm(x / 9 + 30, y / 9, 3);
      let v = 150 + (n - 0.5) * 70 + (m - 0.5) * 26;
      if (x % 128 < 2 || y % 128 < 2) v -= 30;           // 伸缩缝
      const i = (y * w + x) * 4; d[i] = v; d[i + 1] = v * 0.985; d[i + 2] = v * 0.955; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, { repeat: true });
}
const concrete = () => mat('concrete', () => { const t = concreteTex(); t.repeat.set(6, 6); return new THREE.MeshStandardMaterial({ map: t, color: 0xc9c6bf, roughness: 0.92 }); });
const concreteDark = () => mat('concreteDark', () => new THREE.MeshStandardMaterial({ color: 0x5c5a55, roughness: 0.95 }));
const steelGrey = () => mat('steelGrey', () => new THREE.MeshStandardMaterial({ color: 0x9a9da2, roughness: 0.55, metalness: 0.6 }));
const redPaint = () => mat('redPaint', () => new THREE.MeshStandardMaterial({ color: 0xb23a26, roughness: 0.6, metalness: 0.3 }));
const white = () => mat('padWhite', () => new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.6 }));

function box(w, h, d, x, y, z, m) { const b = meshOf(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); return b; }
function cyl(r, h, x, y, z, m, seg = 24) { const c = meshOf(new THREE.CylinderGeometry(r, r, h, seg), m); c.position.set(x, y, z); return c; }

/** 抬升的发射台地基（八边形土堤 + 混凝土顶面）与导流槽 */
function padMound(g, topW, h, trenchAxis = 'z') {
  const geo = new THREE.CylinderGeometry(topW / 2, topW / 2 + h * 2.2, h, 8); geo.rotateY(Math.PI / 8);
  const m = meshOf(geo, concrete()); m.position.y = h / 2; m.receiveShadow = true; g.add(m);
  // 导流槽：两侧开口
  const L = topW + h * 3.6;
  const tr = trenchAxis === 'z' ? box(14, h * 0.62, L, 0, h * 0.3, 0, concreteDark()) : box(L, h * 0.62, 14, 0, h * 0.3, 0, concreteDark());
  g.add(tr);
  return h;
}

// ---------------------------------------------------------------------------
export function buildPad(vehId, veh) {
  const g = new THREE.Group();
  const api = { group: g, setArms: () => {}, setTE: () => {}, trenchExits: [], deckH: veh.deckH, towerX: 0 };
  if (vehId === 'falcon9' || vehId === 'falconHeavy') buildLC39A_F9(g, api, veh, vehId === 'falconHeavy');
  else if (vehId === 'saturnV') buildLC39A_Saturn(g, api, veh);
  else if (vehId === 'starship') buildStarbase(g, api, veh);
  else if (vehId === 'cz5b') buildWenchang(g, api, veh);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return api;
}

// ---------------- LC-39A（SpaceX 时代） ----------------
function buildLC39A_F9(g, api, veh, heavy) {
  const H = padMound(g, 120, 7.5, 'z');
  // 发射支架（Transporter-Erector 底座）
  const mount = new THREE.Group();
  const baseW = heavy ? 16 : 10;
  mount.add(box(baseW, veh.deckH - H, baseW, 0, H + (veh.deckH - H) / 2, 0, steelGrey()));
  mount.add(box(baseW + 3, 0.8, baseW + 3, 0, veh.deckH - 0.4, 0, M.darkMetal()));
  // 支撑夹具
  const clampPos = heavy ? [[0, -4], [0, 0], [0, 4]] : [[0, 0]];
  for (const [cx, cz] of clampPos) for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + Math.PI / 4; g.add(box(0.6, 1.8, 0.6, cx + Math.cos(a) * 2.3, veh.deckH + 0.3, cz + Math.sin(a) * 2.3, M.darkMetal())); }
  g.add(mount);
  // 起竖架（strongback）：发射前后倾
  const te = new THREE.Group(); te.position.set(-4.2 - (heavy ? 0 : 0), veh.deckH - 1, 0);
  const teTruss = meshOf(latticeTower(2.4, 3.6, 66, 3.3, 0.18, 0.07), steelGrey()); teTruss.position.set(-1.6, 0, 0); te.add(teTruss);
  for (const y of [18, 36, 55]) te.add(box(2.6, 0.5, 1.2, -0.2, y, 0, M.darkMetal()));
  g.add(te);
  api.setTE = (v) => { te.rotation.z = v * 0.06; };
  // 固定勤务塔 FSS + 避雷针 + 乘员通道臂
  const fss = new THREE.Group(); fss.position.set(-16, H, -20);
  fss.add(meshOf(latticeTower(12, 12, 86, 6, 0.35, 0.12), steelGrey()));
  fss.add(cyl(0.5, 30, 0, 101, 0, steelGrey(), 8));
  fss.add(box(3.2, 3.2, 18, 3.5, 66, 11, steelGrey()));
  for (let y = 6; y < 86; y += 12) fss.add(box(12.4, 0.5, 12.4, 0, y, 0, M.grey()));
  g.add(fss);
  // 声抑制水塔
  const wt = new THREE.Group(); wt.position.set(-230, 0, 260);
  wt.add(meshOf(latticeTower(16, 16, 62, 8, 0.6, 0.25), white()));
  wt.add(cyl(11, 24, 0, 74, 0, white(), 40));
  wt.add(meshOf(new THREE.SphereGeometry(11, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), white())); wt.children[2].position.y = 86;
  g.add(wt);
  // 液氧/煤油储罐
  // 液氧/液氮球罐：球体坐落在圆柱形裙座上
  for (const [x, z, r] of [[-260, -170, 11], [-230, -205, 11], [-300, -120, 7.5]]) {
    const s = meshOf(new THREE.SphereGeometry(r, 32, 20), white()); s.position.set(x, r * 1.25, z); g.add(s);
    g.add(cyl(r * 0.72, r * 0.85, x, r * 0.42, z, M.grey(), 32));
  }
  // 水平总装厂房 HIF
  const hif = box(95, 30, 60, -520, 15, 0, mat('hif', () => new THREE.MeshStandardMaterial({ color: 0xd8d8d2, roughness: 0.7 }))); g.add(hif);
  g.add(box(4, 22, 55, -472, 11, 0, M.grey()));
  api.trenchExits = [new THREE.Vector3(0, 3, 66), new THREE.Vector3(0, 3, -66)];
}

// ---------------- LC-39A（阿波罗时代）：移动发射平台 + 脐带塔 ----------------
function buildLC39A_Saturn(g, api, veh) {
  const H = padMound(g, 130, 6.4, 'z');
  // 移动发射平台 ML（49 × 41 × 7.6 m）
  const mlTop = veh.deckH;
  g.add(box(49, 7.6, 41, 0, mlTop - 3.8, 0, M.grey()));
  for (const [x, z] of [[-18, -14], [18, -14], [-18, 14], [18, 14], [0, -14], [0, 14]]) g.add(box(3, mlTop - 7.6 - H + 0.2, 3, x, H + (mlTop - 7.6 - H) / 2, z, concreteDark()));
  // 压紧释放臂
  const hold = [];
  for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + (k * Math.PI) / 2; const h = box(1.6, 3.4, 2.4, Math.cos(a) * 6.4, mlTop + 1.7, Math.sin(a) * 6.4, M.darkMetal()); h.rotation.y = -a; g.add(h); hold.push(h); }
  // 脐带塔 LUT（红色桁架）+ 9 根摆臂 + 顶部锤头吊车
  const lut = new THREE.Group(); lut.position.set(-24, mlTop, 0);
  lut.add(meshOf(latticeTower(12, 12, 116, 6.1, 0.45, 0.16), redPaint()));
  const crane = box(26, 3, 3, 4, 119, 0, redPaint()); lut.add(crane);
  lut.add(cyl(0.3, 12, 0, 128, 0, redPaint(), 6));
  const arms = [];
  const armYs = [18, 31, 43, 51, 64, 73, 81, 92, 97];
  armYs.forEach((y, i) => {
    const pivot = new THREE.Group(); pivot.position.set(6, y, i % 2 ? 4 : -4);
    const len = 17.6 - (y > 72 ? 2.4 : 0) - (y > 88 ? 1.4 : 0);
    const arm = meshOf(latticeTower(2.4, 2.6, len, 2.6, 0.12, 0.05), redPaint());
    arm.rotation.z = -Math.PI / 2; arm.position.set(0, 1.2, 0);
    pivot.add(arm); lut.add(pivot); arms.push(pivot);
  });
  g.add(lut);
  api.setArms = (v) => { arms.forEach((a, i) => { const s = i % 2 ? 1 : -1; a.rotation.y = s * v * 1.35; }); hold.forEach((h, k) => { h.rotation.z = v * 0.4; }); };
  api.towerX = -24;
  api.trenchExits = [new THREE.Vector3(0, 3, 74), new THREE.Vector3(0, 3, -74)];
}

// ---------------- 星际基地：轨道发射台 OLM + 发射塔（筷子） ----------------
function buildStarbase(g, api, veh) {
  const deck = veh.deckH;
  // 场坪与水冷导流板
  g.add(box(90, 0.6, 90, 0, 0.3, 0, concrete()));
  g.add(box(22, 1.6, 22, 0, 1.1, 0, M.darkMetal()));
  // 发射台：6 根立柱 + 环形台面
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + Math.PI / 6; g.add(cyl(1.4, deck - 3, Math.cos(a) * 10.5, (deck - 3) / 2, Math.sin(a) * 10.5, steelGrey(), 16)); }
  const table = meshOf(new THREE.CylinderGeometry(12.6, 12.6, 3.2, 6, 1, false), M.grey()); table.position.y = deck - 1.6; table.rotation.y = Math.PI / 6; g.add(table);
  const hole = meshOf(new THREE.CylinderGeometry(5.6, 5.6, 3.4, 32), new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 })); hole.position.y = deck - 1.55; g.add(hole);
  // 夹具
  for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2; g.add(box(0.6, 1.2, 0.9, Math.cos(a) * 5.0, deck + 0.4, Math.sin(a) * 5.0, M.darkMetal())); }
  // 发射塔（Mechazilla）：方形钢结构，高约 146 m
  const T = new THREE.Group(); const tx = -21.5; T.position.set(tx, 0, 0);
  const tw = 11;
  T.add(meshOf(latticeTower(tw, tw, 138, 9.2, 0.55, 0.22), steelGrey()));
  for (let y = 9.2; y < 138; y += 9.2) T.add(box(tw + 0.6, 0.7, tw + 0.6, 0, y, 0, M.grey()));
  T.add(box(tw + 1, 3, tw + 1, 0, 139.5, 0, M.grey()));
  T.add(cyl(0.35, 12, 0, 147, 0, steelGrey(), 8));
  // 飞船快速断开臂（QD）
  T.add(box(20, 2.2, 2.2, 10, 118, 0, steelGrey()));
  // 机械臂小车 + 两根"筷子"
  const armY = 38 + 64.2 - 0.9; // 捕获销下沿高度
  const car = new THREE.Group(); car.position.set(tw / 2 + 1.2, armY, 0);
  car.add(box(3.4, 9, 13, 0, 1.5, 0, M.darkMetal()));
  const arms = [];
  for (const s of [-1, 1]) {
    const piv = new THREE.Group(); piv.position.set(0.5, 0, s * 5.8);
    const arm = new THREE.Group();
    const L = 36;
    arm.add(meshOf(latticeTower(2.2, 3.2, L, 3.0, 0.2, 0.08), steelGrey()));
    arm.children[0].rotation.z = -Math.PI / 2; arm.children[0].position.set(0, 0, 0);
    arm.add(box(L * 0.7, 0.6, 1.6, L * 0.55, 0.3, -s * 1.0, M.darkMetal()));   // 捕获导轨
    arm.add(box(2.5, 3.5, 1.2, L - 1.2, -0.6, -s * 0.2, M.darkMetal()));       // 端部缓冲
    piv.add(arm); car.add(piv); arms.push(piv);
  }
  T.add(car);
  g.add(T);
  api.setArms = (v) => { arms.forEach((a, i) => { const s = i ? 1 : -1; a.rotation.y = -s * (1 - v) * 0.62 + s * 0.045; }); };
  api.setArms(0);
  api.armY = armY; api.towerX = tx;
  // 储罐区
  for (let i = 0; i < 8; i++) g.add(cyl(4, 26, -230 + (i % 4) * 11, 13, 90 + Math.floor(i / 4) * 12, white(), 24));
  for (const [x, z] of [[-280, 140], [-300, 118]]) { const s = meshOf(new THREE.SphereGeometry(9, 24, 16), white()); s.position.set(x, 9, z); g.add(s); }
  // 总装厂房 Mega Bay（远处）
  g.add(box(70, 85, 55, -2600, 42, 380, mat('megabay', () => new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.5, metalness: 0.4 }))));
  api.trenchExits = [];
}

// ---------------- 文昌 101 工位：固定脐带塔 + 活动发射平台 + 4 座避雷塔 ----------------
function buildWenchang(g, api, veh) {
  const H = padMound(g, 100, 3.5, 'x');
  const deck = veh.deckH;
  g.add(box(26, deck - H, 22, 0, H + (deck - H) / 2, 0, M.grey()));
  g.add(box(28, 0.8, 24, 0, deck - 0.4, 0, M.darkMetal()));
  // 脐带塔
  const T = new THREE.Group(); T.position.set(-20, H, 0);
  T.add(meshOf(latticeTower(12, 14, 84, 6, 0.45, 0.16), mat('wcTower', () => new THREE.MeshStandardMaterial({ color: 0xc9c7c0, roughness: 0.6, metalness: 0.3 }))));
  for (let y = 6; y < 84; y += 12) T.add(box(12.6, 0.8, 14.6, 0, y, 0, M.grey()));
  const arms = [];
  for (const y of [22, 36, 50, 64]) {
    const p = new THREE.Group(); p.position.set(6, y, -3);
    p.add(box(12, 2.2, 2.4, 6, 0, 0, M.grey())); T.add(p); arms.push(p);
  }
  T.add(cyl(0.4, 14, 0, 91, 0, M.grey(), 8));
  g.add(T);
  api.setArms = (v) => arms.forEach((a) => (a.rotation.y = v * 1.3));
  // 4 座高避雷塔 + 顶部导线
  const masts = [[60, 60], [-60, 60], [60, -60], [-60, -60]];
  for (const [x, z] of masts) {
    g.add(meshOf(latticeTower(4, 4, 118, 7, 0.22, 0.08), mat('mast', () => new THREE.MeshStandardMaterial({ color: 0xd5d5d0, roughness: 0.6, metalness: 0.4 }))).translateX(x).translateZ(z));
    g.add(cyl(0.25, 14, x, 125, z, M.grey(), 6));
  }
  api.towerX = -20;
  api.trenchExits = [new THREE.Vector3(62, 2, 0), new THREE.Vector3(-62, 2, 0)];
}

// ---------------------------------------------------------------------------
export function buildLandingZone(label = 'LZ-1') {
  const g = new THREE.Group();
  const tex = canvasTex(1024, 1024, (c, w, h) => {
    c.fillStyle = '#8b8a85'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#f2f2ee'; c.lineWidth = 26; c.beginPath(); c.arc(w / 2, h / 2, w * 0.42, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 60; c.beginPath(); c.moveTo(w * 0.28, h * 0.28); c.lineTo(w * 0.72, h * 0.72); c.moveTo(w * 0.72, h * 0.28); c.lineTo(w * 0.28, h * 0.72); c.stroke();
    c.fillStyle = '#f2f2ee'; c.font = '700 60px Arial'; c.textAlign = 'center'; c.fillText(label, w / 2, h * 0.93);
  });
  const top = meshOf(new THREE.CylinderGeometry(43, 45, 1.4, 64), [new THREE.MeshStandardMaterial({ color: 0x77766f, roughness: 0.9 }), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }), concrete()]);
  top.position.y = 0.7; g.add(top);
  return g;
}

export function buildDroneship(name = 'A SHORTFALL OF GRAVITAS') {
  const g = new THREE.Group();
  const deckTex = canvasTex(1024, 1024, (c, w, h) => {
    c.fillStyle = '#3a3b3d'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) { c.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`; c.fillRect(Math.random() * w, Math.random() * h, 30 + Math.random() * 90, 3 + Math.random() * 8); }
    c.strokeStyle = '#e8e8e6'; c.lineWidth = 16; c.beginPath(); c.arc(w / 2, h / 2, w * 0.34, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 40; c.beginPath(); c.moveTo(w * 0.36, h * 0.36); c.lineTo(w * 0.64, h * 0.64); c.moveTo(w * 0.64, h * 0.36); c.lineTo(w * 0.36, h * 0.64); c.stroke();
    // 烧蚀痕迹
    const gr = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.2); gr.addColorStop(0, 'rgba(10,8,6,0.7)'); gr.addColorStop(1, 'rgba(10,8,6,0)'); c.fillStyle = gr; c.fillRect(0, 0, w, h);
  });
  const hull = meshOf(new THREE.BoxGeometry(91, 7, 52), M.darkMetal()); hull.position.y = -2.1; g.add(hull);
  const deck = meshOf(new THREE.PlaneGeometry(88, 50), new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.8, metalness: 0.3 })); deck.rotation.x = -Math.PI / 2; deck.position.y = 1.42; g.add(deck);
  // 两侧防爆墙 + 推进器舱
  for (const s of [-1, 1]) { g.add(box(91, 5, 1.2, 0, 3.5, s * 25.6, M.grey())); g.add(box(6, 3, 6, s * 40, 2.8, 20, mat('yellow', () => new THREE.MeshStandardMaterial({ color: 0xd9b43a, roughness: 0.6 })))); }
  g.add(box(4, 12, 4, -42, 7, -20, M.grey()));
  // 机器人 Octagrabber
  g.add(box(4, 1.2, 4, -30, 2.1, 0, mat('red', () => new THREE.MeshStandardMaterial({ color: 0xc22b2b, roughness: 0.6 }))));
  const nameTex = canvasTex(1024, 64, (c, w, h) => { c.fillStyle = '#2f3032'; c.fillRect(0, 0, w, h); c.fillStyle = '#eee'; c.font = '700 40px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(name, w / 2, h / 2); });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(60, 3.8), new THREE.MeshStandardMaterial({ map: nameTex, roughness: 0.7 })); plate.position.set(0, 3.6, 26.25); g.add(plate);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
