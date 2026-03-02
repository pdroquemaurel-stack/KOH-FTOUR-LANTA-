// server/games/buzzer.js
module.exports = {
  id: 'buzzer',
  name: 'Buzzer',

  init(room) {
    room.game = { open: false, winner: null };
  },

  adminOpen(io, room, code) {
    room.game.open = true;
    room.game.winner = null;
    io.to(code).emit('round:open');
  },

  adminReset(io, room, code) {
    room.game.open = false;
    room.game.winner = null;
    io.to(code).emit('round:reset');
  },

  playerPress(io, room, code, playerName, ack, broadcastPlayers) {
    const g = room.game || {};
    if (!g.open || g.winner) { ack && ack({ ok: false }); return; }

    g.open = false;
    g.winner = playerName || 'Joueur';

    const name = g.winner;
    const newScore = (room.scores.get(name) || 0) + 1;
    room.scores.set(name, newScore);

    io.to(code).emit('round:winner', { name, score: newScore });
    broadcastPlayers(code);
    ack && ack({ ok: true, winner: name });
  }
};
