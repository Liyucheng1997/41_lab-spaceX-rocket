import { FlightSim, planMission } from '../js/physics/flight.js';
const [vid, mid, name, t0, t1, stepS] = process.argv.slice(2);
const plan = planMission(vid, mid, 900);
const sim = new FlightSim(vid, mid, { plan });
let next = +t0;
while (sim.t < +t1) {
  sim.step();
  if (sim.t >= next) {
    next += +(stepS || 5);
    for (const b of sim.bodies) if (b.name.includes(name)) {
      const T = b.tel;
      console.log(`t=${sim.t.toFixed(1)} ${b.ctl?.state||b.mode} h=${(T.h/1000).toFixed(2)} vS=${T.vSurf.toFixed(0)} vV=${T.vVert.toFixed(0)} vH=${T.vHor.toFixed(0)} q=${(T.q/1000).toFixed(1)}k M=${T.mach?.toFixed(2)} aNG=${(T.aNG/9.8).toFixed(2)}g att-up=${((b.att-Math.atan2(b.x,b.y))*57.3).toFixed(0)} pitch=${T.pitch.toFixed(0)} fpa=${T.fpa.toFixed(0)} m=${(b.mass/1000).toFixed(1)} F=${(T.thrust/1000).toFixed(0)} s=${(T.s/1000).toFixed(2)} z=${b.z.toFixed(0)}`);
    }
  }
}
