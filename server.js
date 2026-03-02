const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ADMIN_PASSWORD = 'Admin';
const MAX_PLAYERS = 40;

const SESSION = {
  id: 'GLOBAL',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  locked: false,
  screen: 'LOBBY',
  players: new Map(),
  socketsByPlayerId: new Map(),
  adminSocketId: null
};

function nowIso() { return new Date().toISOString(); }
function touch() { SESSION.updatedAt = nowIso(); }
function safeName(v) { return String(v || '').trim().slice(0, 24) || 'Aventurier'; }
function safeAnimal(v) { return String(v || '').trim().slice(0, 24) || 'Tigre'; }

function buildState() {
  return {
    sessionId: SESSION.id,
    createdAt: SESSION.createdAt,
    updatedAt: SESSION.updatedAt,
    locked: SESSION.locked,
    screen: SESSION.screen,
    playerCount: SESSION.players.size,
    players: [...SESSION.players.values()].map((p) => ({
      playerId: p.playerId,
      name: p.name,
      animal: p.animal,
      status: p.status,
      ready: p.ready,
      lastSeenAt: p.lastSeenAt
    }))
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const publicDir = path.join(__dirname, 'public');
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

  if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(publicDir, 'index.html'));
  if (pathname === '/admin') return serveFile(res, path.join(publicDir, 'admin.html'));
  if (pathname === '/join') return serveFile(res, path.join(publicDir, 'join.html'));
  if (pathname === '/tv') return serveFile(res, path.join(publicDir, 'tv.html'));

  const filePath = path.join(publicDir, pathname.replace(/^\/+/, ''));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: 'Forbidden' });
  if (fs.existsSync(filePath)) return serveFile(res, filePath);
  return sendJson(res, 404, { error: 'Not found' });
});

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, credentials: true },
  transports: ['websocket', 'polling']
});

function emitState() { io.emit('tv:state', buildState()); }
function isAdmin(socket) { return SESSION.adminSocketId === socket.id; }

io.on('connection', (socket) => {
  socket.emit('tv:state', buildState());

  socket.on('admin:auth', ({ password }, ack) => {
    if (password !== ADMIN_PASSWORD) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    if (SESSION.adminSocketId && SESSION.adminSocketId !== socket.id) {
      io.to(SESSION.adminSocketId).emit('admin:revoked', { reason: 'NEW_ADMIN_CONNECTED' });
    }
    SESSION.adminSocketId = socket.id;
    ack?.({ ok: true, state: buildState() });
    emitState();
  });

  socket.on('room:join', ({ playerId, reconnectToken, name, animal }, ack) => {
    if (SESSION.locked) return ack?.({ ok: false, error: 'SESSION_LOCKED' });
    const pid = String(playerId || crypto.randomUUID());
    const token = String(reconnectToken || crypto.randomUUID());
    const existing = SESSION.players.get(pid);

    if (!existing && SESSION.players.size >= MAX_PLAYERS) return ack?.({ ok: false, error: 'SESSION_FULL' });
    if (existing && existing.reconnectToken !== token) return ack?.({ ok: false, error: 'INVALID_RECONNECT_TOKEN' });

    const player = existing || {
      playerId: pid,
      reconnectToken: token,
      name: safeName(name),
      animal: safeAnimal(animal),
      ready: false,
      status: 'CONNECTED',
      lastSeenAt: nowIso()
    };

    player.name = safeName(name || player.name);
    player.animal = safeAnimal(animal || player.animal);
    player.status = 'CONNECTED';
    player.lastSeenAt = nowIso();

    SESSION.players.set(pid, player);
    SESSION.socketsByPlayerId.set(socket.id, pid);
    socket.data.playerId = pid;

    touch();
    emitState();
    io.emit('presence:update', { playerId: pid, status: 'CONNECTED', lastSeenAt: player.lastSeenAt });
    ack?.({ ok: true, player: { ...player }, state: buildState() });
  });

  socket.on('player:update', ({ playerId, name, animal, ready }, ack) => {
    const p = SESSION.players.get(String(playerId || socket.data.playerId || ''));
    if (!p) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
    if (typeof name !== 'undefined') p.name = safeName(name);
    if (typeof animal !== 'undefined') p.animal = safeAnimal(animal);
    if (typeof ready !== 'undefined') p.ready = Boolean(ready);
    p.lastSeenAt = nowIso();
    touch();
    emitState();
    ack?.({ ok: true, player: { ...p } });
  });

  socket.on('admin:lock', ({ locked }, ack) => {
    if (!isAdmin(socket)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    SESSION.locked = Boolean(locked);
    touch();
    emitState();
    ack?.({ ok: true });
  });

  socket.on('admin:kick', ({ playerId }, ack) => {
    if (!isAdmin(socket)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    const pid = String(playerId || '');
    SESSION.players.delete(pid);
    touch();
    emitState();
    io.emit('presence:update', { playerId: pid, status: 'DISCONNECTED', lastSeenAt: nowIso() });
    ack?.({ ok: true });
  });

  socket.on('admin:reset', (_, ack) => {
    if (!isAdmin(socket)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    SESSION.players.clear();
    SESSION.locked = false;
    SESSION.screen = 'LOBBY';
    touch();
    emitState();
    ack?.({ ok: true });
  });

  socket.on('tv:screen', ({ screen }, ack) => {
    if (!isAdmin(socket)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    if (!['LOBBY', 'WAITING', 'PLACEHOLDER'].includes(screen)) return ack?.({ ok: false, error: 'INVALID_SCREEN' });
    SESSION.screen = screen;
    touch();
    emitState();
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    if (SESSION.adminSocketId === socket.id) SESSION.adminSocketId = null;
    const pid = SESSION.socketsByPlayerId.get(socket.id);
    if (!pid) return;
    const p = SESSION.players.get(pid);
    if (p) {
      p.status = 'DISCONNECTED';
      p.lastSeenAt = nowIso();
      touch();
      emitState();
      io.emit('presence:update', { playerId: pid, status: 'DISCONNECTED', lastSeenAt: p.lastSeenAt });
    }
    SESSION.socketsByPlayerId.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Koh Lanta singleton running on http://localhost:${PORT}`);
});
