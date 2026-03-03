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
  freeQuestions: readConfig(path.join('..', 'public', 'free-questions.json'), []),
  price: readConfig('priceisright_items.json', []),
  top3: readConfig('top3_themes.json', [])
};

function buildGameCatalog() {
  return {
    GAME_A: CONFIG.susceptibleQuestions.map((q, idx) => ({ index: idx, label: String(q || `Question ${idx + 1}`) })),
    GAME_B: [{ index: 0, label: '1 bonne réponse par question' }],
    GAME_C: CONFIG.price.map((q, idx) => ({ index: idx, label: String(q?.item || `Objet ${idx + 1}`) })),
    GAME_D: CONFIG.blindtest.map((q, idx) => ({ index: idx, label: String(q?.prompt || `Chanson ${idx + 1}`) })),
    GAME_F: [{ index: 0, label: 'Vise bien ou fais toi des amis' }],
    GAME_G: [{ index: 0, label: 'Imposteurs' }]
  };
}

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
  paused: false,
  resultsShown: false,
  tvMuted: false,
  lastTvAudioError: null,
  previewGame: null,
  lastAward: null,
  joinSeqCounter: 0,
  lastScoreDeltas: {}
};

let gameBTimer = null;

function gameBrief(game){
  const map={
    GAME_A:{title:'Jeu A — Susceptible de...',rules:'Vote pour un joueur',points:'+1 vote sur top, -2 plus cité'},
    GAME_B:{title:'Jeu B — 1 bonne réponse par question',rules:'Questions libres chronométrées',points:'+1 par réponse validée admin'},
    GAME_C:{title:'Jeu C — Le juste prix',rules:'Estimer le prix en DH',points:'+3 premier, +1 second'},
    GAME_D:{title:'Jeu D — Blind test',rules:'Trouver titre et artiste',points:'0,5 point titre + 0,5 point artiste'},
    GAME_F:{title:'Jeu F — Tir à l\'arc',rules:'Viser puis casser une flèche',points:'Selon résultats'},
    GAME_G:{title:'Jeu G — Imposteurs',rules:'Désigner un joueur voté',points:'Imposteur trouvé: neutres +1, sinon imposteurs +2'}
  };
  return map[game]||{title:game,rules:'',points:''};
}

function now() { return Date.now(); }
function nowIso() { return new Date().toISOString(); }
function norm(s) { return String(s || '').trim().toLowerCase(); }
function safeName(v) { return String(v || '').trim().slice(0, 24) || 'Aventurier'; }
function safeAnimal(v) { return String(v || '').trim().slice(0, 24) || 'Tigre'; }
function touch() { SESSION.updatedAt = nowIso(); }
function phaseAllowsActions() { return SESSION.started && !SESSION.paused && !SESSION.answerLocked; }
function activePlayers() { return [...SESSION.players.values()].filter((p) => !p.eliminated); }

function gameProgress() {
  if (!SESSION.phase?.startsWith('GAME_') && SESSION.phase !== 'COUNCIL' && SESSION.phase !== 'FINAL') return { answeredPlayerIds: [], pendingPlayerIds: [] };
  if (!SESSION.gameState) return { answeredPlayerIds: [], pendingPlayerIds: [] };
  const alive = activePlayers().map((p) => p.playerId);
  const answeredSet = new Set();

  if (SESSION.gameState.answers) Object.keys(SESSION.gameState.answers).forEach((pid) => answeredSet.add(pid));
  if (SESSION.phase === 'GAME_B' && SESSION.gameState?.answersByQuestion && typeof SESSION.gameState?.currentIndex === 'number') {
    const bucket = SESSION.gameState.answersByQuestion[SESSION.gameState.currentIndex] || {};
    Object.keys(bucket).forEach((pid) => answeredSet.add(pid));
  }
  if (SESSION.gameState.choices) Object.keys(SESSION.gameState.choices).forEach((pid) => answeredSet.add(pid));
  if (SESSION.gameState.votes) Object.keys(SESSION.gameState.votes).forEach((pid) => answeredSet.add(pid));
  if (SESSION.phase === 'GAME_F' && SESSION.gameState.shots) {
    Object.entries(SESSION.gameState.shots).forEach(([pid, shot]) => {
      if (typeof shot?.vertical === 'number' && typeof shot?.horizontal === 'number') answeredSet.add(pid);
    });
  }

  let trackable = SESSION.phase === 'FINAL' && Array.isArray(SESSION.gameState.finalists)
    ? alive.filter((pid) => SESSION.gameState.finalists.includes(pid))
    : alive;
  if (SESSION.phase === 'GAME_F' && Array.isArray(SESSION.gameState.contenders)) {
    trackable = alive.filter((pid) => SESSION.gameState.contenders.includes(pid));
    if (SESSION.gameState.stage === 'BREAK_SELECT' && SESSION.gameState.closest) {
      trackable = [SESSION.gameState.closest];
      if (SESSION.gameState.breakChoice?.target) answeredSet.add(SESSION.gameState.closest);
    }
  }

  const answered = trackable.filter((pid) => answeredSet.has(pid));
  const pending = trackable.filter((pid) => !answeredSet.has(pid));
  return { answeredPlayerIds: answered, pendingPlayerIds: pending };
}

function ensurePlayerScore(p) { if (typeof p.score !== 'number') p.score = 0; }
function ensurePlayerArrows(p) { if (typeof p.arrows !== 'number') p.arrows = 2; }
function addScore(pid, delta){
  const p=SESSION.players.get(pid); if(!p) return;
  ensurePlayerScore(p);
  p.score += Number(delta)||0;
  SESSION.lastScoreDeltas[pid] = (SESSION.lastScoreDeltas[pid] || 0) + (Number(delta)||0);
}

function rankPlayers() {
  return [...SESSION.players.values()]
    .sort((a, b) => (b.score - a.score) || ((a.joinSeq ?? 0) - (b.joinSeq ?? 0)) || a.name.localeCompare(b.name))
    .map((p, idx, arr) => ({
      playerId: p.playerId,
      name: p.name,
      animal: p.animal,
      status: p.status,
      ready: p.ready,
      score: p.score,
      arrows: typeof p.arrows === 'number' ? p.arrows : 2,
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
    resultsShown: SESSION.resultsShown,
    tvMuted: SESSION.tvMuted,
    lastTvAudioError: SESSION.lastTvAudioError,
    councilMode: SESSION.councilMode,
    councilPenalty: SESSION.councilPenalty,
    immunityPlayerId: SESSION.immunityPlayerId,
    finaleTop: SESSION.finaleTop,
    playerCount: SESSION.players.size,
    rankings: rankPlayers(),
    gameState: SESSION.gameState,
    gameAProgress: gameProgress(),
    gameProgress: gameProgress(),
    history: SESSION.history.slice(-10),
    gameCatalog: buildGameCatalog(),
    previewGame: SESSION.previewGame || null,
    lastAward: SESSION.lastAward || null,
    lastScoreDeltas: SESSION.lastScoreDeltas || {}
  };
}

function broadcastState() {
  io.emit('game:state', buildState());
}
function publishResults(payload) {
  io.emit('results:publish', payload);
}

function setPhase(phase) {
  if (SESSION.phase === 'GAME_B' && phase !== 'GAME_B') clearGameBTimer();
  SESSION.phase = phase;
  SESSION.phaseIndex = FLOW.indexOf(phase);
  SESSION.phaseStartedAt = nowIso();
  SESSION.answerLocked = false;
  SESSION.paused = false;
  SESSION.previewGame = null;
  SESSION.lastAward = null;
  SESSION.phaseTimer = { running: false, endsAt: null, remainingMs: 0 };
  SESSION.resultsShown = false;
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

function initPhaseState(phase, options = {}) {
  if (phase === 'GAME_A') {
    const selectedIndex = Math.max(0, Number(options?.index || 0));
    SESSION.gameState = { key: 'GAME_A', index: selectedIndex, question: CONFIG.susceptibleQuestions[selectedIndex] || '', answers: {}, completed: false };
  } else if (phase === 'GAME_B') {
    const count = Math.max(1, Math.min(15, Number(options?.count || 1)));
    const seconds = Math.max(15, Math.min(30, Number(options?.seconds || 20)));
    const bank = Array.isArray(CONFIG.freeQuestions) ? CONFIG.freeQuestions : [];
    const shuffled = [...bank].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(count, shuffled.length));
    SESSION.gameState = {
      key: 'GAME_B',
      title: '1 bonne réponse par question',
      stage: 'QUESTION',
      questions: picked.map((q, idx) => ({
        index: idx,
        prompt: String(q?.q || `Question ${idx + 1}`),
        answer: String(q?.a || '')
      })),
      secondsPerQuestion: seconds,
      currentIndex: -1,
      reviewIndex: 0,
      answersByQuestion: {},
      completed: false
    };
    advanceGameBQuestion();
  } else if (phase === 'GAME_C') {
    const selectedIndex = Math.max(0, Number(options?.index || 0));
    const manualItem = String(options?.manualItem || '').trim();
    const manualPrice = Number(options?.manualPrice);
    const baseItem = CONFIG.price[selectedIndex] || { item: 'Objet mystère', price: 100 };
    const item = manualItem ? { item: manualItem, price: Number.isFinite(manualPrice) ? manualPrice : baseItem.price } : baseItem;
    SESSION.gameState = { key: 'GAME_C', index: selectedIndex, item: item.item, realPrice: Number(item.price) || 0, withoutOver: true, answers: {}, completed: false };
  } else if (phase === 'GAME_D') {
    const selectedIndex = Math.max(0, Number(options?.index || 0));
    const bank = Array.isArray(CONFIG.blindtest) ? CONFIG.blindtest : [];
    const q = bank[selectedIndex] || { prompt: 'Blind test', answer: '' };
    SESSION.gameState = { key: 'GAME_D', stage: 'PREVIEW', index: selectedIndex, prompt: q.prompt || 'Blind test', answer: String(q.answer||''), answers: {}, awardsByPid: {}, completed: false };
  } else if (phase === 'GAME_E') {
    const ids = activePlayers().map((p) => p.playerId);
    const pairs = [];
    for (let i = 0; i < ids.length; i += 2) {
      if (ids[i + 1]) pairs.push([ids[i], ids[i + 1]]);
      else pairs.push([ids[i], null]);
    }
    SESSION.gameState = { key: 'GAME_E', round: 1, maxRounds: 3, pairs, choices: {}, completed: false, byeBonus: 2 };
  } else if (phase === 'GAME_F') {
    const contenders = activePlayers().map((p) => p.playerId).filter((pid) => {
      const pl = SESSION.players.get(pid); ensurePlayerArrows(pl); return pl.arrows > 0;
    });
    const playerColors = {};
    contenders.forEach((pid, idx) => { playerColors[pid] = ['#ff595e','#ffca3a','#8ac926','#1982c4','#6a4c93','#f72585','#4cc9f0','#ffd166'][idx % 8]; });
    SESSION.gameState = { key: 'GAME_F', name: 'Vise bien ou fais toi des amis', stage: 'AIM', shots: {}, breakChoice: null, results: null, contenders, playerColors, completed: false };
  } else if (phase === 'GAME_G') {
    const ids = activePlayers().map((p)=>p.playerId);
    const shuffled=[...ids].sort(()=>Math.random()-0.5);
    const impCount=Math.max(1, Math.min(2, Math.floor(ids.length/3)||1));
    const roles={};
    ids.forEach((pid,idx)=>{ roles[pid]=idx<impCount?'IMPOSTOR':'NEUTRAL'; });
    shuffled.slice(0,impCount).forEach((pid)=>roles[pid]='IMPOSTOR');
    SESSION.gameState = { key:'GAME_G', roles, selectedPlayerId:null, announced:false, results:null };
  } else if (phase === 'COUNCIL') {
    SESSION.gameState = { key: 'COUNCIL', votes: {}, noSelfVote: true, completed: false };
  } else if (phase === 'FINAL') {
    const finalists = rankPlayers().filter((p) => !p.eliminated).slice(0, SESSION.finaleTop);
    SESSION.gameState = { key: 'FINAL', finalists: finalists.map((f) => f.playerId), question: 'Question finale: Combien de minutes dure 1 heure ?', answer: '60', bets: {}, answers: {}, completed: false };
  } else {
    SESSION.gameState = { key: phase };
  }
}

function clearGameBTimer() {
  if (gameBTimer) {
    clearTimeout(gameBTimer);
    gameBTimer = null;
  }
}

function serializeGameBAnswers(index) {
  const out = [];
  const bucket = SESSION.gameState?.answersByQuestion?.[index] || {};
  for (const [pid, rec] of Object.entries(bucket)) {
    const name = SESSION.players.get(pid)?.name || pid;
    out.push({ playerId: pid, name, answer: rec.answer || '', validated: !!rec.validated, at: rec.at || 0 });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function setGameBReview(index) {
  const qCount = SESSION.gameState.questions.length;
  const next = Math.max(0, Math.min(qCount - 1, Number(index || 0)));
  SESSION.gameState.reviewIndex = next;
  SESSION.gameState.stage = 'REVIEW';
  SESSION.gameState.completed = true;
  SESSION.gameState.reviewAnswers = serializeGameBAnswers(next);
}

function enterGameBReview() {
  clearGameBTimer();
  if (!SESSION.gameState?.questions?.length) return;
  setGameBReview(0);
  SESSION.answerLocked = true;
  SESSION.resultsShown = true;
}

function advanceGameBQuestion() {
  if (SESSION.phase !== 'GAME_B') return;
  const g = SESSION.gameState || {};
  if (!Array.isArray(g.questions) || !g.questions.length) return;
  const next = g.currentIndex + 1;
  if (next >= g.questions.length) {
    enterGameBReview();
    touch();
    broadcastState();
    return;
  }
  clearGameBTimer();
  g.currentIndex = next;
  g.stage = 'QUESTION';
  g.questionStartedAt = nowIso();
  g.currentAnswers = serializeGameBAnswers(next);
  startTimer(g.secondsPerQuestion);
  gameBTimer = setTimeout(() => {
    if (SESSION.phase !== 'GAME_B' || SESSION.gameState?.stage !== 'QUESTION') return;
    advanceGameBQuestion();
  }, g.secondsPerQuestion * 1000);
  touch();
  broadcastState();
}

function resolveGameA() {
  const votes = SESSION.gameState.answers;
  const tally = {};
  Object.values(votes).forEach((target) => { tally[target] = (tally[target] || 0) + 1; });

  const sortedTop = Object.entries(tally).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const top3 = sortedTop.slice(0, 3).map(([playerId, votesCount]) => ({ playerId, votesCount }));
  const top = top3[0]?.playerId || null;

  const voteCountsByPlayer = Object.fromEntries(sortedTop.map(([pid, count]) => [pid, count]));
  const impacts = {};
  for (const p of SESSION.players.values()) {
    ensurePlayerScore(p);
    let delta = 0;
    const votedFor = votes[p.playerId];
    if (votedFor && top && votedFor === top) delta += 1;
    if (votedFor && top && votedFor !== top) delta += 0;
    if (p.playerId === top) delta -= 2;
    if (votedFor && voteCountsByPlayer[votedFor] === 1) delta -= 1;
    p.score += delta;
    impacts[p.playerId] = delta;
  }
  const payload = { game: 'A', tally, top, top3, impacts };
  SESSION.gameState.results = payload;
  SESSION.history.push({ at: nowIso(), game: 'A', winner: top, tally, top3, impacts });
  publishResults(payload);
}

function showResultsCurrentPhase() {
  if (SESSION.resultsShown) return;
  if (SESSION.phase === 'GAME_A') resolveGameA();
  else if (SESSION.phase === 'GAME_B') {
    if (SESSION.gameState?.stage === 'QUESTION') enterGameBReview();
    resolveGameB();
  }
  else if (SESSION.phase === 'GAME_C') resolveGameC();
  else if (SESSION.phase === 'GAME_D') resolveGameD();
  else if (SESSION.phase === 'GAME_E') resolveGameERound();
  else if (SESSION.phase === 'GAME_F') resolveGameF();
  else if (SESSION.phase === 'GAME_G') resolveGameG();
  else if (SESSION.phase === 'COUNCIL') resolveCouncil();
  else if (SESSION.phase === 'FINAL') resolveFinal();
  else return;
  if (SESSION.phase === 'GAME_F' && SESSION.gameState?.stage === 'BREAK_SELECT') {
    SESSION.answerLocked = false;
    SESSION.resultsShown = true;
    return;
  }
  SESSION.answerLocked = true;
  SESSION.resultsShown = true;
}

function resetSession() {
  clearGameBTimer();
  SESSION.players.clear();
  SESSION.socketsByPlayerId.clear();
  SESSION.phase = 'LOBBY';
  SESSION.phaseIndex = FLOW.indexOf('LOBBY');
  SESSION.phaseStartedAt = null;
  SESSION.phaseTimer = { running: false, endsAt: null, remainingMs: 0 };
  SESSION.answerLocked = false;
  SESSION.resultsShown = false;
  SESSION.gameState = {};
  SESSION.history = [];
  SESSION.immunityPlayerId = null;
  SESSION.started = false;
  SESSION.paused = false;
  SESSION.previewGame = null;
  SESSION.lastAward = null;
  SESSION.joinSeqCounter = 0;
}

function resolveGameB() {
  const g = SESSION.gameState || {};
  const payload = {
    game: 'B',
    mode: 'manual_review',
    questions: (g.questions || []).map((q, idx) => ({
      index: idx,
      question: q.prompt,
      expected: q.answer,
      answers: serializeGameBAnswers(idx)
    }))
  };
  SESSION.gameState.results = payload;
  SESSION.history.push({ at: nowIso(), game: 'B', reviewed: payload.questions.length });
  publishResults(payload);
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
  const payload = { game: 'C', real, first, second, answers: valid };
  SESSION.gameState.results = payload;
  SESSION.history.push({ at: nowIso(), game: 'C', real, first, second });
  publishResults(payload);
}

function resolveGameD() {
  const payload = { game: 'D', mode: 'blindtest', prompt: SESSION.gameState.prompt || '', answers: SESSION.gameState.answers || {}, awardsByPid: SESSION.gameState.awardsByPid || {} };
  SESSION.gameState.results = payload;
  SESSION.history.push({ at: nowIso(), game: 'D', prompt: payload.prompt });
  publishResults(payload);
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
  const payload = { game: 'E', round: SESSION.gameState.round, gains, choices };
  SESSION.gameState.results = payload;
  SESSION.history.push({ at: nowIso(), game: 'E', round: SESSION.gameState.round, gains });
  publishResults(payload);
}


function resolveGameF() {
  const contenders = (SESSION.gameState.contenders || []).filter((pid) => {
    const p = SESSION.players.get(pid); if (!p) return false; ensurePlayerArrows(p); return p.arrows > 0;
  });
  const shots = SESSION.gameState.shots || {};
  const firedEntries = [];
  const noShot = [];
  contenders.forEach((pid) => {
    const shot = shots[pid] || {};
    if (typeof shot.horizontal !== 'number' || typeof shot.vertical !== 'number') {
      noShot.push(pid);
      const p = SESSION.players.get(pid);
      if (p) { ensurePlayerArrows(p); p.arrows = Math.max(0, p.arrows - 1); }
      return;
    }
    const x = Math.max(-100, Math.min(100, Number(shot.horizontal || 0)));
    const y = Math.max(-100, Math.min(100, Number(shot.vertical || 0)));
    const distance = Math.sqrt((x * x) + (y * y));
    firedEntries.push({ pid, x, y, distance });
  });
  if (!firedEntries.length) {
    const alive = activePlayers().filter((pl) => { ensurePlayerArrows(pl); return pl.arrows > 0; });
    const winner = alive.length === 1 ? alive[0].playerId : null;
    const payloadNoShot = { game: 'F', stage: 'AIM', shots: [], closest: null, farthest: null, noShot, winner, playerColors: SESSION.gameState.playerColors || {} };
    SESSION.gameState.stage = 'AIM';
    SESSION.gameState.results = payloadNoShot;
    if (!winner) SESSION.gameState.shots = {};
    publishResults(payloadNoShot);
    return;
  }
  firedEntries.sort((a, b) => a.distance - b.distance);
  const closest = firedEntries[0]?.pid || null;
  const farthest = firedEntries[firedEntries.length - 1]?.pid || null;
  if (farthest && SESSION.players.get(farthest)) {
    ensurePlayerArrows(SESSION.players.get(farthest));
    SESSION.players.get(farthest).arrows = Math.max(0, SESSION.players.get(farthest).arrows - 1);
  }
  const payload = { game: 'F', stage: 'BREAK_SELECT', shots: firedEntries, closest, farthest, noShot, playerColors: SESSION.gameState.playerColors || {} };
  SESSION.gameState.stage = 'BREAK_SELECT';
  SESSION.gameState.results = payload;
  SESSION.gameState.closest = closest;
  SESSION.gameState.farthest = farthest;
  SESSION.history.push({ at: nowIso(), game: 'F', closest, farthest, noShot, shots: firedEntries });
  publishResults(payload);
}

function resolveGameG() {
  const g=SESSION.gameState||{};
  const roles=g.roles||{};
  const selected=String(g.selectedPlayerId||'');
  if(!selected) return;
  const isImp = roles[selected]==='IMPOSTOR';
  const gains={};
  Object.entries(roles).forEach(([pid,role])=>{
    if(isImp && role!=='IMPOSTOR'){ addScore(pid,1); gains[pid]=1; }
    if(!isImp && role==='IMPOSTOR'){ addScore(pid,2); gains[pid]=2; }
  });
  const payload={game:'G', selectedPlayerId:selected, selectedRole:roles[selected]||'NEUTRAL', gains};
  SESSION.gameState.results=payload;
  SESSION.gameState.announced=true;
  publishResults(payload);
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
  const payload = { game: 'COUNCIL', tally, loser, mode: SESSION.councilMode, immunity: SESSION.immunityPlayerId };
  SESSION.gameState.results = payload;
  SESSION.history.push({ at: nowIso(), council: payload });
  publishResults(payload);
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
  const payload = { game: 'FINAL', winners, podium };
  SESSION.gameState.results = payload;
  SESSION.history.push({ at: nowIso(), game: 'FINAL', winners, podium });
  publishResults(payload);
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
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  let decodedPathname = pathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad Request' });
  }
  if (pathname === '/healthz') return sendJson(res, 200, { ok: true, phase: SESSION.phase });
  if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(publicDir, 'index.html'));
  if (pathname === '/admin') return serveFile(res, path.join(publicDir, 'admin.html'));
  if (pathname === '/join') return serveFile(res, path.join(publicDir, 'join.html'));
  if (pathname === '/tv') return serveFile(res, path.join(publicDir, 'tv.html'));
  const fp = path.resolve(publicDir, `.${decodedPathname}`);
  if (fp !== publicDir && !fp.startsWith(`${publicDir}${path.sep}`)) return sendJson(res, 403, { error: 'Forbidden' });
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
    else if (command === 'LAUNCH_GAME') {
      const game = String(payload?.game || 'GAME_A');
      const allowedGames = ['GAME_A', 'GAME_B', 'GAME_C', 'GAME_D', 'GAME_F', 'GAME_G'];
      if (!allowedGames.includes(game)) return ack?.({ ok: false, error: 'UNSUPPORTED_GAME' });
      SESSION.started = true;
      setPhase(game);
      initPhaseState(game, {
        index: Number(payload?.questionIndex || 0),
        count: Number(payload?.count || 1),
        seconds: Number(payload?.seconds || 20),
        manualItem: String(payload?.manualItem || ''),
        manualPrice: Number(payload?.manualPrice)
      });
      SESSION.previewGame = { game, ...gameBrief(game) };
      if (game !== 'GAME_D') SESSION.previewGame = null;
    }
    else if (command === 'GAME_B_REVIEW_GOTO') {
      if (SESSION.phase !== 'GAME_B') return ack?.({ ok: false, error: 'INVALID_PHASE' });
      if (!Array.isArray(SESSION.gameState?.questions) || !SESSION.gameState.questions.length) return ack?.({ ok: false, error: 'NO_QUESTIONS' });
      setGameBReview(Number(payload?.index || 0));
      resolveGameB();
    }
    else if (command === 'GAME_B_TOGGLE_VALIDATE') {
      if (SESSION.phase !== 'GAME_B') return ack?.({ ok: false, error: 'INVALID_PHASE' });
      if (SESSION.gameState?.stage !== 'REVIEW') return ack?.({ ok: false, error: 'NOT_IN_REVIEW' });
      const qIdx = SESSION.gameState.reviewIndex;
      const pid = String(payload?.playerId || '');
      if (!pid) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
      const bucket = SESSION.gameState.answersByQuestion[qIdx] || {};
      const rec = bucket[pid] || { answer: '', at: 0, validated: false };
      rec.validated = !rec.validated;
      bucket[pid] = rec;
      SESSION.gameState.answersByQuestion[qIdx] = bucket;
      const player = SESSION.players.get(pid);
      if (player) {
        ensurePlayerScore(player);
        player.score = Math.max(0, player.score + (rec.validated ? 1 : -1));
      }
      SESSION.gameState.reviewAnswers = serializeGameBAnswers(qIdx);
      resolveGameB();
    }
    else if (command === 'RESTORE_ARROW') {
      const pid = String(payload?.playerId || '');
      const p = SESSION.players.get(pid);
      if (!p) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
      ensurePlayerArrows(p);
      p.arrows = Math.min(2, p.arrows + 1);
    }
    else if (command === 'UPDATE_SCORE') {
      const pid = String(payload?.playerId || '');
      const p = SESSION.players.get(pid);
      if (!p) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
      ensurePlayerScore(p);
      if (typeof payload?.delta !== 'undefined') {
        addScore(pid, Number(payload.delta) || 0);
      } else if (typeof payload?.score !== 'undefined') {
        p.score = Number(payload.score) || 0;
      } else {
        return ack?.({ ok: false, error: 'INVALID_SCORE_PAYLOAD' });
      }
    }
    else if (command === 'GAME_PREVIEW') {
      const game = String(payload?.game || '');
      SESSION.previewGame = game ? { game, ...gameBrief(game) } : null;
    }
    else if (command === 'GAME_D_START') {
      if (SESSION.phase !== 'GAME_D') return ack?.({ ok:false, error:'INVALID_PHASE' });
      SESSION.gameState.stage = 'PLAYING';
      SESSION.previewGame = null;
    }
    else if (command === 'GAME_D_NEXT_SONG') {
      if (SESSION.phase !== 'GAME_D') return ack?.({ ok:false, error:'INVALID_PHASE' });
      const bank = Array.isArray(CONFIG.blindtest) ? CONFIG.blindtest : [];
      const next = (Number(SESSION.gameState.index||0) + 1) % Math.max(1, bank.length || 1);
      const q = bank[next] || { prompt:'Blind test', answer:'' };
      SESSION.gameState.index = next;
      SESSION.gameState.prompt = q.prompt || 'Blind test';
      SESSION.gameState.answer = String(q.answer||'');
      SESSION.gameState.answers = {};
      SESSION.gameState.awardedByPid = {};
      SESSION.gameState.stage = 'PREVIEW';
      SESSION.previewGame = { game:'GAME_D', ...gameBrief('GAME_D') };
      SESSION.lastAward = null;
    }
    else if (command === 'GAME_D_TOGGLE') {
      if (SESSION.phase !== 'GAME_D') return ack?.({ ok:false, error:'INVALID_PHASE' });
      const pid=String(payload?.playerId||'');
      const part = payload?.part === 'artist' ? 'artist' : 'title';
      const player=SESSION.players.get(pid);
      if(!player) return ack?.({ok:false,error:'PLAYER_NOT_FOUND'});
      const rec = (SESSION.gameState.awardsByPid && SESSION.gameState.awardsByPid[pid]) || { title:false, artist:false };
      const before = (rec.title?0.5:0) + (rec.artist?0.5:0);
      rec[part] = !rec[part];
      const after = (rec.title?0.5:0) + (rec.artist?0.5:0);
      SESSION.gameState.awardsByPid = SESSION.gameState.awardsByPid || {};
      SESSION.gameState.awardsByPid[pid] = rec;
      addScore(pid, after - before);
      SESSION.lastAward = { at: nowIso(), playerId: pid, name: player.name, delta: after - before };
    }
    else if (command === 'GAME_G_SELECT') {
      if (SESSION.phase !== 'GAME_G') return ack?.({ ok:false, error:'INVALID_PHASE' });
      SESSION.gameState.selectedPlayerId = String(payload?.playerId||'');
    }
    else if (command === 'GAME_G_ANNOUNCE') {
      if (SESSION.phase !== 'GAME_G') return ack?.({ ok:false, error:'INVALID_PHASE' });
      resolveGameG();
      SESSION.resultsShown = true;
    }
    else if (command === 'GAME_F_BREAK_ARROW') {
      if (SESSION.phase !== 'GAME_F' || SESSION.gameState?.stage !== 'BREAK_SELECT') return ack?.({ ok:false, error:'INVALID_PHASE' });
      const target = String(payload?.targetPlayerId || '');
      const by = SESSION.gameState.closest;
      const tp = SESSION.players.get(target);
      if (!tp || !by) return ack?.({ ok:false, error:'PLAYER_NOT_FOUND' });
      ensurePlayerArrows(tp);
      tp.arrows = Math.max(0, tp.arrows - 1);
      const alive = activePlayers().filter((pl)=>{ ensurePlayerArrows(pl); return pl.arrows > 0; });
      const winner = alive.length===1 ? alive[0].playerId : null;
      if (winner) addScore(winner, 2);
      SESSION.gameState.breakChoice = { by, target };
      SESSION.gameState.results = { ...(SESSION.gameState.results||{}), game:'F', breakChoice: SESSION.gameState.breakChoice, winner, winnerBonus: winner ? 2 : 0 };
      SESSION.lastAward = winner ? { at: nowIso(), playerId:winner, name: SESSION.players.get(winner)?.name||winner, delta:2 } : null;
      if (winner) SESSION.gameState.completed = true;
      else { SESSION.gameState.stage='AIM'; SESSION.gameState.shots={}; SESSION.gameState.contenders = alive.map((pl)=>pl.playerId); }
      SESSION.resultsShown = true;
    }
    else if (command === 'SHOW_RESULTS') {
      showResultsCurrentPhase();
    }
    else if (command === 'SET_TV_MUTED') {
      SESSION.tvMuted = !!payload?.muted;
    }
    else if (command === 'RESET_GAME') {
      resetSession();
      io.emit('game:reset', { at: nowIso() });
    }
    touch();
    broadcastState();
    ack?.({ ok: true });
  });

  socket.on('room:join', ({ playerId, reconnectToken, name, animal }, ack) => {
    const pid = String(playerId || crypto.randomUUID());
    const token = String(reconnectToken || crypto.randomUUID());
    const existing = SESSION.players.get(pid);
    if (existing && existing.reconnectToken !== token) return ack?.({ ok: false, error: 'INVALID_RECONNECT_TOKEN' });
    const p = existing || { playerId: pid, reconnectToken: token, name: safeName(name), animal: safeAnimal(animal), ready: false, status: 'CONNECTED', score: 0, arrows: 2, eliminated: false, lastSeenAt: nowIso(), joinSeq: ++SESSION.joinSeqCounter };
    p.name = safeName(name || p.name); p.animal = safeAnimal(animal || p.animal); p.status = 'CONNECTED'; ensurePlayerArrows(p); p.lastSeenAt = nowIso();
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
      const target = payload?.targetPlayerId || '';
      if (target === pid) return ack?.({ ok: false, error: 'NO_SELF_VOTE' });
      SESSION.gameState.answers[pid] = target;
    } else if (SESSION.phase === 'GAME_B' && type === 'B_ANSWER') {
      const g = SESSION.gameState || {};
      if (g.stage !== 'QUESTION') return ack?.({ ok: false, error: 'PHASE_LOCKED' });
      const qIdx = g.currentIndex;
      if (qIdx < 0) return ack?.({ ok: false, error: 'NO_ACTIVE_QUESTION' });
      const answers = g.answersByQuestion[qIdx] || {};
      answers[pid] = {
        answer: String(payload?.answer || '').slice(0, 240),
        at: now(),
        validated: !!answers[pid]?.validated
      };
      g.answersByQuestion[qIdx] = answers;
      g.currentAnswers = serializeGameBAnswers(qIdx);
    } else if (SESSION.phase === 'GAME_C' && type === 'C_GUESS') {
      if (SESSION.gameState.answers[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      SESSION.gameState.answers[pid] = Number(payload?.value);
    } else if (SESSION.phase === 'GAME_D' && type === 'D_BLIND') {
      if (SESSION.gameState.stage !== 'PLAYING') return ack?.({ ok:false, error:'PHASE_LOCKED' });
      SESSION.gameState.answers[pid] = { title: String(payload?.title||'').slice(0,120), artist: String(payload?.artist||'').slice(0,120) };
    } else if (SESSION.phase === 'GAME_E' && type === 'E_CHOICE') {
      if (SESSION.gameState.choices[pid]) return ack?.({ ok: false, error: 'ALREADY_ANSWERED' });
      SESSION.gameState.choices[pid] = payload?.choice === 'BETRAY' ? 'BETRAY' : 'SHARE';
    } else if (SESSION.phase === 'GAME_F' && type === 'F_AIM_VERTICAL') {
      ensurePlayerArrows(p);
      if (p.arrows <= 0) return ack?.({ ok: false, error: 'NO_ARROWS_LEFT' });
      const value = Number(payload?.value);
      if (Number.isNaN(value)) return ack?.({ ok: false, error: 'INVALID_VALUE' });
      SESSION.gameState.shots[pid] = SESSION.gameState.shots[pid] || {};
      SESSION.gameState.shots[pid].vertical = Math.max(-100, Math.min(100, value));
    } else if (SESSION.phase === 'GAME_F' && type === 'F_AIM_HORIZONTAL') {
      ensurePlayerArrows(p);
      if (p.arrows <= 0) return ack?.({ ok: false, error: 'NO_ARROWS_LEFT' });
      const value = Number(payload?.value);
      if (Number.isNaN(value)) return ack?.({ ok: false, error: 'INVALID_VALUE' });
      SESSION.gameState.shots[pid] = SESSION.gameState.shots[pid] || {};
      SESSION.gameState.shots[pid].horizontal = Math.max(-100, Math.min(100, value));
    } else if (SESSION.phase === 'GAME_F' && type === 'F_BREAK_TARGET') {
      ensurePlayerArrows(p);
      if (p.arrows <= 0) return ack?.({ ok: false, error: 'NO_ARROWS_LEFT' });
      if (SESSION.gameState.stage !== 'BREAK_SELECT') return ack?.({ ok: false, error: 'NOT_IN_BREAK_STAGE' });
      if (pid !== SESSION.gameState.closest) return ack?.({ ok: false, error: 'NOT_BREAKER' });
      const target = String(payload?.targetPlayerId || '');
      if (!target || target === pid) return ack?.({ ok: false, error: 'INVALID_TARGET' });
      const targetPlayer = SESSION.players.get(target);
      if (!targetPlayer) return ack?.({ ok: false, error: 'PLAYER_NOT_FOUND' });
      ensurePlayerArrows(targetPlayer);
      targetPlayer.arrows = Math.max(0, targetPlayer.arrows - 1);
      SESSION.gameState.breakChoice = { by: pid, target };
      const alive = activePlayers().filter((pl) => {
        ensurePlayerArrows(pl);
        return pl.arrows > 0;
      });
      const winner = alive.length === 1 ? alive[0].playerId : null;
      const payloadResult = { ...(SESSION.gameState.results || { game: 'F' }), breakChoice: SESSION.gameState.breakChoice, winner };
      SESSION.gameState.results = payloadResult;
      SESSION.history.push({ at: nowIso(), game: 'F', breakChoice: SESSION.gameState.breakChoice, winner });
      publishResults(payloadResult);
      if (winner) {
        SESSION.gameState.completed = true;
      } else {
        const contenders = alive.map((pl) => pl.playerId);
        SESSION.gameState.contenders = contenders;
        SESSION.gameState.shots = {};
        SESSION.gameState.stage = 'AIM';
      }
      SESSION.resultsShown = false;
      SESSION.answerLocked = false;
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

  socket.on('tv:audio_error', ({ reason }, ack) => {
    const error = { at: nowIso(), reason: String(reason || 'AUDIO_PLAYBACK_FAILED').slice(0, 180) };
    SESSION.lastTvAudioError = error;
    if (SESSION.adminSocketId) io.to(SESSION.adminSocketId).emit('admin:tv_audio_error', error);
    touch();
    broadcastState();
    ack?.({ ok: true });
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
    SESSION.socketsByPlayerId.delete(socket.id);
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
