// Точка входа: связывает сцену, самолёт, персонажа и ввод, крутит главный цикл.
import * as THREE from 'three';
import { scene, camera, renderer, updateGround, updateSun } from './scene.js';
import { view, updateFirstPersonCamera, viewForward, viewRight } from './camera.js';
import { Plane } from './plane.js';
import { Character } from './character.js';
import { bindInput, walkInput, applyFlightControls, clearFlightControls } from './input.js';
import { Hands } from './hands.js';
import { setStatus, clearStatus } from './status.js';
import { CHARACTER_HEIGHT, WALK_SPEED, BOARD_DISTANCE, SEAT_OFFSET } from './constants.js';

const MODEL_URL = new URL('../assets/stylized_ww1_plane.glb', import.meta.url).href;
const MAX_FRAME_DT = 0.05;
// Где персонаж стоит в начале — у левого крыла, лицом к самолёту.
const START_OFFSET = { x: -4.6, z: 1.4 };

const plane = new Plane();
scene.add(plane.group);

const character = new Character();
character.setHeight(CHARACTER_HEIGHT);
character.hideHeadForOwner(true);   // камера стоит внутри головы
scene.add(character.group);
character.group.position.set(
  plane.group.position.x + START_OFFSET.x,
  0,
  plane.group.position.z + START_OFFSET.z
);
character.faceTowards(plane.group.position.x, plane.group.position.z);
view.yaw = character.group.rotation.y;

const hands = new Hands();
let seated = false;

/** Посадка в самолёт и высадка по клавише E. */
function toggleSeat() {
  if (seated) {
    // Высадка слева от самолёта, лицом наружу.
    const exit = new THREE.Vector3(START_OFFSET.x, 0, START_OFFSET.z).applyAxisAngle(
      new THREE.Vector3(0, 1, 0), plane.yaw
    );
    scene.add(character.group);   // add переносит узел из самолёта в сцену
    character.group.position.copy(plane.group.position).add(exit);
    character.group.position.y = 0;
    character.group.rotation.set(0, view.yaw, 0);
    seated = false;
    return;
  }

  // Далеко — не садимся; подсказку об этом показывает HUD.
  if (character.group.position.distanceTo(plane.group.position) > BOARD_DISTANCE) return;

  plane.group.add(character.group);
  character.group.position.set(SEAT_OFFSET.x, SEAT_OFFSET.y, SEAT_OFFSET.z);
  // Место заднего стрелка: он сидит спиной к пилоту и смотрит на хвост.
  // Нос самолёта — +Z, хвост — -Z, лицо персонажа — его локальное -Z.
  character.group.rotation.set(0, 0, 0);
  view.yaw = plane.yaw;
  seated = true;
}

bindInput(renderer.domElement, {
  movePlane: (dx, dz) => {
    const before = plane.yaw;
    plane.move(dx, dz);
    // Сидя в кабине взгляд разворачивается вместе с машиной.
    if (seated) view.yaw += plane.yaw - before;
  },
  toggleEngine: () => { plane.engineOn = !plane.engineOn; },
  toggleSeat,
});

setStatus('Загрузка модели самолёта…');
plane.load(MODEL_URL).then(clearStatus).catch(err => {
  console.error(err);
  setStatus('Ошибка загрузки модели: ' + (err?.message ?? err));
});

const hud = document.getElementById('hud');
const clock = new THREE.Clock();
const deg = radians => Math.round(THREE.MathUtils.radToDeg(radians));
const eye = new THREE.Vector3();
const step = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();

function walk(dt, { forward: f, strafe: s }) {
  if (f === 0 && s === 0) return;
  viewForward(forward).multiplyScalar(f);
  viewRight(right).multiplyScalar(s);
  step.copy(forward).add(right);
  if (step.lengthSq() === 0) return;
  step.normalize().multiplyScalar(WALK_SPEED * dt);
  character.group.position.add(step);
  character.group.rotation.y = view.yaw;   // корпус смотрит туда же, куда взгляд
}

/** Знак отклонения поверхности: вверх / вниз / нейтраль. */
function surfaceText(angle) {
  const value = deg(angle);
  if (value === 0) return 'нейтраль';
  return `${value > 0 ? 'вверх' : 'вниз'} ${Math.abs(value)}°`;
}

function updateHud() {
  const p = plane.group.position;
  if (seated) {
    hud.textContent =
      `в кабине   двигатель: ${plane.engineOn ? 'ЗАВЕДЁН' : 'заглушен'}   ` +
      `руль высоты: ${surfaceText(plane.elevatorAngle)}   ` +
      `элероны: правый ${surfaceText(plane.aileronAngle)}   ` +
      `клетка (${plane.cell.x}, ${plane.cell.z})\n` +
      'W/S — руль высоты | A/D — элероны | стрелки — самолёт по клеткам | ' +
      'Пробел — двигатель | E — выйти | ЛКМ+мышь — осмотреться';
  } else {
    const c = character.group.position;
    const near = c.distanceTo(p) <= BOARD_DISTANCE;
    hud.textContent =
      `пешком   позиция (${c.x.toFixed(1)}, ${c.z.toFixed(1)})   ` +
      `до самолёта ${c.distanceTo(p).toFixed(1)} м   ` +
      `двигатель: ${plane.engineOn ? 'ЗАВЕДЁН' : 'заглушен'}\n` +
      `W/S/A/D — идти | ЛКМ+мышь — осмотреться | ${near ? 'E — сесть в самолёт' : 'подойдите к самолёту и нажмите E'}`;
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), MAX_FRAME_DT);

  const input = walkInput();
  if (seated) {
    applyFlightControls(plane);
    // В кабине руки лежат на ручке: без ходьбы и без качания от шага.
    hands.update(dt, { x: 0, y: 0 }, 0);
  } else {
    clearFlightControls(plane);
    walk(dt, input);
    const moving = input.forward !== 0 || input.strafe !== 0;
    hands.update(dt, { x: input.strafe, y: input.forward }, moving ? WALK_SPEED : 0);
  }

  plane.update(dt);
  character.update(dt, null);
  updateFirstPersonCamera(character.eyePosition(eye));
  updateGround();
  updateSun(plane.group.position);
  updateHud();

  renderer.render(scene, camera);
}

animate();
