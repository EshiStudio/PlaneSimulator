// Точка входа: связывает сцену, самолёт, персонажа и ввод, крутит главный цикл.
import * as THREE from 'three';
import { scene, camera, renderer, updateGround, updateSun, SUN_DIRECTION } from './scene.js';
import { view, updateFirstPersonCamera, updateCameraLean } from './camera.js';
import { Plane } from './plane.js';
import { Character, EYE_LOOK_RADIUS } from './character.js';
import { PlayerPhysics, MAX_WALK_SPEED } from './player.js';
import { renderFrame } from './postfx.js';
import { bindInput, walkInput, jumpHeld, slideHeld, clearFlightControls } from './input.js';
import { Hands } from './hands.js';
import { Fire } from './fire.js';
import { setStatus, clearStatus } from './status.js';
import { CHARACTER_HEIGHT, BOARD_DISTANCE, SEAT_OFFSET } from './constants.js';
import { createMulti } from './multi.js';

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
// Лимиты наводки пулемёта — зеркало plane.js (для углов гостя у хоста).
const GUN_YAW_LIMIT = Math.PI / 2;
const GUN_PITCH_MIN = THREE.MathUtils.degToRad(-25);
const GUN_PITCH_MAX = THREE.MathUtils.degToRad(70);
// Высота ступеньки при автошаге — та же, что в plane.js COLLISION_STEP_UP.
const CHARACTER_STEP_UP = 0.5;
// Радиус, в котором автошаг поднимает на ступеньку. Меньше радиуса тела:
// иначе игрок, идущий ВДОЛЬ самолёта, цепляется боком за колёса и капот и
// прыгает на невидимые постаменты. Подниматься должна только ступенька под
// ногами, а не любая ячейка в радиусе тела.
const STEP_LIFT_RADIUS = 0.15;
// Радиус проверки «застрял ли центр тела внутри сетки» для выталкивания.
// Малый: прижатый к стене игрок не должен дёргаться, выталкивание — только
// для реальных клиньев (центр в ячейках), а не для касания стен.
const UNSTICK_RADIUS = 0.2;
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
    net.sendSeat(false);
    return;
  }

  // Далеко — не садимся; подсказку об этом показывает HUD.
  if (character.group.position.distanceTo(plane.group.position) > BOARD_DISTANCE) return;

  // Место в кабине одно для всех: пока кто-то из других игроков сидит,
  // сесть нельзя. Правило одинаковое у каждого клиента — без приоритетов.
  for (const rc of remoteChars.values()) {
    if (rc.target?.seated) return;
  }

  plane.group.add(character.group);
  character.group.position.set(SEAT_OFFSET.x, SEAT_OFFSET.y, SEAT_OFFSET.z);
  // Место заднего стрелка: он сидит спиной к пилоту и смотрит на хвост.
  // Нос самолёта — +Z, хвост — -Z, лицо персонажа — его локальное -Z.
  character.group.rotation.set(0, 0, 0);
  view.yaw = plane.yaw;
  seated = true;
  net.sendSeat(true);
}

// P2P-мультиплеер: хост рулит самолётом, гости подключаются по коду комнаты.
const netPanel = document.getElementById('netpanel');
const netStatusEl = document.getElementById('net-status');
const showNetStatus = (msg, isError = false) => {
  netStatusEl.textContent = msg ?? '';
  netStatusEl.classList.toggle('err', !!isError);
};
const netLink = () => `${location.origin}${location.pathname}?join=${net.code}`;
function renderNetPanel() {
  const body = document.getElementById('net-body');
  if (net.role === 'host') {
    body.innerHTML =
      `<div class="net-room">Комната: <b>${net.code}</b></div>` +
      `<div class="net-room">Игроков: ${net.guests + 1}</div>` +
      `<div class="net-row"><button id="net-copy">Скопировать ссылку</button><button id="net-leave">Выйти</button></div>`;
    body.querySelector('#net-copy').onclick = () => {
      const done = () => showNetStatus('ссылка скопирована');
      const fail = () => showNetStatus('не получилось: ' + netLink(), true);
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(netLink()).then(done, fail);
      else fail();
    };
    body.querySelector('#net-leave').onclick = leaveNet;
  } else if (net.role === 'guest') {
    body.innerHTML =
      `<div class="net-room">Подключено к <b>${net.code}</b></div>` +
      `<div class="net-row"><button id="net-leave">Выйти</button></div>`;
    body.querySelector('#net-leave').onclick = leaveNet;
  } else {
    body.innerHTML =
      `<button id="net-host">Создать комнату</button>` +
      `<div class="net-join"><input id="net-code" placeholder="код комнаты" maxlength="9" autocomplete="off"><button id="net-join">Войти</button></div>`;
    body.querySelector('#net-host').onclick = () => net.host();
    body.querySelector('#net-join').onclick = () => {
      let code = (document.getElementById('net-code').value || '').trim().toUpperCase();
      if (!code) { showNetStatus('введите код комнаты', true); return; }
      // Хост регистрирует id строчным префиксом — нормализуем любой ввод.
      code = 'psim-' + code.replace(/^PSIM-/, '');
      net.join(code);
    };
  }
}
function leaveNet() {
  net.close();
  renderNetPanel();
  showNetStatus('');
}

// Фигуры других игроков (как в оригинале SHOOTER): тот же Character, но со
// своей головой, анимируется снапшотами владельца — шаг, прыжок, поворот
// головы, сидение в кабине.
const remoteChars = new Map();   // key ('host' у гостя / peerId у хоста) -> { char, target }
const remoteWorld = new THREE.Vector3();
const remoteHead = new THREE.Vector3();
const candidateHead = new THREE.Vector3();

function createRemoteCharacter() {
  const c = new Character();
  c.setHeight(CHARACTER_HEIGHT);
  c.hideHeadForOwner(false);   // чужие видны целиком, со своей головой
  scene.add(c.group);
  c.group.visible = false;     // до первого снапшота
  return c;
}

/** Цель глаз фигуры: ближайшая голова другого персонажа в радиусе взгляда. */
function eyeTargetFor(rc) {
  rc.char.headRoot.getWorldPosition(remoteHead);
  let best = null;
  let bestDist = EYE_LOOK_RADIUS;
  character.headRoot.getWorldPosition(candidateHead);
  const dSelf = candidateHead.distanceTo(remoteHead);
  if (dSelf < bestDist) { bestDist = dSelf; best = candidateHead.clone(); }
  for (const o of remoteChars.values()) {
    if (o === rc) continue;
    o.char.headRoot.getWorldPosition(candidateHead);
    const d = candidateHead.distanceTo(remoteHead);
    if (d < bestDist) { bestDist = d; best = candidateHead.clone(); }
  }
  return best;
}

function updateRemoteChar(rc, dt) {
  const t = rc.target;
  const g = rc.char.group;
  if (!t) { g.visible = false; return; }
  g.visible = true;
  if (t.seated) {
    // Владелец сидит в кабине: фигура привязана к самолёту, корпус крутится
    // за наводкой стрелка.
    if (g.parent !== plane.group) plane.group.add(g);
    g.position.set(SEAT_OFFSET.x, SEAT_OFFSET.y, SEAT_OFFSET.z);
    g.rotation.set(0, t.yaw - plane.yaw, 0);
  } else {
    if (g.parent !== scene) scene.add(g);
    const k = 1 - Math.exp(-10 * dt);
    g.position.x += (t.p[0] - g.position.x) * k;
    g.position.y += (t.p[1] - g.position.y) * k;
    g.position.z += (t.p[2] - g.position.z) * k;
    let d = t.yaw - g.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    g.rotation.y += d * k;
  }
  rc.char.externalVelocity.set(0, t.vy, 0);
  rc.char.externalMoveSpeed = t.hspeed;
  rc.char.externalOnFloor = !!t.onFloor;
  // Взгляд вверх-вниз у чужих сглаживается: у владельца pitch меняется
  // мгновенно от мыши, а голова другого не должна дёргаться.
  const pitchK = 1 - Math.exp(-10 * dt);
  rc.headPitch += ((t.pitch ?? 0) - rc.headPitch) * pitchK;
  rc.char.externalPitch = rc.headPitch;
  rc.char.stanceAmount = t.stance ?? 0;   // присед при скольжении, как у своего
  rc.char.sunDirection.copy(SUN_DIRECTION);
  // Глаза как в оригинале: следят за ближайшим персонажем («взгляд в глаза»),
  // иначе блуждают; моргание и щурение на солнце — те же, что у своего.
  rc.char.update(dt, eyeTargetFor(rc));
}

/** Снапшот своего персонажа для других игроков (≈12 Гц). */
function playerSnap() {
  character.group.getWorldPosition(remoteWorld);
  return {
    t: 'player',
    p: [remoteWorld.x, remoteWorld.y, remoteWorld.z],
    yaw: view.yaw,
    pitch: view.pitch,
    vy: player.velocity.y,
    hspeed: player.horizontalSpeed,
    onFloor: onFloor ? 1 : 0,
    seated: seated ? 1 : 0,
    stance: player.stanceAmount,   // скольжение/присед — фигура приседает
  };
}

const net = createMulti({
  push: (dx, dz) => plane.move(dx, dz),   // гость толкает самолёт
  engine: () => { plane.engineOn = !plane.engineOn; },
  seat: () => { net.seatEvents++; },      // гость сел/встал
  // Стрелок-гость наводит пулемёт: хост применяет углы (лимиты — как в
  // plane.aimGun) и разносит всем через plane-снапшоты.
  gun: (gy, gp) => {
    if (!plane.gunYaw) return;
    plane.gunYaw.rotation.y = THREE.MathUtils.clamp(gy, -GUN_YAW_LIMIT, GUN_YAW_LIMIT);
    plane.gunPitch.rotation.x = THREE.MathUtils.clamp(gp, GUN_PITCH_MIN, GUN_PITCH_MAX);
  },
  status: msg => { renderNetPanel(); showNetStatus(msg); },
  error: err => { console.error(err); showNetStatus('ошибка: ' + (err?.type ?? err), true); },
  guests: () => renderNetPanel(),
  player: (key, snap) => {
    let rc = remoteChars.get(key);
    if (!rc) {
      rc = { char: createRemoteCharacter(), target: null, headPitch: 0 };
      remoteChars.set(key, rc);
    }
    rc.target = snap;
  },
});
net.seatEvents = 0;
{
  const params = new URLSearchParams(location.search);
  if (params.has('host')) net.host();
  else if (params.get('join')) net.join(params.get('join'));
}
renderNetPanel();
window.__net = net;   // отладка/тесты CDP

bindInput(renderer.domElement, {
  isSeated: () => seated,
  movePlane: (dx, dz) => {
    // Стрелок самолётом не управляет — только пулемётом.
    if (seated) return;
    // Гость не трогает свой самолёт: он «чужой», толчок уходит хосту.
    if (net.role === 'guest') { net.sendPush(dx, dz); return; }
    plane.move(dx, dz);
  },
  toggleEngine: () => {
    // Пешком Пробел — прыжок, в кабине — двигатель.
    if (!seated) return;
    // Двигатель тоже «хостовый»: гость просит, хост переключает.
    if (net.role === 'guest') { net.sendEngine(); return; }
    plane.engineOn = !plane.engineOn;
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
// Прицел-«E»: взгляд пешехода наведён на самолёт (по земле — конус ~18° от
// направления на центр) и самолёт рядом — перекрестие плавно превращается
// в E с кругом (CSS-переход). Геометрия, а не raycast: не зависит от высоты
// луча глаз и стабильна в headless-тестах.
const LOOK_ANGLE_TO_PLANE = Math.PI * 0.1;   // 18°
const aimFwd = new THREE.Vector3();
const aimToPlane = new THREE.Vector3();
let hoverPlane = false;
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
// Занята ли точка телом самолёта на уровне тела игрока (см. plane.js
// #isBlocked): ячейки ниже ступеньки проходимы, на верхних гранях можно
// стоять, стены блокируют только на уровне тела. Нужна и в walk, и в
// отладочном дампе __dbg, поэтому объявлена на уровне модуля.
const blocked = (x, z, y) => plane.isBlocked(x, z, PLAYER_RADIUS, y, CHARACTER_HEIGHT);
// Подшаг пешей коллизии: движение разбивается на куски этого размера, чтобы
// быстрый слайд (до ~15 м/с) не проскакивал сквозь ячейки сетки 0.2 м и не
// «влетал» внутрь корпуса.
const COLLISION_SUB_STEP = 0.1;
// Коллизия с другими игроками — как в оригинале SHOOTER: персонажи — твёрдые
// круги на земле, сквозь друг друга не проходят (локальный блокируется
// фигурами чужих; их владельцы у себя блокируются точно так же, поэтому
// снапшоты сходятся). Сидящие в кабине недостижимы и пропускаются.
const PLAYER_COLLIDE_DIST = PLAYER_RADIUS * 2;
const hitPlayer = (x, z, x0, z0) => {
  // Из перекрытия (старт в одной точке) выходить можно, углубляться — нет:
  // блокируется только движение внутрь радиуса чужой фигуры.
  const R2 = PLAYER_COLLIDE_DIST * PLAYER_COLLIDE_DIST;
  for (const rc of remoteChars.values()) {
    if (!rc.target || rc.target.seated) continue;
    const g = rc.char.group;
    const newD2 = (x - g.position.x) ** 2 + (z - g.position.z) ** 2;
    const oldD2 = (x0 - g.position.x) ** 2 + (z0 - g.position.z) ** 2;
    if (oldD2 >= R2) { if (newD2 < R2) return true; }
    else if (newD2 < oldD2) return true;
  }
  return false;
};

function walk(dt, input) {
  player.update(dt, input, onFloor, view.yaw);

  // Коллизия с самолётом — сетка занятости мешей (см. plane.js
  // #buildCollisionGrid): ячейки ниже ступеньки проходимы, на верхних
  // гранях можно стоять, стены блокируют только на уровне тела.
  const p = character.group.position;
  const moveX = player.velocity.x * dt;
  const moveZ = player.velocity.z * dt;
  const dist = Math.hypot(moveX, moveZ);
  const steps = Math.max(1, Math.ceil(dist / COLLISION_SUB_STEP));
  for (let i = 0; i < steps; i++) {
    const sx = moveX / steps;
    const sz = moveZ / steps;
    if (!blocked(p.x + sx, p.z, p.y) && !hitPlayer(p.x + sx, p.z, p.x, p.z)) p.x += sx;
    if (!blocked(p.x, p.z + sz, p.y) && !hitPlayer(p.x, p.z + sz, p.x, p.z)) p.z += sz;
  }
  // Страховка от застревания: выталкиваем к ближайшей свободной точке,
  // только если ЦЕНТР игрока действительно внутри сетки (ниша, стены
  // сомкнулись вокруг). Проверка малым радиусом: иначе прижавшийся к стене
  // игрок каждую секунду отпрыгивает назад на 0.12 м и дрожит у стены.
  const wedged = plane.isBlocked(p.x, p.z, UNSTICK_RADIUS, p.y, CHARACTER_HEIGHT);
  if (wedged) {
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
  // Пол под ногами: верхние грани ячеек В РАДИУСЕ НОГ (STEP_LIFT_RADIUS,
  // много меньше радиуса тела). Иначе игрок, идущий МИМО капота/колёс или
  // прижавшийся к стойке, поднимается на невидимые постаменты: ячейки в
  // радиусе тела, но НЕ под ногами, задирают персонажа, а стена фюзеляжа
  // клинит его на высоте.
  let floor = GROUND_Y;
  // Широкий поиск (по телу) ТОЛЬКО для onFloor: подъём на постаменты
  // невозможен (canRise), зато onFloor стабилен даже на краю стойки/крыла,
  // где узкий STEP_LIFT_RADIUS из-за дрейфа позиции то находит пол, то нет,
  // и камера с анимациями прыгает каждый кадр.
  let standFloor = GROUND_Y;
  // Приземление (падение): пол ищем в радиусе ТЕЛА — падающий игрок
  // накрывает крыло краем корпуса и садится на него.
  if (player.velocity.y < 0 && !blocked(p.x, p.z, p.y)) {
    floor = Math.max(floor, plane.floorAt(p.x, p.z, PLAYER_RADIUS, p.y + CHARACTER_STEP_UP));
    standFloor = Math.max(standFloor, floor);
  }
  // Автошаг при ходьбе: только ступенька ПОД НОГАМИ (STEP_LIFT_RADIUS,
  // много меньше радиуса тела). Иначе игрок, идущий МИМО капота/колёс или
  // прижавшийся к стойке, поднимается на невидимые постаменты: ячейки в
  // радиусе тела, но НЕ под ногами, задирают персонажа, а стена фюзеляжа
  // клинит его на высоте. И не поднимаем, если позиция зажата стеной.
  else if (player.horizontalSpeed > 0.2 && !blocked(p.x, p.z, p.y)) {
    floor = Math.max(floor, plane.floorAt(p.x, p.z, STEP_LIFT_RADIUS, p.y + CHARACTER_STEP_UP));
    standFloor = Math.max(standFloor, plane.floorAt(p.x, p.z, PLAYER_RADIUS, p.y + CHARACTER_STEP_UP));
  }
  // Стоим на месте НАД землёй (крыло, стойка, фюзеляж): пол под ногами нужен
  // и для onFloor, иначе «стоим на самолёте» кажется прыжком и анимации
  // толкают камеру. Проверку blocked() тут не используем: на стоянке она не
  // нужна, а на границе «подошва == верх ячейки» дрожит из-за погрешности.
  else if (p.y > GROUND_Y + 0.05) {
    standFloor = Math.max(standFloor, plane.floorAt(p.x, p.z, PLAYER_RADIUS, p.y + CHARACTER_STEP_UP));
  }
  const canRise = player.velocity.y < 0 || player.horizontalSpeed > 0.2;
  if (p.y <= floor && canRise) {
    p.y = floor;
    player.velocity.y = 0;
    onFloor = true;
  } else {
    onFloor = p.y <= Math.max(floor, standFloor) + 0.05;
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
      `двигатель: ${plane.engineOn ? 'ЗАВЕДЁН' : 'заглушен'}`;
  } else {
    const c = character.group.position;
    hud.textContent =
      `пешком   позиция (${c.x.toFixed(1)}, ${c.z.toFixed(1)})   ` +
      `до самолёта ${c.distanceTo(p).toFixed(1)} м   ` +
      `двигатель: ${plane.engineOn ? 'ЗАВЕДЁН' : 'заглушен'}`;
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
    // Наводка турели уходит хосту (у хоста — no-op: conn отсутствует).
    if (plane.gunYaw) {
      net.sendGun(plane.gunYaw.rotation.y, plane.gunPitch.rotation.x);
    }
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

  if (seated) {
    hoverPlane = false;
  } else {
    // «Наводится на самолёт»: направление взгляда (проекция на землю) почти
    // совпадает с направлением на центр самолёта, и самолёт в радиусе посадки.
    camera.getWorldDirection(aimFwd);
    aimFwd.y = 0;
    aimFwd.normalize();
    aimToPlane.subVectors(plane.group.position, character.group.position);
    aimToPlane.y = 0;
    const dist = aimToPlane.length();
    aimToPlane.divideScalar(dist || 1);
    hoverPlane = dist <= BOARD_DISTANCE &&
      aimFwd.angleTo(aimToPlane) <= LOOK_ANGLE_TO_PLANE;
  }
  crosshair.classList.toggle('on-plane', hoverPlane);

  fire.update(dt);
  plane.update(dt);
  // Гость не симулирует самолёт — применяет состояние хоста с интерполяцией.
  // Хост, наоборот, рассылает своё состояние гостям (≈12 Гц).
  const now = performance.now();
  if (net.role === 'guest') {
    net.applyRemote(dt, plane, seated);
    net.tickPlayer(now, playerSnap());
  } else if (net.role === 'host') {
    net.tickPlane(plane, now);
    net.tickPlayer(now, playerSnap());
  }
  for (const rc of remoteChars.values()) updateRemoteChar(rc, dt);
  // Входы анимации персонажа — зеркало `_sync_local_player_avatar()` из
  // оригинального world.gd. Сидя в кабине физика пешехода не обновляется,
  // поэтому скорость и пол явно обнуляем, чтобы персонаж стоял в покое.
  character.externalVelocity.set(0, 0, 0);
  character.externalMoveSpeed = 0;
  character.externalOnFloor = true;
  if (!seated) {
    character.externalVelocity.copy(player.velocity);
    character.externalMoveSpeed = player.horizontalSpeed;
    character.externalOnFloor = onFloor;
  }
  character.externalPitch = view.pitch;
  character.stanceAmount = seated ? 0 : player.stanceAmount;
  character.sunDirection.copy(SUN_DIRECTION);
  character.update(dt, null);
  updateFirstPersonCamera(character.eyePosition(eye));
  if (__dbg) {
    try {
      const pos = character.group.position;
      __dbg.onFloor = onFloor;
      __dbg.jump = character.jumpAmount;
      __dbg.walk = character.walkActivity;
      __dbg.vy = player.velocity.y;
      __dbg.hspeed = player.horizontalSpeed;
      __dbg.blocked = blocked(pos.x, pos.z, pos.y);
      __dbg.eyeY = eye.y;
      __dbg.pos = pos.toArray();
      __dbg.planePos = plane.group.position.toArray();
      __dbg.seated = seated;
      __dbg.engine = plane.engineOn;
      __dbg.hoverPlane = hoverPlane;
      __dbg.gunYaw = plane.gunYaw ? plane.gunYaw.rotation.y : 0;
      __dbg.gunPitch = plane.gunPitch ? plane.gunPitch.rotation.x : 0;
      __dbg.sendGun = (gy, gp) => { net.sendGun(gy, gp); return 'ok'; };
      __dbg.net = {
        role: net.role,
        code: net.code,
        connected: net.connected,
        guests: net.guests,
        seatEvents: net.seatEvents,
        remote: net.role === 'guest' ? net.remote() : null,
      };
      __dbg.remotePlayers = [...remoteChars.entries()].map(([key, rc]) => ({
        key,
        pos: rc.char.group.position.toArray(),
        seated: rc.target?.seated ? 1 : 0,
        visible: rc.char.group.visible,
        gaze: rc.char.gazeActivity,     // глаза следят за ближайшим игроком
        blink: rc.char.blinkAmount,
        stance: rc.target?.stance ?? 0, // скольжение/присед
      }));
    } catch (e) {
      __dbg.err = String(e && e.stack || e);
    }
  }
  updateGround();
  updateSun(plane.group.position);
  updateHud();

  renderFrame();
}

window.__dbg = {};
animate();
