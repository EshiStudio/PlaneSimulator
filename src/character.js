// Персонаж, перенесённый из Godot-скрипта `cheracter/SHOOTER_generator_player_scripts.zip`
// (`scripts/test_character.gd`). Модели там нет: фигура целиком строится кодом из
// боксов, капсул и сфер, поэтому здесь повторена та же сборка на three.js —
// размеры, цвета и смещения взяты один в один.
//
// Отличия от оригинала, вызванные тем, что у нас нет шутера:
// - нет ходьбы, приседа и прыжков: играется только покой (в GDScript это те же
//   формулы при нулевой активности);
// - нет механики «щурится на солнце», поэтому моргание идёт по обычному
//   интервалу, а не только при взгляде на светило;
// - вместо блоба-тени под ногами работает настоящая тень сцены.
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

const BLINK_MIN = 14.0;
const BLINK_VARIATION = 8.0;
const BLINK_CLOSE_SPEED = 12.5;
const BLINK_OPEN_SPEED = 8.0;
const BLINK_HOLD_SECONDS = 0.020;
// Насколько взгляд «включён»: в оригинале считается из присутствия цели, здесь
// цель есть всегда (камера), но немного покоя оставляем, чтобы глаза жили.
const GAZE_ACTIVITY = 0.7;

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

export class Character {
  constructor() {
    this.group = new THREE.Group();
    this.animationTime = 0;

    this.blinkAmount = 0;
    this.blinkTimer = 1.4;
    this.blinkClosing = false;
    this.blinkHoldTimer = 0;

    this.eyeFocus = new THREE.Vector2();
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
   */
  hideHeadForOwner(hidden) {
    this.headRoot.visible = !hidden;
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
    this.#animateBody();
    this.#animateSprout();
    this.#animateEyes(dt, lookTarget);
  }

  // Покой: те же формулы, что в _animate_body при нулевой активности.
  #animateBody() {
    const t = this.animationTime;
    const idle = Math.sin(t * 1.55);

    this.bodyRoot.position.y = Math.sin(t * 1.8) * 0.008;
    this.bodyRoot.rotation.z = idle * deg(0.5);
    this.headRoot.rotation.x = Math.sin(t * 1.6) * deg(0.6);

    this.leftArm.rotation.z = deg(-10) + idle * deg(0.9);
    this.rightArm.rotation.z = deg(10) - idle * deg(0.9);
    this.leftLeg.rotation.z = deg(1);
    this.rightLeg.rotation.z = deg(-1);
  }

  #animateSprout() {
    const t = this.animationTime;
    const sideSway = Math.sin(t * 1.85) * deg(1.6);
    const flutter = Math.sin(t * 3.4) * deg(1.15);

    this.sproutRoot.rotation.set(0, 0, sideSway);
    this.sproutStem.rotation.z = deg(1) + sideSway * 0.22;
    this.leftSproutLeaf.rotation.set(0, deg(-6) - sideSway * 0.24, deg(-39) + sideSway * 0.46 - flutter);
    this.rightSproutLeaf.rotation.set(0, deg(6) - sideSway * 0.24, deg(39) + sideSway * 0.46 + flutter);
  }

  #animateEyes(dt, lookTarget) {
    this.#updateBlink(dt);

    const focusTarget = this.#eyeFocusFor(lookTarget);
    this.eyeFocus.lerp(focusTarget, 1 - Math.exp(-9 * dt));

    const t = this.animationTime;
    const idleAmount = 1 - GAZE_ACTIVITY;
    const focusX = this.eyeFocus.x + Math.sin(t * 0.55) * 0.010 * idleAmount;
    const focusY = this.eyeFocus.y + Math.sin(t * 0.75) * 0.006 * idleAmount;

    const shiftX = THREE.MathUtils.lerp(0.040, 0.105, GAZE_ACTIVITY);
    const shiftY = THREE.MathUtils.lerp(0.022, 0.060, GAZE_ACTIVITY);
    const shiftZ = THREE.MathUtils.lerp(0.006, 0.018, GAZE_ACTIVITY);
    const convergence = GAZE_ACTIVITY * 0.018;
    const offsetX = focusX * shiftX;
    const offsetY = focusY * shiftY;
    const offsetZ = -0.030 - Math.abs(focusX) * shiftZ;

    this.leftEye.position.set(LEFT_EYE_BASE.x + offsetX + convergence, LEFT_EYE_BASE.y + offsetY, LEFT_EYE_BASE.z + offsetZ);
    this.rightEye.position.set(RIGHT_EYE_BASE.x + offsetX - convergence, RIGHT_EYE_BASE.y + offsetY, RIGHT_EYE_BASE.z + offsetZ);

    const glint = vec(-0.014 + focusX * 0.006, 0.014 + focusY * 0.004, -0.014);
    this.leftGlint.position.copy(this.leftEye.position).add(glint);
    this.rightGlint.position.copy(this.rightEye.position).add(glint);

    // Веки: зрачок и белок сплющиваются по высоте, блик гаснет.
    const openScale = THREE.MathUtils.clamp(THREE.MathUtils.lerp(1.0, 0.08, this.blinkAmount), 0.06, 1.0);
    const widen = THREE.MathUtils.clamp(Math.abs(this.eyeFocus.x) * 0.045, 0, 0.055);
    this.leftEye.scale.set(1 + widen, openScale, 0.16);
    this.rightEye.scale.set(1 + widen, openScale, 0.16);
    this.leftEyeWhite.scale.set(1, openScale, 1);
    this.rightEyeWhite.scale.set(1, openScale, 1);
    const glintOpen = THREE.MathUtils.clamp(openScale * (1 - this.blinkAmount), 0, 1);
    this.leftGlint.scale.set(1, glintOpen, 0.10);
    this.rightGlint.scale.set(1, glintOpen, 0.10);
  }

  #eyeFocusFor(lookTarget) {
    const focus = new THREE.Vector2();
    if (!lookTarget) return focus;
    const local = this.headRoot.worldToLocal(lookTarget.clone());
    const depth = Math.max(Math.abs(local.z), 0.25);
    focus.set(
      THREE.MathUtils.clamp(local.x / depth * 1.85, -1, 1),
      THREE.MathUtils.clamp(local.y / depth * 1.20, -0.75, 0.75)
    );
    // Лицо смотрит по -Z: цель позади головы не должна «выворачивать» зрачки.
    if (local.z > 0) focus.multiplyScalar(-1);
    return focus;
  }

  #updateBlink(dt) {
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkTimer = BLINK_MIN + Math.abs(Math.sin(this.animationTime * 0.73 + 0.31)) * BLINK_VARIATION;
      if (!this.blinkClosing && this.blinkHoldTimer <= 0 && this.blinkAmount <= 0.35) {
        this.blinkClosing = true;
      }
    }

    if (this.blinkClosing) {
      this.blinkAmount = Math.min(this.blinkAmount + dt * BLINK_CLOSE_SPEED, 1);
      if (this.blinkAmount >= 1) {
        this.blinkClosing = false;
        this.blinkHoldTimer = BLINK_HOLD_SECONDS;
      }
      return;
    }
    if (this.blinkHoldTimer > 0) {
      this.blinkHoldTimer = Math.max(this.blinkHoldTimer - dt, 0);
      return;
    }
    this.blinkAmount = Math.max(this.blinkAmount - dt * BLINK_OPEN_SPEED, 0);
  }
}
