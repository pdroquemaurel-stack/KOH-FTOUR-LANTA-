// public/js/tv-most.js
import { GameRegistry, Core } from './tv-core.js';

let bank = [];

function pickRandomQuestion() {
  if (!bank.length) return '';
  const item = bank[Math.floor(Math.random() * bank.length)];
  if (typeof item === 'string') return item;
  return String(item && item.q || '').trim();
}

function startMostRound(question, seconds) {
  Core.socket.emit('most:start', { question, seconds });
  Core.socket.emit('countdown:start', seconds);
  setTimeout(() => Core.socket.emit('most:close'), seconds * 1000);
}

function renderPodium(podium) {
  const container = document.getElementById('mostPodium');
  container.innerHTML = '';
  const slots = [
    { rank: 2, label: '🥈', cls: 'silver' },
    { rank: 1, label: '🥇', cls: 'gold' },
    { rank: 3, label: '🥉', cls: 'bronze' }
  ];
  slots.forEach((slot) => {
    const item = (podium || []).find((p, idx) => (idx + 1) === slot.rank);
    const card = document.createElement('div');
    card.className = `podium-step ${slot.cls}`;
    card.innerHTML = `
      <div class="podium-medal">${slot.label}</div>
      <div class="podium-name">${item ? item.name : '-'}</div>
      <div class="podium-votes">${item ? item.votes : 0} vote(s)</div>
    `;
    container.appendChild(card);
  });
}

GameRegistry.register('most', {
  onEnter() {
    const loadBtn = document.getElementById('mostLoadBtn');
    const loadedInfo = document.getElementById('mostLoadedInfo');
    const startBtn = document.getElementById('mostStartBtn');
    const randomBtn = document.getElementById('mostRandomAskBtn');
    const closeBtn = document.getElementById('mostResultCloseBtn');

    if (!startBtn._wired) {
      startBtn._wired = true;

      loadBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/most-questions.json', { cache: 'no-store' });
          const data = await res.json();
          bank = Array.isArray(data) ? data : [];
          loadedInfo.textContent = `${bank.length} question(s) chargée(s).`;
        } catch {
          bank = [];
          loadedInfo.textContent = '';
          alert('Impossible de charger /most-questions.json');
        }
      });

      startBtn.addEventListener('click', () => {
        const question = document.getElementById('mostQuestion').value.trim();
        const seconds = Math.max(5, Math.min(30, parseInt(document.getElementById('mostSeconds').value || '15', 10)));
        if (!question) {
          alert('Entre une question "Qui est le plus..."');
          return;
        }
        startMostRound(question, seconds);
      });

      randomBtn.addEventListener('click', () => {
        const seconds = Math.max(5, Math.min(30, parseInt(document.getElementById('mostSeconds').value || '15', 10)));
        const question = pickRandomQuestion();
        if (!question) {
          alert('Charge la banque de questions');
          return;
        }
        document.getElementById('mostQuestion').value = question;
        startMostRound(question, seconds);
      });
    }

    if (!closeBtn._wired) {
      closeBtn._wired = true;
      closeBtn.addEventListener('click', () => {
        document.getElementById('mostPodiumOverlay')?.classList.remove('show');
      });
    }
  },
  onQuestion({ question, seconds }) {
    document.getElementById('mostInfo').textContent = `Question en cours (${seconds}s): ${question}`;
  },
  onProgress() {},
  onResult({ question, podium, totalVotes }) {
    document.getElementById('mostResultQuestion').textContent = question || '';
    document.getElementById('mostVotesMeta').textContent = `Total des votes enregistrés: ${totalVotes || 0}`;
    renderPodium(podium || []);
    document.getElementById('mostPodiumOverlay')?.classList.add('show');
    document.getElementById('mostInfo').textContent = 'Résultats affichés (Top 3).';
  },
  onClose() {}
});
