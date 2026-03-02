// server/games/most.js
module.exports = {
  id: 'most',
  name: 'Qui est le plus',

  init(room) {
    room.game = {
      open: false,
      question: '',
      seconds: 15,
      votes: new Map() // voter -> target
    };
  },

  adminStart(io, room, code, { question, seconds }) {
    const q = String(question || '').trim().slice(0, 220);
    const sec = Math.max(5, Math.min(30, parseInt(seconds, 10) || 15));
    const choices = Array.from(room.players.values()).map((p) => p.name).sort((a, b) => a.localeCompare(b));

    room.game = {
      open: true,
      question: q,
      seconds: sec,
      votes: new Map()
    };

    io.to(code).emit('mode:changed', { mode: 'most' });
    io.to(code).emit('most:question', { question: q, seconds: sec, choices });
  },

  playerVote(io, room, code, voterName, targetName, ack) {
    const g = room.game || {};
    if (!g.open) {
      ack && ack({ ok: false, error: 'closed' });
      return;
    }
    const target = String(targetName || '').trim();
    if (!target) {
      ack && ack({ ok: false, error: 'missing' });
      return;
    }
    const validTargets = new Set(Array.from(room.players.values()).map((p) => p.name));
    if (!validTargets.has(target)) {
      ack && ack({ ok: false, error: 'invalid_target' });
      return;
    }

    g.votes.set(voterName, target);
    ack && ack({ ok: true });
  },

  adminClose(io, room, code) {
    const g = room.game || {};
    if (!g.open) return;
    g.open = false;

    const counts = new Map();
    g.votes.forEach((target) => {
      counts.set(target, (counts.get(target) || 0) + 1);
    });

    const ranking = Array.from(counts.entries())
      .map(([name, votes]) => ({ name, votes }))
      .sort((a, b) => (b.votes - a.votes) || a.name.localeCompare(b.name));

    // Scoring "Koh Lanta - Ice breaker"
    // +1 si le votant a choisi une personne du top des votes
    // +2 si le joueur fait partie des personnes les plus votées
    if (ranking.length > 0) {
      const topVotes = ranking[0].votes;
      const topTargets = new Set(ranking.filter((r) => r.votes === topVotes).map((r) => r.name));

      g.votes.forEach((target, voter) => {
        if (topTargets.has(target)) {
          room.scores.set(voter, (room.scores.get(voter) || 0) + 1);
        }
      });

      topTargets.forEach((name) => {
        room.scores.set(name, (room.scores.get(name) || 0) + 2);
      });
    }

    io.to(code).emit('most:result', {
      question: g.question,
      ranking,
      podium: ranking.slice(0, 3),
      totalVotes: g.votes.size
    });
  }
};
