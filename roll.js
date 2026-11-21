// Piano roll drawing: glowing falling notes, light beams, sparks, drifting particles, keys.
// Glow is cheap on phones: emissive shapes are also drawn into a 1/4-size canvas, which is
// blurred further into a 1/12-size one; both are scaled back up and added on top (upscaling blurs).
const WINDOW = 3; // seconds of music visible above the keys
let W = 0, H = 0;
let fxOn = (() => { try { return localStorage.getItem('pc-fx') !== 'off'; } catch { return true; } })();
const GS = 4, BS = 12;
const glow = document.createElement('canvas'), gx = glow.getContext('2d');
const bloom = document.createElement('canvas'), bx = bloom.getContext('2d');
const bg = document.createElement('canvas'), bgx = bg.getContext('2d');

const rgbaCache = new Map();
function rgba(hex, a) {
  let c = rgbaCache.get(hex);
  if (!c) { const v = parseInt(hex.slice(1), 16); c = [v >> 16, (v >> 8) & 255, v & 255]; rgbaCache.set(hex, c); }
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

function resize() {
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  W = r.width; H = r.height;
  if (!W || !H) return;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  glow.width = Math.ceil(W / GS); glow.height = Math.ceil(H / GS);
  bloom.width = Math.ceil(W / BS); bloom.height = Math.ceil(H / BS);
  bg.width = canvas.width; bg.height = canvas.height;
  bgx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const top = layout().top;
  const g = bgx.createLinearGradient(0, 0, 0, top);
  g.addColorStop(0, '#02030a'); g.addColorStop(0.65, '#050a18'); g.addColorStop(1, '#0a1630');
  bgx.fillStyle = g; bgx.fillRect(0, 0, W, H);
  const haze = bgx.createRadialGradient(W / 2, top, 0, W / 2, top, Math.max(W, top) * 0.8);
  haze.addColorStop(0, 'rgba(40,130,180,0.20)'); haze.addColorStop(1, 'rgba(40,130,180,0)');
  bgx.fillStyle = haze; bgx.fillRect(0, 0, W, top);
}

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

// ---------- particles ----------
const newMote = anyY => ({ x: Math.random(), y: anyY ? Math.random() : 1.03, r: 0.8 + Math.random() * 2.2, v: 0.006 + Math.random() * 0.02, ph: Math.random() * 6.3 });
const newStreak = anyY => ({ x: Math.random(), y: anyY ? Math.random() * 1.2 : -0.05, len: 0.08 + Math.random() * 0.2, v: 0.04 + Math.random() * 0.12, a: 0.12 + Math.random() * 0.3 });
const motes = Array.from({ length: 44 }, () => newMote(true));
const streaks = Array.from({ length: 12 }, () => newStreak(true));
const sparks = [], pops = [];

function burst(midi, color, n = 10) {
  if (!fxOn || !W || midi < lo || midi > hi) return;
  const L = layout(), r = L.keyRect(midi), x = r.x + r.w / 2;
  for (let i = 0; i < n; i++) sparks.push({
    x: x + (Math.random() - 0.5) * r.w * 0.7, y: L.top, vx: (Math.random() - 0.5) * 160, vy: -60 - Math.random() * 240,
    life: 0, max: 0.35 + Math.random() * 0.5, color: Math.random() < 0.35 ? '#ffe9b0' : color, s: 1 + Math.random() * 1.8,
  });
  if (sparks.length > 500) sparks.splice(0, sparks.length - 500);
}
function burstAll() { for (let m = lo; m <= hi; m += 2) burst(m, m % 4 ? COLORS.R : COLORS.L, 4); }
function pop(text, midi, color) {
  pops.push({ text, midi, color, life: 0 });
  if (pops.length > 14) pops.shift();
}

function drawAmbient(dt, top) {
  for (const s of streaks) { // thin light trails falling through the dark
    s.y += s.v * dt;
    if (s.y - s.len > 1) Object.assign(s, newStreak(false));
    const y1 = Math.min(s.y, 1) * top, y0 = (s.y - s.len) * top;
    if (y1 <= y0) continue;
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, 'rgba(45,212,191,0)'); g.addColorStop(1, `rgba(45,212,191,${s.a})`);
    ctx.fillStyle = g;
    ctx.fillRect(s.x * W, y0, 1.5, y1 - y0);
  }
  ctx.fillStyle = '#5eead4'; gx.fillStyle = '#2dd4bf';
  for (const m of motes) { // slowly rising, twinkling dots
    m.y -= m.v * dt; m.ph += dt * 1.4;
    if (m.y < -0.03) Object.assign(m, newMote(false));
    const a = 0.2 + 0.22 * Math.sin(m.ph), x = m.x * W, y = m.y * top;
    ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(x, y, m.r, 0, 6.283); ctx.fill();
    gx.globalAlpha = a; gx.fillRect(x - m.r * 2, y - m.r * 2, m.r * 4, m.r * 4);
  }
  ctx.globalAlpha = 1; gx.globalAlpha = 1;
}

// ---------- the frame ----------
function draw(dt = 0, now = performance.now()) {
  if (!W) return;
  const L = layout(), pps = L.top / WINDOW, top = L.top;
  if (fxOn) {
    ctx.drawImage(bg, 0, 0, W, H);
    gx.setTransform(1, 0, 0, 1, 0, 0);
    gx.clearRect(0, 0, glow.width, glow.height);
    gx.setTransform(1 / GS, 0, 0, 1 / GS, 0, 0);
    drawAmbient(dt, top);
  } else { ctx.fillStyle = '#05070d'; ctx.fillRect(0, 0, W, H); }

  // octave guide lines
  ctx.fillStyle = 'rgba(120,160,255,0.08)';
  for (const m of L.whites) if (m % 12 === 0) ctx.fillRect(L.keyRect(m).x, 0, 1, top);
  // A/B loop region
  if (loopB != null && !coach) {
    const yA = top - ((loopA ?? 0) - t) * pps, yB = top - (loopB - t) * pps;
    ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(0, yB, W, yA - yB);
    ctx.fillStyle = 'rgba(192,140,255,0.5)'; ctx.fillRect(0, yB, W, 1); ctx.fillRect(0, yA, W, 1);
  }

  // notes
  const who = hands(), beams = [];
  if (fxOn) { gx.save(); gx.beginPath(); gx.rect(0, 0, W, top); gx.clip(); }
  for (const n of song.notes) {
    if (n.time > t + WINDOW) break;
    if (n.time + n.duration < t) continue;
    const r = L.keyRect(n.midi), yb = top - (n.time - t) * pps, h = Math.max(8, n.duration * pps), y = yb - h;
    const mine = playsHand(n, who), col = COLORS[n.hand];
    const x = r.x + 1.5, w = r.w - 3, rad = Math.min(6, w / 2);
    if (fxOn) { gx.globalAlpha = mine ? 0.9 : 0.3; gx.fillStyle = col; gx.fillRect(x - 3, y - 3, w + 6, h + 6); }
    ctx.globalAlpha = mine ? 1 : 0.4; // other hand: dimmer but still clearly visible
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, rad); ctx.fill();
    const label = w >= 12 && h >= 16, cs = Math.min(w - 4, 20);
    const coreH = h - 6 - (label ? cs + 3 : 0);
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; // hot core (stops above the label)
    if (coreH > 2) { ctx.beginPath(); ctx.roundRect(x + w * 0.32, y + 3, w * 0.36, coreH, w * 0.18); ctx.fill(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, rad); ctx.stroke();
    if (label) { // note name in a little chip at the bottom
      const cx = x + (w - cs) / 2, cy = yb - cs - 3;
      ctx.fillStyle = 'rgba(4,10,28,0.6)';
      ctx.beginPath(); ctx.roundRect(cx, cy, cs, cs, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(cs * (NAMES[n.midi % 12].length > 1 ? 0.52 : 0.64))}px system-ui`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(NAMES[n.midi % 12], cx + cs / 2, cy + cs / 2 + 0.5);
    }
    if (n.time <= t + 1e-3 && t < n.time + n.duration) beams.push({ r, col, a: mine ? 1 : 0.45 });
  }
  if (fxOn) gx.restore();
  ctx.globalAlpha = 1; ctx.textBaseline = 'alphabetic';

  // coach: dim everything outside the section being practised
  if (coach) {
    const yF = top - (coach.range.from - t) * pps, yT = top - (coach.range.to - t) * pps;
    ctx.fillStyle = 'rgba(2,3,10,0.6)';
    if (yT > 0) ctx.fillRect(0, 0, W, Math.min(yT, top));
    if (yF < top) ctx.fillRect(0, Math.max(0, yF), W, top - Math.max(0, yF));
  }

  // light beams rising from the keys being played
  ctx.globalCompositeOperation = 'lighter';
  for (const b of beams) {
    const bh = top * 0.5, cx = b.r.x + b.r.w / 2, bw = b.r.w * 0.9;
    const g = ctx.createLinearGradient(0, top - bh, 0, top);
    g.addColorStop(0, rgba(b.col, 0)); g.addColorStop(1, rgba(b.col, 0.4 * b.a));
    ctx.fillStyle = g; ctx.fillRect(cx - bw / 2, top - bh, bw, bh);
    if (fxOn) { gx.globalAlpha = b.a; gx.fillStyle = b.col; gx.fillRect(cx - bw / 2, top - 40, bw, 40); }
  }
  ctx.globalCompositeOperation = 'source-over'; gx.globalAlpha = 1;

  // soft light just above the keys
  const lg = ctx.createLinearGradient(0, top - 40, 0, top);
  lg.addColorStop(0, 'rgba(130,190,255,0)'); lg.addColorStop(1, 'rgba(150,200,255,0.16)');
  ctx.fillStyle = lg; ctx.fillRect(0, top - 40, W, 40);

  drawKeys(L, now);

  // the glowing line where notes meet the keys
  ctx.fillStyle = '#eaf6ff'; ctx.fillRect(0, top - 1, W, 2);
  if (fxOn) { gx.fillStyle = '#8fd0ff'; gx.globalAlpha = 0.8; gx.fillRect(0, top - 4, W, 8); gx.globalAlpha = 1; }

  // sparks
  if (sparks.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life += dt; p.vy += 520 * dt; p.vx *= 1 - 1.5 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.life >= p.max || p.y > top + 4) { sparks.splice(i, 1); continue; }
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = a; ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.s, p.s);
      if (fxOn) { gx.globalAlpha = a; gx.fillStyle = p.color; gx.fillRect(p.x - 3, p.y - 3, 6 + p.s, 6 + p.s); }
    }
    ctx.globalAlpha = 1; gx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  // add the glow on top
  if (fxOn) {
    bx.clearRect(0, 0, bloom.width, bloom.height);
    bx.filter = 'blur(1.5px)';
    bx.drawImage(glow, 0, 0, bloom.width, bloom.height);
    bx.filter = 'none';
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.9; ctx.drawImage(bloom, 0, 0, W, H);
    ctx.globalAlpha = 0.55; ctx.drawImage(glow, 0, 0, W, H);
    ctx.restore();
  }

  // grades rising from the keys (play along)
  ctx.textAlign = 'center'; ctx.font = '700 13px system-ui';
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    p.life += dt;
    if (p.life > 0.9 || p.midi < lo || p.midi > hi) { pops.splice(i, 1); continue; }
    const r = L.keyRect(p.midi);
    ctx.globalAlpha = 1 - p.life / 0.9; ctx.fillStyle = p.color;
    ctx.fillText(p.text, r.x + r.w / 2, top - 26 - p.life * 50);
  }
  ctx.globalAlpha = 1;

  // sustain pedal
  if (song.pedal.length && valueAt(song.pedal, t, 0) >= 0.5) {
    ctx.save();
    ctx.font = 'italic 700 24px Georgia, serif'; ctx.textAlign = 'left';
    ctx.fillStyle = '#8b7bff'; ctx.shadowColor = '#8b7bff'; ctx.shadowBlur = fxOn ? 14 : 0;
    ctx.fillText('Ped.', 12, top - 14);
    ctx.restore();
  }

  // count-in
  if (countIn?.n) {
    const a = Math.max(0, 1 - (now - countIn.at) / countIn.every);
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.65 * a; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(Math.min(120, top * 0.35))}px system-ui`;
    ctx.shadowColor = '#3ab4ff'; ctx.shadowBlur = 30;
    ctx.fillText(countIn.n, W / 2, top / 2);
    ctx.restore();
  }

  drawHeat($('timeline'), t);
  if (song.bars.length) {
    const sub = `Bar ${barAt(t)} of ${song.bars.length}`;
    if ($('pSub').textContent !== sub) $('pSub').textContent = sub;
  }
}

// A song's "cover": its whole piano roll squeezed into a small glowing picture (time across, pitch up).
function fingerprint(notes, duration, w = 720, h = 240) {
  const c = document.createElement('canvas'), x = c.getContext('2d');
  c.width = w; c.height = h;
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#050916'); g.addColorStop(1, '#0d1a36');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  let min = 127, max = 0;
  for (const n of notes) { min = Math.min(min, n.midi); max = Math.max(max, n.midi); }
  const span = Math.max(12, max - min + 1), pad = 24, rowH = (h - 2 * pad) / span;
  const paint = alpha => {
    x.globalAlpha = alpha;
    for (const n of notes) {
      x.fillStyle = COLORS[n.hand] || COLORS.R;
      x.fillRect(pad + (n.time / duration) * (w - 2 * pad), h - pad - (n.midi - min + 1) * rowH,
        Math.max(1.5, (n.duration / duration) * (w - 2 * pad)), Math.max(1.5, rowH * 0.8));
    }
  };
  x.globalCompositeOperation = 'lighter';
  x.filter = 'blur(6px)'; paint(0.55);
  x.filter = 'none'; paint(0.9);
  return c.toDataURL('image/webp', 0.8);
}

function keyColor(m, now) {
  const f = flash.get(m);
  if (f && f.until > now) return f.color;
  if (down.has(m)) return COLORS.good;
  const step = learn?.steps[learn.i];
  if (step && step.notes.includes(m) && !learn.hit.has(m) && step.time - t < 0.6) return COLORS.hint; // play this now
  return null;
}
function drawKeys(L, now) {
  const pulse = 0.45 + 0.3 * Math.sin(now / 140);
  const wg = ctx.createLinearGradient(0, L.top, 0, H);
  wg.addColorStop(0, '#c9d0de'); wg.addColorStop(0.06, '#f4f6fb'); wg.addColorStop(1, '#dde2ec');
  for (const m of L.whites) {
    const r = L.keyRect(m), c = keyColor(m, now);
    ctx.fillStyle = wg; ctx.fillRect(r.x + 0.5, r.y, r.w - 1, r.h);
    if (c) {
      ctx.fillStyle = rgba(c, c === COLORS.hint ? pulse : 0.85); ctx.fillRect(r.x + 0.5, r.y, r.w - 1, r.h);
      if (fxOn) { gx.fillStyle = c; gx.fillRect(r.x, L.top - 12, r.w, 28); }
    }
    if (L.ww > 14) {
      ctx.fillStyle = '#5b6273';
      ctx.font = (m % 12 === 0 ? 'bold ' : '') + '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(m % 12 === 0 ? noteName(m) : NAMES[m % 12], r.x + r.w / 2, r.y + r.h - 6);
    }
  }
  const bgk = ctx.createLinearGradient(0, L.top, 0, L.top + L.kh * 0.62);
  bgk.addColorStop(0, '#1a1e2a'); bgk.addColorStop(1, '#2b3142');
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) continue;
    const r = L.keyRect(m), c = keyColor(m, now);
    ctx.fillStyle = c ? rgba(c, c === COLORS.hint ? pulse + 0.2 : 1) : bgk;
    ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, [0, 0, 3, 3]); ctx.fill();
    if (c && fxOn) { gx.fillStyle = c; gx.fillRect(r.x, L.top - 12, r.w, 24); }
  }
  // shadow cast by the light line onto the keys
  const sh = ctx.createLinearGradient(0, L.top, 0, L.top + 10);
  sh.addColorStop(0, 'rgba(0,0,0,0.35)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh; ctx.fillRect(0, L.top, W, 10);
}

// Mistakes per bar as a strip: grey = not played yet, green = clean, red = trouble.
function drawHeat(cnv, head) {
  if (!song || !cnv.clientWidth) return;
  const dpr = devicePixelRatio || 1, w = cnv.clientWidth, h = cnv.clientHeight;
  if (cnv.width !== Math.round(w * dpr) || cnv.height !== Math.round(h * dpr)) { cnv.width = Math.round(w * dpr); cnv.height = Math.round(h * dpr); }
  const c = cnv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const heat = rec?.progress.heat || {};
  const bars = song.bars.length ? song.bars : [0];
  bars.forEach((b, i) => {
    const x0 = (b / song.duration) * w, x1 = ((bars[i + 1] ?? song.duration) / song.duration) * w;
    const v = heat[i + 1];
    c.fillStyle = v == null ? '#1a2135' : `hsl(${Math.round(140 * (1 - Math.min(1, v * 2.5)))} 75% 48%)`;
    c.fillRect(x0, 0, Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0)), h);
  });
  if (head != null) {
    const hx = (head / song.duration) * w;
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(0, 0, hx, h); // played part
    c.fillStyle = '#fff'; c.fillRect(hx - 1.5, 0, 3, h);
  }
}
