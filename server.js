const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ROOM_RE = /^[A-Z0-9]{6}$/;
const MAX_PLAYERS = 24;

const ROOM_STATES = {
  LOBBY: 'LOBBY',
  WAITING: 'WAITING',
  PLACEHOLDER: 'PLACEHOLDER'
};

const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function uniqueRoomCode() {
  let tries = 0;
  while (tries < 50) {
    const code = makeCode();
    if (!rooms.has(code)) return code;
    tries += 1;
  }
  throw new Error('Unable to generate room code');
}

function nowIso() {
  return new Date().toISOString();
}

function buildTvState(room) {
  return {
    roomCode: room.roomCode,
    locked: room.locked,
    screen: room.screen,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    playerCount: room.players.size,
    players: [...room.players.values()].map((p) => ({
      playerId: p.playerId,
      name: p.name,
      avatar: p.avatar,
      status: p.status,
      ready: p.ready,
      lastSeenAt: p.lastSeenAt
    }))
  };
}

function touch(room) {
  room.updatedAt = nowIso();
}

function createRoom() {
  const roomCode = uniqueRoomCode();
  const room = {
    roomCode,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    locked: false,
    screen: ROOM_STATES.LOBBY,
    players: new Map(),
    socketsByPlayerId: new Map(),
    adminSocketId: null,
    tvSockets: new Set()
  };
  rooms.set(roomCode, room);
  return room;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const publicDir = path.join(__dirname, 'public');

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const ext = path.extname(filePath);
    const map = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': map[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

  if (pathname === '/api/qr') {
    const data = String(url.searchParams.get('data') || '').slice(0, 512);
    if (!data) return sendJson(res, 400, { error: 'Missing data' });
    const png = await QRCode.toBuffer(data, { margin: 1, width: 512 });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(png);
  }

  if (pathname.startsWith('/join/')) return serveFile(res, path.join(publicDir, 'join.html'));
  if (pathname.startsWith('/tv/')) return serveFile(res, path.join(publicDir, 'tv.html'));
  if (pathname.startsWith('/admin/')) return serveFile(res, path.join(publicDir, 'admin.html'));

  if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(publicDir, 'index.html'));

  const filePath = path.join(publicDir, pathname.replace(/^\/+/, ''));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: 'Forbidden' });
  if (fs.existsSync(filePath)) return serveFile(res, filePath);

  return sendJson(res, 404, { error: 'Not found' });
});

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, credentials: true },
  transports: ['websocket', 'polling']
});

function emitTvState(room) {
  const payload = buildTvState(room);
  io.to(`room:${room.roomCode}`).emit('tv:state', payload);
}

function roomFromCode(rawCode) {
  const code = String(rawCode || '').toUpperCase().trim();
  if (!ROOM_RE.test(code)) return null;
  return rooms.get(code) || null;
}

function isAdmin(socket, room) {
  return room && room.adminSocketId === socket.id;
}

function safeName(name) {
  return String(name || '').trim().slice(0, 24) || 'Aventurier';
}

function safeAvatar(avatar) {
  return String(avatar || '🗿').slice(0, 4);
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ adminKey }, ack) => {
    if (adminKey !== ADMIN_KEY) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    const room = createRoom();
    room.adminSocketId = socket.id;
    socket.join(`room:${room.roomCode}`);
    socket.join(`admin:${room.roomCode}`);
    ack?.({
      ok: true,
      roomCode: room.roomCode,
      joinUrl: `${PUBLIC_BASE_URL}/join/${room.roomCode}`,
      tvUrl: `${PUBLIC_BASE_URL}/tv/${room.roomCode}`,
      adminUrl: `${PUBLIC_BASE_URL}/admin/${room.roomCode}`
    });
    emitTvState(room);
  });

  socket.on('admin:auth', ({ adminKey, roomCode }, ack) => {
    const room = roomFromCode(roomCode);
    if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (adminKey !== ADMIN_KEY) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    if (room.adminSocketId && room.adminSocketId !== socket.id) {
      io.to(room.adminSocketId).emit('admin:revoked', { reason: 'NEW_ADMIN_CONNECTED' });
    }
    room.adminSocketId = socket.id;
    socket.join(`room:${room.roomCode}`);
    socket.join(`admin:${room.roomCode}`);
    ack?.({ ok: true, room: buildTvState(room) });
    emitTvState(room);
  });

  socket.on('room:join', ({ roomCode, playerId, reconnectToken, name, avatar }, ack) => {
    const room = roomFromCode(roomCode);
    if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (room.locked) return ack?.({ ok: false, error: 'ROOM_LOCKED' });

    const pid = String(playerId || crypto.randomUUID());
    const token = String(reconnectToken || crypto.randomUUID());
    const existing = room.players.get(pid);

    if (!existing && room.players.size >= MAX_PLAYERS) return ack?.({ ok: false, error: 'ROOM_FULL' });

    if (existing && existing.reconnectToken !== token) {
      return ack?.({ ok: false, error: 'INVALID_RECONNECT_TOKEN' });
    }

    const player = existing || {
      playerId: pid,
      reconnectToken: token,
      name: safeName(name),
      avatar: safeAvatar(avatar),
      ready: false,
      status: 'CONNECTED',
      lastSeenAt: nowIso()
    };

    player.name = safeName(name || player.name);
    player.avatar = safeAvatar(avatar || player.avatar);
    player.status = 'CONNECTED';
    player.lastSeenAt = nowIso();
    room.players.set(pid, player);
    room.socketsByPlayerId.set(socket.id, pid);
    socket.join(`room:${room.roomCode}`);
    socket.data.roomCode = room.roomCode;
    socket.data.playerId = pid;

    touch(room);
    emitTvState(room);
    io.to(`room:${room.roomCode}`).emit('presence:update', {
      roomCode: room.roomCode,
      playerId: pid,
      status: 'CONNECTED',
      lastSeenAt: player.lastSeenAt
    });

    ack?.({ ok: true, room: buildTvState(room), player: { ...player } });
  });

  socket.on('room:leave', ({ roomCode, playerId }, ack) => {
    const room = roomFromCode(roomCode);
    if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    const pid = String(playerId || socket.data.playerId || '');
    if (!room.players.has(pid)) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
    room.players.delete(pid);
    touch(room);
    emitTvState(room);
    io.to(`room:${room.roomCode}`).emit('presence:update', {
      roomCode: room.roomCode,
      playerId: pid,
      status: 'DISCONNECTED',
      lastSeenAt: nowIso()
    });
    ack?.({ ok: true });
  });

  socket.on('player:update', ({ roomCode, playerId, name, avatar, ready }, ack) => {
    const room = roomFromCode(roomCode);
    if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    const player = room.players.get(String(playerId || ''));
    if (!player) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
    if (typeof name !== 'undefined') player.name = safeName(name);
    if (typeof avatar !== 'undefined') player.avatar = safeAvatar(avatar);
    if (typeof ready !== 'undefined') player.ready = Boolean(ready);
    player.lastSeenAt = nowIso();
    touch(room);
    emitTvState(room);
    ack?.({ ok: true, player });
  });

  socket.on('admin:lock', ({ roomCode, locked }, ack) => {
    const room = roomFromCode(roomCode);
    if (!isAdmin(socket, room)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    room.locked = Boolean(locked);
    touch(room);
    emitTvState(room);
    ack?.({ ok: true });
  });

  socket.on('admin:kick', ({ roomCode, playerId }, ack) => {
    const room = roomFromCode(roomCode);
    if (!isAdmin(socket, room)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    const pid = String(playerId || '');
    room.players.delete(pid);
    touch(room);
    emitTvState(room);
    io.to(`room:${room.roomCode}`).emit('presence:update', {
      roomCode: room.roomCode,
      playerId: pid,
      status: 'DISCONNECTED',
      lastSeenAt: nowIso()
    });
    ack?.({ ok: true });
  });

  socket.on('admin:reset', ({ roomCode }, ack) => {
    const room = roomFromCode(roomCode);
    if (!isAdmin(socket, room)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    room.players.clear();
    room.locked = false;
    room.screen = ROOM_STATES.LOBBY;
    touch(room);
    emitTvState(room);
    ack?.({ ok: true });
  });

  socket.on('tv:screen', ({ roomCode, screen }, ack) => {
    const room = roomFromCode(roomCode);
    if (!isAdmin(socket, room)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    if (!Object.values(ROOM_STATES).includes(screen)) return ack?.({ ok: false, error: 'INVALID_SCREEN' });
    room.screen = screen;
    touch(room);
    emitTvState(room);
    ack?.({ ok: true });
  });

  socket.on('tv:subscribe', ({ roomCode }, ack) => {
    const room = roomFromCode(roomCode);
    if (!room) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });
    socket.join(`room:${room.roomCode}`);
    room.tvSockets.add(socket.id);
    ack?.({ ok: true, room: buildTvState(room) });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      if (room.adminSocketId === socket.id) room.adminSocketId = null;
      room.tvSockets.delete(socket.id);
      const pid = room.socketsByPlayerId.get(socket.id);
      if (pid) {
        const p = room.players.get(pid);
        if (p) {
          p.status = 'DISCONNECTED';
          p.lastSeenAt = nowIso();
          io.to(`room:${room.roomCode}`).emit('presence:update', {
            roomCode: room.roomCode,
            playerId: pid,
            status: 'DISCONNECTED',
            lastSeenAt: p.lastSeenAt
          });
          touch(room);
          emitTvState(room);
        }
        room.socketsByPlayerId.delete(socket.id);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Koh Lanta backbone running on http://localhost:${PORT}`);
});
