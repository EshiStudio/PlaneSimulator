// Руки от первого лица, перенесённые из `scripts/hands.gd`. В оригинале это не
// 3D-модель, а рисунок полигонами на экране (`_draw()` у CanvasItem), поэтому
// здесь тот же рисунок делается на HTML-canvas поверх сцены — координаты,
// формы и качание взяты один в один.
import { view } from './camera.js';

const FILL = [0.82, 0.87, 0.96];
const HIGHLIGHT = [0.95, 0.97, 1.0];
const SHADOW = [0.50, 0.57, 0.68];
const OUTLINE = [0.012, 0.014, 0.018];

const css = (color, alpha = 1) =>
  `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${alpha})`;

// Пальцы и ладонь: списки точек в тех же единицах, что в GDScript.
const FINGERS = [
  { points: [[-54, 220], [-82, 130], [-70, 56], [-23, 58], [39, 205], [4, 224]], alpha: 0.94 },
  { points: [[-41, 11], [-42, -42], [-28, -92], [-5, -107], [13, -91], [3, -34], [-9, 8]], alpha: 1 },
  { points: [[-6, -6], [4, -64], [28, -126], [53, -134], [67, -111], [49, -54], [31, 2]], alpha: 1 },
  { points: [[30, 6], [54, -43], [83, -80], [106, -75], [117, -54], [88, -14], [63, 23]], alpha: 1 },
  { points: [[50, 54], [82, 15], [126, 3], [145, 25], [134, 53], [93, 70], [66, 78]], alpha: 0.98 },
];

const PALM = [[-60, 130], [-62, 67], [-45, 18], [-10, -11], [34, -5], [69, 42], [65, 108], [33, 145], [-17, 151]];
const PALM_LIGHT = [[-49, 35], [-13, -2], [28, 3], [52, 40], [18, 73], [-26, 69]];
const PALM_SHADOW = [[-57, 82], [-28, 138], [30, 146], [2, 205], [-54, 220], [-80, 132]];
const CREASES = [
  [[-34, 16], [-8, -11], [27, -8]],
  [[37, 8], [58, 39], [60, 74]],
  [[60, 55], [88, 65], [123, 50]],
  [[-44, 86], [-15, 101], [7, 126]],
];
const SCRATCHES = [
  [[-27, 43], [-18, 49], 0.80],
  [[13, 53], [22, 60], 0.75],
  [[81, -50], [89, -43], 0.75],
];

export class Hands {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'hands';
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '4',
    });
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.time = 0;
    this.stridePhase = 0;
    this.smoothedInput = { x: 0, y: 0 };
    this.smoothedSpeed = 0;
    this.lookSway = { x: 0, y: 0 };
    this.lastYaw = view.yaw;
    this.lastPitch = view.pitch;

    this.#resize();
    addEventListener('resize', () => this.#resize());
  }

  setVisible(visible) {
    this.canvas.style.display = visible ? '' : 'none';
  }

  #resize() {
    const ratio = Math.min(devicePixelRatio, 2);
    this.width = innerWidth;
    this.height = innerHeight;
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /** @param input {x,y} направление хода, speed — скорость в м/с. */
  update(dt, input, speed) {
    this.time += dt;

    const smooth = 1 - Math.exp(-16 * dt);
    this.smoothedInput.x += (input.x - this.smoothedInput.x) * smooth;
    this.smoothedInput.y += (input.y - this.smoothedInput.y) * smooth;
    this.smoothedSpeed += (speed - this.smoothedSpeed) * (1 - Math.exp(-12 * dt));

    const speedFactor = Math.min(Math.max(this.smoothedSpeed / 10, 0), 1.25);
    this.stridePhase += dt * (3.6 + speedFactor * 6.8);

    // Качание от поворота взгляда: руки отстают от резкого движения мышью.
    let yawDelta = view.yaw - this.lastYaw;
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    const pitchDelta = view.pitch - this.lastPitch;
    this.lastYaw = view.yaw;
    this.lastPitch = view.pitch;
    const targetX = Math.min(Math.max(-yawDelta * 760, -34), 34);
    const targetY = Math.min(Math.max(pitchDelta * 620, -28), 28);
    const swayRate = 1 - Math.exp(-20 * dt);
    this.lookSway.x += (targetX - this.lookSway.x) * swayRate;
    this.lookSway.y += (targetY - this.lookSway.y) * swayRate;

    this.#draw(speedFactor);
  }

  #draw(speedFactor) {
    const { ctx, width, height } = this;
    ctx.clearRect(0, 0, width, height);

    const base = Math.min(width / 1280, height / 720);
    const step = Math.sin(this.stridePhase);
    const breathe = Math.sin(this.time * 1.25);
    const input = this.smoothedInput;

    const swayX = input.x * 14 * base;
    const swayY = -input.y * 8 * base;
    const bobLeftY = (Math.abs(step) * 8 + breathe * 3) * speedFactor * base;
    const bobRightY = (-Math.abs(step) * 6 - breathe * 3) * speedFactor * base;
    const bobX = step * 4 * speedFactor * base;

    const left = {
      x: width * 0.17 - swayX + bobX + this.lookSway.x * base * 0.55 - 46 * base,
      y: height - 92 * base + swayY + bobLeftY + this.lookSway.y * base * 0.55,
    };
    const right = {
      x: width * 0.83 - swayX + bobX + this.lookSway.x * base * 0.55 + 46 * base,
      y: height - 92 * base + swayY + bobRightY + this.lookSway.y * base * 0.55,
    };

    const leftRotation = (-12 + step * 1.2) * Math.PI / 180 + this.lookSway.x * 0.0014;
    const rightRotation = (12 + step * 1.2) * Math.PI / 180 + this.lookSway.x * 0.0014;
    const handScale = base * 0.72;

    // Кисти поменяны местами обратно, как в исходном hands.gd: большие пальцы
    // смотрят внутрь кадра.
    this.#drawHand(left, handScale, 1, leftRotation);
    this.#drawHand(right, handScale, -1, rightRotation);
  }

  // Зеркалим по стороне, поворачиваем и масштабируем — как _transform_point.
  #point(p, origin, scale, side, rotation) {
    const x = p[0] * side;
    const y = p[1];
    const angle = rotation * side;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [origin.x + (x * cos - y * sin) * scale, origin.y + (x * sin + y * cos) * scale];
  }

  #path(points, origin, scale, side, rotation) {
    const ctx = this.ctx;
    ctx.beginPath();
    points.forEach((p, i) => {
      const [x, y] = this.#point(p, origin, scale, side, rotation);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  }

  #shape(points, origin, scale, side, rotation, fill, lineWidth) {
    const ctx = this.ctx;
    this.#path(points, origin, scale, side, rotation);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (lineWidth > 0) {
      ctx.strokeStyle = css(OUTLINE);
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  #drawHand(origin, scale, side, rotation) {
    const ctx = this.ctx;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const outlineWidth = 5 * scale;
    const detailWidth = 2.5 * scale;

    for (const finger of FINGERS) {
      this.#shape(finger.points, origin, scale, side, rotation, css(FILL, finger.alpha), outlineWidth);
    }
    this.#shape(PALM, origin, scale, side, rotation, css(FILL), outlineWidth);
    this.#shape(PALM_LIGHT, origin, scale, side, rotation, css(HIGHLIGHT, 0.55), 0);
    this.#shape(PALM_SHADOW, origin, scale, side, rotation, css(SHADOW, 0.46), 0);

    ctx.strokeStyle = css(OUTLINE);
    ctx.lineWidth = detailWidth;
    for (const crease of CREASES) {
      this.#path(crease, origin, scale, side, rotation);
      ctx.stroke();
    }
    for (const [from, to, widthFactor] of SCRATCHES) {
      ctx.lineWidth = detailWidth * widthFactor;
      this.#path([from, to], origin, scale, side, rotation);
      ctx.stroke();
    }
  }
}
