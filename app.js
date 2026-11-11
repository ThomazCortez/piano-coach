const $ = id => document.getElementById(id);
const canvas = $('roll'), ctx = canvas.getContext('2d');
const COLORS = { R: '#4f8cff', L: '#3ccf91', wrong: '#ff5468', good: '#ffd34f' };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = m => [1, 3, 6, 8, 10].includes(m % 12);
const freq = m => 440 * 2 ** ((m - 69) / 12);

let song = null;        // {name, notes:[{midi,time,duration,bar,hand}], duration}
let mode = 'idle';      // 'idle' | 'listen' | 'learn'
let playing = false, t = 0, autoIdx = 0;
let loopA = null, loopB = null;
let learn = null, stats = null;
let lo = 48, hi = 83;   // visible key range
const down = new Set();     // keys the player is holding
const flash = new Map();    // midi -> {color, until}

const status = s => ($('status').textContent = s);
const hands = () => $('hands').value;
const speed = () => $('tempo').value / 100;

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
function lightKey(midi, color, ms) { flash.set(midi, { color, until: performance.now() + ms }); }

// ---------- loading ----------
function setSong(notes, name) {
  if (!notes.length) return status('That file has no notes in it.');
  song = { name, notes, duration: notes.reduce((d, n) => Math.max(d, n.time + n.duration), 0) };
  let min = 127, max = 0;
  for (const n of notes) { min = Math.min(min, n.midi); max = Math.max(max, n.midi); }
  lo = Math.floor(min / 12) * 12;                 // start on a C
  hi = Math.max(Math.ceil((max + 1) / 12) * 12 - 1, lo + 23); // end on a B, at least 2 octaves
  $('name').textContent = name;
  loopA = loopB = null;
  stop();
  status(`${notes.length} notes · ${Math.round(song.duration)} s · keys ${noteName(lo)}–${noteName(hi)}`);
}

function loadMidi(buf, name) {
  const m = new Midi(buf);
  const bar = ticks => (m.header.ticksToMeasures ? Math.floor(m.header.ticksToMeasures(ticks)) + 1 : 0);
  // Controllers act per MIDI channel, not per track (e.g. a pedal written on the left-hand staff holds both hands).
  const byChannel = {};
  for (const tr of m.tracks) for (const [num, evs] of Object.entries(tr.controlChanges)) {
    const key = tr.channel + ':' + num;
    byChannel[key] = (byChannel[key] || []).concat(evs).sort((a, b) => a.time - b.time);
  }
  const tracks = m.tracks.map(tr => {
    const cc = num => byChannel[tr.channel + ':' + num] || []; // 7 volume, 11 expression, 64 sustain pedal
    return tr.notes.map(n => ({
      midi: n.midi, time: n.time, duration: n.duration, bar: bar(n.ticks),
      velocity: n.velocity * valueAt(cc(7), n.time) * valueAt(cc(11), n.time),
      sound: pedalEnd(cc(64), n.time + n.duration) - n.time, // how long it rings, pedal included
    }));
  });
  setSong(assignHands(tracks), name);
}

$('file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  try {
    loadMidi(buf, f.name);
    saveLast(buf, f.name);
  } catch (err) {
    status(typeof Midi === 'undefined' ? 'The MIDI reader (vendor/Midi.js) did not load, so songs cannot be opened.'
      : `Could not read "${f.name}" as a MIDI song. Pick a MIDI file.`);
  }
  e.target.value = '';
};

// Short original exercise so the app can be tried without a file.
$('demo').onclick = () => {
  const rh = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 60];
  const lh = [[48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55]];
  const q = 0.5, notes = [];
  rh.forEach((m, i) => notes.push({ midi: m, time: i * q, duration: q * 0.95, bar: 1 + Math.floor(i / 4), hand: 'R' }));
  lh.forEach((ch, i) => ch.forEach(m => notes.push({ midi: m, time: i * 4 * q, duration: 4 * q * 0.95, bar: i + 1, hand: 'L' })));
  setSong(notes.sort((a, b) => a.time - b.time), 'Demo: C major scale');
};

// Remember the last song (per device). Failure just means it isn't remembered.
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('piano-coach', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('songs');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function saveLast(buf, name) {
  try { (await db()).transaction('songs', 'readwrite').objectStore('songs').put({ buf, name }, 'last'); } catch {}
}
async function loadLast() {
  try {
    const d = await db();
    const v = await new Promise(r => {
      const q = d.transaction('songs').objectStore('songs').get('last');
      q.onsuccess = () => r(q.result);
      q.onerror = () => r(null);
    });
    if (v) loadMidi(v.buf, v.name);
  } catch {}
}

// ---------- transport ----------
function start(m) {
  if (!song) return status('Open a song first (or tap Demo).');
  audio().resume();
  mode = m;
  learn = null; // a leftover learn state would make Listen stop and wait for the player
  if (m === 'learn') {
    learn = newLearn(song.notes, hands());
    seekStep(learn, t);
    stats = { hits: 0, wrong: 0, wrongByBar: {} };
  }
  autoIdx = song.notes.findIndex(n => n.time >= t);
  if (autoIdx < 0) autoIdx = song.notes.length;
  setPlaying(true);
  $('listen').classList.toggle('on', m === 'listen');
  $('learn').classList.toggle('on', m === 'learn');
}
let wake = null;
function setPlaying(on) {
  playing = on;
  $('pause').textContent = on || mode === 'idle' ? '⏸' : '▶';
  updateWake();
}
// Keep the screen on while playing or fullscreen: the hands are on the piano, not the phone.
const wantWake = () => playing || !!document.fullscreenElement;
function updateWake() {
  if (!wantWake()) { wake?.release(); wake = null; }
  else if (!wake || wake.released) navigator.wakeLock?.request('screen')
    .then(w => { if (wantWake() && (!wake || wake.released)) wake = w; else w.release(); })
    .catch(() => {});
}
document.addEventListener('fullscreenchange', updateWake);
document.addEventListener('visibilitychange', updateWake); // the browser drops the lock when the app is hidden
function stop() {
  mode = 'idle';
  setPlaying(false);
  learn = null;
  t = loopA ?? 0;
  $('listen').classList.remove('on');
  $('learn').classList.remove('on');
}
function jump(to) {
  t = Math.max(0, to);
  autoIdx = song.notes.findIndex(n => n.time >= t);
  if (autoIdx < 0) autoIdx = song.notes.length;
  if (learn) seekStep(learn, t);
}
// Pressing the active mode again pauses/resumes, like the pause button; ■ goes back to the start.
const togglePause = () => mode !== 'idle' && setPlaying(!playing);
$('listen').onclick = () => (mode === 'listen' ? togglePause() : start('listen'));
$('learn').onclick = () => (mode === 'learn' ? togglePause() : start('learn'));
$('pause').onclick = togglePause;
$('stop').onclick = stop;
addEventListener('keydown', e => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); togglePause(); } });
$('tempo').oninput = () => ($('tempoVal').textContent = $('tempo').value + '%');
$('hands').onchange = () => { if (mode === 'learn') start('learn'); };
$('setA').onclick = () => { loopA = t; status(`Loop start at ${t.toFixed(1)} s`); };
$('setB').onclick = () => {
  if (t <= (loopA ?? 0)) return status('Move past the loop start first, then tap B.');
  loopB = t;
  status(`Looping ${(loopA ?? 0).toFixed(1)} s – ${t.toFixed(1)} s`);
  jump(loopA ?? 0);
};
$('clearLoop').onclick = () => { loopA = loopB = null; status('Loop cleared'); };
let seeking = false;
$('pos').oninput = () => { seeking = true; if (song) jump(($('pos').value / 1000) * song.duration); };
$('pos').onchange = () => (seeking = false);

function advance(dt) {
  let next = t + dt;
  const step = learn?.steps[learn.i];
  if (step && next >= step.time) next = step.time; // wait for the player
  if (loopB != null && next >= loopB) return jump(loopA ?? 0);
  while (autoIdx < song.notes.length && song.notes[autoIdx].time < next) {
    const n = song.notes[autoIdx++];
    // Listen plays the selected hand(s); Learn plays the other hand while the player plays theirs.
    const mine = playsHand(n, hands());
    if (mode === 'listen' ? mine : !mine) {
      tone(n.midi, (n.sound ?? n.duration) / speed(), n.velocity ?? 0.7);
      lightKey(n.midi, COLORS[n.hand], (n.duration / speed()) * 1000);
    }
  }
  t = next;
  const learnDone = !learn || learn.i >= learn.steps.length;
  if (t >= song.duration && learnDone) finish();
}

function finish() {
  const wasLearn = mode === 'learn';
  stop();
  if (!wasLearn || !stats) return;
  const total = stats.hits + stats.wrong;
  const acc = total ? Math.round((stats.hits / total) * 100) : 100;
  const worst = Object.entries(stats.wrongByBar).sort((a, b) => b[1] - a[1]).slice(0, 3);
  showMsg(`<h2>Finished!</h2>
    <p>Correct notes: <b>${stats.hits}</b> · Wrong notes: <b>${stats.wrong}</b> · Accuracy: <b>${acc}%</b></p>
    ${worst.length ? `<p>Practice these bars: ${worst.map(([b, c]) => `bar ${b} (${c} mistake${c > 1 ? 's' : ''})`).join(', ')}.<br>Tip: use A/B to loop them at a slower tempo.</p>` : '<p>No mistakes. Try a faster tempo!</p>'}
    <button onclick="hideMsg()">OK</button>`);
}

// ---------- player input ----------
function playerPress(midi, { sound = false, source = 'touch' } = {}) {
  if (sound) tone(midi, 0.6);
  if (mode !== 'learn' || !learn) return lightKey(midi, COLORS.good, 250);
  const step = learn.steps[learn.i];
  const r = press(learn, midi);
  if (r === 'wrong') {
    if (source === 'mic') return; // mic only listens for expected notes
    stats.wrong++;
    const bar = step?.bar ?? 0;
    stats.wrongByBar[bar] = (stats.wrongByBar[bar] || 0) + 1;
    lightKey(midi, COLORS.wrong, 400);
  } else if (r !== 'ignored') {
    stats.hits++;
    lightKey(midi, COLORS.good, 300);
  }
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
    mic = { stream, an, buf:new Float32Array(an.frequencyBinCount), thr: null, above: new Set(), prev: new Map() };
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
function micFrame() {
  if (!mic || mic.thr == null || mode !== 'learn' || !learn) return;
  const step = learn.steps[learn.i];
  if (!step || step.time - t > 0.4) return; // only listen close to the note
  mic.an.getFloatFrequencyData(mic.buf);
  for (const m of step.notes) {
    const lv = micLevel(m), prev = mic.prev.get(m) ?? -Infinity;
    mic.prev.set(m, lv);
    // new onset: crossed the threshold, or a sharp jump (same note struck again)
    if (lv > mic.thr && (!mic.above.has(m) || lv - prev > 6)) {
      mic.above.add(m);
      if (!learn.hit.has(m)) playerPress(m, { source: 'mic' });
    } else if (lv < mic.thr - 6) mic.above.delete(m);
  }
}

$('input').onchange = () => {
  const v = $('input').value;
  if (mic) { mic.stream.getTracks().forEach(tr => tr.stop()); mic = null; hideMsg(); } // stop listening (and the mic indicator)
  if (v === 'midi') enableMidi();
  else if (v === 'mic') enableMic();
  else status('Tap the keys on screen.');
};

// ---------- messages ----------
function showMsg(html) { $('msgBody').innerHTML = html; $('msg').classList.add('show'); }
function hideMsg() { $('msg').classList.remove('show'); }

// ---------- drawing ----------
const noteName = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
let W = 0, H = 0;
function resize() {
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  W = r.width; H = r.height;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(canvas); // also fires when the ⚙ menu opens/closes
$('menu').onclick = () => $('menu').setAttribute('aria-expanded', $('more').classList.toggle('open'));

function layout() {
  const whites = [];
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  const ww = W / whites.length, kh = Math.min(H * 0.28, 160), top = H - kh;
  const keyRect = m => {
    if (!isBlack(m)) { const i = whites.indexOf(m); return { x: i * ww, w: ww, y: top, h: kh }; }
    const i = whites.indexOf(m - 1);
    return { x: (i + 1) * ww - ww * 0.3, w: ww * 0.6, y: top, h: kh * 0.62 };
  };
  return { whites, ww, kh, top, keyRect };
}
function keyAt(x, y) {
  const L = layout();
  if (y < L.top) return null;
  for (let m = lo; m <= hi; m++) { // black keys sit on top, check them first
    if (!isBlack(m)) continue;
    const r = L.keyRect(m);
    if (x >= r.x && x < r.x + r.w && y < r.y + r.h) return m;
  }
  const i = Math.floor(x / L.ww);
  return L.whites[Math.max(0, Math.min(i, L.whites.length - 1))];
}

const WINDOW = 3; // seconds of music visible above the keys
function draw() {
  ctx.fillStyle = '#14161c';
  ctx.fillRect(0, 0, W, H);
  const L = layout(), pps = L.top / WINDOW;
  if (!song) {
    ctx.fillStyle = '#9aa0ad';
    ctx.textAlign = 'center';
    ctx.font = '16px system-ui';
    ctx.fillText('Tap 📂 to open a song (Demo is in ⚙)', W / 2, L.top / 2);
  } else {
    // octave guide lines
    ctx.strokeStyle = '#232733';
    for (const m of L.whites) if (m % 12 === 0) { const x = L.keyRect(m).x; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, L.top); ctx.stroke(); }
    // loop region
    if (loopB != null) {
      const yA = L.top - ((loopA ?? 0) - t) * pps, yB = L.top - (loopB - t) * pps;
      ctx.fillStyle = '#ffffff0a';
      ctx.fillRect(0, yB, W, yA - yB);
    }
    const player = hands();
    for (const n of song.notes) {
      if (n.time > t + WINDOW) break;
      if (n.time + n.duration < t) continue;
      const r = L.keyRect(n.midi), yb = L.top - (n.time - t) * pps, h = Math.max(4, n.duration * pps);
      ctx.globalAlpha = playsHand(n, player) ? 1 : 0.55; // other hand: dimmer but still clearly visible
      ctx.fillStyle = COLORS[n.hand];
      roundRect(r.x + 1, yb - h, r.w - 2, h, 4);
      if (r.w > 16 && h > 14) {
        ctx.fillStyle = '#fff';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(NAMES[n.midi % 12], r.x + r.w / 2, yb - 4);
      }
    }
    ctx.globalAlpha = 1;
  }
  drawKeys(L);
  if (song && !seeking) $('pos').value = Math.round((t / song.duration) * 1000);
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }

function keyColor(m, now) {
  const f = flash.get(m);
  if (f && f.until > now) return f.color;
  if (down.has(m)) return COLORS.good;
  const step = learn?.steps[learn.i];
  if (step && step.notes.includes(m) && !learn.hit.has(m) && step.time - t < 0.6) return '#ffb347'; // play this now
  return null;
}
function drawKeys(L) {
  const now = performance.now();
  for (const m of L.whites) {
    const r = L.keyRect(m);
    ctx.fillStyle = keyColor(m, now) || '#f4f4f6';
    ctx.fillRect(r.x + 0.5, r.y, r.w - 1, r.h);
    if (L.ww > 14) {
      ctx.fillStyle = '#555';
      ctx.font = (m % 12 === 0 ? 'bold ' : '') + '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(m % 12 === 0 ? noteName(m) : NAMES[m % 12], r.x + r.w / 2, r.y + r.h - 6);
    }
  }
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    const r = L.keyRect(m);
    ctx.fillStyle = keyColor(m, now) || '#1b1d24';
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
}

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  micFrame();
  if (playing && song) advance(dt * speed());
  draw();
  requestAnimationFrame(frame);
}
resize();
loadLast();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator) {
  const hadWorker = !!navigator.serviceWorker.controller; // first install is not an update: no reload
  navigator.serviceWorker.addEventListener('controllerchange', () => hadWorker && location.reload());
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
