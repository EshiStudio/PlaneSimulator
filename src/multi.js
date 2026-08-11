// P2P-мультиплеер через PeerJS Cloud: хост создаёт комнату по коду, гости
// подключаются к нему по ссылке ?join=CODE. Хост — авторитет по самолёту:
// симулирует его и шлёт состояние гостям; гости шлют хосту события
// (толчок, двигатель, посадка), а не трогают свой самолёт напрямую.

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const SEND_INTERVAL = 80;   // мс между снапшотами самолёта (≈12 Гц)

const makeCode = () => {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  }
  return 'psim-' + s;
};

export function createMulti(handlers = {}) {
  const on = (name, ...args) => handlers[name]?.(...args);

  const net = {
    role: null,          // 'host' | 'guest' | null — solo
    code: null,          // код комнаты psim-XXXX
    connected: false,    // живое соединение
    guests: 0,           // у хоста: сколько гостей подключено
    available: typeof window !== 'undefined' && typeof window.Peer === 'function',
  };

  let peer = null;
  const conns = new Map();   // у хоста: peerId -> DataConnection
  let conn = null;           // у гостя: единственное соединение
  let lastSend = 0;

  const broadcast = msg => {
    for (const c of conns.values()) {
      try { c.send(msg); } catch { /* соединение могло умереть между событиями */ }
    }
  };

  // ---------- хост ----------
  const tryHost = attempt => {
    if (attempt > 5) {
      on('status', 'не удалось создать комнату — повторите');
      return;
    }
    const code = makeCode();
    const p = new Peer(code);
    p.on('open', () => {
      peer = p;
      net.role = 'host';
      net.code = code;
      net.connected = true;
      on('status', `комната ${code} создана`);
    });
    p.on('error', err => {
      if (err?.type === 'unavailable-id') {
        p.destroy();
        tryHost(attempt + 1);   // код занят — пробуем другой
      } else {
        on('error', err);
      }
    });
    p.on('connection', c => {
      c.on('open', () => {
        conns.set(c.peer, c);
        net.guests = conns.size;
        lastSend = 0;   // новый гость получит состояние немедленно
        on('guests', net.guests);
      });
      c.on('data', data => {
        if (!data || typeof data.t !== 'string') return;
        if (data.t === 'push') on('push', data.dx, data.dz);
        else if (data.t === 'engine') on('engine');
        else if (data.t === 'seat') on('seat', !!data.s);
        else if (data.t === 'player') {
          on('player', c.peer, data);
          // Ретрансляция другим гостям: все видят всех через хост.
          if (data.from === undefined) {
            const relay = { ...data, from: c.peer };
            for (const [pid, oc] of conns) {
              if (pid === c.peer) continue;
              try { oc.send(relay); } catch { /* соединение умерло */ }
            }
          }
        }
      });
      c.on('close', () => {
        conns.delete(c.peer);
        net.guests = conns.size;
        on('guests', net.guests);
      });
    });
  };

  net.host = () => {
    if (!net.available) { on('status', 'PeerJS не загружен'); return; }
    tryHost(1);
  };

  // ---------- гость ----------
  net.join = code => {
    if (!net.available) { on('status', 'PeerJS не загружен'); return; }
    const p = new Peer();
    p.on('open', () => {
      peer = p;
      const c = p.connect(code, { reliable: true });
      conn = c;
      c.on('open', () => {
        net.role = 'guest';
        net.connected = true;
        on('status', `подключено к комнате ${code}`);
      });
      c.on('data', data => {
        if (!data || typeof data.t !== 'string') return;
        if (data.t === 'plane') remote = data;
        else if (data.t === 'player') on('player', data.from ?? 'host', data);
      });
      c.on('close', () => {
        net.connected = false;
        on('status', 'соединение с хостом потеряно');
      });
      c.on('error', err => {
        if (err?.type === 'peer-unavailable') on('status', `комната ${code} не найдена`);
        else on('error', err);
      });
    });
    p.on('error', err => {
      if (err?.type === 'peer-unavailable') on('status', `комната ${code} не найдена`);
      else on('error', err);
    });
  };

  net.close = () => {
    try { peer?.destroy(); } catch { /* уже закрыт */ }
    peer = null;
    conn = null;
    conns.clear();
    remote = null;
    net.role = null;
    net.code = null;
    net.connected = false;
    net.guests = 0;
  };

  // ---------- отправка состояния (хост) ----------
  net.tickPlane = (plane, now) => {
    if (net.role !== 'host' || !net.connected || conns.size === 0) return;
    if (now - lastSend < SEND_INTERVAL) return;
    lastSend = now;
    const p = plane.group.position;
    broadcast({
      t: 'plane',
      p: [p.x, p.y, p.z],
      yaw: plane.yaw,
      e: plane.engineOn ? 1 : 0,
      gy: plane.gunYaw ? plane.gunYaw.rotation.y : 0,
      gp: plane.gunPitch ? plane.gunPitch.rotation.x : 0,
    });
  };

  // ---------- события гостя ----------
  net.sendPush = (dx, dz) => { try { conn?.send({ t: 'push', dx, dz }); } catch { } };
  net.sendEngine = () => { try { conn?.send({ t: 'engine' }); } catch { } };
  net.sendSeat = seated => { try { conn?.send({ t: 'seat', s: seated ? 1 : 0 }); } catch { } };

  // ---------- состояние игрока (обе стороны, ≈12 Гц) ----------
  let lastPlayer = 0;
  net.tickPlayer = (now, snap) => {
    if (net.role !== 'host' && net.role !== 'guest') return;
    if (!net.connected) return;
    if (now - lastPlayer < SEND_INTERVAL) return;
    lastPlayer = now;
    if (net.role === 'guest') { try { conn?.send(snap); } catch { } }
    else broadcast(snap);
  };

  // ---------- применение ремоут-состояния (гость) ----------
  let remote = null;   // последний снапшот от хоста
  net.applyRemote = (dt, plane, seated) => {
    if (!remote) return;
    const k = 1 - Math.exp(-10 * dt);   // экспонента: быстро догоняем, без рывков
    const g = plane.group;
    g.position.x += (remote.p[0] - g.position.x) * k;
    g.position.z += (remote.p[2] - g.position.z) * k;
    let d = remote.yaw - g.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    g.rotation.y += d * k;
    plane.engineOn = !!remote.e;
    // Наводка пулемёта хоста видна со стороны; сидящий гость наводит сам.
    if (!seated && plane.gunYaw) {
      plane.gunYaw.rotation.y = remote.gy;
      plane.gunPitch.rotation.x = remote.gp;
    }
  };

  net.remote = () => (remote ? [...remote.p, remote.yaw] : null);

  return net;
}
