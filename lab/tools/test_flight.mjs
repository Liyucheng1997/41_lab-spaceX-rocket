// 无界面飞行验证：node lab/tools/test_flight.mjs [vehicle] [mission]
import { FlightSim, planMission } from '../js/physics/flight.js';
import { VEHICLES } from '../js/physics/vehicles.js';

const fmtT = (t) => (t < 0 ? 'T-' : 'T+') + new Date(Math.abs(t) * 1000).toISOString().substr(14, 5) + '.' + String(Math.floor((Math.abs(t) % 1) * 10));
const only = process.argv[2], onlyM = process.argv[3];

for (const [vid, v] of Object.entries(VEHICLES)) {
  if (only && vid !== only) continue;
  for (const mid of Object.keys(v.missions)) {
    if (onlyM && mid !== onlyM) continue;
    const t0 = Date.now();
    const plan = planMission(vid, mid, 900);
    const sim = new FlightSim(vid, mid, { plan });
    sim.runUntil(900);
    console.log(`\n==== ${v.nameCN} / ${v.missions[mid].name}  (plan+run ${Date.now() - t0} ms)`);
    const m0 = new FlightSim(vid, mid).stack.mass;
    console.log(`  起飞质量 ${(m0 / 1000).toFixed(0)} t`);
    for (const e of sim.log) {
      const d = e.ref != null ? ` (参考 ${fmtT(e.ref)}, Δ${(e.t - e.ref).toFixed(0)}s)` : '';
      const tel = e.tel ? `  h=${(e.tel.h / 1000).toFixed(1)} km  v=${(e.tel.v * 3.6).toFixed(0)} km/h` : '';
      console.log(`  ${fmtT(e.t)}  ${e.label}${d}${tel}`);
    }
    for (const b of sim.bodies) {
      const T = b.tel;
      console.log(`  · [${b.kind}] ${b.name}: ${b.status} h=${(T.h / 1000).toFixed(1)}km s=${(T.s / 1000).toFixed(1)}km z=${(b.z / 1000).toFixed(2)}km vIn=${T.vIn.toFixed(0)} apo=${(T.apo / 1000).toFixed(0)} peri=${(T.peri / 1000).toFixed(0)} prop=${b.parts.map((p) => (p.prop / 1000).toFixed(1) + 't').join('/')}` +
        (b.landMiss != null ? ` miss=${b.landMiss.toFixed(1)}m v=${b.landV.toFixed(2)}` : ''));
    }
    const hq = sim.history.reduce((a, h) => (h.q > a.q ? h : a), { q: 0 });
    const hg = sim.history.reduce((a, h) => (h.g > a.g ? h : a), { g: 0 });
    console.log(`  maxQ ${(hq.q / 1000).toFixed(1)} kPa @ ${fmtT(hq.t)} h=${(hq.h / 1000).toFixed(1)}km ; max g ${hg.g.toFixed(2)} @ ${fmtT(hg.t)}`);
  }
}
