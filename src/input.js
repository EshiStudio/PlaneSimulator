// Клавиатура и мышь. WASD означает разное в зависимости от того, идёт персонаж
// пешком или сидит в самолёте: на земле — шаг, в кабине — управляющие поверхности.
import { turnView, resetView } from './camera.js';
import { VIEW_YAW_SENSITIVITY, VIEW_PITCH_SENSITIVITY } from './constants.js';

const ARROWS = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

const heldKeys = new Set();

export function bindInput(domElement, actions) {
  addEventListener('keydown', event => {
    // Автоповтор клавиши шлёт ~30 keydown в секунду: без этой проверки
    // удержание Пробела переключало бы двигатель десятки раз в секунду.
    if (event.repeat) return;

    const arrow = ARROWS[event.code];
    if (arrow) {
      event.preventDefault();
      actions.movePlane(arrow[0], arrow[1]);
      return;
    }
    if (event.code === 'KeyE') {
      actions.toggleSeat();
      return;
    }
    if (event.code === 'KeyR') {
      resetView();
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      actions.toggleEngine();
      return;
    }
    heldKeys.add(event.code);
  });

  addEventListener('keyup', event => heldKeys.delete(event.code));
  // Уход фокуса (Alt+Tab с зажатой W) иначе оставлял клавишу «залипшей».
  addEventListener('blur', () => heldKeys.clear());

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
    turnView(dx * VIEW_YAW_SENSITIVITY, dy * VIEW_PITCH_SENSITIVITY);
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

/** Ход пешком: +1 вперёд, +1 вправо. */
export function walkInput() {
  return { forward: axis('KeyS', 'KeyW'), strafe: axis('KeyA', 'KeyD') };
}

/** Те же клавиши в кабине управляют поверхностями. */
export function applyFlightControls(plane) {
  plane.pitchInput = axis('KeyS', 'KeyW');   // W — руль высоты вверх, S — вниз
  plane.rollInput = axis('KeyA', 'KeyD');    // D — крен вправо, A — влево
}

export function clearFlightControls(plane) {
  plane.pitchInput = 0;
  plane.rollInput = 0;
}
