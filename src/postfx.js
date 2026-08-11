// Пост-обработка первого лица: сцена рендерится в текстуру, затем фуллскрин-квад
// накладывает панини-проекцию из Godot `SHOOTER/shaders/panini.gdshader`
// (широкий FOV без «растяга» краёв) плюс хроматическую аберрацию и виньетку.
import * as THREE from 'three';
import { scene, camera, renderer, SUN_DIRECTION } from './scene.js';

export const FOV_DEGREES = 60.0;

camera.fov = FOV_DEGREES;   // вертикальный FOV, как camera.fov в original
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

// --- Блик солнца: экранный оверлей из Godot sun_glare.gd. Рисуется поверх
// панини-кадра аддитивно в экранном пространстве (как Control в оригинале):
// проекция точки солнца обычной камерой, яркость зависит от совпадения
// взгляда с солнцем, выхода за край экрана и заслона корпусом самолёта.
const SUN_DISTANCE = 2000.0;
const ALIGNMENT_START = 0.58;
const SCREEN_EDGE_FADE = 1.35;

const glareUniforms = {
  uSize: { value: new THREE.Vector2(1, 1) },
  uSun: { value: new THREE.Vector2(0, 0) },
  uIntensity: { value: 0 },
  uTime: { value: 0 },
};

const glareFragmentShader = `
uniform vec2 uSize;
uniform vec2 uSun;
uniform float uIntensity;
uniform float uTime;
varying vec2 vUv;

const vec3 CORE = vec3(1.0, 0.95, 0.72);
const vec3 WARM = vec3(1.0, 0.70, 0.33);
const vec3 RING = vec3(1.0, 0.82, 0.46);

vec3 srgbEncode(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// _draw_soft_circle: 12 вложенных кругов, альфа каждого 0.48*(1-(i/12)^2).
float softCircle(vec2 g, vec2 p, float R, float alpha) {
  float rn = length(g - p) / max(R, 1e-4);
  float i = clamp(ceil(rn * 12.0), 1.0, 12.0);
  float falloff = (i / 12.0) * (i / 12.0);
  return alpha * 0.48 * (1.0 - falloff);
}

float disc(vec2 g, vec2 p, float R, float alpha) {
  float rn = length(g - p) / max(R, 1e-4);
  return alpha * (1.0 - smoothstep(0.9, 1.0, rn));
}

float hline(vec2 g, vec2 c, float len, float w, float alpha) {
  float halfW = w * 0.5;
  float band = smoothstep(halfW + 1.0, halfW, abs(g.y - c.y));
  band *= smoothstep(len + 1.0, len, abs(g.x - c.x));
  return alpha * band;
}

float vline(vec2 g, vec2 c, float len, float w, float alpha) {
  float halfW = w * 0.5;
  float band = smoothstep(halfW + 1.0, halfW, abs(g.x - c.x));
  band *= smoothstep(len + 1.0, len, abs(g.y - c.y));
  return alpha * band;
}

// _draw_ring: полилиния с волнистостью 1 + sin(3a)*0.025, ширина max(R*0.06, 1).
float ring(vec2 g, vec2 c, float R, float w, float alpha) {
  float d = length(g - c);
  float a = atan(g.y - c.y, g.x - c.x);
  float Reff = R * (1.0 + 0.025 * sin(a * 3.0));
  return alpha * (1.0 - smoothstep(w * 0.5, w * 0.5 + 1.0, abs(d - Reff)));
}

void main() {
  // Экранные пиксели с y вниз — как size/position у Godot Control.
  vec2 g = vec2(vUv.x * uSize.x, (1.0 - vUv.y) * uSize.y);
  if (uIntensity <= 0.003) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float base = min(uSize.x, uSize.y);
  float pulse = 0.96 + sin(uTime * 1.7) * 0.04;
  float intensity = uIntensity * pulse;
  vec2 p = uSun;

  vec3 acc = vec3(0.0);
  acc += CORE * softCircle(g, p, base * 0.24, 0.060 * intensity);
  acc += WARM * softCircle(g, p, base * 0.11, 0.110 * intensity);
  acc += vec3(1.0) * disc(g, p, base * 0.013, 0.75 * intensity);

  float short_ = base * 0.18;
  float long_ = base * 0.32;
  float w = max(base * 0.0045, 1.0);
  acc += CORE * hline(g, p, long_, w * 1.2, 0.10 * intensity);
  acc += CORE * vline(g, p, long_, w, 0.08 * intensity);
  acc += WARM * hline(g, vec2(p.x, p.y + short_ * 0.20), short_, w, 0.06 * intensity);
  acc += WARM * hline(g, vec2(p.x, p.y - short_ * 0.20), short_, w, 0.06 * intensity);

  acc += RING * ring(g, p, base * 0.090, max(base * 0.090 * 0.06, 1.0), 0.08 * intensity);
  acc += WARM * ring(g, p + vec2(base * 0.08, base * 0.03), base * 0.045, max(base * 0.045 * 0.06, 1.0), 0.050 * intensity);
  acc += CORE * ring(g, p - vec2(base * 0.11, base * 0.04), base * 0.032, max(base * 0.032 * 0.06, 1.0), 0.034 * intensity);

  // 2D в Godot рисуется в линейном и кодируется в sRGB на выходе.
  gl_FragColor = vec4(srgbEncode(acc), 1.0);
}
`;

const glareMaterial = new THREE.ShaderMaterial({
  uniforms: glareUniforms,
  vertexShader: paniniVertexShader,
  fragmentShader: glareFragmentShader,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
});
const glareQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glareMaterial);
glareQuad.frustumCulled = false;
glareQuad.renderOrder = 1;   // поверх панини-квада
fxScene.add(glareQuad);

// Объект с публичным списком solidMeshes (самолёт) — по ним рейкаст заслона.
let occluderHost = null;
export function setGlareOccluders(host) {
  occluderHost = host;
}

const sunWorld = new THREE.Vector3();
const camForward = new THREE.Vector3();
const sunView = new THREE.Vector3();
const sunRay = new THREE.Raycaster();
let glareIntensity = 0;
let glareLastMs = performance.now();

/** Заслон солнца: луч из глаз к солнцу, как _is_sun_occluded (маска 1|2). */
function sunOccluded(dir) {
  const meshes = occluderHost?.solidMeshes;
  if (!meshes || meshes.length === 0) return false;
  sunRay.set(
    sunView.copy(camera.position).addScaledVector(dir, 0.12),
    dir
  );
  sunRay.far = SUN_DISTANCE;
  return sunRay.intersectObjects(meshes, false).length > 0;
}

function updateGlare(dt) {
  glareUniforms.uTime.value = performance.now() / 1000;
  const dir = SUN_DIRECTION;
  // camera.updateMatrixWorld обновляет matrixWorld, но не matrixWorldInverse —
  // инвертируем сами, чтобы проекция солнца была точной.
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

  camera.getWorldDirection(camForward);
  const alignment = camForward.dot(dir);
  const facing = THREE.MathUtils.clamp(
    (alignment - ALIGNMENT_START) / (1.0 - ALIGNMENT_START), 0, 1
  );

  let target = 0;
  if (facing > 0 && !sunOccluded(dir)) {
    sunWorld.copy(camera.position).addScaledVector(dir, SUN_DISTANCE);
    sunWorld.project(camera);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // Экранные пиксели с y вниз (как в Godot unproject_position -> Control).
    const sx = (sunWorld.x * 0.5 + 0.5) * size.x;
    const sy = (1.0 - (sunWorld.y * 0.5 + 0.5)) * size.y;
    const nx = sx / Math.max(size.x, 1) * 2 - 1;
    const ny = sy / Math.max(size.y, 1) * 2 - 1;
    const extent = Math.max(Math.abs(nx), Math.abs(ny));
    const edgeFade = THREE.MathUtils.clamp(
      (SCREEN_EDGE_FADE - extent) / (SCREEN_EDGE_FADE - 0.78), 0, 1
    );
    target = Math.pow(facing, 1.55) * edgeFade;
    glareUniforms.uSun.value.set(sx, sy);
  }

  glareIntensity += (target - glareIntensity) * (1.0 - Math.exp(-7.0 * dt));
  glareUniforms.uIntensity.value = glareIntensity;
}

function resize() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  postTarget.setSize(size.x, size.y);
  paniniUniforms.render_size.value.set(postTarget.width, postTarget.height);
  glareUniforms.uSize.value.set(size.x, size.y);
}
addEventListener('resize', resize);
resize();

/** Рендер сцены с панини-пройекцией и бликом солнца — вместо renderer.render. */
export function renderFrame() {
  const now = performance.now();
  updateGlare(Math.min((now - glareLastMs) / 1000, 0.05));
  glareLastMs = now;

  renderer.setRenderTarget(postTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  paniniUniforms.tDiffuse.value = postTarget.texture;
  renderer.render(fxScene, fxCamera);
}