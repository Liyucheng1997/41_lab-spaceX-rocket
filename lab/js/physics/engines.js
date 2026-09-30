// 发动机数据库（公开资料的典型值）
// Fsl/Fvac: 海平面/真空推力 N；isp: 真空比冲 s；exitD: 喷管出口直径 m
// 推力模型：F(p) = τ·Fvac − p·Ae，其中 Ae = (Fvac − Fsl)/p0（喷管出口面积，由两推力反推）
// 质量流量：ṁ = τ·Fvac/(isp·g0)，与环境压强无关（这正是海平面比冲更低的原因）
import { G0 } from './constants.js';
import { P0 } from './atmosphere.js';

export const ENGINES = {
  merlin1d: {
    name: 'Merlin 1D', cycle: '燃气发生器', prop: 'kerolox',
    Fsl: 845e3, Fvac: 914e3, isp: 311, minThr: 0.45, spool: 0.55,
    exitD: 0.92, bellLen: 1.25, length: 2.4, color: 0x2a2b2e,
  },
  mvac: {
    name: 'Merlin 1D Vacuum', cycle: '燃气发生器', prop: 'kerolox',
    Fsl: 115e3, Fvac: 981e3, isp: 348, minThr: 0.39, spool: 0.6,
    exitD: 3.3, bellLen: 2.9, length: 4.2, color: 0x3a3634, glowNozzle: true,
  },
  raptor2: {
    name: 'Raptor 2', cycle: '全流量分级燃烧', prop: 'methalox',
    Fsl: 2256e3, Fvac: 2394e3, isp: 347, minThr: 0.40, spool: 0.7,
    exitD: 1.30, bellLen: 1.45, length: 3.1, color: 0x6b6f75,
  },
  rvac: {
    name: 'Raptor Vacuum', cycle: '全流量分级燃烧', prop: 'methalox',
    Fsl: 2159e3, Fvac: 2580e3, isp: 378, minThr: 0.40, spool: 0.7,
    exitD: 2.30, bellLen: 2.6, length: 4.6, color: 0x6b6f75,
  },
  f1: {
    name: 'F-1', cycle: '燃气发生器', prop: 'kerolox', soot: true,
    Fsl: 6770e3, Fvac: 7740e3, isp: 304, minThr: 1.0, spool: 1.2,
    exitD: 3.76, bellLen: 3.6, length: 5.8, color: 0x1c1c1e,
  },
  j2: {
    name: 'J-2', cycle: '燃气发生器', prop: 'hydrolox',
    Fsl: 727e3, Fvac: 1033e3, isp: 421, minThr: 1.0, spool: 1.0,
    exitD: 1.96, bellLen: 2.1, length: 3.4, color: 0x3b3c40,
  },
  yf100: {
    name: 'YF-100', cycle: '补燃循环', prop: 'kerolox',
    Fsl: 1200e3, Fvac: 1340e3, isp: 335, minThr: 0.65, spool: 0.6,
    exitD: 1.33, bellLen: 1.5, length: 2.9, color: 0x303235,
  },
  yf77: {
    name: 'YF-77', cycle: '燃气发生器', prop: 'hydrolox',
    Fsl: 510e3, Fvac: 700e3, isp: 430, minThr: 1.0, spool: 0.8,
    exitD: 1.55, bellLen: 1.9, length: 4.2, color: 0x3d3e42,
  },
};

for (const k in ENGINES) {
  const e = ENGINES[k];
  e.id = k;
  e.Ae = (e.Fvac - e.Fsl) / P0;           // 出口面积
  e.mdot = e.Fvac / (e.isp * G0);           // 满推力质量流量
  e.ispSL = e.isp * e.Fsl / e.Fvac;         // 由一致性导出的海平面比冲
}

/** 单台发动机在环境压强 p、节流 τ 下的推力 (N) */
export function engineThrust(e, thr, p) {
  return Math.max(0, thr * e.Fvac - p * e.Ae);
}
