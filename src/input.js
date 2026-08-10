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
      // Пешком Пробел — прыжок (см. jumpHeld), в кабине — двигатель.
      if (actions.isSeated?.()) actions.toggleEngine();
      else { /* прыжок обрабатывается каждый кадр по heldKeys */ }
      heldKeys.add(event.code);
      return;
    }
    heldKeys.add(event.code);
  });

  addEventListener('keyup', event => heldKeys.delete(event.code));
  // Уход фокуса (Alt+Tab с зажатой W) иначе оставлял клавишу «залипшей».
  addEventListener('blur', () => heldKeys.clear());

  // Мышь ведёт себя по-разному в двух режимах:
  //   пешком — pointer lock: клик захватывает курсор, поворот по movementX/Y;
  //   в кабине — свободный курсор: камера следует за ним без захвата,
  //   ЛКМ стреляет (как Input.MOUSE_MODE_VISIBLE + огонь в Godot).
  let locked = false;       // pointer lock активен (пешком)
  let dragging = false;     // временное снятие захвата — катим дельту руками
  let lastX = 0;
  let lastY = 0;
  let hasMouse = false;

  domElement.addEventListener('pointerenter', event => {
    lastX = event.clientX;
    lastY = event.clientY;
  });

  // В кабине курсор свободен: свободная наводка пулемёта.
  document.addEventListener('mousemove', event => {
    if (locked) {
      turnView(event.movementX * VIEW_YAW_SENSITIVITY, event.movementY * VIEW_PITCH_SENSITIVITY);
      domElement.classList.add('pointer-locked');
      return;
    }
    if (dragging) {
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      turnView(dx * VIEW_YAW_SENSITIVITY, dy * VIEW_PITCH_SENSITIVITY);
      return;
    }
    if (actions.isSeated?.()) {
      if (!hasMouse) {
        hasMouse = true;
        lastX = event.clientX;
        lastY = event.clientY;
        return;
      }
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      turnView(dx * VIEW_YAW_SENSITIVITY, dy * VIEW_PITCH_SENSITIVITY);
    }
  });

  domElement.addEventListener('pointerleave', () => { hasMouse = false; });

  domElement.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (actions.isSeated?.()) {
      // В кабине клик не захватывает мышь — только огонь.
      actions.fireChange?.(true);
      return;
    }
    // Пешком клик по холсту захватывает мышь (как MOUSE_MODE_CAPTURED).
    if (!locked) domElement.requestPointerLock();
  });

  addEventListener('pointerup', event => {
    if (event.button !== 0) return;
    if (actions.isSeated?.()) actions.fireChange?.(false);
  });

  const stopDrag = event => {
    if (!dragging) return;
    dragging = false;
    domElement.classList.remove('dragging', 'pointer-locked');
    if (domElement.hasPointerCapture(event.pointerId)) {
      domElement.releasePointerCapture(event.pointerId);
    }
  };

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === domElement;
    domElement.classList.toggle('pointer-locked', locked);
    domElement.classList.toggle('dragging', !locked && dragging);
  });

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

/** Пробел зажат (пешком — прыжок, авто-банни-хоп как в оригинале). */
export function jumpHeld() {
  return heldKeys.has('Space');
}

/** Shift зажат — скольжение. */
export function slideHeld() {
  return heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight');
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
