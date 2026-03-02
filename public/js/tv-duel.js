import { GameRegistry, Core } from './tv-core.js';

GameRegistry.register('duel', {
  onEnter() {
    const start = document.getElementById('duelStartRoundBtn');
    const close = document.getElementById('duelCloseRoundBtn');
    if (start && !start._wired) { start._wired = true; start.addEventListener('click', () => Core.socket.emit('duel:start_round')); }
    if (close && !close._wired) { close._wired = true; close.addEventListener('click', () => Core.socket.emit('duel:close_round')); }
  },
  onQuestion(payload) {
    const info = document.getElementById('duelInfo');
    info.textContent = `Round ${payload.round}/${payload.maxRounds} en cours`;
  },
  onProgress() {},
  onResult(payload) {
    const rows = [];
    (payload.results || []).forEach((r) => rows.push({ label: `${r.pair[0]} (${r.choices[0]}) +${r.delta[0]} vs ${r.pair[1]} (${r.choices[1]}) +${r.delta[1]}`, type: 'ok' }));
    Core.showResultsOverlay('Duel - Révélations', rows);
  },
  onClose() {}
});
