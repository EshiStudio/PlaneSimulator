// Самолёт: загрузка GLB, парковочная стойка, пропеллер и закрылки.
import * as THREE from 'three';
import { GLTFLoader } from '../lib/GLTFLoader.js';
import { CELL } from './constants.js';

const TARGET_SPAN = 6.0;              // размах, к которому подгоняется модель, м
const GROUND_CONTACT_DEPTH = 0.01;    // насколько шасси утоплено в пол, м
const STANCE_ROLL = THREE.MathUtils.degToRad(3);    // компенсация крена вправо
const STANCE_PITCH = THREE.MathUtils.degToRad(-8);  // парковочный тангаж

const PROP_MAX_SPEED = 40;            // рад/с (~6.4 об/с)
const PROP_ACCEL = 18;                // рад/с^2 — плавная раскрутка и торможение
const TWO_PI = Math.PI * 2;

const FLAP_MAX_ANGLE_UPPER = THREE.MathUtils.degToRad(25);
const FLAP_MAX_ANGLE_LOWER = THREE.MathUtils.degToRad(35);
const FLAP_SPEED = THREE.MathUtils.degToRad(120);   // °/с — плавный ход
// Порог в СОБСТВЕННЫХ координатах модели: центры панелей по Y — 0.397/0.451
// (верхнее крыло) и 0.206/0.153 (нижнее), по X — около ±0.45.
const FLAP_LEVEL_SPLIT_Y = 0.3;
// Доля глубины панели, по которой определяется направление оси. Узкая полоса у
// самой кромки не годится: панели стреловидные, и в полосу попадает один угол.
const ATTACHED_HALF = 0.5;
// Полоса отбора вершин самой линии крепления (доля глубины панели).
const ATTACH_BAND = 0.08;

const PROP_BLADE_RE = /^polySurface(304|305|306)_/;
const PROP_OUTLINE_NAME = 'polySurface406_Tooner_0';
const FLAP_MESH_RE = /^polySurface(161|165|173|174|407|408|410|411)_/;
const AXIS_X = new THREE.Vector3(1, 0, 0);

function unionBox(nodes) {
  const box = new THREE.Box3();
  nodes.forEach(node => box.union(new THREE.Box3().setFromObject(node)));
  return box;
}

/** Матрица перевода вершин меша в собственные координаты модели. */
function meshToModelMatrix(mesh, model) {
  return new THREE.Matrix4()
    .copy(model.matrixWorld).invert()
    .multiply(mesh.matrixWorld);
}

/**
 * Ось шарнира в СОБСТВЕННЫХ координатах модели: направление вдоль размаха
 * панели и точка НА ЛИНИИ ЕЁ КРЕПЛЕНИЯ к крылу. Ось обязана лежать на этой
 * линии: вокруг центра панели кромка выезжает из крыла и открывается щель.
 * Возвращает null, если геометрии нет или панель вырождена.
 */
function hingeAxis(meshes, model) {
  const verts = [];
  for (const mesh of meshes) {
    const toModel = meshToModelMatrix(mesh, model);
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      verts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(toModel));
    }
  }
  if (verts.length < 3) return null;

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of verts) {
    if (p.z < zMin) zMin = p.z;
    if (p.z > zMax) zMax = p.z;
  }
  const depth = zMax - zMin;
  if (depth < 1e-6) return null;

  // Направление — по крайним по X вершинам приклёпанной половины панели:
  // прямая между ними наследует стреловидность кромки.
  const attached = verts.filter(p => p.z >= zMax - depth * ATTACHED_HALF);
  let p1 = attached[0];
  let p2 = attached[0];
  for (const p of attached) {
    if (p.x < p1.x) p1 = p;
    if (p.x > p2.x) p2 = p;
  }
  const dir = p2.clone().sub(p1);
  if (dir.lengthSq() < 1e-10) return null;
  dir.normalize();

  // Точка на линии крепления. Убираем составляющую вдоль оси: стреловидная
  // кромка схлопывается в точку, и её вершины чисто выделяются по максимуму Z
  // независимо от угла наклона.
  const residualZ = p => p.z - dir.z * p.dot(dir);
  let edgeZ = -Infinity;
  for (const p of verts) {
    const z = residualZ(p);
    if (z > edgeZ) edgeZ = z;
  }
  const origin = new THREE.Vector3();
  let count = 0;
  for (const p of verts) {
    if (residualZ(p) < edgeZ - depth * ATTACH_BAND) continue;
    origin.add(p);
    count++;
  }
  if (count === 0) return null;
  origin.divideScalar(count);

  return { dir, origin };
}

export class Plane {
  constructor() {
    this.group = new THREE.Group();
    this.cell = { x: 0, z: 0 };
    // Модель ориентирована носом по +Z, хвостом по -Z (проверено рендером),
    // поэтому yaw = atan2(dx, dz) поворачивает нос точно в сторону движения.
    this.yaw = 0;

    this.engineOn = false;        // пробел заводит/глушит двигатель
    this.propPivot = null;
    this.propAngle = 0;
    this.propSpeed = 0;

    this.flapsOut = false;        // F — выпустить/убрать
    this.flapGroups = [];
    this.flapAngleUpper = 0;
    this.flapAngleLower = 0;

    this.placeAt(0, 0);
  }

  placeAt(x, z) {
    this.cell = { x, z };
    this.group.position.set(x * CELL + CELL / 2, 0, z * CELL + CELL / 2);
  }

  move(dx, dz) {
    if (dx !== 0 || dz !== 0) {
      this.yaw = Math.atan2(dx, dz);
      this.group.rotation.y = this.yaw;
    }
    this.placeAt(this.cell.x + dx, this.cell.z + dz);
  }

  load(url) {
    return new Promise((resolve, reject) => {
      new GLTFLoader().load(url, gltf => {
        try {
          this.#build(gltf.scene);
          resolve();
        } catch (err) {
          reject(err);
        }
      }, undefined, reject);
    });
  }

  #build(model) {
    const flightEffects = [];
    const solidMeshes = [];
    model.traverse(node => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const isFlightEffect = materials.some(material => {
        const name = material?.name?.toLowerCase();
        return name === 'blur_effect' || name === 'lambert1';
      });
      if (isFlightEffect) {
        flightEffects.push(node);
        return;
      }
      const isOutline = materials.some(material => material?.name?.toLowerCase() === 'tooner');
      node.castShadow = !isOutline;
      node.receiveShadow = !isOutline;
      if (!isOutline) solidMeshes.push(node);
    });
    flightEffects.forEach(node => node.removeFromParent());
    if (solidMeshes.length === 0) throw new Error('в модели не найдено ни одного меша корпуса');

    // Контурная Tooner-оболочка в расчёт не входит: она выступает вниз почти на 0.5 м.
    const raw = unionBox(solidMeshes);
    const span = Math.max(raw.max.x - raw.min.x, raw.max.z - raw.min.z);
    model.scale.setScalar(span > 0.001 ? TARGET_SPAN / span : 1);

    // Крен и тангаж живут в отдельном узле-стойке, а собственные оси модели
    // остаются невращёнными: на них строятся ось винта и оси шарниров.
    const stance = new THREE.Group();
    stance.rotation.set(STANCE_PITCH, 0, STANCE_ROLL);
    stance.add(model);
    stance.updateMatrixWorld(true);
    const grounded = unionBox(solidMeshes);
    stance.position.y = -(grounded.min.y + GROUND_CONTACT_DEPTH);

    this.group.add(stance);
    this.group.updateMatrixWorld(true);
    this.model = model;   // собственная система координат модели, нужна для диагностики

    this.#buildPropeller(model);
    this.#buildFlaps(model);
  }

  /** Лопасти собираются в общий pivot на оси винта, чтобы вращаться вокруг Z. */
  #buildPropeller(model) {
    const blades = [];
    model.traverse(node => {
      if (node.isMesh && PROP_BLADE_RE.test(node.name)) blades.push(node);
    });
    if (blades.length === 0) {
      console.warn('PlaneSimulator: лопасти винта не найдены — двигатель будет без анимации');
      return;
    }

    const center = unionBox(blades).getCenter(new THREE.Vector3());
    const pivot = new THREE.Object3D();
    model.add(pivot);
    pivot.position.copy(model.worldToLocal(center));

    // Контурная Tooner-оболочка винта вращается вместе с лопастями.
    model.traverse(node => {
      if (node.isMesh && node.name === PROP_OUTLINE_NAME) blades.push(node);
    });
    blades.forEach(mesh => pivot.attach(mesh));
    this.propPivot = pivot;
  }

  /**
   * Закрылки — родные светлые панели задней кромки (161/165 сверху, 173/174
   * снизу) со своими Tooner-оболочками (407/408/410/411). Каждая панель садится
   * на шарнир, ось которого идёт вдоль её наклонной передней кромки.
   */
  #buildFlaps(model) {
    const flapMeshes = [];
    model.traverse(node => {
      if (node.isMesh && FLAP_MESH_RE.test(node.name)) flapMeshes.push(node);
    });

    // Сторону и ярус считаем в СОБСТВЕННЫХ координатах модели. Прежде пороги
    // (x > 0, y > 0.3), рассчитанные на сырые единицы GLB, сравнивались с
    // мировыми: после масштаба ×5.7 и сдвига в центр клетки (x = +5) все восемь
    // мешей попадали в одну группу «RU» — четыре закрылка сидели на одном
    // шарнире, а угол нижних панелей вообще не применялся.
    const pairs = new Map();
    const center = new THREE.Vector3();
    flapMeshes.forEach(mesh => {
      new THREE.Box3().setFromObject(mesh).getCenter(center);
      model.worldToLocal(center);
      const key = (center.x > 0 ? 'R' : 'L') + (center.y > FLAP_LEVEL_SPLIT_Y ? 'U' : 'D');
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(mesh);
    });

    pairs.forEach((meshes, key) => {
      const solid = meshes.filter(mesh => !mesh.name.includes('Tooner'));
      const axis = hingeAxis(solid, model);
      if (axis === null) {
        console.warn(`PlaneSimulator: у группы закрылков ${key} нет пригодной кромки — пропущена`);
        return;
      }

      // Два узла, а не один: внешний стоит на линии крепления и держит
      // выравнивание оси по размаху, вложенный отклоняет панель.
      // Совмещать нельзя — `rotation` и `quaternion` в three.js это одно
      // состояние, и присваивание rotation.x стирает выравнивание, из-за чего
      // панель вращается вокруг произвольной оси и вылезает из крыла.
      const hinge = new THREE.Group();
      hinge.position.copy(axis.origin);
      hinge.quaternion.setFromUnitVectors(AXIS_X, axis.dir);
      const pivot = new THREE.Group();
      hinge.add(pivot);
      model.add(hinge);
      meshes.forEach(mesh => pivot.attach(mesh));

      const level = key[1];
      this.flapGroups.push({
        group: pivot,
        level,
        maxAngle: level === 'U' ? FLAP_MAX_ANGLE_UPPER : FLAP_MAX_ANGLE_LOWER,
      });
    });

    if (this.flapGroups.length === 0) {
      console.warn('PlaneSimulator: закрылки не найдены — клавиша F ничего не сделает');
    }
  }

  update(dt) {
    if (this.propPivot) {
      this.propSpeed = this.engineOn
        ? Math.min(PROP_MAX_SPEED, this.propSpeed + PROP_ACCEL * dt)
        : Math.max(0, this.propSpeed - PROP_ACCEL * dt);
      // Угол держим в пределах оборота: за часы работы накопленное значение
      // теряет точность и вращение становится рваным.
      this.propAngle = (this.propAngle + this.propSpeed * dt) % TWO_PI;
      this.propPivot.rotation.z = this.propAngle;
    }

    let upper = 0;
    let lower = 0;
    for (const fg of this.flapGroups) {
      const target = this.flapsOut ? -fg.maxAngle : 0;
      const cur = fg.group.rotation.x;
      const step = FLAP_SPEED * dt;
      fg.group.rotation.x = cur < target
        ? Math.min(target, cur + step)
        : Math.max(target, cur - step);

      const angle = Math.max(0, -fg.group.rotation.x);
      if (fg.level === 'U') upper = Math.max(upper, angle);
      else lower = Math.max(lower, angle);
    }
    this.flapAngleUpper = upper;
    this.flapAngleLower = lower;
  }
}
