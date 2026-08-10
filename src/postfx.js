// Пост-обработка первого лица: сцена рендерится в текстуру, затем фуллскрин-квад
// накладывает панини-проекцию из Godot `SHOOTER/shaders/panini.gdshader`
// (широкий FOV без «растяга» краёв) плюс хроматическую аберрацию и виньетку.
import * as THREE from 'three';
import { scene, camera, renderer } from './scene.js';

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

function resize() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  postTarget.setSize(size.x, size.y);
  paniniUniforms.render_size.value.set(postTarget.width, postTarget.height);
}
addEventListener('resize', resize);
resize();

/** Рендер сцены с панини-пройекцией — вызывается вместо renderer.render. */
export function renderFrame() {
  renderer.setRenderTarget(postTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  paniniUniforms.tDiffuse.value = postTarget.texture;
  renderer.render(fxScene, fxCamera);
}