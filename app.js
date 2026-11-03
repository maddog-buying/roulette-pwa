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
  mode: 'number',   // 'number' 號碼抽獎 | 'prize' 獎品排序
  prizes: [],       // 獎品名稱（可重複）
  history: [],      // { time, nums: [], mode }
};

const isPrize = () => state.mode === 'prize';

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

// 目前模式下輪盤上的項目
const currentPool = () => (isPrize() ? state.prizes.slice() : basePool());

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
let wheelItems = [];
let rotation = 0;
let highlight = -1;
let size = 0;
let animating = false;

// 放大條格子尺寸；中獎框寬度由 --cell 帶給 style.css 的 .tape-marker（格寬 + 2）
// 獎品名稱較長，所以獎品模式的格子比較寬
const tapeCell = () => (isPrize() ? 132 : 64);
const TAPE_GAP = 2;
const TAPE_PAD = 6;
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
  const n = wheelItems.length;
  if (n === 0) return;

  const s = TAU / n;
  let p = ((((-rotation) % TAU) + TAU) % TAU) / s; // 指針所在的連續扇形位置
  // 靜止時（含移除號碼後輪盤重新分格）讓格子置中對齊中獎框
  if (!animating) p = Math.floor(p) + 0.5;
  const W = tapeCell();
  const cx = tapeW / 2;
  const half = Math.ceil(tapeW / W / 2) + 1;
  const base = Math.floor(p);

  tctx.textAlign = 'center';
  tctx.textBaseline = 'middle';
  tctx.font = `800 ${isPrize() ? tapeH * 0.3 : tapeH * 0.42}px system-ui, sans-serif`;
  for (let j = base - half; j <= base + half; j++) {
    const i = ((j % n) + n) % n;
    const x = cx - W / 2 + (j - p + 0.5) * W;
    const label = fitText(tctx, String(wheelItems[i]), W - 14);
    tctx.fillStyle = i === highlight ? '#ffffff' : segColor(i, n);
    tctx.beginPath();
    tctx.roundRect(x + TAPE_GAP, TAPE_PAD, W - TAPE_GAP * 2, tapeH - TAPE_PAD * 2, 8);
    tctx.fill();
    if (i !== highlight) {
      // 深色描邊，讓白字在黃綠色格子上也看得清楚
      tctx.lineWidth = 4;
      tctx.lineJoin = 'round';
      tctx.strokeStyle = 'rgba(0,0,0,.45)';
      tctx.strokeText(label, x + W / 2, tapeH / 2 + 1);
    }
    tctx.fillStyle = i === highlight ? '#d6336c' : '#fff';
    tctx.fillText(label, x + W / 2, tapeH / 2 + 1);
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

// 文字超過寬度時截斷加「…」
function fitText(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
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

  const n = wheelItems.length;
  if (n === 0) {
    ctx.fillStyle = '#2d2560';
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.fill();
    ctx.fillStyle = '#a9a3d1';
    ctx.font = `600 ${size * 0.045}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(isPrize() ? '請先新增獎品' : '沒有可抽的號碼', c, c + size * 0.2);
    return;
  }

  const s = TAU / n;
  const labelR = R * 0.82;
  // 依扇形寬度決定字級；太窄就不畫數字
  const arcLen = s * labelR;
  const fontSize = isPrize() ? Math.min(size * 0.045, arcLen * 0.6) : Math.min(size * 0.06, arcLen * 0.75);
  const labelMaxW = R * 0.66; // 文字沿半徑方向，從邊緣往中心最多佔這麼長
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
      const label = fitText(ctx, String(wheelItems[i]), labelMaxW);
      if (i !== highlight) {
        ctx.lineWidth = Math.max(2, fontSize * 0.18);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,.4)';
        ctx.strokeText(label, R - size * 0.03, 0);
      }
      ctx.fillText(label, R - size * 0.03, 0);
      ctx.restore();
    }
  }

  // 邊緣卡榫：每根經過指針時發出「喀」聲
  const pegs = pegCount(n);
  const pegR = Math.max(2, size * 0.009);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(20, 17, 43, .6)';
  ctx.lineWidth = 1;
  for (let j = 0; j < pegs; j++) {
    const a = rotation + (j * TAU) / pegs - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * (R - pegR - 3), c + Math.sin(a) * (R - pegR - 3), pegR, 0, TAU);
    ctx.fill();
    ctx.stroke();
  }

  // 內圈裝飾
  ctx.beginPath();
  ctx.arc(c, c, R * 0.2, 0, TAU);
  ctx.fillStyle = 'rgba(20, 17, 43, .35)';
  ctx.fill();
}

// 號碼增減後扇形會重新分格，把指針對回某一格的正中央，避免停在分隔線上
function snapRotation() {
  const n = wheelItems.length;
  if (!n) return;
  rotation = -(indexAtPointer() + 0.5) * (TAU / n);
}

function indexAtPointer() {
  const n = wheelItems.length;
  const s = TAU / n;
  const a = (((-rotation) % TAU) + TAU) % TAU;
  return Math.floor(a / s) % n;
}

// 輪盤邊緣的卡榫數：號碼少時每格一根，號碼多時固定 72 根，避免聲音糊成一片
const MAX_PEGS = 72;
const pegCount = (n) => (n <= MAX_PEGS ? n : MAX_PEGS);
function pegAtPointer() {
  const pegs = pegCount(wheelItems.length);
  const a = (((-rotation) % TAU) + TAU) % TAU;
  return Math.floor(a / (TAU / pegs)) % pegs;
}

// ---------- Sound ----------
let audioCtx = null;
let noiseBuf = null;
let master = null;
let lastTick = 0;

// iOS Safari 只允許在點按當下啟動音效，所以在按「開始」時呼叫
function unlockAudio() {
  if (!state.sound) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      master = audioCtx.createGain();
      master.gain.value = 0.9;
      master.connect(audioCtx.destination);
      noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (audioCtx.state !== 'running') audioCtx.resume();
    // 播一段無聲音訊，讓 iOS 正式解鎖
    const b = audioCtx.createBufferSource();
    b.buffer = audioCtx.createBuffer(1, 1, 22050);
    b.connect(master); b.start(0);
  } catch (_) {}
}
// resume() 是非同步的，尚未 running 時排進去的聲音會在解鎖後播出
const audioReady = () => state.sound && !!audioCtx && audioCtx.state !== 'closed';

// 卡榫撞到指針的「喀」：短促的雜訊 + 低頻撞擊，速度越快越清脆
function clack(speed = 1) {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuf;
  const bp = audioCtx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800 + speed * 1600;
  bp.Q.value = 2.5;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.55, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
  src.connect(bp).connect(g).connect(master);
  src.start(t, Math.random() * 0.5, 0.05);

  const o = audioCtx.createOscillator();
  const og = audioCtx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(420 + speed * 180, t);
  o.frequency.exponentialRampToValueAtTime(140, t + 0.04);
  og.gain.setValueAtTime(0.35, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(og).connect(master);
  o.start(t); o.stop(t + 0.06);
}

// 轉動時的風切聲，音量與音高跟著轉速變化
let whoosh = null;
function whooshStart() {
  if (!audioReady()) return;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const g = audioCtx.createGain();
  g.gain.value = 0;
  src.connect(lp).connect(g).connect(master);
  src.start();
  whoosh = { src, lp, g };
}
function whooshUpdate(speed) {
  if (!whoosh) return;
  const t = audioCtx.currentTime;
  whoosh.g.gain.setTargetAtTime(0.16 * speed, t, 0.05);
  whoosh.lp.frequency.setTargetAtTime(250 + speed * 1300, t, 0.05);
}
function whooshStop() {
  if (!whoosh) return;
  const w = whoosh;
  whoosh = null;
  w.g.gain.setTargetAtTime(0, audioCtx.currentTime, 0.08);
  setTimeout(() => { try { w.src.stop(); } catch (_) {} }, 500);
}

function tone(freq, dur, vol = 0.12, type = 'sine') {
  if (!audioReady()) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}
// 停下來中獎的「叮～」
function ding() {
  tone(1319, 0.5, 0.18);
  tone(1976, 0.4, 0.07);
}
function fanfare() {
  [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.25, 0.14, 'triangle'), i * 110));
}

// 指針被卡榫撥動的小動畫，和「喀」聲同步
const pointerEl = document.querySelector('.pointer');
let flickTimer = 0;
function flickPointer(speed) {
  pointerEl.style.transition = 'none';
  pointerEl.style.transform = `translateX(-50%) rotate(${-8 - speed * 10}deg)`;
  clearTimeout(flickTimer);
  flickTimer = setTimeout(() => {
    pointerEl.style.transition = 'transform .12s ease-out';
    pointerEl.style.transform = 'translateX(-50%)';
  }, 30);
}

// ---------- Spin ----------
const easeOut = (t) => 1 - Math.pow(1 - t, 4);

function spinTo(index, duration, turns) {
  return new Promise((resolve) => {
    const n = wheelItems.length;
    const s = TAU / n;
    // 停在扇形正中央，放大條的格子才會剛好對齊中獎框
    const desired = (((-(index + 0.5) * s) % TAU) + TAU) % TAU;
    const start = rotation;
    const cur = ((start % TAU) + TAU) % TAU;
    const delta = ((desired - cur) % TAU + TAU) % TAU;
    const target = start + delta + turns * TAU;
    const t0 = performance.now();
    let lastPeg = pegAtPointer();
    animating = true;
    whooshStart();

    function frame(now) {
      const t = Math.min(1, (now - t0) / duration);
      rotation = start + (target - start) * easeOut(t);
      drawWheel();
      const speed = Math.pow(1 - t, 3); // 相對轉速 1 → 0（easeOut 的導數）
      whooshUpdate(speed);
      const peg = pegAtPointer();
      if (peg !== lastPeg) {
        lastPeg = peg;
        if (now - lastTick > 28) { clack(speed); flickPointer(speed); lastTick = now; }
      }
      if (t < 1) requestAnimationFrame(frame);
      else { animating = false; whooshStop(); drawWheel(); resolve(); }
    }
    requestAnimationFrame(frame);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let spinning = false;

async function startDraw() {
  if (spinning) return;
  readInputs();
  const prize = isPrize();
  const pool = currentPool();
  // 獎品模式：每個獎品都要轉出來，排出完整順序
  const k = prize ? pool.length : state.count;
  if (prize ? k < 2 : pool.length < k || k < 1) { renderPoolInfo(); return; }

  unlockAudio();
  spinning = true;
  setBusy(true);
  $('current').innerHTML = '';
  wheelItems = pool.slice();
  drawWheel();

  const cfg = SPEEDS[state.speed] || SPEEDS.normal;
  const results = [];

  for (let r = 0; r < k; r++) {
    $('status').textContent = prize
      ? `排第 ${r + 1} / ${k} 順位…`
      : k > 1 ? `抽第 ${r + 1} / ${k} 個…` : '抽獎中…';
    const idx = randInt(wheelItems.length);
    const first = r === 0;
    await spinTo(idx, first ? cfg.duration : cfg.duration * 0.7, first ? cfg.turns : Math.max(2, cfg.turns - 2));

    const num = wheelItems[idx];
    results.push(num);
    highlight = idx;
    drawWheel();
    ding();
    addBall($('current'), num, prize ? r + 1 : 0);
    await sleep(r < k - 1 ? 750 : 400);

    highlight = -1;
    wheelItems.splice(idx, 1);
    snapRotation();
    drawWheel();
  }

  if (!prize && state.noRepeat) state.drawn.push(...results);
  state.history.unshift({ time: Date.now(), nums: results, mode: state.mode });
  save();

  $('status').textContent = prize ? `完成！已排出 ${k} 個獎品的順序` : `完成！抽出 ${k} 個號碼`;
  spinning = false;
  setBusy(false);
  refresh();
  showResult(results, prize);
}

function setBusy(busy) {
  $('spinBtn').disabled = busy;
  document.querySelectorAll('.panel input, .panel select, .panel button').forEach((el) => { el.disabled = busy; });
}

// ---------- UI ----------
// rank > 0 時為獎品模式：顯示「名次 + 名稱」
function addBall(container, num, rank = 0) {
  const b = document.createElement('span');
  b.className = rank ? 'ball prize' : 'ball';
  if (rank) {
    const r = document.createElement('span');
    r.className = 'rank';
    r.textContent = rank;
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = num;
    b.append(r, l);
    b.title = `第 ${rank} 順位：${num}`;
  } else {
    b.textContent = num;
  }
  container.appendChild(b);
}

function showResult(nums, prize = false) {
  const box = $('resultBalls');
  box.innerHTML = '';
  box.classList.toggle('ranked', prize);
  $('resultTitle').textContent = prize ? '🎉 獎品順序' : '🎉 抽獎結果';
  nums.forEach((n, i) => setTimeout(() => addBall(box, n, prize ? i + 1 : 0), i * 90));
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
  const info = $('poolInfo');
  $('poolDetails').classList.toggle('hidden', isPrize());
  if (isPrize()) {
    const n = state.prizes.length;
    const bad = n < 2;
    info.innerHTML = bad
      ? `目前 <b>${n}</b> 個獎品<br>⚠ 至少需要 2 個獎品才能排順序`
      : `共 <b>${n}</b> 個獎品，按「開始」由輪盤依序轉出第 1 ~ ${n} 順位`;
    info.classList.toggle('error', bad);
    $('spinBtn').disabled = bad || spinning;
    return;
  }

  const pool = basePool();
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
    const tag = h.mode === 'prize' ? '🎁 獎品排序' : '🔢 號碼';
    meta.textContent = `第 ${state.history.length - i} 回 · ${tag} · ${d.toLocaleString('zh-TW', { hour12: false })}`;
    const nums = document.createElement('div');
    nums.className = 'nums';
    h.nums.forEach((n, j) => {
      const s = document.createElement('span');
      s.textContent = h.mode === 'prize' ? `${j + 1}. ${n}` : n;
      nums.appendChild(s);
    });
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

function renderMode() {
  const prize = isPrize();
  $('modeNumber').classList.toggle('active', !prize);
  $('modePrize').classList.toggle('active', prize);
  $('modeNumber').setAttribute('aria-selected', String(!prize));
  $('modePrize').setAttribute('aria-selected', String(prize));
  $('numberSettings').classList.toggle('hidden', prize);
  $('prizeSettings').classList.toggle('hidden', !prize);
  document.querySelector('.tape-wrap').style.setProperty('--cell', tapeCell() + 'px');
}

function renderPrizes() {
  const list = $('prizeList');
  list.innerHTML = '';
  state.prizes.forEach((p, i) => {
    const li = document.createElement('li');
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = i + 1;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p;
    const x = document.createElement('button');
    x.textContent = '×';
    x.setAttribute('aria-label', `移除獎品 ${p}`);
    x.onclick = () => { state.prizes.splice(i, 1); save(); refresh(); };
    li.append(no, name, x);
    list.appendChild(li);
  });
  $('clearPrizes').classList.toggle('hidden', state.prizes.length === 0);
}

// 一次可加入多個（貼上多行時每行一個）
function addPrizes(text) {
  const names = text.split(/\r?\n/).map((s) => s.trim().slice(0, 40)).filter(Boolean);
  if (!names.length) return false;
  state.prizes.push(...names);
  save(); refresh();
  return true;
}

function setMode(mode) {
  if (spinning || state.mode === mode) return;
  state.mode = mode;
  $('current').innerHTML = '';
  $('status').textContent = mode === 'prize' ? '輸入獎品後按「開始」排出順序' : '設定好參數後按「開始」';
  save(); refresh();
}

function refresh() {
  renderMode();
  if (!spinning) {
    wheelItems = currentPool();
    snapRotation();
    drawWheel();
  }
  renderPrizes();
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
  if (isPrize()) $('status').textContent = '輸入獎品後按「開始」排出順序';
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

  $('modeNumber').onclick = () => setMode('number');
  $('modePrize').onclick = () => setMode('prize');
  const prizeInput = $('prizeInput');
  const submitPrize = () => { if (addPrizes(prizeInput.value)) prizeInput.value = ''; prizeInput.focus(); };
  $('addPrize').onclick = submitPrize;
  prizeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitPrize(); } });
  prizeInput.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (/\r?\n/.test(text.trim())) { e.preventDefault(); addPrizes(text); }
  });
  $('clearPrizes').onclick = () => {
    if (!confirm('確定要清除全部獎品？')) return;
    state.prizes = []; save(); refresh();
  };

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

  $('soundBtn').onclick = () => {
    state.sound = !state.sound;
    if (state.sound) { unlockAudio(); clack(0.6); } else whooshStop();
    syncInputs(); save();
  };

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
