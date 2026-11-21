const $ = id => document.getElementById(id);
const canvas = $('roll'), ctx = canvas.getContext('2d');
const COLORS = { R: '#3ab4ff', L: '#ff9a3c', wrong: '#ff4d6d', good: '#9ef0d0', hint: '#c08cff' };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);
const freq = m => 440 * 2 ** ((m - 69) / 12);
const noteName = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const firstAt = (arr, x) => { const i = arr.findIndex(e => e.time >= x - 1e-6); return i < 0 ? arr.length : i; };

let song = null;        // {id, name, notes:[{midi,time,duration,bar,hand}], duration, bars, beats, pedal, sections, stages}
let rec = null;         // the song's library record: settings and progress
let mode = 'idle';      // 'idle' | 'listen' | 'learn' (waits for you) | 'timing' (play along)
let playing = false, t = 0, autoIdx = 0, beatIdx = 0;
let loopA = null, loopB = null;
let learn = null, timing = null, stats = null;
let coach = null;       // {sec, stage, stages, range:{from,to}} while the coach runs a section
let countIn = null;     // clicks before play-along starts
let lo = 48, hi = 83;   // visible key range
const down = new Set();     // keys the player is holding
const flash = new Map();    // midi -> {color, until}
const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let metro = pref('pc-metro', 'off') === 'on';

const status = s => ($('status').textContent = s);
const speed = () => $('tempo').value / 100;
function setTempo(p) { $('tempo').value = p; $('tempoVal').textContent = p + '%'; }
const icon = (name, fill) => `<svg class="i${fill ? ' fill' : ''}"><use href="#i-${name}"/></svg>`;

// Segmented controls (hands, input): the value lives in data-value; picking one fires 'change'.
function setSeg(seg, v) {
  seg.dataset.value = v;
  for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === v);
}
for (const seg of [$('hands'), $('input')]) {
  setSeg(seg, seg.dataset.value);
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.dataset.v === seg.dataset.value) return;
    setSeg(seg, b.dataset.v);
    seg.dispatchEvent(new Event('change'));
  });
}
const hands = () => $('hands').dataset.value;
const setHands = v => setSeg($('hands'), v);

// ---------- sound ----------
let ac = null, master = null;
const audio = () => {
  if (ac) return ac;
  ac = new AudioContext();
  master = ac.createGain();
  master.gain.value = $('volume').value / 100;
  master.connect(ac.destination);
  loadPiano();
  return ac;
};
$('volume').oninput = () => master && (master.gain.value = $('volume').value / 100);

// Salamander Grand Piano samples every 3 semitones (A0..C8); notes in between are pitch-shifted.
const piano = {};
function loadPiano() {
  for (let m = 21; m <= 108; m += 3) {
    const name = ['A', 'C', 'Ds', 'Fs'][((m - 21) / 3) % 4] + Math.floor((m - 12) / 12);
    fetch(`vendor/piano/${name}.mp3`)
      .then(r => r.arrayBuffer())
      .then(b => ac.decodeAudioData(b))
      .then(buf => (piano[m] = buf))
      .catch(() => {}); // missing sample: that range falls back to the synth
  }
}
function tone(midi, dur, vel = 0.7) {
  const s = Math.min(108, Math.max(21, 21 + 3 * Math.round((midi - 21) / 3)));
  if (piano[s]) {
    const a = audio(), src = a.createBufferSource(), g = a.createGain(), now = a.currentTime;
    src.buffer = piano[s];
    src.playbackRate.value = 2 ** ((midi - s) / 12);
    g.gain.value = 0.15 + 0.6 * vel;
    g.gain.setTargetAtTime(0, now + Math.max(dur, 0.1), 0.12); // damper: fade when the key is released
    src.connect(g).connect(master);
    src.start(now);
    src.stop(now + Math.max(dur, 0.1) + 1);
    return;
  }
  const a = audio(), o = a.createOscillator(), g = a.createGain(), now = a.currentTime;
  const len = Math.min(dur, 3) + 0.3;
  o.type = 'triangle';
  o.frequency.value = freq(midi);
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.25 * vel, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, now + len);
  o.connect(g).connect(master);
  o.start(now);
  o.stop(now + len + 0.05);
}
function click(accent) { // metronome / count-in
  const a = audio(), o = a.createOscillator(), g = a.createGain(), now = a.currentTime;
  o.frequency.value = accent ? 1760 : 1100;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, now + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
  o.connect(g).connect(master);
  o.start(now);
  o.stop(now + 0.08);
}
function lightKey(midi, color, ms) { flash.set(midi, { color, until: performance.now() + ms }); }

// ---------- reading songs ----------
function parseMidi(buf) {
  const m = new Midi(buf), h = m.header;
  // Controllers act per MIDI channel, not per track (e.g. a pedal written on the left-hand staff holds both hands).
  const byChannel = {};
  for (const tr of m.tracks) for (const [num, evs] of Object.entries(tr.controlChanges)) {
    const key = tr.channel + ':' + num;
    byChannel[key] = (byChannel[key] || []).concat(evs).sort((a, b) => a.time - b.time);
  }
  const tracks = m.tracks.map(tr => {
    const cc = num => byChannel[tr.channel + ':' + num] || []; // 7 volume, 11 expression, 64 sustain pedal
    return tr.notes.map(n => ({
      midi: n.midi, time: n.time, duration: n.duration,
      velocity: n.velocity * valueAt(cc(7), n.time) * valueAt(cc(11), n.time),
      sound: pedalEnd(cc(64), n.time + n.duration) - n.time, // how long it rings, pedal included
    }));
  });
  const notes = assignHands(tracks);
  const duration = notes.reduce((d, n) => Math.max(d, n.time + n.duration), 0);
  // Bar and beat start times from the time signatures (for sections, the metronome and the count-in).
  const bars = [], beats = [];
  const sigs = h.timeSignatures.length ? h.timeSignatures : [{ ticks: 0, timeSignature: [4, 4] }];
  const endTick = h.secondsToTicks(duration);
  for (let tick = 0, k = 0; tick <= endTick && bars.length < 5000;) {
    while (k + 1 < sigs.length && sigs[k + 1].ticks <= tick) k++;
    const [num, den] = sigs[k].timeSignature, beat = (h.ppq * 4) / den;
    bars.push(h.ticksToSeconds(tick));
    for (let b = 0; b < num; b++) beats.push({ time: h.ticksToSeconds(tick + b * beat), down: b === 0 });
    tick += beat * num;
  }
  const pedal = Object.entries(byChannel).filter(([k]) => k.endsWith(':64')).flatMap(([, e]) => e).sort((a, b) => a.time - b.time);
  return { notes, duration, bars, beats, pedal };
}

// Short original exercise so the app can be tried without a file: 8 bars, two sections.
function demoData() {
  const q = 0.5, notes = [];
  const rh = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 60,
    64, 65, 67, 69, 67, 65, 64, 62, 60, 64, 67, 72, 67, 64, 60, 60];
  const lh = [[48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55], [48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55]];
  rh.forEach((m, i) => notes.push({ midi: m, time: i * q, duration: q * 0.95, hand: 'R' }));
  lh.forEach((ch, i) => ch.forEach(m => notes.push({ midi: m, time: i * 4 * q, duration: 4 * q * 0.95, hand: 'L' })));
  notes.sort(byTime);
  const bars = lh.map((_, i) => i * 4 * q), beats = rh.map((_, i) => ({ time: i * q, down: i % 4 === 0 }));
  return { notes, duration: 16, bars, beats, pedal: [] };
}

function openSong(r) {
  const d = r.demo ? demoData() : parseMidi(r.buf);
  if (!d.notes.length) throw new Error('That file has no notes in it.');
  const barOf = time => { let i = 0; while (i + 1 < d.bars.length && d.bars[i + 1] <= time + 1e-6) i++; return i + 1; };
  for (const n of d.notes) n.bar = d.bars.length ? barOf(n.time) : 0;
  song = { id: r.id, name: r.name, ...d };
  song.sections = makeSections(song.notes, song.bars, song.duration);
  song.stages = song.sections.map(s => stagesFor(s, song.notes));
  let min = 127, max = 0;
  for (const n of song.notes) { min = Math.min(min, n.midi); max = Math.max(max, n.midi); }
  lo = Math.floor(min / 12) * 12;                 // start on a C
  hi = Math.max(Math.ceil((max + 1) / 12) * 12 - 1, lo + 23); // end on a B, at least 2 octaves
  rec = r;
  const s = r.settings;
  setTempo(s.tempo ?? 100);
  setHands(s.hands ?? 'both');
  loopA = s.loopA ?? null; loopB = s.loopB ?? null;
  coach = null;
  stop();
  showLoop();
  $('pTitle').textContent = song.name;
  if (!r.thumb) { r.thumb = fingerprint(song.notes, song.duration); Lib.put(r); }
}
function saveSettings() {
  if (!rec) return;
  rec.settings = { tempo: +$('tempo').value, hands: hands(), loopA, loopB };
  Lib.put(rec);
}

$('file').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const buf = await f.arrayBuffer();
  try {
    if (!parseMidi(buf).notes.length) throw new Error();
  } catch {
    return alert(typeof Midi === 'undefined' ? 'The MIDI reader (vendor/Midi.js) did not load, so songs cannot be opened.'
      : `Could not read "${f.name}" as a MIDI song. Pick a MIDI file.`);
  }
  const r = await Lib.add(f.name.replace(/\.(mid|midi|kar)$/i, ''), buf);
  go('#/song/' + encodeURIComponent(r.id));
};

// ---------- practice time ----------
let practiceAcc = 0;
function flushPractice() {
  if (practiceAcc < 1 || !rec) return;
  const s = Math.round(practiceAcc);
  practiceAcc = 0;
  rec.progress.practiceSec += s;
  rec.progress.lastPlayed = Date.now();
  Lib.put(rec);
  Lib.addTime(s);
}
document.addEventListener('visibilitychange', () => document.hidden && flushPractice());

// ---------- transport ----------
function syncIdx() { autoIdx = firstAt(song.notes, t); beatIdx = firstAt(song.beats, t); }
function modeButtons() {
  for (const [id, m] of [['listen', 'listen'], ['learn', 'learn'], ['play', 'timing']]) $(id).classList.toggle('on', mode === m);
}
function start(m) {
  if (!song) return;
  audio().resume();
  hideMsg();
  mode = m;
  learn = timing = null; // a leftover learn state would make Listen stop and wait for the player
  countIn = null;
  const r = coach?.range;
  const ns = r ? song.notes.filter(n => inRange(n, r.from, r.to)) : song.notes;
  if (m === 'learn') { learn = newLearn(ns, hands()); seekStep(learn, t); }
  if (m === 'timing') { timing = newTiming(ns, hands()); timingSeek(timing, t); }
  stats = { hits: 0, wrong: 0, perfect: 0, early: 0, late: 0, miss: 0, bars: {}, full: !r && loopB == null && t < 0.5 && hands() === 'both' };
  syncIdx();
  modeButtons();
  if (m === 'timing') beginCountIn(); else setPlaying(true);
}
let wake = null;
function setPlaying(on) {
  playing = on;
  $('pause').innerHTML = icon(on || countIn ? 'pause' : 'play', true);
  updateWake();
}
// Keep the screen on while playing or fullscreen: the hands are on the piano, not the phone.
const wantWake = () => playing || !!countIn || !!document.fullscreenElement;
function updateWake() {
  if (!wantWake()) { wake?.release(); wake = null; }
  else if (!wake || wake.released) navigator.wakeLock?.request('screen')
    .then(w => { if (wantWake() && (!wake || wake.released)) wake = w; else w.release(); })
    .catch(() => {});
}
document.addEventListener('fullscreenchange', updateWake);
document.addEventListener('visibilitychange', updateWake); // the browser drops the lock when the app is hidden
function stop() {
  flushPractice();
  mode = 'idle';
  countIn = null;
  setPlaying(false);
  learn = timing = null;
  t = coach ? coach.range.from : loopA ?? 0;
  if (song) syncIdx();
  modeButtons();
}
function jump(to) {
  t = Math.max(0, to);
  if (coach) t = Math.min(Math.max(t, coach.range.from), coach.range.to);
  syncIdx();
  if (learn) seekStep(learn, t);
  if (timing) timingSeek(timing, t);
}

// One bar of clicks before play-along starts (and when it resumes), so the first note isn't a surprise.
function beatInfo(x) {
  const bs = song.beats;
  if (bs.length < 2) return { len: 0.5, perBar: 4 };
  const i = Math.min(Math.max(firstAt(bs, x), 0), bs.length - 2);
  const len = bs[i + 1].time - bs[i].time;
  let d = i; while (d > 0 && !bs[d].down) d--;
  let e = d + 1; while (e < bs.length && !bs[e].down) e++;
  return { len: len > 0.05 ? len : 0.5, perBar: Math.min(8, Math.max(2, e - d)) };
}
function beginCountIn() {
  const b = beatInfo(t);
  countIn = { left: b.perBar, n: 0, every: (b.len / speed()) * 1000, next: performance.now() + 300, at: 0 };
  setPlaying(false);
}
function tickCountIn(now) {
  if (!countIn || now < countIn.next) return;
  if (countIn.left === 0) { countIn = null; return setPlaying(true); }
  click(countIn.n === 0);
  countIn.n++; countIn.left--; countIn.at = now; countIn.next += countIn.every;
}

// Pressing the active mode again pauses/resumes, like the play button; ↺ goes back to the start.
// Play while stopped starts the coach's step, or Learn.
function togglePause() {
  if (mode === 'idle') return coach ? coachAttempt() : start('learn');
  if (countIn) { countIn = null; return setPlaying(false); }
  if (playing) return setPlaying(false);
  if (mode === 'timing') beginCountIn(); else setPlaying(true);
}
const modeBtn = m => () => {
  if (mode === m) return togglePause();
  if (m === 'listen' && coach) return coachListen();
  if (coach) leaveCoach();
  start(m);
};
$('listen').onclick = modeBtn('listen');
$('learn').onclick = modeBtn('learn');
$('play').onclick = modeBtn('timing');
$('pause').onclick = togglePause;
$('stop').onclick = stop;
addEventListener('keydown', e => {
  if (view === 'play' && e.code === 'Space' && (e.target === document.body || e.target === canvas)) { e.preventDefault(); togglePause(); }
});
$('tempo').oninput = () => { $('tempoVal').textContent = $('tempo').value + '%'; if (!coach) saveSettings(); };
$('hands').onchange = () => {
  if (!coach) saveSettings();
  if (mode === 'learn' || mode === 'timing') start(mode);
};
const barAt = time => { let i = 0; while (i + 1 < song.bars.length && song.bars[i + 1] <= time + 1e-6) i++; return i + 1; };
function showLoop() {
  $('loopVal').textContent = loopB == null ? (loopA == null ? 'off' : `from bar ${barAt(loopA)}`)
    : `bars ${barAt(loopA ?? 0)} to ${barAt(loopB - 0.01)}`;
}
$('setA').onclick = () => { loopA = t; saveSettings(); showLoop(); };
$('setB').onclick = () => {
  if (t <= (loopA ?? 0)) return status('Move past the loop start first, then set the end.');
  loopB = t;
  saveSettings();
  showLoop();
  jump(loopA ?? 0);
};
$('clearLoop').onclick = () => { loopA = loopB = null; saveSettings(); showLoop(); };

// The timeline (mistakes per bar + playhead) doubles as the position slider: drag to move.
let seeking = false;
const seekTo = e => song && jump((Math.min(Math.max(e.offsetX, 0), $('timeline').clientWidth) / $('timeline').clientWidth) * song.duration);
$('timeline').addEventListener('pointerdown', e => { seeking = true; $('timeline').setPointerCapture(e.pointerId); seekTo(e); });
$('timeline').addEventListener('pointermove', e => seeking && seekTo(e));
for (const ev of ['pointerup', 'pointercancel']) $('timeline').addEventListener(ev, () => (seeking = false));
const toggleBtn = (id, on) => { $(id).classList.toggle('on', on); $(id).setAttribute('aria-pressed', on); };
$('metro').onclick = () => { metro = !metro; setPref('pc-metro', metro ? 'on' : 'off'); toggleBtn('metro', metro); };
$('fxBtn').onclick = () => { fxOn = !fxOn; setPref('pc-fx', fxOn ? 'on' : 'off'); toggleBtn('fxBtn', fxOn); };
toggleBtn('metro', metro);
toggleBtn('fxBtn', fxOn);

// Sound the computer's notes (and metronome clicks) up to song time x.
function playUntil(x) {
  const who = hands();
  while (autoIdx < song.notes.length && song.notes[autoIdx].time < x) {
    const n = song.notes[autoIdx++];
    // Listen plays the selected hand(s); Learn and Play along play the other hand while the player plays theirs.
    const mine = playsHand(n, who);
    if (mode === 'listen' ? mine : !mine) {
      tone(n.midi, (n.sound ?? n.duration) / speed(), n.velocity ?? 0.7);
      lightKey(n.midi, COLORS[n.hand], (n.duration / speed()) * 1000);
      burst(n.midi, COLORS[n.hand], 6);
    }
  }
  while (beatIdx < song.beats.length && song.beats[beatIdx].time < x) {
    const b = song.beats[beatIdx++];
    if (metro) click(b.down);
  }
}

function advance(dt) {
  let next = t + dt;
  const step = learn?.steps[learn.i];
  if (step && next >= step.time) next = step.time; // wait for the player
  const tail = timing ? WIN * speed() : 0;          // let the last notes still be played a little late
  const end = coach ? coach.range.to : loopB;
  if (end != null && next >= end + tail) {
    playUntil(end);
    if (timing) gradeMisses(end + tail);
    if (coach) return attemptDone();
    return jump(loopA ?? 0);
  }
  playUntil(end != null ? Math.min(next, end) : next);
  t = next;
  if (timing) gradeMisses(t);
  const learnDone = !learn || learn.i >= learn.steps.length;
  if (t >= song.duration + tail && learnDone) coach ? attemptDone() : finish();
}

function barStat(bar, ok, w = 1) {
  const b = (stats.bars[bar] ??= { ok: 0, bad: 0 });
  ok ? (b.ok += w) : (b.bad += w);
}
function gradeMisses(x) {
  for (const e of timingSweep(timing, x, WIN * speed())) {
    stats.miss++;
    barStat(e.bar, false);
    pop('miss', e.midi, COLORS.wrong);
  }
}
const score = () => (timing ? timingScore(timing, stats.wrong) : learnScore(stats.hits, stats.wrong));
const worstBars = k => Object.entries(stats.bars).filter(([, v]) => v.bad >= 1)
  .sort((a, b) => b[1].bad - a[1].bad).slice(0, k).map(([b]) => +b);
function recordRun(sc) {
  const p = rec.progress;
  for (const [b, v] of Object.entries(stats.bars)) p.heat[b] = +(v.bad / (v.ok + v.bad || 1)).toFixed(2);
  p.plays++;
  p.lastPlayed = Date.now();
  if (stats.full) p.best = Math.max(p.best ?? 0, sc);
  Lib.put(rec);
}

function finish() {
  if (mode === 'listen' || !stats) return stop();
  const sc = score(), s = stats, wasTiming = !!timing;
  stop();
  recordRun(sc);
  const worst = worstBars(3);
  showMsg(`${scoreHead(sc, 'Song finished', `${wasTiming ? 'Play along' : 'Learn'} at ${$('tempo').value}%`)}
    ${wasTiming ? grades(s) : grades(s, true)}
    <p>${worst.length ? `Most mistakes in ${worst.map(b => `bar ${b}`).join(', ')}.`
      : `No mistakes. ${wasTiming ? 'Try a faster tempo.' : 'Now try Play along, where the music keeps going.'}`}</p>
    <div class="acts">${worst.length ? `<button class="btn primary" onclick="fixBar(${worst[0]})">Loop bar ${worst[0]} slowly</button>` : ''}
    <button class="btn" onclick="hideMsg()">Close</button></div>`);
}
// Result header: score ring (green when passed, amber when not) with a title.
const scoreHead = (sc, title, sub) => `<div class="score">
  <div class="ring" style="--p:${sc};--c:${sc >= PASS ? 'var(--ok)' : 'var(--l)'}"><b>${sc}%</b></div>
  <div><h2>${esc(title)}</h2><span class="muted">${esc(sub)}</span></div></div>`;
const grades = (s, learnMode) => `<div class="grades" style="${learnMode ? 'grid-template-columns:1fr 1fr' : ''}">${(learnMode
  ? [['Correct', s.hits], ['Wrong', s.wrong]]
  : [['Perfect', s.perfect], ['Early', s.early], ['Late', s.late], ['Missed', s.miss], ['Wrong', s.wrong]])
  .map(([k, v]) => `<div><b>${v}</b>${k}</div>`).join('')}</div>`;

// Loop one bar slowly, waiting for the player.
function fixBar(bar) {
  hideMsg();
  if (coach) leaveCoach();
  loopA = song.bars[bar - 1] ?? 0;
  loopB = song.bars[bar] ?? song.duration;
  setTempo(Math.min(70, +$('tempo').value));
  saveSettings();
  t = loopA;
  start('learn');
  showLoop();
  status(`Looping bar ${bar} at ${$('tempo').value}%. Clear the loop in Settings.`);
}

// ---------- the coach ----------
const secName = sec => (sec === 'full' ? 'Whole song'
  : song.sections[sec].fromBar ? `Bars ${song.sections[sec].fromBar}–${song.sections[sec].toBar}` : `Part ${sec + 1}`);
const firstStage = i => { const d = rec.progress.sections[i] || 0; return d >= song.stages[i].length ? 0 : d; };

function startCoach(sec) {
  if (sec == null) {
    sec = song.sections.findIndex((_, i) => (rec.progress.sections[i] || 0) < song.stages[i].length);
    if (sec < 0) sec = 'full';
  }
  setCoach(sec, sec === 'full' ? 0 : firstStage(sec));
  coachIntro();
}
function setCoach(sec, stage) {
  const s = song.sections[sec];
  coach = {
    sec, stage,
    stages: sec === 'full' ? [FULL] : song.stages[sec],
    range: sec === 'full' ? { from: 0, to: song.duration } : { from: s.start, to: s.end },
  };
  stop();
  coachBanner();
}
function coachBanner() {
  $('coach').hidden = !coach;
  if (!coach) return;
  const st = coach.stages[coach.stage];
  $('coachTitle').textContent = coach.sec === 'full' ? 'Final run: the whole song'
    : `${secName(coach.sec)}, section ${coach.sec + 1} of ${song.sections.length}`;
  $('coachStep').textContent = `Step ${coach.stage + 1} of ${coach.stages.length}: ${stageLabel(st)}`;
  $('coachDots').innerHTML = coach.stages.map((_, i) => `<i class="${i === coach.stage ? 'c' : i < (rec.progress.sections[coach.sec] || 0) ? 'd' : ''}"></i>`).join('');
}
function coachIntro(afterListen) {
  const st = coach.stages[coach.stage];
  const how = st.mode === 'learn'
    ? 'The music waits until you play the right notes, so take your time. The computer plays the other hand.'
    : 'Now in time: the music keeps going. Play each note as it reaches the glowing line. You get one bar of clicks first.';
  showMsg(`<span class="muted">${afterListen ? 'Your turn' : esc(secName(coach.sec))}, step ${coach.stage + 1} of ${coach.stages.length}</span>
    <h2>${esc(stageLabel(st))}</h2>
    <p>${how} Score ${PASS}% to move on.</p>
    <div class="acts"><button class="btn primary" onclick="coachAttempt()">${icon('play', true)}Start</button>
    ${afterListen ? '' : `<button class="btn" onclick="coachListen()">${icon('ear')}Hear it first</button>`}
    <button class="btn" onclick="leaveCoach()">Leave coach</button></div>`);
}
function coachAttempt() {
  const st = coach.stages[coach.stage];
  setHands(st.hands);
  setTempo(st.tempo);
  coachBanner();
  t = coach.range.from;
  start(st.mode);
}
function coachListen() {
  setHands('both');
  setTempo(coach.stages[coach.stage].tempo);
  t = coach.range.from;
  start('listen');
}
function nextStep() {
  if (coach.sec === 'full') return null;
  if (coach.stage + 1 < coach.stages.length) return { sec: coach.sec, stage: coach.stage + 1 };
  if (coach.sec + 1 < song.sections.length) return { sec: coach.sec + 1, stage: firstStage(coach.sec + 1) };
  return { sec: 'full', stage: 0 };
}
const stepText = n => (n.sec === coach.sec ? stageLabel(coach.stages[n.stage])
  : n.sec === 'full' ? 'the whole song, both hands, full speed' : `next section (${secName(n.sec)})`);
function coachNext() {
  const n = nextStep();
  if (!n) return leaveCoach();
  const same = n.sec === coach.sec;
  setCoach(n.sec, n.stage);
  same ? coachAttempt() : coachIntro();
}
function attemptDone() {
  if (mode === 'listen') { stop(); return coachIntro(true); }
  const sc = score(), st = coach.stages[coach.stage], s = stats;
  stop();
  if (coach.sec === 'full') stats.full = true;
  recordRun(sc);
  const n = nextStep();
  if (sc >= PASS) {
    if (coach.sec !== 'full') {
      const p = rec.progress.sections;
      p[coach.sec] = Math.max(p[coach.sec] || 0, coach.stage + 1);
      rec.progress.mastery = mastery(song.stages, p);
      Lib.put(rec);
      saveNext();
      coachBanner();
    }
    burstAll();
    showMsg(`${scoreHead(sc, n ? 'Step passed' : 'You played the whole song', stageLabel(st))}
      ${st.mode === 'timing' ? grades(s) : ''}
      ${n ? `<p>Next up: <b>${esc(stepText(n))}</b>.</p>` : '<p>Every section is learnt. Come back tomorrow and play it through once more to make it stick.</p>'}
      <div class="acts">${n ? `<button class="btn primary" onclick="coachNext()">Next step${icon('next')}</button>` : ''}
      <button class="btn" onclick="coachAttempt()">Play it again</button> <button class="btn" onclick="leaveCoach()">Stop for now</button></div>`);
  } else {
    const worst = worstBars(1)[0];
    const tip = st.mode === 'timing'
      ? (s.early + s.late > s.miss ? 'You have the notes. Now keep with the clicks and the other hand.' : 'Watch the notes reach the glowing line, and play as they touch it.')
      : 'Go slowly and follow the purple keys: they show what comes next.';
    showMsg(`${scoreHead(sc, 'Not yet', `${PASS}% moves you on`)}
      ${st.mode === 'timing' ? grades(s) : ''}
      <p>${worst ? `Most mistakes in bar ${worst}. ` : ''}${tip}</p>
      <div class="acts"><button class="btn primary" onclick="coachAttempt()">Try again</button>
      ${worst ? `<button class="btn" onclick="fixBar(${worst})">Loop bar ${worst}</button>` : ''}
      <button class="btn" onclick="coachSkip()">Skip step</button></div>`);
  }
}
function coachSkip() { hideMsg(); coachNext(); }
function leaveCoach() {
  hideMsg();
  coach = null;
  coachBanner();
  const s = rec.settings;
  setTempo(s.tempo ?? 100);
  setHands(s.hands ?? 'both');
  stop();
}
$('coachHear').onclick = () => coach && coachListen();
$('coachSkip').onclick = () => coach && coachSkip();
$('coachExit').onclick = leaveCoach;

// ---------- player input ----------
function playerPress(midi, { sound = false, source = 'touch' } = {}) {
  if (sound) tone(midi, 0.6);
  if (mode === 'learn' && learn) {
    const step = learn.steps[learn.i];
    const r = press(learn, midi);
    if (r === 'wrong') {
      if (source === 'mic') return; // mic only listens for expected notes
      stats.wrong++;
      barStat(step?.bar ?? 0, false);
      lightKey(midi, COLORS.wrong, 400);
    } else if (r !== 'ignored') {
      stats.hits++;
      barStat(step.bar, true);
      const n = song.notes.find(x => x.midi === midi && Math.abs(x.time - step.time) < 0.06);
      lightKey(midi, COLORS[n?.hand] ?? COLORS.good, 300);
      burst(midi, COLORS[n?.hand] ?? COLORS.good, 10);
    }
    return;
  }
  if (mode === 'timing' && timing && playing) {
    const r = timingPress(timing, midi, t, WIN * speed(), PERFECT * speed());
    if (r.grade === 'wrong') {
      if (source === 'mic') return;
      stats.wrong++;
      barStat(song.notes[Math.max(0, autoIdx - 1)]?.bar ?? 0, false);
      lightKey(midi, COLORS.wrong, 400);
      pop('✕', midi, COLORS.wrong);
      return;
    }
    stats[r.grade]++;
    barStat(r.note.bar, true);
    if (r.grade !== 'perfect') barStat(r.note.bar, false, 0.3);
    lightKey(midi, COLORS[r.note.hand], 300);
    burst(midi, COLORS[r.note.hand], r.grade === 'perfect' ? 14 : 7);
    pop(r.grade, midi, r.grade === 'perfect' ? '#7dffc4' : '#ffd36b');
    return;
  }
  lightKey(midi, COLORS.good, 250);
  burst(midi, COLORS.good, 6);
}

// Touch / mouse on the on-screen keyboard (multi-touch via pointer ids).
const pointers = new Map();
canvas.addEventListener('pointerdown', e => {
  const m = keyAt(e.offsetX, e.offsetY);
  if (m == null) return;
  canvas.setPointerCapture(e.pointerId); // mouse released outside the canvas must still lift the key
  pointers.set(e.pointerId, m);
  down.add(m);
  playerPress(m, { sound: true });
});
const release = e => { down.delete(pointers.get(e.pointerId)); pointers.delete(e.pointerId); };
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

// Dragging sideways above the keys scrubs through the song: right = forward, at the falling notes' speed.
let scrub = null;
canvas.addEventListener('pointerdown', e => {
  if (!song || scrub || keyAt(e.offsetX, e.offsetY) != null) return;
  canvas.setPointerCapture(e.pointerId);
  scrub = { id: e.pointerId, x: e.offsetX, t0: t, moved: false };
});
canvas.addEventListener('pointermove', e => {
  if (scrub?.id !== e.pointerId) return;
  const dx = e.offsetX - scrub.x;
  if (Math.abs(dx) > 10) scrub.moved = true;
  if (scrub.moved) jump(Math.min(song.duration, scrub.t0 + dx * (WINDOW / layout().top)));
});

// Double tap above the keys toggles fullscreen. On pointerup: a touch only counts as a user gesture when it lifts.
let lastTap = -1e9;
canvas.addEventListener('pointercancel', e => { if (scrub?.id === e.pointerId) scrub = null; });
canvas.addEventListener('pointerup', e => {
  if (scrub?.id === e.pointerId) {
    const moved = scrub.moved;
    scrub = null;
    if (moved) return (lastTap = -1e9);
  }
  if (keyAt(e.offsetX, e.offsetY) != null) return;
  if (e.timeStamp - lastTap < 500) {
    lastTap = -1e9;
    (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())?.catch(() => {});
  } else lastTap = e.timeStamp;
});

// Tapping the mistake strip loops that bar slowly.
const barAtX = (cnv, x) => {
  const time = (x / cnv.clientWidth) * song.duration;
  let i = 0; while (i + 1 < song.bars.length && song.bars[i + 1] <= time) i++;
  return i + 1;
};

// MIDI keyboard (USB-OTG or Bluetooth). The piano makes its own sound, so no tone here.
async function enableMidi() {
  if (!navigator.requestMIDIAccess) return status('This browser has no MIDI support. Use Chrome on Android.');
  try {
    const access = await navigator.requestMIDIAccess();
    const hook = () => {
      const ins = [...access.inputs.values()];
      ins.forEach(i => (i.onmidimessage = onMidi));
      status(ins.length ? 'MIDI connected: ' + ins.map(i => i.name).join(', ') : 'No MIDI keyboard found. Plug it in (USB-OTG) or pair it, then it connects by itself.');
    };
    access.onstatechange = hook;
    hook();
  } catch (err) {
    status('MIDI blocked: ' + err.message);
  }
}
function onMidi(e) {
  const [s, note, vel] = e.data, cmd = s & 0xf0;
  if (cmd === 0x90 && vel > 0) { down.add(note); playerPress(note, { source: 'midi' }); }
  else if (cmd === 0x80 || cmd === 0x90) down.delete(note);
}

// Microphone: look at the spectrum only at the notes expected right now.
let mic = null;
async function enableMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const a = audio();
    await a.resume();
    const an = a.createAnalyser();
    an.fftSize = 8192; // ~5 Hz per bin, enough to tell neighbouring notes apart above ~C2
    an.smoothingTimeConstant = 0.2;
    a.createMediaStreamSource(stream).connect(an);
    mic = { stream, an, buf: new Float32Array(an.frequencyBinCount), thr: null, above: new Set(), prev: new Map() };
    calibrate();
  } catch (err) {
    status('Microphone blocked: ' + err.message);
  }
}
function micLevel(midi) { // loudest of fundamental and 2nd harmonic (low piano notes have weak fundamentals)
  const binHz = ac.sampleRate / mic.an.fftSize;
  let best = -Infinity;
  for (const h of [1, 2]) {
    const b = Math.round((freq(midi) * h) / binHz);
    for (let k = b - 1; k <= b + 1; k++) if (k > 0 && k < mic.buf.length) best = Math.max(best, mic.buf[k]);
  }
  return best;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function sample(ms, fn) {
  const end = performance.now() + ms;
  while (mic && performance.now() < end) { mic.an.getFloatFrequencyData(mic.buf); fn(); await sleep(30); }
}
async function calibrate() {
  mic.thr = null;
  showMsg('<h2>Microphone setup 1/2</h2><p>Stay quiet for 2 seconds…</p>');
  let noise = -Infinity;
  await sample(2000, () => { for (let m = 36; m <= 96; m++) noise = Math.max(noise, micLevel(m)); });
  if (!mic) return; // input was switched away mid-setup
  showMsg('<h2>Microphone setup 2/2</h2><p>Play and hold <b>middle C (C4)</b> at normal loudness…</p>');
  let peak = -Infinity;
  await sample(2500, () => (peak = Math.max(peak, micLevel(60))));
  if (!mic) return;
  mic.thr = noise + (peak - noise) * 0.4;
  if (peak - noise < 10) {
    showMsg(`<h2>Too quiet</h2><p>I could barely hear the piano. Move the phone closer and try again.</p>
      <button onclick="calibrate()">Try again</button> <button onclick="hideMsg()">Use anyway</button>`);
  } else {
    hideMsg();
    status('Microphone ready. Use headphones for the app sound, or the mic may hear it.');
  }
}
// The notes the mic should listen for right now.
function micTargets() {
  if (mode === 'learn' && learn) {
    const step = learn.steps[learn.i];
    return step && step.time - t <= 0.4 ? step.notes.filter(m => !learn.hit.has(m)) : [];
  }
  if (mode === 'timing' && timing && playing) {
    const out = [], w = WIN * speed();
    for (let k = timing.i; k < timing.exp.length && timing.exp[k].time <= t + w; k++) if (!timing.exp[k].res) out.push(timing.exp[k].midi);
    return out;
  }
  return [];
}
function micFrame() {
  if (!mic || mic.thr == null) return;
  const targets = micTargets();
  if (!targets.length) return;
  mic.an.getFloatFrequencyData(mic.buf);
  for (const m of targets) {
    const lv = micLevel(m), prev = mic.prev.get(m) ?? -Infinity;
    mic.prev.set(m, lv);
    // new onset: crossed the threshold, or a sharp jump (same note struck again)
    if (lv > mic.thr && (!mic.above.has(m) || lv - prev > 6)) {
      mic.above.add(m);
      playerPress(m, { source: 'mic' });
    } else if (lv < mic.thr - 6) mic.above.delete(m);
  }
}

$('input').onchange = () => {
  const v = $('input').dataset.value;
  if (mic) { mic.stream.getTracks().forEach(tr => tr.stop()); mic = null; hideMsg(); } // stop listening (and the mic indicator)
  if (v === 'midi') enableMidi();
  else if (v === 'mic') enableMic();
  else status('Tap the keys on screen.');
};

// ---------- messages ----------
function showMsg(html) { $('msgBody').innerHTML = html; $('msg').classList.add('show'); }
function hideMsg() { $('msg').classList.remove('show'); }

new ResizeObserver(resize).observe(canvas); // also fires when the ⚙ menu opens/closes
const openPanel = open => { $('panel').classList.toggle('open', open); $('menu').setAttribute('aria-expanded', open); };
$('menu').onclick = () => openPanel(!$('panel').classList.contains('open'));
$('panelClose').onclick = () => openPanel(false);
canvas.addEventListener('pointerdown', () => openPanel(false));

// ---------- screens: home, song page, player ----------
let view = '', pending = null, navigated = false;
const go = h => { navigated = true; location.hash = h; };
const back = fallback => (navigated ? history.back() : location.replace(fallback));
const VIEWS = { home: 'home', song: 'songPage', play: 'player' };

async function route() {
  const [, v = '', rawId = ''] = location.hash.split('/');
  const id = decodeURIComponent(rawId);
  const next = v === 'song' || v === 'play' ? v : 'home';
  if (view === 'play' && next !== 'play') leavePlayer();
  if (next !== 'home' && song?.id !== id) {
    const r = id === 'demo' ? await Lib.demo() : await Lib.get(id);
    try { if (!r) throw new Error(); openSong(r); } catch { return location.replace('#/'); }
  }
  view = next;
  for (const [k, el] of Object.entries(VIEWS)) $(el).hidden = k !== view;
  if (view === 'home') renderHome();
  if (view === 'song') renderSongPage();
  if (view === 'play') {
    resize();
    const p = pending;
    pending = null;
    if (p) runAction(p);
  }
}
addEventListener('hashchange', route);
function leavePlayer() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  hideMsg();
  coach = null;
  coachBanner();
  stop();
}
function runAction(p) {
  if (p.kind === 'coach') return startCoach(p.sec);
  if (p.kind === 'fix') return fixBar(p.bar);
  start(p.kind);
}
const playSong = (id, action) => { pending = action; go('#/play/' + encodeURIComponent(id)); };
$('back').onclick = () => back('#/song/' + encodeURIComponent(song.id));
$('spBack').onclick = () => back('#/');

const ago = ms => {
  const d = Math.floor((Date.now() - ms) / 864e5);
  return !ms ? 'Not practised yet' : d < 1 ? 'Practised today' : d < 2 ? 'Practised yesterday' : `Practised ${d} days ago`;
};
const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
const bgImg = url => (url ? `background-image:url(${url})` : '');
const meter = p => `<div class="bar"><i style="width:${p}%"></i></div>`;

// What the coach will do next for the open song; saved so the home screen can say it too.
function nextUp() {
  const p = rec.progress.sections;
  const sec = song.sections.findIndex((_, i) => (p[i] || 0) < song.stages[i].length);
  if (sec < 0) return { sec: 'full', text: 'Final run: the whole song at full speed' };
  return { sec, text: `${secName(sec)}: ${stageLabel(song.stages[sec][p[sec] || 0])}` };
}
function saveNext() {
  const text = nextUp().text;
  if (rec.progress.next !== text) { rec.progress.next = text; Lib.put(rec); }
}

let demoThumb = null;
async function renderHome() {
  await Lib.migrate();
  const [list, days] = await Promise.all([Lib.all(), Lib.days()]);
  for (const r of list) if (!r.thumb) { // songs added before covers existed
    try { const d = r.demo ? demoData() : parseMidi(r.buf); r.thumb = fingerprint(d.notes, d.duration); Lib.put(r); } catch {}
  }
  demoThumb ??= fingerprint(demoData().notes, 16);
  const recent = r => r.progress.lastPlayed || r.added;
  list.sort((a, b) => recent(b) - recent(a));

  const last = list.find(r => r.progress.lastPlayed);
  $('hero').innerHTML = last ? `
    <div class="stage" style="${bgImg(last.thumb)}">
      <span class="kicker">Pick up where you left off</span>
      <h1>${esc(last.name)}</h1>
      <p class="next">${last.progress.next ? `Next: ${esc(last.progress.next)}` : esc(ago(last.progress.lastPlayed))}</p>
      <div class="row">
        <button class="btn primary" data-continue="${esc(last.id)}">${icon('play', true)}Continue</button>
        <div class="meter">${meter(last.progress.mastery)}${last.progress.mastery}% learnt</div>
      </div>
    </div>` : `
    <div class="stage welcome" style="${bgImg(demoThumb)}">
      <h1>Learn a song one small piece at a time</h1>
      <p class="next">Add a MIDI file. The coach splits it into short sections and takes you through each one: one hand, then both, then up to speed.</p>
      <div class="row">
        <label class="btn primary" for="file">${icon('plus')}Add a song</label>
        <button class="btn" data-id="demo">Try the demo</button>
      </div>
    </div>`;

  // this week: one bar per day, height = minutes practised
  const secs = Object.fromEntries(days.map(d => [d.date, d.secs]));
  const week = [...Array(7)].map((_, k) => { const d = new Date(); d.setDate(d.getDate() - 6 + k); return d; });
  const most = Math.max(60, ...week.map(d => secs[dayKey(d)] || 0));
  let streak = 0;
  for (let d = new Date(), first = true; ; d.setDate(d.getDate() - 1), first = false) {
    if (secs[dayKey(d)]) streak++;
    else if (!first) break; // nothing yet today doesn't break the streak
  }
  const today = Math.round((secs[dayKey()] || 0) / 60);
  $('week').innerHTML = `<div class="days" aria-label="Minutes practised each day this week">${week.map((d, k) => {
    const v = secs[dayKey(d)] || 0;
    return `<div class="day${v ? ' on' : ''}${k === 6 ? ' today' : ''}" title="${Math.round(v / 60)} min">
      <i style="height:${5 + Math.round((43 * v) / most)}px"></i>${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</div>`;
  }).join('')}</div>
    <p><b>${today} min</b>practised today${streak > 1 ? `, ${streak} days in a row` : ''}</p>`;

  const row = r => `<button class="song${r.demo ? ' demo' : ''}" data-id="${esc(r.id)}">
      <span class="thumb" style="${bgImg(r.thumb || demoThumb)}"></span>
      <span class="t"><b>${esc(r.name)}</b><small>${esc(ago(r.progress.lastPlayed))}${r.progress.best != null ? `, best run ${r.progress.best}%` : ''}</small></span>
      <span class="pct">${r.progress.mastery}%${meter(r.progress.mastery)}</span></button>`;
  const demo = list.some(r => r.id === 'demo') ? '' : `<button class="song demo" data-id="demo">
      <span class="thumb" style="${bgImg(demoThumb)}"></span>
      <span class="t"><b>Demo: C major warm-up</b><small>Eight bars to try the app with</small></span><span class="pct"></span></button>`;
  $('songs').innerHTML = list.map(row).join('') + demo;
}
$('home').onclick = e => {
  const c = e.target.closest('[data-continue]');
  if (c) return playSong(c.dataset.continue, { kind: 'coach' });
  const card = e.target.closest('[data-id]');
  if (card) go('#/song/' + encodeURIComponent(card.dataset.id));
};

function renderSongPage() {
  const p = rec.progress, nx = nextUp();
  saveNext();
  $('spBanner').style.cssText = bgImg(rec.thumb);
  $('spTitle').textContent = song.name;
  const m = Math.floor(song.duration / 60), s = Math.round(song.duration % 60);
  $('spMeta').textContent = `${song.bars.length} bars, ${m}:${String(s).padStart(2, '0')} long. ${p.mastery}% learnt`
    + (p.best != null ? `, best full run ${p.best}%` : '') + (p.practiceSec ? `, ${fmtMin(Math.round(p.practiceSec / 60))} practised.` : '.');
  $('spCoachMain').textContent = p.mastery ? (nx.sec === 'full' ? 'Play the whole song' : 'Continue learning') : 'Start learning';
  $('spCoachSub').textContent = nx.text;
  const learnt = song.sections.filter((_, i) => (p.sections[i] || 0) >= song.stages[i].length).length;
  $('spPathNote').textContent = `${learnt} of ${song.sections.length} learnt`;
  $('spSections').innerHTML = song.sections.map((sec, i) => {
    const n = song.stages[i].length, done = Math.min(p.sections[i] || 0, n);
    const pips = song.stages[i].map((_, k) => `<i class="${k < done ? 'd' : ''}"></i>`).join('');
    const cls = done >= n ? 'done' : i === nx.sec ? 'now' : '';
    return `<button class="sec ${cls}" data-sec="${i}" aria-label="Section ${i + 1}, ${esc(secName(i))}, ${done} of ${n} steps done">
      <span class="n">${done >= n ? '✓' : i + 1}</span><b>${esc(secName(i))}</b><span class="pips">${pips}</span></button>`;
  }).join('');
  drawHeat($('spHeat'));
}
$('spSections').onclick = e => {
  const b = e.target.closest('[data-sec]');
  if (b) playSong(song.id, { kind: 'coach', sec: +b.dataset.sec });
};
$('spCoach').onclick = () => playSong(song.id, { kind: 'coach' });
$('spPlay').onclick = () => playSong(song.id, { kind: 'timing' });
$('spLearn').onclick = () => playSong(song.id, { kind: 'learn' });
$('spListen').onclick = () => playSong(song.id, { kind: 'listen' });
$('spHeat').onclick = e => song.bars.length && playSong(song.id, { kind: 'fix', bar: barAtX($('spHeat'), e.offsetX) });
$('spDelete').onclick = async () => {
  if (!confirm(`Remove "${song.name}" and its progress from this device?`)) return;
  await Lib.remove(song.id);
  song = rec = null;
  location.replace('#/');
};

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (view === 'play' && song) {
    tickCountIn(now);
    micFrame();
    if (playing) {
      advance(dt * speed());
      if (mode !== 'idle') { practiceAcc += dt; if (practiceAcc >= 20) flushPractice(); }
    }
    draw(dt, now);
  }
  requestAnimationFrame(frame);
}
route();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) {
  const hadWorker = !!navigator.serviceWorker.controller; // first install is not an update: no reload
  navigator.serviceWorker.addEventListener('controllerchange', () => hadWorker && location.reload());
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
