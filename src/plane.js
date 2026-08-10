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

// --- Управляющие поверхности ---
const AILERON_MAX_ANGLE = THREE.MathUtils.degToRad(22);   // крыльевые панели, крен
const ELEVATOR_MAX_ANGLE = THREE.MathUtils.degToRad(20);  // хвост, тангаж
const SURFACE_SPEED = THREE.MathUtils.degToRad(180);      // °/с — ход поверхностей

// Полёта пока нет: самолёт стоит на земле, двигаются только поверхности.
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
const AILERON_MESH_RE = /^polySurface(161|165|173|174|407|408|410|411)_/;
// Половины горизонтального оперения. Своих контурных оболочек у них нет —
// контур хвоста входит в общую оболочку polySurface308_Tooner_0.
const ELEVATOR_MESH_RE = /^polySurface(200|292)_/;
const HULL_OUTLINE_NAME = 'polySurface308_Tooner_0';
const FIN_MESH_RE = /^polySurface201_/;
// Зона стыка киля с оперением. Контур внутри неё в нейтрали закрыт панелями, а
// при отклонении руля торчит наружу чёрным клином, поэтому удаляется совсем.
// Оболочка раздута примерно на 0.09 в единицах модели, поэтому вниз зона
// должна уходить заметно глубже самой панели.
const JUNCTION_SIDE_MARGIN = 0.02;
const JUNCTION_BELOW = 0.14;
const JUNCTION_ABOVE = 0.02;
const AXIS_X = new THREE.Vector3(1, 0, 0);

/** Габариты мешей в собственных координатах модели. */
function localBox(meshes, model) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const toModel = meshToModelMatrix(mesh, model);
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(toModel));
    }
  }
  return box;
}

/** Новая геометрия из перечисленных треугольников исходной (без индекса). */
function subGeometry(geometry, triangles) {
  const index = geometry.index;
  const result = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const size = attr.itemSize;
    const array = new Float32Array(triangles.length * 3 * size);
    let w = 0;
    for (const t of triangles) {
      for (let corner = 0; corner < 3; corner++) {
        const i = index ? index.getX(t * 3 + corner) : t * 3 + corner;
        for (let c = 0; c < size; c++) array[w++] = attr.getComponent(i, c);
      }
    }
    result.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  return result;
}

/**
 * Вырезает из общей контурной оболочки её кусок, относящийся к заданным мешам.
 * Нужно для хвоста: его контур входит в общую оболочку фюзеляжа, и без разреза
 * он остаётся висеть чёрным пятном на месте отклонённого руля высоты.
 *
 * Треугольник отходит тому мешу, к которому он БЛИЖЕ ВСЕГО. По габаритам
 * панели это делать нельзя: оболочка раздута наружу почти на полметра и в них
 * просто не попадает, а достаточный запас захватывает киль и хвостовую балку.
 */
function extractOutlineFor(shell, model, targets, candidates) {
  const geometry = shell.geometry;
  const index = geometry.index;
  const position = geometry.attributes.position;
  const toModel = meshToModelMatrix(shell, model);
  const triangleCount = (index ? index.count : position.count) / 3;

  const owners = candidates.map(mesh => ({
    box: localBox([mesh], model),
    wanted: targets.includes(mesh),
  }));
  owners.forEach(owner => { owner.center = owner.box.getCenter(new THREE.Vector3()); });

  const taken = [];
  const kept = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(position, i0).applyMatrix4(toModel);
    b.fromBufferAttribute(position, i1).applyMatrix4(toModel);
    c.fromBufferAttribute(position, i2).applyMatrix4(toModel);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);

    let best = null;
    let bestScore = Infinity;
    for (const owner of owners) {
      // Расстояние до габаритов, а при равенстве (точка внутри нескольких) —
      // до их центра: так треугольник достаётся более подходящему мешу.
      const score = owner.box.distanceToPoint(centroid) * 1000 + centroid.distanceTo(owner.center);
      if (score < bestScore) {
        bestScore = score;
        best = owner;
      }
    }
    if (best !== null && best.wanted) taken.push(t);
    else kept.push(t);
  }

  if (taken.length === 0) return null;

  const part = new THREE.Mesh(subGeometry(geometry, taken), shell.material);
  part.name = `${shell.name}_part`;
  part.position.copy(shell.position);
  part.quaternion.copy(shell.quaternion);
  part.scale.copy(shell.scale);
  part.castShadow = false;      // контур тени не отбрасывает
  part.receiveShadow = false;
  shell.parent.add(part);

  const remaining = subGeometry(geometry, kept);
  geometry.dispose();
  shell.geometry = remaining;
  return part;
}

/** Удаляет из оболочки треугольники, чей центр лежит внутри области. */
function deleteOutlineInside(shell, model, box) {
  const geometry = shell.geometry;
  const index = geometry.index;
  const position = geometry.attributes.position;
  const toModel = meshToModelMatrix(shell, model);
  const triangleCount = (index ? index.count : position.count) / 3;

  const kept = [];
  const v = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t++) {
    centroid.set(0, 0, 0);
    for (let corner = 0; corner < 3; corner++) {
      const i = index ? index.getX(t * 3 + corner) : t * 3 + corner;
      centroid.add(v.fromBufferAttribute(position, i).applyMatrix4(toModel));
    }
    centroid.multiplyScalar(1 / 3);
    if (!box.containsPoint(centroid)) kept.push(t);
  }

  if (kept.length === triangleCount) return 0;
  const remaining = subGeometry(geometry, kept);
  geometry.dispose();
  shell.geometry = remaining;
  return triangleCount - kept.length;
}

/** Плавное движение значения к цели с ограничением шага. */
function approach(current, target, step) {
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

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

    // Ввод управления: +1 — руль вверх / крен вправо, -1 — вниз / влево.
    this.pitchInput = 0;
    this.rollInput = 0;

    this.ailerons = [];           // крыльевые панели: крен
    this.elevators = [];          // половины оперения: тангаж
    this.aileronAngle = 0;
    this.elevatorAngle = 0;

    this.placeAt(0, 0);
  }

  placeAt(x, z) {
    this.cell = { x, z };
    this.group.position.set(x * CELL + CELL / 2, this.group.position.y, z * CELL + CELL / 2);
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
    this.model = model;              // собственная система координат модели
    this.solidMeshes = solidMeshes;  // без контурных оболочек

    this.#buildPropeller(model);
    this.#buildAilerons(model);
    this.#buildElevator(model);
  }

  /**
   * Сажает набор мешей на шарнир и возвращает узел отклонения.
   * Узлов ДВА, а не один: внешний стоит на линии крепления к крылу и держит
   * выравнивание оси, вложенный отклоняет поверхность. Совмещать нельзя —
   * `rotation` и `quaternion` в three.js это одно состояние, и присваивание
   * rotation.x стирает выравнивание, из-за чего панель вращается вокруг
   * произвольной оси и вылезает из крыла.
   */
  #mountSurface(model, meshes, label) {
    const solid = meshes.filter(mesh => !mesh.name.includes('Tooner'));
    const axis = hingeAxis(solid, model);
    if (axis === null) {
      console.warn(`PlaneSimulator: у поверхности ${label} нет пригодной кромки — пропущена`);
      return null;
    }
    const hinge = new THREE.Group();
    hinge.position.copy(axis.origin);
    hinge.quaternion.setFromUnitVectors(AXIS_X, axis.dir);
    const pivot = new THREE.Group();
    hinge.add(pivot);
    model.add(hinge);
    meshes.forEach(mesh => pivot.attach(mesh));
    return pivot;
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
   * Элероны — родные светлые панели задней кромки (161/165 сверху, 173/174
   * снизу) со своими Tooner-оболочками (407/408/410/411). Панели одной стороны
   * ходят вместе, левая и правая — в противоположные стороны (крен).
   */
  #buildAilerons(model) {
    const flapMeshes = [];
    model.traverse(node => {
      if (node.isMesh && AILERON_MESH_RE.test(node.name)) flapMeshes.push(node);
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
      const pivot = this.#mountSurface(model, meshes, `элерон ${key}`);
      if (pivot === null) return;
      this.ailerons.push({ pivot, side: key[0], level: key[1] });
    });

    if (this.ailerons.length === 0) {
      console.warn('PlaneSimulator: элероны не найдены — крен будет без анимации');
    }
  }

  /**
   * Руль высоты — половины горизонтального оперения (200 слева, 292 справа).
   * Каждая садится на свой шарнир, обе ходят синхронно.
   */
  #buildElevator(model) {
    const halves = [];
    let hull = null;
    let fin = null;
    model.traverse(node => {
      if (!node.isMesh) return;
      if (ELEVATOR_MESH_RE.test(node.name)) halves.push(node);
      else if (node.name === HULL_OUTLINE_NAME) hull = node;
      else if (FIN_MESH_RE.test(node.name)) fin = node;
    });

    if (halves.length === 0) {
      console.warn('PlaneSimulator: руль высоты не найден — тангаж будет без анимации');
      return;
    }

    // Обе половины ходят синхронно, поэтому сидят на ОДНОМ шарнире. Так контур
    // хвоста вырезается одним куском: он состоит из крупных треугольников, и
    // при делении на две области они перестают целиком попадать в область и
    // остаются висеть чёрным пятном на месте отклонённого руля.
    const surfaces = [...halves];

    if (hull !== null) {
      // Соседи-конкуренты за треугольники контура: киль и хвостовая балка
      // должны забрать свои куски, иначе они уедут вместе с рулём.
      // Сначала убираем контур в стыке киля с оперением: в нейтрали он закрыт
      // панелями, а при отклонении торчит чёрным клином — причём торчит именно
      // потому, что уезжает ВМЕСТЕ с рулём. Поэтому удаляем его ДО выделения,
      // иначе эти треугольники попадут в подвижный кусок.
      if (fin !== null) {
        const finBox = localBox([fin], model);
        const tailBox = localBox(halves, model);
        const junction = new THREE.Box3(
          new THREE.Vector3(
            finBox.min.x - JUNCTION_SIDE_MARGIN,
            tailBox.min.y - JUNCTION_BELOW,
            Math.min(finBox.min.z, tailBox.min.z)
          ),
          new THREE.Vector3(
            finBox.max.x + JUNCTION_SIDE_MARGIN,
            tailBox.max.y + JUNCTION_ABOVE,
            Math.max(finBox.max.z, tailBox.max.z)
          )
        );
        deleteOutlineInside(hull, model, junction);
      }

      const outline = extractOutlineFor(hull, model, halves, this.solidMeshes);
      if (outline !== null) surfaces.push(outline);
      else console.warn('PlaneSimulator: контур хвоста не выделен — останется на месте');
    } else {
      console.warn('PlaneSimulator: общая контурная оболочка не найдена — контур хвоста останется на месте');
    }

    const pivot = this.#mountSurface(model, surfaces, 'руль высоты');
    if (pivot !== null) this.elevators.push(pivot);
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

    const surfaceStep = SURFACE_SPEED * dt;

    // Элероны: при крене вправо правая панель идёт вверх, левая вниз.
    // rotation.x > 0 поднимает заднюю кромку, < 0 опускает.
    const aileronTarget = this.rollInput * AILERON_MAX_ANGLE;
    for (const surface of this.ailerons) {
      const target = surface.side === 'R' ? aileronTarget : -aileronTarget;
      surface.pivot.rotation.x = approach(surface.pivot.rotation.x, target, surfaceStep);
    }
    this.aileronAngle = this.ailerons.length > 0 ? this.ailerons[0].pivot.rotation.x : 0;

    // Руль высоты: набор высоты — задняя кромка вверх.
    const elevatorTarget = this.pitchInput * ELEVATOR_MAX_ANGLE;
    for (const pivot of this.elevators) {
      pivot.rotation.x = approach(pivot.rotation.x, elevatorTarget, surfaceStep);
    }
    this.elevatorAngle = this.elevators.length > 0 ? this.elevators[0].rotation.x : 0;
  }
}
