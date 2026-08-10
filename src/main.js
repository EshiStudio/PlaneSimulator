// Точка входа: связывает сцену, самолёт, персонажа и ввод, крутит главный цикл.
import * as THREE from 'three';
import { scene, camera, renderer, updateGround, updateSun } from './scene.js';
import { view, updateFirstPersonCamera, viewForward, viewRight } from './camera.js';
import { Plane } from './plane.js';
import { Character } from './character.js';
import { bindInput, walkInput, clearFlightControls } from './input.js';
import { Hands } from './hands.js';
import { Fire } from './fire.js';
import { setStatus, clearStatus } from './status.js';
import { CHARACTER_HEIGHT, WALK_SPEED, BOARD_DISTANCE, SEAT_OFFSET } from './constants.js';

const MODEL_URL = new URL('../assets/stylized_ww1_plane.glb', import.meta.url).href;
const MAX_FRAME_DT = 0.05;
// Темп спаренного пулемёта: стволы стреляют поочерёдно.
const FIRE_INTERVAL = 0.09;   // с — ~11 выстрелов в секунду
const FIRE_SPREAD = 0.012;    // рад — конус разброса трассеров
// Пули сходятся в центр прицела на этой дистанции: точка прицеливания лежит
// на луче взгляда в SIGHT_DISTANCE, а выстрел идёт из дула в неё. Так пули
// попадают туда, куда смотрит прицел, несмотря на смещение дула от глаз.
const SIGHT_DISTANCE = 40;    // м

// Прыжок: ускорение свободного падения выше земного, чтобы прыжок был
// читаемым. Высота при таких числах ~1.1 м.
const JUMP_SPEED = 6.0;       // м/с — начальная скорость прыжка
const GRAVITY = 16;           // м/с²
// Габариты самолёта для пешей коллизии + радиус персонажа: через них не
// пройти. Высота не участвует: перепрыгнуть самолёт нельзя всё равно.
const PLANE_HALF_W = 3.3;     // полуразмах с запасом
const PLANE_HALF_L = 3.9;     // полдлина с носом и хвостом
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
const fire = new Fire(scene);
let seated = false;
let fireActive = false;   // зажата ЛКМ в кабине
let fireTimer = 0;
let barrel = 0;           // какой ствол стреляет следующим
let jumpVelocity = 0;     // вертикальная скорость персонажа, м/с

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
  jumpVelocity = 0;
}

bindInput(renderer.domElement, {
  movePlane: (dx, dz) => {
    // Стрелок самолётом не управляет — только пулемётом.
    if (seated) return;
    plane.move(dx, dz);
  },
  toggleEngine: () => {
    // Пешком Пробел — прыжок, в кабине — двигатель.
    if (seated) plane.engineOn = !plane.engineOn;
    else if (character.group.position.y <= 0.001) jumpVelocity = JUMP_SPEED;
  },
  toggleSeat,
  fireChange: active => {
    fireActive = active;
    if (!active) fireTimer = 0;
  },
});

setStatus('Загрузка модели самолёта…');
plane.load(MODEL_URL).then(clearStatus).catch(err => {
  console.error(err);
  setStatus('Ошибка загрузки модели: ' + (err?.message ?? err));
});

const hud = document.getElementById('hud');
const crosshair = document.getElementById('crosshair');
// Перекрестие — постоянный центр взаимодействия и точка схода пуль.
crosshair.style.display = 'block';
const clock = new THREE.Clock();
const deg = radians => Math.round(THREE.MathUtils.radToDeg(radians));
const eye = new THREE.Vector3();
const step = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const muzzlePos = new THREE.Vector3();
const muzzleDir = new THREE.Vector3();
const aimPoint = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function walk(dt, { forward: f, strafe: s }) {
  if (f === 0 && s === 0) return;
  viewForward(forward).multiplyScalar(f);
  viewRight(right).multiplyScalar(s);
  step.copy(forward).add(right);
  if (step.lengthSq() === 0) return;
  step.normalize().multiplyScalar(WALK_SPEED * dt);

  // Коллизия с самолётом: скольжение по осям порознь, чтобы не застревать
  // на стыке клетки с бортом и всё же огибать крыло.
  const px = plane.group.position.x;
  const pz = plane.group.position.z;
  const blocked = (x, z) => Math.abs(x - px) < PLANE_HALF_W && Math.abs(z - pz) < PLANE_HALF_L;
  const nx = character.group.position.x + step.x;
  const nz = character.group.position.z + step.z;
  if (!blocked(nx, character.group.position.z)) character.group.position.x = nx;
  if (!blocked(character.group.position.x, nz)) character.group.position.z = nz;
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
    const gunYaw = plane.gunYaw === null ? 0 : plane.gunYaw.rotation.y;
    const gunPitch = plane.gunPitch === null ? 0 : plane.gunPitch.rotation.x;
    hud.textContent =
      `место стрелка   пулемёт: ${deg(gunYaw)}° по курсу, ${deg(gunPitch)}° по высоте   ` +
      `двигатель: ${plane.engineOn ? 'ЗАВЕДЁН' : 'заглушен'}\n` +
      'мышь — наводка пулемёта | ЛКМ — огонь | Пробел — двигатель | E — выйти  ' +
      '(самолётом стрелок не управляет)';
  } else {
    const c = character.group.position;
    const near = c.distanceTo(p) <= BOARD_DISTANCE;
    hud.textContent =
      `пешком   позиция (${c.x.toFixed(1)}, ${c.z.toFixed(1)})   ` +
      `до самолёта ${c.distanceTo(p).toFixed(1)} м   ` +
      `двигатель: ${plane.engineOn ? 'ЗАВЕДЁН' : 'заглушен'}\n` +
      `W/S/A/D — идти | Пробел — прыжок | мышь — осмотреться | ${near ? 'E — сесть в самолёт' : 'подойдите к самолёту и нажмите E'}`;
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), MAX_FRAME_DT);

  const input = walkInput();
  if (seated) {
    // Стрелок наводит пулемёт мышью: углы отсчитываются от самолёта, чтобы
    // наводка не сбивалась, когда машина разворачивается.
    const relativeYaw = view.yaw - plane.yaw;
    plane.aimGun(relativeYaw, view.pitch);
    character.group.rotation.y = relativeYaw;   // корпус и голова следом
    clearFlightControls(plane);   // поверхности стоят в нейтрали
    // В кабине руки на пулемёте: без ходьбы и без качания от шага.
    hands.update(dt, { x: 0, y: 0 }, 0);

    // Огонь: очередь с темпом пулемёта, стволы спарки чередуются.
    if (fireActive) {
      fireTimer -= dt;
      if (fireTimer <= 0) {
        fireTimer = FIRE_INTERVAL;
        barrel = 1 - barrel;
        if (plane.getMuzzle(barrel, muzzlePos, muzzleDir)) {
          // Прицельная точка — на луче взгляда, на дистанции пристрелки.
          // Выстрел из дула в неё: параллакс глаза и ствола не уводит пули.
          camera.getWorldDirection(muzzleDir);
          aimPoint.copy(camera.position).addScaledVector(muzzleDir, SIGHT_DISTANCE);
          muzzleDir.subVectors(aimPoint, muzzlePos).normalize();
          // Разброс: небольшой конус вокруг направления на точку прицела.
          muzzleDir.applyAxisAngle(Y_AXIS, (Math.random() - 0.5) * FIRE_SPREAD);
          muzzleDir.applyAxisAngle(X_AXIS, (Math.random() - 0.5) * FIRE_SPREAD);
          fire.shot(muzzlePos, muzzleDir);
        }
      }
    }
  } else {
    clearFlightControls(plane);
    // Прыжок/приземление: высота ног над полом.
    jumpVelocity -= GRAVITY * dt;
    const flyY = character.group.position.y + jumpVelocity * dt;
    if (flyY <= 0) {
      character.group.position.y = 0;
      jumpVelocity = 0;
    } else {
      character.group.position.y = flyY;
    }
    walk(dt, input);
    const moving = input.forward !== 0 || input.strafe !== 0;
    hands.update(dt, { x: input.strafe, y: input.forward }, moving ? WALK_SPEED : 0);
  }

  fire.update(dt);
  plane.update(dt);
  character.update(dt, null);
  updateFirstPersonCamera(character.eyePosition(eye));
  updateGround();
  updateSun(plane.group.position);
  updateHud();

  renderer.render(scene, camera);
}

animate();
