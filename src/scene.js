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

// Направление на солнце — как в демо (drei Sky azimuth=1, inclination=0.6):
// sunPosition = (cos(phi), sin(theta), sin(phi)), theta=0.1*PI, phi=PI →
// (-1, 0.309, 0), нормализовано. Светит низко над горизонтом (el ~17°),
// как на thumbnail демо.
// Нормализованное направление демо-солнца (-1, 0.309, 0) / 1.0466
export const SUN_DIRECTION = new THREE.Vector3(-0.9554, 0.2952, 0);

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

// --- Небо: three.js SkyShader (examples/jsm/objects/Sky.js, r139) — тот же,
// что рендерит drei <Sky> в демо. Параметры демо: azimuth=1, inclination=0.6,
// rayleigh=0.5, turbidity=10, mieCoefficient=0.005, mieDirectionalG=0.8.
// Выход шейдера — линейный, как в демо (без тонмаппинга); sRGB-кодирование
// даёт панини-проход.
// g=0.8 давал слишком широкое белое пятно вокруг солнца («белая дыра» при
// взгляде на него); 0.55 оставляет заметное свечение, но не выжигает небо.
// g/mie: широкий хвост HG-фазы выжигал небо на 30-40° вокруг солнца в серо-белый
// («белая дыра»). Мия почти убрана (0.0001, g=0.5) — небо остаётся релеевским
// голубым, а белый диск и тёплый ореол рисует пост-процессинг (postfx.js).
const SKY = {
  rayleigh: 0.5,
  turbidity: 10,
  mieCoefficient: 0.0001,
  mieDirectionalG: 0.5,
};

export const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  uniforms: {
    uRayleigh: { value: SKY.rayleigh },
    uTurbidity: { value: SKY.turbidity },
    uMieCoefficient: { value: SKY.mieCoefficient },
    uMieDirectionalG: { value: SKY.mieDirectionalG },
    uSunDirection: { value: SUN_DIRECTION },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uCameraPos: { value: camera.position },
    uExposure: { value: 0.9 },   // 1.5 выжигал небо у солнца и у горизонта в белый
    // (HDR-значения >1.0 после sRGB-кодирования); 0.9 держит солнце белым,
    // а небо вокруг — голубым (0.8 оказался слишком «вечерним»)
    uKnee: { value: 1.5 },   // мягкое колено на яркость: прижимает белую полосу
    // у горизонта и ореол под солнцем, не трогая голубое небо (0 = выкл)
  },
  vertexShader: `
    uniform vec3 uSunDirection;
    uniform float uRayleigh;
    uniform float uTurbidity;
    uniform float uMieCoefficient;
    varying vec3 vWorldPosition;
    varying vec3 vSunDirection;
    varying float vSunfade;
    varying vec3 vBetaR;
    varying vec3 vBetaM;
    varying float vSunE;

    const float e = 2.71828182845904523536028747135266249775724709369995957;
    const float pi = 3.141592653589793238462643383279502884197169;

    const vec3 lambda = vec3(680E-9, 550E-9, 450E-9);
    const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);

    const float v = 4.0;
    const vec3 K = vec3(0.686, 0.678, 0.666);
    const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);

    const float cutoffAngle = 1.6110731556870734;
    const float steepness = 1.5;
    // EE=1000 держит небо ярким по всей сфере; «белую дыру» лечит не снижение
    // яркости, а сужение вперёд-конуса мии (uMieDirectionalG=0.6): белым
    // остаётся только диск солнца и узкое свечение вокруг него.
    const float EE = 1000.0;

    float sunIntensity(float zenithAngleCos) {
      zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
      return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
    }

    vec3 totalMie(float T) {
      float c = (0.2 * T) * 10E-18;
      return 0.434 * c * MieConst;
    }

    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position.z = gl_Position.w;

      vSunDirection = normalize(uSunDirection);
      vSunE = sunIntensity(dot(vSunDirection, vec3(0.0, 1.0, 0.0)));
      vSunfade = 1.0 - clamp(1.0 - exp((uSunDirection.y / 450000.0)), 0.0, 1.0);

      float rayleighCoefficient = uRayleigh - (1.0 * (1.0 - vSunfade));
      vBetaR = totalRayleigh * rayleighCoefficient;
      vBetaM = totalMie(uTurbidity) * uMieCoefficient;
    }
  `,
  fragmentShader: `
    varying vec3 vWorldPosition;
    varying vec3 vSunDirection;
    varying float vSunfade;
    varying vec3 vBetaR;
    varying vec3 vBetaM;
    varying float vSunE;

    uniform float uMieDirectionalG;
    uniform vec3 uCameraPos;
    uniform float uExposure;
    uniform float uKnee;

    const float pi = 3.141592653589793238462643383279502884197169;

    const float n = 1.0003;
    const float N = 2.545E25;

    const float rayleighZenithLength = 8.4E3;
    const float mieZenithLength = 1.25E3;
    const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

    const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
    const float ONE_OVER_FOURPI = 0.07957747154594767;

    float rayleighPhase(float cosTheta) {
      return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0));
    }

    float hgPhase(float cosTheta, float g) {
      float g2 = pow(g, 2.0);
      float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
      return ONE_OVER_FOURPI * ((1.0 - g2) * inverse);
    }

    void main() {
      vec3 direction = normalize(vWorldPosition - uCameraPos);

      // optical length
      // cutoff angle at 90 to avoid singularity in next formula.
      float zenithAngle = acos(max(0.0, dot(vec3(0.0, 1.0, 0.0), direction)));
      float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
      float sR = rayleighZenithLength * inverse;
      float sM = mieZenithLength * inverse;

      // combined extinction factor
      vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));

      // in scattering
      float cosTheta = dot(direction, vSunDirection);

      float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
      vec3 betaRTheta = vBetaR * rPhase;

      float mPhase = hgPhase(cosTheta, uMieDirectionalG);
      vec3 betaMTheta = vBetaM * mPhase;

      vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
      Lin *= mix(vec3(1.0), pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(1.0 / 2.0)), clamp(pow(1.0 - dot(vec3(0.0, 1.0, 0.0), vSunDirection), 5.0), 0.0, 1.0));

      // nightsky
      float theta = acos(direction.y);
      float phi = atan(direction.z, direction.x);
      vec2 uv = vec2(phi, theta) / vec2(2.0 * pi, pi) + vec2(0.5, 0.0);
      vec3 L0 = vec3(0.1) * Fex;

      // composition: солнечный диск рисуется в пост-процессинге (postfx.js) —
      // на сетке купола диск алиасится в мозаику («белая дыра»).

      vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);

      vec3 retColor = pow(texColor, vec3(1.0 / (1.2 + (1.2 * vSunfade))));

      // Как в демо: SkyShader без тонмаппинга, sRGB-кодирование — в панини-проходе.
      // Мягкое колено (по яркости, оттенок сохраняется): значения выше 0.55
      // линейно сжимаются — белая полоса у горизонта и дымка под солнцем
      // перестают выжигать небо, голубое небо почти не меняется.
      vec3 col = max(retColor, 0.0) * uExposure;

      // turbidity=10 даёт SkyShader'у известный бирюзово-зелёный подмес
      // (зелёный канал g/b≈0.82 вместо ~0.65 у чистого голубого неба).
      // Для небесных тонов (синий доминирует) поднимаем синий и давим
      // зелёный — оттенок становится чище, солнце и горизонт не трогаем.
      float blueAmt = clamp((col.b - col.r) * 2.0, 0.0, 1.0);
      col.rgb = mix(col.rgb, col.rgb * vec3(0.94, 0.86, 1.14), blueAmt);
      if (uKnee > 0.0) {
        float L = dot(col, vec3(0.299, 0.587, 0.114));
        float C = L / (1.0 + max(L - 0.55, 0.0) * uKnee);
        col *= (C / max(L, 0.0001));
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), skyMat);
skyDome.frustumCulled = false;
skyDome.renderOrder = -10;   // рисуется первым, под всеми объектами
scene.add(skyDome);

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
  skyMat.uniforms.uCameraPos.value.copy(camera.position);
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
