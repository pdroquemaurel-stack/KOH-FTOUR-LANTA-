import { GameRegistry, Core } from './tv-core.js';

GameRegistry.register('conseil', {
  onEnter() {
    const start = document.getElementById('conseilStartBtn');
    const close = document.getElementById('conseilCloseBtn');
    const immun = document.getElementById('conseilImmunityBtn');
    if (start && !start._wired) {
      start._wired = true;
      start.addEventListener('click', () => {
        const mode = document.getElementById('conseilElimination').checked ? 'elimination' : 'malus';
        const malus = parseInt(document.getElementById('conseilMalusValue').value || '4', 10);
        Core.socket.emit('conseil:start', { mode, malus });
      });
    }
    if (close && !close._wired) { close._wired = true; close.addEventListener('click', () => Core.socket.emit('conseil:close')); }
    if (immun && !immun._wired) {
      immun._wired = true;
      immun.addEventListener('click', () => {
        const name = document.getElementById('conseilImmunityName').value;
        Core.socket.emit('conseil:immunity', { name });
      });
    }
  },
  onQuestion() {},
  onProgress() {},
  onResult(payload) {
    const rows = (payload.ranking || []).map((r) => ({ label: `${r.name}: ${r.votes} vote(s)`, type: 'none' }));
    if (payload.action) rows.unshift({ label: `Issue: ${payload.action.type} -> ${payload.action.name}`, type: 'ok' });
    if (payload.immunity) rows.unshift({ label: `Immunité: ${payload.immunity}`, type: 'ok' });
    Core.showResultsOverlay('Conseil - Dépouillement', rows);
  },
  onClose() {}
});
