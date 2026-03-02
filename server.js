const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ADMIN_PASSWORD = 'Admin';
const COUNCIL_MODE = process.env.COUNCIL_MODE || 'ELIMINATION';
const COUNCIL_PENALTY = Number(process.env.COUNCIL_PENALTY || 5);
const FINALE_TOP = Number(process.env.FINALE_TOP || 3);

function readConfig(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config', name), 'utf8'));
  } catch {
    return fallback;
  }
}

const CONFIG = {
  susceptibleQuestions: readConfig('susceptible_questions.json', []),
  blindtest: readConfig('blindtest_bank.json', []),
  price: readConfig('priceisright_items.json', []),
  top3: readConfig('top3_themes.json', [])
};

const FLOW = ['LOBBY', 'INTRO', 'GAME_A', 'RESULTS_A', 'GAME_B', 'RESULTS_B', 'GAME_C', 'RESULTS_C', 'GAME_D', 'RESULTS_D', 'GAME_E', 'RESULTS_E', 'COUNCIL', 'COUNCIL_RESULT', 'FINAL', 'FINAL_RESULT', 'END'];
const TV_SCREENS = ['LOBBY', 'WAITING', 'PLACEHOLDER'];

const SESSION = {
  id: 'GLOBAL',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  players: new Map(),
  socketsByPlayerId: new Map(),
  adminSocketId: null,
  phase: 'LOBBY',
  phaseIndex: 0,
  phaseStartedAt: null,
  phaseTimer: { running: false, endsAt: null, remainingMs: 0 },
  answerLocked: false,
  gameState: {},
  history: [],
  councilMode: COUNCIL_MODE,
  councilPenalty: COUNCIL_PENALTY,
  immunityPlayerId: null,
  finaleTop: FINALE_TOP,
  started: false,
  paused: false
};

function now() { return Date.now(); }
function nowIso() { return new Date().toISOString(); }
function norm(s) { return String(s || '').trim().toLowerCase(); }
function safeName(v) { return String(v || '').trim().slice(0, 24) || 'Aventurier'; }
function safeAnimal(v) { return String(v || '').trim().slice(0, 24) || 'Tigre'; }
function touch() { SESSION.updatedAt = nowIso(); }
function phaseAllowsActions() { return SESSION.started && !SESSION.paused && !SESSION.answerLocked; }
function activePlayers() { return [...SESSION.players.values()].filter((p) => !p.eliminated); }

function ensurePlayerScore(p) { if (typeof p.score !== 'number') p.score = 0; }

function rankPlayers() {
  return [...SESSION.players.values()]
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
    .map((p, idx, arr) => ({
      playerId: p.playerId,
      name: p.name,
      animal: p.animal,
      status: p.status,
      ready: p.ready,
      score: p.score,
      eliminated: !!p.eliminated,
      rank: 1 + arr.filter((x) => x.score > p.score).length,
      lastSeenAt: p.lastSeenAt
    }));
}

function buildState() {
  return {
    sessionId: SESSION.id,
    createdAt: SESSION.createdAt,
    updatedAt: SESSION.updatedAt,
    started: SESSION.started,
    paused: SESSION.paused,
    phase: SESSION.phase,
    phaseIndex: SESSION.phaseIndex,
    phaseTimer: SESSION.phaseTimer,
    answerLocked: SESSION.answerLocked,
    councilMode: SESSION.councilMode,
    councilPenalty: SESSION.councilPenalty,
    immunityPlayerId: SESSION.immunityPlayerId,
    finaleTop: SESSION.finaleTop,
    playerCount: SESSION.players.size,
    rankings: rankPlayers(),
    gameState: SESSION.gameState,
    history: SESSION.history.slice(-10)
  };
}

function broadcastState() {
  io.emit('game:state', buildState());
}
function publishResults(payload) {
  io.emit('results:publish', payload);
}

function setPhase(phase) {
  SESSION.phase = phase;
  SESSION.phaseIndex = FLOW.indexOf(phase);
  SESSION.phaseStartedAt = nowIso();
  SESSION.answerLocked = false;
  SESSION.paused = false;
  SESSION.phaseTimer = { running: false, endsAt: null, remainingMs: 0 };
}

function nextPhase() {
  const idx = FLOW.indexOf(SESSION.phase);
  if (idx < FLOW.length - 1) setPhase(FLOW[idx + 1]);
}

function startTimer(seconds) {
  const ms = Math.max(0, Number(seconds || 0) * 1000);
  SESSION.phaseTimer = { running: ms > 0, endsAt: ms ? now() + ms : null, remainingMs: ms };
}
function pauseTimer() {
  if (!SESSION.phaseTimer.running || !SESSION.phaseTimer.endsAt) return;
  SESSION.phaseTimer.remainingMs = Math.max(0, SESSION.phaseTimer.endsAt - now());
  SESSION.phaseTimer.running = false;
  SESSION.phaseTimer.endsAt = null;
}
function resumeTimer() {
  if (SESSION.phaseTimer.running || !SESSION.phaseTimer.remainingMs) return;
  SESSION.phaseTimer.running = true;
  SESSION.phaseTimer.endsAt = now() + SESSION.phaseTimer.remainingMs;
}

function initPhaseState(phase) {
  if (phase === 'GAME_A') {
    SESSION.gameState = { key: 'GAME_A', index: 0, question: CONFIG.susceptibleQuestions[0] || '', answers: {}, completed: false };
  } else if (phase === 'GAME_B') {
    SESSION.gameState = { key: 'GAME_B', index: 0, prompt: CONFIG.blindtest[0]?.prompt || '', options: CONFIG.blindtest[0]?.options || [], answer: CONFIG.blindtest[0]?.answer || '', answers: {}, completed: false };
  } else if (phase === 'GAME_C') {
    const item = CONFIG.price[0] || { item: 'Item', price: 100 };
    SESSION.gameState = { key: 'GAME_C', index: 0, item: item.item, realPrice: item.price, withoutOver: true, answers: {}, completed: false };
  } else if (phase === 'GAME_D') {
    const t = CONFIG.top3[0] || { theme: 'Thème', answers: [] };
    SESSION.gameState = { key: 'GAME_D', index: 0, theme: t.theme, expected: t.answers, answers: {}, completed: false };
  } else if (phase === 'GAME_E') {
    const ids = activePlayers().map((p) => p.playerId);
    const pairs = [];
    for (let i = 0; i < ids.length; i += 2) {
      if (ids[i + 1]) pairs.push([ids[i], ids[i + 1]]);
      else pairs.push([ids[i], null]);
    }
    SESSION.gameState = { key: 'GAME_E', round: 1, maxRounds: 3, pairs, choices: {}, completed: false, byeBonus: 2 };
  } else if (phase === 'COUNCIL') {
    SESSION.gameState = { key: 'COUNCIL', votes: {}, noSelfVote: true, completed: false };
  } else if (phase === 'FINAL') {
    const finalists = rankPlayers().filter((p) => !p.eliminated).slice(0, SESSION.finaleTop);
    SESSION.gameState = { key: 'FINAL', finalists: finalists.map((f) => f.playerId), question: 'Question finale: Combien de minutes dure 1 heure ?', answer: '60', bets: {}, answers: {}, completed: false };
  } else {
    SESSION.gameState = { key: phase };
  }
}

function resolveGameA() {
  const votes = SESSION.gameState.answers;
  const tally = {};
  Object.values(votes).forEach((target) => { tally[target] = (tally[target] || 0) + 1; });
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const p of SESSION.players.values()) {
    ensurePlayerScore(p);
    if (votes[p.playerId] === top) p.score += 1;
    if (p.playerId === top) p.score += 2;
  }
  SESSION.history.push({ at: nowIso(), game: 'A', winner: top, tally });
  publishResults({ game: 'A', tally, top });
}

function resolveGameB() {
  const a = SESSION.gameState.answers;
  const correct = norm(SESSION.gameState.answer);
  const entries = Object.entries(a).filter(([, v]) => norm(v.answer) === correct).sort((x, y) => x[1].at - y[1].at);
  entries.forEach(([pid], idx) => {
    const p = SESSION.players.get(pid);
    if (!p) return;
    ensurePlayerScore(p);
    p.score += 2;
    if (idx === 0) p.score += 1;
  });
  SESSION.history.push({ at: nowIso(), game: 'B', correct, winners: entries.map(([pid]) => pid) });
  publishResults({ game: 'B', correct, winners: entries.map(([pid]) => pid) });
}

function resolveGameC() {
  const real = Number(SESSION.gameState.realPrice);
  const list = Object.entries(SESSION.gameState.answers).map(([pid, v]) => ({ pid, value: Number(v) }));
  const valid = list.filter((x) => !Number.isNaN(x.value));
  valid.sort((a, b) => Math.abs(a.value - real) - Math.abs(b.value - real));
  const first = valid[0]?.pid;
  const second = valid[1]?.pid;
  valid.forEach((x) => {
    const p = SESSION.players.get(x.pid);
    if (!p) return;
    ensurePlayerScore(p);
    if (SESSION.gameState.withoutOver && x.value > real) p.score -= 1;
  });
  if (first && SESSION.players.get(first)) SESSION.players.get(first).score += 3;
  if (second && SESSION.players.get(second)) SESSION.players.get(second).score += 1;
  SESSION.history.push({ at: nowIso(), game: 'C', real, first, second });
  publishResults({ game: 'C', real, first, second, answers: valid });
}

function resolveGameD() {
  const expected = (SESSION.gameState.expected || []).map(norm);
  const results = {};
  Object.entries(SESSION.gameState.answers).forEach(([pid, arr]) => {
    const guessed = (arr || []).map(norm);
    const hit = guessed.filter((x) => expected.includes(x)).length;
    const p = SESSION.players.get(pid);
    if (!p) return;
    ensurePlayerScore(p);
    p.score += hit;
    if (hit >= 3) p.score += 2;
    results[pid] = hit;
  });
  SESSION.history.push({ at: nowIso(), game: 'D', expected, results });
  publishResults({ game: 'D', expected, results });
}

function resolveGameERound() {
  const choices = SESSION.gameState.choices;
  const gains = {};
  SESSION.gameState.pairs.forEach(([a, b]) => {
    if (!b) { gains[a] = (gains[a] || 0) + SESSION.gameState.byeBonus; return; }
    const ca = choices[a]; const cb = choices[b];
    if (!ca || !cb) return;
    const pa = ca === 'SHARE'; const pb = cb === 'SHARE';
    if (pa && pb) { gains[a] = (gains[a] || 0) + 3; gains[b] = (gains[b] || 0) + 3; }
    else if (!pa && pb) { gains[a] = (gains[a] || 0) + 5; gains[b] = (gains[b] || 0) + 0; }
    else if (pa && !pb) { gains[a] = (gains[a] || 0) + 0; gains[b] = (gains[b] || 0) + 5; }
    else { gains[a] = (gains[a] || 0) + 1; gains[b] = (gains[b] || 0) + 1; }
  });
  Object.entries(gains).forEach(([pid, pts]) => {
    const p = SESSION.players.get(pid); if (!p) return; ensurePlayerScore(p); p.score += pts;
  });
  SESSION.history.push({ at: nowIso(), game: 'E', round: SESSION.gameState.round, gains });
  publishResults({ game: 'E', round: SESSION.gameState.round, gains, choices });
}

function resolveCouncil() {
  const tally = {};
  Object.entries(SESSION.gameState.votes).forEach(([, target]) => {
    if (!target || target === SESSION.immunityPlayerId) return;
    tally[target] = (tally[target] || 0) + 1;
  });
  const loser = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  if (loser) {
    const p = SESSION.players.get(loser);
    if (p) {
      if (SESSION.councilMode === 'ELIMINATION') p.eliminated = true;
      else p.score -= SESSION.councilPenalty;
    }
  }
  SESSION.history.push({ at: nowIso(), council: { tally, loser, mode: SESSION.councilMode, immunity: SESSION.immunityPlayerId } });
  publishResults({ game: 'COUNCIL', tally, loser, mode: SESSION.councilMode, immunity: SESSION.immunityPlayerId });
}

function resolveFinal() {
  const answer = norm(SESSION.gameState.answer);
  const winners = [];
  SESSION.gameState.finalists.forEach((pid) => {
    const p = SESSION.players.get(pid); if (!p) return;
    ensurePlayerScore(p);
    const bet = Math.max(0, Math.min(5, Number(SESSION.gameState.bets[pid] || 0)));
    const a = norm(SESSION.gameState.answers[pid] || '');
    if (a === answer) { p.score += bet; winners.push(pid); }
    else p.score -= bet;
  });
  const podium = rankPlayers().slice(0, 3).map((p) => p.playerId);
  SESSION.history.push({ at: nowIso(), game: 'FINAL', winners, podium });
  publishResults({ game: 'FINAL', winners, podium });
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
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  if (pathname === '/healthz') return sendJson(res, 200, { ok: true, phase: SESSION.phase });
  if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(publicDir, 'index.html'));
  if (pathname === '/admin') return serveFile(res, path.join(publicDir, 'admin.html'));
  if (pathname === '/join') return serveFile(res, path.join(publicDir, 'join.html'));
  if (pathname === '/tv') return serveFile(res, path.join(publicDir, 'tv.html'));
  const fp = path.join(publicDir, pathname.replace(/^\/+/, ''));
  if (!fp.startsWith(publicDir)) return sendJson(res, 403, { error: 'Forbidden' });
  if (fs.existsSync(fp)) return serveFile(res, fp);
  return sendJson(res, 404, { error: 'Not found' });
});

const io = new Server(server, { cors: { origin: CORS_ORIGIN, credentials: true }, transports: ['websocket', 'polling'] });

function isAdmin(socket) { return SESSION.adminSocketId === socket.id; }

io.on('connection', (socket) => {
  socket.emit('game:state', buildState());

  socket.on('admin:auth', ({ password }, ack) => {
    if (password !== ADMIN_PASSWORD) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    if (SESSION.adminSocketId && SESSION.adminSocketId !== socket.id) io.to(SESSION.adminSocketId).emit('admin:revoked', { reason: 'NEW_ADMIN_CONNECTED' });
    SESSION.adminSocketId = socket.id;
    ack?.({ ok: true, state: buildState() });
    broadcastState();
  });

  socket.on('admin:command', ({ command, payload }, ack) => {
    if (!isAdmin(socket)) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
    if (command === 'START') {
      SESSION.started = true; setPhase('INTRO'); startTimer(10); initPhaseState('INTRO');
    } else if (command === 'NEXT') {
      if (SESSION.phase === 'GAME_A') resolveGameA();
      if (SESSION.phase === 'GAME_B') resolveGameB();
      if (SESSION.phase === 'GAME_C') resolveGameC();
      if (SESSION.phase === 'GAME_D') resolveGameD();
      if (SESSION.phase === 'GAME_E') resolveGameERound();
      if (SESSION.phase === 'COUNCIL') resolveCouncil();
      if (SESSION.phase === 'FINAL') resolveFinal();
      nextPhase(); initPhaseState(SESSION.phase);
    } else if (command === 'PAUSE') { SESSION.paused = true; pauseTimer(); }
    else if (command === 'RESUME') { SESSION.paused = false; resumeTimer(); }
    else if (command === 'LOCK_ANSWERS') { SESSION.answerLocked = !!payload?.locked; }
    else if (command === 'FORCE_END') {
      if (SESSION.phase.startsWith('GAME_')) {
        if (SESSION.phase === 'GAME_A') resolveGameA();
        if (SESSION.phase === 'GAME_B') resolveGameB();
        if (SESSION.phase === 'GAME_C') resolveGameC();
        if (SESSION.phase === 'GAME_D') resolveGameD();
        if (SESSION.phase === 'GAME_E') resolveGameERound();
      }
      if (SESSION.phase === 'COUNCIL') resolveCouncil();
      if (SESSION.phase === 'FINAL') resolveFinal();
      nextPhase(); initPhaseState(SESSION.phase);
    } else if (command === 'RESET_PHASE') { initPhaseState(SESSION.phase); }
    else if (command === 'SKIP') { nextPhase(); initPhaseState(SESSION.phase); }
    else if (command === 'SET_IMMUNITY') { SESSION.immunityPlayerId = payload?.playerId || null; }
    else if (command === 'SET_COUNCIL_MODE') { SESSION.councilMode = payload?.mode === 'PENALTY' ? 'PENALTY' : 'ELIMINATION'; }
    else if (command === 'TV_SCREEN') { if (TV_SCREENS.includes(payload?.screen)) SESSION.phase = payload.screen; }
    touch();
    broadcastState();
    ack?.({ ok: true });
  });

  socket.on('room:join', ({ playerId, reconnectToken, name, animal }, ack) => {
    const pid = String(playerId || crypto.randomUUID());
    const token = String(reconnectToken || crypto.randomUUID());
    const existing = SESSION.players.get(pid);
    if (existing && existing.reconnectToken !== token) return ack?.({ ok: false, error: 'INVALID_RECONNECT_TOKEN' });
    const p = existing || { playerId: pid, reconnectToken: token, name: safeName(name), animal: safeAnimal(animal), ready: false, status: 'CONNECTED', score: 0, eliminated: false, lastSeenAt: nowIso() };
    p.name = safeName(name || p.name); p.animal = safeAnimal(animal || p.animal); p.status = 'CONNECTED'; p.lastSeenAt = nowIso();
    SESSION.players.set(pid, p); SESSION.socketsByPlayerId.set(socket.id, pid); socket.data.playerId = pid;
    touch();
    broadcastState();
    io.emit('presence:update', { playerId: pid, status: 'CONNECTED', lastSeenAt: p.lastSeenAt });
    ack?.({ ok: true, player: { ...p } });
  });

  socket.on('player:update', ({ playerId, ready }, ack) => {
    const p = SESSION.players.get(String(playerId || socket.data.playerId || ''));
    if (!p) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
    if (typeof ready !== 'undefined') p.ready = !!ready;
    p.lastSeenAt = nowIso();
    touch(); broadcastState(); ack?.({ ok: true });
  });

  socket.on('game:action', ({ type, payload }, ack) => {
    const pid = String(socket.data.playerId || payload?.playerId || '');
    const p = SESSION.players.get(pid);
    if (!p) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
    if (!phaseAllowsActions()) return ack?.({ ok: false, error: 'PHASE_LOCKED' });

    if (SESSION.phase === 'GAME_A' && type === 'A_VOTE') {
      if (SESSION.gameState.answers[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      SESSION.gameState.answers[pid] = payload?.targetPlayerId || '';
    } else if (SESSION.phase === 'GAME_B' && type === 'B_ANSWER') {
      if (SESSION.gameState.answers[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      SESSION.gameState.answers[pid] = { answer: String(payload?.answer || ''), at: now() };
    } else if (SESSION.phase === 'GAME_C' && type === 'C_GUESS') {
      if (SESSION.gameState.answers[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      SESSION.gameState.answers[pid] = Number(payload?.value);
    } else if (SESSION.phase === 'GAME_D' && type === 'D_TOP3') {
      if (SESSION.gameState.answers[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      SESSION.gameState.answers[pid] = Array.isArray(payload?.answers) ? payload.answers.slice(0, 3) : [];
    } else if (SESSION.phase === 'GAME_E' && type === 'E_CHOICE') {
      if (SESSION.gameState.choices[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      SESSION.gameState.choices[pid] = payload?.choice === 'BETRAY' ? 'BETRAY' : 'SHARE';
    } else if (SESSION.phase === 'COUNCIL' && type === 'COUNCIL_VOTE') {
      if (SESSION.gameState.votes[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      const target = payload?.targetPlayerId;
      if (SESSION.gameState.noSelfVote && target === pid) return ack?.({ ok: false, error: 'NO_SELF_VOTE' });
      SESSION.gameState.votes[pid] = target;
    } else if (SESSION.phase === 'FINAL' && type === 'FINAL_BET_ANSWER') {
      if (!SESSION.gameState.finalists.includes(pid)) return ack?.({ ok: false, error: 'NOT_FINALIST' });
      if (SESSION.gameState.answers[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      SESSION.gameState.bets[pid] = Math.max(0, Math.min(5, Number(payload?.bet || 0)));
      SESSION.gameState.answers[pid] = String(payload?.answer || '');
    } else return ack?.({ ok: false, error: 'INVALID_ACTION' });

    touch();
    broadcastState();
    ack?.({ ok: true, receivedAt: nowIso() });
  });

  socket.on('disconnect', () => {
    if (SESSION.adminSocketId === socket.id) SESSION.adminSocketId = null;
    const pid = SESSION.socketsByPlayerId.get(socket.id);
    if (pid && SESSION.players.has(pid)) {
      const p = SESSION.players.get(pid);
      p.status = 'DISCONNECTED'; p.lastSeenAt = nowIso();
      SESSION.socketsByPlayerId.delete(socket.id);
      touch(); broadcastState();
      io.emit('presence:update', { playerId: pid, status: 'DISCONNECTED', lastSeenAt: p.lastSeenAt });
    }
  });
});

setInterval(() => {
  if (!SESSION.phaseTimer.running || !SESSION.phaseTimer.endsAt) return;
  const remaining = SESSION.phaseTimer.endsAt - now();
  if (remaining <= 0) {
    SESSION.phaseTimer.running = false;
    SESSION.phaseTimer.remainingMs = 0;
    SESSION.phaseTimer.endsAt = null;
    touch();
    broadcastState();
  } else {
    SESSION.phaseTimer.remainingMs = remaining;
  }
}, 250);

server.listen(PORT, () => console.log(`Koh Lanta engine running on http://localhost:${PORT}`));
