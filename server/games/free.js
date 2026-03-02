// server/games/free.js
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

module.exports = {
  id: 'free',
  name: 'Réponse Libre',

  init(room) {
    room.game = {
      mode: 'single',
      phase: 'idle',
      // single
      open: false,
      question: '',
      seconds: 30,
      answer: '',
      answers: new Map(),
      // series
      series: [],        // [{ q, s, a }]
      seriesLength: 0,
      currentIndex: -1,
      answersByIdx: new Map(), // idx -> Map(name -> { text, validated })
      reviewIndex: 0
    };
  },

  // SINGLE
  adminStart(io, room, code, { question, seconds, answer }) {
    const q = String(question || '').trim().slice(0, 300);
    const sec = clampInt(seconds, 5, 180, 30);
    const a = String(answer || '').slice(0, 300);

    room.game.mode = 'single';
    room.game.phase = 'single_active';
    room.game.open = true;
    room.game.question = q;
    room.game.seconds = sec;
    room.game.answer = a;
    room.game.answers = new Map();

    io.to(code).emit('mode:changed', { mode: 'free' });
    io.to(code).emit('free:question', { question: q, seconds: sec });
  },

  playerAnswer(io, room, code, playerName, text, ack) {
    const g = room.game || {};
    const t = String(text || '').slice(0, 280);

    if (g.mode === 'single' && g.phase === 'single_active' && g.open) {
      const prev = g.answers.get(playerName) || { text: '', validated: false };
      g.answers.set(playerName, { text: t, validated: prev.validated === true });
      ack && ack({ ok: true });
      return;
    }

    if (g.mode === 'series' && g.phase === 'series_active' && g.currentIndex >= 0) {
      const idx = g.currentIndex;
      let map = g.answersByIdx.get(idx);
      if (!map) { map = new Map(); g.answersByIdx.set(idx, map); }
      const prev = map.get(playerName) || { text: '', validated: false };
      map.set(playerName, { text: t, validated: prev.validated === true });
      ack && ack({ ok: true });
      return;
    }

    ack && ack({ ok: false });
  },

  adminClose(io, room, code) {
    const g = room.game || {};
    if (g.mode !== 'single' || g.phase !== 'single_active') return;

    g.open = false;
    g.phase = 'idle';

    const results = [];
    room.players.forEach(p => {
      const rec = g.answers.get(p.name);
      results.push({ name: p.name, text: rec ? rec.text : '', validated: rec ? !!rec.validated : false });
    });
    g.answers.forEach((rec, name) => {
      if (!results.find(r => r.name === name)) {
        results.push({ name, text: rec.text, validated: !!rec.validated });
      }
    });
    results.sort((a, b) => a.name.localeCompare(b.name));

    io.to(code).emit('free:results', {
      question: g.question,
      expected: g.answer || '',
      items: results
    });
  },

  adminToggleValidate(io, room, code, playerName, broadcastPlayers) {
    const g = room.game || {};

    if (g.mode === 'single' && g.phase === 'idle') {
      const rec = g.answers.get(playerName) || { text: '', validated: false };
      rec.validated = !rec.validated;
      g.answers.set(playerName, rec);
      const prev = room.scores.get(playerName) || 0;
      const next = rec.validated ? prev + 1 : Math.max(0, prev - 1);
      room.scores.set(playerName, next);
      io.to(code).emit('free:validated', { name: playerName, validated: rec.validated, score: next });
      broadcastPlayers(code);
      return;
    }

    if (g.mode === 'series' && g.phase === 'review') {
      const idx = g.reviewIndex;
      let map = g.answersByIdx.get(idx);
      if (!map) { map = new Map(); g.answersByIdx.set(idx, map); }
      const rec = map.get(playerName) || { text: '', validated: false };
      rec.validated = !rec.validated;
      map.set(playerName, rec);
      const prev = room.scores.get(playerName) || 0;
      const next = rec.validated ? prev + 1 : Math.max(0, prev - 1);
      room.scores.set(playerName, next);
      io.to(code).emit('free:review_validated', { index: idx, name: playerName, validated: rec.validated, score: next });
      broadcastPlayers(code);
      return;
    }
  },

  // SERIES
  adminSeriesStart(io, room, code, { items }) {
    const list = Array.isArray(items) ? items.slice(0, 50) : [];
    if (list.length === 0) return;

    const norm = list.map(it => ({
      q: String((it && it.q) || '').slice(0, 300),
      s: clampInt(it && it.s, 5, 180, 30),
      a: String((it && it.a) || '').slice(0, 300)
    }));

    room.game.mode = 'series';
    room.game.phase = 'series_active';
    room.game.series = norm;
    room.game.seriesLength = norm.length;
    room.game.currentIndex = -1;
    room.game.answersByIdx = new Map();
    room.game.reviewIndex = 0;

    io.to(code).emit('mode:changed', { mode: 'free' });
  },

  adminSeriesNextQuestion(io, room, code) {
    const g = room.game || {};
    if (g.mode !== 'series' || g.phase !== 'series_active') return;
    const next = g.currentIndex + 1;
    if (next >= g.seriesLength) {
      g.phase = 'review';
      g.reviewIndex = 0;
      const first = g.series[0];
      const items = this._buildReviewItems(room, g, 0);
      io.to(code).emit('free:review_open', {
        index: 0,
        total: g.seriesLength,
        question: first.q,
        expected: first.a || '',
        seconds: first.s,
        items
      });
      return;
    }
    g.currentIndex = next;
    const cur = g.series[next];
    io.to(code).emit('free:question', { question: cur.q, seconds: cur.s, index: next, total: g.seriesLength });
  },

  adminSeriesFinish(io, room, code) {
    const g = room.game || {};
    if (g.mode !== 'series' || g.phase !== 'series_active') return;

    const askedCount = g.currentIndex + 1;
    if (askedCount <= 0) return;

    g.series = g.series.slice(0, askedCount);
    g.seriesLength = askedCount;
    g.currentIndex = askedCount - 1;
    g.phase = 'review';
    g.reviewIndex = 0;

    const first = g.series[0];
    const items = this._buildReviewItems(room, g, 0);
    io.to(code).emit('free:review_open', {
      index: 0,
      total: g.seriesLength,
      question: first.q,
      expected: first.a || '',
      seconds: first.s,
      items
    });
  },

  adminSeriesGotoIndex(io, room, code, index) {
    const g = room.game || {};
    if (g.mode !== 'series' || g.phase !== 'review') return;
    const idx = clampInt(index, 0, g.seriesLength - 1, 0);
    g.reviewIndex = idx;
    const q = g.series[idx].q;
    const a = g.series[idx].a || '';
    const items = this._buildReviewItems(room, g, idx);
    io.to(code).emit('free:review_open', {
      index: idx,
      total: g.seriesLength,
      question: q,
      expected: a,
      seconds: g.series[idx].s,
      items
    });
  },

  _buildReviewItems(room, g, idx) {
    const items = [];
    const map = g.answersByIdx.get(idx) || new Map();
    room.players.forEach(p => {
      const rec = map.get(p.name);
      items.push({ name: p.name, text: rec ? rec.text : '', validated: rec ? !!rec.validated : false });
    });
    map.forEach((rec, name) => {
      if (!items.find(r => r.name === name)) {
        items.push({ name, text: rec.text, validated: !!rec.validated });
      }
    });
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  }
};
