// Serveur HTTP + fichiers statiques + Socket.IO (sans Express)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// Jeux (modules)
const buzzerGame = require('./server/games/buzzer');
const quizGame = require('./server/games/quiz');
const guessGame = require('./server/games/guess');
const freeGame = require('./server/games/free');
const mostGame = require('./server/games/most');

const games = {
  buzzer: buzzerGame,
  quiz: quizGame,
  guess: guessGame,
  free: freeGame,
  most: mostGame
};

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SESSION_COOKIE = 'party_tv_room';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ROOM_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function parseRoomCode(raw) {
  const code = String(raw || '').toUpperCase().trim();
  if (!ROOM_CODE_RE.test(code)) return '';
  return code;
}

function parseCookies(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  if (!raw) return {};
  return raw.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return acc;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) acc[key] = val;
    return acc;
  }, {});
}

function createRateLimiter(limit, windowMs) {
  const state = new Map();
  return function allowed(key) {
    const k = String(key || 'unknown');
    const t = nowMs();
    const rec = state.get(k);
    if (!rec || (t - rec.start) > windowMs) {
      state.set(k, { start: t, count: 1 });
      return true;
    }
    if (rec.count >= limit) return false;
    rec.count += 1;
    return true;
  };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8'
  };
  return types[ext] || 'application/octet-stream';
}

// Statique
function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/healthz') {
    setSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (urlPath === '/qr') {
    const reqUrl = new URL(req.url, 'http://localhost');
    const data = String(reqUrl.searchParams.get('data') || '').slice(0, 512);
    if (!data) {
      setSecurityHeaders(res);
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('missing data');
      return;
    }
    QRCode.toBuffer(data, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 260,
      type: 'png'
    }, (err, buffer) => {
      if (err) {
        setSecurityHeaders(res);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('qr_error');
        return;
      }
      setSecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store, max-age=0'
      });
      res.end(buffer);
    });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/tv') {
    const cookies = parseCookies(req);
    const savedRoom = parseRoomCode(cookies[SESSION_COOKIE]);
    if (savedRoom) {
      setSecurityHeaders(res);
      res.writeHead(302, {
        Location: '/tv.html?room=' + encodeURIComponent(savedRoom),
        'Set-Cookie': SESSION_COOKIE + '=; Max-Age=0; Path=/; SameSite=Lax'
      });
      res.end();
      return;
    }
    urlPath = '/tv.html';
  }
  if (urlPath === '/join') urlPath = '/join.html';

  const resolvedPath = path.resolve(publicDir, '.' + urlPath);
  const baseDir = publicDir.endsWith(path.sep) ? publicDir : (publicDir + path.sep);
  if (!(resolvedPath === publicDir || resolvedPath.startsWith(baseDir))) {
    setSecurityHeaders(res);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  const filePath = resolvedPath;

  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      setSecurityHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    fs.readFile(filePath, function (err2, data) {
      if (err2) {
        setSecurityHeaders(res);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
        return;
      }
      setSecurityHeaders(res);
      res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
      res.end(data);
    });
  });
}

const httpServer = http.createServer(serveStatic);
const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN },
  maxHttpBufferSize: 1e5
});

// rooms -> { players: Map<socketId,{name}>, scores: Map<name,number>, gameId, game, locked: boolean }
const rooms = new Map();
const canCreateRoom = createRateLimiter(8, 60 * 1000);
const canJoinRoom = createRateLimiter(30, 60 * 1000);

function touchRoom(room) {
  room.updatedAt = nowMs();
}

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { players: new Map(), scores: new Map(), profiles: new Map(), gameId: 'buzzer', game: {}, locked: false, updatedAt: nowMs() };
    games['buzzer'].init(r);
    rooms.set(code, r);
  }
  touchRoom(r);
  return r;
}

function broadcastRoomState(code) {
  const r = rooms.get(code);
  if (!r) return;
  io.to(code).emit('room:state', { locked: !!r.locked });
}

function cleanName(name) {
  const n = String(name || '').replace(/[^a-zA-Z0-9 _.-]/g, '').trim().slice(0, 16);
  return n || 'Joueur';
}

function cleanColor(raw) {
  const c = String(raw || '').trim();
  return /^#[0-9A-Fa-f]{6}$/.test(c) ? c : '#ff5f7e';
}

function uniqueName(code, desired) {
  const r = getRoom(code);
  let base = desired;
  let name = base;
  let i = 2;
  const taken = new Set(Array.from(r.players.values()).map(p => p.name));
  while (taken.has(name)) name = base + '#' + (i++);
  return name;
}

function broadcastPlayers(code) {
  const r = rooms.get(code);
  if (!r) return;
  const listMap = new Map();
  r.scores.forEach((score, name) => {
    const profile = r.profiles && r.profiles.get(name);
    listMap.set(name, { name, score, connected: false, color: profile && profile.color ? profile.color : null });
  });
  r.players.forEach(p => {
    const profile = r.profiles && r.profiles.get(p.name);
    const item = listMap.get(p.name) || { name: p.name, score: 0, connected: false, color: profile && profile.color ? profile.color : null };
    item.connected = true;
    listMap.set(p.name, item);
  });
  const list = Array.from(listMap.values()).sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  io.to(code).emit('room:players', list);
}

function ensureGame(code, gameId) {
  const r = getRoom(code);
  const id = games[gameId] ? gameId : 'buzzer';
  r.gameId = id;
  games[id].init(r);
  touchRoom(r);
  io.to(code).emit('mode:changed', { mode: id });
  io.to(code).emit('round:reset');
  return r;
}

function socketIp(socket) {
  return socket.handshake.address || socket.conn.remoteAddress || socket.id;
}

function hasAdminAccess(payload) {
  if (!ADMIN_TOKEN) return true;
  const provided = String(payload && payload.adminToken || '');
  return provided && provided === ADMIN_TOKEN;
}

setInterval(() => {
  const limit = nowMs() - ROOM_TTL_MS;
  rooms.forEach((room, code) => {
    if (room.players.size === 0 && room.updatedAt < limit) rooms.delete(code);
  });
}, CLEANUP_INTERVAL_MS);

io.on('connection', (socket) => {
  let role = null;
  let roomCode = null;
  let playerName = null;

  socket.on('tv:create_room', (payload, ack) => {
    const ipKey = socketIp(socket);
    if (!canCreateRoom(ipKey)) { ack && ack({ ok: false, error: 'rate_limited' }); return; }
    const code = parseRoomCode(payload && payload.code);
    if (!code) { ack && ack({ ok: false, error: 'invalid_room' }); return; }
    if (!hasAdminAccess(payload)) { ack && ack({ ok: false, error: 'unauthorized' }); return; }
    roomCode = code;
    role = 'tv';
    const r = getRoom(roomCode);
    socket.join(roomCode);
    socket.emit('room:ready', { code: roomCode });
    socket.emit('mode:changed', { mode: r.gameId });
    broadcastPlayers(roomCode);
    broadcastRoomState(roomCode);
    ack && ack({ ok: true, code: roomCode });
  });

  socket.on('player:join', (payload, ack) => {
    const ipKey = socketIp(socket);
    if (!canJoinRoom(ipKey)) { ack && ack({ ok: false, error: 'rate_limited' }); return; }
    const code = parseRoomCode(payload && payload.room);
    const desired = cleanName(payload && payload.name);
    const color = cleanColor(payload && payload.color);
    if (!code || !desired) { ack && ack({ ok: false, error: 'missing' }); return; }
    const r = getRoom(code);
    if (r.locked) { ack && ack({ ok: false, error: 'locked' }); return; }
    const finalName = uniqueName(code, desired);
    playerName = finalName;
    roomCode = code;
    r.players.set(socket.id, { name: finalName, color });
    r.profiles.set(finalName, { color });
    if (!r.scores.has(finalName)) r.scores.set(finalName, 0);
    touchRoom(r);
    socket.join(code);
    ack && ack({ ok: true, name: finalName });
    socket.emit('mode:changed', { mode: r.gameId });
    broadcastPlayers(code);
  });

  socket.on('tv:remember', ({ room }, ack) => {
    if (role !== 'tv') { ack && ack({ ok: false }); return; }
    const code = parseRoomCode(room);
    if (!code) { ack && ack({ ok: false, error: 'invalid_room' }); return; }
    roomCode = code;
    const r = getRoom(code);
    socket.join(code);
    socket.emit('room:ready', { code });
    socket.emit('mode:changed', { mode: r.gameId });
    broadcastPlayers(code);
    broadcastRoomState(code);
    ack && ack({ ok: true, code });
  });

  // Verrouillage manuel (optionnel)
  socket.on('room:lock', (locked) => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    r.locked = !!locked;
    touchRoom(r);
    broadcastRoomState(roomCode);
  });

  // Changement de jeu (TV)
  socket.on('mode:set', ({ mode }) => {
    if (role !== 'tv' || !roomCode) return;
    ensureGame(roomCode, mode);
  });

  // Countdown (rebroadcast)
  socket.on('countdown:start', (seconds = 3) => {
    if (role !== 'tv' || !roomCode) return;
    const s = Math.max(1, Math.min(60, parseInt(seconds, 10) || 3));
    io.to(roomCode).emit('countdown:start', { seconds: s });
  });

  // Reset tour/question générique (TV)
  socket.on('round:reset', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    games[r.gameId].init(r);
    r.locked = false;
    touchRoom(r);
    io.to(roomCode).emit('round:reset');
    broadcastRoomState(roomCode);
  });

  // Reset scores (TV)
  socket.on('scores:reset', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    const newScores = new Map();
    r.players.forEach(p => newScores.set(p.name, 0));
    r.scores = newScores;
    touchRoom(r);
    io.to(roomCode).emit('scores:reset');
    broadcastPlayers(roomCode);
  });

  socket.on('scores:adjust', ({ name, delta }) => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    const player = String(name || '').trim();
    const d = Math.max(-5, Math.min(5, parseInt(delta, 10) || 0));
    if (!player || !d || !r.scores.has(player)) return;
    const next = Math.max(0, (r.scores.get(player) || 0) + d);
    r.scores.set(player, next);
    touchRoom(r);
    broadcastPlayers(roomCode);
  });

  // BUZZER
  socket.on('buzz:open', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'buzzer') return;
    r.locked = true;
    broadcastRoomState(roomCode);
    games.buzzer.adminOpen(io, r, roomCode);
    touchRoom(r);
  });

  socket.on('buzz:press', (ack) => {
    if (!roomCode) { ack && ack({ ok: false }); return; }
    const r = getRoom(roomCode);
    if (r.gameId !== 'buzzer') { ack && ack({ ok: false }); return; }
    games.buzzer.playerPress(io, r, roomCode, (playerName || 'Joueur'), ack, broadcastPlayers);
    // Déverrouillage à la fin d'un buzz (gagnant trouvé)
    r.locked = false;
    touchRoom(r);
    broadcastRoomState(roomCode);
  });

  // QUIZ
  socket.on('quiz:start', ({ question, correct, seconds }) => {
    if (role !== 'tv' || !roomCode) return;
    let r = getRoom(roomCode);
    if (r.gameId !== 'quiz') r = ensureGame(roomCode, 'quiz');
    r.locked = true;
    broadcastRoomState(roomCode);
    games.quiz.adminStart(io, r, roomCode, { question, correct, seconds });
    touchRoom(r);
  });

  socket.on('quiz:answer', ({ answer }, ack) => {
    if (!roomCode) { ack && ack({ ok: false }); return; }
    const r = getRoom(roomCode);
    if (r.gameId !== 'quiz') { ack && ack({ ok: false }); return; }
    games.quiz.playerAnswer(io, r, roomCode, (playerName || 'Joueur'), !!answer, ack);
    touchRoom(r);
  });

  socket.on('quiz:close', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'quiz') return;
    games.quiz.adminClose(io, r, roomCode, broadcastPlayers);
    r.locked = false;
    touchRoom(r);
    broadcastRoomState(roomCode);
  });

  // GUESS (Devine le nombre)
  socket.on('guess:start', ({ question, correct, min, max, seconds }) => {
    if (role !== 'tv' || !roomCode) return;
    let r = getRoom(roomCode);
    if (r.gameId !== 'guess') r = ensureGame(roomCode, 'guess');
    r.locked = true;
    broadcastRoomState(roomCode);
    games.guess.adminStart(io, r, roomCode, { question, correct, min, max, seconds });
    touchRoom(r);
  });

  socket.on('guess:answer', ({ value }, ack) => {
    if (!roomCode) { ack && ack({ ok: false }); return; }
    const r = getRoom(roomCode);
    if (r.gameId !== 'guess') { ack && ack({ ok: false }); return; }
    games.guess.playerAnswer(io, r, roomCode, (playerName || 'Joueur'), value, ack);
    touchRoom(r);
  });

  socket.on('guess:close', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'guess') return;
    games.guess.adminClose(io, r, roomCode, broadcastPlayers);
    r.locked = false;
    touchRoom(r);
    broadcastRoomState(roomCode);
  });

  // FREE (Réponse Libre) - Single
	socket.on('free:start', ({ question, seconds, answer }) => { if (role !== 'tv' || !roomCode) return; let r = getRoom(roomCode); if (r.gameId !== 'free') r = ensureGame(roomCode, 'free'); r.locked = true; broadcastRoomState(roomCode); 
	// IMPORTANT: transmettre answer 
	games.free.adminStart(io, r, roomCode, { question, seconds, answer }); touchRoom(r); });

  socket.on('free:answer', ({ text }, ack) => {
    if (!roomCode) { ack && ack({ ok: false }); return; }
    const r = getRoom(roomCode);
    if (r.gameId !== 'free') { ack && ack({ ok: false }); return; }
    games.free.playerAnswer(io, r, roomCode, (playerName || 'Joueur'), text, ack);
    touchRoom(r);
  });

  socket.on('free:close', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'free') return;
    games.free.adminClose(io, r, roomCode);
    r.locked = false;
    touchRoom(r);
    broadcastRoomState(roomCode);
  });

  socket.on('free:toggle_validate', ({ name }) => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'free') return;
    const player = String(name || '').trim();
    if (!player) return;
    games.free.adminToggleValidate(io, r, roomCode, player, broadcastPlayers);
    touchRoom(r);
  });

  // FREE - Series
	socket.on('free:series:start', ({ items }) => {
    if (role !== 'tv' || !roomCode) return;
    let r = getRoom(roomCode);
    if (r.gameId !== 'free') r = ensureGame(roomCode, 'free');
    r.locked = true;
    broadcastRoomState(roomCode);
    games.free.adminSeriesStart(io, r, roomCode, { items });
    // démarrer immédiatement
    games.free.adminSeriesNextQuestion(io, r, roomCode);
    touchRoom(r);
  });

  socket.on('free:series:next_question', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'free') return;
    games.free.adminSeriesNextQuestion(io, r, roomCode);
    touchRoom(r);
  });

  socket.on('free:series:finish', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'free') return;
    games.free.adminSeriesFinish(io, r, roomCode);
    touchRoom(r);
    // locked restera true jusqu'à fin de la review manuelle -> on déverrouille quand l'animateur quitte l'overlay si besoin
  });

  socket.on('free:series:goto_index', ({ index }) => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'free') return;
    games.free.adminSeriesGotoIndex(io, r, roomCode, index);
    touchRoom(r);
  });


  // MOST (Qui est le plus)
  socket.on('most:start', ({ question, seconds }) => {
    if (role !== 'tv' || !roomCode) return;
    let r = getRoom(roomCode);
    if (r.gameId !== 'most') r = ensureGame(roomCode, 'most');
    r.locked = true;
    broadcastRoomState(roomCode);
    games.most.adminStart(io, r, roomCode, { question, seconds });
    touchRoom(r);
  });

  socket.on('most:vote', ({ target }, ack) => {
    if (!roomCode) { ack && ack({ ok: false }); return; }
    const r = getRoom(roomCode);
    if (r.gameId !== 'most') { ack && ack({ ok: false }); return; }
    games.most.playerVote(io, r, roomCode, (playerName || 'Joueur'), target, ack);
    touchRoom(r);
  });

  socket.on('most:close', () => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    if (r.gameId !== 'most') return;
    games.most.adminClose(io, r, roomCode);
    r.locked = false;
    touchRoom(r);
    broadcastRoomState(roomCode);
  });

  socket.on('player:kick', ({ name }) => {
    if (role !== 'tv' || !roomCode) return;
    const r = getRoom(roomCode);
    const target = String(name || '').trim();
    if (!target) return;
    let targetSocket = null;
    r.players.forEach((p, sid) => {
      if (!targetSocket && p.name === target) targetSocket = sid;
    });
    if (!targetSocket) return;
    const targetSock = io.sockets.sockets.get(targetSocket);
    if (targetSock) {
      targetSock.emit('player:kicked');
      targetSock.leave(roomCode);
      targetSock.disconnect(true);
    }
    r.players.delete(targetSocket);
    r.scores.delete(target);
    if (r.profiles) r.profiles.delete(target);
    touchRoom(r);
    broadcastPlayers(roomCode);
  });

  socket.on('disconnect', () => {
    if (!roomCode) return;
    const r = rooms.get(roomCode);
    if (r) {
      r.players.delete(socket.id);
      broadcastPlayers(roomCode);
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', function () {
  console.log('Serveur avec Socket.IO demarre sur port ' + PORT);
});
