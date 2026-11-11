// Run: node matcher.test.js
const assert = require('assert');
const { assignHands, newLearn, press, seekStep } = require('./matcher.js');

const n = (midi, time) => ({ midi, time, duration: 0.5, bar: 1 + Math.floor(time / 2) });

// Two tracks: the higher one becomes the right hand, whatever the order.
const notes = assignHands([[n(48, 0), n(52, 1)], [n(72, 0), n(76, 0.01), n(74, 1)]]);
assert.deepStrictEqual(notes.filter(x => x.hand === 'R').map(x => x.midi), [72, 76, 74]);
assert.deepStrictEqual(notes.filter(x => x.hand === 'L').map(x => x.midi), [48, 52]);

// One track: split at middle C.
assert.deepStrictEqual(assignHands([[n(59, 0), n(60, 0)]]).map(x => x.hand), ['L', 'R']);

// Both hands: first step is a 3-note chord (48, 72, 76 start together).
const s = newLearn(notes, 'both');
assert.strictEqual(s.steps.length, 2);
assert.deepStrictEqual(s.steps[0].notes.sort(), [48, 72, 76]);
assert.strictEqual(press(s, 60), 'wrong');
assert.strictEqual(press(s, 72), 'hit');
assert.strictEqual(press(s, 72), 'hit'); // repeat doesn't complete it
assert.strictEqual(press(s, 48), 'hit');
assert.strictEqual(press(s, 76), 'done');
assert.strictEqual(s.i, 1);
assert.strictEqual(press(s, 52), 'hit');
assert.strictEqual(press(s, 74), 'done');
assert.strictEqual(press(s, 74), 'ignored');

// Right hand only ignores left-hand notes.
const r = newLearn(notes, 'R');
assert.deepStrictEqual(r.steps.map(x => x.notes), [[72, 76], [74]]);
assert.strictEqual(press(r, 48), 'wrong');

// Seeking for loops.
seekStep(r, 0.5);
assert.strictEqual(r.i, 1);
seekStep(r, 99);
assert.strictEqual(r.i, 2);

// Controller values and sustain pedal.
const { valueAt, pedalEnd } = require('./matcher.js');
const vol = [{ time: 0, value: 0.5 }, { time: 2, value: 1 }];
assert.strictEqual(valueAt([], 5), 1);
assert.strictEqual(valueAt(vol, 1), 0.5);
assert.strictEqual(valueAt(vol, 2), 1);
const ped = [{ time: 1, value: 1 }, { time: 3, value: 0 }];
assert.strictEqual(pedalEnd(ped, 0.5), 0.5); // released before pedal goes down
assert.strictEqual(pedalEnd(ped, 2), 3);     // pedal held: rings until pedal up
assert.strictEqual(pedalEnd([{ time: 0, value: 1 }], 1), 9); // never released: capped
assert.strictEqual(pedalEnd([], 1), 1);

console.log('matcher: all tests passed');
