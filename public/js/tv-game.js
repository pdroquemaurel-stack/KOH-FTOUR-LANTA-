import { Core } from './tv-core.js';

const GAME_DEFS = [
  { id: 'quiz', label: 'Quiz Vrai/Faux', bankUrl: '/questions.json', defaults: { count: 3, seconds: 10 } },
  { id: 'guess', label: 'Devine le nombre', bankUrl: '/guess-questions.json', defaults: { count: 3, seconds: 10 } },
  { id: 'free', label: 'Réponse libre', bankUrl: '/free-questions.json', defaults: { count: 5, seconds: 10 } },
  { id: 'most', label: 'Qui est le plus', bankUrl: '/most-questions.json', defaults: { count: 3, seconds: 15 } }
];

const state = {
  running: false,
  stopRequested: false,
  banks: new Map(),
  selectedOrder: [],
  configByGameId: new Map()
};

const RESULTS_VIEW_MS = 10000;
const REVIEW_WAIT_TIMEOUT_MS = 120000;
let flowTimerInterval = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitForSocketEvent(eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;

    const onEvent = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      Core.socket.off(eventName, onEvent);
      resolve(payload);
    };

    timer = setTimeout(() => {
      if (done) return;
      done = true;
      Core.socket.off(eventName, onEvent);
      reject(new Error('timeout:' + eventName));
    }, timeoutMs);

    Core.socket.on(eventName, onEvent);
  });
}


function stageEls() {
  return {
    root: document.getElementById('gameShowStage'),
    mode: document.getElementById('gameShowMode'),
    phase: document.getElementById('gameShowPhase'),
    question: document.getElementById('gameShowQuestion')
  };
}

function stageShow() {
  const els = stageEls();
  if (els.root) els.root.classList.add('show');
}

function stageHide() {
  const els = stageEls();
  if (els.root) els.root.classList.remove('show');
}

function stageUpdate({ mode, phase, question }) {
  const els = stageEls();
  if (els.mode && mode) els.mode.textContent = mode;
  if (els.phase && phase) els.phase.textContent = phase;
  if (els.question) els.question.textContent = question || '...';
}


function flowTimerEls() {
  return {
    root: document.getElementById('gameFlowTimer'),
    phase: document.getElementById('gameFlowTimerPhase'),
    value: document.getElementById('gameFlowTimerValue'),
    fill: document.getElementById('gameFlowTimerFill')
  };
}

function stopFlowTimer() {
  if (flowTimerInterval) {
    clearInterval(flowTimerInterval);
    flowTimerInterval = null;
  }
  const els = flowTimerEls();
  if (els.root) els.root.style.display = 'none';
}

function startFlowTimer(totalSeconds, phaseLabel) {
  stopFlowTimer();
  const total = Math.max(1, Number(totalSeconds) || 1);
  const els = flowTimerEls();
  if (!els.root || !els.value || !els.fill || !els.phase) return;
  els.root.style.display = '';
  els.phase.textContent = phaseLabel || 'Question';
  const startAt = Date.now();

  const tick = () => {
    const elapsed = (Date.now() - startAt) / 1000;
    const remain = Math.max(0, total - elapsed);
    const pct = Math.max(0, Math.min(1, remain / total));
    els.value.textContent = `${Math.ceil(remain)}s`;
    els.fill.style.width = `${Math.round(pct * 100)}%`;
  };

  tick();
  flowTimerInterval = setInterval(() => {
    tick();
    if ((Date.now() - startAt) / 1000 >= total) stopFlowTimer();
  }, 100);
}

async function sleepWithFlowTimer(ms, phaseLabel) {
  const sec = Math.max(1, Math.round(ms / 1000));
  startFlowTimer(sec, phaseLabel);
  await sleep(ms);
  stopFlowTimer();
}

function clamp(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function getGameDef(gameId) {
  return GAME_DEFS.find((g) => g.id === gameId) || null;
}

function ensureConfig(gameId) {
  if (!state.configByGameId.has(gameId)) {
    const def = getGameDef(gameId);
    if (!def) return null;
    state.configByGameId.set(gameId, { count: def.defaults.count, seconds: def.defaults.seconds });
  }
  return state.configByGameId.get(gameId);
}

function isSelected(gameId) {
  return state.selectedOrder.includes(gameId);
}

function toggleGame(gameId) {
  if (isSelected(gameId)) {
    state.selectedOrder = state.selectedOrder.filter((id) => id !== gameId);
  } else {
    state.selectedOrder.push(gameId);
    ensureConfig(gameId);
  }
  renderBuilder();
}

function moveGame(gameId, delta) {
  const index = state.selectedOrder.indexOf(gameId);
  if (index < 0) return;
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= state.selectedOrder.length) return;
  const nextOrder = [...state.selectedOrder];
  [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
  state.selectedOrder = nextOrder;
  renderBuilder();
}

function setConfig(gameId, field, value) {
  const cfg = ensureConfig(gameId);
  if (!cfg) return;
  if (field === 'count') cfg.count = clamp(value, 1, 50, cfg.count);
  if (field === 'seconds') cfg.seconds = clamp(value, 5, 45, cfg.seconds);
}

function getPlan() {
  return state.selectedOrder.map((gameId) => {
    const cfg = ensureConfig(gameId);
    return {
      id: gameId,
      count: clamp(cfg?.count, 1, 50, 3),
      seconds: clamp(cfg?.seconds, 5, 45, 10)
    };
  });
}

function renderAvailableList() {
  const list = document.getElementById('gameBuilderList');
  if (!list) return;
  list.innerHTML = '';

  GAME_DEFS.forEach((g) => {
    const selected = isSelected(g.id);
    const item = document.createElement('div');
    item.className = 'game-builder-list-item';
    item.innerHTML = `
      <div>
        <div><strong>${g.label}</strong></div>
        <div class="hint">Banque: ${g.bankUrl.replace('/', '')}</div>
      </div>
      <button type="button" class="${selected ? '' : 'btn-cyan'}">${selected ? 'Retirer' : 'Ajouter'}</button>
    `;
    item.querySelector('button')?.addEventListener('click', () => toggleGame(g.id));
    list.appendChild(item);
  });
}

function renderConfigList() {
  const configWrap = document.getElementById('gameBuilderConfig');
  const summary = document.getElementById('gameBuilderSummary');
  const startBtn = document.getElementById('gameBuilderStartBtn');
  if (!configWrap) return;

  const plan = getPlan();
  const totalQ = plan.reduce((sum, p) => sum + p.count, 0);
  if (summary) {
    summary.textContent = plan.length
      ? `${plan.length} jeu(x) • ${totalQ} question(s)`
      : 'Aucun jeu sélectionné';
  }
  if (startBtn) startBtn.disabled = plan.length === 0;

  configWrap.innerHTML = '';
  if (!plan.length) {
    const empty = document.createElement('div');
    empty.className = 'game-builder-empty';
    empty.textContent = 'Ajoute des jeux depuis la colonne de gauche.';
    configWrap.appendChild(empty);
    return;
  }

  plan.forEach((step, index) => {
    const def = getGameDef(step.id);
    const item = document.createElement('div');
    item.className = 'game-builder-config-item';
    item.setAttribute('data-game-id', step.id);
    item.innerHTML = `
      <div class="game-builder-config-head">
        <div>
          <div class="game-builder-order">#${index + 1}</div>
          <strong>${def ? def.label : step.id}</strong>
        </div>
        <div class="btn-row" style="gap:.35rem;">
          <button type="button" data-act="up" title="Monter">↑</button>
          <button type="button" data-act="down" title="Descendre">↓</button>
          <button type="button" data-act="remove" title="Retirer">✖</button>
        </div>
      </div>
      <div class="game-builder-config-grid">
        <div class="field">
          <label>Nombre de questions</label>
          <input data-field="count" type="number" min="1" max="50" value="${step.count}" />
        </div>
        <div class="field">
          <label>Durée / question (secondes)</label>
          <input data-field="seconds" type="number" min="5" max="45" value="${step.seconds}" />
        </div>
      </div>
    `;

    item.querySelector('[data-act="up"]')?.addEventListener('click', () => moveGame(step.id, -1));
    item.querySelector('[data-act="down"]')?.addEventListener('click', () => moveGame(step.id, +1));
    item.querySelector('[data-act="remove"]')?.addEventListener('click', () => toggleGame(step.id));

    item.querySelector('[data-field="count"]')?.addEventListener('change', (ev) => {
      setConfig(step.id, 'count', ev.target.value);
      renderConfigList();
    });
    item.querySelector('[data-field="seconds"]')?.addEventListener('change', (ev) => {
      setConfig(step.id, 'seconds', ev.target.value);
      renderConfigList();
    });

    configWrap.appendChild(item);
  });
}

function renderBuilder() {
  renderAvailableList();
  renderConfigList();
}

async function loadBank(url) {
  if (state.banks.has(url)) return state.banks.get(url);
  const u = new URL(url, window.location.origin);
  u.searchParams.set('t', String(Date.now()));
  const res = await fetch(u.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const items = Array.isArray(data) ? data : [];
  state.banks.set(url, items);
  return items;
}

function sample(items, count) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, count));
}

function openBuilder() {
  renderBuilder();
  document.getElementById('gameBuilderOverlay')?.classList.add('show');
}

function closeBuilder() {
  document.getElementById('gameBuilderOverlay')?.classList.remove('show');
}

async function runQuiz(item, seconds) {
  const q = String(item.q || '').trim();
  if (!q) return '';
  Core.socket.emit('quiz:start', { question: q, correct: !!item.a, seconds });
  Core.socket.emit('countdown:start', seconds);
  await sleepWithFlowTimer(seconds * 1000, 'Question');
  Core.socket.emit('quiz:close');
  return q;
}

async function runGuess(item, seconds) {
  const q = String(item.q || '').trim();
  if (!q) return '';
  const min = Number.isFinite(Number(item.min)) ? Number(item.min) : 0;
  const max = Number.isFinite(Number(item.max)) ? Number(item.max) : 100;
  const correct = Number.isFinite(Number(item.c)) ? Number(item.c) : min;
  Core.socket.emit('guess:start', { question: q, correct, min, max, seconds });
  Core.socket.emit('countdown:start', seconds);
  await sleepWithFlowTimer(seconds * 1000, 'Question');
  Core.socket.emit('guess:close');
  return q;
}

async function runFreeSingle(item, seconds) {
  const q = String(item.q || '').trim();
  if (!q) return;
  Core.socket.emit('free:start', { question: q, seconds, answer: String(item.a || '') });
  Core.socket.emit('countdown:start', seconds);
  await sleepWithFlowTimer(seconds * 1000, 'Question');
  Core.socket.emit('free:close');
}

async function runFreeSeries(step) {
  const def = getGameDef('free');
  if (!def) return;
  const bank = await loadBank(def.bankUrl);
  if (!bank.length) return;

  const questions = sample(bank, Math.min(step.count, bank.length)).map((item) => ({
    q: String(item.q || '').trim(),
    s: step.seconds,
    a: String(item.a || '')
  })).filter((item) => item.q);

  if (!questions.length) return;

  const reviewOpened = waitForSocketEvent('free:review_open', REVIEW_WAIT_TIMEOUT_MS).catch(() => null);
  Core.socket.emit('free:series:start', { items: questions });
  return await reviewOpened;
}

async function runMost(item, seconds) {
  const q = String(item.q || '').trim();
  if (!q) return '';
  Core.socket.emit('most:start', { question: q, seconds });
  Core.socket.emit('countdown:start', seconds);
  await sleepWithFlowTimer(seconds * 1000, 'Question');
  Core.socket.emit('most:close');
  return q;
}

async function runGame(step, globalIndex, globalTotal) {
  const def = getGameDef(step.id);
  if (!def) return;

  if (def.id === 'free') {
    Core.showProgress(`GAME: ${globalIndex + 1}/${globalTotal} • ${def.label} (série + correction)`);
    stageShow();
    stageUpdate({ mode: def.label, phase: 'Questions en cours', question: 'Les joueurs répondent à toute la série...' });
    startFlowTimer(Math.max(1, step.seconds * step.count), 'Questions');
    const reviewPayload = await runFreeSeries(step);
    stopFlowTimer();
    const reviewQuestion = reviewPayload && reviewPayload.question ? reviewPayload.question : 'Correction en cours';
    stageUpdate({ mode: def.label, phase: 'Correction', question: reviewQuestion });
    // Pendant la correction, on laisse voir l'overlay de réponses.
    stageHide();
    await sleepWithFlowTimer(RESULTS_VIEW_MS, 'Réponses');
    return;
  }

  const bank = await loadBank(def.bankUrl);
  if (!bank.length) return;
  const questions = sample(bank, Math.min(step.count, bank.length));
  for (let i = 0; i < questions.length; i++) {
    if (state.stopRequested) return;
    const current = questions[i];
    const q = String(current && current.q || '').trim();
    stageShow();
    stageUpdate({ mode: def.label, phase: 'Question', question: q || 'Question en cours...' });
    Core.showProgress(`GAME: ${globalIndex + i + 1}/${globalTotal} • ${def.label}`);
    let askedQuestion = q;
    if (def.id === 'quiz') askedQuestion = await runQuiz(current, step.seconds);
    else if (def.id === 'guess') askedQuestion = await runGuess(current, step.seconds);
    else if (def.id === 'most') askedQuestion = await runMost(current, step.seconds);
    stageUpdate({ mode: def.label, phase: 'Correction', question: askedQuestion || q || 'Correction en cours' });
    // Pendant la correction, on laisse voir les réponses/résultats natifs.
    stageHide();
    await sleepWithFlowTimer(RESULTS_VIEW_MS, 'Réponses');
  }
}

async function startGamePlan() {
  if (state.running) return;
  const plan = getPlan();
  if (!plan.length) {
    alert('Sélectionne au moins un jeu pour la GAME.');
    return;
  }

  closeBuilder();
  state.running = true;
  state.stopRequested = false;
  stageShow();
  stageUpdate({ mode: 'Mode GAME', phase: 'Lancement', question: 'Préparez-vous !' });

  try {
    const totalQuestions = plan.reduce((sum, p) => sum + p.count, 0);
    let done = 0;
    for (const step of plan) {
      if (state.stopRequested) break;
      await runGame(step, done, totalQuestions);
      done += step.count;
    }
    Core.showProgress(state.stopRequested ? 'GAME interrompue' : 'GAME terminée ✅');
    await sleep(1400);
  } catch {
    Core.showProgress('Erreur pendant la GAME');
    await sleep(1400);
  } finally {
    Core.hideProgress();
    stageHide();
    stopFlowTimer();
    state.running = false;
    state.stopRequested = false;
  }
}

function wire() {
  const btn = document.getElementById('gameBuilderBtn');
  const closeBtn = document.getElementById('gameBuilderCloseBtn');
  const startBtn = document.getElementById('gameBuilderStartBtn');
  const overlay = document.getElementById('gameBuilderOverlay');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';

  btn.addEventListener('click', openBuilder);
  closeBtn?.addEventListener('click', closeBuilder);
  startBtn?.addEventListener('click', startGamePlan);
  overlay?.addEventListener('click', (ev) => {
    if (ev.target === overlay) closeBuilder();
  });

  document.getElementById('overlayStopBtn')?.addEventListener('click', () => {
    if (state.running) state.stopRequested = true;
  });

  if (!state.selectedOrder.length) {
    state.selectedOrder = ['quiz'];
    ensureConfig('quiz');
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', wire, { once: true });
} else {
  wire();
}
