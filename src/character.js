// Персонаж, перенесённый из Godot-скрипта `cheracter/SHOOTER_generator_player_scripts.zip`
// (`scripts/test_character.gd`). Модели там нет: фигура целиком строится кодом из
// боксов, капсул и сфер, поэтому здесь повторена та же сборка на three.js —
// размеры, цвета и смещения взяты один в один. Анимации тоже портированы
// целиком: ходьба, развороты, прыжок с отталкиванием и приземлением, слайд,
// росток на голове, глаза с морганием и «щурится на солнце».
//
// Входы (`externalVelocity`, `externalMoveSpeed`, `stanceAmount`, `externalPitch`,
// `externalOnFloor`, `sunDirection`) заполняет main.js — зеркало
// `_sync_local_player_avatar()` из оригинального world.gd.
//
// Отличие от оригинала: вместо блоба-тени под ногами работает настоящая тень
// сцены. Голова при этом скрывается от владельца только визуально (прозрачный
// материал), чтобы тень от головы оставалась.
import * as THREE from 'three';

const deg = THREE.MathUtils.degToRad;

// Цвета заданы в sRGB — как albedo_color в Godot.
const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

const WHITE = rgb(0.92, 0.95, 1.0);
const EYE_WHITE = rgb(0.96, 0.98, 1.0);
const OUTLINE = rgb(0.01, 0.012, 0.016);
const EYE_COLOR = rgb(0.0, 0.0, 0.0);
const SHIRT_ORANGE = rgb(1.0, 0.60, 0.02);
const SHIRT_DARK_ORANGE = rgb(0.90, 0.36, 0.02);
const SHIRT_PATTERN = rgb(0.98, 0.98, 0.88);
const PLANT_STEM = rgb(0.24, 0.32, 0.08);
const PLANT_LEAF = rgb(0.42, 0.63, 0.16);
const PLANT_LEAF_DARK = rgb(0.20, 0.38, 0.08);
const PLANT_LEAF_LIGHT = rgb(0.66, 0.80, 0.26);

const LEFT_LEG_BASE = new THREE.Vector3(-0.125, 0.58, 0.02);
const RIGHT_LEG_BASE = new THREE.Vector3(0.125, 0.58, 0.02);
const LOWER_LEG_BASE = new THREE.Vector3(0.0, -0.300, 0.012);
const SHIN_LOCAL_BASE = new THREE.Vector3(0.0, -0.150, 0.0);
const FOOT_LOCAL_BASE = new THREE.Vector3(0.0, -0.225, -0.075);
const LEFT_EYE_BASE = new THREE.Vector3(-0.17, -0.035, -0.370);
const RIGHT_EYE_BASE = new THREE.Vector3(0.17, -0.035, -0.370);

const WALK_FULL_SPEED = 4.4;
const EYE_LOOK_RADIUS = 7.0;
export { EYE_LOOK_RADIUS };
const BASE_BLINK_MIN = 14.0;
const BASE_BLINK_VARIATION = 8.0;
const SUN_BLINK_MIN = 0.65;
const SUN_BLINK_VARIATION = 0.55;
const SUN_LOOK_DOT_START = 0.84;
const SUN_GAZE_CHARGE_SECONDS = 2.8;
const SUN_GAZE_DECAY_SECONDS = 1.4;
const BLINK_CLOSE_SPEED = 12.5;
const SUN_BLINK_CLOSE_SPEED = 14.0;
const BLINK_OPEN_SPEED = 8.0;
const SUN_BLINK_OPEN_SPEED = 9.0;
const BLINK_HOLD_SECONDS = 0.020;
const SUN_BLINK_HOLD_SECONDS = 0.035;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const exp = Math.exp;
const pow = Math.pow;
const abs = Math.abs;
const sin = Math.sin;
const cos = Math.cos;
const maxf = Math.max;
const minf = Math.min;
const sign = Math.sign;

// Порт Godot wrapf(x, -PI, PI): угол в (-PI, PI].
function wrapRad(a) {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

// --- Кэш геометрии и материалов: деталей больше сотни, но форм немного ---
const geometries = new Map();
const materials = new Map();

function cached(key, create) {
  let value = geometries.get(key);
  if (value === undefined) {
    value = create();
    geometries.set(key, value);
  }
  return value;
}

const boxGeometry = (x, y, z) =>
  cached(`b${x},${y},${z}`, () => new THREE.BoxGeometry(x, y, z));

// В Godot height капсулы — это ПОЛНАЯ высота вместе с полусферами,
// в three.js length — только цилиндрическая часть.
const capsuleGeometry = (radius, height) =>
  cached(`c${radius},${height}`, () =>
    new THREE.CapsuleGeometry(radius, Math.max(height - radius * 2, 0.001), 4, 18));

const sphereGeometry = radius =>
  cached(`s${radius}`, () => new THREE.SphereGeometry(radius, 16, 8));

function material(color) {
  const key = color.getHex();
  let value = materials.get(key);
  if (value === undefined) {
    value = new THREE.MeshStandardMaterial({ color, roughness: 0.88 });
    materials.set(key, value);
  }
  return value;
}

// Контур — та же геометрия чуть крупнее, с отсечением ЛИЦЕВЫХ граней и без
// освещения (в Godot: cull_mode = CULL_FRONT, shading_mode = UNSHADED).
const outlineMaterial = new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide });

function addPart(parent, name, geometry, position, rotation, scale, color) {
  const mesh = new THREE.Mesh(geometry, material(color));
  mesh.name = name;
  mesh.position.copy(position);
  mesh.rotation.order = 'YXZ';           // порядок поворотов как в Godot
  if (rotation) mesh.rotation.set(rotation.x, rotation.y, rotation.z);
  if (scale) mesh.scale.copy(scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addOutlinedPart(parent, name, geometry, position, rotation, scale, color, outlineScale) {
  const root = new THREE.Group();
  root.name = name;
  root.position.copy(position);
  root.rotation.order = 'YXZ';
  if (rotation) root.rotation.set(rotation.x, rotation.y, rotation.z);
  parent.add(root);

  const partScale = scale ?? new THREE.Vector3(1, 1, 1);

  const outline = new THREE.Mesh(geometry, outlineMaterial);
  outline.name = 'Outline';
  outline.scale.copy(partScale).multiplyScalar(outlineScale);
  outline.castShadow = false;            // контур тени не отбрасывает
  root.add(outline);

  const fill = new THREE.Mesh(geometry, material(color));
  fill.name = 'Fill';
  fill.scale.copy(partScale);
  fill.castShadow = true;
  fill.receiveShadow = true;
  root.add(fill);
  return root;
}

function partRoot(parent, name, position) {
  const root = new THREE.Group();
  root.name = name;
  root.position.copy(position);
  root.rotation.order = 'YXZ';
  parent.add(root);
  return root;
}

const vec = (x, y, z) => new THREE.Vector3(x, y, z);

// Рост фигуры в её собственных единицах: макушка приходится на 2.35.
export const NATURAL_HEIGHT = 2.35;
// Центр глаз в системе координат головы (лицо смотрит по -Z).
const EYE_LOCAL = new THREE.Vector3(0, -0.035, -0.30);
// Слайд-поза один в один из оригинального test_character.gd: тело сжимается
// до высоты капсулы слайда (SLIDE_HEIGHT 1.18 из STANDING_HEIGHT 2.35) и
// слегка расширяется. Камера стоит на голове, поэтому при сплющивании глаз
// опускается так же, как VIEW_HEIGHT 2.12 → SLIDE_VIEW_HEIGHT 1.02.
const CROUCH_HEIGHT_SCALE = 1.18 / 2.35;
// Ширина тела в слайде — ширина капсулы слайда относительно обычной
// (в оригинале lerp(1.0, 1.08, crouch) прямо в _animate_body).
const CROUCH_WIDTH_SCALE = 1.08;

export class Character {
  constructor() {
    this.group = new THREE.Group();
    this.animationTime = 0;
    // Степень «приседания» в слайде 0..1 — из PlayerPhysics.stanceAmount
    // (в оригинале external_stance_amount).
    this.stanceAmount = 0;

    // Входы от физики игрока — зеркало world.gd `_sync_local_player_avatar()`.
    this.externalVelocity = new THREE.Vector3();
    this.externalMoveSpeed = 0;
    this.externalPitch = 0;
    this.externalOnFloor = true;
    this.sunDirection = new THREE.Vector3();

    // Состояние анимации — имена переменных из test_character.gd.
    this.walkDirectionLocal = new THREE.Vector2(0, 1);
    this.walkActivity = 0;
    this.visualStanceAmount = 0;
    this.previousExternalOnFloor = true;
    this.jumpAmount = 0;
    this.jumpAirTime = 0;
    this.takeoffAmount = 0;
    this.landingAmount = 0;
    this.landingSettleAmount = 0;
    this.turnIntensity = 0;
    this.turnActivity = 0;
    this.turnPhase = 0;
    this.turnYawError = 0;
    this.turnSpeed = 0;
    this.previousYaw = null;   // null = первый кадр, шага поворота нет
    this.gazeActivity = 0;
    this.eyeDart = new THREE.Vector2();
    this.eyeDartTimer = 0;
    this.sunGazeCharge = 0;

    this.blinkAmount = 0;
    this.blinkTimer = 1.4;
    this.blinkClosing = false;
    this.blinkHoldTimer = 0;

    this.eyeFocus = new THREE.Vector2();
    this.headHidden = false;
    this.armsHidden = false;
    this.hiddenOwnerMaterials = new Map();
    this.#build();
  }

  /** Приводит фигуру к заданному росту в метрах. */
  setHeight(meters) {
    this.group.scale.setScalar(meters / NATURAL_HEIGHT);
  }

  /**
   * Прячет голову от самого игрока (в оригинале — hide_head_for_owner).
   * Обязательно при виде от первого лица: контур рисуется по ЗАДНИМ граням,
   * поэтому изнутри головы он закрывает весь экран.
   *
   * Просто выключить visible нельзя: three.js в теневом проходе пропускает
   * невидимые объекты, и тень от головы исчезает (в оригинале тень — блоб,
   * там голова и так не видна). Поэтому детали, отбрасывающие тень, делаем
   * прозрачными (opacity 0, depthWrite false): в основной камере их не видно,
   * а в карту теней они попадают. Контуры (castShadow=false) прячем целиком.
   */
  hideHeadForOwner(hidden) {
    this.#hideFromOwner(this.headRoot, hidden, 'headHidden');
  }

  /** Руки тоже прячем от владельца: от первого лица видны только canvas-руки
   * (hands.js), а 3D-руки фигуры торчат снизу и мешают. Чужим — видны. */
  hideArmsForOwner(hidden) {
    this.#hideFromOwner(this.leftArm, hidden, 'armsHidden');
    this.#hideFromOwner(this.rightArm, hidden, 'armsHidden');
  }

  /** Скрыть поддерево для владельца (камера первого лица): детали, отбрасывающие
   * тень, становятся прозрачными (тень остаётся), контуры прячем целиком.
   * Повторный вызов с тем же состоянием игнорируется — иначе в мапу ляжет уже
   * прозрачный материал и восстановление вернёт его же. */
  #hideFromOwner(root, hidden, stateKey) {
    if (hidden === this[stateKey]) return;
    this[stateKey] = hidden;
    root.traverse(o => {
      if (!o.isMesh) return;
      if (hidden) {
        if (o.castShadow) {
          this.hiddenOwnerMaterials.set(o, o.material);
          o.material = new THREE.MeshStandardMaterial({
            transparent: true, opacity: 0, depthWrite: false,
          });
        } else {
          o.visible = false;
        }
      } else {
        if (this.hiddenOwnerMaterials.has(o)) {
          o.material = this.hiddenOwnerMaterials.get(o);
          this.hiddenOwnerMaterials.delete(o);
        }
        o.visible = true;
      }
    });
  }

  /** Мировая точка глаз — отсюда смотрит камера от первого лица. */
  eyePosition(target = new THREE.Vector3()) {
    // Матрицы обновляются рендером уже ПОСЛЕ этого вызова, поэтому цепочку
    // родителей пересчитываем сами — иначе камера отстаёт на кадр, а сразу
    // после посадки в самолёт берёт вообще старое место.
    this.headRoot.updateWorldMatrix(true, false);
    return this.headRoot.localToWorld(target.copy(EYE_LOCAL));
  }

  /** Разворачивает персонажа лицом к точке: лицо смотрит по локальному -Z. */
  faceTowards(x, z) {
    const dx = x - this.group.position.x;
    const dz = z - this.group.position.z;
    if (dx === 0 && dz === 0) return;
    this.group.rotation.y = Math.atan2(-dx, -dz);
  }

  #build() {
    const body = this.bodyRoot = new THREE.Group();
    body.name = 'BodyRoot';
    body.rotation.order = 'YXZ';
    this.group.add(body);

    addOutlinedPart(body, 'Body', boxGeometry(0.34, 0.88, 0.25), vec(0, 0.94, 0), null, null, WHITE, 1.055);
    this.#addShirtTorso(body);

    this.leftLeg = partRoot(body, 'LeftLeg', LEFT_LEG_BASE);
    this.rightLeg = partRoot(body, 'RightLeg', RIGHT_LEG_BASE);
    addOutlinedPart(this.leftLeg, 'LeftThigh', capsuleGeometry(0.066, 0.35), vec(0, -0.16, 0), null, null, WHITE, 1.08);
    addOutlinedPart(this.rightLeg, 'RightThigh', capsuleGeometry(0.066, 0.35), vec(0, -0.16, 0), null, null, WHITE, 1.08);

    this.leftLowerLeg = partRoot(this.leftLeg, 'LeftLowerLeg', LOWER_LEG_BASE);
    this.rightLowerLeg = partRoot(this.rightLeg, 'RightLowerLeg', LOWER_LEG_BASE);
    addOutlinedPart(this.leftLowerLeg, 'LeftShin', capsuleGeometry(0.058, 0.38), SHIN_LOCAL_BASE, null, null, WHITE, 1.08);
    addOutlinedPart(this.rightLowerLeg, 'RightShin', capsuleGeometry(0.058, 0.38), SHIN_LOCAL_BASE, null, null, WHITE, 1.08);

    this.leftFoot = addOutlinedPart(this.leftLowerLeg, 'LeftFoot', boxGeometry(0.16, 0.09, 0.27), FOOT_LOCAL_BASE, null, null, WHITE, 1.08);
    this.rightFoot = addOutlinedPart(this.rightLowerLeg, 'RightFoot', boxGeometry(0.16, 0.09, 0.27), FOOT_LOCAL_BASE, null, null, WHITE, 1.08);

    this.leftArm = addOutlinedPart(body, 'LeftArm', capsuleGeometry(0.066, 0.74), vec(-0.285, 0.96, 0), vec(0, 0, deg(-10)), null, WHITE, 1.08);
    this.rightArm = addOutlinedPart(body, 'RightArm', capsuleGeometry(0.066, 0.74), vec(0.285, 0.96, 0), vec(0, 0, deg(10)), null, WHITE, 1.08);
    this.#addSleeves();

    const head = this.headRoot = new THREE.Group();
    head.name = 'HeadRoot';
    head.position.set(0, 1.60, 0);
    head.rotation.order = 'YXZ';
    body.add(head);

    addOutlinedPart(head, 'CubeHead', boxGeometry(0.68, 0.64, 0.64), vec(0, 0, 0), null, null, WHITE, 1.045);
    addPart(head, 'MouthLine', boxGeometry(0.42, 0.030, 0.022), vec(0, -0.16, -0.342), null, null, OUTLINE);

    this.leftEyeWhite = addOutlinedPart(head, 'LeftEyeWhite', sphereGeometry(0.082),
      LEFT_EYE_BASE.clone().add(vec(0, 0, 0.004)), null, vec(1.46, 1.02, 0.10), EYE_WHITE, 1.18);
    this.rightEyeWhite = addOutlinedPart(head, 'RightEyeWhite', sphereGeometry(0.082),
      RIGHT_EYE_BASE.clone().add(vec(0, 0, 0.004)), null, vec(1.46, 1.02, 0.10), EYE_WHITE, 1.18);
    this.leftEye = addPart(head, 'LeftPupil', sphereGeometry(0.046),
      LEFT_EYE_BASE.clone().add(vec(0, 0, -0.030)), null, vec(1, 1, 0.12), EYE_COLOR);
    this.rightEye = addPart(head, 'RightPupil', sphereGeometry(0.046),
      RIGHT_EYE_BASE.clone().add(vec(0, 0, -0.030)), null, vec(1, 1, 0.12), EYE_COLOR);
    this.leftGlint = addPart(head, 'LeftEyeGlint', sphereGeometry(0.014),
      LEFT_EYE_BASE.clone().add(vec(-0.014, 0.014, -0.044)), null, vec(1, 1, 0.10), WHITE);
    this.rightGlint = addPart(head, 'RightEyeGlint', sphereGeometry(0.014),
      RIGHT_EYE_BASE.clone().add(vec(-0.014, 0.014, -0.044)), null, vec(1, 1, 0.10), WHITE);

    this.#addHeadSprout();
  }

  #addShirtTorso(parent) {
    const box = (name, size, position, rotation, color) =>
      addPart(parent, name, boxGeometry(size[0], size[1], size[2]),
        vec(position[0], position[1], position[2]), rotation, null, color);

    box('ShirtShell', [0.370, 0.805, 0.282], [0, 0.925, 0], null, SHIRT_ORANGE);
    box('ShirtBack', [0.310, 0.770, 0.006], [0, 0.925, 0.146], null, SHIRT_ORANGE);
    box('LeftShirtSide', [0.006, 0.760, 0.190], [-0.188, 0.925, 0], null, SHIRT_ORANGE);
    box('RightShirtSide', [0.006, 0.760, 0.190], [0.188, 0.925, 0], null, SHIRT_ORANGE);
    box('LeftShirtPanel', [0.128, 0.780, 0.006], [-0.084, 0.925, -0.146], null, SHIRT_ORANGE);
    box('RightShirtPanel', [0.128, 0.780, 0.006], [0.084, 0.925, -0.146], null, SHIRT_ORANGE);
    box('ShirtFrontHem', [0.304, 0.032, 0.008], [0, 0.532, -0.148], null, SHIRT_DARK_ORANGE);
    box('ShirtBackHem', [0.304, 0.032, 0.008], [0, 0.532, 0.148], null, SHIRT_DARK_ORANGE);
    box('LeftShirtSideHem', [0.008, 0.032, 0.170], [-0.190, 0.532, 0], null, SHIRT_DARK_ORANGE);
    box('RightShirtSideHem', [0.008, 0.032, 0.170], [0.190, 0.532, 0], null, SHIRT_DARK_ORANGE);
    box('LeftShirtOpening', [0.012, 0.720, 0.008], [-0.023, 0.905, -0.153], null, SHIRT_DARK_ORANGE);
    box('RightShirtOpening', [0.012, 0.720, 0.008], [0.023, 0.905, -0.153], null, SHIRT_DARK_ORANGE);
    box('LeftCollar', [0.106, 0.182, 0.020], [-0.068, 1.336, -0.152], vec(0, 0, deg(-27)), SHIRT_ORANGE);
    box('RightCollar', [0.106, 0.182, 0.020], [0.068, 1.336, -0.152], vec(0, 0, deg(27)), SHIRT_ORANGE);
    box('BackCollar', [0.220, 0.068, 0.026], [0, 1.342, 0.136], null, SHIRT_ORANGE);

    for (let i = 0; i < 5; i++) {
      addPart(parent, `ShirtButton${i}`, sphereGeometry(0.011),
        vec(0.024, 1.200 - i * 0.128, -0.160), null, vec(1, 1, 0.16), SHIRT_PATTERN);
    }

    // Гавайский узор: цветы и листья на рубашке.
    this.#floralCluster(parent, 'LeftChestFlower', vec(-0.106, 1.165, -0.162), 0.026, deg(-18), -1);
    this.#floralCluster(parent, 'RightChestFlower', vec(0.106, 1.088, -0.162), 0.025, deg(25), -1);
    this.#floralCluster(parent, 'LeftLowerFlower', vec(-0.104, 0.755, -0.162), 0.023, deg(10), -1);
    this.#floralCluster(parent, 'RightLowerFlower', vec(0.104, 0.700, -0.162), 0.026, deg(-30), -1);
    this.#leafPair(parent, 'LeftTorsoLeaves', vec(-0.096, 0.980, -0.164), 0.036, deg(36), -1);
    this.#leafPair(parent, 'RightTorsoLeaves', vec(0.104, 0.880, -0.164), 0.038, deg(-42), -1);
    this.#leafPair(parent, 'LeftHemLeaves', vec(-0.064, 0.585, -0.164), 0.030, deg(-18), -1);
    this.#leafPair(parent, 'RightHemLeaves', vec(0.064, 0.585, -0.164), 0.030, deg(18), -1);
    this.#floralCluster(parent, 'BackShoulderFlower', vec(-0.104, 1.145, 0.162), 0.024, deg(18), 1);
    this.#floralCluster(parent, 'BackLowerFlower', vec(0.098, 0.760, 0.162), 0.026, deg(-24), 1);
    this.#leafPair(parent, 'BackTorsoLeaves', vec(0.090, 1.000, 0.164), 0.036, deg(-32), 1);
    this.#leafPair(parent, 'BackHemLeaves', vec(-0.082, 0.604, 0.164), 0.030, deg(28), 1);
    this.#sideLeafPair(parent, 'LeftSideLeaves', vec(-0.190, 0.970, -0.028), 0.030, deg(14), -1);
    this.#sideLeafPair(parent, 'RightSideLeaves', vec(0.190, 0.805, 0.034), 0.032, deg(-18), 1);
  }

  #addSleeves() {
    addOutlinedPart(this.leftArm, 'LeftSleeve', capsuleGeometry(0.086, 0.340), vec(0, 0.185, 0), null, null, SHIRT_ORANGE, 1.05);
    addOutlinedPart(this.rightArm, 'RightSleeve', capsuleGeometry(0.086, 0.340), vec(0, 0.185, 0), null, null, SHIRT_ORANGE, 1.05);
    this.#floralCluster(this.leftArm, 'LeftSleeveFlower', vec(0, 0.225, -0.090), 0.017, deg(12), -1);
    this.#floralCluster(this.rightArm, 'RightSleeveFlower', vec(0, 0.225, -0.090), 0.017, deg(-12), -1);
    this.#floralCluster(this.leftArm, 'LeftSleeveBackFlower', vec(0, 0.125, 0.090), 0.015, deg(-18), 1);
    this.#floralCluster(this.rightArm, 'RightSleeveBackFlower', vec(0, 0.125, 0.090), 0.015, deg(18), 1);
  }

  #floralCluster(parent, name, center, radius, rotationOffset, normalZ) {
    addPart(parent, `${name}Center`, sphereGeometry(radius * 0.34),
      center.clone().add(vec(0, 0, normalZ * 0.004)), null, vec(1, 1, 0.12), SHIRT_PATTERN);
    for (let i = 0; i < 5; i++) {
      const angle = rotationOffset + (i / 5) * Math.PI * 2;
      addPart(parent, `${name}Petal${i}`, sphereGeometry(radius * 0.47),
        center.clone().add(vec(Math.cos(angle) * radius * 0.82, Math.sin(angle) * radius * 0.82, normalZ * 0.006)),
        vec(0, 0, angle), vec(1.45, 0.45, 0.10), SHIRT_PATTERN);
    }
  }

  #leafPair(parent, name, center, radius, rotationOffset, normalZ) {
    for (let i = 0; i < 4; i++) {
      const angle = rotationOffset + i * deg(54);
      addPart(parent, `${name}Leaf${i}`, sphereGeometry(radius * 0.34),
        center.clone().add(vec(Math.cos(angle) * radius * 0.42, Math.sin(angle) * radius * 0.42, normalZ * 0.006)),
        vec(0, 0, angle), vec(1.80, 0.34, 0.08), SHIRT_PATTERN);
    }
  }

  #sideLeafPair(parent, name, center, radius, rotationOffset, sideSign) {
    for (let i = 0; i < 4; i++) {
      const angle = rotationOffset + i * deg(54);
      addPart(parent, `${name}Leaf${i}`, sphereGeometry(radius * 0.34),
        center.clone().add(vec(sideSign * 0.006, Math.sin(angle) * radius * 0.42, Math.cos(angle) * radius * 0.42)),
        vec(angle, 0, 0), vec(0.08, 1.80, 0.34), SHIRT_PATTERN);
    }
  }

  #addHeadSprout() {
    const root = this.sproutRoot = new THREE.Group();
    root.name = 'HeadSprout';
    root.position.set(0, 0.348, -0.010);
    root.rotation.order = 'YXZ';
    this.headRoot.add(root);

    this.sproutStem = addOutlinedPart(root, 'SproutStem', capsuleGeometry(0.012, 0.300),
      vec(0, 0.140, 0), vec(0, 0, deg(1)), null, PLANT_STEM, 1.10);
    addPart(root, 'SproutBase', sphereGeometry(0.024), vec(0, 0, 0), null, vec(1.1, 0.42, 0.68), PLANT_LEAF_DARK);

    this.leftSproutLeaf = this.#sproutLeaf(root, 'LeftSproutLeaf',
      vec(-0.074, 0.274, -0.012), vec(0, deg(-6), deg(-39)), vec(1.78, 0.52, 0.060), 0.052);
    this.rightSproutLeaf = this.#sproutLeaf(root, 'RightSproutLeaf',
      vec(0.074, 0.274, -0.012), vec(0, deg(6), deg(39)), vec(1.78, 0.52, 0.060), 0.052);
  }

  #sproutLeaf(parent, name, position, rotation, scale, radius) {
    const leaf = addOutlinedPart(parent, name, sphereGeometry(radius), position, rotation, scale, PLANT_LEAF, 1.06);
    addPart(leaf, 'MidVein', boxGeometry(radius * 3.25, radius * 0.060, radius * 0.035),
      vec(0, 0, -radius * 0.055), null, null, PLANT_LEAF_LIGHT);
    for (let i = 0; i < 4; i++) {
      const x = -radius * 0.80 + i * radius * 0.52;
      const side = i % 2 === 0 ? 1 : -1;
      addPart(leaf, `SideVein${i}`, boxGeometry(radius * 0.78, radius * 0.040, radius * 0.028),
        vec(x, side * radius * 0.15, -radius * 0.070), vec(0, 0, side * deg(24)), null, PLANT_LEAF_LIGHT);
    }
    return leaf;
  }

  /** @param lookTarget мировая точка, за которой следят глаза (обычно камера). */
  update(dt, lookTarget) {
    this.animationTime += dt;
    this.#updateExternalMotion(dt, lookTarget);
    this.#animateBody(dt);
    this.#animateEyes(dt, lookTarget);
  }

  // --- Порт _process (face_target_enabled=false) из test_character.gd ---

  #updateExternalMotion(delta, lookTarget) {
    if (this.previousYaw === null) this.previousYaw = this.group.rotation.y;
    const yawStep = wrapRad(this.group.rotation.y - this.previousYaw);
    this.previousYaw = this.group.rotation.y;
    this.turnYawError = 0;
    this.turnSpeed = lerp(this.turnSpeed, yawStep / maxf(delta, 0.001), 1 - exp(-12 * delta));
    this.gazeActivity = lerp(this.gazeActivity, this.#targetPresence(lookTarget), 1 - exp(-8.5 * delta));

    const horizontalVelocity = new THREE.Vector3(this.externalVelocity.x, 0, this.externalVelocity.z);
    let measuredSpeed = horizontalVelocity.length();
    if (!this.externalOnFloor) measuredSpeed *= 0.45;
    const moveSpeed = maxf(this.externalMoveSpeed, measuredSpeed);
    const speedActivity = clamp(moveSpeed / WALK_FULL_SPEED, 0, 1);
    let targetWalkDirection = this.walkDirectionLocal.clone();
    if (measuredSpeed > 0.04) {
      // Локальные оси: поворот корпуса только по Y, базис обращается поворотом
      // на -yaw (масштаб корпуса однородный и на направление не влияет).
      const a = -this.group.rotation.y;
      const c = cos(a), s = sin(a);
      const localX = c * horizontalVelocity.x + s * horizontalVelocity.z;
      const localZ = -s * horizontalVelocity.x + c * horizontalVelocity.z;
      targetWalkDirection.set(localX, -localZ);
      if (targetWalkDirection.lengthSq() > 0.0001) targetWalkDirection.normalize();
    } else if (speedActivity > 0.05) {
      targetWalkDirection.set(0, 1);
    }

    this.walkDirectionLocal.lerp(targetWalkDirection, 1 - exp(-14 * delta));
    if (this.walkDirectionLocal.lengthSq() > 1) this.walkDirectionLocal.normalize();
    this.walkActivity = lerp(this.walkActivity, speedActivity, 1 - exp(-12 * delta));
    this.visualStanceAmount = lerp(this.visualStanceAmount, clamp(this.stanceAmount, 0, 1), 1 - exp(-16 * delta));
    this.#updateJumpState(delta);

    const stanceActivity = this.visualStanceAmount * 0.40;
    const turnActivityTarget = clamp(abs(this.turnSpeed) * 0.16, 0, 1);
    const targetTurn = clamp(this.turnSpeed * 0.18, -1, 1);
    const targetActivity = maxf(maxf(maxf(this.walkActivity, stanceActivity), this.jumpAmount * 0.55), turnActivityTarget);

    this.turnIntensity = lerp(this.turnIntensity, targetTurn, 1 - exp(-11 * delta));
    this.turnActivity = lerp(this.turnActivity, targetActivity, 1 - exp(-9 * delta));
  }

  #updateJumpState(delta) {
    if (this.previousExternalOnFloor && !this.externalOnFloor) {
      this.jumpAmount = maxf(this.jumpAmount, 0.75);
      this.takeoffAmount = 1;
      this.landingAmount = 0;
      this.landingSettleAmount = 0;
      this.jumpAirTime = 0;
    }
    if (!this.previousExternalOnFloor && this.externalOnFloor) {
      this.landingAmount = 1;
      this.landingSettleAmount = 1;
      this.takeoffAmount = 0;
    }
    this.previousExternalOnFloor = this.externalOnFloor;

    this.jumpAirTime = this.externalOnFloor ? 0 : this.jumpAirTime + delta;
    this.jumpAmount = lerp(this.jumpAmount, this.externalOnFloor ? 0 : 1, 1 - exp(-12 * delta));
    this.takeoffAmount = maxf(this.takeoffAmount - delta * 4.2, 0);
    this.landingAmount = maxf(this.landingAmount - delta * 4.6, 0);
    this.landingSettleAmount = maxf(this.landingSettleAmount - delta * 2.05, 0);
  }

  // --- Порт _animate_body(delta) ---

  #animateBody(delta) {
    if (this.turnActivity > 0.015) {
      let phaseDirection = sign(this.walkDirectionLocal.y);
      if (abs(phaseDirection) < 0.001) phaseDirection = sign(this.turnIntensity);
      if (abs(phaseDirection) < 0.001) phaseDirection = 1;
      this.turnPhase += delta * (4.4 + this.turnActivity * 6.0 + this.walkActivity * this.externalMoveSpeed * 0.42) * phaseDirection;
    }

    const idle = sin(this.animationTime * 1.55);
    const activity = this.turnActivity;
    const turn = this.turnIntensity;
    const stepLeft = sin(this.turnPhase);
    const stepRight = sin(this.turnPhase + Math.PI);
    const walkForward = this.walkDirectionLocal.y * this.walkActivity;
    const walkSide = this.walkDirectionLocal.x * this.walkActivity;
    const strideScale = 0.35 + abs(walkForward) * 0.85 + abs(walkSide) * 0.55;
    const liftLeft = pow(maxf(0, stepLeft), 0.75) * activity * (0.65 + this.walkActivity * 0.55);
    const liftRight = pow(maxf(0, stepRight), 0.75) * activity * (0.65 + this.walkActivity * 0.55);
    const plantedLeft = 1 - liftLeft;
    const plantedRight = 1 - liftRight;
    const sideLeft = -0.010 * activity + liftLeft * 0.018 + stepLeft * walkSide * 0.035;
    const sideRight = 0.010 * activity - liftRight * 0.018 + stepRight * walkSide * 0.035;
    const strideLeft = clamp(stepLeft, -0.65, 0.65) * activity * strideScale;
    const strideRight = clamp(stepRight, -0.65, 0.65) * activity * strideScale;
    const crouch = this.visualStanceAmount;
    const rising = clamp(this.externalVelocity.y / 7.0, 0, 1) * this.jumpAmount;
    const falling = clamp(-this.externalVelocity.y / 9.0, 0, 1) * this.jumpAmount;
    const airPhase = clamp(this.jumpAirTime / 0.70, 0, 1);
    const apex = this.jumpAmount * clamp(1 - abs(airPhase - 0.50) * 2, 0, 1);
    const launchStretch = clamp(this.takeoffAmount * 0.85 + rising * 0.55, 0, 1);
    const landingImpact = pow(clamp(this.landingAmount, 0, 1), 1.28);
    const landingSettle = pow(clamp(this.landingSettleAmount, 0, 1), 1.55);
    const landingRebound = clamp((landingSettle - landingImpact) * 0.50, 0, 0.26);
    const landingSquash = clamp(landingImpact * 0.82 + landingSettle * 0.18, 0, 1);
    const landingTail = clamp(landingSettle * 0.42 + landingRebound * 0.30, 0, 1);
    const tuck = clamp(apex * 0.92 + rising * 0.18 - falling * 0.18, 0, 1);
    const extendForLanding = clamp(falling * 0.90 + landingSquash * 0.10 + landingRebound * 0.18, 0, 1);
    const landingBrace = clamp(falling * 0.42 + landingSquash * 0.78 + landingTail * 0.34, 0, 1);
    const armLift = clamp(launchStretch * 0.74 + apex * 0.28, 0, 1);
    const armSpread = clamp(this.jumpAmount * 0.72 + landingBrace * 0.26, 0, 1);
    const kneeFold = clamp(tuck * 1.18 + landingSquash * 0.58 + landingTail * 0.18 + falling * 0.12 - launchStretch * 0.20, 0, 1);
    const kneeStraighten = clamp(launchStretch * 0.55 + extendForLanding * 0.46 + landingRebound * 0.30 + landingTail * 0.14 - landingSquash * 0.20, 0, 1);
    const legAirSpread = this.jumpAmount * 0.028 + kneeFold * 0.030 + landingBrace * 0.020;
    const bodyBob = sin(this.animationTime * 1.8) * 0.008 + (liftLeft + liftRight) * 0.018 + this.walkActivity * abs(sin(this.turnPhase * 2.0)) * 0.018 + activity * 0.006;
    const jumpLift = launchStretch * 0.090 + apex * 0.140 + rising * 0.030 - landingSquash * 0.060 - landingTail * 0.018 + landingRebound * 0.042;

    this.bodyRoot.position.y = bodyBob - crouch * 0.015 + jumpLift;
    this.bodyRoot.scale.set(
      lerp(1, CROUCH_WIDTH_SCALE, crouch) - launchStretch * 0.045 + landingSquash * 0.105 + landingTail * 0.028 - landingRebound * 0.024,
      lerp(1, CROUCH_HEIGHT_SCALE, crouch) + launchStretch * 0.135 - landingSquash * 0.190 - landingTail * 0.045 + landingRebound * 0.060,
      lerp(1, CROUCH_WIDTH_SCALE, crouch) - launchStretch * 0.030 + landingSquash * 0.095 + landingTail * 0.024 - landingRebound * 0.020,
    );
    this.bodyRoot.rotation.set(
      -abs(turn) * deg(1.5) - walkForward * deg(1.4) + launchStretch * deg(4.0) - falling * deg(6.0) + landingSquash * deg(6.2) + landingTail * deg(2.2) - landingRebound * deg(2.4),
      -turn * deg(3.8) + walkSide * deg(2.5),
      idle * deg(0.5) - turn * deg(4.2) - walkSide * deg(3.0),
    );

    this.headRoot.rotation.set(
      sin(this.animationTime * 1.6) * deg(0.6) + abs(turn) * deg(0.8) + this.externalPitch * 0.22 - crouch * deg(4.0) - tuck * deg(4.0) + landingSquash * deg(5.2) + landingTail * deg(1.8) - landingRebound * deg(1.8),
      turn * deg(8.0) + clamp(this.turnYawError, -0.45, 0.45) * 0.10 + walkSide * deg(3.5),
      -turn * deg(1.6),
    );

    this.leftArm.position.set(
      -0.285 - armSpread * 0.100 - landingBrace * 0.024,
      0.96 + armLift * 0.120 - landingBrace * 0.030,
      -0.025 * activity - launchStretch * 0.020 + landingBrace * 0.045,
    );
    this.rightArm.position.set(
      0.285 + armSpread * 0.100 + landingBrace * 0.024,
      0.96 + armLift * 0.120 - landingBrace * 0.030,
      -0.025 * activity - launchStretch * 0.020 + landingBrace * 0.045,
    );
    this.leftArm.rotation.set(
      -turn * deg(15.0) + stepRight * activity * deg(8.0) + stepRight * this.walkActivity * deg(18.0) + crouch * deg(8.0) - launchStretch * deg(10.0) + landingBrace * deg(14.0),
      turn * deg(4.5) - armSpread * deg(9.0) - landingSquash * deg(3.8) - landingTail * deg(1.4) + landingRebound * deg(1.5),
      deg(-10.0) - activity * deg(2.0) + idle * deg(0.9) - armLift * deg(39.0) - armSpread * deg(12.0) + landingSquash * deg(10.5) + landingTail * deg(4.0) - landingRebound * deg(4.0),
    );
    this.rightArm.rotation.set(
      turn * deg(15.0) + stepLeft * activity * deg(8.0) + stepLeft * this.walkActivity * deg(18.0) + crouch * deg(8.0) - launchStretch * deg(10.0) + landingBrace * deg(14.0),
      turn * deg(4.5) + armSpread * deg(9.0) + landingSquash * deg(3.8) + landingTail * deg(1.4) - landingRebound * deg(1.5),
      deg(10.0) + activity * deg(2.0) - idle * deg(0.9) + armLift * deg(39.0) + armSpread * deg(12.0) - landingSquash * deg(10.5) - landingTail * deg(4.0) + landingRebound * deg(4.0),
    );

    this.leftLeg.position.set(
      LEFT_LEG_BASE.x + sideLeft - legAirSpread,
      LEFT_LEG_BASE.y + liftLeft * 0.018 + tuck * 0.110 - launchStretch * 0.034 - extendForLanding * 0.058 - landingSquash * 0.014 - landingTail * 0.010 + landingRebound * 0.014,
      LEFT_LEG_BASE.z + strideLeft * 0.028 + tuck * 0.026 - extendForLanding * 0.058 + landingSquash * 0.010 + landingTail * 0.006,
    );
    this.rightLeg.position.set(
      RIGHT_LEG_BASE.x + sideRight + legAirSpread,
      RIGHT_LEG_BASE.y + liftRight * 0.018 + tuck * 0.106 - launchStretch * 0.030 - extendForLanding * 0.058 - landingSquash * 0.014 - landingTail * 0.010 + landingRebound * 0.014,
      RIGHT_LEG_BASE.z + strideRight * 0.028 - tuck * 0.026 - extendForLanding * 0.052 + landingSquash * 0.010 + landingTail * 0.006,
    );
    this.leftLeg.rotation.set(
      strideLeft * deg(22.0) - liftLeft * deg(7.0) - crouch * deg(14.0) - launchStretch * deg(10.0) + tuck * deg(35.0) + extendForLanding * deg(14.0) + landingSquash * deg(22.0) + landingTail * deg(8.0) - landingRebound * deg(8.0),
      turn * deg(5.0) + strideLeft * deg(3.0) + walkSide * deg(5.0) - kneeFold * deg(3.5),
      deg(1.0) - turn * deg(2.0) + liftLeft * deg(1.0) - walkSide * deg(2.0) - kneeFold * deg(8.5) - landingBrace * deg(3.0),
    );
    this.rightLeg.rotation.set(
      strideRight * deg(22.0) - liftRight * deg(7.0) - crouch * deg(14.0) - launchStretch * deg(8.0) + tuck * deg(33.0) + extendForLanding * deg(13.0) + landingSquash * deg(22.0) + landingTail * deg(8.0) - landingRebound * deg(8.0),
      turn * deg(5.0) + strideRight * deg(3.0) + walkSide * deg(5.0) + kneeFold * deg(3.5),
      deg(-1.0) - turn * deg(2.0) - liftRight * deg(1.0) - walkSide * deg(2.0) + kneeFold * deg(8.5) + landingBrace * deg(3.0),
    );

    this.leftLowerLeg.position.copy(LOWER_LEG_BASE);
    this.rightLowerLeg.position.copy(LOWER_LEG_BASE);
    this.leftLowerLeg.rotation.set(
      stepRight * activity * deg(5.0) - kneeFold * deg(84.0) + kneeStraighten * deg(18.0) - landingSquash * deg(11.0) - landingTail * deg(3.5) + landingRebound * deg(7.0),
      turn * deg(2.5) + walkSide * deg(2.5) + kneeFold * deg(4.5),
      liftLeft * deg(1.0) - walkSide * deg(2.0) + kneeFold * deg(13.0) - landingBrace * deg(3.0),
    );
    this.rightLowerLeg.rotation.set(
      stepLeft * activity * deg(5.0) - kneeFold * deg(82.0) + kneeStraighten * deg(17.0) - landingSquash * deg(11.0) - landingTail * deg(3.5) + landingRebound * deg(7.0),
      turn * deg(2.5) + walkSide * deg(2.5) - kneeFold * deg(4.5),
      -liftRight * deg(1.0) - walkSide * deg(2.0) - kneeFold * deg(13.0) + landingBrace * deg(3.0),
    );

    this.leftFoot.position.set(
      FOOT_LOCAL_BASE.x,
      FOOT_LOCAL_BASE.y + liftLeft * 0.014 + tuck * 0.020 - launchStretch * 0.014 - extendForLanding * 0.024 + landingSquash * 0.016 + landingTail * 0.010,
      FOOT_LOCAL_BASE.z + strideLeft * 0.018 + tuck * 0.014 - extendForLanding * 0.034 + landingSquash * 0.012 + landingTail * 0.006,
    );
    this.rightFoot.position.set(
      FOOT_LOCAL_BASE.x,
      FOOT_LOCAL_BASE.y + liftRight * 0.014 + tuck * 0.018 - launchStretch * 0.012 - extendForLanding * 0.024 + landingSquash * 0.016 + landingTail * 0.010,
      FOOT_LOCAL_BASE.z + strideRight * 0.018 - tuck * 0.014 - extendForLanding * 0.028 + landingSquash * 0.012 + landingTail * 0.006,
    );
    this.leftFoot.rotation.set(
      -strideLeft * deg(6.0) + liftLeft * deg(5.0) + crouch * deg(7.0) + launchStretch * deg(8.0) + tuck * deg(22.0) - extendForLanding * deg(12.0) + landingSquash * deg(7.5) + landingTail * deg(3.0) - landingRebound * deg(5.0) - this.leftLowerLeg.rotation.x * 0.36,
      turn * deg(7.0) + strideLeft * deg(3.0) + walkSide * deg(4.0) - kneeFold * deg(2.0),
      -turn * deg(1.5) + plantedLeft * activity * deg(0.7) - kneeFold * deg(7.0) - landingBrace * deg(2.0),
    );
    this.rightFoot.rotation.set(
      -strideRight * deg(6.0) + liftRight * deg(5.0) + crouch * deg(7.0) + launchStretch * deg(8.0) + tuck * deg(21.0) - extendForLanding * deg(12.0) + landingSquash * deg(7.5) + landingTail * deg(3.0) - landingRebound * deg(5.0) - this.rightLowerLeg.rotation.x * 0.36,
      turn * deg(7.0) + strideRight * deg(3.0) + walkSide * deg(4.0) + kneeFold * deg(2.0),
      -turn * deg(1.5) - plantedRight * activity * deg(0.7) + kneeFold * deg(7.0) + landingBrace * deg(2.0),
    );

    this.#animateHeadSprout(walkSide, walkForward, turn, rising, falling, apex, tuck, this.landingAmount, this.takeoffAmount);
  }

  // --- Порт _animate_head_sprout(...) ---

  #animateHeadSprout(walkSide, walkForward, turn, rising, falling, apex, tuck, landing, takeoff) {
    const idleSway = sin(this.animationTime * 1.85) * deg(1.6);
    const walkSway = sin(this.turnPhase * 1.15) * this.walkActivity * deg(5.0);
    const spring = takeoff * deg(-10.0) + rising * deg(-4.0) + falling * deg(9.0) + landing * deg(13.0);
    const sideSway = -walkSide * deg(8.5) - turn * deg(7.0) + idleSway + walkSway;
    const forwardSway = -walkForward * deg(2.5) + spring;

    this.sproutRoot.position.set(0, 0.348 + takeoff * 0.014 + apex * 0.010 - landing * 0.024, -0.010);
    this.sproutRoot.rotation.set(forwardSway, 0, sideSway);
    this.sproutStem.rotation.set(0, 0, deg(1.0) + sideSway * 0.22);

    const leafFlutter = sin(this.animationTime * 3.4 + this.turnPhase * 0.35) * deg(1.15);
    const stretch = takeoff * deg(4.0) - apex * deg(2.5);
    const landingFold = landing * deg(6.0);
    const airSpread = tuck * deg(2.5);

    this.leftSproutLeaf.rotation.set(
      falling * deg(2.0),
      deg(-6.0) - sideSway * 0.24,
      deg(-39.0) + sideSway * 0.46 - leafFlutter - stretch - airSpread + landingFold,
    );
    this.rightSproutLeaf.rotation.set(
      falling * deg(2.0),
      deg(6.0) - sideSway * 0.24,
      deg(39.0) + sideSway * 0.46 + leafFlutter + stretch + airSpread - landingFold,
    );
  }

  // --- Порт _animate_eyes(delta) ---

  #animateEyes(delta, lookTarget) {
    this.#updateSunGaze(delta);
    this.blinkTimer -= delta;
    if (this.blinkTimer <= 0) {
      this.blinkTimer = this.#nextBlinkInterval();
      if (this.#sunBlinkIntensity() > 0 || !lookTarget) this.#startBlink();
    }
    this.#updateBlinkCycle(delta);

    this.eyeDartTimer -= delta;
    if (this.eyeDartTimer <= 0) {
      if (lookTarget) {
        this.eyeDartTimer = 0.55 + abs(sin(this.animationTime * 1.9)) * 0.55;
        this.eyeDart.set(0, 0);
      } else {
        this.eyeDartTimer = 1.6 + abs(sin(this.animationTime * 1.9)) * 1.4;
        this.eyeDart.set(sin(this.animationTime * 8.1), cos(this.animationTime * 6.4)).multiplyScalar(0.10);
      }
    }

    const targetFocus = this.#targetEyeFocus(lookTarget);
    targetFocus.x += clamp(this.turnIntensity * 0.18 + this.turnYawError * 0.10, -0.24, 0.24);
    const idleDartWeight = lookTarget ? 0 : 0.30;
    targetFocus.add(this.eyeDart.clone().multiplyScalar(idleDartWeight));
    this.eyeFocus.lerp(targetFocus, 1 - exp(-9 * delta));

    const idleAmount = 1 - this.gazeActivity;
    const eyeIdle = new THREE.Vector2(sin(this.animationTime * 0.55) * 0.010, sin(this.animationTime * 0.75) * 0.006).multiplyScalar(idleAmount);
    const focus = this.eyeFocus.clone().add(eyeIdle);
    const eyeShiftX = lerp(0.040, 0.105, this.gazeActivity);
    const eyeShiftY = lerp(0.022, 0.060, this.gazeActivity);
    const eyeShiftZ = lerp(0.006, 0.018, this.gazeActivity);
    const convergence = this.gazeActivity * 0.018;
    const eyeOffset = new THREE.Vector3(focus.x * eyeShiftX, focus.y * eyeShiftY, -0.030 - abs(focus.x) * eyeShiftZ);
    this.leftEye.position.set(LEFT_EYE_BASE.x + eyeOffset.x + convergence, LEFT_EYE_BASE.y + eyeOffset.y, LEFT_EYE_BASE.z + eyeOffset.z);
    this.rightEye.position.set(RIGHT_EYE_BASE.x + eyeOffset.x - convergence, RIGHT_EYE_BASE.y + eyeOffset.y, RIGHT_EYE_BASE.z + eyeOffset.z);

    const glint = new THREE.Vector3(-0.014 + focus.x * 0.006, 0.014 + focus.y * 0.004, -0.014);
    this.leftGlint.position.copy(this.leftEye.position).add(glint);
    this.rightGlint.position.copy(this.rightEye.position).add(glint);
    this.#applyEyeScale();
  }

  #startBlink() {
    if (this.blinkClosing || this.blinkHoldTimer > 0 || this.blinkAmount > 0.35) return;
    this.blinkClosing = true;
  }

  #updateBlinkCycle(delta) {
    const sunIntensity = this.#sunBlinkIntensity();
    if (this.blinkClosing) {
      const closeSpeed = lerp(BLINK_CLOSE_SPEED, SUN_BLINK_CLOSE_SPEED, sunIntensity);
      this.blinkAmount = minf(this.blinkAmount + delta * closeSpeed, 1);
      if (this.blinkAmount >= 1) {
        this.blinkClosing = false;
        this.blinkHoldTimer = lerp(BLINK_HOLD_SECONDS, SUN_BLINK_HOLD_SECONDS, sunIntensity);
      }
      return;
    }
    if (this.blinkHoldTimer > 0) {
      this.blinkHoldTimer = maxf(this.blinkHoldTimer - delta, 0);
      return;
    }
    const openSpeed = lerp(BLINK_OPEN_SPEED, SUN_BLINK_OPEN_SPEED, sunIntensity);
    this.blinkAmount = maxf(this.blinkAmount - delta * openSpeed, 0);
  }

  #nextBlinkInterval() {
    const sunIntensity = this.#sunBlinkIntensity();
    const slowInterval = BASE_BLINK_MIN + abs(sin(this.animationTime * 0.73 + 0.31)) * BASE_BLINK_VARIATION;
    const fastInterval = SUN_BLINK_MIN + abs(sin(this.animationTime * 1.47 + 1.2)) * SUN_BLINK_VARIATION;
    return lerp(slowInterval, fastInterval, sunIntensity);
  }

  #applyEyeScale() {
    const turnSquint = clamp(abs(this.turnIntensity) * 0.018 + this.turnActivity * 0.010, 0, 0.035);
    const focusWiden = clamp(abs(this.eyeFocus.x) * 0.045, 0, 0.055);
    const openScale = clamp(lerp(1, 0.08, this.blinkAmount) - turnSquint, 0.06, 1);
    this.leftEye.scale.set(1 + focusWiden, openScale, 0.16);
    this.rightEye.scale.set(1 + focusWiden, openScale, 0.16);
    this.leftEyeWhite.scale.set(1, openScale, 1);
    this.rightEyeWhite.scale.set(1, openScale, 1);
    const glintOpen = clamp(openScale * (1 - this.blinkAmount), 0, 1);
    this.leftGlint.scale.set(1, glintOpen, 0.10);
    this.rightGlint.scale.set(1, glintOpen, 0.10);
  }

  #targetPresence(lookTarget) {
    if (!lookTarget) return 0;
    this.headRoot.updateWorldMatrix(true, false);
    const source = this.headRoot.getWorldPosition(new THREE.Vector3());
    const distance = source.distanceTo(lookTarget);
    return clamp(1 - distance / EYE_LOOK_RADIUS, 0, 1);
  }

  #targetEyeFocus(lookTarget) {
    if (!lookTarget) return new THREE.Vector2();
    this.headRoot.updateWorldMatrix(true, false);
    const local = this.headRoot.worldToLocal(lookTarget.clone());
    const depth = maxf(abs(local.z), 0.25);
    const gazeGainX = lerp(1.15, 1.85, this.#targetPresence(lookTarget));
    const gazeGainY = lerp(0.85, 1.20, this.#targetPresence(lookTarget));
    return new THREE.Vector2(
      clamp(local.x / depth * gazeGainX, -1, 1),
      clamp(local.y / depth * gazeGainY, -0.75, 0.75),
    );
  }

  // --- Солнечный взгляд: зажмуривается, глядя на солнце (как в оригинале) ---

  #updateSunGaze(delta) {
    const lookFactor = this.#sunLookFactor();
    if (lookFactor > 0) {
      this.sunGazeCharge = minf(this.sunGazeCharge + lookFactor * delta / SUN_GAZE_CHARGE_SECONDS, 1);
    } else {
      this.sunGazeCharge = maxf(this.sunGazeCharge - delta / SUN_GAZE_DECAY_SECONDS, 0);
    }
  }

  #sunLookFactor() {
    if (this.sunDirection.lengthSq() < 0.0001) return 0;
    const clampedPitch = clamp(this.externalPitch, deg(-84), deg(84));
    const localDirection = new THREE.Vector3(0, sin(clampedPitch), -cos(clampedPitch))
      .applyAxisAngle(Y_AXIS, this.group.rotation.y);
    const alignment = localDirection.dot(this.sunDirection.clone().normalize());
    return clamp((alignment - SUN_LOOK_DOT_START) / (1 - SUN_LOOK_DOT_START), 0, 1);
  }

  #sunBlinkIntensity() {
    return clamp((this.sunGazeCharge - 0.65) / 0.35, 0, 1);
  }
}
