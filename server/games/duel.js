function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  id: 'duel',
  name: 'Partager / Trahir',

  init(room) {
    room.game = { open: false, round: 0, maxRounds: 3, pairs: [], choices: new Map(), bye: null };
  },

  _makePairs(room) {
    const names = shuffle(Array.from(room.players.values()).map((p) => p.name));
    const pairs = [];
    let bye = null;
    for (let i = 0; i < names.length; i += 2) {
      if (!names[i + 1]) { bye = names[i]; break; }
      pairs.push([names[i], names[i + 1]]);
    }
    return { pairs, bye };
  },

  adminStartRound(io, room, code) {
    const g = room.game || {};
    const built = this._makePairs(room);
    g.open = true;
    g.round = (g.round || 0) + 1;
    g.maxRounds = 3;
    g.pairs = built.pairs;
    g.bye = built.bye;
    g.choices = new Map();
    io.to(code).emit('mode:changed', { mode: 'duel' });
    io.to(code).emit('duel:round', { round: g.round, maxRounds: g.maxRounds, pairs: g.pairs, bye: g.bye });
  },

  playerChoice(io, room, code, playerName, choice, ack) {
    const g = room.game || {};
    if (!g.open) return ack && ack({ ok: false, error: 'closed' });
    const c = choice === 'betray' ? 'betray' : 'share';
    g.choices.set(playerName, c);
    ack && ack({ ok: true });
  },

  adminCloseRound(io, room, code, broadcastPlayers) {
    const g = room.game || {};
    if (!g.open) return;
    g.open = false;
    const results = [];

    if (g.bye) {
      room.scores.set(g.bye, (room.scores.get(g.bye) || 0) + 2);
      results.push({ pair: [g.bye, 'Djinn'], choices: ['bye', 'djinn'], delta: [2, 0] });
    }

    g.pairs.forEach(([a, b]) => {
      const ca = g.choices.get(a) || 'share';
      const cb = g.choices.get(b) || 'share';
      let da = 0; let db = 0;
      if (ca === 'share' && cb === 'share') { da = 3; db = 3; }
      else if (ca === 'betray' && cb === 'share') { da = 5; db = 0; }
      else if (ca === 'share' && cb === 'betray') { da = 0; db = 5; }
      else { da = 1; db = 1; }
      room.scores.set(a, (room.scores.get(a) || 0) + da);
      room.scores.set(b, (room.scores.get(b) || 0) + db);
      results.push({ pair: [a, b], choices: [ca, cb], delta: [da, db] });
    });

    io.to(code).emit('duel:result', { round: g.round, maxRounds: g.maxRounds, results, done: g.round >= g.maxRounds });
    broadcastPlayers(code);
  }
};
