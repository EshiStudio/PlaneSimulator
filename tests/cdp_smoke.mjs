// Браузерный smoke-тест для CI: страница загружается без ошибок консоли,
// ходьба даёт движение камеры (пиксельный diff кадров), после остановки
// камера стабильна (нет дёрганья анимациями на месте).
// Chrome: env CHROME_BIN (по умолчанию /opt/google/chrome/chrome).
// Сервер: python3 -m http.server на случайном порту из корня репо.
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const PORT = 8123 + Math.floor(Math.random() * 500);

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
const profile = mkdtempSync(join(tmpdir(), 'oc-ci-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`,
  `--remote-debugging-port=9334`, '--window-size=1280,800',
  `http://127.0.0.1:${PORT}/`
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws = null;
for (let i = 0; i < 60; i++) {
  try {
    const data = await (await fetch(`http://127.0.0.1:9334/json/list`)).json();
    const page = data.find(t => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(500);
}
if (!ws) {
  console.log('CDP FAIL: chrome not reachable');
  process.exit(1);
}

let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const errors = [];
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push('EXC: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push('CONSOLE.ERROR: ' + JSON.stringify(msg.params.args).slice(0, 300));
  }
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable');

// Ждём живую игру: __dbg заполняется анимациями с числами.
let alive = false;
for (let i = 0; i < 60; i++) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const d = window.__dbg; return d && d.onFloor !== undefined && d.jump !== undefined ? 'ok' : 'no'; })()`,
    returnByValue: true,
  });
  if (r.result.value === 'ok') { alive = true; break; }
  await sleep(500);
}
// Прогрев: загрузка GLB-модели и первые кадры рендера.
if (alive) await sleep(8000);
if (!alive) {
  const diag = await send('Runtime.evaluate', {
    expression: `({ url: location.href, state: document.readyState, hasCanvas: !!document.querySelector('canvas'), dbg: JSON.stringify(window.__dbg), status: document.getElementById('status')?.getAttribute('hidden'), body: document.body.innerText.slice(0, 200) })`,
    returnByValue: true,
  });
  console.log('PAGE NEVER READY. diag:', JSON.stringify(diag.result.value), 'errors:', JSON.stringify(errors));
  chrome.kill(); server.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

const key = (type, k, code) => send('Input.dispatchKeyEvent', {
  type, key: k, code,
  windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0,
  nativeVirtualKeyCode: 0,
});

let frameIdx = 0;
async function grab() {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const ev = await send('Runtime.evaluate', {
    expression: `(async () => {
      const url = 'data:image/png;base64,${shot.data}';
      const img = new Image();
      await new Promise(res => { img.onload = res; img.src = url; });
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 400;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, 640, 400);
      return Array.from(ctx.getImageData(0, 0, 640, 400).data);
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  return ev.result.value;
}
function diff(a, b) {
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return sum / n;
}

function maxDiff(seq) {
  let m = 0;
  for (let i = 1; i < seq.length; i++) m = Math.max(m, diff(seq[i - 1], seq[i]));
  return m;
}

const frames = [];
for (let i = 0; i < 4; i++) {
  frames.push(await grab());
  await sleep(300);
}
const idleDiff = maxDiff(frames);

await key('keyDown', 'w', 'KeyW');
await sleep(300);
const wdbg = await send('Runtime.evaluate', { expression: `JSON.stringify(window.__dbg)`, returnByValue: true });
console.log('walk dbg:', wdbg.result.value);
await sleep(300);
frames.length = 0;
for (let i = 0; i < 6; i++) {
  frames.push(await grab());
  await sleep(300);
}
await key('keyUp', 'w', 'KeyW');
const walkDiff = maxDiff(frames);

// После остановки ждём полного затухания скорости и анимаций (инерция ~3.5s),
// затем проверяем стабильность камеры.
for (let i = 0; i < 40; i++) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const d = window.__dbg; return d && d.hspeed !== undefined && d.hspeed < 0.01 ? 'stop' : 'moving'; })()`,
    returnByValue: true,
  });
  if (r.result.value === 'stop') break;
  await sleep(500);
}
await sleep(1500);
const sdbg = await send('Runtime.evaluate', { expression: `JSON.stringify(window.__dbg)`, returnByValue: true });
console.log('stand dbg:', sdbg.result.value);
frames.length = 0;
for (let i = 0; i < 4; i++) {
  frames.push(await grab());
  await sleep(300);
}
const standDiff = maxDiff(frames);

chrome.kill(); server.kill();
for (let i = 0; i < 5; i++) {
  try { rmSync(profile, { recursive: true, force: true }); break; }
  catch { await sleep(500); }
}

let fails = 0;
if (errors.length) { fails++; console.log('CONSOLE ERRORS:'); errors.forEach(e => console.log(' ', e)); }
if (idleDiff > 8) { fails++; console.log('idle diff too high:', idleDiff.toFixed(2), '(>8)'); }
if (walkDiff < 10) { fails++; console.log('walk motion too small:', walkDiff.toFixed(2), '(<10)'); }
if (walkDiff < idleDiff * 1.8) { fails++; console.log('walk not distinct from idle:', walkDiff.toFixed(2), 'idle:', idleDiff.toFixed(2)); }
if (standDiff > 8) { fails++; console.log('stand camera jerking:', standDiff.toFixed(2), '(>8)'); }
console.log(`idle=${idleDiff.toFixed(2)} walk=${walkDiff.toFixed(2)} stand=${standDiff.toFixed(2)}`);
console.log(fails === 0 ? 'SMOKE OK' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
