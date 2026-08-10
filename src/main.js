// Точка входа: связывает сцену, самолёт, персонажа и ввод, крутит главный цикл.
import * as THREE from 'three';
import { scene, camera, renderer, updateGround, updateSun } from './scene.js';
import { view, updateFirstPersonCamera, updateCameraLean } from './camera.js';
import { Plane } from './plane.js';
import { Character } from './character.js';
import { PlayerPhysics, MAX_WALK_SPEED } from './player.js';
import { renderFrame } from './postfx.js';
import { bindInput, walkInput, jumpHeld, slideHeld, clearFlightControls } from './input.js';
import { Hands } from './hands.js';
import { Fire } from './fire.js';
import { setStatus, clearStatus } from './status.js';
import { CHARACTER_HEIGHT, BOARD_DISTANCE, SEAT_OFFSET } from './constants.js';

const MODEL_URL = new URL('../assets/stylized_ww1_plane.glb', import.meta.url).href;
const MAX_FRAME_DT = 0.05;
// Темп спаренного пулемёта: стволы стреляют поочерёдно.
const FIRE_INTERVAL = 0.09;   // с — ~11 выстрелов в секунду
const FIRE_SPREAD = 0.012;    // рад — конус разброса трассеров
// Пули сходятся в центр прицела на этой дистанции: точка прицеливания лежит
// на луче взгляда в SIGHT_DISTANCE, а выстрел идёт из дула в неё. Так пули
// попадают туда, куда смотрит прицел, несмотря на смещение дула от глаз.
const SIGHT_DISTANCE = 40;    // м

// Радиус персонажа для пешей коллизии с корпусом: форма самолёта берётся из
// сетки занятости (см. plane.js #buildCollisionGrid), а не из прямоугольника.
const PLAYER_RADIUS = 0.35;   // м
// Высота ступеньки при автошаге — та же, что в plane.js COLLISION_STEP_UP.
const CHARACTER_STEP_UP = 0.5;
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
const player = new PlayerPhysics();
const fire = new Fire(scene);
let seated = false;
let onFloor = true;
let fireActive = false;   // зажата ЛКМ в кабине
let fireTimer = 0;
let barrel = 0;           // какой ствол стреляет следующим

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
    player.velocity.set(0, 0, 0);
    onFloor = true;
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
  isSeated: () => seated,
  movePlane: (dx, dz) => {
    // Стрелок самолётом не управляет — только пулемётом.
    if (seated) return;
    plane.move(dx, dz);
  },
  toggleEngine: () => {
    // Пешком Пробел — прыжок, в кабине — двигатель.
    if (seated) plane.engineOn = !plane.engineOn;
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
const muzzlePos = new THREE.Vector3();
const muzzleDir = new THREE.Vector3();
const aimPoint = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// «Ноги» стоят на земле (y=0); при прыжке голова поднимается на velocity.y.
const GROUND_Y = 0;
// Подшаг пешей коллизии: движение разбивается на куски этого размера, чтобы
// быстрый слайд (до ~15 м/с) не проскакивал сквозь ячейки сетки 0.2 м и не
// «влетал» внутрь корпуса.
const COLLISION_SUB_STEP = 0.1;

function walk(dt, input) {
  player.update(dt, input, onFloor, view.yaw);

  // Коллизия с самолётом — сетка занятости мешей (см. plane.js
  // #buildCollisionGrid): ячейки ниже ступеньки проходимы, на верхних
  // гранях можно стоять, стены блокируют только на уровне тела.
  const blocked = (x, z, y) => plane.isBlocked(x, z, PLAYER_RADIUS, y, CHARACTER_HEIGHT);
  const p = character.group.position;
  const moveX = player.velocity.x * dt;
  const moveZ = player.velocity.z * dt;
  const dist = Math.hypot(moveX, moveZ);
  const steps = Math.max(1, Math.ceil(dist / COLLISION_SUB_STEP));
  for (let i = 0; i < steps; i++) {
    const sx = moveX / steps;
    const sz = moveZ / steps;
    if (!blocked(p.x + sx, p.z, p.y)) p.x += sx;
    if (!blocked(p.x, p.z + sz, p.y)) p.z += sz;
  }
  // Страховка от застревания: если всё же оказались внутри сетки (ниша,
  // стены сомкнулись вокруг) — выталкиваем к ближайшей свободной точке.
  if (blocked(p.x, p.z, p.y)) {
    outer: for (let r = 1; r <= 10; r++) {
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        const tx = p.x + Math.cos(ang) * r * 0.12;
        const tz = p.z + Math.sin(ang) * r * 0.12;
        if (!blocked(tx, tz, p.y)) {
          p.x = tx;
          p.z = tz;
          break outer;
        }
      }
    }
  }
  // Вертикаль: прыжок/гравитация; приземление на верхние грани и
  // автоматический шаг на низкие ступеньки (колёса, стойки) при движении.
  p.y += player.velocity.y * dt;
  const floor = Math.max(GROUND_Y, plane.floorAt(p.x, p.z, PLAYER_RADIUS, p.y + CHARACTER_STEP_UP));
  const canRise = player.velocity.y < 0 || player.horizontalSpeed > 0.2;
  if (p.y <= floor && canRise) {
    p.y = floor;
    player.velocity.y = 0;
    onFloor = true;
  } else {
    onFloor = p.y <= floor + 0.05;
  }
  character.group.rotation.y = view.yaw;   // корпус смотрит туда же, куда взгляд

  // Как в `_update_camera_motion`: скорость фильтруется и нормируется на max_speed.
  const speedFactor = Math.min(player.filteredSpeed / MAX_WALK_SPEED, 1.25);
  updateCameraLean(dt, player.filteredInput, speedFactor, player.stanceAmount);
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
      `W/S/A/D — идти | мышь — осмотреться | Пробел — прыжок | Shift — скольжение | ` +
      `${near ? 'E — сесть в самолёт' : 'подойдите к самолёту и нажмите E'}`;
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), MAX_FRAME_DT);

  if (seated) {
    // Стрелок наводит пулемёт мышью: углы отсчитываются от самолёта, чтобы
    // наводка не сбивалась, когда машина разворачивается.
    const relativeYaw = view.yaw - plane.yaw;
    plane.aimGun(relativeYaw, view.pitch);
    character.group.rotation.y = relativeYaw;   // корпус и голова следом
    clearFlightControls(plane);   // поверхности стоят в нейтрали
    // В кабине руки на пулемёте: без ходьбы и без качания от шага.
    hands.update(dt, { x: 0, y: 0 }, 0);
    updateCameraLean(dt, { x: 0, y: 0 }, 0, 0);   // не оставлять крен после бега

    // Огонь: очередь с темпом пулемёта, стволы спарки чередуются.
    if (fireActive) {
      fireTimer -= dt;
      if (fireTimer <= 0) {
        fireTimer = FIRE_INTERVAL;
        barrel = 1 - barrel;
        if (plane.getMuzzle(barrel, muzzlePos, muzzleDir)) {
          plane.kickMuzzle(barrel);   // отдача: ствол откатывается назад
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
    const input = { ...walkInput(), jump: jumpHeld(), slide: slideHeld() };
    walk(dt, input);
    const moving = player.horizontalSpeed > 0.05;
    hands.update(dt, { x: input.strafe, y: input.forward }, moving ? player.filteredSpeed : 0, player.stanceAmount);
  }

  fire.update(dt);
  plane.update(dt);
  character.stanceAmount = seated ? 0 : player.stanceAmount;
  character.update(dt, null);
  updateFirstPersonCamera(character.eyePosition(eye));
  updateGround();
  updateSun(plane.group.position);
  updateHud();

  renderFrame();
}

animate();
