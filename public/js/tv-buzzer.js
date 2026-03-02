// public/js/tv-buzzer.js
import { GameRegistry, Core } from './tv-core.js';

// Module Buzzer
// - onEnter: connecte les boutons "Démarrer le tour" et "Réinitialiser le tour"
// - onQuestion: feedback facultatif quand round:open arrive (non nécessaire ici)
// - onResult: l'overlay gagnant est déjà géré par le Core (winnerName + overlay)

GameRegistry.register('buzzer', {
  onEnter() {
    const startBtn = document.getElementById('startRoundBtn');
    const resetBtn = document.getElementById('resetRoundBtn');

    if (!startBtn._wired) {
      startBtn._wired = true;
      startBtn.addEventListener('click', () => {
        // Ouverture immédiate du tour au clic animateur
        Core.socket.emit('buzz:open');
        Core.setStatus('Tour ouvert: buzz autorisé immédiatement.');
      });
    }
    if (!resetBtn._wired) {
      resetBtn._wired = true;
      resetBtn.addEventListener('click', () => {
        Core.socket.emit('round:reset');
      });
    }
  },

  onQuestion(payload) {
    // round:open est envoyé par le serveur et géré côté joueurs pour activer le bouton BUZZ.
    // On peut afficher un statut si tu veux (facultatif).
    // Exemple:
    // Core.setStatus('Tour ouvert: le plus rapide gagne !');
  },

  onResult(data) {
    // Rien à faire ici: l'overlay gagnant est affiché par le Core.
  },

  onClose() {}
});
