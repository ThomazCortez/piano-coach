// Pure logic (no DOM): which hand plays what, grouping into chord steps, checking presses.
// Loaded by index.html as a script and by matcher.test.js via require.
const CHORD_WINDOW = 0.05; // notes starting within 50 ms count as one chord

const byTime = (a, b) => a.time - b.time || a.midi - b.midi;
const avg = ns => ns.reduce((s, n) => s + n.midi, 0) / ns.length;

// tracks: array of note arrays. Two tracks -> higher one is right hand; otherwise split at middle C.
function assignHands(tracks) {
  const used = tracks.filter(t => t.length);
  if (used.length === 2) {
    const [r, l] = avg(used[0]) >= avg(used[1]) ? used : [used[1], used[0]];
    return [...r.map(n => ({ ...n, hand: 'R' })), ...l.map(n => ({ ...n, hand: 'L' }))].sort(byTime);
  }
  return used.flat().map(n => ({ ...n, hand: n.midi >= 60 ? 'R' : 'L' })).sort(byTime);
}

const playsHand = (note, hands) => hands === 'both' || note.hand === hands;

// Group the notes the player must play into steps: [{time, notes:[midi], bar}]
function buildSteps(notes, hands) {
  const steps = [];
  for (const n of notes) {
    if (!playsHand(n, hands)) continue;
    const last = steps[steps.length - 1];
    if (last && n.time - last.time < CHORD_WINDOW) {
      if (!last.notes.includes(n.midi)) last.notes.push(n.midi);
    } else steps.push({ time: n.time, notes: [n.midi], bar: n.bar });
  }
  return steps;
}

function newLearn(notes, hands) {
  return { steps: buildSteps(notes, hands), i: 0, hit: new Set() };
}

// Returns 'hit' (part of chord), 'done' (step complete), 'wrong', or 'ignored' (song finished).
function press(state, midi) {
  const step = state.steps[state.i];
  if (!step) return 'ignored';
  if (!step.notes.includes(midi)) return 'wrong';
  state.hit.add(midi);
  if (step.notes.every(m => state.hit.has(m))) {
    state.i++;
    state.hit = new Set();
    return 'done';
  }
  return 'hit';
}

// Index of the first step at or after time t (used for seeking and loops).
function seekStep(state, t) {
  let i = state.steps.findIndex(s => s.time >= t - 1e-6);
  state.i = i < 0 ? state.steps.length : i;
  state.hit = new Set();
}

if (typeof module !== 'undefined') module.exports = { assignHands, buildSteps, newLearn, press, seekStep, playsHand };
