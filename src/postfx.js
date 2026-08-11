// Пост-обработка первого лица: сцена рендерится в текстуру, затем фуллскрин-квад
// накладывает панини-проекцию из Godot `SHOOTER/shaders/panini.gdshader`
// (широкий FOV без «растяга» краёв) плюс хроматическую аберрацию и виньетку.
import * as THREE from 'three';
import { scene, camera, renderer, SUN_DIRECTION, skyMat } from './scene.js';

export const FOV_DEGREES = 60.0;

camera.fov = FOV_DEGREES;   // вертикальный FOV
camera.updateProjectionMatrix();

const paniniUniforms = {
  tDiffuse: { value: null },
  render_size: { value: new THREE.Vector2(1, 1) },
  panini_distance: { value: 1.15 },
  // 0.535: при 0.28 углы экрана выходили за границы текстуры (uv.y≈1.136) и края
  // сжимались клампом — то, что раньше прятала тёмная рамка. 0.535 вписывает
  // панини-плоскость ровно в кадр: верх/низ без растяга и без обрезки.
  vertical_squeeze: { value: 0.535 },
  camera_fov_y_degrees: { value: FOV_DEGREES },
  // Солнце рисуется в пост-процессинге мягким диском: координаты солнца
  // в панини-плоскости (h, v) и видимость (солнце впереди камеры).
  uSunPanini: { value: new THREE.Vector2(100, 100) },
  uSunVisible: { value: 0 },
  uSunRadiusDeg: { value: 1.7 },
};

const paniniVertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const paniniFragmentShader = `
uniform sampler2D tDiffuse;
uniform vec2 render_size;
uniform float panini_distance;
uniform float vertical_squeeze;
uniform float camera_fov_y_degrees;
uniform vec2 uSunPanini;
uniform float uSunVisible;
uniform float uSunRadiusDeg;
varying vec2 vUv;

float panini_forward_x(float phi, float d) {
  return ((d + 1.0) * sin(phi)) / max(d + cos(phi), 0.0001);
}

float inverse_panini_phi(float h, float d) {
  if (abs(h) < 0.00001) {
    return 0.0;
  }
  if (abs(d - 1.0) < 0.0001) {
    return 2.0 * atan(h * 0.5);
  }
  float root_argument = max((d + 1.0) * ((d + 1.0) - (d - 1.0) * h * h), 0.0);
  float t = ((d + 1.0) - sqrt(root_argument)) / ((d - 1.0) * h);
  return 2.0 * atan(t);
}

void main() {
  float aspect = render_size.x / max(render_size.y, 1.0);
  float max_v = tan(radians(camera_fov_y_degrees) * 0.5);
  float max_h = max_v * aspect;

  float d = max(panini_distance, 0.0);
  float half_phi = atan(max_h);
  float panini_half_h = panini_forward_x(half_phi, d);

  vec2 ndc = vec2(vUv.x * 2.0 - 1.0, vUv.y * 2.0 - 1.0);
  vec2 panini_plane = vec2(ndc.x * panini_half_h, ndc.y * max_v);

  float phi = inverse_panini_phi(panini_plane.x, d);
  float cos_phi = max(cos(phi), 0.025);
  float scale = (d + 1.0) / max(d + cos_phi, 0.0001);
  float theta = atan(panini_plane.y / scale);

  float src_x = tan(phi);
  float vertical_denominator = mix(cos_phi, 1.0, vertical_squeeze);
  float src_y = tan(theta) / vertical_denominator;
  // Нижний левый угол текстуры — (0,0), поэтому y растёт вверх (отражение
  // Godot-овского UV.y=0 сверху).
  vec2 source_uv = vec2(0.5 + 0.5 * (src_x / max_h), 0.5 + 0.5 * (src_y / max_v));

  vec2 clamped_uv = clamp(source_uv, vec2(0.001), vec2(0.999));
  vec4 color = texture2D(tDiffuse, clamped_uv);

  // Солнце: мягкий тёплый диск в панини-плоскости (на сетке купола оно
  // алиасится — «белая дыра»). Радиус в тех же единицах, что и uSunPanini.
  // Плюс две широкие тёплые дымки: возвращают «закатный» характер (у низкого
  // солнца вокруг диска должна быть золотистая дымка, а не холодная синева).
  vec2 sun_delta = panini_plane - uSunPanini;
  float sun_dist = length(sun_delta);
  float sun_r = panini_forward_x(radians(uSunRadiusDeg), d);
  float sun_glow = exp(-pow(sun_dist / sun_r, 2.0));
  float sun_halo = exp(-pow(sun_dist / (sun_r * 2.6), 2.0));
  float sun_warm = exp(-pow(sun_dist / (sun_r * 3.5), 2.0));
  float sun_tint = exp(-pow(sun_dist / (sun_r * 8.0), 2.0));
  vec3 sun_color = vec3(1.0, 0.94, 0.82);
  vec3 warm_color = vec3(1.0, 0.88, 0.68);
  color.rgb += (sun_color * sun_glow + sun_color * sun_halo * 0.30
              + warm_color * sun_warm * 0.28 + warm_color * sun_tint * 0.10) * uSunVisible;

  gl_FragColor = vec4(color.rgb, 1.0);
  // Сцена рендерится в RenderTarget в линейном пространстве; кастомный шейдер
  // без этого чука не переводит результат обратно в sRGB — картинка темнеет.
  #include <colorspace_fragment>
}
`;

const paniniMaterial = new THREE.ShaderMaterial({
  uniforms: paniniUniforms,
  vertexShader: paniniVertexShader,
  fragmentShader: paniniFragmentShader,
  depthTest: false,
  depthWrite: false,
});

const fxScene = new THREE.Scene();
// Камера смотрит по −Z из точки +1; PlaneGeometry нормалью +Z развёрнута к ней
// лицевой стороной, квад закрывает весь экран в границах (−1..1).
const fxCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 1.5);
fxCamera.position.z = 1;
const fxQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), paniniMaterial);
fxQuad.frustumCulled = false;
fxScene.add(fxQuad);

export const postTarget = new THREE.WebGLRenderTarget(1, 1, {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
});
// Сглаживание на промежуточной текстуре: обычный враппер с antialias не даёт
// MSAA при рендере в RenderTarget (в Godot это INTERNAL_RENDER_SCALE 1.5).
postTarget.samples = 4;

const camForward = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const sunViewDir = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
let sunFovAmount = 0;

// Окклюзия: если между камерой и солнцем есть объект (самолёт), диск
// не рисуется — иначе глоу ложится поверх тёмных частей модели («белая дыра»).
const occluderRay = new THREE.Raycaster();
const occluderDir = new THREE.Vector3();
let occluders = null;
function getOccluders() {
  if (!occluders) {
    occluders = [];
    scene.traverse(o => {
      if (o.isMesh && o.material !== skyMat && o.visible) occluders.push(o);
    });
  }
  return occluders;
}
function isSunOccluded() {
  occluderDir.copy(SUN_DIRECTION);
  occluderRay.set(camera.position, occluderDir);
  occluderRay.near = 0.6; // пропустить тело персонажа вокруг камеры
  occluderRay.far = 700;
  return occluderRay.intersectObjects(getOccluders(), false).length > 0;
}

// Мировое направление солнца → координаты (h, v) в панини-плоскости,
// чтобы диск совпал с позицией солнца на небе при любой ориентации камеры.
function updateSunScreen() {
  tmpQuat.copy(camera.quaternion).invert();
  sunViewDir.copy(SUN_DIRECTION).applyQuaternion(tmpQuat);
  const d = paniniUniforms.panini_distance.value;
  const phi = Math.atan2(sunViewDir.x, -sunViewDir.z);
  const theta = Math.atan2(sunViewDir.y, Math.hypot(sunViewDir.x, sunViewDir.z));
  const cosPhi = Math.cos(phi);
  const scale = (d + 1.0) / (d + cosPhi);
  const h = (d + 1.0) * Math.sin(phi) / (d + cosPhi);
  const v = scale * Math.tan(theta);
  paniniUniforms.uSunPanini.value.set(h, v);
  paniniUniforms.uSunVisible.value = (sunViewDir.z < 0 && !isSunOccluded()) ? 1 : 0;
}

// Взгляд на солнце плавно расширяет FOV (как 60 → 67): небо с солнцем
// разворачивается на большем угле, а сама сцена остаётся прежней.
const FOV_BASE = FOV_DEGREES;
const FOV_MAX = 67.0;
const FOV_ALIGNMENT_START = 0.55;

function updateSunFov(dt) {
  camera.getWorldDirection(camForward);
  const alignment = camForward.dot(SUN_DIRECTION);
  const target = THREE.MathUtils.clamp(
    (alignment - FOV_ALIGNMENT_START) / (1.0 - FOV_ALIGNMENT_START), 0, 1
  );
  sunFovAmount += (target - sunFovAmount) * (1.0 - Math.exp(-7.0 * dt));
  const fov = FOV_BASE + (FOV_MAX - FOV_BASE) * sunFovAmount;
  if (Math.abs(camera.fov - fov) > 0.001) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    paniniUniforms.camera_fov_y_degrees.value = fov;
  }
}

function resize() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  postTarget.setSize(size.x, size.y);
  paniniUniforms.render_size.value.set(postTarget.width, postTarget.height);
}
addEventListener('resize', resize);
resize();

/** Рендер сцены с панини-проекцией — вместо renderer.render. */
export function renderFrame() {
  const now = performance.now();
  updateSunFov(Math.min((now - lastMs) / 1000, 0.05));
  updateSunScreen();
  lastMs = now;

  renderer.setRenderTarget(postTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  paniniUniforms.tDiffuse.value = postTarget.texture;
  renderer.render(fxScene, fxCamera);
}
let lastMs = performance.now();