'use strict';

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const STORE_KEY = 'roulette-pwa-v1';

const SPEEDS = {
  slow:   { duration: 6500, turns: 6 },
  normal: { duration: 4200, turns: 5 },
  fast:   { duration: 2300, turns: 3 },
};

// ---------- State ----------
const state = {
  total: 50,
  count: 3,
  excludes: [],     // 手動排除
  drawn: [],        // 跨回合已抽中（noRepeat 時排除）
  noRepeat: true,
  speed: 'normal',
  sound: true,
  history: [],      // { time, nums: [] }
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) Object.assign(state, saved);
  } catch (_) { /* 無痕模式等情況忽略 */ }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
}

// ---------- Pool ----------
function basePool() {
  const ex = new Set(state.excludes);
  if (state.noRepeat) state.drawn.forEach((n) => ex.add(n));
  const pool = [];
  for (let i = 1; i <= state.total; i++) if (!ex.has(i)) pool.push(i);
  return pool;
}

// 公平亂數（拒絕取樣，避免模數偏差）
function randInt(n) {
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= max);
  return buf[0] % n;
}

// ---------- Wheel drawing ----------
const canvas = $('wheel');
const ctx = canvas.getContext('2d');
let wheelNums = [];
let rotation = 0;
let highlight = -1;
let size = 0;

const tape = $('tape');
const tctx = tape.getContext('2d');
let tapeW = 0, tapeH = 0;

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  size = canvas.clientWidth;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tapeW = tape.clientWidth;
  tapeH = tape.clientHeight;
  tape.width = Math.round(tapeW * dpr);
  tape.height = Math.round(tapeH * dpr);
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWheel();
}

// 放大條：把指針附近的扇形攤平成一列，和輪盤同步轉動
function drawTape() {
  if (!tapeW) return;
  tctx.clearRect(0, 0, tapeW, tapeH);
  const n = wheelNums.length;
  if (n === 0) return;

  const s = TAU / n;
  const p = ((((-rotation) % TAU) + TAU) % TAU) / s; // 指針所在的連續扇形位置
  const W = 64;
  const cx = tapeW / 2;
  const half = Math.ceil(tapeW / W / 2) + 1;
  const base = Math.floor(p);

  tctx.textAlign = 'center';
  tctx.textBaseline = 'middle';
  tctx.font = `800 ${tapeH * 0.42}px system-ui, sans-serif`;
  for (let j = base - half; j <= base + half; j++) {
    const i = ((j % n) + n) % n;
    const x = cx - W / 2 + (j - p + 0.5) * W;
    tctx.fillStyle = i === highlight ? '#ffffff' : segColor(i, n);
    tctx.beginPath();
    tctx.roundRect(x + 2, 6, W - 4, tapeH - 12, 8);
    tctx.fill();
    if (i !== highlight) {
      // 深色描邊，讓白字在黃綠色格子上也看得清楚
      tctx.lineWidth = 4;
      tctx.lineJoin = 'round';
      tctx.strokeStyle = 'rgba(0,0,0,.45)';
      tctx.strokeText(String(wheelNums[i]), x + W / 2, tapeH / 2 + 1);
    }
    tctx.fillStyle = i === highlight ? '#d6336c' : '#fff';
    tctx.fillText(String(wheelNums[i]), x + W / 2, tapeH / 2 + 1);
  }

  // 兩側淡出
  const fade = Math.min(80, tapeW * 0.2);
  const gl = tctx.createLinearGradient(0, 0, fade, 0);
  gl.addColorStop(0, 'rgba(20,17,43,.95)'); gl.addColorStop(1, 'rgba(20,17,43,0)');
  tctx.fillStyle = gl; tctx.fillRect(0, 0, fade, tapeH);
  const gr = tctx.createLinearGradient(tapeW - fade, 0, tapeW, 0);
  gr.addColorStop(0, 'rgba(20,17,43,0)'); gr.addColorStop(1, 'rgba(20,17,43,.95)');
  tctx.fillStyle = gr; tctx.fillRect(tapeW - fade, 0, fade, tapeH);
}

function segColor(i, n) {
  const hue = (i * 360) / n;
  const light = n > 1 && i % 2 ? 58 : 48;
  return `hsl(${hue}, 78%, ${light}%)`;
}

function drawWheel() {
  if (!size) return;
  const c = size / 2;
  const R = c - 2;
  ctx.clearRect(0, 0, size, size);
  drawTape();

  const n = wheelNums.length;
  if (n === 0) {
    ctx.fillStyle = '#2d2560';
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.fill();
    ctx.fillStyle = '#a9a3d1';
    ctx.font = `600 ${size * 0.045}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('沒有可抽的號碼', c, c + size * 0.2);
    return;
  }

  const s = TAU / n;
  const labelR = R * 0.82;
  // 依扇形寬度決定字級；太窄就不畫數字
  const arcLen = s * labelR;
  const fontSize = Math.min(size * 0.06, arcLen * 0.75);
  const showLabels = fontSize >= 7;
  const showLines = n <= 360;

  for (let i = 0; i < n; i++) {
    const a0 = rotation + i * s - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, R, a0, a0 + s + (showLines ? 0 : 0.002));
    ctx.closePath();
    ctx.fillStyle = i === highlight ? '#ffffff' : segColor(i, n);
    ctx.fill();
    if (showLines) {
      ctx.strokeStyle = 'rgba(20, 17, 43, .55)';
      ctx.lineWidth = n > 120 ? 0.5 : 1.5;
      ctx.stroke();
    }

    if (showLabels) {
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(a0 + s / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${fontSize}px system-ui, sans-serif`;
      ctx.fillStyle = i === highlight ? '#d6336c' : '#fff';
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = i === highlight ? 0 : 3;
      ctx.fillText(String(wheelNums[i]), R - size * 0.03, 0);
      ctx.restore();
    }
  }

  // 內圈裝飾
  ctx.beginPath();
  ctx.arc(c, c, R * 0.2, 0, TAU);
  ctx.fillStyle = 'rgba(20, 17, 43, .35)';
  ctx.fill();
}

function indexAtPointer() {
  const n = wheelNums.length;
  const s = TAU / n;
  const a = (((-rotation) % TAU) + TAU) % TAU;
  return Math.floor(a / s) % n;
}

// ---------- Sound ----------
let audioCtx = null;
let lastTick = 0;
function tick(freq = 1400, dur = 0.03, vol = 0.15) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + dur);
  } catch (_) {}
}
function fanfare() {
  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tick(f, 0.18, 0.12), i * 110));
}

// ---------- Spin ----------
const easeOut = (t) => 1 - Math.pow(1 - t, 4);

function spinTo(index, duration, turns) {
  return new Promise((resolve) => {
    const n = wheelNums.length;
    const s = TAU / n;
    // 停在扇形內隨機位置（避開邊界），讓每次停點都不同
    const jitter = (randInt(1000) / 1000 - 0.5) * 0.7;
    const desired = (((-(index + 0.5 + jitter) * s) % TAU) + TAU) % TAU;
    const start = rotation;
    const cur = ((start % TAU) + TAU) % TAU;
    const delta = ((desired - cur) % TAU + TAU) % TAU;
    const target = start + delta + turns * TAU;
    const t0 = performance.now();
    let lastIdx = indexAtPointer();

    function frame(now) {
      const t = Math.min(1, (now - t0) / duration);
      rotation = start + (target - start) * easeOut(t);
      drawWheel();
      const idx = indexAtPointer();
      if (idx !== lastIdx) {
        lastIdx = idx;
        if (now - lastTick > 35) { tick(); lastTick = now; }
      }
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let spinning = false;

async function startDraw() {
  if (spinning) return;
  readInputs();
  const pool = basePool();
  const k = state.count;
  if (pool.length < k || k < 1) { renderPoolInfo(); return; }

  spinning = true;
  setBusy(true);
  $('current').innerHTML = '';
  wheelNums = pool.slice();
  drawWheel();

  const cfg = SPEEDS[state.speed] || SPEEDS.normal;
  const results = [];

  for (let r = 0; r < k; r++) {
    $('status').textContent = k > 1 ? `抽第 ${r + 1} / ${k} 個…` : '抽獎中…';
    const idx = randInt(wheelNums.length);
    const first = r === 0;
    await spinTo(idx, first ? cfg.duration : cfg.duration * 0.7, first ? cfg.turns : Math.max(2, cfg.turns - 2));

    const num = wheelNums[idx];
    results.push(num);
    highlight = idx;
    drawWheel();
    tick(880, 0.2, 0.12);
    addBall($('current'), num);
    await sleep(r < k - 1 ? 750 : 400);

    highlight = -1;
    wheelNums.splice(idx, 1);
    drawWheel();
  }

  if (state.noRepeat) state.drawn.push(...results);
  state.history.unshift({ time: Date.now(), nums: results });
  save();

  $('status').textContent = `完成！抽出 ${k} 個號碼`;
  spinning = false;
  setBusy(false);
  refresh();
  showResult(results);
}

function setBusy(busy) {
  $('spinBtn').disabled = busy;
  document.querySelectorAll('.panel input, .panel select, .panel button').forEach((el) => { el.disabled = busy; });
}

// ---------- UI ----------
function addBall(container, num) {
  const b = document.createElement('span');
  b.className = 'ball';
  b.textContent = num;
  container.appendChild(b);
}

function showResult(nums) {
  const box = $('resultBalls');
  box.innerHTML = '';
  nums.forEach((n, i) => setTimeout(() => addBall(box, n), i * 90));
  $('resultModal').classList.remove('hidden');
  fanfare();
  confetti();
  $('closeModal').focus();
}

function parseExcludes(text) {
  const out = [];
  // 全形數字轉半形（中文鍵盤常見）
  text = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const tokens = text.split(/[,，、;；\s]+/).filter(Boolean);
  for (const tok of tokens) {
    const m = tok.match(/^(\d+)\s*[-~～－]\s*(\d+)$/);
    if (m) {
      let a = +m[1], b = +m[2];
      if (a > b) [a, b] = [b, a];
      if (b - a > 10000) continue;
      for (let i = a; i <= b; i++) if (i >= 1) out.push(i);
    } else if (/^\d+$/.test(tok) && +tok >= 1) {
      out.push(+tok);
    }
  }
  return out;
}

function addExcludes() {
  const input = $('excludeInput');
  const nums = parseExcludes(input.value);
  if (!nums.length) { input.focus(); return; }
  state.excludes = [...new Set([...state.excludes, ...nums])].sort((a, b) => a - b);
  input.value = '';
  save();
  refresh();
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  for (const n of state.excludes) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = n;
    if (n > state.total) chip.title = '超出總數，不影響抽獎';
    if (n > state.total) chip.style.opacity = '.45';
    const x = document.createElement('button');
    x.textContent = '×';
    x.setAttribute('aria-label', `移除排除號碼 ${n}`);
    x.onclick = () => {
      state.excludes = state.excludes.filter((v) => v !== n);
      save(); refresh();
    };
    chip.appendChild(x);
    box.appendChild(chip);
  }
  $('clearExclude').classList.toggle('hidden', state.excludes.length === 0);
}

function renderPoolInfo() {
  const pool = basePool();
  const info = $('poolInfo');
  const exCount = state.excludes.filter((n) => n <= state.total).length;
  const drawnCount = state.noRepeat ? state.drawn.filter((n) => n <= state.total && !state.excludes.includes(n)).length : 0;
  let html = `可抽號碼 <b>${pool.length}</b> 個（共 ${state.total}，排除 ${exCount}`;
  if (state.noRepeat) html += `，已抽出 ${drawnCount}`;
  html += '）';
  const bad = state.count < 1 || pool.length < state.count;
  if (bad) {
    html += state.count < 1
      ? '<br>⚠ 一次抽出數量至少為 1'
      : `<br>⚠ 可抽號碼不足 ${state.count} 個，請調整設定或重置紀錄`;
  }
  info.innerHTML = html;
  info.classList.toggle('error', bad);

  $('poolListTitle').textContent = `查看輪盤上的全部 ${pool.length} 個號碼`;
  const list = $('poolList');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  pool.forEach((n) => { const s = document.createElement('span'); s.textContent = n; frag.appendChild(s); });
  list.appendChild(frag);
  $('spinBtn').disabled = bad || spinning;
}

function renderHistory() {
  const list = $('history');
  list.innerHTML = '';
  state.history.forEach((h, i) => {
    const li = document.createElement('li');
    const d = new Date(h.time);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `第 ${state.history.length - i} 回 · ${d.toLocaleString('zh-TW', { hour12: false })}`;
    const nums = document.createElement('div');
    nums.className = 'nums';
    h.nums.forEach((n) => { const s = document.createElement('span'); s.textContent = n; nums.appendChild(s); });
    li.append(meta, nums);
    list.appendChild(li);
  });
  $('historyEmpty').classList.toggle('hidden', state.history.length > 0);
}

function readInputs() {
  const total = parseInt($('total').value, 10);
  const count = parseInt($('count').value, 10);
  state.total = Number.isFinite(total) ? Math.min(Math.max(total, 1), 9999) : 1;
  state.count = Number.isFinite(count) ? Math.min(Math.max(count, 0), 999) : 0;
  state.noRepeat = $('noRepeat').checked;
  state.speed = $('speed').value;
}

function refresh() {
  if (!spinning) {
    wheelNums = basePool();
    drawWheel();
  }
  renderChips();
  renderPoolInfo();
  renderHistory();
}

function syncInputs() {
  $('total').value = state.total;
  $('count').value = state.count;
  $('noRepeat').checked = state.noRepeat;
  $('speed').value = state.speed;
  $('soundBtn').textContent = state.sound ? '🔊' : '🔇';
}

// ---------- Confetti ----------
function confetti() {
  const cv = $('confetti');
  const cx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ['#ffcc33', '#ff5c8a', '#5ce1e6', '#7cff6b', '#b18cff', '#ffffff'];
  const parts = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight * 0.45,
    vx: (Math.random() - 0.5) * 16,
    vy: -Math.random() * 16 - 4,
    r: Math.random() * TAU,
    vr: (Math.random() - 0.5) * 0.4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(now) {
    const t = now - t0;
    cx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      cx.save();
      cx.globalAlpha = Math.max(0, 1 - t / 2800);
      cx.translate(p.x, p.y); cx.rotate(p.r);
      cx.fillStyle = p.c;
      cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      cx.restore();
    }
    if (t < 2800) requestAnimationFrame(frame);
    else cx.clearRect(0, 0, innerWidth, innerHeight);
  })(t0);
}

// ---------- Events ----------
function bind() {
  $('spinBtn').onclick = startDraw;
  $('addExclude').onclick = addExcludes;
  $('excludeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addExcludes(); } });
  $('clearExclude').onclick = () => { state.excludes = []; save(); refresh(); };

  ['total', 'count'].forEach((id) => $(id).addEventListener('input', () => { readInputs(); save(); refresh(); }));
  ['noRepeat', 'speed'].forEach((id) => $(id).addEventListener('change', () => { readInputs(); save(); refresh(); }));

  $('resetBtn').onclick = () => {
    if (!state.history.length && !state.drawn.length) return;
    if (!confirm('確定要清除所有抽獎紀錄？（已抽出的號碼會回到輪盤）')) return;
    state.history = []; state.drawn = [];
    $('current').innerHTML = '';
    $('status').textContent = '紀錄已重置';
    save(); refresh();
  };

  $('soundBtn').onclick = () => { state.sound = !state.sound; syncInputs(); save(); };

  const closeModal = () => $('resultModal').classList.add('hidden');
  $('closeModal').onclick = closeModal;
  $('resultModal').addEventListener('click', (e) => { if (e.target.id === 'resultModal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  new ResizeObserver(resizeCanvas).observe(canvas);

  // PWA 安裝按鈕
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferred = e;
    $('installBtn').classList.remove('hidden');
  });
  $('installBtn').onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('installBtn').classList.add('hidden');
  };
}

load();
syncInputs();
bind();
refresh();
resizeCanvas();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
