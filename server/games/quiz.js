// server/games/quiz.js
module.exports = {
  id: 'quiz',
  name: 'Quiz Vrai/Faux',

  init(room) {
    room.game = { open: false, question: '', correct: null, answers: new Map(), answerTimes: new Map(), startedAt: 0 };
  },

  adminStart(io, room, code, { question, correct, seconds }) {
    const q = String(question || '').trim().slice(0, 200);
    const c = !!correct;

    room.game = { open: true, question: q, correct: c, answers: new Map(), answerTimes: new Map(), startedAt: Date.now() };

    // S'assurer que les clients sont en mode quiz
    io.to(code).emit('mode:changed', { mode: 'quiz' });
    io.to(code).emit('quiz:question', {
      question: q,
      seconds: Math.max(1, Math.min(30, parseInt(seconds, 10) || 5))
    });
  },

  playerAnswer(io, room, code, playerName, answer, ack) {
    const g = room.game || {};
    if (!g.open) { ack && ack({ ok: false }); return; }
    if (!g.answers.has(playerName)) {
      g.answers.set(playerName, !!answer); // on prend la première réponse
      g.answerTimes.set(playerName, Date.now() - (g.startedAt || Date.now()));
    }
    ack && ack({ ok: true });
  },

  adminClose(io, room, code, broadcastPlayers) {
    const g = room.game || {};
    if (!g.open) return;
    g.open = false;

    let countTrue = 0, countFalse = 0;
    const winners = [];
    const losers = [];
    const answeredNames = [];

    g.answers.forEach((ans, name) => {
      answeredNames.push(name);
      if (ans) countTrue++; else countFalse++;
      if (ans === g.correct) winners.push(name);
      else losers.push(name);
    });

    const allPlayers = new Set([
      ...Array.from(room.scores.keys()),
      ...Array.from(room.players.values()).map((p) => p.name)
    ]);
    const noAnswer = Array.from(allPlayers).filter((name) => !g.answers.has(name));

    winners.forEach(name => {
      room.scores.set(name, (room.scores.get(name) || 0) + 2);
    });

    let fastest = null;
    let fastestMs = Number.POSITIVE_INFINITY;
    winners.forEach((name) => {
      const t = g.answerTimes.get(name);
      if (Number.isFinite(t) && t < fastestMs) { fastestMs = t; fastest = name; }
    });
    if (fastest) room.scores.set(fastest, (room.scores.get(fastest) || 0) + 1);

    io.to(code).emit('quiz:result', {
      correct: g.correct,
      countTrue,
      countFalse,
      total: countTrue + countFalse,
      winners,
      losers,
      noAnswer,
      fastest
    });
    broadcastPlayers(code);
  }
};
