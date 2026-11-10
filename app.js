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
let ac = null;
const audio = () => (ac ||= new AudioContext());
function tone(midi, dur, vel = 0.7) {
  const a = audio(), o = a.createOscillator(), g = a.createGain(), now = a.currentTime;
  const len = Math.min(dur, 3) + 0.3;
  o.type = 'triangle';
  o.frequency.value = freq(midi);
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.25 * vel, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, now + len);
  o.connect(g).connect(a.destination);
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
  const tracks = m.tracks.map(tr => tr.notes.map(n => ({
    midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity, bar: bar(n.ticks),
  })));
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
    status('Could not read that file as MIDI: ' + err.message);
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
  if (m === 'learn') {
    learn = newLearn(song.notes, hands());
    seekStep(learn, t);
    stats = { hits: 0, wrong: 0, wrongByBar: {} };
  }
  autoIdx = song.notes.findIndex(n => n.time >= t);
  if (autoIdx < 0) autoIdx = song.notes.length;
  playing = true;
  $('listen').classList.toggle('on', m === 'listen');
  $('learn').classList.toggle('on', m === 'learn');
}
function stop() {
  playing = false;
  mode = 'idle';
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
$('listen').onclick = () => (mode === 'listen' ? stop() : start('listen'));
$('learn').onclick = () => (mode === 'learn' ? stop() : start('learn'));
$('stop').onclick = stop;
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
    if (mode === 'listen' || !playsHand(n, hands())) {
      tone(n.midi, n.duration / speed(), n.velocity ?? 0.7);
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
  pointers.set(e.pointerId, m);
  down.add(m);
  playerPress(m, { sound: true });
});
const release = e => { down.delete(pointers.get(e.pointerId)); pointers.delete(e.pointerId); };
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

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
    mic = { an, buf: new Float32Array(an.frequencyBinCount), thr: null, above: new Set(), prev: new Map() };
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
  while (performance.now() < end) { mic.an.getFloatFrequencyData(mic.buf); fn(); await sleep(30); }
}
async function calibrate() {
  mic.thr = null;
  showMsg('<h2>Microphone setup 1/2</h2><p>Stay quiet for 2 seconds…</p>');
  let noise = -Infinity;
  await sample(2000, () => { for (let m = 36; m <= 96; m++) noise = Math.max(noise, micLevel(m)); });
  showMsg('<h2>Microphone setup 2/2</h2><p>Play and hold <b>middle C (C4)</b> at normal loudness…</p>');
  let peak = -Infinity;
  await sample(2500, () => (peak = Math.max(peak, micLevel(60))));
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
addEventListener('resize', resize);

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
    ctx.fillText('Open a MIDI file or tap Demo', W / 2, L.top / 2);
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
    const player = mode === 'learn' ? hands() : 'both';
    for (const n of song.notes) {
      if (n.time > t + WINDOW) break;
      if (n.time + n.duration < t) continue;
      const r = L.keyRect(n.midi), yb = L.top - (n.time - t) * pps, h = Math.max(4, n.duration * pps);
      ctx.globalAlpha = playsHand(n, player) ? 1 : 0.3;
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
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
