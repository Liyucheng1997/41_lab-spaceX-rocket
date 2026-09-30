// 公共几何体与材质库：钟形喷管、栅格翼、着陆腿、贴花文字、程序化纹理
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// 程序化噪声
// ---------------------------------------------------------------------------
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, oct = 4) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= 2; a *= 0.5; } return s; }

export function canvasTex(w, h, draw, { srgb = true, repeat = false } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}

let _noiseCanvas = null;
function noiseCanvas() {
  if (_noiseCanvas) return _noiseCanvas;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), img = g.createImageData(256, 256), d = img.data;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const v = 128 + (fbm(x / 32, y / 32, 4) - 0.5) * 200 + (hash(x, y) - 0.5) * 40;
    const i = (y * 256 + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return (_noiseCanvas = c);
}

// ---------------------------------------------------------------------------
// 箭体涂装纹理（沿圆周 u、沿轴向 v 展开）
// spec: { base, length, circ, bands:[{y0,y1,color,pattern}], texts:[{text,y,angle,size,color,vertical,font}], flags:[{y,angle,h,type}], soot, panels }
// ---------------------------------------------------------------------------
export function paintTexture(spec) {
  const pxPerM = spec.res || 22;
  const W = Math.min(2048, Math.ceil((spec.circ * pxPerM) / 4) * 4);
  const H = Math.min(4096, Math.ceil(spec.length * pxPerM));
  const sx = W / spec.circ, sy = H / spec.length;
  return canvasTex(W, H, (g) => {
    g.fillStyle = spec.base; g.fillRect(0, 0, W, H);
    // 细微的漆面明暗变化（平铺噪声图案，避免逐像素计算）
    const amp = spec.grain ?? 0.07;
    if (amp > 0) { g.save(); g.globalAlpha = amp; g.globalCompositeOperation = 'overlay'; g.fillStyle = g.createPattern(noiseCanvas(), 'repeat'); g.fillRect(0, 0, W, H); g.restore(); }
    const Y = (m) => H - m * sy; // 纹理 v=0 在底部
    for (const b of spec.bands || []) {
      g.fillStyle = b.color;
      if (b.pattern === 'quad') {
        // 土星五号滚转识别涂装：四象限黑白交替
        for (let k = 0; k < 4; k++) if ((k + (b.phase || 0)) % 2 === 0) g.fillRect((k * W) / 4, Y(b.y1), W / 4, (b.y1 - b.y0) * sy);
      } else if (b.pattern === 'stripes') {
        const n = b.n || 8;
        for (let k = 0; k < n; k++) g.fillRect(((k + 0.25) * W) / n, Y(b.y1), (W / n) * (b.w || 0.5), (b.y1 - b.y0) * sy);
      } else g.fillRect(0, Y(b.y1), W, (b.y1 - b.y0) * sy);
    }
    // 焊缝 / 蒙皮接缝
    if (spec.panels) {
      g.strokeStyle = spec.panels.color || 'rgba(0,0,0,0.12)'; g.lineWidth = spec.panels.w || 1.2;
      for (let y = spec.panels.y0 || 0; y < spec.length; y += spec.panels.dy) { g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(W, Y(y)); g.stroke(); }
      if (spec.panels.nx) for (let k = 0; k < spec.panels.nx; k++) { const x = (k * W) / spec.panels.nx; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    }
    // 底部烟熏（发动机回流）
    if (spec.soot) {
      const gr = g.createLinearGradient(0, H, 0, Y(spec.soot.h));
      gr.addColorStop(0, `rgba(20,16,12,${spec.soot.a})`); gr.addColorStop(1, 'rgba(20,16,12,0)');
      g.fillStyle = gr; g.fillRect(0, Y(spec.soot.h), W, spec.soot.h * sy);
      for (let i = 0; i < 90; i++) {
        const x = hash(i, 3) * W, h = spec.soot.h * sy * (0.4 + hash(i, 7) * 0.9);
        g.fillStyle = `rgba(25,20,15,${0.05 + hash(i, 9) * 0.08})`; g.fillRect(x, H - h, 2 + hash(i, 5) * 10, h);
      }
    }
    for (const t of spec.texts || []) {
      const x = (t.angle / 360) * W, y = Y(t.y);
      g.save(); g.translate(x, y);
      g.fillStyle = t.color || '#111';
      const px = t.size * sy;
      g.font = `${t.weight || 800} ${px}px ${t.font || '"Arial Black","Helvetica Neue",Arial,sans-serif'}`;
      g.textBaseline = 'middle'; g.textAlign = 'center';
      if (t.vertical) {
        if (t.stack) { // 竖排（逐字）
          const chars = [...t.text]; const step = px * (t.lead || 1.1);
          chars.forEach((ch, i) => g.fillText(ch, 0, (i - (chars.length - 1) / 2) * step));
        } else { g.rotate(-Math.PI / 2); if (t.spacing) g.letterSpacing = `${t.spacing * px}px`; g.fillText(t.text, 0, 0); }
      } else { g.scale(t.sx || 1, 1); g.fillText(t.text, 0, 0); }
      g.restore();
    }
    for (const f of spec.flags || []) drawFlag(g, (f.angle / 360) * W, Y(f.y), f.h * sy, f.type, f.vertical);
  });
}

function drawFlag(g, cx, cy, h, type, vertical) {
  g.save(); g.translate(cx, cy); if (vertical) g.rotate(-Math.PI / 2);
  const w = h * 1.5;
  if (type === 'us') {
    for (let i = 0; i < 13; i++) { g.fillStyle = i % 2 ? '#fff' : '#b22234'; g.fillRect(-w / 2, -h / 2 + (i * h) / 13, w, h / 13 + 0.5); }
    g.fillStyle = '#3c3b6e'; g.fillRect(-w / 2, -h / 2, w * 0.4, h * 0.54);
    g.fillStyle = '#fff';
    for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) g.fillRect(-w / 2 + (c + 0.5) * (w * 0.4) / 6.2, -h / 2 + (r + 0.6) * (h * 0.54) / 5.4, 1.2, 1.2);
  } else if (type === 'cn') {
    g.fillStyle = '#de2910'; g.fillRect(-w / 2, -h / 2, w, h);
    g.fillStyle = '#ffde00';
    const star = (x, y, r, rot = 0) => { g.beginPath(); for (let i = 0; i < 10; i++) { const a = rot - Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.38 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.fill(); };
    const u = h / 20;
    star(-w / 2 + 5 * u, -h / 2 + 5 * u, 3 * u);
    [[10, 2], [12, 4], [12, 7], [10, 9]].forEach(([x, y]) => star(-w / 2 + x * u, -h / 2 + y * u, u, 0.4));
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// 材质
// ---------------------------------------------------------------------------
const matCache = {};
export function mat(key, make) { return matCache[key] || (matCache[key] = make()); }

export const M = {
  white: () => mat('white', () => new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.42, metalness: 0.0 })),
  offwhite: () => mat('offwhite', () => new THREE.MeshStandardMaterial({ color: 0xe6e4df, roughness: 0.5, metalness: 0.0 })),
  black: () => mat('black', () => new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.62, metalness: 0.1 })),
  carbon: () => mat('carbon', () => new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.38, metalness: 0.25 })),
  darkMetal: () => mat('darkMetal', () => new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.45, metalness: 0.85 })),
  metal: () => mat('metal', () => new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.95 })),
  titanium: () => mat('titanium', () => new THREE.MeshStandardMaterial({ color: 0x8c8a86, roughness: 0.5, metalness: 0.9 })),
  copper: () => mat('copper', () => new THREE.MeshStandardMaterial({ color: 0xa0674a, roughness: 0.4, metalness: 0.95 })),
  grey: () => mat('grey', () => new THREE.MeshStandardMaterial({ color: 0x8d9095, roughness: 0.6, metalness: 0.4 })),
  pipe: () => mat('pipe', () => new THREE.MeshStandardMaterial({ color: 0xb8b8b4, roughness: 0.3, metalness: 0.9 })),
  gold: () => mat('gold', () => new THREE.MeshStandardMaterial({ color: 0xd4a543, roughness: 0.3, metalness: 1.0 })),
};

// 不锈钢（星舰）：带环形焊缝与轻微色差的法线/粗糙度纹理
export function steelMaterial(len, circ, opts = {}) {
  const ring = 1.83; // 钢环高度
  const tex = canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#b9bcc0'; g.fillRect(0, 0, w, h);
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = (fbm(x / 40, y / 25, 4) - 0.5) * 34 + (fbm(x / 6, y / 90, 2) - 0.5) * 12;
      const i = (y * w + x) * 4; d[i] += n; d[i + 1] += n * 0.98; d[i + 2] += n * 0.95;
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = 'rgba(70,64,58,0.55)'; g.fillRect(0, 0, w, 3);             // 环缝
    g.fillStyle = 'rgba(160,120,80,0.18)'; g.fillRect(0, 3, w, 5);           // 焊接热影响区
    g.fillStyle = 'rgba(70,64,58,0.35)'; g.fillRect(w * 0.33, 0, 2, h); g.fillRect(w * 0.66, 0, 2, h); g.fillRect(w - 2, 0, 2, h);
  }, { repeat: true });
  tex.repeat.set(Math.round(circ / 9.5), len / ring);
  const rough = canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#8c8c8c'; g.fillRect(0, 0, w, h);
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const n = (fbm(x / 20, y / 10, 4) - 0.5) * 90; const i = (y * w + x) * 4; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
  }, { srgb: false, repeat: true });
  rough.repeat.copy(tex.repeat);
  return new THREE.MeshStandardMaterial({ map: tex, roughnessMap: rough, roughness: 0.78, metalness: 1.0, envMapIntensity: 1.0, color: opts.tint || 0xffffff });
}

// 星舰防热瓦（六边形黑瓦）
export function tileMaterial(len, circ) {
  const tex = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#0d0d0f'; g.fillRect(0, 0, w, h);
    const r = 16, hw = Math.sqrt(3) * r;
    for (let row = -1; row < h / (1.5 * r) + 1; row++) for (let col = -1; col < w / hw + 1; col++) {
      const cx = col * hw + (row % 2 ? hw / 2 : 0), cy = row * 1.5 * r;
      const sh = 12 + hash(row, col) * 16;
      g.fillStyle = `rgb(${sh},${sh},${sh + 2})`;
      g.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; g.lineTo(cx + Math.cos(a) * (r - 1.2), cy + Math.sin(a) * (r - 1.2)); } g.fill();
      if (hash(col, row) > 0.985) { g.fillStyle = '#d9d6cf'; g.fill(); } // 偶有白色替换瓦
    }
  }, { repeat: true });
  tex.repeat.set(circ / 5, len / 5);
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0.05 });
}

// ---------------------------------------------------------------------------
// 几何体
// ---------------------------------------------------------------------------
/** 钟形喷管轮廓（Rao 抛物线近似）。返回 [外表面, 内表面] 几何，喷口在 y=0，喉部在 y=len */
export function bellGeometry(exitR, len, throatR = exitR * 0.28, seg = 40) {
  const pts = [], n = 22;
  for (let i = 0; i <= n; i++) {
    const t = i / n;                       // 0 喉部 → 1 出口
    const r = throatR + (exitR - throatR) * (1 - Math.pow(1 - t, 1.9));
    pts.push(new THREE.Vector2(r, len * (1 - t)));
  }
  const outer = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p.x * 1.012 + 0.01, p.y)), seg);
  const inner = new THREE.LatheGeometry(pts.slice().reverse(), seg);
  return { outer, inner, pts };
}

/** 喷管内壁（高温）材质：发动机工作时自发光 */
export function hotNozzleMaterial(color = 0x33302d) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.7, emissive: new THREE.Color(0xff6a1a), emissiveIntensity: 0, side: THREE.BackSide });
}

/** 一台发动机（喷管 + 喉部 + 涡轮泵/管路简化） */
export function buildEngine(e, opts = {}) {
  const g = new THREE.Group();
  const exitR = (opts.exitD || e.exitD) / 2, len = opts.bellLen || e.bellLen;
  const { outer, inner } = bellGeometry(exitR, len, exitR * (opts.throat || 0.3));
  const outerMat = opts.outerMat || mat('nozzleOuter' + e.id, () => new THREE.MeshStandardMaterial({ color: e.color, roughness: 0.42, metalness: 0.9, emissive: new THREE.Color(0xff5010), emissiveIntensity: 0 }));
  const innerMat = opts.innerMat || hotNozzleMaterial();
  const mo = new THREE.Mesh(outer, outerMat), mi = new THREE.Mesh(inner, innerMat);
  mo.castShadow = true; g.add(mo, mi);
  // 喷口加强环
  const lip = new THREE.Mesh(new THREE.TorusGeometry(exitR * 1.01, Math.max(0.012, exitR * 0.018), 6, 40), M.darkMetal());
  lip.rotation.x = Math.PI / 2; g.add(lip);
  // 冷却管束纹理感：若干纵向加强筋
  if (!opts.noRibs) {
    const ribGeo = [];
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.TorusGeometry(exitR * (0.55 + i * 0.12) * 1.02, exitR * 0.012, 4, 32);
      ring.rotateX(Math.PI / 2); ring.translate(0, len * (0.75 - i * 0.2), 0); ribGeo.push(ring);
    }
    g.add(new THREE.Mesh(mergeGeometries(ribGeo), M.darkMetal()));
  }
  // 燃烧室 + 涡轮泵
  const chamberR = exitR * (opts.chamber || 0.36);
  const ch = new THREE.Mesh(new THREE.CylinderGeometry(chamberR, chamberR * 0.9, len * 0.45, 20), M.metal());
  ch.position.y = len + len * 0.2; g.add(ch);
  if (!opts.noPump) {
    const tp = new THREE.Mesh(new THREE.CylinderGeometry(chamberR * 0.55, chamberR * 0.55, len * 0.5, 14), M.pipe());
    tp.position.set(chamberR * 1.25, len * 1.1, 0); g.add(tp);
    const pipe = new THREE.Mesh(new THREE.TorusGeometry(chamberR * 0.9, chamberR * 0.12, 8, 18, Math.PI), M.pipe());
    pipe.position.set(chamberR * 0.4, len * 1.3, 0); pipe.rotation.y = Math.PI / 2; g.add(pipe);
    if (opts.exhaustDuct) { // 燃气发生器排气管（Merlin、F-1 等）
      const ex = new THREE.Mesh(new THREE.CylinderGeometry(exitR * 0.09, exitR * 0.11, len * 0.8, 10), M.darkMetal());
      ex.position.set(-chamberR * 1.3, len * 0.75, 0); g.add(ex);
    }
  }
  g.userData = { innerMat, outerMat, exitR, len };
  return g;
}

/** 栅格翼：外框 + 格栅（合并为单一几何体） */
export function gridFinGeometry(w, h, depth, nx, ny, frame = 0.06, bar = 0.018) {
  const geos = [];
  const box = (sx, sy, sz, x, y, z, rz = 0) => { const b = new THREE.BoxGeometry(sx, sy, sz); if (rz) b.rotateZ(rz); b.translate(x, y, z); geos.push(b); };
  box(w, frame, depth, 0, h / 2, 0); box(w, frame, depth, 0, -h / 2, 0);
  box(frame, h, depth, w / 2, 0, 0); box(frame, h, depth, -w / 2, 0, 0);
  // 斜向格栅（真实 F9 格栅为菱形网格）
  const L = Math.hypot(w, h);
  for (let i = -nx; i <= nx; i++) {
    const off = (i / nx) * (w / 2 + h / 2);
    for (const s of [1, -1]) {
      const b = new THREE.BoxGeometry(L * 1.1, bar, depth * 0.96);
      b.rotateZ(s * Math.PI / 4); b.translate(off, 0, 0);
      // 裁剪到框内：使用顶点夹紧近似
      const p = b.attributes.position;
      for (let k = 0; k < p.count; k++) { p.setX(k, Math.max(-w / 2, Math.min(w / 2, p.getX(k)))); p.setY(k, Math.max(-h / 2, Math.min(h / 2, p.getY(k)))); }
      geos.push(b);
    }
  }
  const g = mergeGeometries(geos); g.computeVertexNormals(); return g;
}

/** 大型矩形栅格翼（超重型） */
export function rectGridFinGeometry(w, h, depth, nx, ny, frame = 0.15, bar = 0.05) {
  const geos = [];
  const box = (sx, sy, sz, x, y, z) => { const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(x, y, z); geos.push(b); };
  box(w, frame, depth, 0, h / 2, 0); box(w, frame, depth, 0, -h / 2, 0); box(frame, h, depth, w / 2, 0, 0); box(frame, h, depth, -w / 2, 0, 0);
  for (let i = 1; i < nx; i++) box(bar, h, depth * 0.95, -w / 2 + (i * w) / nx, 0, 0);
  for (let j = 1; j < ny; j++) box(w, bar, depth * 0.95, 0, -h / 2 + (j * h) / ny, 0);
  return mergeGeometries(geos);
}

/** 旋成体：由 [r, y] 点序列生成 */
export function lathe(points, seg = 64, phiStart = 0, phiLen = TAU) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)), seg, phiStart, phiLen);
}

/** 切线卵形（ogive）头锥轮廓：底半径 R、高度 L、从 y0 开始；tipR 为球头半径 */
export function ogive(R, L, y0, n = 28, tipR = 0) {
  const rho = (R * R + L * L) / (2 * R);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * L;                 // 距底部
    const r = Math.sqrt(Math.max(0, rho * rho - x * x)) + R - rho;
    pts.push([Math.max(r, tipR * (i / n)), y0 + x]);
  }
  pts.push([0.0001, y0 + L + tipR * 0.3]);
  return pts;
}

/** 圆柱侧壁（开口），带 UV：u 绕圆周，v 沿轴 */
export function tube(R, y0, y1, seg = 64, open = true) {
  const g = new THREE.CylinderGeometry(R, R, y1 - y0, seg, 1, open);
  g.translate(0, (y0 + y1) / 2, 0); return g;
}

export function meshOf(geo, material, cast = true) { const m = new THREE.Mesh(geo, material); m.castShadow = cast; m.receiveShadow = true; return m; }

/** 桁架塔（四柱 + 横撑 + 斜撑），合并几何以减少绘制调用 */
export function latticeTower(w, d, h, bay, legR, braceR) {
  const geos = [];
  const cyl = (a, b, r) => {
    const v = new THREE.Vector3().subVectors(b, a), L = v.length();
    const c = new THREE.CylinderGeometry(r, r, L, 6, 1, true);
    c.translate(0, L / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
    c.applyQuaternion(q); c.translate(a.x, a.y, a.z); geos.push(c);
  };
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  corners.forEach(([x, z]) => { const bx = new THREE.BoxGeometry(legR * 2, h, legR * 2); bx.translate(x, h / 2, z); geos.push(bx); });
  for (let y = 0; y < h - 0.01; y += bay) {
    const y1 = Math.min(h, y + bay);
    for (let k = 0; k < 4; k++) {
      const [x0, z0] = corners[k], [x1, z1] = corners[(k + 1) % 4];
      cyl(new THREE.Vector3(x0, y1, z0), new THREE.Vector3(x1, y1, z1), braceR);
      if ((Math.floor(y / bay) + k) % 2) cyl(new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y1, z1), braceR * 0.8);
      else cyl(new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y1, z0), braceR * 0.8);
    }
  }
  return mergeGeometries(geos);
}

export { mergeGeometries };
