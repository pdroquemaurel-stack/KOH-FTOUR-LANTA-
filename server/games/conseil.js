module.exports = {
  id: 'conseil',
  name: 'Conseil',

  init(room) {
    room.game = { open: false, votes: new Map(), immunity: null, mode: 'malus', malus: 4 };
  },

  adminStart(io, room, code, { mode, malus }) {
    room.game = {
      open: true,
      votes: new Map(),
      immunity: null,
      mode: mode === 'elimination' ? 'elimination' : 'malus',
      malus: Math.max(1, Math.min(20, parseInt(malus, 10) || 4))
    };
    const choices = Array.from(room.players.values()).map((p) => p.name).sort((a, b) => a.localeCompare(b));
    io.to(code).emit('mode:changed', { mode: 'conseil' });
    io.to(code).emit('conseil:start', { choices, mode: room.game.mode });
  },

  playerVote(io, room, code, voterName, target, ack) {
    const g = room.game || {};
    if (!g.open) return ack && ack({ ok: false });
    const t = String(target || '').trim();
    if (!t) return ack && ack({ ok: false });
    g.votes.set(voterName, t);
    ack && ack({ ok: true });
  },

  adminSetImmunity(io, room, code, target) {
    const g = room.game || {};
    if (!g.open) return;
    g.immunity = String(target || '').trim() || null;
    io.to(code).emit('conseil:immunity', { name: g.immunity });
  },

  adminClose(io, room, code, broadcastPlayers) {
    const g = room.game || {};
    if (!g.open) return;
    g.open = false;
    const counts = new Map();
    g.votes.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
    if (g.immunity && counts.has(g.immunity)) counts.delete(g.immunity);
    const ranking = Array.from(counts.entries()).map(([name, votes]) => ({ name, votes })).sort((a, b) => (b.votes - a.votes) || a.name.localeCompare(b.name));
    const eliminated = ranking[0] ? ranking[0].name : null;
    let action = null;
    if (eliminated) {
      if (g.mode === 'elimination') {
        action = { type: 'elimination', name: eliminated };
      } else {
        const next = Math.max(0, (room.scores.get(eliminated) || 0) - g.malus);
        room.scores.set(eliminated, next);
        action = { type: 'malus', name: eliminated, malus: g.malus };
      }
    }
    io.to(code).emit('conseil:result', { ranking, immunity: g.immunity, action, totalVotes: g.votes.size });
    broadcastPlayers(code);
  }
};
