import { GameRegistry, Core } from './tv-core.js';

GameRegistry.register('top3', {
  onEnter() {
    const start = document.getElementById('top3StartBtn');
    const close = document.getElementById('top3CloseBtn');
    const info = document.getElementById('top3Info');
    if (start && !start._wired) {
      start._wired = true;
      start.addEventListener('click', () => {
        const question = document.getElementById('top3Question').value;
        const expected = [
          document.getElementById('top3Expected1').value,
          document.getElementById('top3Expected2').value,
          document.getElementById('top3Expected3').value
        ];
        Core.socket.emit('top3:start', { question, expected, seconds: 25 });
        info.textContent = 'Top 3 lancé.';
      });
    }
    if (close && !close._wired) {
      close._wired = true;
      close.addEventListener('click', () => Core.socket.emit('top3:close'));
    }
  },
  onQuestion() {},
  onProgress() {},
  onResult(payload) {
    const rows = (payload.ranking || []).map((r) => ({ label: `${r.name}: +${r.added} (${r.ok}/3 + bonus ${r.bonus})`, type: r.added > 0 ? 'ok' : 'none' }));
    Core.showResultsOverlay('Top 3 - résultats', rows);
  },
  onClose() {}
});
