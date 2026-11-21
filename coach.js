// Practice coach logic (no DOM): song sections, the practice steps for each, play-along timing grades.
// Loaded by index.html as a script and by coach.test.js via require.
const PASS = 90;       // % needed to move on to the next step
const WIN = 0.16;      // play-along: a press this close to a note (seconds, real time) counts
const PERFECT = 0.07;  // ...and this close is "perfect"

// Each section is learnt in these steps: hands separately and slow, then together, then in time up to full speed.
const STAGES = [
  { hands: 'R', tempo: 60, mode: 'learn' },
  { hands: 'L', tempo: 60, mode: 'learn' },
  { hands: 'both', tempo: 60, mode: 'learn' },
  { hands: 'both', tempo: 70, mode: 'timing' },
  { hands: 'both', tempo: 85, mode: 'timing' },
  { hands: 'both', tempo: 100, mode: 'timing' },
];
const FULL = { hands: 'both', tempo: 100, mode: 'timing' }; // the final whole-song run
const HAND_LABEL = { R: 'Right hand', L: 'Left hand', both: 'Both hands' };
const stageLabel = s => `${HAND_LABEL[s.hands]} at ${s.tempo}%, ${s.mode === 'learn' ? 'music waits for you' : 'in time'}`;
const inRange = (n, a, b) => n.time >= a - 1e-6 && n.time < b - 1e-6;

// Split the song into sections of `per` bars (bars = start time of each bar). No bar info: 8-second chunks.
// Sections without notes (long rests) are left out.
function makeSections(notes, bars, duration, per = 4) {
  let cuts;
  if (bars && bars.length > 1) cuts = bars.filter((_, i) => i % per === 0).map((time, i) => ({ time, bar: i * per + 1 }));
  else { cuts = []; for (let x = 0; x < duration; x += 8) cuts.push({ time: x, bar: 0 }); }
  const out = [];
  cuts.forEach((c, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].time : duration;
    if (!notes.some(n => inRange(n, c.time, end))) return;
    out.push({ index: out.length, start: c.time, end, fromBar: c.bar, toBar: c.bar ? Math.min(c.bar + per - 1, bars.length) : 0 });
  });
  return out;
}

// The steps for one section. A hand with no notes there gets no step of its own (and "both, waits" would repeat the other).
function stagesFor(sec, notes) {
  const ns = notes.filter(n => inRange(n, sec.start, sec.end));
  const has = { R: ns.some(n => n.hand === 'R'), L: ns.some(n => n.hand === 'L') };
  return STAGES.filter(s => (s.hands === 'both' ? s.mode === 'timing' || (has.R && has.L) : has[s.hands]));
}

// % of all section steps passed. done[i] = steps passed in section i.
function mastery(stages, done) {
  let d = 0, total = 0;
  stages.forEach((st, i) => { total += st.length; d += Math.min(done[i] || 0, st.length); });
  return total ? Math.round((100 * d) / total) : 0;
}

// ---------- play-along: the music keeps going and each note is graded ----------
function newTiming(notes, hands) {
  const exp = notes.filter(n => hands === 'both' || n.hand === hands)
    .map(n => ({ midi: n.midi, time: n.time, bar: n.bar, hand: n.hand, res: null }));
  return { exp, i: 0 };
}

// A press at song time t: the closest ungraded note with that pitch within `win` (song seconds).
function timingPress(st, midi, t, win, perfect) {
  let best = null;
  for (let k = st.i; k < st.exp.length; k++) {
    const e = st.exp[k];
    if (e.time > t + win) break;
    if (e.res || e.midi !== midi) continue;
    const d = t - e.time;
    if (Math.abs(d) <= win && (!best || Math.abs(d) < Math.abs(best.d))) best = { e, d };
  }
  if (!best) return { grade: 'wrong' };
  best.e.res = Math.abs(best.d) <= perfect ? 'perfect' : best.d < 0 ? 'early' : 'late';
  return { grade: best.e.res, note: best.e };
}

// Notes whose window has passed without a press become misses (returned so the app can show them).
function timingSweep(st, t, win) {
  const missed = [];
  while (st.i < st.exp.length && st.exp[st.i].time < t - win) {
    const e = st.exp[st.i++];
    if (!e.res) { e.res = 'miss'; missed.push(e); }
  }
  return missed;
}

// Seeking/looping: everything from t on is to be played (again).
function timingSeek(st, t) {
  st.i = st.exp.findIndex(e => e.time >= t - 1e-6);
  if (st.i < 0) st.i = st.exp.length;
  for (let k = st.i; k < st.exp.length; k++) st.exp[k].res = null;
}

// Perfect = 1, early/late = 0.75, missed = 0; a wrong note costs half a note.
function timingScore(st, wrong) {
  const n = st.exp.length;
  if (!n) return 100;
  const pts = st.exp.reduce((s, e) => s + (e.res === 'perfect' ? 1 : e.res === 'early' || e.res === 'late' ? 0.75 : 0), 0);
  return Math.max(0, Math.round((100 * pts) / (n + wrong * 0.5)));
}

const learnScore = (hits, wrong) => (hits + wrong ? Math.round((100 * hits) / (hits + wrong)) : 100);

if (typeof module !== 'undefined') module.exports = {
  PASS, WIN, PERFECT, STAGES, FULL, stageLabel, makeSections, stagesFor, mastery,
  newTiming, timingPress, timingSweep, timingSeek, timingScore, learnScore,
};
