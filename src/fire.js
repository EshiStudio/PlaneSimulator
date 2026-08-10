// Огонь из турели: трассеры, вспышка у дула и звук через Web Audio.
// Вспышка и трассеры — примитивы без теней: их число ограничено пулом,
// чтобы не плодить материалы и draw calls.
import * as THREE from 'three';

const TRACER_COUNT = 24;          // пул трассеров
const TRACER_RADIUS = 0.035;      // м
const TRACER_SPEED = 140;         // м/с — видимая скорость полёта
const TRACER_LIFE = 0.2;          // с — дальность ~28 м
const TRACER_COLOR = 0xffcc66;

const FLASH_RADIUS = 0.15;        // м — сфера вспышки у дула
const FLASH_LIFE = 0.06;          // с
const FLASH_COLOR = 0xffdd88;
const FLASH_LIGHT_INTENSITY = 30; // кандел
const FLASH_LIGHT_LIFE = 0.08;    // с
const FLASH_LIGHT_DISTANCE = 10;  // м

export class Fire {
  constructor(scene) {
    this.scene = scene;
    this.audio = null;
    this.masterGain = null;

    this.tracers = [];
    for (let i = 0; i < TRACER_COUNT; i++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(TRACER_RADIUS, 6, 4),
        new THREE.MeshBasicMaterial({
          color: TRACER_COLOR,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      );
      mesh.visible = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0, dir: new THREE.Vector3() });
    }
    this.nextTracer = 0;

    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(FLASH_RADIUS, 8, 6),
      new THREE.MeshBasicMaterial({
        color: FLASH_COLOR,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.flash.visible = false;
    scene.add(this.flash);

    this.flashLight = new THREE.PointLight(FLASH_COLOR, 0, FLASH_LIGHT_DISTANCE, 2);
    scene.add(this.flashLight);
    this.flashLife = 0;
    this.lightLife = 0;
  }

  /** Один выстрел: пуля из дула + вспышка с подсветкой + звук. */
  shot(at, dir) {
    const tracer = this.tracers[this.nextTracer];
    this.nextTracer = (this.nextTracer + 1) % this.tracers.length;
    tracer.mesh.visible = true;
    tracer.mesh.position.copy(at).addScaledVector(dir, 0.2);
    tracer.dir.copy(dir).normalize().multiplyScalar(TRACER_SPEED);
    tracer.life = TRACER_LIFE;

    this.flash.visible = true;
    this.flash.position.copy(at).addScaledVector(dir, 0.35);
    this.flashLife = FLASH_LIFE;
    this.flash.scale.setScalar(1);

    this.flashLight.position.copy(at).addScaledVector(dir, 0.5);
    this.flashLight.intensity = FLASH_LIGHT_INTENSITY;
    this.lightLife = FLASH_LIGHT_LIFE;

    this.#bang();
  }

  update(dt) {
    for (const tracer of this.tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      if (tracer.life <= 0) {
        tracer.mesh.visible = false;
        continue;
      }
      tracer.mesh.position.addScaledVector(tracer.dir, dt);
      tracer.mesh.material.opacity = tracer.life / TRACER_LIFE;
    }

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      const k = Math.max(this.flashLife, 0) / FLASH_LIFE;
      this.flash.material.opacity = k;
      this.flash.scale.setScalar(1 + (1 - k) * 0.6);
      if (this.flashLife <= 0) this.flash.visible = false;
    }

    if (this.lightLife > 0) {
      this.lightLife -= dt;
      this.flashLight.intensity = Math.max(this.lightLife, 0) / FLASH_LIGHT_LIFE * FLASH_LIGHT_INTENSITY;
    }
  }

  /** Пулемётный хлопок: шумовой выброс + низкий удар. */
  #bang() {
    if (!this.#ensureAudio()) return;
    if (this.audio.state === 'suspended') this.audio.resume();
    const t = this.audio.currentTime;

    const dur = 0.045;
    const buffer = this.audio.createBuffer(1, Math.ceil(this.audio.sampleRate * dur), this.audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    }
    const source = this.audio.createBufferSource();
    source.buffer = buffer;
    const filter = this.audio.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900 * (0.85 + Math.random() * 0.3);
    const gain = this.audio.createGain();
    gain.gain.setValueAtTime(1, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    source.connect(filter).connect(gain).connect(this.masterGain);
    source.start(t);

    const osc = this.audio.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.07);
    const oscGain = this.audio.createGain();
    oscGain.gain.setValueAtTime(0.5, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    osc.connect(oscGain).connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  #ensureAudio() {
    if (this.audio) return true;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return false;
      this.audio = new AudioContext();
      this.masterGain = this.audio.createGain();
      this.masterGain.gain.value = 0.35;   // чтобы очередь не оглушала
      this.masterGain.connect(this.audio.destination);
      return true;
    } catch {
      this.audio = null;
      return false;
    }
  }
}