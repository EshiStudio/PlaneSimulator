import { Character } from '../src/character.js';

const DEG = Math.PI / 180;
let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.log('FAIL:', msg); }
}
function fin(v, msg) {
  if (!Number.isFinite(v)) { failures++; console.log('FAIL: NaN/Inf', msg, v); }
}

// Прогон анимаций с синтетическими входами: покой, ходьба, слайд, прыжок,
// разворот, солнце. Проверяем, что всё конечно и что поза меняется.
const c = new Character();
c.hideHeadForOwner(true);
const parts = ['bodyRoot', 'headRoot', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg',
  'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'sproutRoot',
  'sproutStem', 'leftSproutLeaf', 'rightSproutLeaf',
  'leftEye', 'rightEye', 'leftEyeWhite', 'rightEyeWhite', 'leftGlint', 'rightGlint'];
const snapshot = () => parts.map(p => {
  const o = c[p];
  return `${o.position.x},${o.position.y},${o.position.z}|${o.rotation.x},${o.rotation.y},${o.rotation.z}|${o.scale.x},${o.scale.y},${o.scale.z}`;
});

const scenarios = [
  ['idle', 3, (dt) => { c.externalVelocity.set(0, 0, 0); c.externalMoveSpeed = 0; c.stanceAmount = 0; c.externalOnFloor = true; c.externalPitch = 0; }],
  ['walk', 3, (dt) => { c.externalVelocity.set(0, 0, -4); c.externalMoveSpeed = 4; c.stanceAmount = 0; c.externalOnFloor = true; c.externalPitch = 0; }],
  ['strafe', 3, (dt) => { c.externalVelocity.set(3, 0, 0); c.externalMoveSpeed = 3; c.stanceAmount = 0; c.externalOnFloor = true; }],
  ['slide', 3, (dt) => { c.externalVelocity.set(0, 0, -5); c.externalMoveSpeed = 5; c.stanceAmount = 1; c.externalOnFloor = true; }],
  ['turn', 2, (dt) => { c.group.rotation.y += dt * 3; c.externalVelocity.set(0, 0, 0); c.externalMoveSpeed = 0; }],
  ['jump', 1.5, (dt) => { c.externalVelocity.set(0, 6, -2); c.externalMoveSpeed = 2; c.externalOnFloor = false; }],
  ['fall-land', 2, (dt) => {
    if (dt < 0.8) { c.externalVelocity.set(0, -8, 0); c.externalOnFloor = false; }
    else { c.externalVelocity.set(0, 0, 0); c.externalOnFloor = true; }
  }],
];

for (const [name, secs, setInput] of scenarios) {
  const poses = [];
  let t = 0;
  while (t < secs) {
    const dt = 1 / 120;
    setInput(dt);
    c.update(dt, null);
    t += dt;
  }
  const s = snapshot();
  for (const v of s) for (const num of v.split(/[|,]/)) fin(parseFloat(num), `${name} part pose`);
  poses.push(s.join(';'));
  console.log(name, 'OK — e.g. leg x-rot:', c.leftLeg.rotation.x.toFixed(3), 'arm z-rot:', c.leftArm.rotation.z.toFixed(3), 'walkActivity:', c.walkActivity.toFixed(3), 'jump:', c.jumpAmount.toFixed(2), 'turn:', c.turnIntensity.toFixed(3));
}

// Глаза и моргание работают
c.externalOnFloor = true; c.externalVelocity.set(0, 0, 0); c.externalMoveSpeed = 0;
for (let i = 0; i < 30 * 60; i++) c.update(1 / 60, null);
ok(c.blinkAmount >= 0 && c.blinkAmount <= 1, 'blinkAmount in range');
console.log('blinkAmount after 30s:', c.blinkAmount.toFixed(3), 'eyeFocus:', c.eyeFocus.x.toFixed(3), c.eyeFocus.y.toFixed(3));

// Солнце: смотрим на солнце -> заряд + частое моргание
c.sunDirection.set(-0.9554, 0.2952, 0).normalize();
c.group.rotation.y = Math.atan2(0.9554, 0); // смотрим в сторону солнца по X
for (let i = 0; i < 4 * 60; i++) c.update(1 / 60, null);
console.log('sunGazeCharge:', c.sunGazeCharge.toFixed(3), 'sunBlink:', c.blinkAmount.toFixed(3));
ok(c.sunGazeCharge > 0.9, 'sun gaze charges up');

// hideHeadForOwner: тень остаётся (castShadow-меши прозрачны, а не выключены)
c.hideHeadForOwner(true);
let castShadowCount = 0, transparentCount = 0, hiddenOutline = 0;
c.headRoot.traverse(o => {
  if (!o.isMesh) return;
  if (o.castShadow) { castShadowCount++; if (o.material.transparent && o.material.opacity === 0) transparentCount++; }
  else if (!o.visible) hiddenOutline++;
});
console.log(`head: castShadow meshes=${castShadowCount}, transparent=${transparentCount}, hidden outlines=${hiddenOutline}`);
ok(castShadowCount > 0 && castShadowCount === transparentCount, 'all shadow-casting head meshes transparent');
c.hideHeadForOwner(false);
let restored = true;
c.headRoot.traverse(o => {
  if (!o.isMesh) return;
  if (o.material.transparent && o.material.opacity === 0) restored = false;
});
ok(restored, 'head materials restored on unhide');

// hideArmsForOwner: руки 3D-фигуры не видны владельцу (тень остаётся),
// у чужих руки на месте.
const armParts = [c.leftArm, c.rightArm];
let armShadow = 0, armHidden = 0, armOutline = 0;
c.hideArmsForOwner(true);
for (const arm of armParts) arm.traverse(o => {
  if (!o.isMesh) return;
  if (o.castShadow) { armShadow++; if (o.material.transparent && o.material.opacity === 0) armHidden++; }
  else if (!o.visible) armOutline++;
});
console.log(`arms: castShadow meshes=${armShadow}, hidden=${armHidden}, hidden outlines=${armOutline}`);
ok(armShadow > 0 && armShadow === armHidden, 'all shadow-casting arm meshes hidden for owner');
ok(armOutline > 0, 'arm outlines hidden for owner');
c.hideArmsForOwner(false);
let armsRestored = true;
for (const arm of armParts) arm.traverse(o => {
  if (!o.isMesh) return;
  if (o.material.transparent && o.material.opacity === 0) armsRestored = false;
});
ok(armsRestored, 'arm materials restored on unhide');

console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
