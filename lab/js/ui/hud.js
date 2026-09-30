// 遥测面板、发动机点火图、推进剂条、事件列表与实时曲线
const $ = (id) => document.getElementById(id);

export function fmtT(t) {
  const neg = t < 0; const a = Math.abs(t);
  const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), s = Math.floor(a % 60);
  return `T${neg ? '−' : '+'} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export function fmtShort(t) {
  if (t == null) return '—';
  const neg = t < 0; const a = Math.abs(t);
  const m = Math.floor(a / 60), s = a % 60;
  return `${neg ? '−' : '+'}${String(m).padStart(2, '0')}:${s.toFixed(0).padStart(2, '0')}`;
}
const num = (v, d = 0) => (isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

const FIELDS = [
  ['alt', '高度', 'km'], ['vs', '地速', 'km/h'], ['vi', '惯性速度', 'm/s'], ['dr', '下航程', 'km'],
  ['mach', '马赫数', ''], ['q', '动压', 'kPa'], ['g', '过载', 'g'], ['thr', '推力', 'kN'],
  ['throttle', '油门', '%'], ['mass', '质量', 't'], ['pitch', '俯仰角', '°'], ['fpa', '航迹角', '°'],
  ['apo', '远地点', 'km'], ['peri', '近地点', 'km'],
];

export class HUD {
  constructor() {
    const grid = $('teleGrid');
    grid.innerHTML = FIELDS.map(([k, n, u]) => `<div class="kv"><div class="k">${n}</div><div class="v" id="tv_${k}">—<small>${u}</small></div></div>`).join('');
    this.units = Object.fromEntries(FIELDS.map(([k, , u]) => [k, u]));
    this.chartKind = 'alt';
    document.querySelectorAll('.chart-tabs button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.chart-tabs button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); this.chartKind = b.dataset.c;
    }));
    this.evEls = new Map();
    this.toastTimer = 0;
  }

  setVal(k, v) { const el = $('tv_' + k); if (el) el.innerHTML = `${v}<small>${this.units[k]}</small>`; }

  telemetry(body, sim) {
    const T = body.tel;
    $('teleName').textContent = body.name;
    const st = $('teleStatus');
    const stTxt = { flying: body.clamped ? '发射台' : '飞行中', landed: '已着陆', caught: '已被捕获', impact: body.kind === 'recovery' ? '坠毁' : '落入大海' }[body.status] || body.status;
    const ctlState = body.ctl && body.status === 'flying' ? { sepCoast: '分离滑行', flip: '翻转', boostback: '返场点火', coast: '无动力滑行', flipEntry: '调姿', entry: '再入点火', aero: '气动减速', landing: '着陆点火' }[body.ctl.state] : null;
    st.textContent = ctlState || stTxt;
    st.className = 'pill ' + (body.status === 'landed' || body.status === 'caught' ? 'good' : body.status === 'impact' ? 'bad' : (T.lit > 0 ? 'warn' : ''));
    this.setVal('alt', num(Math.max(0, T.h) / 1000, T.h < 10000 ? 2 : 1));
    this.setVal('vs', num(T.vSurf * 3.6));
    this.setVal('vi', num(T.vIn));
    this.setVal('dr', num(T.s / 1000, 1));
    this.setVal('mach', num(T.mach || 0, 2));
    this.setVal('q', num((T.q || 0) / 1000, 1));
    this.setVal('g', num((T.aNG || 0) / 9.80665, 2));
    this.setVal('thr', num((T.thrust || 0) / 1000));
    this.setVal('throttle', num((T.throttle || 0) * 100));
    this.setVal('mass', num(T.mass / 1000, 1));
    this.setVal('pitch', num(T.pitch, 1));
    this.setVal('fpa', num(T.fpa, 1));
    this.setVal('apo', T.apo > 0 && isFinite(T.apo) ? num(T.apo / 1000, 0) : '—');
    this.setVal('peri', isFinite(T.peri) && T.apo > 50e3 ? num(T.peri / 1000, 0) : '—');
  }

  engines(body, veh) {
    const svg = $('engSvg');
    // 汇总本箭体所有发动机的布局（优先显示第一级/主发动机组）
    const groups = [];
    for (const p of body.parts) p.groups.forEach((g, gi) => groups.push({ p, g, gi }));
    const key = body.id + ':' + groups.map((x) => x.p.id + x.gi).join(',');
    if (this.engKey !== key) {
      this.engKey = key;
      let maxR = 1;
      const items = [];
      for (const { p, g } of groups) {
        const off = p.def.offset || [0, 0, 0];
        g.layout.forEach(([x, z], i) => { items.push({ x: x + off[0], z: z + off[2], r: g.e.exitD / 2, g, i }); maxR = Math.max(maxR, Math.hypot(x + off[0], z + off[2]) + g.e.exitD / 2); });
      }
      const sc = 52 / maxR;
      svg.innerHTML = `<circle r="56" fill="none" stroke="rgba(150,190,230,0.15)"/>` + items.map((it, k) => `<circle id="eng_${k}" cx="${(it.x * sc).toFixed(1)}" cy="${(-it.z * sc).toFixed(1)}" r="${Math.max(1.6, it.r * sc * 0.92).toFixed(1)}" fill="#1a2230" stroke="#50627a" stroke-width="0.8"/>`).join('');
      this.engItems = items;
    }
    this.engItems.forEach((it, k) => {
      const g = it.g;
      const litIdx = g.order.slice(0, g.lit);
      const on = litIdx.includes(it.i) && g.thrAct > 0.02;
      const el = document.getElementById('eng_' + k);
      if (el) { el.setAttribute('fill', on ? (g.e.prop === 'methalox' ? '#b6a6ff' : g.e.prop === 'hydrolox' ? '#9ec4ff' : '#ffb35c') : '#1a2230'); el.setAttribute('stroke', on ? '#fff' : '#50627a'); }
    });
  }

  props(sim) {
    const el = $('propBars');
    const parts = [];
    for (const b of sim.bodies) for (const p of b.parts) if (p.prop0 > 0 && !p.half) parts.push(p);
    const key = parts.map((p) => p.id).join(',');
    if (this.propKey !== key) {
      this.propKey = key;
      el.innerHTML = parts.map((p) => `<div class="bar"><div class="lab"><span>${p.def.name}</span><b id="pb_t_${p.id}"></b></div><div class="track"><div class="fill" id="pb_${p.id}"></div></div></div>`).join('');
    }
    for (const p of parts) {
      const f = p.prop / p.prop0;
      const b = document.getElementById('pb_' + p.id); if (b) b.style.width = (f * 100).toFixed(1) + '%';
      const t = document.getElementById('pb_t_' + p.id); if (t) t.textContent = `${(p.prop / 1000).toFixed(1)} t · ${(f * 100).toFixed(0)}%`;
    }
  }

  buildEvents(planLog, mission) {
    const list = $('evList');
    this.evEls.clear();
    // 以预演得到的时间表为骨架
    const items = planLog.map((e) => ({ id: e.id, label: e.label, t: e.t, ref: e.ref }));
    list.innerHTML = items.map((e) => `<li id="ev_${e.id}" class="pending"><span class="t">${fmtShort(e.t)}</span><span class="l">${e.label.replace(/ · [\d.]+ kPa/, '').replace(/（偏差[^）]*）/, '')}</span><span class="r">${e.ref != null ? '参考 ' + fmtShort(e.ref) : ''}</span></li>`).join('');
    items.forEach((e) => this.evEls.set(e.id, document.getElementById('ev_' + e.id)));
  }

  event(e) {
    const li = this.evEls.get(e.id);
    if (!li) return;
    li.className = 'done fresh';
    li.querySelector('.t').textContent = fmtShort(e.t);
    li.querySelector('.l').textContent = e.label;
    if (e.ref != null) {
      const d = e.t - e.ref, cls = Math.abs(d) < 8 ? 'ok' : Math.abs(d) < 25 ? 'mid' : '';
      li.querySelector('.r').innerHTML = `参考 ${fmtShort(e.ref)}<span class="d ${cls}">Δ${d >= 0 ? '+' : ''}${d.toFixed(0)} s</span>`;
    }
    setTimeout(() => li.classList.remove('fresh'), 2500);
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    this.toast(e.label.replace(/^.+?：/, (m) => m), e.bodyName);
  }

  toast(text, sub) {
    const t = $('toast'); t.innerHTML = text + (sub ? `<small>${sub}</small>` : ''); t.classList.add('show');
    clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  chart(sim, selBody) {
    const cv = $('chart'), g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const pad = { l: 44, r: 10, t: 10, b: 22 };
    const kind = this.chartKind;
    g.font = '11px JetBrains Mono, monospace'; g.fillStyle = '#8796aa'; g.strokeStyle = 'rgba(150,190,230,0.12)';
    if (kind === 'traj') {
      // 弹道剖面：高度 vs 下航程（所有箭体）
      let maxS = 10, maxH = 10;
      for (const b of sim.bodies) for (const p of b.track) { maxS = Math.max(maxS, Math.abs(p[1]) / 1000); maxH = Math.max(maxH, p[2] / 1000); }
      maxS *= 1.05; maxH *= 1.1;
      const X = (s) => pad.l + ((s / 1000 + maxS * 0.05) / (maxS * 1.05)) * (W - pad.l - pad.r), Y = (h) => H - pad.b - (h / 1000 / maxH) * (H - pad.t - pad.b);
      this.axes(g, W, H, pad, `${maxH.toFixed(0)} km`, `下航程 ${maxS.toFixed(0)} km`);
      const cols = ['#5fb8ff', '#ffb454', '#6be3a5', '#ff7ab6', '#c7a6ff', '#ffe16b'];
      sim.bodies.forEach((b, i) => {
        if (b.track.length < 2 || b.parts.some((p) => p.half)) return;
        g.strokeStyle = cols[i % cols.length]; g.lineWidth = b === selBody ? 2 : 1.2; g.beginPath();
        b.track.forEach((p, k) => (k ? g.lineTo(X(p[1]), Y(p[2])) : g.moveTo(X(p[1]), Y(p[2]))));
        g.stroke();
        const p = b.track[b.track.length - 1]; g.fillStyle = cols[i % cols.length]; g.beginPath(); g.arc(X(p[1]), Y(p[2]), 2.5, 0, 7); g.fill();
      });
      return;
    }
    const hs = sim.history;
    if (hs.length < 2) { this.axes(g, W, H, pad, '', ''); return; }
    const key = { alt: 'h', vel: 'v', q: 'q', g: 'g' }[kind];
    const scale = { alt: 1 / 1000, vel: 3.6, q: 1 / 1000, g: 1 }[kind];
    const unit = { alt: 'km', vel: 'km/h', q: 'kPa', g: 'g' }[kind];
    const t0 = hs[0].t, t1 = Math.max(hs[hs.length - 1].t, t0 + 60);
    let maxV = 1e-6; for (const p of hs) maxV = Math.max(maxV, p[key] * scale);
    maxV *= 1.1;
    const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r), Y = (v) => H - pad.b - (v / maxV) * (H - pad.t - pad.b);
    this.axes(g, W, H, pad, `${maxV.toFixed(maxV < 10 ? 1 : 0)} ${unit}`, `T+${(t1 / 60).toFixed(1)} min`);
    // 真实飞行关键事件竖线
    g.strokeStyle = 'rgba(255,180,84,0.25)';
    for (const e of sim.log) if (e.t > t0) { g.beginPath(); g.moveTo(X(e.t), pad.t); g.lineTo(X(e.t), H - pad.b); g.stroke(); }
    const grad = g.createLinearGradient(0, pad.t, 0, H - pad.b); grad.addColorStop(0, 'rgba(95,184,255,0.35)'); grad.addColorStop(1, 'rgba(95,184,255,0)');
    g.beginPath(); hs.forEach((p, k) => (k ? g.lineTo(X(p.t), Y(p[key] * scale)) : g.moveTo(X(p.t), Y(p[key] * scale))));
    g.lineTo(X(hs[hs.length - 1].t), H - pad.b); g.lineTo(X(hs[0].t), H - pad.b); g.closePath(); g.fillStyle = grad; g.fill();
    g.strokeStyle = '#5fb8ff'; g.lineWidth = 1.8; g.beginPath();
    hs.forEach((p, k) => (k ? g.lineTo(X(p.t), Y(p[key] * scale)) : g.moveTo(X(p.t), Y(p[key] * scale))));
    g.stroke();
  }
  axes(g, W, H, pad, yl, xl) {
    g.strokeStyle = 'rgba(150,190,230,0.14)'; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const y = pad.t + (i / 4) * (H - pad.t - pad.b); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke(); }
    g.fillStyle = '#8796aa'; g.fillText(yl, 4, pad.t + 9); g.fillText(xl, W - pad.r - g.measureText(xl).width, H - 6); g.fillText('0', pad.l - 12, H - pad.b);
  }

  specs(veh, mission) {
    $('specs').innerHTML = `<h3>${veh.nameCN}</h3><div class="en">${veh.name} · ${mission.name}</div>
      <table>${veh.specs.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      <div class="note">飞行由实时物理计算驱动：USSA-1976 标准大气、随环境压强变化的发动机推力、马赫数相关的气动力、RK4 积分与闭环入轨/回收制导。右侧列出仿真事件时间与真实飞行公开时间线的对比。</div>`;
  }
}
