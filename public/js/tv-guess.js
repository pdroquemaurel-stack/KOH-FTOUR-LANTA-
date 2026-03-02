// public/js/tv-guess.js
import { GameRegistry, Core } from './tv-core.js';

let bank = [];
let autoplay = { running: false, total: 0, done: 0 };

function renderGuessChart(prog) {
  const chart = document.getElementById('guessChart');
  const scale = document.getElementById('guessScale');
  chart.innerHTML = '';
  if (!prog || !Array.isArray(prog.bins) || prog.bins.length === 0) {
    scale.innerHTML = `<span>${prog?.min ?? ''}</span><span>${prog?.max ?? ''}</span>`;
    return;
  }
  const maxCount = Math.max(1, ...prog.bins.map(b => b.count));
  prog.bins.forEach(b => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const h = Math.round((b.count / maxCount) * 100);
    bar.style.height = (h || 2) + '%';
    bar.title = `${b.from}–${b.to}: ${b.count}`;
    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = b.count ? b.count : '';
    bar.appendChild(label);
    chart.appendChild(bar);
  });
  scale.innerHTML = `<span>${prog.min}</span><span>${prog.max}</span>`;
}

function startAutoplay(count) {
  if (!bank.length) { alert('Charge la banque'); return; }
  Core.autoPlayRunning = true;
  autoplay = { running: true, total: count, done: 0 };
  runNext();

  function runNext() {
    if (!Core.autoPlayRunning || !autoplay.running) { autoplay.running = false; Core.hideProgress(); return; }
    if (autoplay.done >= autoplay.total) { autoplay.running = false; Core.hideProgress(); return; }

    const item = bank[Math.floor(Math.random() * bank.length)];
    const q = item.q || '';
    const min = item.min ?? parseInt(document.getElementById('guessMin').value || '0', 10);
    const max = item.max ?? parseInt(document.getElementById('guessMax').value || '100', 10);
    const correct = item.c ?? parseInt(document.getElementById('guessCorrect').value || '0', 10);
    const seconds = Math.max(1, Math.min(60, parseInt(document.getElementById('guessSeconds').value || (item.s || '8'), 10)));
    if (!q) { autoplay.running = false; Core.autoPlayRunning = false; alert('Question vide.'); return; }

    Core.showProgress(`Auto‑play Devine: ${autoplay.done + 1}/${autoplay.total}`);
    Core.socket.emit('guess:start', { question: q, correct, min, max, seconds });
    Core.socket.emit('countdown:start', seconds);
    setTimeout(() => {
      Core.socket.emit('guess:close');
      autoplay.done++;
      if (Core.autoPlayRunning && autoplay.running) setTimeout(runNext, 1200);
    }, seconds * 1000);
  }
}

GameRegistry.register('guess', {
  onEnter() {
    const loadBtn = document.getElementById('guessLoadBtn');
    const loadedInfo = document.getElementById('guessLoadedInfo');
    const startBtn = document.getElementById('guessStartBtn');
    const randAskBtn = document.getElementById('guessRandomAskBtn');
    const seriesBtn = document.getElementById('guessSeriesBtn');

    if (!loadBtn._wired) {
      loadBtn._wired = true;
      loadBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/guess-questions.json', { cache: 'no-store' });
          const data = await res.json();
          bank = Array.isArray(data) ? data : [];
          loadedInfo.textContent = `${bank.length} question(s) chargée(s).`;
        } catch {
          alert('Impossible de charger /guess-questions.json');
          bank = []; loadedInfo.textContent=''; 
        }
      });

      startBtn.addEventListener('click', () => {
        const q = document.getElementById('guessQuestion').value.trim();
        if (!q) { alert('Entre une question'); return; }
        const correct = parseInt(document.getElementById('guessCorrect').value || '0', 10);
        const min = parseInt(document.getElementById('guessMin').value || '0', 10);
        const max = parseInt(document.getElementById('guessMax').value || '100', 10);
        const seconds = Math.max(1, Math.min(60, parseInt(document.getElementById('guessSeconds').value || '8', 10)));
        Core.socket.emit('guess:start', { question: q, correct, min, max, seconds });
        Core.socket.emit('countdown:start', seconds);
        setTimeout(() => Core.socket.emit('guess:close'), seconds * 1000);
      });

      randAskBtn.addEventListener('click', () => {
        if (!bank.length) { alert('Charge la banque'); return; }
        const item = bank[Math.floor(Math.random() * bank.length)];
        const q = item.q || '';
        const min = item.min ?? 0;
        const max = item.max ?? 100;
        const correct = item.c ?? 0;
        const seconds = Math.max(1, Math.min(60, parseInt(document.getElementById('guessSeconds').value || (item.s || '8'), 10)));
        if (!q) return;
        Core.socket.emit('guess:start', { question: q, correct, min, max, seconds });
        Core.socket.emit('countdown:start', seconds);
        setTimeout(() => Core.socket.emit('guess:close'), seconds * 1000);
      });

      seriesBtn.addEventListener('click', () => {
        if (!bank.length) { alert('Charge la banque'); return; }
        const count = Math.max(1, Math.min(50, parseInt(document.getElementById('guessSeriesCount').value || '10', 10)));
        startAutoplay(count);
      });
    }
  },
  onQuestion({ question, min, max, seconds }) {
    document.getElementById('guessInfo').textContent = `Question en cours (${seconds}s) — Intervalle: ${min} à ${max}`;
    document.getElementById('guessChart').innerHTML = '';
    document.getElementById('guessScale').innerHTML = `<span>${min}</span><span>${max}</span>`;
  },
  onProgress(prog) { renderGuessChart(prog); },
  onResult({ correct, winners, bestDiff, tol }) {
    const maxShow = 5;
    const names = winners || [];
    const shown = names.slice(0, maxShow).join(', ');
    const more = names.length > maxShow ? ` (+${names.length - maxShow})` : '';
    const who = names.length ? shown + more : 'Aucun';
    const detail = (bestDiff === null) ? '' : ` — meilleur écart: ${bestDiff}${tol ? `, tolérance≈±${tol}` : ''}`;
    document.getElementById('guessInfo').textContent = `Réponse: ${correct} — Gagnants: ${who}${detail}`;
    Core.showResultsOverlay(`Devine: réponse = ${correct}`, [
      { type: 'good', label: `🟢 Gagnants: ${who}` },
      { type: 'none', label: `⚪ Tolérance: ±${tol || 0}` },
      { type: (bestDiff === null ? 'none' : 'bad'), label: bestDiff === null ? '⚪ Aucune réponse envoyée' : `🔴 Meilleur écart: ${bestDiff}` }
    ]);
  },
  onClose() {}
});
