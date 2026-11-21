// Run: node coach.test.js
const assert = require('assert');
const c = require('./coach.js');

const n = (midi, time, hand = 'R', bar = 1 + Math.floor(time / 2)) => ({ midi, time, duration: 0.4, hand, bar });

// Sections: 4 bars of 2 s each; a section with no notes is skipped.
const notes = [n(60, 0), n(48, 0, 'L'), n(62, 3), n(64, 17), n(65, 18)];
const bars = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
const secs = c.makeSections(notes, bars, 19);
assert.deepStrictEqual(secs.map(s => [s.fromBar, s.toBar, s.start, s.end]), [[1, 4, 0, 8], [9, 10, 16, 19]]);
assert.deepStrictEqual(secs.map(s => s.index), [0, 1]);

// No bar info: 8-second chunks.
assert.strictEqual(c.makeSections([n(60, 0), n(60, 9)], [], 10).length, 2);

// Steps: both hands present -> all six; right hand only -> no left-hand step and no "both, waits".
assert.strictEqual(c.stagesFor(secs[0], notes).length, 6);
const rOnly = c.stagesFor(secs[1], notes);
assert.deepStrictEqual(rOnly.map(s => s.hands + s.mode), ['Rlearn', 'bothtiming', 'bothtiming', 'bothtiming']);
assert.strictEqual(c.stageLabel(rOnly[0]), 'Right hand at 60%, music waits for you');

// Mastery: 3 of 6 + 4 of 4 = 7/10.
assert.strictEqual(c.mastery([c.STAGES, rOnly], { 0: 3, 1: 9 }), 70);
assert.strictEqual(c.mastery([], {}), 0);

// Play-along grading.
const st = c.newTiming([n(60, 1), n(62, 2), n(64, 3), n(48, 3, 'L')], 'R');
assert.strictEqual(st.exp.length, 3);
assert.strictEqual(c.timingPress(st, 60, 1.02, 0.16, 0.07).grade, 'perfect');
assert.strictEqual(c.timingPress(st, 60, 1.05, 0.16, 0.07).grade, 'wrong'); // already graded
assert.strictEqual(c.timingPress(st, 62, 1.9, 0.16, 0.07).grade, 'early');
assert.strictEqual(c.timingPress(st, 65, 2.5, 0.16, 0.07).grade, 'wrong');
assert.deepStrictEqual(c.timingSweep(st, 3.5, 0.16).map(e => e.midi), [64]);
assert.strictEqual(st.exp[2].res, 'miss');
// (1 + 0.75 + 0) / (3 + 0.5) = 50%
assert.strictEqual(c.timingScore(st, 1), 50);

// Seeking back clears the grades from there on.
c.timingSeek(st, 2);
assert.deepStrictEqual(st.exp.map(e => e.res), ['perfect', null, null]);
assert.strictEqual(st.i, 1);
assert.strictEqual(c.timingPress(st, 62, 2.1, 0.16, 0.07).grade, 'late');

assert.strictEqual(c.learnScore(9, 1), 90);
assert.strictEqual(c.learnScore(0, 0), 100);

console.log('coach: all tests passed');
