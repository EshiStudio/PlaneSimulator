// Клавиатура и мышь. Камера — только мышью и Q/E, самолёт — стрелками.
import { camState, resetCamera, zoomCamera, raiseCamera, orbitCamera } from './camera.js';
import { CAM_HEIGHT_SPEED, CAM_ORBIT_SENSITIVITY, CAM_HEIGHT_SENSITIVITY } from './constants.js';

const ARROWS = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

const heldKeys = new Set();

export function bindInput(domElement, plane) {
  addEventListener('keydown', event => {
    // Автоповтор клавиши шлёт ~30 keydown в секунду: без этой проверки
    // удержание Пробела или F переключало состояние десятки раз в секунду.
    if (event.repeat) return;

    const arrow = ARROWS[event.code];
    if (arrow) {
      event.preventDefault();
      plane.move(arrow[0], arrow[1]);
      return;
    }
    if (event.code === 'KeyR') {
      resetCamera();
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      plane.engineOn = !plane.engineOn;
      return;
    }
    heldKeys.add(event.code);
  });

  addEventListener('keyup', event => heldKeys.delete(event.code));
  // Уход фокуса (Alt+Tab с зажатой Q) иначе оставлял клавишу «залипшей».
  addEventListener('blur', () => heldKeys.clear());

  domElement.addEventListener('wheel', event => {
    event.preventDefault();
    zoomCamera(event.deltaY > 0 ? 1.1 : 0.9);
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  domElement.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    domElement.classList.add('dragging');
    domElement.setPointerCapture(event.pointerId);
  });

  domElement.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    orbitCamera(dx * CAM_ORBIT_SENSITIVITY);
    raiseCamera(-dy * CAM_HEIGHT_SENSITIVITY);
  });

  const stopDrag = event => {
    if (!dragging) return;
    dragging = false;
    domElement.classList.remove('dragging');
    if (domElement.hasPointerCapture(event.pointerId)) {
      domElement.releasePointerCapture(event.pointerId);
    }
  };

  domElement.addEventListener('pointerup', stopDrag);
  domElement.addEventListener('pointercancel', stopDrag);
  domElement.addEventListener('contextmenu', event => event.preventDefault());
}

const axis = (negative, positive) =>
  (heldKeys.has(positive) ? 1 : 0) - (heldKeys.has(negative) ? 1 : 0);

/** Клавиши, действующие непрерывно: высота камеры Q/E и управление W/S, A/D. */
export function updateHeldKeys(dt, plane) {
  if (heldKeys.has('KeyQ')) raiseCamera(-CAM_HEIGHT_SPEED * dt);
  if (heldKeys.has('KeyE')) raiseCamera(CAM_HEIGHT_SPEED * dt);

  plane.pitchInput = axis('KeyS', 'KeyW');   // W — руль высоты вверх, S — вниз
  plane.rollInput = axis('KeyA', 'KeyD');    // D — крен вправо, A — влево
  return camState;
}
