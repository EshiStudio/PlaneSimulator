// Камера от первого лица: стоит в глазах персонажа, направление задаётся мышью.
import * as THREE from 'three';
import { camera } from './scene.js';
import { VIEW_PITCH_LIMIT } from './constants.js';

// Курс и тангаж взгляда в мировых координатах. При yaw = 0 взгляд направлен
// по -Z — так же, как локальное «вперёд» у персонажа.
export const view = { yaw: 0, pitch: 0 };

export function resetView() {
  view.pitch = 0;
}

export function turnView(dYaw, dPitch) {
  view.yaw -= dYaw;
  view.pitch = THREE.MathUtils.clamp(view.pitch - dPitch, -VIEW_PITCH_LIMIT, VIEW_PITCH_LIMIT);
}

/** Единичный вектор «вперёд» по курсу взгляда, без наклона. */
export function viewForward(target = new THREE.Vector3()) {
  return target.set(-Math.sin(view.yaw), 0, -Math.cos(view.yaw));
}

/** Единичный вектор «вправо» относительно взгляда. */
export function viewRight(target = new THREE.Vector3()) {
  return target.set(Math.cos(view.yaw), 0, -Math.sin(view.yaw));
}

export function updateFirstPersonCamera(eyePosition) {
  camera.position.copy(eyePosition);
  // Порядок YXZ: сначала курс, затем тангаж — иначе горизонт заваливается.
  camera.rotation.order = 'YXZ';
  camera.rotation.set(view.pitch, view.yaw, 0);
}
