// P2P-тест: два headless Chrome (хост + гость) соединяются через PeerJS Cloud.
// 1. Хост нажимает «Создать комнату» в панели — получает код комнаты.
// 2. Гость вводит код в поле и нажимает «Войти» — соединение устанавливается.
// 3. Хост толкает самолёт стрелкой — гость видит его движение.
// 4. Гость толкает самолёт — хост применяет и рассылает обратно.
// 5. Гость садится (E) и заводит двигатель (Пробел) — хост переключает.
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const CHROME = process.env.CHROME_BIN || '/opt/google/chrome/chrome';
const PORT = 8223 + Math.floor(Math.random() * 500);
const DBG_PORT_A = 9335;
const DBG_PORT_B = 9336;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch(profileDir, url, dbgPort) {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${dbgPort}`, '--window-size=1280,800', url,
  ], { stdio: 'ignore' });
  let ws = null;
  for (let i = 0; i < 60; i++) {
    try {
      const data = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      const page = data.find(t => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(500);
  }
  if (!ws) throw new Error(`chrome ${dbgPort} not reachable`);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push('EXC: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('CONSOLE.ERROR: ' + JSON.stringify(msg.params.args).slice(0, 200));
    }
  };
  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable');
  return { chrome, send, errors };
}

const evalJson = async (client, expression) => {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result.value;
};

const waitFor = async (client, expression, timeoutMs, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await evalJson(client, expression);
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timeout waiting: ${what}`);
};

const key = (client, type, k, code) => client.send('Input.dispatchKeyEvent', {
  type, key: k, code,
  windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0,
  nativeVirtualKeyCode: 0,
});

const click = (client, selector) => evalJson(client, `(() => { const b = document.querySelector('${selector}'); if (!b) return null; b.click(); return 'ok'; })()`);
const setInput = (client, selector, value) => evalJson(client, `(() => { const i = document.querySelector('${selector}'); if (!i) return null; i.value = '${value}'; return 'ok'; })()`);

const profileA = mkdtempSync(join(tmpdir(), 'oc-net-a-'));
const profileB = mkdtempSync(join(tmpdir(), 'oc-net-b-'));
let host, guest, fails = 0;

try {
  host = await launch(profileA, `http://127.0.0.1:${PORT}/`, DBG_PORT_A);
  await waitFor(host, `window.__dbg?.net?.role === null ? 'ok' : null`, 60000, 'solo mode');
  await click(host, '#net-host');
  const code = await waitFor(host, `(() => { const n = window.__dbg?.net; return n && n.role === 'host' && n.code ? n.code : null; })()`, 60000, 'host room');
  console.log('host room:', code);

  guest = await launch(profileB, `http://127.0.0.1:${PORT}/`, DBG_PORT_B);
  await waitFor(guest, `window.__dbg?.net?.role === null ? 'ok' : null`, 60000, 'guest solo mode');
  await setInput(guest, '#net-code', code);
  await click(guest, '#net-join');
  await waitFor(guest, `(() => { const n = window.__dbg?.net; return n && n.role === 'guest' && n.connected ? 'ok' : null; })()`, 60000, 'guest connect');
  console.log('guest connected via panel');
  await waitFor(host, `(() => { const n = window.__dbg?.net; return n && n.guests === 1 ? 'ok' : null; })()`, 30000, 'host sees guest');

  // Глаза ремоут-фигуры следят за ближайшим игроком («взгляд в глаза»): игроки
  // стоят рядом — gazeActivity фигуры хоста у гостя должен подняться.
  await waitFor(guest, `(() => { const r = window.__dbg?.remotePlayers; return r && r[0] && r[0].visible && r[0].gaze > 0.5 ? 'ok' : null; })()`, 15000, 'eyes follow nearby player');
  console.log('eye gaze replication OK');

  // Прицел-«E»: гость стоит рядом с самолётом и смотрит на него —
  // перекрестие превращается в E (hoverPlane true).
  await waitFor(guest, `window.__dbg?.hoverPlane === true ? 'ok' : null`, 10000, 'crosshair E on plane');
  console.log('crosshair-E hover OK');

  // Хост толкает самолёт: ArrowUp = move(0, -1), позиция (5, -5).
  await key(host, 'keyDown', 'ArrowUp', 'ArrowUp');
  await key(host, 'keyUp', 'ArrowUp', 'ArrowUp');
  await waitFor(host, `(() => { const p = window.__dbg?.planePos; return p && Math.abs(p[0] - 5) < 0.01 && Math.abs(p[2] + 5) < 0.01 ? 'ok' : null; })()`, 10000, 'host moved plane');
  await waitFor(guest, `(() => { const d = window.__dbg; const p = d?.planePos; return d?.net?.remote && p && Math.abs(p[0] - 5) < 0.5 && Math.abs(p[2] + 5) < 0.5 ? 'ok' : null; })()`, 20000, 'guest sees host move');
  console.log('host->guest plane sync OK');

  // Гость толкает самолёт: ArrowDown = move(0, 1) обратно к (5, 5).
  await key(guest, 'keyDown', 'ArrowDown', 'ArrowDown');
  await key(guest, 'keyUp', 'ArrowDown', 'ArrowDown');
  await waitFor(guest, `(() => { const p = window.__dbg?.planePos; return p && Math.abs(p[0] - 5) < 0.5 && Math.abs(p[2] - 5) < 0.5 ? 'ok' : null; })()`, 20000, 'guest push applied');
  await waitFor(host, `(() => { const p = window.__dbg?.planePos; return p && Math.abs(p[0] - 5) < 0.01 && Math.abs(p[2] - 5) < 0.01 ? 'ok' : null; })()`, 10000, 'host applied guest push');
  console.log('guest->host push OK');

  // Репликация игроков: хост идёт назад (S, от самолёта) — гость видит
  // его фигуру в движении (смещение от стартовой позиции > 0.5 м).
  const hostStart = (await evalJson(host, `window.__dbg?.pos`)) ?? [0.4, 0, 6.4];
  await key(host, 'keyDown', 's', 'KeyS');
  await sleep(800);
  await key(host, 'keyUp', 's', 'KeyS');
  await waitFor(guest, `(() => { const r = window.__dbg?.remotePlayers; if (!r || !r[0] || !r[0].visible) return null; const p = r[0].pos; return Math.hypot(p[0] - ${hostStart[0]}, p[2] - ${hostStart[2]}) > 0.5 ? 'ok' : null; })()`, 15000, 'guest sees host walk');
  console.log('host->guest player replication OK');

  // Коллизия игроков: хост развернулся и идёт обратно к гостю — упрётся
  // в его фигуру на ~0.7 м и не пройдёт сквозь (как в оригинале SHOOTER).
  await key(host, 'keyDown', 'w', 'KeyW');
  await sleep(2500);
  await key(host, 'keyUp', 'w', 'KeyW');
  await waitFor(host, `(() => { const d = window.__dbg; const r = d?.remotePlayers?.[0]; if (!d?.pos || !r?.pos || !r.visible) return null; const dist = Math.hypot(d.pos[0] - r.pos[0], d.pos[2] - r.pos[2]); return dist >= 0.55 && dist < 1.3 ? 'ok' : null; })()`, 10000, 'players collide');
  console.log('player collision OK');

  // Гость садится (E) и заводит двигатель (Пробел) из кабины.
  await key(guest, 'keyDown', 'e', 'KeyE');
  await key(guest, 'keyUp', 'e', 'KeyE');
  await waitFor(guest, `window.__dbg?.seated === true ? 'ok' : null`, 10000, 'guest seated');
  await waitFor(host, `(() => { const r = window.__dbg?.remotePlayers; return r && r[0] && r[0].seated === 1 ? 'ok' : null; })()`, 10000, 'host sees guest seated');
  await waitFor(host, `window.__dbg?.net?.seatEvents === 1 ? 'ok' : null`, 10000, 'host seat event');
  await key(guest, 'keyDown', ' ', 'Space');
  await key(guest, 'keyUp', ' ', 'Space');
  await waitFor(host, `window.__dbg?.engine === true ? 'ok' : null`, 10000, 'host engine on');
  await waitFor(guest, `window.__dbg?.engine === true ? 'ok' : null`, 20000, 'guest sees engine state');
  console.log('seat + engine sync OK');

  // Синк турели: стрелок-гость наводит пулемёт — хост применяет углы
  // (эмуляция наводки: реально углы идут от мыши через aimGun).
  await evalJson(guest, `window.__dbg.sendGun(0.5, 0.3); 'ok'`);
  await waitFor(host, `(() => { const g = window.__dbg; return g && Math.abs(g.gunYaw - 0.5) < 0.06 && Math.abs(g.gunPitch - 0.3) < 0.06 ? 'ok' : null; })()`, 10000, 'host sees turret aim');
  console.log('turret aim guest->host OK');

  // Гость выходит из кабины и скользит (Shift): хост видит присед фигуры.
  await key(guest, 'keyDown', 'e', 'KeyE');
  await key(guest, 'keyUp', 'e', 'KeyE');
  await waitFor(host, `window.__dbg?.net?.seatEvents === 2 ? 'ok' : null`, 10000, 'host seat event 2');
  // Пешком гость видит наводку хоста из plane-снапшотов (host держит углы).
  await waitFor(guest, `(() => { const g = window.__dbg; return g && g.seated === false && Math.abs(g.gunYaw - 0.5) < 0.06 ? 'ok' : null; })()`, 15000, 'guest sees turret aim from snapshot');
  console.log('turret aim host->guest OK');
  await key(guest, 'keyDown', 's', 'KeyS');
  await sleep(400);   // разгон до скорости слайда
  await key(guest, 'keyDown', 'ShiftLeft', 'ShiftLeft');
  await waitFor(host, `(() => { const r = window.__dbg?.remotePlayers; return r && r[0] && r[0].stance > 0.2 ? 'ok' : null; })()`, 10000, 'host sees guest slide');
  await key(guest, 'keyUp', 'ShiftLeft', 'ShiftLeft');
  await key(guest, 'keyUp', 's', 'KeyS');
  console.log('slide replication OK');

  const guestDbg = await evalJson(guest, `JSON.stringify(window.__dbg?.net)`);
  console.log('guest net:', guestDbg);

  if (host.errors.length || guest.errors.length) {
    fails++;
    console.log('CONSOLE ERRORS:');
    host.errors.forEach(e => console.log('  host:', e));
    guest.errors.forEach(e => console.log('  guest:', e));
  }
} catch (err) {
  fails++;
  console.log('FAIL:', err.message);
  for (const [name, client] of [['host', host], ['guest', guest]]) {
    if (!client) continue;
    const dbg = await evalJson(client, `(() => { const d = window.__dbg; return { net: d?.net, planePos: d?.planePos, seated: d?.seated, engine: d?.engine }; })()`).catch(() => null);
    console.log(name, 'dbg:', JSON.stringify(dbg));
  }
} finally {
  host?.chrome.kill();
  guest?.chrome.kill();
  server.kill();
  await sleep(500);
  for (const p of [profileA, profileB]) {
    for (let i = 0; i < 5; i++) {
      try { rmSync(p, { recursive: true, force: true }); break; }
      catch { await sleep(500); }
    }
  }
}

console.log(fails === 0 ? 'NET OK' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
