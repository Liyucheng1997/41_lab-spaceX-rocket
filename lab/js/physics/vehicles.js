// 火箭型号与任务剖面定义（数据驱动）
// 质量、尺寸、发动机取自公开资料的典型值；参考时间 ref 为真实飞行（或典型任务）的公开时间线。
// 坐标约定：箭体坐标系 y 沿箭体轴向上，原点为一级喷管出口平面；x 指向射向（下航程）一侧，z 为横向。

const ring = (n, r, off = 0) => Array.from({ length: n }, (_, i) => {
  const a = off + (i * 2 * Math.PI) / n;
  return [r * Math.cos(a), r * Math.sin(a)];
});

// ---------------- 发射场 ----------------
export const SITES = {
  LC39A: { id: 'LC39A', name: '肯尼迪航天中心 39A 发射台', lat: 28.6082, lon: -80.6041, coastX: 1700, coastHeading: 72, landSide: 'west' },
  STARBASE: { id: 'STARBASE', name: '星际基地 Starbase（得克萨斯）', lat: 25.9967, lon: -97.1544, coastX: 2600, coastHeading: 95, landSide: 'west' },
  WENCHANG: { id: 'WENCHANG', name: '文昌航天发射场 101 工位', lat: 19.6144, lon: 110.9510, coastX: 1300, coastHeading: 115, landSide: 'west' },
};

// ---------------- 猎鹰 9 号 Block 5 ----------------
const F9_S1_LAYOUT = [[0, 0], ...ring(8, 1.25, Math.PI / 8)];
const F9_ORDER = [0, 1, 5, 3, 7, 2, 6, 4, 8];

const falcon9 = {
  id: 'falcon9', name: 'Falcon 9 Block 5', nameCN: '猎鹰 9 号 Block 5', site: 'LC39A', model: 'falcon9',
  height: 70.0, diam: 3.66, pivotY: 26, deckH: 12,
  specs: [
    ['全高', '70.0 m'], ['直径', '3.66 m'], ['起飞质量', '≈ 568 t'], ['起飞推力', '7,607 kN（海平面）'],
    ['一级', '9 × Merlin 1D（煤油/液氧）'], ['二级', '1 × Merlin 1D Vacuum'], ['LEO 运力', '22.8 t（一次性）/ ≈17 t（回收）'],
  ],
  parts: {
    s1: {
      name: '一级（含级间段）', dry: 25600, prop: 411000, diam: 3.66, y0: 0, len: 47.3, pivot: [0, 18, 0],
      engines: [{ type: 'merlin1d', n: 9, layout: F9_S1_LAYOUT, order: F9_ORDER }],
      cdDesc: 0.95, legs: true,
    },
    s2: {
      name: '二级', dry: 4000, prop: 107500, diam: 3.66, y0: 43.1, len: 13.8, pivot: [0, 51, 0],
      engines: [{ type: 'mvac', n: 1, layout: [[0, 0]], order: [0], y: 43.1 }],
    },
    fairing: { name: '整流罩', dry: 1900, diam: 5.2, y0: 56.9, len: 13.1, pivot: [0, 62, 0], halves: true },
    payload: { name: '有效载荷', dry: 16500, diam: 3.66, y0: 57.4, len: 8, pivot: [0, 60, 0] },
  },
  stack: ['s1', 's2', 'fairing', 'payload'],
  missions: {
    starlink: {
      name: 'Starlink 星链组网 · 无人船海上回收', short: '星链 · ASDS',
      azimuth: 43, tStart: -25,
      target: { insertAlt: 200e3, otherAlt: 280e3 },
      ascent: { kickStart: 8, kickDur: 9, kickAngle: 3.4, qLimit: 30e3, thrBucket: 0.78 },
      events: [
        { id: 'ign', label: '一级 9 台 Merlin 点火', ref: -3, when: { t: -3 }, act: [['ignite', 's1', 9, 1]] },
        { id: 'liftoff', label: '起飞 LIFTOFF', ref: 0, when: { t: 0 }, act: [['release']] },
        { id: 'mach1', label: '突破音速', ref: 58, when: { mach: 1 } },
        { id: 'maxq', label: '最大动压 MAX-Q', ref: 72, when: { maxq: true } },
        { id: 'meco', label: '一级主发动机关机 MECO', ref: 147, when: { propBelow: ['s1', 27000] }, act: [['shutdown', 's1']] },
        { id: 'sep', label: '一二级分离', ref: 150, when: { after: ['meco', 3] }, act: [['separate', ['s1'], { recovery: 'f9asds', dv: -1.2 }]] },
        { id: 'ses1', label: '二级发动机点火 SES-1', ref: 158, when: { after: ['sep', 7.5] }, act: [['ignite', 's2', 1, 1], ['guidance', 'peg']] },
        { id: 'fairing', label: '整流罩分离', ref: 175, when: { after: ['ses1', 15] }, act: [['jettison', 'fairing', { halves: true }]] },
        { id: 'seco', label: '二级关机 SECO-1 · 入轨', ref: 519, when: { cutoff: true }, act: [['shutdown', 's2'], ['guidance', 'prograde']] },
        { id: 'deploy', label: '有效载荷分离', ref: 540, when: { after: ['seco', 20] }, act: [['separate', ['payload'], { dv: 0.5, passive: true, name: '星链卫星' }]] },
      ],
      recovery: {
        f9asds: {
          name: '一级', type: 'asds', boostback: false, sepCoast: 4, flipRate: 7,
          entry: { alt: 58e3, dv: 900, engines: 3 }, landing: { engines: 1, margin: 0.78, legsAt: 450 },
          refs: { flip: 160, entryStart: 368, entryEnd: 386, landingStart: 477, touchdown: 505 },
        },
      },
    },
    rtls: {
      name: '返回发射场（RTLS）· 1 号着陆区', short: 'RTLS · 陆上回收',
      azimuth: 50, tStart: -25,
      target: { insertAlt: 210e3, otherAlt: 330e3 },
      payloadMass: 7000,
      ascent: { kickStart: 8, kickDur: 9, kickAngle: 3.9, qLimit: 32e3, thrBucket: 0.8 },
      events: [
        { id: 'ign', label: '一级 9 台 Merlin 点火', ref: -3, when: { t: -3 }, act: [['ignite', 's1', 9, 1]] },
        { id: 'liftoff', label: '起飞 LIFTOFF', ref: 0, when: { t: 0 }, act: [['release']] },
        { id: 'mach1', label: '突破音速', ref: 56, when: { mach: 1 } },
        { id: 'maxq', label: '最大动压 MAX-Q', ref: 70, when: { maxq: true } },
        { id: 'meco', label: '一级主发动机关机 MECO', ref: 137, when: { propBelow: ['s1', 70000] }, act: [['shutdown', 's1']] },
        { id: 'sep', label: '一二级分离', ref: 140, when: { after: ['meco', 3] }, act: [['separate', ['s1'], { recovery: 'f9rtls', dv: -1.2 }]] },
        { id: 'ses1', label: '二级发动机点火 SES-1', ref: 148, when: { after: ['sep', 7.5] }, act: [['ignite', 's2', 1, 1], ['guidance', 'peg']] },
        { id: 'fairing', label: '整流罩分离', ref: 175, when: { after: ['ses1', 25] }, act: [['jettison', 'fairing', { halves: true }]] },
        { id: 'seco', label: '二级关机 SECO-1 · 入轨', ref: 510, when: { cutoff: true }, act: [['shutdown', 's2'], ['guidance', 'prograde']] },
        { id: 'deploy', label: '有效载荷分离', ref: 530, when: { after: ['seco', 20] }, act: [['separate', ['payload'], { dv: 0.5, passive: true, name: '有效载荷' }]] },
      ],
      recovery: {
        f9rtls: {
          name: '一级', type: 'rtls', target: { lat: 28.48580, lon: -80.54427, h: 3, name: 'LZ-1' }, boostback: { engines: 3, pitchUp: 12 },
          sepCoast: 3.5, flipRate: 10,
          entry: { alt: 50e3, dv: 620, engines: 3 }, landing: { engines: 1, margin: 0.78, legsAt: 450 },
          refs: { flip: 146, boostbackStart: 158, boostbackEnd: 210, entryStart: 380, entryEnd: 392, landingStart: 437, touchdown: 462 },
        },
      },
    },
  },
};

// ---------------- 猎鹰重型 ----------------
const falconHeavy = {
  id: 'falconHeavy', name: 'Falcon Heavy', nameCN: '猎鹰重型', site: 'LC39A', model: 'falconHeavy',
  height: 70.0, diam: 12.2, pivotY: 26, deckH: 12,
  specs: [
    ['全高', '70.0 m'], ['宽度', '12.2 m'], ['起飞质量', '≈ 1,420 t'], ['起飞推力', '22,819 kN'],
    ['一级', '3 × 9 台 Merlin 1D（27 台）'], ['二级', '1 × MVac'], ['LEO 运力', '63.8 t（一次性）'],
  ],
  parts: {
    core: {
      name: '芯一级', dry: 30000, prop: 411000, diam: 3.66, y0: 0, len: 47.3, pivot: [0, 18, 0],
      engines: [{ type: 'merlin1d', n: 9, layout: F9_S1_LAYOUT, order: F9_ORDER }], cdDesc: 0.95, legs: true,
    },
    sideA: {
      name: '侧助推器 A', dry: 26500, prop: 411000, diam: 3.66, y0: 0, len: 43.5, offset: [0, 0, -4.0], pivot: [0, 18, -4.0],
      engines: [{ type: 'merlin1d', n: 9, layout: F9_S1_LAYOUT, order: F9_ORDER }], cdDesc: 0.95, legs: true, nosecone: true,
    },
    sideB: {
      name: '侧助推器 B', dry: 26500, prop: 411000, diam: 3.66, y0: 0, len: 43.5, offset: [0, 0, 4.0], pivot: [0, 18, 4.0],
      engines: [{ type: 'merlin1d', n: 9, layout: F9_S1_LAYOUT, order: F9_ORDER }], cdDesc: 0.95, legs: true, nosecone: true,
    },
    s2: {
      name: '二级', dry: 4000, prop: 107500, diam: 3.66, y0: 43.1, len: 13.8, pivot: [0, 51, 0],
      engines: [{ type: 'mvac', n: 1, layout: [[0, 0]], order: [0], y: 43.1 }],
    },
    fairing: { name: '整流罩', dry: 1900, diam: 5.2, y0: 56.9, len: 13.1, pivot: [0, 62, 0], halves: true },
    payload: { name: '有效载荷', dry: 6000, diam: 3.66, y0: 57.4, len: 8, pivot: [0, 60, 0] },
  },
  stack: ['core', 'sideA', 'sideB', 's2', 'fairing', 'payload'],
  missions: {
    demo: {
      name: '重型演示任务 · 双助推器同步返场 + 芯级海上回收', short: '双助推器同步着陆',
      azimuth: 90, tStart: -25,
      target: { insertAlt: 250e3, otherAlt: 1200e3 },
      ascent: { kickStart: 8, kickDur: 9, kickAngle: 5.2, qLimit: 25e3, thrBucket: 0.62 },
      events: [
        { id: 'ign', label: '27 台 Merlin 点火', ref: -3, when: { t: -3 }, act: [['ignite', 'core', 9, 1], ['ignite', 'sideA', 9, 1], ['ignite', 'sideB', 9, 1]] },
        { id: 'liftoff', label: '起飞 LIFTOFF', ref: 0, when: { t: 0 }, act: [['release']] },
        { id: 'corethr', label: '芯级节流（节省推进剂）', ref: 45, when: { t: 45 }, act: [['throttle', 'core', 0.55]] },
        { id: 'mach1', label: '突破音速', ref: 60, when: { mach: 1 } },
        { id: 'maxq', label: '最大动压 MAX-Q', ref: 66, when: { maxq: true } },
        { id: 'beco', label: '侧助推器关机 BECO', ref: 149, when: { propBelow: ['sideA', 82000] }, act: [['shutdown', 'sideA'], ['shutdown', 'sideB']] },
        { id: 'bsep', label: '侧助推器分离', ref: 153, when: { after: ['beco', 3.5] }, act: [
          ['separate', ['sideA'], { recovery: 'sideA', lateral: [0, -2.5], dv: -0.5 }],
          ['separate', ['sideB'], { recovery: 'sideB', lateral: [0, 2.5], dv: -0.5 }],
          ['throttle', 'core', 1]] },
        { id: 'meco', label: '芯级关机 MECO', ref: 184, when: { propBelow: ['core', 62000] }, act: [['shutdown', 'core']] },
        { id: 'sep', label: '芯级与二级分离', ref: 187, when: { after: ['meco', 3] }, act: [['separate', ['core'], { recovery: 'core', dv: -1.2 }]] },
        { id: 'ses1', label: '二级点火 SES-1', ref: 195, when: { after: ['sep', 7.5] }, act: [['ignite', 's2', 1, 1], ['guidance', 'peg']] },
        { id: 'fairing', label: '整流罩分离', ref: 215, when: { after: ['ses1', 18] }, act: [['jettison', 'fairing', { halves: true }]] },
        { id: 'seco', label: '二级关机 SECO-1', ref: 510, when: { cutoff: true }, act: [['shutdown', 's2'], ['guidance', 'prograde']] },
      ],
      recovery: {
        sideA: {
          name: '侧助推器 A', type: 'rtls', target: { lat: 28.48580, lon: -80.54427, h: 3, name: 'LZ-1' }, boostback: { engines: 3, pitchUp: 0 },
          sepCoast: 4, flipRate: 9, entry: { alt: 55e3, dv: 850, engines: 3 }, landing: { engines: 1, margin: 0.78, legsAt: 450 },
          refs: { boostbackStart: 170, entryStart: 398, landingStart: 455, touchdown: 482 },
        },
        sideB: {
          name: '侧助推器 B', type: 'rtls', target: { lat: 28.48763, lon: -80.54176, h: 3, name: 'LZ-2' }, boostback: { engines: 3, pitchUp: 0 },
          sepCoast: 4, flipRate: 9, entry: { alt: 55e3, dv: 850, engines: 3 }, landing: { engines: 1, margin: 0.78, legsAt: 450 },
          refs: { boostbackStart: 170, entryStart: 398, landingStart: 455, touchdown: 482 },
        },
        core: {
          name: '芯一级', type: 'asds', boostback: false, sepCoast: 4, flipRate: 7,
          entry: { alt: 88e3, dv: 1350, engines: 3 }, landing: { engines: 3, engines2: 1, gate: 200, margin: 0.8, legsAt: 450 },

        },
      },
    },
  },
};

// ---------------- 星舰 / 超重型（IFT-5 构型） ----------------
const SH_LAYOUT = [...ring(3, 1.05, Math.PI / 2), ...ring(10, 2.5, 0), ...ring(20, 3.95, Math.PI / 20)];
const SH_ORDER = SH_LAYOUT.map((_, i) => i);
const starship = {
  id: 'starship', name: 'Starship / Super Heavy', nameCN: '星舰 / 超重型', site: 'STARBASE', model: 'starship',
  height: 121.3, diam: 9.0, pivotY: 45, deckH: 22,
  specs: [
    ['全高', '121.3 m（IFT-5 构型）'], ['直径', '9.0 m'], ['起飞质量', '≈ 5,000 t'], ['起飞推力', '≈ 74,400 kN'],
    ['超重型助推器', '33 × Raptor 2（甲烷/液氧）'], ['星舰飞船', '3 × Raptor 海平面 + 3 × Raptor 真空'], ['回收方式', '发射塔"筷子"机械臂空中捕获'],
  ],
  parts: {
    booster: {
      name: '超重型助推器', dry: 275000, prop: 3600000, diam: 9.0, y0: 0, len: 71.0, pivot: [0, 30, 0],
      engines: [{ type: 'raptor2', n: 33, layout: SH_LAYOUT, order: SH_ORDER }], cdDesc: 1.3, catch: true,
    },
    ship: {
      name: '星舰飞船', dry: 130000, prop: 1400000, diam: 9.0, y0: 71.0, len: 50.3, pivot: [0, 92, 0],
      engines: [
        { type: 'raptor2', n: 3, layout: ring(3, 1.05, Math.PI / 2), order: [0, 1, 2], y: 71.0 },
        { type: 'rvac', n: 3, layout: ring(3, 3.05, -Math.PI / 2), order: [0, 1, 2], y: 71.0 },
      ],
    },
  },
  stack: ['booster', 'ship'],
  missions: {
    ift5: {
      name: '第五次综合飞行测试 IFT-5 · 助推器筷子捕获', short: 'IFT-5 · 筷子捕获',
      azimuth: 97, tStart: -25,
      target: { insertAlt: 155e3, otherAlt: -60e3 },
      ascent: { kickStart: 9, kickDur: 10, kickAngle: 0.81, qLimit: 28e3, thrBucket: 0.7 },
      events: [
        { id: 'ign', label: '33 台猛禽发动机点火', ref: -4, when: { t: -4 }, act: [['ignite', 'booster', 33, 0.9]] },
        { id: 'liftoff', label: '起飞 LIFTOFF', ref: 0, when: { t: 0 }, act: [['release']] },
        { id: 'mach1', label: '突破音速', ref: 52, when: { mach: 1 } },
        { id: 'maxq', label: '最大动压 MAX-Q', ref: 62, when: { maxq: true } },
        { id: 'meco', label: '助推器主发动机关机 MECO（保留 3 台）', ref: 159, when: { propBelow: ['booster', 430000] }, act: [['engines', 'booster', 3], ['throttle', 'booster', 0.6]] },
        { id: 'hotstage', label: '热分离：飞船 6 台发动机点火', ref: 161, when: { after: ['meco', 1.5] }, act: [['ignite', 'ship', 3, 0.82, 0], ['ignite', 'ship', 3, 0.82, 1]] },
        { id: 'sep', label: '级间分离', ref: 163, when: { after: ['hotstage', 1.6] }, act: [['shutdown', 'booster'], ['separate', ['booster'], { recovery: 'booster', dv: -2.0 }], ['guidance', 'peg']] },
        { id: 'seco', label: '飞船关机 SECO', ref: 511, when: { cutoff: true }, act: [['shutdown', 'ship'], ['guidance', 'prograde']] },
      ],
      recovery: {
        booster: {
          name: '超重型助推器', type: 'catch', target: { s: 0, z: 0, h: 38 }, boostback: { engines: 13, pitchUp: -10, throttle: 0.8 },
          sepCoast: 1.0, flipRate: 10, entry: null,
          landing: { engines: 13, engines2: 3, gate: 200, vGate: 16, margin: 0.62, catchH: 38, hiQAngle: 8 },
          refs: { flip: 166, boostbackStart: 171, boostbackEnd: 224, landingStart: 364, touchdown: 413 },
        },
      },
    },
  },
};

// ---------------- 土星五号（阿波罗 11 号） ----------------
const SAT_SIC = [[0, 0], ...ring(4, 4.45, Math.PI / 4)];
const SAT_SII = [[0, 0], ...ring(4, 2.65, Math.PI / 4)];
const saturnV = {
  id: 'saturnV', name: 'Saturn V', nameCN: '土星五号', site: 'LC39A', model: 'saturnV',
  height: 110.6, diam: 10.1, pivotY: 38, deckH: 14,
  specs: [
    ['全高', '110.6 m'], ['直径', '10.1 m'], ['起飞质量', '≈ 2,950 t'], ['起飞推力', '33,850 kN'],
    ['S-IC 一级', '5 × F-1（煤油/液氧）'], ['S-II 二级', '5 × J-2（液氢/液氧）'], ['S-IVB 三级', '1 × J-2'],
  ],
  parts: {
    sic: {
      name: 'S-IC 一级', dry: 131000, prop: 2085000, diam: 10.1, y0: 0, len: 42.1, pivot: [0, 18, 0],
      engines: [{ type: 'f1', n: 5, layout: SAT_SIC, order: [1, 2, 3, 4, 0] }], cdDesc: 1.1,
    },
    inter: { name: 'S-II 级间段', dry: 5200, diam: 10.1, y0: 42.1, len: 5.6, pivot: [0, 44.9, 0] },
    sii: {
      name: 'S-II 二级', dry: 36200, prop: 452000, diam: 10.1, y0: 43.8, len: 23.2, pivot: [0, 56, 0],
      engines: [{ type: 'j2', n: 5, layout: SAT_SII, order: [1, 2, 3, 4, 0], y: 43.8 }],
    },
    sivb: {
      name: 'S-IVB 三级', dry: 13300, prop: 109000, diam: 6.6, y0: 66.2, len: 19.5, pivot: [0, 77, 0],
      engines: [{ type: 'j2', n: 1, layout: [[0, 0]], order: [0], y: 66.2 }],
    },
    apollo: { name: '阿波罗飞船（LM + CSM）', dry: 45700, diam: 6.6, y0: 85.7, len: 19.1, pivot: [0, 95, 0] },
    les: { name: '逃逸塔 LES', dry: 4200, diam: 1.2, y0: 101.6, len: 9.0, pivot: [0, 106, 0] },
  },
  stack: ['sic', 'inter', 'sii', 'sivb', 'apollo', 'les'],
  missions: {
    apollo11: {
      name: '阿波罗 11 号 · 1969-07-16 · 进入地球停泊轨道', short: 'Apollo 11',
      azimuth: 72.06, tStart: -25,
      target: { insertAlt: 191e3, otherAlt: 185e3 },
      ascent: { kickStart: 13.2, kickDur: 18, kickAngle: 2.6, qLimit: 99e3, thrBucket: 1 },
      events: [
        { id: 'ign', label: '点火序列开始（F-1 按 1-2-2 顺序启动）', ref: -8.9, when: { t: -8.9 }, act: [['ignite', 'sic', 5, 1]] },
        { id: 'liftoff', label: '释放 · 起飞 LIFTOFF', ref: 0, when: { t: 0 }, act: [['release']] },
        { id: 'tower', label: '越过发射塔', ref: 12.0, when: { altAbove: 136 } },
        { id: 'pitch', label: '滚转与俯仰程序开始', ref: 13.2, when: { t: 13.2 } },
        { id: 'mach1', label: '突破音速', ref: 66.3, when: { mach: 1 } },
        { id: 'maxq', label: '最大动压 MAX-Q', ref: 83.0, when: { maxq: true } },
        { id: 'ceco', label: 'S-IC 中心发动机关机', ref: 135.2, when: { t: 135.2 }, act: [['engines', 'sic', 4]] },
        { id: 'oeco', label: 'S-IC 外围发动机关机', ref: 161.6, when: { propBelow: ['sic', 25000] }, act: [['shutdown', 'sic']] },
        { id: 'sep1', label: 'S-IC / S-II 分离（反推火箭点火）', ref: 162.3, when: { after: ['oeco', 0.7] }, act: [['separate', ['sic'], { dv: -6, passive: true, retro: true, name: 'S-IC' }]] },
        { id: 'sii', label: 'S-II 5 台 J-2 点火', ref: 165.0, when: { after: ['sep1', 2.7] }, act: [['ignite', 'sii', 5, 1], ['guidance', 'peg']] },
        { id: 'inter', label: 'S-II 级间段抛离', ref: 193.3, when: { after: ['sii', 28.3] }, act: [['jettison', 'inter', { dv: -2 }]] },
        { id: 'les', label: '逃逸塔抛离', ref: 197.9, when: { after: ['sii', 32.9] }, act: [['jettison', 'les', { dv: 25, les: true }]] },
        { id: 'sii_ceco', label: 'S-II 中心发动机关机', ref: 460.6, when: { t: 460.6 }, act: [['engines', 'sii', 4]] },
        { id: 'sii_oeco', label: 'S-II 外围发动机关机', ref: 548.2, when: { propEmpty: 'sii' }, act: [['shutdown', 'sii']] },
        { id: 'sep2', label: 'S-II / S-IVB 分离', ref: 549.2, when: { after: ['sii_oeco', 1.0] }, act: [['separate', ['sii'], { dv: -3, passive: true, name: 'S-II' }]] },
        { id: 'sivb', label: 'S-IVB 点火', ref: 552.2, when: { after: ['sep2', 3.0] }, act: [['ignite', 'sivb', 1, 1]] },
        { id: 'seco', label: 'S-IVB 关机 · 进入停泊轨道', ref: 699.3, when: { cutoff: true }, act: [['shutdown', 'sivb'], ['guidance', 'prograde']] },
      ],
      recovery: {},
    },
  },
};

// ---------------- 长征五号 B（天和核心舱） ----------------
const cz5bBooster = (name, ang) => {
  const r = 4.28;
  return {
    name, dry: 12400, prop: 142800, diam: 3.35, y0: 0, len: 27.6,
    offset: [r * Math.cos(ang), 0, r * Math.sin(ang)], pivot: [r * Math.cos(ang), 12, r * Math.sin(ang)], ang,
    engines: [{ type: 'yf100', n: 2, layout: [[0, -0.78], [0, 0.78]], order: [0, 1] }], cdDesc: 1.2, nosecone: true,
  };
};
const cz5b = {
  id: 'cz5b', name: 'Long March 5B', nameCN: '长征五号乙', site: 'WENCHANG', model: 'cz5b',
  height: 53.66, diam: 11.6, pivotY: 20, deckH: 9,
  specs: [
    ['全高', '53.66 m'], ['芯级直径', '5.0 m'], ['助推器直径', '3.35 m × 4'], ['起飞质量', '≈ 837 t'],
    ['起飞推力', '≈ 10,620 kN'], ['芯一级', '2 × YF-77（液氢/液氧）'], ['助推器', '4 × 2 × YF-100（煤油/液氧）'],
  ],
  parts: {
    core: {
      name: '芯一级', dry: 21600, prop: 165300, diam: 5.0, y0: 0, len: 33.2, pivot: [0, 16, 0],
      engines: [{ type: 'yf77', n: 2, layout: [[-1.15, 0], [1.15, 0]], order: [0, 1] }], cdDesc: 1.1,
    },
    b1: cz5bBooster('助推器 Ⅰ', Math.PI / 4), b2: cz5bBooster('助推器 Ⅱ', (3 * Math.PI) / 4),
    b3: cz5bBooster('助推器 Ⅲ', (5 * Math.PI) / 4), b4: cz5bBooster('助推器 Ⅳ', (7 * Math.PI) / 4),
    fairing: { name: '整流罩', dry: 5500, diam: 5.2, y0: 33.2, len: 20.5, pivot: [0, 42, 0], halves: true },
    payload: { name: '天和核心舱', dry: 22500, diam: 4.2, y0: 33.8, len: 16.6, pivot: [0, 42, 0] },
  },
  stack: ['core', 'b1', 'b2', 'b3', 'b4', 'fairing', 'payload'],
  missions: {
    tianhe: {
      name: '天和核心舱发射 · 2021-04-29 · 文昌', short: '天和核心舱',
      azimuth: 108, tStart: -25,
      target: { insertAlt: 200e3, otherAlt: 380e3 },
      ascent: { kickStart: 11, kickDur: 12, kickAngle: 3.3, qLimit: 99e3, thrBucket: 1 },
      events: [
        { id: 'ign', label: '点火：10 台发动机', ref: -3, when: { t: -3 }, act: [['ignite', 'core', 2, 1], ['ignite', 'b1', 2, 1], ['ignite', 'b2', 2, 1], ['ignite', 'b3', 2, 1], ['ignite', 'b4', 2, 1]] },
        { id: 'liftoff', label: '起飞', ref: 0, when: { t: 0 }, act: [['release']] },
        { id: 'pitch', label: '程序转弯', ref: 11, when: { t: 11 } },
        { id: 'mach1', label: '突破音速', ref: 62, when: { mach: 1 } },
        { id: 'maxq', label: '最大动压', ref: 78, when: { maxq: true } },
        { id: 'beco', label: '助推器关机', ref: 173, when: { propBelow: ['b1', 900] }, act: [['shutdown', 'b1'], ['shutdown', 'b2'], ['shutdown', 'b3'], ['shutdown', 'b4'], ['guidance', 'peg']] },
        { id: 'bsep', label: '助推器分离', ref: 174, when: { after: ['beco', 0.8] }, act: [
          ['separate', ['b1'], { passive: true, radial: 6, name: '助推器 Ⅰ' }], ['separate', ['b2'], { passive: true, radial: 6, name: '助推器 Ⅱ' }],
          ['separate', ['b3'], { passive: true, radial: 6, name: '助推器 Ⅲ' }], ['separate', ['b4'], { passive: true, radial: 6, name: '助推器 Ⅳ' }]] },
        { id: 'fairing', label: '整流罩分离', ref: 200, when: { altAbove: 118e3 }, act: [['jettison', 'fairing', { halves: true }]] },
        { id: 'seco', label: '芯一级关机', ref: 480, when: { cutoff: true }, act: [['shutdown', 'core'], ['guidance', 'prograde']] },
        { id: 'deploy', label: '天和核心舱与火箭分离', ref: 494, when: { after: ['seco', 14] }, act: [['separate', ['payload'], { dv: 0.6, passive: true, name: '天和核心舱' }]] },
      ],
      recovery: {},
    },
  },
};

export const VEHICLES = { falcon9, falconHeavy, starship, saturnV, cz5b };

/** 发射场局部平面坐标：返回相对发射台的下航程 s（沿射向）与横向 z（射向右侧），单位 m */
export function siteLocal(site, azDeg, lat, lon) {
  const k = 111320, az = (azDeg * Math.PI) / 180;
  const dN = (lat - site.lat) * k, dE = (lon - site.lon) * k * Math.cos((site.lat * Math.PI) / 180);
  return { s: dN * Math.cos(az) + dE * Math.sin(az), z: -dN * Math.sin(az) + dE * Math.cos(az) };
}
