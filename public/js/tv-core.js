// public/js/tv-core.js
import { EVENTS, GAME_EVENTS } from './types.js';

export const GameRegistry = (() => {
  const modules = new Map();
  return {
    register(name, mod) { modules.set(name, mod); },
    get(name) { return modules.get(name); },
    all() { return Array.from(modules.keys()); }
  };
})();

export const Core = (() => {
  const socket = io();
  let room = generateRoomCode(5);
  let currentMode = 'buzzer';

  // Auto-play global flag pour STOP
  let autoPlayRunning = false;

  // Elements
  const els = {
    roomCode: document.getElementById('roomCode'),
    qr: document.getElementById('qr'),
    qrLink: document.getElementById('qrLink'),
    regenBtn: document.getElementById('regenBtn'),
    players: document.getElementById('players'),
    resetScoresBtn: document.getElementById('resetScoresBtn'),
    status: document.getElementById('status'),
    roomLockToggle: document.getElementById('roomLockToggle'),
    overlay: document.getElementById('overlay'),
    winnerName: document.getElementById('winnerName'),
    countdown: document.getElementById('countdown'),
    countNum: document.getElementById('countNum'),
    resultsOverlay: document.getElementById('resultsOverlay'),
    resultsTitle: document.getElementById('resultsTitle'),
    resultsBody: document.getElementById('resultsBody'),
    resultsCloseBtn: document.getElementById('resultsCloseBtn'),
    modeSwitch: document.getElementById('modeSwitch'),
    panels: document.querySelectorAll('[data-game-panel]'),

    // Overlays
    quizQOverlay: document.getElementById('quizQOverlay'),
    overlayStopBtn: document.getElementById('overlayStopBtn'),
    quizQText: document.getElementById('quizQText'),
    quizTimer: document.getElementById('quizTimer'),
    timerRing: document.getElementById('timerRing'),
    freeHint: document.getElementById('freeHint'),

    freeResultsOverlay: document.getElementById('freeResultsOverlay'),
    freeResultsList: document.getElementById('freeResultsList'),
    freeResultsCloseBtn: document.getElementById('freeResultsCloseBtn'),
    freeReviewOverlay: document.getElementById('freeReviewOverlay'),
    freeReviewPosition: document.getElementById('freeReviewPosition'),
    freeReviewQuestion: document.getElementById('freeReviewQuestion'),
    freeReviewList: document.getElementById('freeReviewList'),
    freeReviewPrevBtn: document.getElementById('freeReviewPrevBtn'),
    freeReviewNextBtn: document.getElementById('freeReviewNextBtn'),
    freeReviewCloseBtn: document.getElementById('freeReviewCloseBtn'),

    // Bandeau progression
    progressBanner: createProgressBanner()
  };

  const BASE_URL = (window.location && window.location.origin) || '';
  const ADMIN_TOKEN = window.localStorage.getItem('party_admin_token') || '';
  const TV_ROOM_STORAGE_KEY = 'party_tv_room';

  // State
  let cdTimer = null;
  let quizTimer = null;
  let freeSeriesActive = false;

  // Utils
  function generateRoomCode(len) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function isForceNewRoom() {
    const qs = new URLSearchParams(window.location.search);
    return qs.get('new') === '1';
  }

  function getRequestedRoom() {
    const qs = new URLSearchParams(window.location.search);
    const roomFromUrl = String(qs.get('room') || '').toUpperCase().trim();
    if (/^[A-Z0-9]{4,8}$/.test(roomFromUrl)) return roomFromUrl;
    const roomFromStorage = String(window.localStorage.getItem(TV_ROOM_STORAGE_KEY) || '').toUpperCase().trim();
    if (/^[A-Z0-9]{4,8}$/.test(roomFromStorage)) return roomFromStorage;
    return '';
  }

  function persistRoom(code) {
    window.localStorage.setItem(TV_ROOM_STORAGE_KEY, code);
    document.cookie = `party_tv_room=${encodeURIComponent(code)}; Max-Age=86400; Path=/; SameSite=Lax`;
  }

  function clearPersistedRoom() {
    window.localStorage.removeItem(TV_ROOM_STORAGE_KEY);
    document.cookie = 'party_tv_room=; Max-Age=0; Path=/; SameSite=Lax';
  }
  function playBeep(freq = 880, durMs = 120) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      o.start();
      setTimeout(() => {
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
        o.stop(ctx.currentTime + 0.12);
      }, durMs);
    } catch {}
  }
  function setStatus(text) { els.status.textContent = text || ''; }

  function buildJoinUrl() { return BASE_URL + '/join?room=' + encodeURIComponent(room); }
  function renderInvite() {
    els.roomCode.textContent = room;
    const joinUrl = buildJoinUrl();
    els.qrLink.href = joinUrl;
    els.qrLink.classList.remove('hint');
    if (!els.qrLink.contains(els.qr)) els.qrLink.appendChild(els.qr);
    const qrApi = '/qr?data=';
    const fallbackSvg = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="#fff"/><text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="20" fill="#000">ROOM</text><text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="30" font-weight="bold" fill="#000">${room}</text></svg>`);
    els.qr.onerror = () => {
      if (els.qr.src !== fallbackSvg) {
        els.qr.src = fallbackSvg;
        return;
      }
      els.qr.style.display = 'none';
      els.qrLink.textContent = 'Ouvrir le lien de participation';
      els.qrLink.classList.add('hint');
    };
    els.qr.onload = () => {
      els.qr.style.display = 'block';
      if (!els.qrLink.contains(els.qr)) els.qrLink.appendChild(els.qr);
      const fallbackText = els.qrLink.querySelector('.qr-fallback-link');
      if (fallbackText) fallbackText.remove();
    };
    els.qr.src = qrApi + encodeURIComponent(joinUrl);
  }

  // Avatars/initiales
  function colorFromName(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    h = (h >>> 0) % 360;
    return `hsl(${h}, 85%, 58%)`;
  }
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/);
    const a = (parts[0] || '').charAt(0) || '';
    const b = (parts[1] || '').charAt(0) || '';
    return (a + b).toUpperCase() || (String(name || 'J')[0] || 'J').toUpperCase();
  }

  function renderPlayers(list) {
    els.players.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];

    (list || []).forEach((p, idx) => {
      const li = document.createElement('li');
      li.className = 'score-item';
      if (idx <= 2) li.classList.add(['gold','silver','bronze'][idx]);

      // Médaille
      const medal = document.createElement('div');
      medal.className = 'score-medal';
      medal.textContent = medals[idx] || '';

      // Avatar + nom
      const name = document.createElement('div');
      name.className = 'score-name';
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.style.background = p.color || colorFromName(p.name);
      avatar.textContent = initials(p.name);
      const online = document.createElement('span');
      online.className = 'online-dot' + (p.connected ? ' online' : '');
      const label = document.createElement('span');
      label.textContent = ' ' + p.name;

      name.appendChild(avatar);
      name.appendChild(online);
      name.appendChild(label);

      // Score
      const score = document.createElement('div');
      score.className = 'score-value';
      score.textContent = p.score;

      // Controls
      const controls = document.createElement('div');
      controls.className = 'score-controls';
      const btnPlus = document.createElement('button');
      btnPlus.className = 'score-btn plus';
      btnPlus.textContent = '▲';
      btnPlus.title = 'Ajouter 1 point';
      btnPlus.addEventListener('click', () => {
        score.textContent = String((parseInt(score.textContent||'0',10)||0)+1);
        socket.emit('scores:adjust', { name: p.name, delta: +1 });
      });
      const btnMinus = document.createElement('button');
      btnMinus.className = 'score-btn minus';
      btnMinus.textContent = '▼';
      btnMinus.title = 'Retirer 1 point';
      btnMinus.addEventListener('click', () => {
        score.textContent = String((parseInt(score.textContent||'0',10)||0)-1);
        socket.emit('scores:adjust', { name: p.name, delta: -1 });
      });

      const btnKick = document.createElement('button');
      btnKick.className = 'score-btn kick';
      btnKick.textContent = '✖';
      btnKick.title = 'Supprimer ce joueur';
      btnKick.addEventListener('click', () => {
        if (window.confirm(`Supprimer ${p.name} de la salle ?`)) socket.emit('player:kick', { name: p.name });
      });

      controls.appendChild(btnPlus);
      controls.appendChild(btnMinus);
      controls.appendChild(btnKick);

      li.appendChild(medal);
      li.appendChild(name);
      li.appendChild(score);
      li.appendChild(controls);

      li.style.animation = 'pop-in .25s ease-out';
      els.players.appendChild(li);
    });
  }

  function createProgressBanner() {
    const b = document.createElement('div');
    b.id = 'progressBanner';
    b.className = 'progress-banner';
    b.style.display = 'none';
    document.body.appendChild(b);
    return b;
  }
  function showProgress(text) { els.progressBanner.textContent = text; els.progressBanner.style.display = 'block'; }
  function hideProgress() { els.progressBanner.style.display = 'none'; }

  function updateTimerRing(remaining, total) {
    const ring = els.timerRing;
    if (!ring) return;
    const safeTotal = Math.max(1, total || 1);
    const pct = Math.max(0, Math.min(1, remaining / safeTotal));
    ring.style.display = 'grid';
    ring.setAttribute('data-urgent', remaining <= 3 ? '1' : '0');
    ring.querySelector('.timer-value').textContent = String(Math.max(0, Math.ceil(remaining)));
    ring.style.setProperty('--timer-pct', `${pct}`);
  }

  function hideTimerRing() {
    if (els.timerRing) els.timerRing.style.display = 'none';
  }

  function stopCountdownUI() { if (cdTimer) { clearInterval(cdTimer); cdTimer = null; } els.countdown.classList.remove('show'); hideTimerRing(); }
  function startCountdown(sec = 3, onEnd) {
    stopCountdownUI();
    els.countNum.textContent = sec;
    els.countdown.classList.add('show');
    socket.emit(EVENTS.COUNTDOWN_START, sec);
    playBeep(700, 120);
    let remain = sec;
    updateTimerRing(remain, sec);
    cdTimer = setInterval(() => {
      remain--;
      if (remain > 0) { els.countNum.textContent = remain; updateTimerRing(remain, sec); playBeep(700, 120); }
      else { stopCountdownUI(); playBeep(1200, 200); if (typeof onEnd === 'function') onEnd(); }
    }, 1000);
  }

  function showQuestionOverlay(question, seconds, showFreeHint = false) {
    if (quizTimer) { clearInterval(quizTimer); quizTimer = null; }
    els.quizQText.textContent = question;
    const total = Math.max(1, seconds || 5);
    let remain = total;
    els.quizTimer.textContent = `⏱ Temps restant: ${remain}s`;
    updateTimerRing(remain, total);
    if (remain <= 5) playBeep(980, 90);
    els.freeHint.style.display = showFreeHint ? 'block' : 'none';
    els.quizQOverlay.classList.add('show');
    quizTimer = setInterval(() => {
      remain--;
      if (remain > 0) {
        els.quizTimer.textContent = `⏱ Temps restant: ${remain}s`;
        updateTimerRing(remain, total);
        if (remain <= 5) playBeep(980, 90);
      }
      else { clearInterval(quizTimer); quizTimer = null; hideTimerRing(); }
    }, 1000);
  }
  function hideQuestionOverlay() {
    if (quizTimer) { clearInterval(quizTimer); quizTimer = null; }
    els.quizQOverlay.classList.remove('show');
    els.quizTimer.textContent = '';
    els.freeHint.style.display = 'none';
    hideTimerRing();
  }

  function showResultsOverlay(title, rows) {
    if (!els.resultsOverlay) return;
    els.resultsTitle.textContent = title || '';
    els.resultsBody.innerHTML = '';
    (rows || []).forEach((row) => {
      const item = document.createElement('div');
      item.className = `quiz-result-item ${row.type || 'none'}`;
      item.textContent = row.label || '';
      els.resultsBody.appendChild(item);
    });
    els.resultsOverlay.classList.add('show');
  }

  function hideResultsOverlay() {
    els.resultsOverlay?.classList.remove('show');
  }

  // Mini routeur de mode
  function setModeUI(mode) {
    els.panels.forEach(p => { p.style.display = (p.dataset.gamePanel === mode) ? '' : 'none'; });
    currentMode = mode;
    setStatus(
      mode === 'buzzer' ? 'Mode Buzzer' :
      mode === 'quiz' ? 'Mode Quiz' :
      mode === 'guess' ? 'Mode Devine' :
      mode === 'free' ? 'Mode Réponse libre' :
      mode === 'most' ? 'Mode Qui est le plus' : `Mode ${mode}`
    );
    const selected = els.modeSwitch.querySelector(`input[name="mode"][value="${mode}"]`);
    if (selected) selected.checked = true;
    const mod = GameRegistry.get(mode);
    if (mod && mod.onEnter) mod.onEnter();
  }

  function emitGameEvent(type, payload) {
    const mod = GameRegistry.get(currentMode);
    if (!mod) return;
    const map = {
      [GAME_EVENTS.QUESTION]: mod.onQuestion,
      [GAME_EVENTS.PROGRESS]: mod.onProgress,
      [GAME_EVENTS.RESULT]: mod.onResult,
      [GAME_EVENTS.CLOSE]: mod.onClose
    };
    const handler = map[type];
    if (typeof handler === 'function') handler(payload);
  }

  // Socket handlers communs
  socket.on(EVENTS.MODE_CHANGED, ({ mode }) => {
    freeSeriesActive = false;
    hideQuestionOverlay();
    hideResultsOverlay();
    stopCountdownUI();
    hideProgress();
    setModeUI(mode);
  });
  socket.on(EVENTS.ROOM_PLAYERS, renderPlayers);
  socket.on('room:state', ({ locked }) => {
    const lockText = locked ? ' — salle fermée aux nouvelles connexions' : ' — salle ouverte';
    setStatus(`Salle ${room}${lockText}`);
    if (els.roomLockToggle) els.roomLockToggle.checked = !!locked;
  });
  socket.on(EVENTS.SCORES_RESET, () => setStatus('Scores réinitialisés'));
  socket.on(EVENTS.ROUND_RESET, () => { hideQuestionOverlay(); hideResultsOverlay(); hideProgress(); setStatus('Tour/Question réinitialisé.'); });
  socket.on('room:ready', ({ code }) => {
    if (code) { room = code; persistRoom(code); renderInvite(); }
  });

  // Buzzer
  socket.on(EVENTS.BUZZ_OPEN, () => emitGameEvent(GAME_EVENTS.QUESTION, { opened: true }));
  socket.on(EVENTS.BUZZ_WINNER, (data) => {
    els.winnerName.textContent = data.name;
    els.overlay.classList.add('show');
    emitGameEvent(GAME_EVENTS.RESULT, data);
    hideProgress();
  });

  // Quiz
  socket.on(EVENTS.QUIZ_QUESTION, ({ question, seconds }) => {
    setModeUI('quiz');
    showQuestionOverlay(question, seconds, false);
    emitGameEvent(GAME_EVENTS.QUESTION, { question, seconds });
  });
  socket.on(EVENTS.QUIZ_RESULT, (payload) => {
    hideQuestionOverlay();
    emitGameEvent(GAME_EVENTS.RESULT, payload);
    hideProgress();
  });

  // Guess
  socket.on(EVENTS.GUESS_START, ({ question, min, max, seconds }) => {
    setModeUI('guess');
    showQuestionOverlay(question, seconds, false);
    emitGameEvent(GAME_EVENTS.QUESTION, { question, min, max, seconds });
  });
  socket.on(EVENTS.GUESS_PROGRESS, (prog) => emitGameEvent(GAME_EVENTS.PROGRESS, prog));
  socket.on(EVENTS.GUESS_RESULT, (payload) => {
    hideQuestionOverlay();
    emitGameEvent(GAME_EVENTS.RESULT, payload);
    hideProgress();
  });

  // Free
  socket.on(EVENTS.FREE_QUESTION, ({ question, seconds, index, total }) => {
    setModeUI('free');
    showQuestionOverlay(question, seconds, true);
    freeSeriesActive = typeof index === 'number' && typeof total === 'number';
    if (freeSeriesActive) showProgress(`Série: ${index + 1}/${total}`);
    emitGameEvent(GAME_EVENTS.QUESTION, { question, seconds, index, total });
  });
  socket.on(EVENTS.FREE_RESULTS, ({ question, expected, items }) => {
    freeSeriesActive = false;
    hideQuestionOverlay();
    emitGameEvent(GAME_EVENTS.RESULT, { question, expected, items });
    hideProgress();
  });
  socket.on(EVENTS.FREE_VALIDATED, ({ name, validated }) => {
    emitGameEvent(GAME_EVENTS.PROGRESS, { name, validated, context: 'single' });
  });
  socket.on(EVENTS.FREE_REVIEW_OPEN, ({ index, total, question, expected, seconds, items }) => {
    freeSeriesActive = false;
    showProgress(`Correction: ${index + 1}/${total}`);
    emitGameEvent(GAME_EVENTS.QUESTION, { index, total, question, expected, seconds, items, phase: 'review' });
  });
  socket.on(EVENTS.FREE_REVIEW_VALIDATED, ({ name, validated }) => {
    emitGameEvent(GAME_EVENTS.PROGRESS, { name, validated, context: 'review' });
  });


  // Most
  socket.on(EVENTS.MOST_QUESTION, ({ question, seconds }) => {
    setModeUI('most');
    showQuestionOverlay(question, seconds, false);
    emitGameEvent(GAME_EVENTS.QUESTION, { question, seconds });
  });
  socket.on(EVENTS.MOST_RESULT, (payload) => {
    hideQuestionOverlay();
    emitGameEvent(GAME_EVENTS.RESULT, payload);
    hideProgress();
  });

  // UI init
  window.addEventListener('DOMContentLoaded', () => {
    const forceNew = isForceNewRoom();
    if (forceNew) clearPersistedRoom();
    const remembered = forceNew ? '' : getRequestedRoom();
    room = remembered || room;
    renderInvite();
    const openRoom = remembered ? 'tv:remember' : 'tv:create_room';
    socket.emit(openRoom, { room, code: room, adminToken: ADMIN_TOKEN }, (res) => {
      if (res && res.ok && res.code) {
        room = res.code;
        persistRoom(room);
        renderInvite();
      }
    });

    // Mode radios -> serveur
    els.modeSwitch.querySelectorAll('input[name="mode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (radio.checked) socket.emit('mode:set', { mode: radio.value });
      });
    });

    els.regenBtn.addEventListener('click', () => {
      clearPersistedRoom();
      room = generateRoomCode(5);
      renderInvite();
      socket.emit('tv:create_room', { code: room, adminToken: ADMIN_TOKEN }, (res) => {
        if (res && res.ok && res.code) persistRoom(res.code);
      });
    });

    els.resetScoresBtn?.addEventListener('click', () => socket.emit('scores:reset'));
    els.roomLockToggle?.addEventListener('change', () => {
      socket.emit('room:lock', !!els.roomLockToggle.checked);
    });
    els.resultsCloseBtn?.addEventListener('click', hideResultsOverlay);

    document.querySelectorAll('.duration-presets').forEach((group) => {
      const target = group.getAttribute('data-target');
      const input = document.getElementById(target || '');
      const buttons = group.querySelectorAll('button[data-seconds], button[data-count]');
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const value = btn.getAttribute('data-seconds') || btn.getAttribute('data-count');
          if (input && value) input.value = value;
          buttons.forEach((b) => b.classList.remove('is-selected'));
          btn.classList.add('is-selected');
        });
      });
    });

    // Bouton STOP (croix rouge) dans overlay: arrête l'auto‑play global
    if (els.overlayStopBtn && !els.overlayStopBtn._wired) {
      els.overlayStopBtn._wired = true;
      els.overlayStopBtn.addEventListener('click', () => {
        if (currentMode === 'free' && freeSeriesActive && els.quizQOverlay?.classList.contains('show')) {
          autoPlayRunning = false;
          freeSeriesActive = false;
          hideQuestionOverlay();
          socket.emit('free:series:finish');
          showProgress('Série interrompue — passage à la correction');
          return;
        }
        autoPlayRunning = false;
        showProgress('Auto‑play arrêté');
        setTimeout(hideProgress, 1200);
      });
    }
  });

  // API exposée aux modules
  return {
    socket,
    setModeUI,
    setStatus,
    startCountdown,
    stopCountdownUI,
    showQuestionOverlay,
    hideQuestionOverlay,
    showResultsOverlay,
    hideResultsOverlay,
    playBeep,
    showProgress,
    hideProgress,
    els,
    get autoPlayRunning() { return autoPlayRunning; },
    set autoPlayRunning(v) { autoPlayRunning = !!v; }
  };
})();
