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

// Наклоны камеры «на ходу», как в `player.gd` (_update_camera_motion):
// корпус слегка кренится в крене и рыскает против стороны хода, а нос
// задирается по ходу. Всё плавно сходится к цели с экспонентой.
const LEAN_ROLL_DEG = 6.0;
const LEAN_YAW_DEG = 1.8;
const LEAN_PITCH_DEG = 1.1;
const LEAN_RESPONSE = 10.0;
// Дополнительный наклон «прогибания» в слайде (оригинальный SLIDE_CAMERA_PITCH_DEGREES).
const SLIDE_LEAN_PITCH_DEG = -4.0;

export const leanState = {
  roll: 0,
  yaw: 0,
  pitch: 0,
};

/** @param input {x,y} направление хода, speedFactor — ходьба относительно максимума. */
export function updateCameraLean(dt, input, speedFactor, stanceAmount) {
  const targetRoll = -input.x * deg(LEAN_ROLL_DEG) * speedFactor;
  const targetYaw = -input.x * deg(LEAN_YAW_DEG) * speedFactor;
  let targetPitch = input.y * deg(LEAN_PITCH_DEG) * speedFactor;
  targetPitch += stanceAmount * deg(SLIDE_LEAN_PITCH_DEG);
  const blend = 1 - Math.exp(-LEAN_RESPONSE * dt);
  leanState.roll += (targetRoll - leanState.roll) * blend;
  leanState.yaw += (targetYaw - leanState.yaw) * blend;
  leanState.pitch += (targetPitch - leanState.pitch) * blend;
}

const deg = v => v * Math.PI / 180;

export function updateFirstPersonCamera(eyePosition) {
  camera.position.copy(eyePosition);
  // Порядок YXZ: сначала курс, затем тангаж — иначе горизонт заваливается.
  // Наклоны от движения накладываются тем же порядком, что в оригинале:
  // head.rotation = (pitch + pitchOffset, yawOffset, rollOffset).
  camera.rotation.order = 'YXZ';
  camera.rotation.set(view.pitch + leanState.pitch, view.yaw + leanState.yaw, leanState.roll);
}
