// 相机系统：自由环绕 / 地面长焦跟踪 / 伴飞 / 箭载 / 发射台近景
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const CAM_MODES = [
  { id: 'orbit', name: '自由观察', key: '1' },
  { id: 'tracking', name: '地面长焦跟踪', key: '2' },
  { id: 'chase', name: '伴飞', key: '3' },
  { id: 'onboard', name: '箭载相机', key: '4' },
  { id: 'pad', name: '发射台近景', key: '5' },
];

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 8; this.controls.maxDistance = 4e6;
    this.controls.zoomSpeed = 1.2;
    this.mode = 'orbit';
    this.prevTarget = new THREE.Vector3();
    this.station = new THREE.Vector3(-900, 6, 2400);
    this.padCam = new THREE.Vector3(55, 3, 70);
    this.fovBase = 45;
    this.tmp = new THREE.Vector3(); this.tmp2 = new THREE.Vector3();
    this.smoothTarget = new THREE.Vector3();
    this.first = true;
  }
  setMode(m, info) {
    this.mode = m;
    this.controls.enabled = m === 'orbit' || m === 'chase';
    this.first = true;
    if (m === 'orbit' && info) {
      const d = info.size * 1.6;
      this.camera.position.copy(info.center).add(new THREE.Vector3(d * 0.55, d * 0.1, d));
      this.controls.target.copy(info.center);
    }
    this.camera.fov = this.fovBase; this.camera.updateProjectionMatrix();
  }
  setStations(site, deckH) {
    // 地面跟踪站：位于发射台西南侧约 3 km（真实的长焦跟踪相机距离）
    this.station.set(-1200, 8, 2600);
    this.padCam.set(48, deckH + 1.5, 64);
  }
  /**
   * info: { center: 世界坐标, size: 目标尺度 m, quat: 箭体姿态, up: 当地铅垂方向, bodyTop, bodyR }
   */
  update(dt, info) {
    const cam = this.camera, c = this.controls;
    if (!info) return;
    if (this.mode === 'orbit' || this.mode === 'chase') {
      if (this.first) { this.prevTarget.copy(info.center); if (this.mode === 'chase') this.placeChase(info); this.first = false; }
      const delta = this.tmp.subVectors(info.center, this.prevTarget);
      cam.position.add(delta); c.target.add(delta);
      this.prevTarget.copy(info.center);
      // 目标平滑跟随
      c.target.lerp(info.center, 1 - Math.exp(-dt * 6));
      cam.up.copy(info.up);
      c.update();
      if (cam.fov !== this.fovBase) { cam.fov = this.fovBase; cam.updateProjectionMatrix(); }
    } else if (this.mode === 'tracking') {
      cam.position.copy(this.station);
      cam.up.set(0, 1, 0);
      if (this.first) { this.smoothTarget.copy(info.center); this.first = false; }
      this.smoothTarget.lerp(info.center, 1 - Math.exp(-dt * 4));
      cam.lookAt(this.smoothTarget);
      const dist = cam.position.distanceTo(info.center);
      const want = THREE.MathUtils.clamp((2 * Math.atan((info.frame * info.size) / dist) * 180) / Math.PI, 0.25, 55);
      cam.fov += (want - cam.fov) * (1 - Math.exp(-dt * 2.5));
      cam.updateProjectionMatrix();
    } else if (this.mode === 'pad') {
      cam.position.copy(this.padCam);
      cam.up.set(0, 1, 0);
      if (this.first) { this.smoothTarget.copy(info.center); this.first = false; }
      this.smoothTarget.lerp(info.center, 1 - Math.exp(-dt * 3));
      cam.lookAt(this.smoothTarget);
      const dist = cam.position.distanceTo(info.center);
      const want = THREE.MathUtils.clamp((2 * Math.atan((0.75 * info.size) / dist) * 180) / Math.PI, 2, 70);
      cam.fov += (want - cam.fov) * (1 - Math.exp(-dt * 2));
      cam.updateProjectionMatrix();
    } else if (this.mode === 'onboard') {
      // 箭体侧壁上的相机，沿箭体向下看（可见发动机尾焰与地球）
      const q = info.quat;
      const off = this.tmp.set(info.bodyR + 0.9, info.onboardY, 0.4).applyQuaternion(q);
      cam.position.copy(info.origin).add(off);
      const look = this.tmp2.set(info.bodyR * 0.6, info.onboardY - 30, 0).applyQuaternion(q).add(info.origin);
      cam.up.set(1, 0, 0).applyQuaternion(q);
      cam.lookAt(look);
      if (cam.fov !== 70) { cam.fov = 70; cam.updateProjectionMatrix(); }
    }
  }
  placeChase(info) {
    const d = info.size * 2.2;
    const side = this.tmp.set(0.35, -0.25, 1).normalize().multiplyScalar(d).applyQuaternion(info.quat);
    this.camera.position.copy(info.center).add(side);
    this.controls.target.copy(info.center);
  }
}
