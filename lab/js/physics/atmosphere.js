// 1976 美国标准大气 (U.S. Standard Atmosphere 1976)
// 0–86 km 使用分层温度梯度解析解；86–1000 km 使用标准表格做对数插值。
import { G0, RE } from './constants.js';

const R_AIR = 287.053;   // J/(kg·K)
const GAMMA = 1.4;
const R0_GEOPOT = 6356766; // 标准大气使用的地球半径（位势高度换算）

// [底层位势高度 m, 底层温度 K, 温度梯度 K/m, 底层压强 Pa]
const LAYERS = [
  [0,     288.15, -0.0065, 101325.0],
  [11000, 216.65,  0.0,     22632.06],
  [20000, 216.65,  0.001,   5474.889],
  [32000, 228.65,  0.0028,  868.0187],
  [47000, 270.65,  0.0,     110.9063],
  [51000, 270.65, -0.0028,  66.93887],
  [71000, 214.65, -0.002,   3.956420],
];

// 86 km 以上：[几何高度 m, 压强 Pa, 密度 kg/m³, 温度 K]
const UPPER = [
  [86e3,   0.3734,   6.958e-6,  186.87],
  [100e3,  3.201e-2, 5.604e-7,  195.08],
  [120e3,  2.538e-3, 2.222e-8,  360.0],
  [150e3,  4.542e-4, 2.076e-9,  634.4],
  [200e3,  8.474e-5, 2.541e-10, 854.6],
  [250e3,  2.476e-5, 6.073e-11, 941.3],
  [300e3,  8.770e-6, 1.916e-11, 976.0],
  [400e3,  1.452e-6, 2.803e-12, 995.8],
  [500e3,  3.019e-7, 5.215e-13, 999.2],
  [600e3,  8.2e-8,   1.137e-13, 999.9],
  [800e3,  1.7e-8,   1.136e-14, 1000],
  [1000e3, 7.5e-9,   3.561e-15, 1000],
];

const out = { rho: 0, p: 0, T: 0, a: 0 };

/** 输入几何高度 h (m)，返回 {rho, p, T, a}（共享对象，调用方需立即读取） */
export function atmosphere(h) {
  if (h < 86000) {
    const hg = Math.max(-500, (R0_GEOPOT * h) / (R0_GEOPOT + h)); // 位势高度
    let i = LAYERS.length - 1;
    while (i > 0 && hg < LAYERS[i][0]) i--;
    const [hb, Tb, L, Pb] = LAYERS[i];
    const dh = hg - hb;
    let T, p;
    if (L === 0) {
      T = Tb;
      p = Pb * Math.exp((-G0 * dh) / (R_AIR * Tb));
    } else {
      T = Tb + L * dh;
      p = Pb * Math.pow(Tb / T, G0 / (R_AIR * L));
    }
    out.T = T; out.p = p; out.rho = p / (R_AIR * T); out.a = Math.sqrt(GAMMA * R_AIR * T);
    return out;
  }
  if (h >= 1000e3) { out.T = 1000; out.p = 0; out.rho = 0; out.a = 600; return out; }
  let i = 0;
  while (i < UPPER.length - 2 && h > UPPER[i + 1][0]) i++;
  const a = UPPER[i], b = UPPER[i + 1];
  const f = (h - a[0]) / (b[0] - a[0]);
  out.p = Math.exp(Math.log(a[1]) + f * (Math.log(b[1]) - Math.log(a[1])));
  out.rho = Math.exp(Math.log(a[2]) + f * (Math.log(b[2]) - Math.log(a[2])));
  out.T = a[3] + f * (b[3] - a[3]);
  out.a = Math.sqrt(GAMMA * R_AIR * Math.min(out.T, 300));
  return out;
}

export const P0 = 101325;
export { RE };
