// server/games/guess.js
function makeBins(min, max, answersMap, binCount = 10) {
  const span = Math.max(1, (max - min + 1));
  const n = Math.max(1, Math.min(binCount, span));
  const size = span / n; // taille “virtuelle” d'un bin
  const counts = Array.from({ length: n }, () => 0);
  answersMap.forEach((val) => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((val - min) / size)));
    counts[idx]++;
  });
  const bins = counts.map((count, i) => {
    const from = Math.round(min + i * size);
    const to = Math.round(i === n - 1 ? max : (min + (i + 1) * size) - 1);
    return { from, to, count };
  });
  return { bins, total: answersMap.size, min, max };
}

module.exports = {
  id: 'guess',
  name: 'Devine le nombre',

  init(room) {
    room.game = {
      open: false,
      question: '',
      correct: 0,
      min: 0,
      max: 100,
      answers: new Map() // name -> number (dernière valeur retenue)
    };
  },

  adminStart(io, room, code, { question, correct, min, max, seconds }) {
    const q = String(question || '').trim().slice(0, 200);

    let lo = Number.isFinite(+min) ? parseInt(min, 10) : 0;
    let hi = Number.isFinite(+max) ? parseInt(max, 10) : 100;
    if (isNaN(lo)) lo = 0;
    if (isNaN(hi)) hi = 100;
    if (lo === hi) hi = lo + 1;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }

    let corr = Number.isFinite(+correct) ? parseInt(correct, 10) : lo;
    if (isNaN(corr)) corr = lo;
    if (corr < lo) corr = lo;
    if (corr > hi) corr = hi;

    const sec = Math.max(1, Math.min(60, parseInt(seconds, 10) || 5));

    room.game = { open: true, question: q, correct: corr, min: lo, max: hi, answers: new Map() };

    io.to(code).emit('mode:changed', { mode: 'guess' });
    io.to(code).emit('guess:start', { question: q, min: lo, max: hi, seconds: sec });

    // Progress initiale (0 réponses)
    const prog = makeBins(lo, hi, room.game.answers);
    io.to(code).emit('guess:progress', prog);
  },

  // Accepte les mises à jour: on conserve la dernière valeur (pas seulement la première)
  playerAnswer(io, room, code, playerName, value, ack) {
    const g = room.game || {};
    if (!g.open) { ack && ack({ ok: false }); return; }
    const v = parseInt(value, 10);
    if (!Number.isFinite(v)) { ack && ack({ ok: false }); return; }
    const clamped = Math.max(g.min, Math.min(g.max, v));

    g.answers.set(playerName, clamped); // écrase l'ancienne, garde la dernière
    ack && ack({ ok: true });

    // Émettre la progression (histogramme)
    const prog = makeBins(g.min, g.max, g.answers);
    io.to(code).emit('guess:progress', prog);
  },

  adminClose(io, room, code, broadcastPlayers) {
    const g = room.game || {};
    if (!g.open) return;
    g.open = false;

    // Tolérance “exact” = 5% de la réponse (au moins 1)
    const tol = Math.max(1, Math.floor(Math.abs(g.correct) * 0.05));

    const diffs = [];
    g.answers.forEach((val, name) => {
      diffs.push({ name, val, diff: Math.abs(val - g.correct) });
    });

    // Gagnants exacts (<= tol) → +2 points
    const exactWinners = diffs.filter(d => d.diff <= tol).map(d => d.name);

    if (exactWinners.length > 0) {
      exactWinners.forEach(name => {
        room.scores.set(name, (room.scores.get(name) || 0) + 2);
      });
      io.to(code).emit('guess:result', {
        correct: g.correct,
        winners: exactWinners,
        bestDiff: 0,
        tol
      });
      broadcastPlayers(code);
      return;
    }

    // Sinon: plus proches → +1 (ex aequo)
    if (diffs.length > 0) {
      let best = diffs[0].diff;
      diffs.forEach(d => { if (d.diff < best) best = d.diff; });
      const winners = diffs.filter(d => d.diff === best).map(d => d.name);
      winners.forEach(name => {
        room.scores.set(name, (room.scores.get(name) || 0) + 1);
      });
      io.to(code).emit('guess:result', {
        correct: g.correct,
        winners,
        bestDiff: best,
        tol
      });
      broadcastPlayers(code);
    } else {
      // Personne n'a répondu
      io.to(code).emit('guess:result', {
        correct: g.correct,
        winners: [],
        bestDiff: null,
        tol
      });
    }
  }
};
