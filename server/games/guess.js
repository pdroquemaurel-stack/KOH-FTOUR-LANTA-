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

    const diffs = [];
    g.answers.forEach((val, name) => {
      const diff = Math.abs(val - g.correct);
      const over = val > g.correct;
      diffs.push({ name, val, diff, over });
    });

    if (diffs.length === 0) {
      io.to(code).emit('guess:result', { correct: g.correct, winners: [], bestDiff: null, tol: 0, ranking: [] });
      return;
    }

    diffs.sort((a, b) => (a.diff - b.diff) || (a.over - b.over) || a.name.localeCompare(b.name));

    const awarded = [];
    const first = diffs[0];
    room.scores.set(first.name, (room.scores.get(first.name) || 0) + 3);
    awarded.push({ name: first.name, points: 3, over: first.over, value: first.val, diff: first.diff });

    if (diffs[1]) {
      const second = diffs[1];
      room.scores.set(second.name, (room.scores.get(second.name) || 0) + 1);
      awarded.push({ name: second.name, points: 1, over: second.over, value: second.val, diff: second.diff });
    }

    diffs.filter((d) => d.over).forEach((d) => {
      room.scores.set(d.name, Math.max(0, (room.scores.get(d.name) || 0) - 1));
    });

    io.to(code).emit('guess:result', {
      correct: g.correct,
      winners: awarded.map((a) => a.name),
      bestDiff: diffs[0].diff,
      tol: 0,
      ranking: diffs,
      awarded
    });
    broadcastPlayers(code);
  }

};
