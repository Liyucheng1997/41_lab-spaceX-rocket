// 飞行动力学仿真核心
// - 地心惯性系（发射平面内二维）+ 横向 z 通道；地球自转在发射平面内的分量 ω_p = ω_e·cosφ·sin(Az)
// - 引力：μ/r²；大气：USSA-1976；气动阻力：马赫数相关 Cd，按攻角在头部/尾部/侧向之间插值
// - 发动机：推力随环境压强变化（F = τFvac − pAe），质量流量恒定；带启动/关机的推力爬升
// - 制导：一级重力转弯（垂直上升 → 程序转弯 → 零攻角），上面级闭环（类 PEG 线性加速度制导），
//   助推器：翻转 → 返场点火 → 再入点火 → 栅格翼气动修正 → 着陆点火（ZEM/ZEV 横向修正）
import { MU, RE, G0, OMEGA_E, DEG } from './constants.js';
import { atmosphere, P0 } from './atmosphere.js';
import { ENGINES, engineThrust } from './engines.js';
import { VEHICLES, SITES, siteLocal } from './vehicles.js';

export const DT = 0.02; // 固定积分步长 (s)

const M_TAB = [0, 0.6, 0.8, 0.95, 1.05, 1.2, 1.5, 2, 3, 5, 10, 30];
const CD_ASC = [0.30, 0.30, 0.34, 0.52, 0.68, 0.66, 0.58, 0.48, 0.38, 0.30, 0.27, 0.26];
const CD_DESC = [0.95, 1.0, 1.1, 1.35, 1.5, 1.5, 1.42, 1.32, 1.22, 1.15, 1.1, 1.05];
function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x < xs[i]) {
    const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + f * (ys[i] - ys[i - 1]);
  }
  return ys[ys.length - 1];
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// 可复现的伪随机数
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------------------
export class Part {
  constructor(id, def) {
    this.id = id; this.def = def;
    this.dry = def.dry; this.prop = def.prop || 0; this.prop0 = this.prop;
    this.groups = (def.engines || []).map((g) => ({
      e: ENGINES[g.type], n: g.n, layout: g.layout, order: g.order, y: g.y ?? def.y0 ?? 0,
      lit: 0, thrCmd: 0, thrAct: 0, shutting: false,
    }));
  }
  get mass() { return this.dry + this.prop; }
  clone() {
    const p = new Part(this.id, this.def);
    p.prop = this.prop; p.prop0 = this.prop0; p.dry = this.dry;
    p.groups.forEach((g, i) => Object.assign(g, { lit: this.groups[i].lit, thrCmd: this.groups[i].thrCmd, thrAct: this.groups[i].thrAct, shutting: this.groups[i].shutting }));
    return p;
  }
}

let BODY_ID = 0;
export class Body {
  constructor(parts, opts = {}) {
    this.id = opts.id ?? ++BODY_ID;
    this.name = opts.name || parts.map((p) => p.def.name).join(' + ');
    this.kind = opts.kind || 'stack';
    this.parts = parts;
    this.pivot = opts.pivot || [0, 0, 0];
    this.x = 0; this.y = RE; this.vx = 0; this.vy = 0; this.z = 0; this.vz = 0;
    this.att = 0; this.attRate = 0; this.attCmd = 0; this.attRateMax = 2 * DEG; this.attAccMax = 3 * DEG;
    this.zTilt = 0; this.aeroSteer = [0, 0];
    this.mode = 'hold'; this.ctl = null; this.clamped = false; this.fixedEF = null;
    this.status = 'flying'; this.alive = true;
    this.tumble = opts.tumble || null;  // 被动物体的可视翻滚角速度 [wx, wy, wz]
    this.fx = {};                        // 视觉效果标志（反推火箭、RCS 喷气等）
    this.thrFactor = 1;                  // 最大动压节流系数
    this.legs = 0; this.fins = 0; this.arms = 0;
    this.tel = {};
    this.track = [];                     // 地固系轨迹采样
    this.tNextTrack = -1e9;
    this.born = opts.born ?? 0;
    this.refreshGeometry();
  }
  get mass() { let m = 0; for (const p of this.parts) m += p.mass; return m; }
  refreshGeometry() {
    let maxD = 0, extra = 0, ymin = 1e9, ymax = -1e9;
    for (const p of this.parts) {
      const d = p.def.diam || 1;
      if (p.def.offset && this.parts.length > 1) extra += (Math.PI / 4) * d * d; else maxD = Math.max(maxD, d);
      ymin = Math.min(ymin, p.def.y0 ?? 0); ymax = Math.max(ymax, (p.def.y0 ?? 0) + (p.def.len || 1));
    }
    this.area = (Math.PI / 4) * maxD * maxD + extra;
    this.length = ymax - ymin;
    this.sideArea = this.length * Math.max(maxD, 1) * (extra > 0 ? 2 : 1);
    this.baseY = ymin;
    this.cdDesc = Math.max(...this.parts.map((p) => p.def.cdDesc || 1.1));
  }
  groups() { const out = []; for (const p of this.parts) for (const g of p.groups) out.push([p, g]); return out; }
}

// ---------------------------------------------------------------------------
export class FlightSim {
  constructor(vehicleId, missionId, opts = {}) {
    this.veh = VEHICLES[vehicleId];
    this.mission = this.veh.missions[missionId];
    this.site = SITES[this.veh.site];
    this.plan = opts.plan || null;       // 预演结果（用于海上回收目标点等）
    this.planning = !!opts.planning;
    const lat = this.site.lat * DEG, az = this.mission.azimuth * DEG;
    this.omega = OMEGA_E * Math.cos(lat) * Math.sin(az);
    this.t = this.mission.tStart;
    this.rng = mulberry32(1234567);
    this.bodies = []; this.log = []; this.flags = {}; this.fired = {};
    this.events = this.mission.events;
    this.qmax = 0; this.tqmax = 0;
    this.history = [];                   // 主箭遥测历史
    this.targets = {};                   // 回收目标点 {name: {s, z, h}}
    this.listeners = [];

    const parts = this.veh.stack.map((id) => {
      const def = { ...this.veh.parts[id] };
      if (id === 'payload' && this.mission.payloadMass) def.dry = this.mission.payloadMass;
      return new Part(id, def);
    });
    const stack = new Body(parts, { name: this.veh.nameCN, kind: 'stack', pivot: [0, this.veh.pivotY, 0], id: 1 });
    stack.clamped = true; stack.mode = 'hold'; stack.attRateMax = 1.5 * DEG;
    this.stack = stack; this.main = stack;
    this.bodies.push(stack);
    this.placeOnPad(stack);
    stack.att = this.localVerticalAngle(stack);
    stack.attCmd = stack.att;
    this.updateTelemetry(stack);
  }

  on(fn) { this.listeners.push(fn); }
  emit(type, data) { for (const f of this.listeners) f(type, data); }

  // ---------- 坐标变换 ----------
  padR() { return RE + this.veh.deckH; }
  placeOnPad(b) {
    const phi = this.omega * this.t;
    const r = this.padR() + (b.pivot[1] - b.baseY);
    b.x = r * Math.sin(phi); b.y = r * Math.cos(phi);
    b.vx = this.omega * b.y; b.vy = -this.omega * b.x;
  }
  localVerticalAngle(b) { return Math.atan2(b.x, b.y); }
  /** 地固系：下航程弧长 s、高度 h */
  earthFixed(b) {
    const phi = Math.atan2(b.x, b.y) - this.omega * this.t;
    const r = Math.hypot(b.x, b.y);
    return { phi, s: phi * RE, h: r - RE, r };
  }
  fromEarthFixed(s, h, t) {
    const phi = s / RE + this.omega * t, r = RE + h;
    return [r * Math.sin(phi), r * Math.cos(phi)];
  }

  // ---------- 推力与气动 ----------
  thrustInfo(b, p) {
    let F = 0, mdot = 0, Fmax = 0;
    for (const [part, g] of b.groups()) {
      if (g.lit <= 0) continue;
      const thr = g.thrAct * (b.kind === 'stack' ? b.thrFactor : 1);
      F += g.lit * engineThrust(g.e, thr, p);
      mdot += g.lit * thr * g.e.mdot;
      Fmax += g.lit * engineThrust(g.e, 1, p);
    }
    return { F, mdot, Fmax };
  }

  accel(b, s, out) {
    const x = s[0], y = s[1], vx = s[2], vy = s[3], vz = s[5];
    const r = Math.hypot(x, y), h = r - RE;
    const gm = MU / (r * r * r);
    let ax = -gm * x, ay = -gm * y, az = 0;
    const atm = atmosphere(h);
    const rho = atm.rho, p = atm.p, a = atm.a;
    const m = b.mass;
    // 推力
    let F = 0;
    for (const [part, g] of b.groups()) {
      if (g.lit <= 0 || g.thrAct <= 0) continue;
      const thr = g.thrAct * (b.kind === 'stack' ? b.thrFactor : 1);
      F += g.lit * engineThrust(g.e, thr, p);
    }
    const sa = Math.sin(b.att), ca = Math.cos(b.att);
    const czt = Math.cos(b.zTilt), szt = Math.sin(b.zTilt);
    let fx = F * sa * czt, fy = F * ca * czt, fz = F * szt;
    // 气动
    const vax = vx - this.omega * y, vay = vy + this.omega * x, vaz = vz;
    const vrel = Math.hypot(vax, vay, vaz);
    let q = 0, mach = 0;
    if (rho > 0 && vrel > 0.1) {
      q = 0.5 * rho * vrel * vrel;
      mach = vrel / a;
      // 轴向力 + 法向力模型：C_A(M)·cos²α（头部或尾部迎风表不同），
      // 法向力 C_N = C_Nα·sinα·|cosα| + η·C_dc·(S_侧/S_参)·sin²α（细长体理论 + 横流阻力）
      const vxh = vax / vrel, vyh = vay / vrel, vzh = vaz / vrel;
      const ax3 = sa * czt, ay3 = ca * czt, az3 = szt;   // 三维箭体轴（含偏航）
      const c = vxh * ax3 + vyh * ay3 + vzh * az3;   // cosα（+1 头部迎风，−1 尾部迎风）
      const cA = c >= 0 ? interp(M_TAB, CD_ASC, mach) : interp(M_TAB, CD_DESC, mach) * b.cdDesc;
      const FA = q * b.area * cA * c * Math.abs(c);
      fx -= FA * ax3; fy -= FA * ay3; fz -= FA * az3;
      const px = vxh - c * ax3, py = vyh - c * ay3, pz = vzh - c * az3, sn = Math.hypot(px, py, pz);
      if (sn > 1e-4) {
        const CN = 2 * sn * Math.abs(c) + 0.84 * (b.sideArea / b.area) * sn * sn;
        const FN = (q * b.area * CN) / sn;
        fx -= FN * px; fy -= FN * py; fz -= FN * pz;
      }
      // 栅格翼 / 气动舵面产生的横向控制力（受动压限制）
      if (b.aeroSteer[0] || b.aeroSteer[1]) {
        const amax = Math.min(15, (q * b.area * 0.15) / m);
        const ux = y / r, uy = -x / r; // 当地水平（下航程方向）
        const as = clamp(b.aeroSteer[0], -amax, amax), az2 = clamp(b.aeroSteer[1], -amax, amax);
        fx += as * m * ux; fy += as * m * uy; fz += az2 * m;
      }
    }
    ax += fx / m; ay += fy / m; az += fz / m;
    out[0] = vx; out[1] = vy; out[2] = ax; out[3] = ay; out[4] = vz; out[5] = az;
    out.q = q; out.mach = mach; out.F = F; out.p = p; out.rho = rho;
    out.aNG = Math.hypot(fx, fy, fz) / m; // 非引力加速度（过载）
    return out;
  }

  integrate(b, dt) {
    const s0 = [b.x, b.y, b.vx, b.vy, b.z, b.vz];
    const k1 = this.accel(b, s0, []);
    const s1 = s0.map((v, i) => v + 0.5 * dt * k1[i]);
    const k2 = this.accel(b, s1, []);
    const s2 = s0.map((v, i) => v + 0.5 * dt * k2[i]);
    const k3 = this.accel(b, s2, []);
    const s3 = s0.map((v, i) => v + dt * k3[i]);
    const k4 = this.accel(b, s3, []);
    const n = s0.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    [b.x, b.y, b.vx, b.vy, b.z, b.vz] = n;
    b.tel.q = k1.q; b.tel.mach = k1.mach; b.tel.thrust = k1.F; b.tel.aNG = k1.aNG; b.tel.p = k1.p; b.tel.rho = k1.rho;
    // 推进剂消耗
    for (const [part, g] of b.groups()) {
      if (g.lit <= 0 || g.thrAct <= 0) continue;
      const thr = g.thrAct * (b.kind === 'stack' ? b.thrFactor : 1);
      part.prop -= g.lit * thr * g.e.mdot * dt;
      if (part.prop <= 0) {
        part.prop = 0;
        for (const gg of part.groups) { gg.lit = 0; gg.thrCmd = 0; gg.thrAct = 0; }
        this.flags['empty_' + part.id] = true;
      }
    }
  }

  // 发动机推力爬升/关机
  spool(b, dt) {
    for (const [part, g] of b.groups()) {
      if (g.lit <= 0) { g.thrAct = 0; continue; }
      const tgt = g.shutting ? 0 : g.thrCmd;
      const rate = g.thrAct < tgt ? dt / g.e.spool : dt / 0.25;
      g.thrAct += clamp(tgt - g.thrAct, -rate, rate);
      if (g.shutting && g.thrAct <= 0.001) { g.lit = 0; g.shutting = false; g.thrAct = 0; }
    }
  }

  // 姿态：二阶跟踪 + 角速度/角加速度限幅
  steer(b, dt) {
    if (b.tumble) { b.att += b.attRate * dt; return; }
    const err = wrapPi(b.attCmd - b.att);
    const want = clamp(err * 1.2, -b.attRateMax, b.attRateMax);
    b.attRate += clamp(want - b.attRate, -b.attAccMax * dt, b.attAccMax * dt);
    b.att += b.attRate * dt;
    b.fx.rcs = Math.abs(b.attRate) > 1.5 * DEG && (b.tel.q || 0) < 2000 && !b.clamped;
  }

  // ---------- 主箭制导 ----------
  guideStack(b) {
    const m = this.mission.ascent;
    const up = this.localVerticalAngle(b);
    if (b.mode === 'hold') { b.attCmd = up; return; }
    if (b.mode === 'ascent') {
      const tk = this.t - m.kickStart;
      const vax = b.vx - this.omega * b.y, vay = b.vy + this.omega * b.x;
      const vel = Math.atan2(vax, vay);
      const velFromVert = wrapPi(vel - up);
      if (tk < 0) { b.attCmd = up; }
      else if (!b.gturn) {
        const kick = m.kickAngle * DEG * Math.min(1, tk / m.kickDur);
        b.attCmd = up + kick;
        if (tk > m.kickDur && velFromVert >= m.kickAngle * DEG * 0.98) b.gturn = true;
      } else {
        b.attCmd = vel; // 零攻角重力转弯
      }
      // 最大动压节流
      const q = b.tel.q || 0, qL = m.qLimit;
      const want = 1 - clamp((q - 0.82 * qL) / (0.18 * qL), 0, 1) * (1 - m.thrBucket);
      b.thrFactor += clamp(want - b.thrFactor, -0.25 * DT, 0.25 * DT);
      return;
    }
    b.thrFactor += clamp(1 - b.thrFactor, -0.5 * DT, 0.5 * DT);
    if (b.mode === 'peg') {
      this.peg(b);
      // 上面级过载限制（真实火箭在关机前会节流以限制过载）
      const gl = m.gLimit || 4.2;
      const { Fmax } = this.thrustInfo(b, b.tel.p || 0);
      if (Fmax > 0) {
        const want = clamp((gl * G0 * b.mass) / Fmax, 0.4, 1);
        b.thrFactor = Math.min(b.thrFactor, want);
      }
      return;
    }
    if (b.mode === 'prograde') { b.attCmd = Math.atan2(b.vx, b.vy); b.attRateMax = 1 * DEG; return; }
  }

  // 闭环入轨制导（线性径向加速度剖面，类 PEG）
  peg(b) {
    const tg = this.mission.target;
    const r = Math.hypot(b.x, b.y);
    const ux = b.x / r, uy = b.y / r, hx = uy, hy = -ux;
    const vr = b.vx * ux + b.vy * uy, vh = b.vx * hx + b.vy * hy;
    const atm = atmosphere(r - RE);
    const { F, mdot } = this.thrustInfo(b, atm.p);
    const rT = RE + tg.insertAlt, rO = RE + tg.otherAlt;
    const vhT = Math.sqrt((2 * MU * rO) / (rT * (rT + rO)));
    const epsT = -MU / (rT + rO);
    const v2 = b.vx * b.vx + b.vy * b.vy;
    const eps = v2 / 2 - MU / r;
    b.attRateMax = 1.8 * DEG;
    if (F <= 1) { b.attCmd = b.att; return; }
    if (eps >= epsT && !this.flags.cutoff) { this.flags.cutoff = true; return; }
    const m = b.mass, aT = F / m, ve = F / Math.max(mdot, 1e-6);
    const dv = Math.max(vhT - vh, 5);
    let tgo = (m / mdot) * (1 - Math.exp(-dv / ve));
    if (tgo > 10 || !b.peg) {
      tgo = Math.max(tgo, 10);
      const B = (12 * (r + (vr * tgo) / 2 - rT)) / (tgo * tgo * tgo);
      const A = (-vr - (B * tgo * tgo) / 2) / tgo;
      b.peg = { A, B, t: this.t };
    }
    const aCmd = b.peg.A + b.peg.B * (this.t - b.peg.t);
    const aR = aCmd + MU / (r * r) - (vh * vh) / r;
    const sp = clamp(aR / aT, -0.45, 0.9), cp = Math.sqrt(1 - sp * sp);
    const ax = cp * hx + sp * ux, ay = cp * hy + sp * uy;
    b.attCmd = Math.atan2(ax, ay);
  }

  // ---------- 事件 ----------
  checkEvents() {
    const st = this.stack;
    for (const ev of this.events) {
      if (this.fired[ev.id]) continue;
      const w = ev.when;
      let go = false, tEv = this.t;
      if (w.t != null) go = this.t >= w.t - 1e-9;
      else if (w.after) { const f = this.fired[w.after[0]]; go = f != null && this.t >= f + w.after[1] - 1e-9; }
      else if (w.propBelow) { const p = this.findPart(w.propBelow[0]); go = p && p.prop <= w.propBelow[1]; }
      else if (w.propEmpty) go = !!this.flags['empty_' + w.propEmpty];
      else if (w.mach) go = st.status === 'flying' && !st.clamped && (st.tel.mach || 0) >= w.mach;
      else if (w.altAbove) go = !st.clamped && st.tel.h - this.veh.deckH >= w.altAbove;
      else if (w.cutoff) go = !!this.flags.cutoff;
      else if (w.maxq) { go = this.qmax > 5000 && (st.tel.q || 0) < 0.97 * this.qmax && st.mode === 'ascent'; tEv = this.tqmax; }
      if (!go) continue;
      this.fired[ev.id] = this.t;
      let label = ev.label;
      if (w.maxq) label += ` · ${(this.qmax / 1000).toFixed(1)} kPa`;
      this.record(ev.id, label, ev.ref, tEv, st);
      for (const a of ev.act || []) this.act(a);
    }
  }
  record(id, label, ref, t, body) {
    const e = { id, label, ref, t, body: body?.id, bodyName: body?.name, tel: body ? { h: body.tel.h, v: body.tel.vSurf, vi: body.tel.vIn } : null };
    this.log.push(e); this.emit('event', e);
  }
  findPart(id) { for (const b of this.bodies) for (const p of b.parts) if (p.id === id) return p; return null; }
  findBodyOfPart(id) { return this.bodies.find((b) => b.parts.some((p) => p.id === id)); }

  act(a) {
    const [type, ...args] = a;
    if (type === 'ignite') {
      const [pid, n, thr, gi = 0] = args; const p = this.findPart(pid); if (!p) return;
      const g = p.groups[gi]; g.lit = n; g.thrCmd = thr; g.shutting = false;
    } else if (type === 'engines') {
      const p = this.findPart(args[0]); if (p) for (const g of p.groups) if (g.lit) g.lit = Math.min(g.n, args[1]);
    } else if (type === 'throttle') {
      const p = this.findPart(args[0]); if (p) for (const g of p.groups) g.thrCmd = args[1];
    } else if (type === 'shutdown') {
      const p = this.findPart(args[0]); if (p) for (const g of p.groups) if (g.lit) g.shutting = true;
    } else if (type === 'release') {
      const s = this.stack; s.clamped = false; s.mode = 'ascent';
    } else if (type === 'guidance') {
      this.stack.mode = args[0];
    } else if (type === 'separate' || type === 'jettison') {
      const ids = Array.isArray(args[0]) ? args[0] : [args[0]];
      this.separate(ids, args[1] || {}, type === 'jettison');
    }
  }

  separate(ids, opt, jettison) {
    const src = this.findBodyOfPart(ids[0]); if (!src) return;
    const parts = src.parts.filter((p) => ids.includes(p.id));
    src.parts = src.parts.filter((p) => !ids.includes(p.id));
    const sa = Math.sin(src.att), ca = Math.cos(src.att);
    const makeBody = (plist, pivot, extra = {}) => {
      const nb = new Body(plist, { name: extra.name || opt.name || plist.map((p) => p.def.name).join(' + '), kind: extra.kind, pivot, born: this.t, tumble: extra.tumble });
      const dy = pivot[1] - src.pivot[1], dx = pivot[0] - src.pivot[0];
      nb.x = src.x + dy * sa + dx * ca; nb.y = src.y + dy * ca - dx * sa; nb.z = src.z + (pivot[2] - src.pivot[2]);
      nb.vx = src.vx; nb.vy = src.vy; nb.vz = src.vz;
      nb.att = src.att; nb.attCmd = src.att; nb.attRate = src.attRate;
      const dv = extra.dv ?? opt.dv ?? 0;
      nb.vx += dv * sa; nb.vy += dv * ca;
      if (extra.lat) { nb.vx += extra.lat[0] * ca; nb.vy -= extra.lat[0] * sa; nb.vz += extra.lat[1]; }
      nb.tel = { ...src.tel };
      this.bodies.push(nb);
      this.updateTelemetry(nb);
      return nb;
    };
    if (opt.halves) {
      // 整流罩两半：绕铰链向两侧翻开
      for (const side of [-1, 1]) {
        const p = parts[0].clone(); p.dry = parts[0].dry / 2; p.half = side;
        const nb = makeBody([p], [...parts[0].def.pivot], { kind: 'passive', name: `${parts[0].def.name}（${side < 0 ? '左' : '右'}）`, lat: [0, side * 3.5], dv: -0.3, tumble: [0, 0, 0] });
        nb.tumble = [side * 0.35, 0, 0]; nb.half = side; nb.attRate = 0;
      }
    } else if (opt.radial) {
      // 捆绑助推器径向分离
      const p = parts[0], ang = p.def.ang ?? 0;
      const nb = makeBody(parts, [...p.def.pivot], { kind: 'passive', lat: [Math.cos(ang) * opt.radial, Math.sin(ang) * opt.radial], dv: -1 });
      nb.tumble = [Math.sin(ang) * 0.12, 0, -Math.cos(ang) * 0.12]; nb.attRate = -Math.cos(ang) * 0.02;
    } else {
      const pv = this.massPivot(parts);
      const kind = opt.recovery ? 'recovery' : 'passive';
      const nb = makeBody(parts, pv, { kind, lat: opt.lateral });
      if (opt.recovery) {
        nb.ctl = new RecoveryCtl(this, nb, this.mission.recovery[opt.recovery], opt.recovery);
      } else if (opt.les) {
        nb.fx.motorUntil = this.t + 3.5; nb.motorAcc = 60; nb.tumble = [0.05, 0, 0.18];
      } else {
        nb.tumble = [this.rng() * 0.02 - 0.01, 0, -0.01 - this.rng() * 0.01];
        nb.attRate = -0.004;
        if (opt.retro) nb.fx.retroUntil = this.t + 0.8;
      }
      if (opt.name) nb.name = opt.name;
    }
    // 剩余箭体重新计算枢轴（质心附近），保证翻滚/转向自然
    if (src.parts.length) {
      const pv = this.massPivot(src.parts);
      const dy = pv[1] - src.pivot[1], dx = pv[0] - src.pivot[0];
      src.x += dy * sa + dx * ca; src.y += dy * ca - dx * sa; src.z += pv[2] - src.pivot[2];
      src.pivot = pv; src.refreshGeometry();
      if (src.kind === 'stack' && ids.includes('sii')) src.fx.ullageUntil = this.t + 3.5;
    } else { src.alive = false; }
    this.emit('separate', { src, ids });
  }
  massPivot(parts) {
    let m = 0, x = 0, y = 0, z = 0;
    for (const p of parts) { const w = p.mass; const pv = p.def.pivot || [0, (p.def.y0 || 0) + (p.def.len || 0) / 2, 0]; m += w; x += w * pv[0]; y += w * pv[1]; z += w * pv[2]; }
    return [x / m, y / m, z / m];
  }

  // ---------- 遥测 ----------
  updateTelemetry(b) {
    const T = b.tel;
    const r = Math.hypot(b.x, b.y);
    const ux = b.x / r, uy = b.y / r, hx = uy, hy = -ux;
    const ef = this.earthFixed(b);
    const upComp = Math.sin(b.att) * ux + Math.cos(b.att) * uy;
    T.h = ef.h - (b.pivot[1] - b.baseY) * upComp;
    T.hPivot = ef.h; T.s = ef.s; T.z = b.z;
    const vax = b.vx - this.omega * b.y, vay = b.vy + this.omega * b.x;
    T.vIn = Math.hypot(b.vx, b.vy, b.vz);
    T.vSurf = Math.hypot(vax, vay, b.vz);
    T.vVert = vax * ux + vay * uy;
    T.vHor = vax * hx + vay * hy;
    T.fpa = Math.atan2(T.vVert, T.vHor) / DEG;
    T.pitch = Math.atan2(upComp, Math.sin(b.att) * hx + Math.cos(b.att) * hy) / DEG;
    T.mass = b.mass;
    const v2 = b.vx * b.vx + b.vy * b.vy, eps = v2 / 2 - MU / r;
    const hm = b.x * b.vy - b.y * b.vx;
    if (eps < 0) {
      const a = -MU / (2 * eps), e = Math.sqrt(Math.max(0, 1 + (2 * eps * hm * hm) / (MU * MU)));
      T.apo = a * (1 + e) - RE; T.peri = a * (1 - e) - RE;
    } else { T.apo = Infinity; T.peri = NaN; }
    let lit = 0, tot = 0;
    for (const [p, g] of b.groups()) { tot += g.n; if (g.thrAct > 0.02) lit += g.lit; }
    T.lit = lit; T.engines = tot;
    T.throttle = 0;
    for (const [p, g] of b.groups()) if (g.lit && g.thrAct > 0.02) { T.throttle = g.thrAct * (b.kind === 'stack' ? b.thrFactor : 1); break; }
  }

  // ---------- 主循环 ----------
  step() {
    const dt = DT;
    this.checkEvents();
    for (const b of this.bodies) {
      if (!b.alive) continue;
      if (b.kind === 'stack') this.guideStack(b); else if (b.ctl) b.ctl.update(dt);
      else if (b.fx.motorUntil && this.t < b.fx.motorUntil) {
        // 逃逸塔发动机：沿箭体轴向加速
        b.vx += Math.sin(b.att) * b.motorAcc * dt; b.vy += Math.cos(b.att) * b.motorAcc * dt;
      }
      this.spool(b, dt);
      if (b.clamped) { this.placeOnPad(b); b.att = this.localVerticalAngle(b); }
      else if (b.fixedEF) {
        const [x, y] = this.fromEarthFixed(b.fixedEF.s, b.fixedEF.h, this.t + dt);
        b.x = x; b.y = y; b.vx = this.omega * y; b.vy = -this.omega * x; b.z = b.fixedEF.z; b.vz = 0;
        b.att = Math.atan2(x, y); b.attRate = 0; b.tel.q = 0; b.tel.thrust = 0;
      } else {
        this.steer(b, dt);
        this.integrate(b, dt);
      }
      this.updateTelemetry(b);
      // 撞地判定（被动物体 / 失控）
      if (!b.clamped && !b.fixedEF && b.tel.hPivot < (b.kind === 'recovery' ? -5 : 0) && b.status === 'flying') {
        b.status = 'impact'; b.fixedEF = { s: b.tel.s, h: Math.max(-3, b.tel.hPivot), z: b.z };
        b.impactT = this.t;
        if (b.kind !== 'stack') this.emit('impact', b);
      }
      if (this.t >= b.tNextTrack) {
        b.track.push([this.t, b.tel.s, b.tel.h, b.z]); b.tNextTrack = this.t + (b.tel.h < 2000 ? 0.25 : 1);
      }
    }
    // 最大动压跟踪
    const st = this.stack;
    if (!st.clamped && st.mode === 'ascent' && (st.tel.q || 0) > this.qmax) { this.qmax = st.tel.q; this.tqmax = this.t; }
    if (!this.hNext || this.t >= this.hNext) {
      this.hNext = this.t + 0.5;
      const T = st.tel;
      this.history.push({ t: this.t, h: T.h, v: T.vSurf, vi: T.vIn, q: T.q || 0, g: (T.aNG || 0) / G0, s: T.s, thr: T.throttle, m: T.mass });
    }
    this.t += dt;
  }

  runUntil(tEnd, maxSteps = 1e7) { let n = 0; while (this.t < tEnd && n++ < maxSteps) this.step(); }
}

/** 以油门 thr、n 台发动机逆速度方向点火，垂向速度归零时的高度（含阻力与重力） */
function stopHeightFrom(h, vv, vh, m, CdA, n, thr, e, spoolUp) {
  const dt = 0.1;
  for (let i = 0; i < 2000; i++) {
    if (vv >= 0) return h;
    const atm = atmosphere(Math.max(h, 0));
    const v = Math.hypot(vv, vh);
    const F = n * engineThrust(e, thr, atm.p) * (spoolUp ? Math.min(1, (i * dt) / e.spool + 0.05) : 1);
    const D = 0.5 * atm.rho * v * v * CdA * interp(M_TAB, CD_DESC, v / atm.a);
    const a = (F + D) / m;
    vv += (a * (-vv / v) - MU / ((RE + h) ** 2)) * dt;
    vh += a * (-vh / v) * dt;
    h += vv * dt;
  }
  return h;
}

// ===========================================================================
// 助推器回收制导
// ===========================================================================
class RecoveryCtl {
  constructor(sim, body, cfg, key) {
    this.sim = sim; this.b = body; this.cfg = cfg; this.key = key;
    this.state = 'sepCoast'; this.tState = sim.t;
    body.name = cfg.name;
    const planT = sim.plan?.targets?.[key];
    if (cfg.type === 'asds') this.target = planT ? { ...planT } : null; // 预演阶段：自由落点
    else {
      this.target = { ...cfg.target };
      if (cfg.target.lat != null) Object.assign(this.target, siteLocal(sim.site, sim.mission.azimuth, cfg.target.lat, cfg.target.lon));
    }
    if (this.target) sim.targets[key] = this.target;
    this.nextPredict = 0;
    this.nEng = 0;
    this.logged = {};
  }
  group() { return this.b.parts[0].groups[0]; }
  setEngines(n, thr) {
    const g = this.group();
    if (n <= 0) { if (g.lit) g.shutting = true; return; }
    if (!g.lit || g.shutting) { g.thrAct = Math.min(g.thrAct, 0.05); }
    g.lit = n; g.thrCmd = clamp(thr, g.e.minThr, 1); g.shutting = false;
  }
  log(k, label) {
    if (this.logged[k]) return; this.logged[k] = true;
    this.sim.record(this.key + '_' + k, `${this.cfg.name}：${label}`, this.cfg.refs?.[k], this.sim.t, this.b);
  }
  go(state) { this.state = state; this.tState = this.sim.t; }

  // 落点预测：重力 + 阻力 + 简化的着陆点火（低空按真空刹停距离判断点火，推力沿逆速度方向）
  predict(hT, withBurn = true) {
    const sim = this.sim, b = this.b;
    let x = b.x, y = b.y, vx = b.vx, vy = b.vy, z = b.z, vz = b.vz, t = sim.t;
    const m = b.mass, CdA = b.area * b.cdDesc, w = sim.omega;
    const L = this.cfg.landing, e = this.group().e;
    const baseOff = b.pivot[1] - b.baseY;
    let burning = false, tChk = -1e9;
    // 若再入点火尚未执行，预测中也计入它（逆速度方向减速 dv）
    const E = this.cfg.entry;
    let entryLeft = E && (this.state === 'boostback' || this.state === 'coast' || this.state === 'flipEntry' || this.state === 'flip' || this.state === 'sepCoast') ? E.dv : 0;
    if (E && this.state === 'entry') entryLeft = Math.max(0, E.dv - (this.vEntry0 - b.tel.vSurf));
    for (let i = 0; i < 5000; i++) {
      const r = Math.hypot(x, y), h = r - RE - baseOff;
      const vrad = (vx * x + vy * y) / r;
      if (h <= hT && vrad < 0) break;
      if (burning && vrad >= -1) break;
      const dt = h > 90e3 ? 1.0 : h > 20e3 ? 0.4 : 0.1;
      const atm = atmosphere(h);
      const vax = vx - w * y, vay = vy + w * x, vr = Math.hypot(vax, vay, vz);
      const q = 0.5 * atm.rho * vr * vr;
      const cd = interp(M_TAB, CD_DESC, vr / atm.a);
      let k = vr > 0 ? (q * cd * CdA) / (m * vr) : 0;
      const g = MU / (r * r * r);
      if (entryLeft > 0 && h < E.alt && vrad < 0) {
        const aE = (E.engines * engineThrust(e, 1, atm.p)) / m;
        k += aE / Math.max(vr, 1); entryLeft -= aE * dt;
      }
      if (withBurn && L && h < 12000 && vrad < 0) {
        if (!burning && t >= tChk) {
          tChk = t + 0.4;
          const hx = y / r, hy = -x / r;
          const vh = vax * hx + vay * hy, vv = (vax * x + vay * y) / r;
          if (stopHeightFrom(h, vv, vh, m, CdA, L.engines, L.margin, e, true) <= hT + 2) burning = true;
        }
        if (burning) k += (L.engines * engineThrust(e, L.margin, atm.p)) / m / Math.max(vr, 1);
      }
      vx += (-g * x - k * vax) * dt; vy += (-g * y - k * vay) * dt; vz += -k * vz * dt;
      x += vx * dt; y += vy * dt; z += vz * dt; t += dt;
    }
    const phi = Math.atan2(x, y) - w * t;
    return { s: phi * RE, z, t };
  }

  update(dt) {
    const sim = this.sim, b = this.b, c = this.cfg, T = b.tel;
    if (b.status !== 'flying') return;
    const r = Math.hypot(b.x, b.y), ux = b.x / r, uy = b.y / r, hx = uy, hy = -ux;
    const up = Math.atan2(b.x, b.y);
    const vax = b.vx - sim.omega * b.y, vay = b.vy + sim.omega * b.x;
    const retro = Math.atan2(-vax, -vay);
    const retroZ = Math.atan2(-b.vz, Math.hypot(vax, vay)); // 逆速度方向的横向分量
    const since = sim.t - this.tState;
    b.fins = this.state === 'sepCoast' ? 0 : Math.min(1, b.fins + dt / 3);
    b.aeroSteer = [0, 0];

    switch (this.state) {
      case 'sepCoast':
        b.attCmd = b.att;
        if (since > c.sepCoast) { this.go(c.boostback ? 'flip' : 'flipEntry'); this.log('flip', '翻转机动（冷气推力器）'); }
        break;
      case 'flip': {
        const pu = (c.boostback.pitchUp || 10) * DEG;
        const ax = -Math.cos(pu) * hx + Math.sin(pu) * ux, ay = -Math.cos(pu) * hy + Math.sin(pu) * uy;
        b.attCmd = Math.atan2(ax, ay); b.attRateMax = c.flipRate * DEG; b.attAccMax = 4 * DEG;
        if (Math.abs(wrapPi(b.attCmd - b.att)) < 12 * DEG) {
          this.go('boostback'); this.setEngines(c.boostback.engines, c.boostback.throttle || 1); this.log('boostbackStart', '返场点火开始');
        }
        break;
      }
      case 'boostback': {
        const pu = (c.boostback.pitchUp || 10) * DEG;
        if (sim.t >= this.nextPredict) { this.pred = this.predict(this.target.h); this.nextPredict = sim.t + 0.25; }
        const err = this.pred.s - this.target.s; // >0：落点仍偏远
        const ez = this.target.z - this.pred.z;
        const ax = -Math.cos(pu) * hx + Math.sin(pu) * ux, ay = -Math.cos(pu) * hy + Math.sin(pu) * uy;
        b.attCmd = Math.atan2(ax, ay);
        b.zTilt = clamp(Math.atan2(ez, Math.max(err, 0) + 250), -1.45, 1.45); // 推力矢量偏航，同时修正预测落点的横向误差
        if (err < 12000 && this.group().lit > 1) this.setEngines(1, 1);
        if (err <= 0 && Math.abs(ez) < 150) {
          this.setEngines(0); b.zTilt = 0; this.go('coast'); this.log('boostbackEnd', '返场点火结束');
        }
        break;
      }
      case 'flipEntry':
      case 'coast':
        b.attCmd = retro; b.attRateMax = (c.flipRate || 6) * DEG; b.attAccMax = 3 * DEG; b.zTilt = retroZ;
        if (c.entry && T.hPivot < c.entry.alt && T.vVert < 0) {
          this.go('entry'); this.vEntry0 = T.vSurf; this.setEngines(c.entry.engines, 1); this.log('entryStart', '再入点火开始');
        } else if (!c.entry && T.hPivot < 30e3 && T.vVert < 0) this.go('aero');
        break;
      case 'entry':
        b.attCmd = retro; b.zTilt = retroZ;
        if (T.vSurf <= this.vEntry0 - c.entry.dv) { this.setEngines(0); this.go('aero'); this.log('entryEnd', '再入点火结束'); }
        break;
      case 'aero': {
        b.attCmd = retro; b.attRateMax = 6 * DEG; b.zTilt = retroZ;
        if (this.target) {
          if (sim.t >= this.nextPredict) { this.pred = this.predict(this.target.h); this.nextPredict = sim.t + 0.5; }
          const tgo = Math.max(5, this.pred.t - sim.t);
          const es = this.target.s - this.pred.s, ez = this.target.z - this.pred.z;
          b.aeroSteer = [clamp((5 * es) / (tgo * tgo), -20, 20), clamp((5 * ez) / (tgo * tgo), -20, 20)];
        }
        this.tryLanding(dt);
        break;
      }
      case 'landing':
        this.landing(dt);
        break;
    }
  }

  landParams() {
    const c = this.cfg.landing; const g = this.group();
    return { n: this.nLand || c.engines, e: g.e };
  }
  targetH() { return this.target ? this.target.h : 3; }

  // 预测：若此刻以 margin 推力逆速度方向点火，速度归零时的高度（含阻力、重力）
  stopHeight(n, margin, spoolUp = true) {
    const b = this.b, T = b.tel;
    return stopHeightFrom(T.h, T.vVert, T.vHor, b.mass, b.area * b.cdDesc, n, margin, this.group().e, spoolUp);
  }

  tryLanding() {
    const sim = this.sim, b = this.b, T = b.tel, c = this.cfg.landing;
    if (T.h > 12000 || T.vVert > 0) return;
    const hStop = this.stopHeight(c.engines, c.margin);
    if (hStop <= this.targetH() + 2) {
      this.go('landing'); this.nLand = c.engines; this.setEngines(c.engines, c.margin); this.log('landingStart', `着陆点火（${c.engines} 台）`);
      if (!this.target) { const pr = this.predict(3); this.freeTarget = { s: T.s + (pr.s - T.s) * 0.5, z: b.z + (pr.z - b.z) * 0.5, h: 3 }; }
    }
  }

  landing(dt) {
    const sim = this.sim, b = this.b, T = b.tel, c = this.cfg.landing;
    const e = this.group().e;
    const r = Math.hypot(b.x, b.y), ux = b.x / r, uy = b.y / r, hx = uy, hy = -ux;
    const g = MU / (r * r);
    const tgt = this.target || this.freeTarget;
    const hRel = T.h - tgt.h;
    const vdn = -T.vVert;
    b.attRateMax = 14 * DEG; b.attAccMax = 12 * DEG;
    if (hRel < 450) b.legs = Math.min(1, b.legs + dt / 2.2);
    if (c.catchH && hRel < 60) b.arms = 1;
    // 触地 / 捕获判定
    if (hRel <= 0.15) {
      const miss = Math.hypot(T.s - tgt.s, b.z - tgt.z);
      if (sim.planning && this.cfg.type === 'asds') sim.targets[this.key] = { s: T.s, z: b.z, h: tgt.h };
      const planFree = sim.planning && this.cfg.type === 'asds'; // 预演阶段只用于确定回收船位置
      if (!planFree && (vdn > 8 || Math.hypot(T.vHor, b.vz) > 5 || miss > 60)) {
        this.setEngines(0); this.group().lit = 0; this.group().thrAct = 0;
        b.status = 'impact'; b.fixedEF = { s: T.s, h: T.hPivot - hRel, z: b.z }; b.impactT = sim.t;
        this.log('touchdown', `着陆失败（${vdn.toFixed(0)} m/s，偏差 ${miss.toFixed(0)} m）`); sim.emit('impact', b); return;
      }
      this.setEngines(0); this.group().lit = 0; this.group().thrAct = 0;
      b.status = c.catchH ? 'caught' : 'landed';
      b.fixedEF = { s: T.s, h: T.hPivot - hRel, z: b.z };
      b.landT = sim.t; b.landMiss = miss; b.landV = vdn; b.legs = 1;
      if (sim.planning && this.cfg.type === 'asds') sim.targets[this.key] = { s: T.s, z: b.z, h: tgt.h };
      this.log('touchdown', c.catchH ? `机械臂捕获成功（偏差 ${miss.toFixed(1)} m，${vdn.toFixed(1)} m/s）` : `着陆成功（偏差 ${miss.toFixed(1)} m，触地 ${vdn.toFixed(1)} m/s）`);
      sim.emit('landed', b);
      return;
    }
    // 末段：以恒定小速度缓降（筷子捕获更慢更稳）
    const vFinal = c.catchH ? 0.8 : 1.6;
    let tgo = clamp((2 * hRel) / Math.max(vdn, 0.5), 0.5, 60);
    let aUp = (vdn * vdn - vFinal * vFinal) / (2 * Math.max(hRel, 0.3)) + g;
    // 多发动机着陆：先用大推力段刹停到"切换门"（gate 高度处的适配速度），再用少数发动机精细下降
    const gate = c.engines2 && this.nLand > c.engines2 ? c.gate || 0 : 0;
    let vGate = 0;
    if (gate > 0) {
      const a2g = (c.engines2 * engineThrust(e, 1, T.p)) / b.mass - g;
      vGate = Math.min(c.vGate || 99, 0.75 * Math.sqrt(2 * 0.45 * Math.max(a2g, 0.5) * gate));
      aUp = (vdn * vdn - vGate * vGate) / (2 * Math.max(hRel - gate, 0.3)) + g;
    }
    const vProfile = Math.sqrt(vFinal * vFinal + 2 * 2.5 * Math.max(0, hRel - 2));
    if (c.catchH && hRel < 25 && vdn < vProfile + 3) { aUp = g + (vdn - Math.min(vProfile, vFinal + hRel * 0.25)) * 2.0; tgo = clamp(hRel / Math.max(vFinal, 0.5), 0.5, 20); }
    const Fone = engineThrust(e, 1, T.p);
    const v = T.vSurf;
    const es = tgt.s - T.s, ez = tgt.z - b.z;
    const vs = T.vHor, vz = b.vz;
    // 统一的 ZEM/ZEV 最优着陆制导：垂向按恒减速刹停，横向消除零控脱靶量；扣除气动阻力的贡献；
    // 推力方向与逆速度方向夹角受限（高动压下避免大攻角）
    const D = v > 1 ? ((T.q || 0) * b.area * b.cdDesc * interp(M_TAB, CD_DESC, T.mach || 0)) / b.mass : 0;
    // 横向在"切换门"之前就完成对准（真实超重型在塔旁先减速再平移入臂）
    const tgoH = gate > 0 ? clamp((2 * Math.max(hRel - gate, 1)) / Math.max(vdn, 1), 0.5, 60) : tgo;
    let as = (6 * (es - vs * tgoH)) / (tgoH * tgoH) + (2 * vs) / tgoH;
    let az = (6 * (ez - vz * tgoH)) / (tgoH * tgoH) + (2 * vz) / tgoH;
    if (hRel < 6) { as = -vs * 1.5 + es * 0.3; az = -vz * 1.5 + ez * 0.3; }
    let aV = aUp - (v > 1 ? D * (vdn / v) : 0);
    as += v > 1 ? D * (vs / v) : 0; az += v > 1 ? D * (vz / v) : 0;
    aV = Math.max(aV, 0.5);
    // 限制推力方向：高速时相对逆速度方向，低速时相对竖直方向
    // 高动压时尾部迎风的箭体若偏转推力会产生反向法向力，因此推力保持逆速度方向，横向修正交给栅格翼
    const qNow = T.q || 0;
    const maxAng = (qNow > 1500 && v > 150 ? c.hiQAngle || 2 : v > 60 ? 12 : hRel < 30 ? 7 : 16) * DEG;
    if (qNow > 400) b.aeroSteer = [clamp(as, -20, 20), clamp(az, -20, 20)];
    let ref = v > 60 ? [-vs / v, vdn / v, -vz / v] : [0, 1, 0];
    let aMag = Math.hypot(as, aV, az), dir = [as / aMag, aV / aMag, az / aMag];
    const cosA = dir[0] * ref[0] + dir[1] * ref[1] + dir[2] * ref[2];
    if (cosA < Math.cos(maxAng)) {
      const perp = [dir[0] - cosA * ref[0], dir[1] - cosA * ref[1], dir[2] - cosA * ref[2]];
      const pn = Math.hypot(...perp) || 1;
      dir = ref.map((r0, i) => Math.cos(maxAng) * r0 + Math.sin(maxAng) * perp[i] / pn);
      aMag = aV / Math.max(0.2, dir[1]);
    }
    as = dir[0] * aMag; aV = dir[1] * aMag; az = dir[2] * aMag;
    // 垂向油门：高速段用"刹停高度预测"反解恒定油门（含阻力随速度的变化），末段用 v²/2h 精确控制
    let thrV = null;
    if (v > 25 && hRel > 40 + 2.5 * gate) {
      if (sim.t >= (this.nextThr || 0)) {
        this.nextThr = sim.t + 0.2;
        const n = this.nLand, eMin = e.minThr, hT = tgt.h + gate * 0.5;
        let lo = eMin, hi = 1;
        if (this.stopHeight(n, hi, false) < hT) this.thrV = 1;
        else if (this.stopHeight(n, lo, false) > hT) this.thrV = lo;
        else { for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; if (this.stopHeight(n, mid, false) > hT) hi = mid; else lo = mid; } this.thrV = (lo + hi) / 2; }
      }
      thrV = this.thrV;
    }
    if (thrV != null) {
      const F = this.nLand * engineThrust(e, thrV, T.p);
      const k = F / b.mass / Math.hypot(as, aV, az);
      as *= k; aV *= k; az *= k;
    }
    // 筷子捕获末段：解耦的速度跟踪控制（垂向按刹车曲线缓降，横向按位置误差给定速度）
    if (c.catchH && this.nLand <= (c.engines2 || 99) && hRel < (c.gate || 150) + 20) {
      const aMax = (this.nLand * Fone) / b.mass - g;
      const vdes = Math.min(16, vFinal + 0.12 * Math.max(0, hRel - 2) + Math.sqrt(2 * 0.12 * Math.max(aMax, 0.5) * Math.max(0, hRel - 2)));
      aV = g + 2.2 * (vdn - vdes);
      const la = Math.tan(6 * DEG) * g;
      const vsDes = Math.sign(es) * Math.min(5, Math.sqrt(2 * 0.5 * la * Math.abs(es)));
      const vzDes = Math.sign(ez) * Math.min(5, Math.sqrt(2 * 0.5 * la * Math.abs(ez)));
      as = 0.9 * (vsDes - vs); az = 0.9 * (vzDes - vz);
      const lim = Math.tan((hRel < 20 ? 4 : 8) * DEG) * Math.max(aV, 1), hh = Math.hypot(as, az);
      if (hh > lim) { as *= lim / hh; az *= lim / hh; }
      aV = Math.max(aV, 0.5);
    }
    const aT = Math.hypot(as, aV, az);
    // 发动机数量切换：当少数发动机（~85% 推力）已足以在剩余高度内刹停时，关闭外圈
    const a2 = c.engines2 ? (0.85 * c.engines2 * Fone) / b.mass - g : 0;
    const doSwitch = c.gate ? (hRel <= gate + 1 || vdn <= vGate + 1.5) : a2 > 0.5 && (vdn * vdn - vFinal * vFinal) / (2 * a2) < hRel * 0.92;
    if (c.engines2 && this.nLand > c.engines2 && doSwitch) {
      this.nLand = c.engines2; this.log('engReduce', `关闭外圈发动机，保留 ${c.engines2} 台`);
    }
    const thr = (b.mass * aT) / (this.nLand * Fone);
    this.setEngines(this.nLand, thr);
    const axw = as * hx + aV * ux, ayw = as * hy + aV * uy;
    b.attCmd = Math.atan2(axw, ayw);
    b.zTilt = Math.atan2(az, Math.hypot(as, aV));
  }
}

/** 预演整次任务（确定性），得到海上回收落点与事件时间表 */
export function planMission(vehicleId, missionId, tEnd = 900) {
  const sim = new FlightSim(vehicleId, missionId, { planning: true });
  sim.runUntil(tEnd);
  return { targets: { ...sim.targets }, log: sim.log.slice(), sim };
}
