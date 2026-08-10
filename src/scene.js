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

export const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(30, 50, 20);
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
}

/** Свет и его теневая камера следуют за целью в безграничном мире. */
export function updateSun(target) {
  sun.position.set(target.x + 20, target.y + 35, target.z + 15);
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
