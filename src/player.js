// Физика движения пешком, перенесённая из `SHOOTER/scripts/player.gd`
// (PaniniPlayer). Оригинал считает в «полуединицах» (HU) и переводит их в
// метры через HU_TO_GODOT — здесь та же константа, поэтому цифры один в один.
import * as THREE from 'three';

const HU_TO_GODOT = 0.025;
// Чуть медленнее оригинала (250 HU): 5.5 м/с вместо 6.25, чтобы не сносило
// с ног на маленьком поле 500 м.
const MAX_SPEED = 220.0 * HU_TO_GODOT;          // 5.5 м/с
export const MAX_WALK_SPEED = MAX_SPEED;
const GRAVITY = 800.0 * HU_TO_GODOT;            // 20 м/с²
const JUMP_SPEED = 268.328 * HU_TO_GODOT;       // ~6.71 м/с
const STOP_SPEED = 100.0 * HU_TO_GODOT;         // 2.5 м/с
const GROUND_ACCELERATE = 10.0;
const AIR_ACCELERATE = 10.0;
const FRICTION = 4.0;
const AIR_WISH_SPEED_CAP = 30.0 * HU_TO_GODOT;  // 0.75 м/с
const MAX_VELOCITY = 2000.0 * HU_TO_GODOT;      // 50 м/с

const SLIDE_MIN_SPEED = 170.0 * HU_TO_GODOT;    // 4.25 м/с
const SLIDE_EXIT_SPEED = 115.0 * HU_TO_GODOT;   // 2.875 м/с
const SLIDE_BOOST = 140.0 * HU_TO_GODOT;        // 3.5 м/с
const SLIDE_MAX_ENTRY_BONUS = 120.0 * HU_TO_GODOT; // 3.0 м/с
const SLIDE_ENTRY_SPEED_FACTOR = 0.42;
const SLIDE_JUMP_BOOST = 105.0 * HU_TO_GODOT;   // 2.625 м/с
const SLIDE_MAX_TIME = 1.05;
const SLIDE_FRICTION = 0.22;
const SLIDE_STEER_ACCELERATE = 4.0;
const STANCE_RESPONSE = 16.0;

const SPEED_SOFT_CAP = 620.0 * HU_TO_GODOT;     // 15.5 м/с
const SPEED_HARD_CAP = 780.0 * HU_TO_GODOT;     // 19.5 м/с
const OVER_CAP_DAMPING = 4.0;

function expBlend(k) {
  return 1 - Math.exp(-k);
}

export class PlayerPhysics {
  constructor() {
    this.velocity = new THREE.Vector3();
    this.isSliding = false;
    this.slideTimeLeft = 0;
    this.stanceAmount = 0;
    this.filteredInput = { x: 0, y: 0 };
    this.filteredSpeed = 0;
  }

  /**
   * Шаг физики игрока — та же логика, что в `_physics_process`.
   * @param {number} dt
   * @param {{forward:number, strafe:number, jump:boolean, slide:boolean}} input
   * @param {boolean} onFloor стоит ли на земле (y <= 0)
   * @param {number} yaw текущий курс взгляда
   */
  update(dt, input, onFloor, yaw) {
    const wish = this.#getWish(input, yaw);
    const wishDir = wish.dir;
    const wishSpeed = wish.speed;
    const wantsJump = input.jump;
    const wantsSlide = input.slide;
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);

    if (wantsSlide && !this.isSliding && onFloor && horizontalSpeed >= SLIDE_MIN_SPEED) {
      this.#startSlide(wishDir);
    }

    if (onFloor) {
      if (wantsJump) {
        if (this.isSliding) this.#slideJumpBoost(wishDir);
        this.isSliding = false;
        this.velocity.y = JUMP_SPEED;
        this.#airMove(wishDir, wishSpeed, dt);
      } else if (this.isSliding) {
        this.velocity.y = 0;
        this.#slideMove(wishDir, wishSpeed, dt);
      } else {
        this.velocity.y = 0;
        this.#groundFriction(dt, FRICTION);
        this.#accelerate(wishDir, wishSpeed, GROUND_ACCELERATE, dt);
      }
    } else {
      this.isSliding = false;
      this.velocity.y -= GRAVITY * dt;
      this.#airMove(wishDir, wishSpeed, dt);
    }

    if (this.isSliding) {
      this.slideTimeLeft -= dt;
      const slideSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      if (this.slideTimeLeft <= 0 || slideSpeed < SLIDE_EXIT_SPEED || !wantsSlide) {
        this.isSliding = false;
      }
    }

    this.#skillSpeedLimit(dt);
    this.#clampVelocity();
    this.#updateStance(dt, wantsSlide);
    this.#updateFilters(dt, input);
  }

  /** Горизонтальная скорость в м/с — для качания рук и камеры. */
  get horizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  #getWish(input, yaw) {
    // forward = -Z при yaw=0, right повёрнут на +90° — те же оси, что в Godot.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const wx = rx * input.strafe + fx * input.forward;
    const wz = rz * input.strafe + fz * input.forward;
    const len = Math.hypot(wx, wz);
    const wishSpeed = Math.min(Math.hypot(input.forward, input.strafe), 1) * MAX_SPEED;
    if (len < 0.001) return { dir: new THREE.Vector3(), speed: wishSpeed };
    return { dir: new THREE.Vector3(wx / len, 0, wz / len), speed: wishSpeed };
  }

  #groundFriction(dt, friction) {
    const speed = this.horizontalSpeed;
    if (speed < 0.001) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    const control = speed < STOP_SPEED ? STOP_SPEED : speed;
    const newSpeed = Math.max(speed - control * friction * dt, 0);
    if (newSpeed !== speed) {
      const scale = newSpeed / speed;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }
  }

  #accelerate(wishDir, wishSpeed, accel, dt) {
    if (wishSpeed <= 0 || wishDir.lengthSq() === 0) return;
    const currentSpeed = this.velocity.dot(wishDir);
    let addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * dt * wishSpeed;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    this.velocity.addScaledVector(wishDir, accelSpeed);
  }

  #airMove(wishDir, wishSpeed, dt) {
    if (wishSpeed <= 0 || wishDir.lengthSq() === 0) return;
    const wishSpd = Math.min(wishSpeed, AIR_WISH_SPEED_CAP);
    const currentSpeed = this.velocity.dot(wishDir);
    let addSpeed = wishSpd - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = AIR_ACCELERATE * wishSpeed * dt;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    this.velocity.addScaledVector(wishDir, accelSpeed);
  }

  #startSlide(wishDir) {
    this.isSliding = true;
    this.slideTimeLeft = SLIDE_MAX_TIME;
    let slideDir = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const entrySpeed = slideDir.length();
    slideDir.normalize();
    if (slideDir.lengthSq() === 0 && wishDir.lengthSq() !== 0) slideDir.copy(wishDir);
    if (slideDir.lengthSq() !== 0) {
      const speedBonus = Math.min(Math.max(entrySpeed - SLIDE_MIN_SPEED, 0) * SLIDE_ENTRY_SPEED_FACTOR, SLIDE_MAX_ENTRY_BONUS);
      const totalBoost = SLIDE_BOOST + speedBonus;
      this.velocity.x += slideDir.x * totalBoost;
      this.velocity.z += slideDir.z * totalBoost;
    }
  }

  #slideMove(wishDir, wishSpeed, dt) {
    this.#groundFriction(dt, SLIDE_FRICTION);
    if (wishDir.lengthSq() !== 0) {
      this.#accelerate(wishDir, Math.min(wishSpeed, MAX_SPEED * 0.85), SLIDE_STEER_ACCELERATE, dt);
    }
  }

  #slideJumpBoost(wishDir) {
    let boostDir = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    boostDir.normalize();
    if (boostDir.lengthSq() === 0 && wishDir.lengthSq() !== 0) boostDir.copy(wishDir);
    if (boostDir.lengthSq() === 0) return;
    const alignment = wishDir.lengthSq() !== 0 ? Math.max(boostDir.dot(wishDir), 0) : 0;
    const totalBoost = SLIDE_JUMP_BOOST * (1 + alignment * 0.35);
    this.velocity.x += boostDir.x * totalBoost;
    this.velocity.z += boostDir.z * totalBoost;
  }

  #clampVelocity() {
    this.velocity.x = THREE.MathUtils.clamp(this.velocity.x, -MAX_VELOCITY, MAX_VELOCITY);
    this.velocity.y = THREE.MathUtils.clamp(this.velocity.y, -MAX_VELOCITY, MAX_VELOCITY);
    this.velocity.z = THREE.MathUtils.clamp(this.velocity.z, -MAX_VELOCITY, MAX_VELOCITY);
  }

  #updateStance(dt, wantsSlide) {
    const target = this.isSliding || wantsSlide ? 1 : 0;
    this.stanceAmount += (target - this.stanceAmount) * expBlend(STANCE_RESPONSE * dt);
  }

  #skillSpeedLimit(dt) {
    const speed = this.horizontalSpeed;
    if (speed <= SPEED_SOFT_CAP) return;
    let targetSpeed = speed;
    if (speed > SPEED_HARD_CAP) {
      targetSpeed = SPEED_HARD_CAP;
    } else {
      const overCapRatio = (speed - SPEED_SOFT_CAP) / Math.max(SPEED_HARD_CAP - SPEED_SOFT_CAP, 0.001);
      const damp = OVER_CAP_DAMPING * overCapRatio * overCapRatio * dt;
      targetSpeed = speed + (SPEED_SOFT_CAP - speed) * THREE.MathUtils.clamp(damp, 0, 1);
    }
    const scale = targetSpeed / speed;
    this.velocity.x *= scale;
    this.velocity.z *= scale;
  }

  #updateFilters(dt, input) {
    // filtered_input в оригинале хранит Vector2 из Input.get_vector(), где
    // «вперёд» — отрицательный y. Камера берёт его как есть.
    const rawX = input.strafe;
    const rawY = -input.forward;
    const inBlend = expBlend(14 * dt);
    this.filteredInput.x += (rawX - this.filteredInput.x) * inBlend;
    this.filteredInput.y += (rawY - this.filteredInput.y) * inBlend;
    const speedBlend = expBlend(10 * dt);
    this.filteredSpeed += (this.horizontalSpeed - this.filteredSpeed) * speedBlend;
  }
}