/* =========================================================
   BLUE FX — Deriv real-time candle client
   Price scale = the right-hand vertical axis. Auto-scales to
   visible candles by default; drag on it to zoom manually,
   tap AUTO to reset (matches TradingView's price-scale model).
   ========================================================= */

const PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const MAX_CANDLES_PER_REQUEST = 5000;
const MONITOR_CANDLE_COUNT = 200;
const PING_INTERVAL_MS = 20000;
const MIN_CANDLE_PX = 3;
const MAX_CANDLE_PX = 30;
const RING_DURATION_MS = 15000;
const AXIS_WIDTH = 64;
const RIGHT_GUTTER = 78; // empty space after the last candle so it isn't hidden behind the axis

const SYMBOLS = [
  { group: "Volatility Indices", items: ["R_10","R_25","R_50","R_75","R_100","1HZ10V","1HZ25V","1HZ50V","1HZ75V","1HZ100V"] },
  { group: "Jump Indices", items: ["JD10","JD25","JD50","JD75","JD100"] },
  { group: "Step Indices", items: ["stpRNG"] },
  { group: "Forex", items: ["frxEURUSD","frxGBPUSD","frxUSDJPY","frxAUDUSD","frxUSDCAD","frxUSDCHF","frxNZDUSD"] },
  { group: "Commodities", items: ["frxXAUUSD","frxXAGUSD","frxBROUSD","frxWTIUSD"] },
  { group: "Crypto", items: ["cryBTCUSD","cryETHUSD","cryLTCUSD"] },
];
const VOLATILITY_SYMBOLS = SYMBOLS[0].items;

let ws = null;
let candles = [];
let currentSymbol = "R_100";
let granularity = 3600;
let reconnectTimer = null;
let reconnectDelay = 2000;
let pingTimer = null;
let loadingHistory = false;
let userScrolled = false;
let candlePx = 8;
let scrollRedrawQueued = false;
let historyLoaded = false;

// Price-scale (y-axis) manual override state
let manualScale = false;
let manualYMin = null, manualYMax = null;
let lastYMin = 0, lastYMax = 1; // updated every draw(), used as the drag baseline
let axisDragStartY = null, axisDragBaseMin = null, axisDragBaseMax = null;
let lastAxisTapTime = 0;

const monitors = {};
VOLATILITY_SYMBOLS.forEach(sym => { monitors[sym] = { candles: [], lastDiffSign: 0 }; });

const symbolSel = document.getElementById("symbol");
const granSel = document.getElementById("granularity");
const statusEl = document.getElementById("status-dot");
const logEl = document.getElementById("log");
const priceBadge = document.getElementById("price-badge");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");
const axisCanvas = document.getElementById("axis-overlay");
const axisCtx = axisCanvas.getContext("2d");
const scrollContainer = document.getElementById("scroll-container");
const chartArea = document.getElementById("chart-area");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const alertBar = document.getElementById("alert-bar");
const alertText = document.getElementById("alert-text");
const dismissAlertBtn = document.getElementById("dismissAlertBtn");
const crossList = document.getElementById("cross-list");
const enableSoundBtn = document.getElementById("enableSoundBtn");
const ringtoneSelect = document.getElementById("ringtoneSelect");
const testRingBtn = document.getElementById("testRingBtn");
const monitorStatus = document.getElementById("monitor-status");
const axisModeBtn = document.getElementById("axis-mode-btn");
const jumpLatestBtn = document.getElementById("jump-latest-btn");

SYMBOLS.forEach(group => {
  const og = document.createElement("optgroup");
  og.label = group.group;
  group.items.forEach(sym => {
    const opt = document.createElement("option");
    opt.value = sym;
    opt.textContent = sym;
    if (sym === currentSymbol) opt.selected = true;
    og.appendChild(opt);
  });
  symbolSel.appendChild(og);
});

function log(msg) {
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(state) { statusEl.className = state; }
function bucketStart(epoch, gran) { return Math.floor(epoch / gran) * gran; }

// =========================================================
// AUDIO
// =========================================================
let audioCtx = null;
let soundUnlocked = false;
let activeRingStop = null;

function ensureAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { log("Audio not supported: " + e.message); return null; }
  }
  return audioCtx;
}
function unlockAudio() {
  const ac = ensureAudioCtx();
  if (!ac) return;
  ac.resume().then(() => { soundUnlocked = true; monitorStatus.textContent = "Sound: enabled"; }).catch(() => {});
}
document.addEventListener("click", unlockAudio);
enableSoundBtn.addEventListener("click", () => { unlockAudio(); log("Sound unlock requested."); });
testRingBtn.addEventListener("click", () => { unlockAudio(); playRingtone(ringtoneSelect.value); });

function playTone(freq, startTime, duration, type = "sine", gainVal = 0.3) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(gainVal, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(startTime); osc.stop(startTime + duration);
}

function playRingtone(kind) {
  const ac = ensureAudioCtx();
  if (!ac) return;
  ac.resume().catch(() => {});
  if (activeRingStop) activeRingStop();
  const end = ac.currentTime + RING_DURATION_MS / 1000;
  let intervalId;
  if (kind === "beep") intervalId = setInterval(() => { if (ac.currentTime < end) playTone(880, ac.currentTime, 0.18, "square"); }, 400);
  else if (kind === "siren") { let up = true; intervalId = setInterval(() => { if (ac.currentTime < end) { playTone(up ? 700 : 1100, ac.currentTime, 0.35, "sine", 0.25); up = !up; } }, 350); }
  else if (kind === "chime") { const notes = [523.25, 659.25, 783.99]; let i = 0; intervalId = setInterval(() => { if (ac.currentTime < end) playTone(notes[i++ % notes.length], ac.currentTime, 0.3, "triangle", 0.28); }, 300); }
  else intervalId = setInterval(() => { if (ac.currentTime < end) playTone(1200, ac.currentTime, 0.06, "square", 0.25); }, 150);

  if (kind === "beep") playTone(880, ac.currentTime, 0.18, "square");
  else if (kind === "siren") playTone(700, ac.currentTime, 0.35, "sine", 0.25);
  else if (kind === "chime") playTone(523.25, ac.currentTime, 0.3, "triangle", 0.28);
  else playTone(1200, ac.currentTime, 0.06, "square", 0.25);

  const timeoutId = setTimeout(() => { clearInterval(intervalId); activeRingStop = null; }, RING_DURATION_MS);
  activeRingStop = () => { clearInterval(intervalId); clearTimeout(timeoutId); };
}

// =========================================================
// EMA + crossover detection
// =========================================================
function computeEMA(candleArr, period) {
  const out = new Array(candleArr.length).fill(null);
  if (candleArr.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candleArr[i].close;
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < candleArr.length; i++) out[i] = candleArr[i].close * k + out[i - 1] * (1 - k);
  return out;
}

function checkCrossover(symbol, candleArr) {
  const ema20 = computeEMA(candleArr, 20);
  const ema50 = computeEMA(candleArr, 50);
  const n = candleArr.length;
  if (n < 51) return;
  const lastIdx = n - 1, prevIdx = n - 2;
  if (ema20[lastIdx] == null || ema50[lastIdx] == null || ema20[prevIdx] == null || ema50[prevIdx] == null) return;
  const prevSign = Math.sign(ema20[prevIdx] - ema50[prevIdx]);
  const currSign = Math.sign(ema20[lastIdx] - ema50[lastIdx]);
  const mon = monitors[symbol];
  if (mon.lastDiffSign !== 0 && prevSign !== 0 && currSign !== 0 && mon.lastDiffSign !== currSign) {
    fireCrossoverAlert(symbol, currSign > 0);
  }
  mon.lastDiffSign = currSign;
}

function fireCrossoverAlert(symbol, bullish) {
  const time = new Date().toLocaleTimeString();
  const label = bullish ? "Bullish (EMA20 crossed above EMA50)" : "Bearish (EMA20 crossed below EMA50)";
  log(`CROSSOVER: ${symbol} — ${label} at ${time}`);
  const entry = document.createElement("div");
  entry.className = "cross-entry " + (bullish ? "bull" : "bear");
  entry.textContent = `[${time}] ${symbol} — ${label}`;
  if (crossList.firstChild && crossList.firstChild.style) crossList.innerHTML = "";
  crossList.prepend(entry);
  alertText.textContent = `${symbol}: ${label}`;
  alertBar.classList.add("show");
  playRingtone(ringtoneSelect.value);
  if (!soundUnlocked) monitorStatus.textContent = "Sound: attempted (tap anywhere once if silent)";
}
dismissAlertBtn.addEventListener("click", () => alertBar.classList.remove("show"));

// =========================================================
// Horizontal zoom (time axis) — buttons + pinch
// =========================================================
scrollContainer.addEventListener("scroll", () => {
  const atRightEdge = scrollContainer.scrollWidth - scrollContainer.scrollLeft - scrollContainer.clientWidth < 20;
  userScrolled = !atRightEdge;
  jumpLatestBtn.classList.toggle("show", userScrolled);
  if (!scrollRedrawQueued) { scrollRedrawQueued = true; requestAnimationFrame(() => { scrollRedrawQueued = false; draw(); }); }
});

jumpLatestBtn.addEventListener("click", () => {
  userScrolled = false;
  jumpLatestBtn.classList.remove("show");
  draw();
});

function setZoom(newPx, anchorClientX) {
  const oldPx = candlePx;
  newPx = Math.min(MAX_CANDLE_PX, Math.max(MIN_CANDLE_PX, newPx));
  if (newPx === oldPx) return;
  const rect = scrollContainer.getBoundingClientRect();
  const anchorX = anchorClientX != null ? anchorClientX - rect.left : rect.width / 2;
  const contentX = scrollContainer.scrollLeft + anchorX;
  const ratio = contentX / (candles.length * oldPx || 1);
  candlePx = newPx;
  draw();
  scrollContainer.scrollLeft = ratio * candles.length * candlePx - anchorX;
}
zoomInBtn.addEventListener("click", () => setZoom(candlePx * 1.4));
zoomOutBtn.addEventListener("click", () => setZoom(candlePx / 1.4));

let pinchStartDist = null, pinchStartPx = null;
function touchDist(t) { const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx*dx+dy*dy); }
scrollContainer.addEventListener("touchstart", (e) => { if (e.touches.length === 2) { pinchStartDist = touchDist(e.touches); pinchStartPx = candlePx; } }, { passive: true });
scrollContainer.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2 && pinchStartDist) {
    e.preventDefault();
    const scale = touchDist(e.touches) / pinchStartDist;
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    setZoom(pinchStartPx * scale, midX);
  }
}, { passive: false });
scrollContainer.addEventListener("touchend", (e) => { if (e.touches.length < 2) { pinchStartDist = null; pinchStartPx = null; } });

// =========================================================
// Vertical drag on the PRICE SCALE (axis) — manual zoom,
// matching TradingView's "drag the price axis to rescale" model.
// Double-tap the axis resets to auto-scale.
// =========================================================
axisCanvas.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  const now = Date.now();
  if (now - lastAxisTapTime < 300) {
    manualScale = false; // double-tap => reset to auto
    axisModeBtn.textContent = "AUTO";
    draw();
    lastAxisTapTime = 0;
    return;
  }
  lastAxisTapTime = now;
  axisDragStartY = e.touches[0].clientY;
  axisDragBaseMin = manualScale ? manualYMin : lastYMin;
  axisDragBaseMax = manualScale ? manualYMax : lastYMax;
}, { passive: true });

axisCanvas.addEventListener("touchmove", (e) => {
  if (axisDragStartY == null || e.touches.length !== 1) return;
  e.preventDefault();
  const deltaY = axisDragStartY - e.touches[0].clientY; // drag up = zoom in (narrower range)
  const center = (axisDragBaseMin + axisDragBaseMax) / 2;
  const baseRange = (axisDragBaseMax - axisDragBaseMin) || 1;
  const scaleFactor = Math.pow(1.01, deltaY); // gentle sensitivity
  const newRange = baseRange / scaleFactor;
  manualYMin = center - newRange / 2;
  manualYMax = center + newRange / 2;
  manualScale = true;
  axisModeBtn.textContent = "MANUAL";
  draw();
}, { passive: false });

axisCanvas.addEventListener("touchend", () => { axisDragStartY = null; });

axisModeBtn.addEventListener("click", () => {
  manualScale = false;
  axisModeBtn.textContent = "AUTO";
  draw();
});

// =========================================================
// WebSocket
// =========================================================
function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (ws) { try { ws.close(); } catch (e) {} }
  setStatus("connecting");
  log(`Connecting to public feed...`);
  ws = new WebSocket(PUBLIC_WS_URL);

  ws.onopen = () => {
    setStatus("connected");
    log("Connected.");
    reconnectDelay = 2000;
    candles = [];
    historyLoaded = false;
    VOLATILITY_SYMBOLS.forEach(sym => { monitors[sym].candles = []; monitors[sym].lastDiffSign = 0; });
    subscribeCandles(currentSymbol, granularity, MAX_CANDLES_PER_REQUEST, "latest");
    VOLATILITY_SYMBOLS.forEach(sym => subscribeCandles(sym, granularity, MONITOR_CANDLE_COUNT, "latest"));
    monitorStatus.textContent = (soundUnlocked ? "Sound: enabled" : "Sound: tap anywhere to enable") + " — monitoring " + VOLATILITY_SYMBOLS.length + " volatility indices";
    pingTimer = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 })); }, PING_INTERVAL_MS);
  };

  ws.onmessage = (event) => { let msg; try { msg = JSON.parse(event.data); } catch (e) { return; } handleMessage(msg); };
  ws.onerror = (err) => { log("WebSocket error (see console)."); console.error("WS error event:", err); };
  ws.onclose = (event) => {
    setStatus("disconnected");
    clearInterval(pingTimer);
    log(`Disconnected (code=${event.code}, reason="${event.reason || "none"}"). Reconnecting in ${reconnectDelay/1000}s...`);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  };
}

function subscribeCandles(symbol, gran, count, end) {
  ws.send(JSON.stringify({ ticks_history: symbol, style: "candles", granularity: gran, adjust_start_time: 1, count, end, subscribe: end === "latest" ? 1 : 0 }));
}

function requestMoreHistory() {
  if (candles.length === 0 || loadingHistory) return;
  loadingHistory = true;
  subscribeCandles(currentSymbol, granularity, MAX_CANDLES_PER_REQUEST, candles[0].time - 1);
}

function handleMessage(msg) {
  console.log("RAW:", msg);
  if (msg.error) {
    const errSym = (msg.echo_req && msg.echo_req.ticks_history) || "unknown symbol";
    log(`Server error for ${errSym}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return;
  }
  if (msg.pong) return;

  const echoSymbol = msg.echo_req && msg.echo_req.ticks_history;

  if (msg.candles) {
    const incoming = msg.candles.map(c => normalizeCandle(c, granularity));
    const merged = mergeIntoBuckets(incoming, granularity);
    if (echoSymbol === currentSymbol || echoSymbol == null) {
      if (loadingHistory) {
        const existingTimes = new Set(candles.map(c => c.time));
        const older = merged.filter(c => !existingTimes.has(c.time));
        candles = [...older, ...candles].sort((a, b) => a.time - b.time);
        loadingHistory = false;
        log(`Loaded ${older.length} older candles. Total: ${candles.length}`);
      } else { candles = merged; historyLoaded = true; }
      draw();
    }
    if (echoSymbol && monitors[echoSymbol]) { monitors[echoSymbol].candles = merged; checkCrossover(echoSymbol, merged); }
    return;
  }
  if (msg.ohlc) {
    const update = normalizeCandle(msg.ohlc, granularity);
    const sym = echoSymbol || (msg.ohlc && msg.ohlc.symbol);
    if ((sym === currentSymbol || sym == null) && historyLoaded) applyLiveUpdate(update);
    if (sym && monitors[sym]) applyMonitorUpdate(sym, update);
    return;
  }
  if (msg.tick) {
    const price = Number(msg.tick.quote ?? msg.tick.price);
    const epoch = Number(msg.tick.epoch) || Math.floor(Date.now() / 1000);
    const sym = msg.tick.symbol || echoSymbol;
    if ((sym === currentSymbol || sym == null) && historyLoaded) applyTickAsOHLC(epoch, price);
    if (sym && monitors[sym]) applyMonitorTick(sym, epoch, price);
    return;
  }
}

function mergeIntoBuckets(list, gran) {
  const buckets = new Map();
  for (const c of list) {
    const key = bucketStart(c.time, gran);
    if (!buckets.has(key)) buckets.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close });
    else { const b = buckets.get(key); b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function normalizeCandle(c, gran) {
  return { time: bucketStart(Number(c.epoch ?? c.time), gran), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) };
}

function applyLiveUpdate(update) {
  const last = candles[candles.length - 1];
  if (last && last.time === update.time) { last.high = Math.max(last.high, update.high); last.low = Math.min(last.low, update.low); last.close = update.close; }
  else if (!last || update.time > last.time) { candles.push(update); }
  else { const t = candles.find(c => c.time === update.time); if (t) { t.high = Math.max(t.high, update.high); t.low = Math.min(t.low, update.low); t.close = update.close; } }
  updateLastPrice(update.close);
  draw();
}

function applyTickAsOHLC(epoch, price) {
  const bucket = bucketStart(epoch, granularity);
  const last = candles[candles.length - 1];
  if (last && last.time === bucket) { last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price; }
  else if (!last || bucket > last.time) { candles.push({ time: bucket, open: price, high: price, low: price, close: price }); }
  updateLastPrice(price);
  draw();
}

function applyMonitorUpdate(symbol, update) {
  const mon = monitors[symbol];
  const last = mon.candles[mon.candles.length - 1];
  if (last && last.time === update.time) { last.high = Math.max(last.high, update.high); last.low = Math.min(last.low, update.low); last.close = update.close; }
  else if (!last || update.time > last.time) { mon.candles.push(update); if (mon.candles.length > MONITOR_CANDLE_COUNT) mon.candles.shift(); }
  checkCrossover(symbol, mon.candles);
}

function applyMonitorTick(symbol, epoch, price) {
  const mon = monitors[symbol];
  const bucket = bucketStart(epoch, granularity);
  const last = mon.candles[mon.candles.length - 1];
  if (last && last.time === bucket) { last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price; }
  else if (!last || bucket > last.time) { mon.candles.push({ time: bucket, open: price, high: price, low: price, close: price }); if (mon.candles.length > MONITOR_CANDLE_COUNT) mon.candles.shift(); }
  checkCrossover(symbol, mon.candles);
}

function updateLastPrice(price) {
  if (price == null) return;
  const prevPrice = priceBadge.dataset.prev ? Number(priceBadge.dataset.prev) : price;
  priceBadge.textContent = Number(price).toFixed(4);
  priceBadge.className = price >= prevPrice ? "up" : "down";
  priceBadge.dataset.prev = price;
}

function formatTime(epoch, gran) {
  const d = new Date(epoch * 1000);
  return gran >= 86400 ? d.toLocaleDateString([], { month: "short", day: "numeric" }) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// =========================================================
// Rendering
// =========================================================
function draw() {
  if (!historyLoaded || candles.length < 2) {
    const containerH = scrollContainer.clientHeight;
    const containerW = chartArea.clientWidth || 300;
    canvas.width = containerW * devicePixelRatio;
    canvas.height = containerH * devicePixelRatio;
    canvas.style.width = containerW + "px";
    canvas.style.height = containerH + "px";
    ctx.setTransform(1,0,0,1,0,0); ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.clearRect(0, 0, containerW, containerH);
    ctx.fillStyle = "#7a8296";
    ctx.font = "13px monospace";
    ctx.fillText("Loading candle history for " + currentSymbol + "...", 16, containerH / 2);
    return;
  }

  const containerH = scrollContainer.clientHeight;
  const containerW = chartArea.clientWidth;
  const padTop = 16, padBottom = 28;
  const plotW = candles.length * candlePx;
  const totalW = plotW + RIGHT_GUTTER; // empty space so the live candle isn't hidden behind the axis

  canvas.width = totalW * devicePixelRatio;
  canvas.height = containerH * devicePixelRatio;
  canvas.style.width = totalW + "px";
  canvas.style.height = containerH + "px";
  ctx.setTransform(1,0,0,1,0,0); ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, totalW, containerH);

  axisCanvas.width = AXIS_WIDTH * devicePixelRatio;
  axisCanvas.height = containerH * devicePixelRatio;
  axisCanvas.style.width = AXIS_WIDTH + "px";
  axisCanvas.style.height = containerH + "px";
  axisCtx.setTransform(1,0,0,1,0,0); axisCtx.scale(devicePixelRatio, devicePixelRatio);
  axisCtx.clearRect(0, 0, AXIS_WIDTH, containerH);

  const scrollLeft = scrollContainer.scrollLeft;
  const firstVisibleIdx = Math.max(0, Math.floor(scrollLeft / candlePx));
  const lastVisibleIdx = Math.min(candles.length - 1, Math.ceil((scrollLeft + containerW) / candlePx));
  const visible = candles.slice(firstVisibleIdx, lastVisibleIdx + 1);
  const rangeSource = visible.length > 0 ? visible : candles;

  const ema20Full = computeEMA(candles, 20);
  const ema50Full = computeEMA(candles, 50);

  const plotH = containerH - padTop - padBottom;
  let yMin, yMax;

  if (manualScale && manualYMin != null && manualYMax != null) {
    yMin = manualYMin; yMax = manualYMax;
  } else {
    const highs = rangeSource.map(c => c.high);
    const lows = rangeSource.map(c => c.low);
    for (let i = firstVisibleIdx; i <= lastVisibleIdx; i++) {
      if (ema20Full[i] != null) { highs.push(ema20Full[i]); lows.push(ema20Full[i]); }
      if (ema50Full[i] != null) { highs.push(ema50Full[i]); lows.push(ema50Full[i]); }
    }
    const max = Math.max(...highs), min = Math.min(...lows);
    const range = (max - min) || 1;
    const yPad = range * 0.1;
    yMax = max + yPad; yMin = min - yPad;
  }

  lastYMin = yMin; lastYMax = yMax; // baseline for the next manual drag
  const yRange = yMax - yMin;
  const yToPx = (val) => padTop + (1 - (val - yMin) / yRange) * plotH;
  const bodyW = Math.max(1, candlePx * 0.65);

  ctx.strokeStyle = "#1e2636"; ctx.lineWidth = 1;
  axisCtx.fillStyle = "#7a8296"; axisCtx.font = "11px monospace";
  for (let i = 0; i <= 6; i++) {
    const val = yMin + (yRange * i) / 6;
    const y = yToPx(val);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    axisCtx.fillText(val.toFixed(4), 6, y + 4);
  }

  ctx.fillStyle = "#7a8296"; ctx.font = "11px monospace";
  const labelEvery = Math.max(1, Math.floor(candles.length / 10));
  candles.forEach((c, i) => { if (i % labelEvery === 0) ctx.fillText(formatTime(c.time, granularity), i * candlePx, containerH - 8); });

  candles.forEach((c, i) => {
    const x = i * candlePx + candlePx / 2;
    const yHigh = yToPx(c.high), yLow = yToPx(c.low), yOpen = yToPx(c.open), yClose = yToPx(c.close);
    const up = c.close >= c.open;
    const isForming = i === candles.length - 1; // last bucket, assumed still open
    ctx.strokeStyle = up ? "#26a69a" : "#ef5350"; ctx.fillStyle = up ? "#26a69a" : "#ef5350";
    ctx.beginPath(); ctx.moveTo(x, yHigh); ctx.lineTo(x, yLow); ctx.stroke();
    const bodyTop = Math.min(yOpen, yClose), bodyH = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);

    if (isForming) {
      // Highlight the still-forming candle so it's unmistakable
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - bodyW / 2 - 1, bodyTop - 1, bodyW + 2, bodyH + 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = "9px monospace";
      ctx.fillText("● LIVE", x - 10, yHigh - 6);
    }
  });

  drawEmaLine(ema20Full, yToPx, "#f5c542");
  drawEmaLine(ema50Full, yToPx, "#e05fd0");

  const lastClose = candles[candles.length - 1].close;
  const yLast = yToPx(lastClose);
  ctx.strokeStyle = "#2f6bff"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, yLast); ctx.lineTo(plotW, yLast); ctx.stroke();
  ctx.setLineDash([]);

  if (yLast >= 0 && yLast <= containerH) {
    axisCtx.fillStyle = "#2f6bff"; axisCtx.fillRect(0, yLast - 9, 60, 18);
    axisCtx.fillStyle = "#ffffff"; axisCtx.fillText(lastClose.toFixed(4), 4, yLast + 4);
  }

  if (!userScrolled) scrollContainer.scrollLeft = scrollContainer.scrollWidth;
}

function drawEmaLine(emaArr, yToPx, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  emaArr.forEach((val, i) => {
    if (val == null) return;
    const x = i * candlePx + candlePx / 2;
    const y = yToPx(val);
    if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
  });
  ctx.stroke();
}

window.addEventListener("resize", draw);

symbolSel.addEventListener("change", (e) => {
  const previousSymbol = currentSymbol;
  currentSymbol = e.target.value;
  candles = [];
  historyLoaded = false;
  userScrolled = false;
  manualScale = false;
  axisModeBtn.textContent = "AUTO";
  log(`Switching chart from ${previousSymbol} to ${currentSymbol}...`);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ forget_all: "candles" }));
    subscribeCandles(currentSymbol, granularity, MAX_CANDLES_PER_REQUEST, "latest");
    VOLATILITY_SYMBOLS.forEach(sym => subscribeCandles(sym, granularity, MONITOR_CANDLE_COUNT, "latest"));
  }
});

granSel.addEventListener("change", (e) => {
  granularity = Number(e.target.value);
  candles = [];
  historyLoaded = false;
  userScrolled = false;
  manualScale = false;
  axisModeBtn.textContent = "AUTO";
  VOLATILITY_SYMBOLS.forEach(sym => { monitors[sym].candles = []; monitors[sym].lastDiffSign = 0; });
  if (ws && ws.readyState === WebSocket.OPEN) {
    subscribeCandles(currentSymbol, granularity, MAX_CANDLES_PER_REQUEST, "latest");
    VOLATILITY_SYMBOLS.forEach(sym => subscribeCandles(sym, granularity, MONITOR_CANDLE_COUNT, "latest"));
  }
});


connect();

// =========================================================
// TRADE UI — placeholders only. No real orders are sent yet;
// this needs the authenticated OTP WebSocket (see the /otp
// endpoint from earlier) before "Rise"/"Fall" can place a
// real trade. Wire that in when you're ready to connect.
// =========================================================
const riseBtn = document.getElementById("riseBtn");
const fallBtn = document.getElementById("fallBtn");
const accountBlock = document.getElementById("account-block");
const demoAccBtn = document.getElementById("demoAccBtn");
const realAccBtn = document.getElementById("realAccBtn");
const accountBalance = document.getElementById("account-balance");

let selectedAccountType = "demo"; // "demo" | "real" — not yet wired to a real account

riseBtn.addEventListener("click", () => {
  log(`[placeholder] Rise tapped on ${currentSymbol} (${selectedAccountType} account) — not connected to trading yet.`);
});

fallBtn.addEventListener("click", () => {
  log(`[placeholder] Fall tapped on ${currentSymbol} (${selectedAccountType} account) — not connected to trading yet.`);
});

demoAccBtn.addEventListener("click", () => {
  selectedAccountType = "demo";
  demoAccBtn.classList.add("active");
  realAccBtn.classList.remove("active");
  log("Switched to Demo account (placeholder — not yet linked to a real account).");
});

realAccBtn.addEventListener("click", () => {
  selectedAccountType = "real";
  realAccBtn.classList.add("active");
  demoAccBtn.classList.remove("active");
  log("Switched to Real account (placeholder — not yet linked to a real account).");
});

// To reveal the account block later once auth is wired up, run in console:
//   document.getElementById("account-block").classList.add("visible");

// =========================================================
// TABS — Chart / Signals / Settings
// =========================================================
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-page").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    // Redraw the chart canvas in case it was hidden (display:none) while resized
    if (btn.dataset.tab === "chart") setTimeout(draw, 0);
  });
});

// =========================================================
// SIGNALS HISTORY TAB — mirrors every crossover into a full list.
// Not persisted: clears on page reload.
// =========================================================
const crossListFull = document.getElementById("cross-list-full");

function addToSignalsHistory(symbol, bullish, time) {
  const label = bullish ? "Bullish (EMA20 crossed above EMA50)" : "Bearish (EMA20 crossed below EMA50)";
  const entry = document.createElement("div");
  entry.className = "cross-entry " + (bullish ? "bull" : "bear");
  entry.textContent = `[${time}] ${symbol} — ${label}`;
  if (crossListFull.firstChild && crossListFull.firstChild.style) crossListFull.innerHTML = "";
  crossListFull.prepend(entry);
}

// Wrap the existing alert function so both the chart-tab banner AND the
// Signals tab both get updated from the same crossover event.
const _originalFireCrossoverAlert = fireCrossoverAlert;
fireCrossoverAlert = function(symbol, bullish) {
  _originalFireCrossoverAlert(symbol, bullish);
  addToSignalsHistory(symbol, bullish, new Date().toLocaleTimeString());
};

// =========================================================
// LOGOUT — placeholder only. There is no real account session
// yet (still on the public feed), so this just resets the UI.
// =========================================================
document.getElementById("logoutBtn").addEventListener("click", () => {
  selectedAccountType = "demo";
  demoAccBtn.classList.add("active");
  realAccBtn.classList.remove("active");
  accountBalance.textContent = "Not connected";
  log("Logged out (placeholder — no real session was active).");
});

// =========================================================
// DERIV OAUTH LOGIN — Authorization Code + PKCE flow.
// The code-for-token exchange happens on our own backend
// (/api/exchange-code in server.js), per Deriv's requirement
// that this never happen in the browser.
// Rise/Fall still do NOT place real trades — that needs the
// buy/sell message spec, which isn't wired up yet.
// =========================================================
const DERIV_APP_ID = "34qkHBWs65EnHfTnuEESd";
const connectDerivBtn = document.getElementById("connectDerivBtn");
let derivAccessToken = null;
let derivAccounts = []; // [{account_id, balance, currency, account_type, ...}]
let selectedDerivAccount = null;
let authWs = null;

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createPkce() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const code_verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code_verifier));
  const code_challenge = base64UrlEncode(digest);
  return { code_verifier, code_challenge };
}

connectDerivBtn.addEventListener("click", async () => {
  const { code_verifier, code_challenge } = await createPkce();
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("bluefx_code_verifier", code_verifier);
  sessionStorage.setItem("bluefx_oauth_state", state);

  const redirectUri = window.location.origin + "/callback";
  const authUrl = "https://auth.deriv.com/oauth2/auth?" + new URLSearchParams({
    response_type: "code",
    client_id: DERIV_APP_ID,
    redirect_uri: redirectUri,
    scope: "trade account_manage",
    state: state,
    code_challenge: code_challenge,
    code_challenge_method: "S256",
  }).toString();

  window.location.href = authUrl;
});

function loadStoredDerivAccounts() {
  const token = localStorage.getItem("bluefx_access_token");
  const raw = localStorage.getItem("bluefx_deriv_accounts");
  if (!token || !raw) return;
  derivAccessToken = token;
  try {
    derivAccounts = JSON.parse(raw);
    log(`Loaded ${derivAccounts.length} Deriv account(s).`);
    renderDerivAccounts();
  } catch (e) {
    log("Could not parse stored Deriv accounts: " + e.message);
  }
}

function renderDerivAccounts() {
  if (derivAccounts.length === 0) return;
  connectDerivBtn.style.display = "none";

  const demo = derivAccounts.find(a => (a.account_type || "").toLowerCase() === "demo");
  const real = derivAccounts.find(a => (a.account_type || "").toLowerCase() !== "demo");

  demoAccBtn.onclick = () => selectDerivAccount(demo, "demo");
  realAccBtn.onclick = () => selectDerivAccount(real, "real");

  if (demo) selectDerivAccount(demo, "demo"); // default to demo for safety
  else if (real) selectDerivAccount(real, "real");
}

function selectDerivAccount(acc, type) {
  if (!acc) {
    log(`No ${type} account found among linked accounts.`);
    accountBalance.textContent = `No ${type} account linked`;
    return;
  }
  selectedDerivAccount = acc;
  selectedAccountType = type;
  demoAccBtn.classList.toggle("active", type === "demo");
  realAccBtn.classList.toggle("active", type === "real");
  accountBalance.textContent = `${acc.account_id} — ${acc.balance} ${acc.currency}`;
  log(`Selected ${type} account: ${acc.account_id}`);
  connectAuthenticatedFeed(acc);
}

async function connectAuthenticatedFeed(acc) {
  log(`Requesting OTP for account ${acc.account_id}...`);
  try {
    const res = await fetch(
      `https://api.derivws.com/trading/v1/options/accounts/${acc.account_id}/otp`,
      { method: "POST", headers: { "Authorization": `Bearer ${derivAccessToken}` } }
    );
    const body = await res.json();
    if (!res.ok || !body.data || !body.data.url) {
      log(`OTP request failed for ${acc.account_id}: ${JSON.stringify(body)}`);
      return;
    }
    if (authWs) { try { authWs.close(); } catch (e) {} }
    authWs = new WebSocket(body.data.url);
    authWs.onopen = () => log(`Authenticated WebSocket connected for ${acc.account_id}.`);
    authWs.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      console.log("AUTH_RAW:", msg);
      log(`[auth feed] message received — see console (AUTH_RAW) for details.`);
    };
    authWs.onerror = (err) => { log("Authenticated WebSocket error — see console."); console.error(err); };
    authWs.onclose = (event) => log(`Authenticated WebSocket closed (code=${event.code}, reason="${event.reason || "none"}").`);
  } catch (e) {
    log(`OTP request error: ${e.message}`);
  }
}

loadStoredDerivAccounts();
