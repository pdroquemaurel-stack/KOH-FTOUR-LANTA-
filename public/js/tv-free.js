// public/js/tv-free.js
import { GameRegistry, Core } from './tv-core.js';

let bank = [];

let bankLoadingPromise = null;

async function loadFreeBankIfNeeded(infoEl) {
  if (bank.length) {
    if (infoEl) infoEl.textContent = `${bank.length} question(s) disponible(s).`;
    return bank;
  }
  if (!bankLoadingPromise) {
    bankLoadingPromise = fetch('/free-questions.json', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        bank = Array.isArray(data) ? data : [];
        return bank;
      })
      .catch(() => {
        bank = [];
        return bank;
      })
      .finally(() => {
        bankLoadingPromise = null;
      });
  }
  const items = await bankLoadingPromise;
  if (infoEl) infoEl.textContent = `${items.length} question(s) disponible(s).`;
  return items;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function normalizeFreeSeconds(v) {
  const n = parseInt(v, 10);
  if (n === 10 || n === 15 || n === 20) return n;
  return 10;
}
function pickRandomFreeItems(src, amount, secondsOverride) {
  if (!Array.isArray(src) || src.length === 0) return [];
  const arr = src.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const n = clamp(amount || 20, 1, 50);
  const out = [];
  for (let i = 0; i < n; i++) {
    const srcItem = arr[i % arr.length];
    out.push({ q: srcItem.q, s: secondsOverride || srcItem.s || 30, a: srcItem.a || '' });
  }
  return out;
}

function renderAnswerCard(item, context = 'single') {
  const card = document.createElement('article');
  card.className = 'free-answer-card' + (item.validated ? ' validated' : '');
  card.dataset.player = item.name;

  const head = document.createElement('header');
  head.className = 'free-answer-head';

  const name = document.createElement('div');
  name.className = 'free-answer-name';
  name.textContent = item.name;

  const badge = document.createElement('span');
  badge.className = 'free-answer-badge' + (item.validated ? ' yes' : ' no');
  badge.textContent = item.validated ? '✅ Validée (+1 point)' : '⏳ En attente';

  head.appendChild(name);
  head.appendChild(badge);

  const answerLabel = document.createElement('div');
  answerLabel.className = 'free-answer-label';
  answerLabel.textContent = 'Réponse';

  const text = document.createElement('div');
  text.className = 'free-answer-text';
  text.textContent = item.text || '—';

  const actions = document.createElement('div');
  actions.className = 'free-answer-actions';
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = item.validated ? 'btn-cyan' : 'btn-green';
  toggleBtn.textContent = item.validated ? 'Annuler validation' : 'Valider (+1)';
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    Core.socket.emit('free:toggle_validate', { name: item.name, context });
  });
  actions.appendChild(toggleBtn);

  card.addEventListener('click', () => {
    Core.socket.emit('free:toggle_validate', { name: item.name, context });
  });

  card.appendChild(head);
  card.appendChild(answerLabel);
  card.appendChild(text);
  card.appendChild(actions);
  return card;
}

function renderAnswersList(listEl, items, context) {
  listEl.innerHTML = '';
  (items || []).forEach((item) => {
    listEl.appendChild(renderAnswerCard(item, context));
  });
}

GameRegistry.register('free', {
  onEnter() {
    const loadedInfo = document.getElementById('freeLoadedInfo');
    const qInput = document.getElementById('freeQuestion');
    const sInput = document.getElementById('freeSeconds');
    const countInput = document.getElementById('freeSeriesCount');
    const startBtn = document.getElementById('freeStartBtn');
    const randAskBtn = document.getElementById('freeRandomAskBtn');
    const seriesBtn = document.getElementById('freeSeriesBtn');
    const info = document.getElementById('freeInfo');

    loadFreeBankIfNeeded(loadedInfo);

    if (!startBtn._wired) {
      startBtn._wired = true;

      startBtn.addEventListener('click', () => {
        const q = qInput.value.trim();
        const seconds = normalizeFreeSeconds(sInput.value || '10');
        if (!q) { alert('Entre une question'); return; }
        Core.socket.emit('free:start', { question: q, seconds, answer: '' });
        Core.socket.emit('countdown:start', seconds);
        info.textContent = `Question posée (${seconds}s)`;
        setTimeout(() => Core.socket.emit('free:close'), seconds * 1000);
      });

      randAskBtn.addEventListener('click', () => {
        if (!bank.length) { alert('Banque indisponible'); return; }
        const item = bank[Math.floor(Math.random() * bank.length)];
        const q = item.q || '';
        if (!q) return;
        const seconds = normalizeFreeSeconds(sInput.value || '10');
        Core.socket.emit('free:start', { question: q, seconds, answer: item.a || '' });
        Core.socket.emit('countdown:start', seconds);
        info.textContent = `Question posée (${seconds}s)`;
        setTimeout(() => Core.socket.emit('free:close'), seconds * 1000);
      });

      seriesBtn.addEventListener('click', () => {
        if (!bank.length) { alert('Banque indisponible'); return; }
        const count = Math.max(1, Math.min(50, parseInt(countInput.value || '20', 10)));
        const seconds = normalizeFreeSeconds(sInput.value || '10');
        const items = pickRandomFreeItems(bank, count, seconds);
        Core.socket.emit('free:series:start', { items });
        info.textContent = `Série lancée (${items.length} question(s))`;
      });

      document.getElementById('freeResultsCloseBtn')?.addEventListener('click', () => {
        Core.els.freeResultsOverlay.classList.remove('show');
      });
      document.getElementById('freeReviewPrevBtn')?.addEventListener('click', () => {
        const pos = Core.els.freeReviewPosition.textContent.split('/').map(x => parseInt(x, 10));
        const idx = Math.max(0, (pos[0] || 1) - 2);
        Core.socket.emit('free:series:goto_index', { index: idx });
      });
      document.getElementById('freeReviewNextBtn')?.addEventListener('click', () => {
        const pos = Core.els.freeReviewPosition.textContent.split('/').map(x => parseInt(x, 10));
        const idx = Math.min((pos[1] || 1) - 1, (pos[0] || 1));
        Core.socket.emit('free:series:goto_index', { index: idx });
      });
      document.getElementById('freeReviewCloseBtn')?.addEventListener('click', () => {
        Core.els.freeReviewOverlay.classList.remove('show');
        Core.socket.emit('room:lock', true);
      });
    }
  },

  onQuestion(payload) {
    if (payload.phase === 'review') {
      Core.els.freeReviewPosition.textContent = `${payload.index + 1}/${payload.total}`;
      Core.els.freeReviewQuestion.textContent = payload.question;
      Core.els.freeReviewQuestion.classList.add('free-review-big-question');

      let expectedEl = document.getElementById('freeReviewExpected');
      if (!expectedEl) {
        expectedEl = document.createElement('div');
        expectedEl.id = 'freeReviewExpected';
        expectedEl.className = 'hint';
        expectedEl.style.marginTop = '.35rem';
        Core.els.freeReviewQuestion.insertAdjacentElement('afterend', expectedEl);
      }
      const secInfo = payload.seconds ? ` • Durée question: ${payload.seconds}s` : '';
      expectedEl.textContent = (payload.expected ? `Bonne réponse: ${payload.expected}` : 'Bonne réponse: —') + secInfo;

      renderAnswersList(Core.els.freeReviewList, payload.items, 'review');
      Core.els.freeReviewOverlay.classList.add('show');
      return;
    }

    const freeInfo = document.getElementById('freeInfo');
    if (typeof payload.index === 'number' && typeof payload.total === 'number') {
      freeInfo.textContent = `Question ${payload.index + 1}/${payload.total} en cours (${payload.seconds}s)`;
      setTimeout(() => {
        Core.hideQuestionOverlay();
        setTimeout(() => Core.socket.emit('free:series:next_question'), 400);
      }, payload.seconds * 1000);
    } else {
      freeInfo.textContent = `Question en cours (${payload.seconds}s)`;
    }
  },

  onProgress({ name, validated, context }) {
    const list = context === 'review' ? Core.els.freeReviewList : Core.els.freeResultsList;
    const cards = Array.from(list.querySelectorAll('.free-answer-card'));
    const card = cards.find((el) => el.dataset.player === name);
    if (!card) return;
    card.classList.toggle('validated', !!validated);
    const badge = card.querySelector('.free-answer-badge');
    if (badge) {
      badge.className = 'free-answer-badge ' + (validated ? 'yes' : 'no');
      badge.textContent = validated ? '✅ Validée (+1 point)' : '⏳ En attente';
    }
    const btn = card.querySelector('button');
    if (btn) {
      btn.className = validated ? 'btn-cyan' : 'btn-green';
      btn.textContent = validated ? 'Annuler validation' : 'Valider (+1)';
    }
  },

  onResult({ question, expected, items }) {
    const list = Core.els.freeResultsList;
    list.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'question free-review-big-question';
    title.style.marginBottom = '.55rem';
    title.textContent = question;

    const exp = document.createElement('div');
    exp.className = 'hint free-expected';
    exp.style.marginBottom = '.6rem';
    exp.textContent = expected ? `Bonne réponse: ${expected}` : 'Bonne réponse: —';

    list.appendChild(title);
    list.appendChild(exp);
    renderAnswersList(list, items, 'single');

    Core.els.freeResultsOverlay.classList.add('show');
  },

  onClose() {}
});
