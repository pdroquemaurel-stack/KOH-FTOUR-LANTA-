module.exports = {
  id: 'top3',
  name: 'Top 3',

  init(room) {
    room.game = { open: false, question: '', expected: [], answers: new Map() };
  },

  adminStart(io, room, code, { question, expected, seconds }) {
    const q = String(question || '').trim().slice(0, 220);
    const exp = Array.isArray(expected)
      ? expected.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).slice(0, 3)
      : [];
    room.game = { open: true, question: q, expected: exp, answers: new Map() };
    io.to(code).emit('mode:changed', { mode: 'top3' });
    io.to(code).emit('top3:question', { question: q, seconds: Math.max(10, Math.min(90, parseInt(seconds, 10) || 25)) });
  },

  playerAnswer(io, room, code, playerName, picks, ack) {
    const g = room.game || {};
    if (!g.open) return ack && ack({ ok: false, error: 'closed' });
    const norm = Array.isArray(picks) ? picks : [];
    const clean = norm.slice(0, 3).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
    g.answers.set(playerName, clean);
    ack && ack({ ok: true });
  },

  adminClose(io, room, code, broadcastPlayers) {
    const g = room.game || {};
    if (!g.open) return;
    g.open = false;
    const expSet = new Set(g.expected);
    const ranking = [];
    g.answers.forEach((arr, name) => {
      let ok = 0;
      arr.forEach((a) => { if (expSet.has(a)) ok += 1; });
      const bonus = ok === 3 ? 2 : 0;
      const add = ok + bonus;
      room.scores.set(name, (room.scores.get(name) || 0) + add);
      ranking.push({ name, ok, bonus, added: add, picks: arr });
    });
    ranking.sort((a, b) => (b.added - a.added) || a.name.localeCompare(b.name));
    io.to(code).emit('top3:result', { question: g.question, expected: g.expected, ranking });
    broadcastPlayers(code);
  }
};
