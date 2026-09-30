// 离线整定一级程序转弯角：使级间分离高度接近目标
import { FlightSim, planMission } from '../js/physics/flight.js';
import { VEHICLES } from '../js/physics/vehicles.js';
const [vid, mid, evId, target] = process.argv.slice(2);
const m = VEHICLES[vid].missions[mid];
let lo = 0.8, hi = 8;
for (let i = 0; i < 12; i++) {
  const k = (lo + hi) / 2; m.ascent.kickAngle = k;
  const sim = new FlightSim(vid, mid, { planning: true });
  sim.runUntil(400);
  const e = sim.log.find((e) => e.id === evId);
  const h = e ? e.tel.h : 0;
  console.log(k.toFixed(3), e ? `${e.t.toFixed(1)}s h=${(h / 1000).toFixed(1)}km v=${(e.tel.v * 3.6).toFixed(0)}` : 'none');
  if (h > +target) lo = k; else hi = k;
}
