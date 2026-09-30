// 真实卫星影像：EOX Sentinel-2 cloudless 2020（10 m 分辨率，Web 墨卡托瓦片）
// 在发射场周围按三个细节层级拼接成画布纹理，供局部地形着色器按经纬度采样。
// 影像署名：Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2020)
import * as THREE from 'three';

const URL = (z, y, x) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;

export function mercator(lat, lon) {
  const la = (lat * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2];
}

function loadImg(src) {
  return new Promise((res) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = src;
  });
}

/** 加载一个层级：以 (lat, lon) 为中心、半宽 halfKm 的区域，返回 { texture, rect:[mx0,my0,mx1,my1] } */
export async function loadLevel(lat, lon, halfKm, z, maxAniso = 8) {
  const dLat = halfKm / 111.32, dLon = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const [ax, ay] = mercator(lat + dLat, lon - dLon), [bx, by] = mercator(lat - dLat, lon + dLon);
  const n = 2 ** z;
  const tx0 = Math.floor(ax * n), tx1 = Math.floor(bx * n), ty0 = Math.floor(ay * n), ty1 = Math.floor(by * n);
  const W = (tx1 - tx0 + 1) * 256, H = (ty1 - ty0 + 1) * 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#1d2b22'; g.fillRect(0, 0, W, H);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push(loadImg(URL(z, ty, tx)).then((im) => { if (im) g.drawImage(im, (tx - tx0) * 256, (ty - ty0) * 256); return !!im; }));
  }
  const ok = (await Promise.all(jobs)).filter(Boolean).length;
  if (ok < jobs.length * 0.6) return null;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture: tex, rect: new THREE.Vector4(tx0 / n, ty0 / n, (tx1 + 1) / n, (ty1 + 1) / n) };
}

/** 三级影像：近场 z14（±7 km）、中场 z11（±45 km）、远场 z8（±260 km） */
export async function loadSiteImagery(site, uniforms, maxAniso) {
  const levels = [[14, 7], [11, 45], [8, 260]];
  await Promise.all(levels.map(async ([z, km], i) => {
    const r = await loadLevel(site.lat, site.lon, km, z, maxAniso);
    if (!r) return;
    uniforms['uImg' + i].value = r.texture;
    uniforms['uRect' + i].value.copy(r.rect);
    uniforms.uImgOn.value.setComponent(i, 1);
  }));
}

export const IMAGERY_CREDIT = '卫星影像：Sentinel-2 cloudless 2020 © EOX IT Services GmbH（含修改的 Copernicus Sentinel 数据）';
