// Точка входа: связывает сцену, самолёт и ввод, крутит главный цикл.
import * as THREE from 'three';
import { scene, camera, renderer, updateGround, updateSun } from './scene.js';
import { updateChaseCamera } from './camera.js';
import { Plane } from './plane.js';
import { bindInput, updateHeldKeys } from './input.js';
import { setStatus, clearStatus } from './status.js';

const MODEL_URL = new URL('../assets/stylized_ww1_plane.glb', import.meta.url).href;
const MAX_FRAME_DT = 0.05;

const plane = new Plane();
scene.add(plane.group);
bindInput(renderer.domElement, plane);

setStatus('Загрузка модели самолёта…');
plane.load(MODEL_URL).then(clearStatus).catch(err => {
  console.error(err);
  setStatus('Ошибка загрузки модели: ' + (err?.message ?? err));
});

const hud = document.getElementById('hud');
const clock = new THREE.Clock();
const deg = radians => Math.round(THREE.MathUtils.radToDeg(radians));

/** Знак отклонения поверхности: вверх / вниз / нейтраль. */
function surfaceText(angle) {
  const value = deg(angle);
  if (value === 0) return 'нейтраль';
  return `${value > 0 ? 'вверх' : 'вниз'} ${Math.abs(value)}°`;
}

function updateHud() {
  const p = plane.group.position;
  hud.textContent =
    `двигатель: ${plane.engineOn ? 'ЗАВЕДЁН' : 'заглушен'}   ` +
    `руль высоты: ${surfaceText(plane.elevatorAngle)}   ` +
    `элероны: правый ${surfaceText(plane.aileronAngle)}   ` +
    `клетка (${plane.cell.x}, ${plane.cell.z})   мир (${p.x.toFixed(1)}, ${p.z.toFixed(1)})` +
    '\nW/S — руль высоты | A/D — элероны | стрелки — самолёт по клеткам | ' +
    'Пробел — двигатель | ЛКМ+мышь — камера | колесо — зум | Q/E — камера выше/ниже | R — сброс';
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), MAX_FRAME_DT);

  updateHeldKeys(dt, plane);
  updateChaseCamera(plane.group.position, plane.yaw);
  plane.update(dt);
  updateGround();
  updateSun(plane.group.position);
  updateHud();

  renderer.render(scene, camera);
}

animate();
