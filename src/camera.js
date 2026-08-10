// Камера преследования: всегда за хвостом самолёта, управляется только мышью и Q/E.
import * as THREE from 'three';
import { camera } from './scene.js';
import { CAM_DEFAULT, CAM_MIN_DIST, CAM_MAX_DIST, CAM_MIN_HEIGHT, CAM_MAX_HEIGHT } from './constants.js';

export const camState = { ...CAM_DEFAULT };

export function resetCamera() {
  Object.assign(camState, CAM_DEFAULT);
}

export function zoomCamera(factor) {
  camState.dist = THREE.MathUtils.clamp(camState.dist * factor, CAM_MIN_DIST, CAM_MAX_DIST);
}

export function raiseCamera(delta) {
  camState.height = THREE.MathUtils.clamp(camState.height + delta, CAM_MIN_HEIGHT, CAM_MAX_HEIGHT);
}

export function orbitCamera(delta) {
  camState.orbit -= delta;
}

const lookTarget = new THREE.Vector3();

export function updateChaseCamera(planePosition, planeYaw) {
  // направление от самолёта к камере: за хвост (хвост = -Z модели)
  const tailAngle = planeYaw + camState.orbit;
  const dx = -Math.sin(tailAngle);
  const dz = -Math.cos(tailAngle);
  camera.position.set(
    planePosition.x + dx * camState.dist,
    planePosition.y + camState.height,
    planePosition.z + dz * camState.dist
  );
  lookTarget.set(planePosition.x, planePosition.y + 1.2, planePosition.z);
  camera.lookAt(lookTarget);
}
