// Сцена, рендер, свет и бесконечная земля: сетка рисуется шейдером,
// а плоскость следует за камерой.
import * as THREE from 'three';
import { CELL, MAJOR, GROUND_SIZE, FADE_START, FADE_END } from './constants.js';
import { setStatus, clearStatus } from './status.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b2b33);

export const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 800);
camera.position.set(0, 30, 30);

// Ограничение pixelRatio: на HiDPI-мониторах рендер в 3-4x пикселей вместе
// с теневой картой 2048x2048 просаживает FPS без видимого выигрыша.
const pixelRatio = () => Math.min(devicePixelRatio, 2);

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(pixelRatio());
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.8));

// Направление на солнце из Godot world.gd: DirectionalLight3D rotation
// (-42, -36, 0) (порядок YXZ), свет светит вдоль локального -Z, а +Z —
// обратно к солнцу: sun_direction = basis.z = (-0.437, 0.669, 0.601).
// Энергия 2.2 и ambient 0.85 в оригинале, но здесь остаются прежними,
// чтобы не менять яркость уже отстроенной сцены.
export const SUN_DIRECTION = new THREE.Vector3(-0.437, 0.669, 0.601);

export const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.copy(SUN_DIRECTION).multiplyScalar(35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 100;
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 20;
sun.shadow.camera.bottom = -20;
sun.shadow.bias = -0.0005;
scene.add(sun);
scene.add(sun.target);

// --- Небо: встроенный шейдер Godot ProceduralSkyMaterial 4.7.1
// (scene/resources/3d/sky_material.cpp), параметры из world.gd _build_blue_sky.
// Цвета заданы линейными, как в Godot; сцена рендерится в линейное
// пространство, поэтому прямо в шейдере применён AGX-тонмаппинг Godot 4.6
// (tonemap_inc.glsl), а sRGB-кодирование даёт панини-проход.
const SKY = {
  top: new THREE.Color(0.18, 0.42, 0.95),
  horizon: new THREE.Color(0.54, 0.76, 1.0),
  curve: 0.08,
  energy: 1.15,                    // sky_energy_multiplier
  ground: new THREE.Color(0.62, 0.66, 0.70),
  groundHorizon: new THREE.Color(0.54, 0.76, 1.0),  // задан в world.gd
  groundCurve: 0.02,
};
// Солнце в небе (LIGHT0 шейдера): DirectionalLight3D из world.gd — energy 2.2,
// angular_distance 0 (диск-точка), sun_angle_max по умолчанию 30°,
// inv_sun_curve = 1.6/pow(0.15, 1.4) (set_sun_curve из sky_material.cpp).
const SUN_SKY = {
  color: new THREE.Color(1, 1, 1),
  energy: 2.2,
  size: 0.0,                                          // rad, light_angular_distance
  angleMax: Math.cos(30 * Math.PI / 180),             // 0.8660254
  invCurve: 1.6 / Math.pow(0.15, 1.4),                // 22.78
};
// Параметры allenwp-кривой AGX, считаются как в environment_storage.cpp
// (SDR: output_max_value=1, white=MAX(2, 10)=10, contrast=1).
const AGX_CROSSOVER = 0.18;
const AGX_SHOULDER_MAX = 1.0 - AGX_CROSSOVER;
const AGX_TOE_A = ((1.0 / AGX_CROSSOVER) - 1.0) * Math.pow(AGX_CROSSOVER, 1.0);
const AGX_SLOPE_DENOM = AGX_CROSSOVER + AGX_TOE_A;
const AGX_SLOPE = (1.0 * Math.pow(AGX_CROSSOVER, 0.0) * AGX_TOE_A) / (AGX_SLOPE_DENOM * AGX_SLOPE_DENOM);
const AGX_W = Math.pow(10.0 - AGX_CROSSOVER, 2) / AGX_SHOULDER_MAX * AGX_SLOPE;

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  uniforms: {
    uTop: { value: SKY.top.clone().multiplyScalar(SKY.energy) },
    uHorizon: { value: SKY.horizon.clone().multiplyScalar(SKY.energy) },
    uInvSkyCurve: { value: 0.6 / SKY.curve },
    uGround: { value: SKY.ground },
    uGroundHorizon: { value: SKY.groundHorizon },
    uInvGroundCurve: { value: 0.6 / SKY.groundCurve },
    uSunDir: { value: SUN_DIRECTION },
    uSunColor: { value: SUN_SKY.color },
    uSunEnergy: { value: SUN_SKY.energy },
    uSunSize: { value: Math.cos(SUN_SKY.size) },
    uSunAngleMax: { value: SUN_SKY.angleMax },
    uInvSunCurve: { value: SUN_SKY.invCurve },
    uToeA: { value: AGX_TOE_A },
    uSlope: { value: AGX_SLOPE },
    uW: { value: AGX_W },
    uAspect: { value: camera.aspect },
    uFovY: { value: 60.0 },
    uSize: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uTop;
    uniform vec3 uHorizon;
    uniform float uInvSkyCurve;
    uniform vec3 uGround;
    uniform vec3 uGroundHorizon;
    uniform float uInvGroundCurve;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform float uSunEnergy;
    uniform float uSunSize;
    uniform float uSunAngleMax;
    uniform float uInvSunCurve;
    uniform float uToeA;
    uniform float uSlope;
    uniform float uW;
    uniform float uAspect;
    uniform float uFovY;
    uniform vec2 uSize;

    // allenwp-кривая AGX из Godot tonemap_inc.glsl (contrast = 1.0).
    vec3 agxAllenwp(vec3 x) {
      float crossover = 0.18;
      float shoulderMax = 1.0 - crossover;
      vec3 s = x - crossover;
      vec3 slopeS = uSlope * s;
      s = slopeS * (1.0 + s / uW) / (1.0 + slopeS / shoulderMax);
      s += crossover;
      vec3 t = x / (x + uToeA);
      return mix(s, t, lessThan(x, vec3(crossover)));
    }

    void main() {
      // Направление луча считаем попиксельно из камеры (как sky-шейдер в Godot):
      // gl_FragCoord даёт позицию фрагмента в RenderTarget, а не UV купола.
      float tanHalf = tan(radians(uFovY) * 0.5);
      vec2 fragUV = gl_FragCoord.xy / uSize;
      vec3 dirCam = normalize(vec3((fragUV.x * 2.0 - 1.0) * tanHalf * uAspect,
                                   (fragUV.y * 2.0 - 1.0) * tanHalf, -1.0));
      // Мировое направление: транспонированная часть поворота viewMatrix.
      // GLSL m[i][j] = элемент (строка j, столбец i), поэтому для (m^T * d)
      // индексы столбцов идут по строкам.
      mat3 m = mat3(viewMatrix);
      vec3 dir = normalize(vec3(
        m[0][0] * dirCam.x + m[0][1] * dirCam.y + m[0][2] * dirCam.z,
        m[1][0] * dirCam.x + m[1][1] * dirCam.y + m[1][2] * dirCam.z,
        m[2][0] * dirCam.x + m[2][1] * dirCam.y + m[2][2] * dirCam.z));

      // Godot ProceduralSkyMaterial 4.7.1, sky(): небо/земля через
      // inv_curve = 0.6/curve, энергия вшита в цвета, солнце (LIGHT0) —
      // диск-точка (size=0) с ореолом до sun_angle_max.
      float v = clamp(dir.y, -1.0, 1.0);
      vec3 sky = mix(uTop, uHorizon, clamp(pow(1.0 - v, uInvSkyCurve), 0.0, 1.0));
      float sunAngle = dot(uSunDir, dir);
      if (sunAngle > uSunSize) {
        sky = uSunColor * uSunEnergy;
      } else if (sunAngle > uSunAngleMax) {
        float c2 = (uSunSize - sunAngle) / (uSunSize - uSunAngleMax);
        sky = mix(sky, uSunColor * uSunEnergy, clamp(pow(1.0 - c2, uInvSunCurve), 0.0, 1.0));
      }
      vec3 ground = mix(uGround, uGroundHorizon, clamp(pow(1.0 + v, uInvGroundCurve), 0.0, 1.0));
      vec3 color = mix(ground, sky, step(0.0, dir.y));
      color = max(color, 0.0);   // AGX требует неотрицательный вход
      // Godot 4.6 tonemap_agx: inset -> кривая -> clamp -> outset.
      const mat3 inset = mat3(
        0.544814746488245, 0.140416948464053, 0.0888104196149096,
        0.373787398372697, 0.754137554567394, 0.178871756420858,
        0.0813978551390581, 0.105445496968552, 0.732317823964232);
      const mat3 outset = mat3(
        1.96488741169489, -0.299313364904742, -0.164352742528393,
        -0.855988495690215, 1.32639796461980, -0.238183969428088,
        -0.108898916004672, -0.0270845997150571, 1.40253671195648);
      color = inset * color;
      color = agxAllenwp(color);
      color = min(vec3(1.0), color);
      color = outset * color;
      gl_FragColor = vec4(color, 1.0);
    }
  `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), skyMat);
skyDome.frustumCulled = false;
skyDome.renderOrder = -10;   // рисуется первым, под всеми объектами
scene.add(skyDome);

// Размер drawing buffer (пиксели с учётом pixelRatio) — для gl_FragCoord.
const skySize = new THREE.Vector2();
const updateSkySize = () => {
  renderer.getDrawingBufferSize(skySize);
  skyMat.uniforms.uSize.value.copy(skySize);
};
updateSkySize();

const groundMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uCenter: { value: new THREE.Vector2(0, 0) },
    uFadeStart: { value: FADE_START },
    uFadeEnd: { value: FADE_END },
    uMinor: { value: new THREE.Color(0x9a9a9a) },
    uMajor: { value: new THREE.Color(0x4d4d4d) },
  },
  vertexShader: `
    varying vec4 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    uniform vec2 uCenter;
    uniform float uFadeStart;
    uniform float uFadeEnd;
    uniform vec3 uMinor;
    uniform vec3 uMajor;
    varying vec4 vWorldPos;

    float distToLine(vec2 p, float step) {
      vec2 f = fract(p / step);
      vec2 g = 0.5 - abs(f - 0.5);          // 0 на линии, 0.5 между линиями
      vec2 fw = fwidth(p / step);
      vec2 l = 1.0 - smoothstep(vec2(0.0), fw, g);
      return max(l.x, l.y);
    }

    void main() {
      vec2 coord = vWorldPos.xz;
      float minor = distToLine(coord, ${CELL.toFixed(1)});  // клетки
      float major = distToLine(coord, ${MAJOR.toFixed(1)}); // крупные линии

      vec3 color = mix(vec3(0.96), uMajor, major);        // белый пол + тёмные линии
      color = mix(color, uMinor, minor * (1.0 - major));  // + серые линии

      float dist = distance(coord, uCenter);
      float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
      gl_FragColor = vec4(color, fade);
    }
  `,
});

const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), groundMat);
ground.rotation.x = -Math.PI / 2;
// Обе плоскости прозрачные и лежат в 2 мм друг от друга: без явного порядка
// отрисовки сортировка по расстоянию даёт мерцание на пологих углах.
ground.renderOrder = 0;
scene.add(ground);

// Прозрачная плоскость принимает настоящую тень поверх процедурной сетки.
const shadowGround = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
  new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.32 })
);
shadowGround.rotation.x = -Math.PI / 2;
shadowGround.position.y = 0.002;
shadowGround.receiveShadow = true;
shadowGround.renderOrder = 1;
scene.add(shadowGround);

/** Земля центрируется на камере; округление до клетки держит линии на целых координатах. */
export function updateGround() {
  ground.position.x = Math.round(camera.position.x / CELL) * CELL;
  ground.position.z = Math.round(camera.position.z / CELL) * CELL;
  shadowGround.position.x = ground.position.x;
  shadowGround.position.z = ground.position.z;
  groundMat.uniforms.uCenter.value.set(ground.position.x, ground.position.z);
  // Купол неба всегда вокруг камеры: он не должен упираться в far-плоскость,
  // когда камера улетает далеко от начала координат.
  skyDome.position.copy(camera.position);
}

/** Свет и его теневая камера следуют за целью в безграничном мире. */
export function updateSun(target) {
  sun.position.set(
    target.x + SUN_DIRECTION.x * 35,
    target.y + SUN_DIRECTION.y * 35,
    target.z + SUN_DIRECTION.z * 35
  );
  sun.target.position.copy(target);
  sun.target.updateMatrixWorld();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  skyMat.uniforms.uAspect.value = camera.aspect;
  updateSkySize();
  renderer.setPixelRatio(pixelRatio()); // окно могли перетащить на другой монитор
  renderer.setSize(innerWidth, innerHeight);
});

// Потеря контекста (спящий режим, переключение GPU, сброс драйвера) без этого
// оставляет чёрный canvas без единого сообщения.
renderer.domElement.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  setStatus('Контекст WebGL потерян — ожидаю восстановления…');
});
renderer.domElement.addEventListener('webglcontextrestored', () => clearStatus());
