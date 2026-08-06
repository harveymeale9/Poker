/* ============================================================
   Felt Ledger — script.js
   Single-user poker discipline tracker + spaced-repetition study.
   Storage: data.json in a GitHub repo via the REST API,
   with a localStorage cache for instant loads / offline use.
   ============================================================ */

"use strict";

/* ---------------- constants ---------------- */

const CFG_KEY = "feltledger_config";
const CACHE_KEY = "feltledger_cache";
const PH_KEY_PREFIX = "feltledger_ph_"; // placeholder done-state per date

const TRAILING_HANDS = 7500;

// Days until the NEXT review, indexed by number of completed reviews.
// Stage 0 = NEW (due the morning after creation). Completing stage 0
// schedules +3d, then +7d, ... Completing the Day 365 review retires the spot.
const INTERVALS = [3, 7, 14, 30, 60, 120, 365];
const STAGE_LABELS = ["New", "Day 3", "Day 7", "Day 14", "Day 30", "Day 60", "Day 120", "Day 365"];

const PLACEHOLDER_POOL = [
  "BTN vs BB SRP K72r",
  "CO vs BB SRP T84r",
  "SB vs BB 3BP A83r",
  "BTN vs BB SRP QJ4tt",
  "BB vs BTN SRP 964tt",
  "CO vs BTN 3BP AK5r",
  "SB vs BB SRP 772r",
  "BTN vs SB 3BP QT7ss",
  "BB vs CO SRP J85ss",
  "HJ vs BB SRP A94r",
  "BB vs SB 3BP K96tt",
  "BTN vs BB SRP 655r"
];

/* ---------------- state ---------------- */

let db = { dailyEntries: [], studySpots: [] };
let ghSha = null;
let chart = null;
let chartRange = "90";
let toastTimer = null;
let undoSnapshot = null; // { spotId, spot } for undoing a completion

/* ---------------- date helpers (local timezone) ---------------- */

function localISO(d) {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
}
function todayStr() { return localISO(new Date()); }
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return localISO(new Date(y, m - 1, d + n));
}
function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long"
  });
}

/* ---------------- misc helpers ---------------- */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function fmtNum(n, dp = 0) {
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: dp, maximumFractionDigits: dp
  });
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* UTF-8 safe base64 */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------------- config ---------------- */

function getConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY));
    if (c && c.user && c.repo && c.token) return c;
  } catch (e) { /* ignore */ }
  return null;
}
function setConfig(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }

/* ---------------- data normalization ---------------- */

function normalize(raw) {
  const out = { dailyEntries: [], studySpots: [] };
  if (raw && Array.isArray(raw.dailyEntries)) out.dailyEntries = raw.dailyEntries;
  if (raw && Array.isArray(raw.studySpots)) out.studySpots = raw.studySpots;
  out.dailyEntries.forEach((e) => {
    e.handsPlayed = Number(e.handsPlayed) || 0;
    e.punts = Number(e.punts) || 0;
    e.bbPunted = Number(e.bbPunted) || 0;
    e.sloppyPlays = Number(e.sloppyPlays) || 0;
  });
  out.studySpots.forEach((s) => {
    s.notes = s.notes || "";
    s.reviewStage = Number(s.reviewStage) || 0;
    s.reviewHistory = Array.isArray(s.reviewHistory) ? s.reviewHistory : [];
    s.retired = !!s.retired;
  });
  out.dailyEntries.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/* ---------------- GitHub sync ---------------- */

function ghUrl(c) {
  return `https://api.github.com/repos/${encodeURIComponent(c.user)}/${encodeURIComponent(c.repo)}/contents/data.json`;
}
function ghHeaders(c) {
  return {
    "Authorization": `Bearer ${c.token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function ghLoad() {
  const c = getConfig();
  if (!c) return null;
  const res = await fetch(`${ghUrl(c)}?ref=${encodeURIComponent(c.branch || "main")}&t=${Date.now()}`, {
    headers: ghHeaders(c), cache: "no-store"
  });
  if (res.status === 404) { ghSha = null; return { missing: true }; }
  if (res.status === 401) throw new Error("Token rejected — check your PAT in settings.");
  if (!res.ok) throw new Error(`GitHub load failed (${res.status}).`);
  const j = await res.json();
  ghSha = j.sha;
  return { data: JSON.parse(b64decode(j.content)) };
}

async function ghSave() {
  const c = getConfig();
  if (!c) return false;
  // Refresh the sha right before writing so the commit lands on the latest file.
  try {
    const r = await fetch(`${ghUrl(c)}?ref=${encodeURIComponent(c.branch || "main")}&t=${Date.now()}`, {
      headers: ghHeaders(c), cache: "no-store"
    });
    if (r.ok) ghSha = (await r.json()).sha;
    else if (r.status === 404) ghSha = null;
  } catch (e) { /* offline check happens below */ }

  const body = {
    message: `Felt Ledger update — ${todayStr()}`,
    content: b64encode(JSON.stringify(db, null, 2)),
    branch: c.branch || "main"
  };
  if (ghSha) body.sha = ghSha;

  const res = await fetch(ghUrl(c), {
    method: "PUT", headers: ghHeaders(c), body: JSON.stringify(body)
  });
  if (res.status === 401) throw new Error("Token rejected — check your PAT in settings.");
  if (res.status === 409) throw new Error("Save conflict — reload the page and try again.");
  if (!res.ok) throw new Error(`GitHub save failed (${res.status}).`);
  const j = await res.json();
  ghSha = j.content.sha;
  return true;
}

/* ---------------- persistence pipeline ---------------- */

function setSync(state, label) {
  const dot = $("syncDot"), lab = $("syncLabel");
  dot.className = "sync-dot " + (state === "synced" ? "synced" : state === "syncing" ? "syncing" : state === "error" ? "error" : "");
  lab.textContent = label || ({ synced: "Synced", syncing: "Syncing", error: "Sync error", local: "Local" }[state] || "Local");
}

async function persist() {
  localStorage.setItem(CACHE_KEY, JSON.stringify(db));
  if (!getConfig()) { setSync("local"); return; }
  setSync("syncing");
  try {
    await ghSave();
    setSync("synced");
  } catch (e) {
    setSync("error");
    toast(e.message || "Couldn't save to GitHub. Data is kept on this device.");
  }
}

/* ---------------- stats ---------------- */

function aggregate(entries) {
  const t = { hands: 0, punts: 0, bb: 0, sloppy: 0 };
  entries.forEach((e) => {
    t.hands += e.handsPlayed; t.punts += e.punts;
    t.bb += e.bbPunted; t.sloppy += e.sloppyPlays;
  });
  t.puntRate = t.hands ? (t.bb / t.hands) * 100 : 0;      // BB / 100
  t.puntFreq = t.hands ? (t.punts / t.hands) * 100 : 0;   // %
  t.sloppyFreq = t.hands ? (t.sloppy / t.hands) * 100 : 0; // %
  return t;
}

function lifetimeStats() { return aggregate(db.dailyEntries); }

function trailingStats() {
  const sorted = [...db.dailyEntries].sort((a, b) => b.date.localeCompare(a.date));
  const picked = [];
  let hands = 0;
  for (const e of sorted) {
    picked.push(e);
    hands += e.handsPlayed;
    if (hands >= TRAILING_HANDS) break;
  }
  return aggregate(picked);
}

/* ---------------- study logic ---------------- */

function spotCompletedOn(s, dateStr) {
  return s.reviewHistory.some((h) => h.date === dateStr);
}

function todaysStudy() {
  const today = todayStr();
  const active = db.studySpots.filter((s) => !s.retired);

  // Spots already reviewed today keep their slot (shown as done).
  const doneToday = active.filter((s) => spotCompletedOn(s, today));

  const due = active.filter((s) => !spotCompletedOn(s, today) && s.nextReviewDate && s.nextReviewDate <= today);
  const newDue = due.filter((s) => s.reviewHistory.length === 0)
    .sort((a, b) => a.nextReviewDate.localeCompare(b.nextReviewDate) || a.createdDate.localeCompare(b.createdDate));
  const reviewDue = due.filter((s) => s.reviewHistory.length > 0)
    .sort((a, b) => a.nextReviewDate.localeCompare(b.nextReviewDate));

  const cards = [];
  for (const s of doneToday) if (cards.length < 2) cards.push({ type: "spot", spot: s, done: true });
  for (const s of newDue) if (cards.length < 2) cards.push({ type: "spot", spot: s, done: false });
  for (const s of reviewDue) if (cards.length < 2) cards.push({ type: "spot", spot: s, done: false });

  // Fill any remaining slot with temporary placeholders (never saved).
  // Deterministic per date so a refresh shows the same drills.
  let seed = hashStr(today);
  const used = new Set(cards.filter((c) => c.type === "spot").map((c) => c.spot.spotText));
  while (cards.length < 2) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const pick = PLACEHOLDER_POOL[seed % PLACEHOLDER_POOL.length];
    if (used.has(pick)) continue;
    used.add(pick);
    cards.push({ type: "placeholder", text: pick, index: cards.length });
  }
  return cards;
}

function stageLabel(s) {
  if (s.reviewHistory.length === 0) return "New";
  return `Review · ${STAGE_LABELS[Math.min(s.reviewStage, STAGE_LABELS.length - 1)]}`;
}
function cornerRank(s) {
  if (s.reviewHistory.length === 0) return "N";
  const lbl = STAGE_LABELS[Math.min(s.reviewStage, STAGE_LABELS.length - 1)];
  return lbl.replace("Day ", "") + "d";
}

function completeSpot(id, noteText) {
  const s = db.studySpots.find((x) => x.id === id);
  if (!s) return;
  undoSnapshot = { id: s.id, before: JSON.parse(JSON.stringify(s)) };

  const today = todayStr();
  if (noteText && noteText.trim()) appendNote(s, noteText);
  s.reviewHistory.push({ date: today, stage: s.reviewStage });
  if (s.reviewStage >= INTERVALS.length) {
    s.retired = true;
    s.nextReviewDate = null;
  } else {
    s.nextReviewDate = addDays(today, INTERVALS[s.reviewStage]);
  }
  s.reviewStage++;
  persist();
  renderAll();

  const when = s.retired ? "Spot retired — fully learned." : `Next review ${s.nextReviewDate}.`;
  toast(`Marked complete. ${when}`, "Undo", () => {
    if (!undoSnapshot) return;
    const i = db.studySpots.findIndex((x) => x.id === undoSnapshot.id);
    if (i !== -1) db.studySpots[i] = undoSnapshot.before;
    undoSnapshot = null;
    persist();
    renderAll();
  });
}

function appendNote(s, text) {
  const stamp = `[${todayStr()}]`;
  s.notes = (s.notes ? s.notes + "\n\n" : "") + `${stamp} ${text.trim()}`;
}

function saveNoteOnly(id, noteText) {
  const s = db.studySpots.find((x) => x.id === id);
  if (!s || !noteText.trim()) return;
  appendNote(s, noteText);
  persist();
  renderAll();
  toast("Note added.");
}

/* placeholder done-state, per device per day */
function phKey() { return PH_KEY_PREFIX + todayStr(); }
function getPhDone() {
  try { return JSON.parse(localStorage.getItem(phKey())) || {}; } catch (e) { return {}; }
}
function setPhDone(idx, val) {
  const cur = getPhDone();
  cur[idx] = val;
  localStorage.setItem(phKey(), JSON.stringify(cur));
}

/* ---------------- rendering: dashboard ---------------- */

function renderComparison(life, trail) {
  const card = $("compCard"), line = $("compLine"), sub = $("compSub");
  card.className = "comp-card";

  if (life.hands === 0) { card.hidden = true; return; }
  card.hidden = false;

  if (life.hands <= TRAILING_HANDS) {
    line.textContent = "Building baseline";
    sub.textContent = `${fmtNum(life.hands)} of ${fmtNum(TRAILING_HANDS)}+ hands — comparison unlocks after that.`;
    return;
  }
  if (life.puntRate === 0) {
    line.textContent = "Lifetime punt rate is 0";
    sub.textContent = "Nothing to compare against.";
    return;
  }
  const diff = ((trail.puntRate - life.puntRate) / life.puntRate) * 100;
  const pct = Math.abs(Math.round(diff));
  sub.textContent = `Punt rate: ${trail.puntRate.toFixed(1)} BB/100 now vs ${life.puntRate.toFixed(1)} lifetime`;
  if (diff <= -5) {
    line.textContent = `${pct}% below lifetime average. Excellent work.`;
    card.classList.add("good");
  } else if (diff >= 5) {
    line.textContent = `${pct}% above lifetime average. Focus on discipline.`;
    card.classList.add("bad");
  } else {
    line.textContent = "In line with lifetime average.";
  }
}

function renderKPIs(trail) {
  const has = trail.hands > 0;
  $("kpiPuntRate").textContent = has ? trail.puntRate.toFixed(1) : "—";
  $("kpiPuntFreq").textContent = has ? trail.puntFreq.toFixed(2) + "%" : "—";
  $("kpiSloppyFreq").textContent = has ? trail.sloppyFreq.toFixed(1) + "%" : "—";
}

function statCell(trailVal, lifeVal, betterLow, suffix, dp) {
  let cls = "";
  if (lifeVal > 0 && trailVal !== lifeVal) {
    const improved = betterLow ? trailVal < lifeVal : trailVal > lifeVal;
    cls = improved ? "good" : "bad";
  }
  return `<div class="stat-num ${cls}">${fmtNum(trailVal, dp)}${suffix}</div>`;
}

function renderStatTable(life, trail) {
  const rows = [
    `<div class="stat-row head"><div class="stat-name">Metric</div><div class="stat-num">Lifetime</div><div class="stat-num">Trailing</div></div>`,
    `<div class="stat-row"><div class="stat-name">Hands</div><div class="stat-num">${fmtNum(life.hands)}</div><div class="stat-num">${fmtNum(trail.hands)}</div></div>`,
    `<div class="stat-row"><div class="stat-name">Punt rate (BB/100)</div><div class="stat-num">${fmtNum(life.puntRate, 1)}</div>${statCell(trail.puntRate, life.puntRate, true, "", 1)}</div>`,
    `<div class="stat-row"><div class="stat-name">Punt frequency</div><div class="stat-num">${fmtNum(life.puntFreq, 2)}%</div>${statCell(trail.puntFreq, life.puntFreq, true, "%", 2)}</div>`,
    `<div class="stat-row"><div class="stat-name">Sloppy play frequency</div><div class="stat-num">${fmtNum(life.sloppyFreq, 1)}%</div>${statCell(trail.sloppyFreq, life.sloppyFreq, true, "%", 1)}</div>`
  ];
  $("statTable").innerHTML = rows.join("");
}

/* ---------------- chart ---------------- */

function studyCompletionsByDate() {
  const map = {};
  db.studySpots.forEach((s) => s.reviewHistory.forEach((h) => {
    map[h.date] = (map[h.date] || 0) + 1;
  }));
  return map;
}

function renderChart() {
  const canvas = $("mainChart");
  const empty = $("chartEmpty");
  const entries = [...db.dailyEntries].sort((a, b) => a.date.localeCompare(b.date));
  const studyMap = studyCompletionsByDate();

  const allDates = new Set(entries.map((e) => e.date));
  Object.keys(studyMap).forEach((d) => allDates.add(d));
  let dates = [...allDates].sort();

  if (chartRange !== "all") {
    const cutoff = addDays(todayStr(), -Number(chartRange));
    dates = dates.filter((d) => d >= cutoff);
  }

  if (dates.length === 0) {
    empty.hidden = false;
    canvas.parentElement.style.display = "none";
    if (chart) { chart.destroy(); chart = null; }
    return;
  }
  empty.hidden = true;
  canvas.parentElement.style.display = "";

  const byDate = {};
  entries.forEach((e) => { byDate[e.date] = e; });

  const bbData = dates.map((d) => byDate[d] ? byDate[d].bbPunted : null);
  const pfData = dates.map((d) => byDate[d] && byDate[d].handsPlayed ? +((byDate[d].punts / byDate[d].handsPlayed) * 100).toFixed(3) : null);
  const sfData = dates.map((d) => byDate[d] && byDate[d].handsPlayed ? +((byDate[d].sloppyPlays / byDate[d].handsPlayed) * 100).toFixed(3) : null);
  const stData = dates.map((d) => studyMap[d] || 0);

  const labels = dates.map((d) => {
    const [y, m, dd] = d.split("-").map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  });

  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const gridColor = "rgba(147,163,153,0.08)";
  const tickColor = col("--faint");

  const cfg = {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "BB punted", data: bbData, yAxisID: "yBB", borderColor: col("--red"), backgroundColor: col("--red"), tension: 0.3, spanGaps: true, pointRadius: 3.5, pointHoverRadius: 7, borderWidth: 3 },
        { label: "Punt freq %", data: pfData, yAxisID: "yPct", borderColor: col("--amber"), backgroundColor: col("--amber"), tension: 0.3, spanGaps: true, pointRadius: 3.5, pointHoverRadius: 7, borderWidth: 3 },
        { label: "Sloppy freq %", data: sfData, yAxisID: "yPct", borderColor: col("--brass"), backgroundColor: col("--brass"), tension: 0.3, spanGaps: true, pointRadius: 3.5, pointHoverRadius: 7, borderWidth: 3 },
        { label: "Spots studied", data: stData, yAxisID: "yCount", borderColor: col("--green"), backgroundColor: col("--green"), tension: 0.3, pointRadius: 3.5, pointHoverRadius: 7, borderWidth: 3, borderDash: [6, 5] }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: { color: col("--muted"), boxWidth: 12, boxHeight: 12, padding: 14, usePointStyle: true, pointStyle: "circle", font: { family: "Sora", size: 13, weight: 600 } }
        },
        tooltip: {
          backgroundColor: "#1a241f",
          borderColor: "#26312a", borderWidth: 1,
          titleColor: col("--text"), bodyColor: col("--muted"),
          titleFont: { family: "Sora" }, bodyFont: { family: "Spline Sans Mono", size: 12 },
          padding: 12, cornerRadius: 10,
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v === null || v === undefined) return null;
              if (ctx.dataset.yAxisID === "yPct") return ` ${ctx.dataset.label}: ${v.toFixed(2)}%`;
              if (ctx.dataset.label === "BB punted") return ` BB punted: ${v}`;
              return ` ${ctx.dataset.label}: ${v}`;
            }
          }
        }
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: tickColor, maxTicksLimit: 6, font: { family: "Sora", size: 12 } } },
        yBB: { position: "left", beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, font: { family: "Spline Sans Mono", size: 12 } }, title: { display: false } },
        yPct: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: tickColor, font: { family: "Spline Sans Mono", size: 12 }, callback: (v) => v + "%" } },
        yCount: { display: false, beginAtZero: true, suggestedMax: 4 }
      }
    }
  };

  if (chart) chart.destroy();
  chart = new Chart(canvas, cfg);
}

/* ---------------- rendering: study ---------------- */

function notesHtml(notes) {
  if (!notes) return `<span class="notes-empty">No notes yet — write what you learn below.</span>`;
  return esc(notes).replace(/\[(\d{4}-\d{2}-\d{2})\]/g, `<span class="note-date">[$1]</span>`);
}

function renderStudy() {
  $("studyDate").textContent = prettyDate(todayStr());
  const wrap = $("studyCards");
  const cards = todaysStudy();
  const phDone = getPhDone();

  wrap.innerHTML = cards.map((c, i) => {
    if (c.type === "placeholder") {
      const done = !!phDone[c.index];
      return `
      <div class="study-card placeholder ${done ? "done" : ""}">
        <div class="corner"><span class="corner-rank">—</span><span class="corner-pip">♢</span></div>
        <span class="stage-tag ph">Practice · not saved</span>
        <h3 class="spot-title">${esc(c.text)}</h3>
        <p class="hint">Nothing due today — run this common spot so the habit never breaks. It won't be recorded.</p>
        <div class="study-actions">
          <label class="check ${done ? "is-done" : ""}">
            <input type="checkbox" data-ph="${c.index}" ${done ? "checked" : ""}>
            <span class="box">✓</span>
            ${done ? "Done for today" : "Completed today"}
          </label>
        </div>
      </div>`;
    }
    const s = c.spot;
    const isNew = s.reviewHistory.length === 0 && !c.done;
    return `
    <div class="study-card ${c.done ? "done" : ""}">
      <div class="corner"><span class="corner-rank">${esc(c.done ? "✓" : cornerRank(s))}</span><span class="corner-pip">♠</span></div>
      <span class="stage-tag ${isNew ? "new" : ""}">${c.done ? "Reviewed today" : stageLabel(s)}</span>
      <h3 class="spot-title">${esc(s.spotText)}</h3>
      <div class="notes-history">${notesHtml(s.notes)}</div>
      ${c.done ? "" : `
      <textarea class="note-input" id="note-${esc(s.id)}" placeholder="Add today's notes — appended beneath the old ones, never overwritten."></textarea>
      <div class="study-actions">
        <label class="check">
          <input type="checkbox" data-complete="${esc(s.id)}">
          <span class="box">✓</span>
          Completed today
        </label>
        <button class="btn btn-small" data-savenote="${esc(s.id)}">Save note only</button>
      </div>`}
    </div>`;
  }).join("");

  if (cards.length === 0) {
    wrap.innerHTML = `<p class="study-empty">Nothing to study today.</p>`;
  }

  // wire up
  wrap.querySelectorAll("[data-complete]").forEach((el) => {
    el.addEventListener("change", () => {
      if (!el.checked) return;
      const id = el.getAttribute("data-complete");
      const note = $(`note-${id}`) ? $(`note-${id}`).value : "";
      completeSpot(id, note);
    });
  });
  wrap.querySelectorAll("[data-savenote]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-savenote");
      const ta = $(`note-${id}`);
      if (!ta || !ta.value.trim()) { toast("Write a note first."); return; }
      saveNoteOnly(id, ta.value);
    });
  });
  wrap.querySelectorAll("[data-ph]").forEach((el) => {
    el.addEventListener("change", () => {
      setPhDone(el.getAttribute("data-ph"), el.checked);
      renderStudy();
    });
  });
}

/* ---------------- rendering: input ---------------- */

function resetInputForm() {
  $("inDate").value = todayStr();
  ["inHands", "inPunts", "inBB", "inSloppy", "inSpot1", "inSpot2"].forEach((id) => { $(id).value = ""; });
}

function saveEntry() {
  const date = $("inDate").value;
  const hands = Number($("inHands").value);
  if (!date) { toast("Pick a date."); return; }
  if (!hands || hands <= 0) { toast("Enter how many hands you played."); return; }

  const entry = {
    date,
    handsPlayed: hands,
    punts: Number($("inPunts").value) || 0,
    bbPunted: Number($("inBB").value) || 0,
    sloppyPlays: Number($("inSloppy").value) || 0,
    studySpot1: $("inSpot1").value.trim(),
    studySpot2: $("inSpot2").value.trim()
  };

  // One entry per date — a re-save for the same date replaces the session numbers.
  const existing = db.dailyEntries.findIndex((e) => e.date === date);
  if (existing !== -1) db.dailyEntries[existing] = { ...entry };
  else db.dailyEntries.push(entry);
  db.dailyEntries.sort((a, b) => a.date.localeCompare(b.date));

  // New study spots enter the queue, due the next morning.
  [entry.studySpot1, entry.studySpot2].forEach((text) => {
    if (!text) return;
    const dup = db.studySpots.some((s) => !s.retired && s.spotText.toLowerCase() === text.toLowerCase());
    if (dup) { toast(`"${text}" is already in your study queue.`); return; }
    db.studySpots.push({
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      createdDate: date,
      spotText: text,
      notes: "",
      reviewStage: 0,
      reviewHistory: [],
      nextReviewDate: addDays(date, 1),
      retired: false
    });
  });

  persist();
  renderAll();
  resetInputForm();
  const spotCount = [entry.studySpot1, entry.studySpot2].filter(Boolean).length;
  toast(`Session saved.${spotCount ? ` ${spotCount} spot${spotCount > 1 ? "s" : ""} queued for tomorrow.` : ""}`);
  switchTab("dashboard");
}

/* ---------------- toast ---------------- */

function toast(msg, actionLabel, actionFn) {
  const t = $("toast"), m = $("toastMsg"), a = $("toastAction");
  m.textContent = msg;
  if (actionLabel && actionFn) {
    a.textContent = actionLabel;
    a.hidden = false;
    a.onclick = () => { t.hidden = true; actionFn(); };
  } else {
    a.hidden = true;
    a.onclick = null;
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 6000 : 3200);
}

/* ---------------- tabs ---------------- */

function switchTab(name) {
  ["dashboard", "input", "study"].forEach((t) => { $(`tab-${t}`).hidden = t !== name; });
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === name);
  });
  if (name === "dashboard") renderDashboard();
  if (name === "study") renderStudy();
  window.scrollTo({ top: 0 });
}

/* ---------------- settings modal ---------------- */

function openSettings() {
  const c = getConfig() || {};
  $("cfgUser").value = c.user || "";
  $("cfgRepo").value = c.repo || "";
  $("cfgBranch").value = c.branch || "main";
  $("cfgToken").value = c.token || "";
  $("cfgError").hidden = true;
  $("settingsModal").hidden = false;
}

async function saveSettings() {
  const c = {
    user: $("cfgUser").value.trim(),
    repo: $("cfgRepo").value.trim(),
    branch: $("cfgBranch").value.trim() || "main",
    token: $("cfgToken").value.trim()
  };
  const err = $("cfgError");
  if (!c.user || !c.repo || !c.token) {
    err.textContent = "Username, repository and token are all required.";
    err.hidden = false;
    return;
  }
  $("cfgSave").disabled = true;
  $("cfgSave").textContent = "Connecting…";
  setConfig(c);
  try {
    const remote = await ghLoad();
    if (remote && remote.missing) {
      // First run: publish current local data as data.json.
      await ghSave();
      toast("Connected — data.json created in your repo.");
    } else if (remote && remote.data) {
      const remoteDb = normalize(remote.data);
      const remoteEmpty = remoteDb.dailyEntries.length === 0 && remoteDb.studySpots.length === 0;
      const localHasData = db.dailyEntries.length > 0 || db.studySpots.length > 0;
      if (remoteEmpty && localHasData) {
        await ghSave(); // keep local, push it up
      } else {
        db = remoteDb; // repo is the source of truth
        localStorage.setItem(CACHE_KEY, JSON.stringify(db));
      }
      toast("Connected to GitHub.");
    }
    setSync("synced");
    $("settingsModal").hidden = true;
    $("connectBanner").hidden = true;
    renderAll();
  } catch (e) {
    err.textContent = e.message || "Couldn't reach the repository.";
    err.hidden = false;
    setSync("error");
  } finally {
    $("cfgSave").disabled = false;
    $("cfgSave").textContent = "Save & connect";
  }
}

/* ---------------- render all / init ---------------- */

function renderDashboard() {
  const life = lifetimeStats();
  const trail = trailingStats();
  renderComparison(life, trail);
  renderKPIs(trail);
  renderStatTable(life, trail);
  renderChart();
}

function renderAll() {
  renderDashboard();
  renderStudy();
}

async function init() {
  // Instant paint from cache
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (cached) db = normalize(cached);
  } catch (e) { /* fresh start */ }

  resetInputForm();
  renderAll();

  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.getAttribute("data-tab")));
  });
  document.querySelectorAll("#rangeChips .chip").forEach((ch) => {
    ch.addEventListener("click", () => {
      chartRange = ch.getAttribute("data-range");
      document.querySelectorAll("#rangeChips .chip").forEach((c) => c.classList.toggle("active", c === ch));
      renderChart();
    });
  });
  $("saveEntryBtn").addEventListener("click", saveEntry);
  $("settingsBtn").addEventListener("click", openSettings);
  $("connectBannerBtn").addEventListener("click", openSettings);
  $("cfgCancel").addEventListener("click", () => { $("settingsModal").hidden = true; });
  $("cfgSave").addEventListener("click", saveSettings);
  $("settingsModal").addEventListener("click", (e) => {
    if (e.target === $("settingsModal")) $("settingsModal").hidden = true;
  });

  const cfg = getConfig();
  if (!cfg) {
    setSync("local");
    $("connectBanner").hidden = false;
    return;
  }

  // Pull the latest from GitHub
  setSync("syncing");
  try {
    const remote = await ghLoad();
    if (remote && remote.missing) {
      setSync("local", "No data.json");
      toast("data.json not found in the repo — it'll be created on your first save.");
    } else if (remote && remote.data) {
      db = normalize(remote.data);
      localStorage.setItem(CACHE_KEY, JSON.stringify(db));
      setSync("synced");
      renderAll();
    }
  } catch (e) {
    setSync("error");
    toast("Couldn't reach GitHub — showing data cached on this device.");
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
