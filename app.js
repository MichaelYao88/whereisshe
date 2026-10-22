/* WhereIsShe prototype: a daily GeoGuessr-style game. 5 rounds per day; each round is one photo of the day's
   featured woman ("She") somewhere in the world. Drop a pin, see the distance, score 0-5000 per round.
   UI/structure adapted from Rankd v6 (same tabs, settings, ads, sharing, deep links, stats).
   No build step; works from file:// (map tiles need internet). */
(() => {
"use strict";

// ================================================================ config
const CONFIG = {
  brand: "WhereIsShe",
  // Public URL used in share links. From file:// we can't share a local path, so a placeholder is used.
  siteUrl: (location.protocol.startsWith("http") ? location.origin + location.pathname : "https://whereisshe.example/"),
  // Daily No. 1 date (launch day).
  dailyEpoch: "2026-10-21",          // Daily No. 001 = Oct 21 2026 = she-001; the 5 featured days then repeat in order
  rounds: 5,
  maxRoundScore: 5000,
  scoreScaleKm: 1492.7,              // decay beyond the radius: 5000 * e^(-(km - radius) / 1492.7)
  fullScoreRadiusKm: 30,
  // Future "try our other ranking game" card on a later visit. DISABLED: never shown to players while enabled is false.
  // To launch: set enabled: true + url (+ title/blurb). Shows once, on visit >= minVisit, never in preview mode or on the first visit.
  crossPromo: { enabled: false, url: "", title: "Rankd", blurb: "Our other game: rank things, see how your picks compare.", minVisit: 2 },
  videoRetries: 2,                   // automatic reloads of a clip after an error or a stall
  videoStallMs: 8000,                // no playback progress for this long while loading = stalled -> retry             // within this many km of the answer = full 5000 ("Perfect!")
  interstitialBeforeResults: true,   // ALWAYS show the ad after guess 5, before the results screen (daily too)
  interstitialSeconds: 5,            // skip countdown
  includePlaceholderDays: false,      // placeholder (non-featured) days are not in the daily rotation
  // Opt-in / removal. Leave the endpoints "" to fall back to a pre-filled email (mailto:).
  optinEndpoint: "",                 // e.g. "https://api.whereisshe.example/optin"  (POST JSON)
  removalEndpoint: "",               // e.g. "https://api.whereisshe.example/remove" (POST JSON)
  contactEmail: "hello@whereisshe.example",   // PLACEHOLDER: set a real inbox before launch
  // Map tiles: see tiles.js (OpenFreeMap vector basemap via MapLibre, Esri raster fallback; no API keys).
};
// v6: saved progress is namespaced by mode + day + puzzle id + a hash of the puzzle's content, under fresh v2 keys.
// Anything from earlier versions (v1 keys, other daily numbering, other puzzle content) is discarded, never resumed.
const LS = { results: "wis.results.v2", stats: "wis.stats.v2", settings: "wis.settings.v1", custom: "wis.custom.v1", welcome: "wis.welcome.v1", visits: "wis.visits.v1", promo: "wis.promo.v1" };
const LEGACY_LS = ["wis.results.v1", "wis.stats.v1"];
const BUILD = "7632a6d25a";   // stamped by tools/deploy.sh; must match window.WIS_BUILD in puzzles-data.js
const BANDS = [[100, "🟩", "e-g"], [500, "🟨", "e-y"], [2000, "🟧", "e-o"], [Infinity, "🟥", "e-r"]];   // km thresholds

// ================================================================
// COMMUNITY STATS: BACKEND PLUG-IN POINT
// ----------------------------------------------------------------
// The prototype has NO backend, so no real player data exists.
// Implement these two against Supabase or a Cloudflare Worker + D1/KV:
//   submit: await supabase.from('results').insert({ puzzle_id, day, total, rounds })
//   fetch:  await supabase.rpc('puzzle_stats', { puzzle_id, day })
//           -> { players, avgTotal, pctBeaten /* % of players you beat */, perRoundAvg: [n,n,n,n,n] }
// Return null from fetch() to show the "coming soon" placeholder.
// ================================================================
const CommunityStats = {
  async submit(result) { /* TODO backend */ return false; },
  async fetch(puzzleId, dayKey) { /* TODO backend */ return null; },
};

// ================================================================ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
try { LEGACY_LS.forEach(k => localStorage.removeItem(k)); } catch {}
// A browser can briefly mix a cached app.js from one deploy with puzzles-data.js from another (GitHub Pages caches each
// file for 10 min). That mix numbers the days wrongly, so reload once from a cache-busting URL instead of running it.
if (!BUILD.startsWith("__") && window.WIS_BUILD && window.WIS_BUILD !== BUILD) {
  let tried = false; try { tried = sessionStorage.getItem("wis.reloaded") === BUILD + "|" + window.WIS_BUILD; sessionStorage.setItem("wis.reloaded", BUILD + "|" + window.WIS_BUILD); } catch {}
  if (!tried) { location.replace(location.pathname + "?r=" + Date.now() + location.hash); return; }
}
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const keyOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayKey = () => keyOf(new Date());
const utc = k => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const dayNumber = k => Math.round((utc(k) - utc(CONFIG.dailyEpoch)) / 864e5);      // 0-based
const keyFromDay = n => { const d = new Date(utc(CONFIG.dailyEpoch) + n * 864e5); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; };
const validKey = k => /^\d{4}-\d{2}-\d{2}$/.test(k || "") && !isNaN(utc(k));
const prettyDate = k => new Date(utc(k)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const longDate = k => new Date(utc(k)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const pad3 = n => String(n).padStart(3, "0");
const n0 = v => Math.round(v).toLocaleString("en-US");
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2400); }
const maxTotal = () => CONFIG.rounds * CONFIG.maxRoundScore;

// ================================================================ geo + scoring
function haversineKm(a, b) {
  const R = 6371.0088, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// full score inside the radius, then the usual exponential decay measured from the radius edge (continuous at the edge)
const isPerfect = km => km <= CONFIG.fullScoreRadiusKm;
const scoreFor = km => isPerfect(km) ? CONFIG.maxRoundScore : Math.round(CONFIG.maxRoundScore * Math.exp(-(km - CONFIG.fullScoreRadiusKm) / CONFIG.scoreScaleKm));
const band = km => BANDS.find(b => km < b[0]);
const fmtKm = km => km < 1 ? `${Math.round(km * 1000)} m` : km < 10 ? `${km.toFixed(1)} km` : `${n0(km)} km`;

// ================================================================ data (mirrors build.py)
// One row per round. Puzzle-level fields (daily_order, set, placeholder, featured_*, consent_on) are read from the
// first row of each puzzle_id that has them. See README "Data format".
const COLS = ["puzzle_id","daily_order","round","set","placeholder","featured_name","featured_handle","featured_ig_url","featured_pronoun","consent_on",
  "media_type","image_url","video_url","poster_url","lat","lng","place_name","country","fun_fact","photo_date","credit","license","license_url","source_url","focus","focus_mobile","in_frame"];
const str = v => { v = String(v ?? "").trim(); return v.endsWith(".0") ? v.slice(0, -2) : v; };
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
const yes = v => v === true || ["yes", "y", "true", "1"].includes(str(v).toLowerCase());
const lowerKeys = r => { const o = {}; for (const k in r) o[String(k).trim().toLowerCase()] = r[k]; return o; };
const handleOf = h => str(h).replace(/^@/, "");
// per-day wording: featured_pronoun "she" (default) or "he" (anything else falls back to "they")
const PRONOUNS = { she: { subj: "she", obj: "her", noun: "woman" }, he: { subj: "he", obj: "him", noun: "man" }, they: { subj: "they", obj: "them", noun: "person" } };
const pronounOf = v => { v = str(v).toLowerCase(); return v === "he" || v === "him" ? "he" : v === "they" || v === "them" ? "they" : "she"; };
const W = p => PRONOUNS[(p && p.featured && p.featured.pronoun) || "she"];
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
// v10 heading: just the day code (+ daily No. on dated days). Never "Who is she?" (only the bottom reminder says that), never the handle.
const dayTitle = p => state.mode === "practice" || !state.dateKey ? p.id : `${p.id} · No. ${pad3(dayNumber(state.dateKey) + 1)}`;
const whereQ = p => { const w = W(p); return `Where ${w.subj === "they" ? "are" : "is"} ${w.subj}?`; };
// focus: where to centre the starting (cropped) view, "x,y" or [x,y] or {x,y} in 0-1 of the media; null = centre
const parseFocus = v => { if (v == null || v === "") return null; let a = Array.isArray(v) ? v : typeof v === "object" ? [v.x, v.y] : String(v).split(/[ ,;]+/);
  const x = parseFloat(a[0]), y = parseFloat(a[1]); return isFinite(x) && isFinite(y) ? [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] : null; };
function parseRows(rows) {
  const by = {}, out = [];
  rows.forEach((raw, i) => {
    const r = lowerKeys(raw), id = str(r.puzzle_id); if (!id) return;
    let p = by[id];
    if (!p) { p = by[id] = { id, order: null, set: "", placeholder: false, featured: null, rounds: [], _i: i }; out.push(p); }
    if (p.order == null && num(r.daily_order) != null) p.order = num(r.daily_order);
    if (yes(r.practice_only)) p.practiceOnly = true;
    if (!p.set && str(r.set)) p.set = str(r.set);
    if (yes(r.placeholder)) p.placeholder = true;
    if (!p.featured && handleOf(r.featured_handle)) {
      const h = handleOf(r.featured_handle);
      p.featured = { name: str(r.featured_name), handle: h, igUrl: str(r.featured_ig_url) || `https://www.instagram.com/${encodeURIComponent(h)}/`, consentOn: str(r.consent_on), pronoun: pronounOf(r.featured_pronoun) };
    }
    const lat = num(r.lat), lng = num(r.lng), media = str(r.media_type).toLowerCase() === "video" ? "video" : "image";
    if (lat == null || lng == null || (media === "video" ? !str(r.video_url) : !str(r.image_url))) return;
    p.rounds.push({ n: num(r.round) ?? p.rounds.length + 1, media, img: str(r.image_url), video: str(r.video_url), poster: str(r.poster_url), lat, lng, place: str(r.place_name), country: str(r.country),
      fact: str(r.fun_fact), credit: str(r.credit), license: str(r.license), licenseUrl: str(r.license_url), sourceUrl: str(r.source_url),
      focus: parseFocus(r.focus), focusMobile: parseFocus(r.focus_mobile) });
  });
  return out.filter(p => {
    p.rounds.sort((a, b) => a.n - b.n);
    if (p.rounds.length !== CONFIG.rounds) { console.warn(`WhereIsShe: ${p.id} has ${p.rounds.length} rounds (needs ${CONFIG.rounds}), skipped`); return false; }
    // Real (non-placeholder) days must have a featured woman with a recorded consent date.
    if (!p.placeholder && !(p.featured && p.featured.consentOn)) { console.warn(`WhereIsShe: ${p.id} has no featured_handle/consent_on, skipped`); return false; }
    return true;
  }).map(p => ({ ...p, order: p.order ?? 10000 + p._i })).sort((a, b) => a.order - b.order);
}

let custom = load(LS.custom, null);
let ALL = parseRows((custom && custom.rows?.length) ? custom.rows : (window.WIS_PUZZLE_ROWS || []));
const dailyPool = () => { const days = ALL.filter(p => !p.practiceOnly), real = days.filter(p => !p.placeholder);   // practice_only days never appear as dailies
  return CONFIG.includePlaceholderDays || !real.length ? days : real; };

// ================================================================ settings + theme
const settings = Object.assign({ theme: "system", sound: false }, load(LS.settings, {}));
const saveSettings = () => save(LS.settings, settings);
const mq = matchMedia("(prefers-color-scheme: dark)");
const effectiveTheme = () => settings.theme === "system" ? (mq.matches ? "dark" : "light") : settings.theme;
function applyTheme() {
  const t = effectiveTheme(); document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
  $("#themeBtn").title = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
}
mq.addEventListener?.("change", () => settings.theme === "system" && applyTheme());

// ================================================================ state
const state = { mode: "daily", dateKey: todayKey(), puzzle: null, practiceIdx: 0, game: null, pin: null, busy: false };
const puzzleForDay = n => { const pool = dailyPool(); return pool[((n % pool.length) + pool.length) % pool.length]; };
// v9: the daily schedule is data (schedule.json -> window.WIS_SCHEDULE, edited with tools/schedule.py): a date pinned in
// "dates" plays that puzzle; any other date falls back to "rotation" (the day after the last pinned date = rotation[0]).
// A custom puzzle file loaded in Settings ignores the schedule and uses the old order-based rotation.
const SCHED = window.WIS_SCHEDULE || null;
if (SCHED && validKey(SCHED.epoch)) CONFIG.dailyEpoch = SCHED.epoch;
function puzzleForDate(key) {
  if (SCHED && !custom) {
    const byId = id => ALL.find(p => p.id === id && !p.practiceOnly);
    const pinned = SCHED.dates && SCHED.dates[key] && byId(SCHED.dates[key]); if (pinned) return pinned;
    const rot = (SCHED.rotation || []).map(byId).filter(Boolean);
    if (rot.length) {
      const keys = Object.keys(SCHED.dates || {}).filter(validKey).sort(), last = keys[keys.length - 1];
      const n = last && utc(key) > utc(last) ? Math.round((utc(key) - utc(last)) / 864e5) - 1 : dayNumber(key);
      return rot[((n % rot.length) + rot.length) % rot.length];
    }
  }
  return puzzleForDay(dayNumber(key));
}
// content hash (FNV-1a) of what a player actually guesses on: media + answer of each round, in order
const puzzleHash = p => { if (p._h) return p._h; let h = 0x811c9dc5; const t = JSON.stringify(p.rounds.map(r => [r.media, r.img, r.video, r.lat, r.lng]));
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return (p._h = h.toString(36)); };
const keyFor = (mode, dateKey, p) => mode === "practice" ? `p:${p.id}@${puzzleHash(p)}` : `d:${dateKey}:${p.id}@${puzzleHash(p)}`;
const resultKey = () => keyFor(state.mode, state.dateKey, state.puzzle);
// preview mode (schedule.html "Play this day"): progress lives only in memory, never in localStorage, stats or streaks
const previewStore = {};
const isPreview = () => state.mode === "preview";
// a saved game is only used if it belongs to exactly this puzzle (id + content hash) and is internally consistent
function validSaved(r, p) {
  if (!r || typeof r !== "object" || r.id !== p.id || r.h !== puzzleHash(p) || !Array.isArray(r.rounds)) return false;
  const n = Math.min(CONFIG.rounds, p.rounds.length);
  if (r.rounds.length > n || !r.rounds.every(x => x && isFinite(x.pts) && isFinite(x.dist) && isFinite(x.lat) && isFinite(x.lng))) return false;
  return !r.done || r.rounds.length === n;
}
function savedFor(key, p) {
  const all = load(LS.results, {}), r = all[key];
  if (r && !validSaved(r, p)) { delete all[key]; save(LS.results, all); return null; }
  return r || null;
}
const getResult = () => isPreview() ? previewStore[resultKey()] || null : savedFor(resultKey(), state.puzzle);
const setResult = r => { if (isPreview()) { previewStore[resultKey()] = { ...r, id: state.puzzle.id }; return; } const all = load(LS.results, {}); all[resultKey()] = { ...r, id: state.puzzle.id, h: puzzleHash(state.puzzle), at: Date.now() }; save(LS.results, all); };
const isToday = () => state.mode === "daily";
function linkHash() { return state.mode === "practice" ? `#p=${encodeURIComponent(state.puzzle.id)}` : isPreview() ? `#preview=${state.dateKey}` : `#d=${state.dateKey}`; }
function setHash(h) { try { history.replaceState(null, "", h || location.pathname + location.search); } catch { location.hash = h; } }
const totalOf = g => g.rounds.reduce((s, r) => s + r.pts, 0);

// ================================================================ map (Leaflet)
let map = null, layer = null, summaryMap = null;
const pinIcon = (cls, label = "") => L.divIcon({ className: "", html: `<div class="pin ${cls}"><span class="pin-lbl">${esc(label)}</span></div>`, iconSize: [22, 22], iconAnchor: [11, 26] });
function tiles(m) { return window.WISTiles(m); }
function ensureMap() {
  if (map || !window.L) return;
  map = L.map("map", { worldCopyJump: true, minZoom: 0, attributionControl: true }).setView([20, 10], 1);
  tiles(map); layer = L.layerGroup().addTo(map);
  map.on("click", e => {
    const g = state.game; if (!g || state.busy || g.rounds.length > g.cur || g.done || dockMode() === "reveal") return;
    const ll = e.latlng.wrap(); state.pin = { lat: ll.lat, lng: ll.lng };
    layer.clearLayers(); L.marker(ll, { icon: pinIcon("you") }).addTo(layer);
    $("#guessBtn").disabled = false; $("#pinNote").textContent = "Pin dropped"; $("#mapHint").classList.add("gone"); $("#dock").classList.add("has-pin");
  });
}
const worldZoom = () => { const w = map.getSize().x; return w > 1000 ? 2 : w > 340 ? 1 : 0; };
function resetMap() {
  if (!map) return; layer.clearLayers(); map.invalidateSize(); map.setView([20, 10], worldZoom(), { animate: false });
}
// ---- map dock: "mini" (corner minimap) | "full" (full-screen overlay) | "reveal" (large result map)
// The same Leaflet map lives in all three, so a dropped pin persists; invalidateSize() after every size change.
const compact = matchMedia("(max-width: 760px)");
const dockMode = () => $("#dock").dataset.mode;
function setDock(mode) {
  const d = $("#dock"); if (d.dataset.mode === mode) return;
  const prev = d.dataset.mode; d.dataset.mode = mode; d.classList.remove("hovering");
  document.documentElement.classList.toggle("map-open", mode !== "mini");
  if (!map) return;
  map.invalidateSize({ pan: false });
  if (mode === "full" && prev === "mini" && !state.pin) map.setView([20, 10], worldZoom(), { animate: false });
  if (mode === "full" && state.pin) map.panTo([state.pin.lat, state.pin.lng], { animate: false });
  if (mode === "full") $("#mapHint").textContent = compact.matches ? "Tap to drop your pin" : "Click to drop your pin";
  setTimeout(() => map.invalidateSize(), 220);
}
const openFullMap = () => { if (dockMode() === "mini" && !state.busy) setDock("full"); };
const closeFullMap = () => { if (dockMode() === "full") { setDock("mini"); if (state.pin) map.panTo([state.pin.lat, state.pin.lng], { animate: false }); } };
function drawReveal(guess, ans, animate = true) {
  if (!map) return; layer.clearLayers();
  const a = L.latLng(ans.lat, ans.lng);
  // draw the guess on the world copy nearest the answer so the line takes the short way round
  let gl = guess.lng; while (gl - ans.lng > 180) gl -= 360; while (ans.lng - gl > 180) gl += 360;
  const g = L.latLng(guess.lat, gl);
  L.polyline([g, a], { color: "#111", weight: 2.5, dashArray: "6 6", opacity: .85 }).addTo(layer);
  L.marker(g, { icon: pinIcon("you") }).addTo(layer);
  L.marker(a, { icon: pinIcon("ans") }).addTo(layer).bindTooltip(esc(ans.place), { direction: "top", offset: [0, -24] });
  map.invalidateSize();
  map.fitBounds(L.latLngBounds([g, a]).pad(0.3), { maxZoom: 8, animate });
}

// ================================================================ rendering
function renderHero() {
  const p = state.puzzle, n = dayNumber(state.dateKey) + 1;
  $("#heroNo").textContent = state.mode === "practice" ? `Practice ${state.practiceIdx + 1}/${ALL.length}` : `No. ${pad3(n)}`;
  $("#heroDate").textContent = state.mode === "practice" ? "Practice mode · doesn't count toward stats"
    : `${CONFIG.brand} #${pad3(n)} · ${longDate(state.dateKey)}${isToday() ? "" : isPreview() ? " · Preview" : " · Archive"}`;
  let bar = $("#previewBar");
  if (isPreview()) {
    if (!bar) { bar = document.createElement("div"); bar.id = "previewBar"; bar.className = "preview-bar"; $("#stage").before(bar); }
    bar.innerHTML = `👀 Preview · No. ${pad3(n)} · ${esc(prettyDate(state.dateKey))} · progress isn't saved <a href="schedule.html">Schedule</a> <a href="#" id="previewExit">Exit</a>`;
    $("#previewExit").onclick = e => { e.preventDefault(); goToday(); };
  } else if (bar) bar.remove();
  const label = isToday() ? "Share today's puzzle" : "Share this puzzle";
  $("#shareChallengeTop").textContent = label + " ↗"; $("#shareChallengeBtn").textContent = label;
}
function renderDots() {
  const g = state.game;
  $("#roundDots").innerHTML = Array.from({ length: CONFIG.rounds }, (_, i) => { const r = g.rounds[i];
    return r ? `<i class="${band(r.dist)[2]}" title="Round ${i + 1}: ${n0(r.pts)} pts"></i>` : `<i class="${i === g.cur ? "cur" : ""}"></i>`; }).join("") +
    `<span>Round ${Math.min(g.cur + 1, CONFIG.rounds)}/${CONFIG.rounds}</span>`;
  $("#running").textContent = `${n0(totalOf(g))} pts`;
}

function openPuzzle(p) {
  state.puzzle = p; state.busy = false; state.pin = null;
  showView("play"); renderHero(); $("#result").classList.add("hidden"); $("#stage").classList.remove("hidden");
  setHash(linkHash());
  const saved = getResult();
  state.game = saved ? { ...saved } : { rounds: [], cur: 0, done: false, adSeen: false };
  ensureMap();
  const g = state.game;
  // Resume only this puzzle's own progress, and always at a playable point: never re-open an old guess's reveal map.
  if (g.done) { g.adSeen = true; showRound(CONFIG.rounds - 1, true); showResults(false); }
  else showRound(g.rounds.length, false);                     // next unguessed round (round 1 on a fresh game)
  window.scrollTo({ top: 0 });
}
function showRound(i, revealed) {
  const p = state.puzzle, g = state.game, r = p.rounds[i]; g.cur = i; state.pin = null;
  $("#heroKind").textContent = `Round ${i + 1} / ${CONFIG.rounds}`;
  $("#question").textContent = dayTitle(p);   // v10: the day code ("she-001 · No. 001"); name/handle only on the Meet card
  document.title = `${p.id} · ${CONFIG.brand}`;
  showMedia(r, i);
  $("#phTag") && $("#phTag").classList.toggle("hidden", !p.placeholder);
  if (p.featured) $("#credit").innerHTML = `<span class="who-hint">${esc(whoHint(p))}</span>`;
  else $("#credit").textContent = `${r.media === "video" ? "Video" : "Photo"} credit is shown after you guess`;
  setDock("mini");
  $("#mapHint").textContent = compact.matches ? "Tap to open the map" : "Click the map to drop your pin";
  $("#mapHint").classList.remove("gone"); $("#pinNote").textContent = "No pin yet";
  $("#guessBtn").disabled = true; $("#dock").classList.remove("has-pin");
  resetMap(); renderDots();
  if (revealed) revealRound(i, false);
}
// ---- per-media view (v5): "smart fill". Each photo/video starts zoomed to fill the stage as far as possible while
// still showing at least 80% of the media's width AND height: start scale = min(cover, contain / 0.8), relative to the
// contained view (scale 1). Any area still uncovered shows the blurred fill. The starting pan centres the round's focus
// point (focus on desktop, focus_mobile on phones/tablets; default centre). Recomputed per viewport on resize/rotate.
// Drag pans (mouse on desktop, one finger on touch); pinch / double-tap zoom on touch (scale 1 = fully contained, max 5).
const MIN_VISIBLE = 0.8;
const wideStage = matchMedia("(min-width:1101px)");
const Zoom = (() => {
  let s = 1, tx = 0, ty = 0, s0 = 1, pts = new Map(), start = null, lastTap = 0, round = null, drag = null;   // lastTap: {t,x,y} of the last clean single tap
  const box = () => $("#media");
  const el = () => { const v = $("#video"); return v && !v.classList.contains("hidden") ? v : $("#photo"); };
  const dims = e => e.tagName === "VIDEO" ? [e.videoWidth, e.videoHeight] : [e.naturalWidth, e.naturalHeight];
  function geom() { const e = el(), bw = e.offsetWidth, bh = e.offsetHeight, [nw0, nh0] = dims(e), nw = nw0 || bw, nh = nh0 || bh, k = Math.min(bw / nw, bh / nh);
    const cw = nw * k, ch = nh * k; return { bw, bh, cw, ch, ox: (bw - cw) / 2, oy: (bh - ch) / 2, ready: !!nw0 }; }
  function clamp() { const g = geom();
    const ax = (bw, c, o, t) => s * c <= bw ? (bw - s * c) / 2 - s * o : Math.min(-s * o, Math.max(bw - s * (o + c), t));
    tx = ax(g.bw, g.cw, g.ox, tx); ty = ax(g.bh, g.ch, g.oy, ty); return g; }
  function apply() {
    if (s < 1.001) s = 1;
    const g = clamp(), e = el(), b = box();
    e.style.transform = s === 1 ? "" : `translate(${tx}px,${ty}px) scale(${s})`;
    const ovx = s * g.cw > g.bw + 1, ovy = s * g.ch > g.bh + 1;
    // let the page scroll along any axis the media doesn't overflow
    b.style.touchAction = ovx && ovy ? "none" : ovx ? "pan-y" : ovy ? "pan-x" : "pan-y";
    b.classList.toggle("pannable", ovx || ovy); b.classList.toggle("zoomed", Math.abs(s - s0) > 0.01);
  }
  // starting view for the current round + viewport
  function begin(r) {
    if (r !== undefined) round = r;
    const e = el(), g = geom(); pts.clear(); start = null; drag = null;
    if (!g.ready || !g.cw || !g.ch) { s = 1; tx = ty = 0; s0 = 1; e.style.transform = ""; return; }
    const cover = Math.max(g.bw / g.cw, g.bh / g.ch);
    s0 = s = Math.max(1, Math.min(cover, 1 / MIN_VISIBLE));
    const f = (round && (wideStage.matches ? round.focus : (round.focusMobile || round.focus))) || [0.5, 0.5];
    tx = g.bw / 2 - s * (g.ox + f[0] * g.cw); ty = g.bh / 2 - s * (g.oy + f[1] * g.ch); apply();
  }
  function zoomAt(ns, px, py) { ns = Math.max(1, Math.min(5, ns)); tx = px - (px - tx) * (ns / s); ty = py - (py - ty) * (ns / s); s = ns; apply(); }
  // coordinates relative to the untransformed media box (transform-origin 0 0)
  const rel = (x, y) => { const b = box().getBoundingClientRect(), e = el(); return { x: x - b.left - e.offsetLeft, y: y - b.top - e.offsetTop }; };
  function down(e) {
    if (e.pointerType === "mouse") { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false }; box().setPointerCapture?.(e.pointerId); box().classList.add("dragging"); e.preventDefault(); return; }
    if (e.pointerType !== "touch") return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; start = { d: Math.hypot(a.x - b.x, a.y - b.y), s, tx, ty, m: rel((a.x + b.x) / 2, (a.y + b.y) / 2) }; }
    else if (pts.size === 1) { start = { pan: true, x: e.clientX, y: e.clientY, tx, ty, t: Date.now(), moved: 0, multi: false };
      // double-tap = a second quick tap right after a clean single tap (not after a pinch or a drag)
      if (lastTap && Date.now() - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) { const p = rel(e.clientX, e.clientY); dbl(p.x, p.y); lastTap = 0; start.multi = true; } } }
  function dbl(x, y) { if (Math.abs(s - s0) > 0.01) begin(); else zoomAt(Math.max(2.5, s0 * 2), x, y); }
  function move(e) {
    if (drag && e.pointerType === "mouse") { tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; drag.moved = true; apply(); return; }
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2 && start && start.d) { e.preventDefault(); start.multi = true; const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), m = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
      const ns = Math.max(1, Math.min(5, start.s * d / start.d)); tx = m.x - (start.m.x - start.tx) * (ns / start.s); ty = m.y - (start.m.y - start.ty) * (ns / start.s); s = ns; apply(); }
    else if (pts.size === 1 && start && start.pan) { e.preventDefault(); start.moved = Math.max(start.moved, Math.hypot(e.clientX - start.x, e.clientY - start.y)); tx = start.tx + e.clientX - start.x; ty = start.ty + e.clientY - start.y; apply(); } }
  function up(e) {
    if (e.pointerType === "mouse") { drag = null; box().classList.remove("dragging"); return; }
    const was = start; pts.delete(e.pointerId);
    if (pts.size === 1) { const [a] = [...pts.values()]; start = { pan: true, x: a.x, y: a.y, tx, ty, t: 0, moved: 99, multi: true }; }
    else if (!pts.size) { lastTap = was && was.pan && !was.multi && was.moved < 10 && Date.now() - was.t < 300 ? { t: Date.now(), x: e.clientX, y: e.clientY } : 0; start = null; } }
  function attach() { const b = box(); b.addEventListener("pointerdown", down); b.addEventListener("pointermove", move, { passive: false });
    ["pointerup", "pointercancel"].forEach(t => b.addEventListener(t, up));
    b.addEventListener("pointerleave", e => { if (e.pointerType !== "mouse") up(e); });
    b.addEventListener("dblclick", e => { const p = rel(e.clientX, e.clientY); dbl(p.x, p.y); });
    // iOS Safari: stop its page-level pinch while a pinch is on the media
    b.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    ["gesturestart", "gesturechange"].forEach(t => b.addEventListener(t, e => e.preventDefault()));
    b.addEventListener("dragstart", e => e.preventDefault());
    return true; }
  return { attach, begin, setRound(r) { round = r; }, reset() { s = 1; tx = ty = 0; s0 = 1; pts.clear(); start = null; drag = null; ["#photo", "#video"].forEach(q => { const e = $(q); if (e) e.style.transform = ""; }); },
           state: () => ({ s, tx, ty, s0 }), zoomAt: (ns, x, y) => zoomAt(ns, x, y), geom, attached: false };
})();
Zoom.attached = Zoom.attach();
function fitMedia() {
  const m = $("#media"), vid = $("#video"), img = $("#photo"), isVid = !vid.classList.contains("hidden");
  const nw = isVid ? vid.videoWidth : img.naturalWidth, nh = isVid ? vid.videoHeight : img.naturalHeight;
  if (!nw || !nh) return;
  m.dataset.orient = nw / nh > 1.1 ? "landscape" : nw / nh < 0.9 ? "portrait" : "square"; m.dataset.fit = "smart";
  Zoom.begin();
}
wideStage.addEventListener ? wideStage.addEventListener("change", fitMedia) : 0;
let _rz = 0; window.addEventListener("resize", () => { clearTimeout(_rz); _rz = setTimeout(fitMedia, 120); });

// ---- media: photo or looping muted video (autoplay needs muted + playsinline on iOS/Android)
// v10 video loading: visible "Loading clip…" state, automatic retry on error/stall (cache-busted), a tap-to-play fallback
// when the browser refuses autoplay (e.g. iOS Low Power Mode), and the next round's clip is preloaded in the background.
const VS = { round: -1, url: "", tries: 0, state: "idle", timer: 0, lastT: -1, lastAt: 0, log: [] };
function vidOverlay(kind, text) {
  const o = $("#vidLoading"); if (!o) return;
  VS.state = kind; o.dataset.state = kind; o.classList.toggle("hidden", kind === "playing" || kind === "idle");
  o.querySelector(".vl-text").textContent = text || "";
  o.querySelector(".vl-btn").classList.toggle("hidden", !(kind === "error" || kind === "tap" || kind === "slow"));
  o.querySelector(".vl-btn").textContent = kind === "tap" ? "▶ Tap to play" : "↻ Retry";
  o.querySelector(".vl-spin").classList.toggle("hidden", !(kind === "loading" || kind === "slow"));
}
function vidLoad(r, retry) {
  const vid = $("#video"); clearInterval(VS.timer);
  VS.url = retry ? `${r.video}${r.video.includes("?") ? "&" : "?"}retry=${VS.tries}-${Date.now() % 1e6}` : r.video;   // cache-busted retry
  VS.log.push((retry ? "retry " : "load ") + VS.url);
  vid.src = VS.url; vid.load(); vidOverlay("loading", "Loading clip…");
  VS.lastT = -1; VS.lastAt = Date.now();
  VS.timer = setInterval(() => {   // stall watchdog: no playback progress while the clip is still loading
    if (vid.classList.contains("hidden")) return clearInterval(VS.timer);
    if (!vid.paused && vid.currentTime !== VS.lastT) { VS.lastT = vid.currentTime; VS.lastAt = Date.now(); return; }
    if (VS.state === "tap" || VS.state === "error") return;
    const idle = Date.now() - VS.lastAt;
    if (vid.readyState < 3 && idle > CONFIG.videoStallMs) vidFail("stall");
    else if (vid.readyState < 3 && idle > 3500 && VS.state === "loading") vidOverlay("slow", "Still loading… clips can take a few seconds on slow connections");
  }, 500);
  vidPlay();
}
function vidFail(why) {
  const r = state.puzzle && state.puzzle.rounds[VS.round]; if (!r || r.media !== "video") return;
  VS.log.push("fail " + why);
  if (VS.tries < CONFIG.videoRetries) {
    VS.tries++; vidOverlay("loading", `Reconnecting… (try ${VS.tries + 1})`); clearInterval(VS.timer);
    const at = VS.round; setTimeout(() => { if (VS.round === at && !$("#video").classList.contains("hidden")) vidLoad(r, true); }, 700 * VS.tries);
  } else { clearInterval(VS.timer); vidOverlay("error", "This clip didn't load. Check your connection and tap Retry, or guess from the poster."); }
}
function vidPlay() {
  const vid = $("#video"), pr = vid.play();
  if (pr && pr.catch) pr.catch(err => {
    if (err && err.name === "AbortError") return;                        // a newer load() replaced this one: not a failure
    if (!vid.muted) { vid.muted = true; setMuteLabel(); pulseMute(); return vidPlay(); }   // sound refused without a gesture
    if (err && err.name === "NotAllowedError") vidOverlay("tap", "Tap to play the clip");   // even muted autoplay refused
  });
}
function preloadNext(i) {   // warm the next video round's clip (and the next posters/photos) while this round is played
  const rs = state.puzzle.rounds, n = rs.slice(i + 1).find(x => x.media === "video");
  rs.slice(i + 1, i + 3).forEach(x => { const im = new Image(); im.src = x.media === "video" ? x.poster : x.img; });
  if (!n || (preloadNext.el && preloadNext.el.dataset.src === n.video)) return;
  const v = preloadNext.el || (preloadNext.el = Object.assign(document.createElement("video"), { muted: true, preload: "auto", playsInline: true }));
  v.dataset.src = n.video; v.src = n.video; v.load();
}
function showMedia(r, i) {
  const img = $("#photo"), vid = $("#video"), mute = $("#muteBtn"), isVid = r.media === "video";
  Zoom.reset(); Zoom.setRound(r); $("#media").classList.add("zoomable");
  img.classList.toggle("hidden", isVid); vid.classList.toggle("hidden", !isVid); mute.classList.toggle("hidden", !isVid); $("#zoomBtn").classList.toggle("hidden", isVid);
  VS.round = i; VS.tries = 0;
  if (isVid) {
    img.removeAttribute("src");
    // sound follows the player's choice (welcome card / sound pill = settings.sound); falls back to muted if refused
    vid.defaultMuted = true; vid.setAttribute("muted", ""); vid.muted = !settings.sound; vid.loop = true; vid.playsInline = true; vid.autoplay = true;
    if (r.poster) vid.poster = r.poster; else vid.removeAttribute("poster");
    vid.setAttribute("aria-label", `${whereQ(state.puzzle)} Round ${i + 1} video`);
    $("#media").style.setProperty("--media-bg", r.poster ? `url("${r.poster}")` : "none");
    vid.onloadedmetadata = fitMedia;
    vid.onplaying = () => { VS.lastAt = Date.now(); vidOverlay("playing"); };
    vid.onwaiting = () => { if (VS.state === "playing") vidOverlay("loading", "Loading clip…"); };
    vid.onerror = () => vidFail("error " + (vid.error ? vid.error.code : "?"));
    const same = vid.getAttribute("src") && vid.getAttribute("src").split("?")[0] === r.video && !vid.error;
    if (!same) vidLoad(r, false); else { fitMedia(); if (vid.paused) vidPlay(); vidOverlay(vid.paused ? "loading" : "playing", "Loading clip…"); }
    setMuteLabel(); pulseMute();
  } else {
    clearInterval(VS.timer); vidOverlay("idle");
    vid.onerror = vid.onplaying = vid.onwaiting = null;
    if (!vid.paused) vid.pause(); vid.removeAttribute("src"); vid.removeAttribute("poster"); vid.load();
    img.classList.add("loading"); img.onload = () => { img.classList.remove("loading"); fitMedia(); }; img.src = r.img; img.alt = `${whereQ(state.puzzle)} Round ${i + 1} photo`;
    $("#media").style.setProperty("--media-bg", `url("${r.img}")`);   // blurred fill behind the contain-fit photo
  }
  setTimeout(() => preloadNext(i), 1200);
}
function setMuteLabel() {
  const v = $("#video"), b = $("#muteBtn");
  b.innerHTML = v.muted ? `<span class="mi" aria-hidden="true">🔇</span><span class="mt">Tap for sound</span>` : `<span class="mi" aria-hidden="true">🔊</span><span class="mt">Sound on</span>`;
  b.setAttribute("aria-pressed", String(!v.muted)); b.setAttribute("aria-label", v.muted ? "Sound off. Tap for sound" : "Sound on. Tap to mute");
  b.classList.toggle("on", !v.muted);
}
// a brief pulse when a muted video round starts, so the control is noticed
function pulseMute() { const b = $("#muteBtn"); b.classList.remove("pulse"); if (!$("#video").muted) return; void b.offsetWidth; b.classList.add("pulse"); }
function toggleMute() {
  const v = $("#video"); v.muted = !v.muted; settings.sound = !v.muted; saveSettings();   // remembered across rounds and days
  if (v.paused) v.play().catch(() => {}); $("#muteBtn").classList.remove("pulse"); setMuteLabel();
}

function submitGuess() {
  const p = state.puzzle, g = state.game; if (!state.pin || state.busy || g.rounds.length > g.cur) return;
  const r = p.rounds[g.cur], dist = haversineKm(state.pin, r), pts = scoreFor(dist);
  g.rounds.push({ lat: +state.pin.lat.toFixed(5), lng: +state.pin.lng.toFixed(5), dist: +dist.toFixed(3), pts });
  if (g.rounds.length === CONFIG.rounds) {
    g.done = true; g.total = totalOf(g); g.emoji = g.rounds.map(x => band(x.dist)[1]).join("");
    if (isToday()) recordStats(g);
    if (!isPreview()) CommunityStats.submit({ puzzleId: p.id, day: state.dateKey, mode: state.mode, total: g.total, rounds: g.rounds });
  }
  setResult(g); revealRound(g.cur, true);
}
function revealRound(i, animate) {
  const p = state.puzzle, g = state.game, r = p.rounds[i], gr = g.rounds[i];
  setDock("reveal");
  drawReveal(gr, r, animate);
  $("#rvPoints").textContent = n0(gr.pts);
  $("#rvDist").textContent = `${band(gr.dist)[1]} ${fmtKm(gr.dist)} away`;
  const perfect = $("#rvPerfect"); perfect.textContent = `Perfect! within ${CONFIG.fullScoreRadiusKm} km`; perfect.classList.toggle("hidden", !isPerfect(gr.dist));
  $("#rvPlace").textContent = `📍 ${r.place}${r.country ? ", " + r.country : ""}`;
  $("#rvFact").innerHTML = r.fact ? `<b>Fun fact:</b> ${esc(r.fact)}` : "";
  // Featured days: no handle / IG link until the Meet her card after round 5
  $("#credit").innerHTML = $("#rvCredit").innerHTML = state.puzzle.featured
    ? `${r.media === "video" ? "Video" : "Photo"} used with permission · <span class="who-hint">${esc(whoHint(state.puzzle))}</span>` : creditHtml(r);
  $("#mapHint").classList.add("gone");
  const nb = $("#nextRoundBtn");
  nb.textContent = i + 1 >= CONFIG.rounds ? "See results →" : "Next round →";
  renderDots(); if (animate) nb.focus({ preventScroll: true });
}
const creditHtml = r => `${r.media === "video" ? "Video" : "Photo"}: ${r.sourceUrl ? `<a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">${esc(r.credit || "source")}</a>` : esc(r.credit || "unknown")}` +
  (r.license ? ` · ${r.licenseUrl ? `<a href="${esc(r.licenseUrl)}" target="_blank" rel="noopener">${esc(r.license)}</a>` : esc(r.license)}` : "");
function nextRound() {
  const g = state.game; if (state.busy) return;
  if (g.cur + 1 < CONFIG.rounds) { showRound(g.cur + 1, false); $("#stage").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  // after guess 5: interstitial ad, THEN results (daily included)
  const finish = () => { g.adSeen = true; setResult(g); showResults(true); };
  if (CONFIG.interstitialBeforeResults && !g.adSeen) showInterstitial(finish); else finish();
}

// ================================================================ interstitial
function showInterstitial(done) {
  const ov = $("#interstitial"), btn = $("#skipAd"); let s = CONFIG.interstitialSeconds; state.busy = true;
  ov.classList.remove("hidden"); btn.disabled = true; btn.textContent = `Skip in ${s}`;
  // ADSENSE / GAM: request + render the interstitial creative here.
  const t = setInterval(() => { s--; if (s <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = "See results ✕"; } else btn.textContent = `Skip in ${s}`; }, 1000);
  btn.onclick = () => { if (btn.disabled) return; clearInterval(t); ov.classList.add("hidden"); state.busy = false; done(); };
}

// ================================================================ results
function titleFor(t) { const f = t / maxTotal(); return f >= .9 ? "World-class tracker 🌍" : f >= .7 ? "Great eye! 👀" : f >= .45 ? "Solid trip ✈️" : f >= .2 ? "Scenic route 🗺️" : "Lost in transit 😅"; }
function showResults(scroll) {
  const p = state.puzzle, g = state.game, t = totalOf(g);
  setDock("mini"); $("#stage").classList.add("hidden");   // results replace the play area
  $("#scoreBig").innerHTML = `<span>${n0(t)}<br><small>/ ${n0(maxTotal())}</small></span>`;
  $("#scoreTitle").textContent = titleFor(t);
  $("#emojiRow").textContent = g.rounds.map(x => band(x.dist)[1]).join("");
  $("#roundList").innerHTML = p.rounds.map((r, i) => { const x = g.rounds[i];
    return `<div class="rrow"><span class="re">${band(x.dist)[1]}</span><span class="rp">${i + 1}. ${esc(r.place)}<small>${esc(r.country)} · ${fmtKm(x.dist)} away</small></span>
      <span class="rs">${n0(x.pts)}<small>pts</small></span>${r.fact ? `<span class="rf">${esc(r.fact)}</span>` : ""}</div>`; }).join("");
  renderMeetHer(p);
  $("#nextBtn").textContent = state.mode === "practice" ? "Next puzzle →" : state.mode === "archive" ? "Back to archive →" : isPreview() ? "Back to schedule →" : "More puzzles →";
  renderCommunity(p, t);
  $("#result").classList.remove("hidden");
  drawSummary(p, g);
  if (scroll) setTimeout(() => $("#result").scrollIntoView({ behavior: "smooth", block: "start" }), 80);
}
function renderMeetHer(p) {
  const box = $("#meetHer"), f = p.featured, w = W(p);
  if (f) {
    box.innerHTML = `<div class="mh-k">Meet ${w.obj}</div><div class="mh-row"><div class="mh-av">${esc((f.name || f.handle).slice(0, 1).toUpperCase())}</div>
      <div><div class="mh-name">${esc(f.name || "@" + f.handle)}</div><div class="mh-handle">@${esc(f.handle)}</div></div>
      <a class="pill-btn primary mh-btn" id="meetHerLink" href="${esc(f.igUrl)}" target="_blank" rel="noopener">Instagram ↗</a></div>
      <p class="mh-note">Featured with ${w.subj === "she" ? "her" : w.subj === "he" ? "his" : "their"} consent${f.consentOn ? ` (opted in ${esc(f.consentOn)})` : ""}. We never pin a home address.</p>`;
  } else {
    box.innerHTML = `<div class="mh-k">Meet ${w.obj}</div><p class="mh-note">No featured ${w.noun} is linked to this day.</p><a class="link-btn" href="#optin">Want to be featured? Opt in →</a>`;
  }
}
function drawSummary(p, g) {
  if (!window.L) return;
  if (!summaryMap) { summaryMap = L.map("summaryMap", { worldCopyJump: true, minZoom: 1, zoomSnap: 0.5, scrollWheelZoom: false }); tiles(summaryMap); summaryMap._grp = L.layerGroup().addTo(summaryMap); }
  const grp = summaryMap._grp; grp.clearLayers(); const pts = [];
  p.rounds.forEach((r, i) => { const x = g.rounds[i]; let gl = x.lng; while (gl - r.lng > 180) gl -= 360; while (r.lng - gl > 180) gl += 360;
    const a = L.latLng(r.lat, r.lng), b = L.latLng(x.lat, gl); pts.push(a, b);
    L.polyline([b, a], { color: "#111", weight: 2, dashArray: "5 5", opacity: .7 }).addTo(grp);
    L.marker(b, { icon: pinIcon("you", i + 1) }).addTo(grp); L.marker(a, { icon: pinIcon("ans", i + 1) }).addTo(grp).bindTooltip(esc(r.place)); });
  setTimeout(() => { summaryMap.invalidateSize(); summaryMap.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 5, animate: false }); }, 60);
}
async function renderCommunity(p, total) {
  const body = $("#communityBody"), badge = $("#communityBadge");
  let data = null; try { data = await CommunityStats.fetch(p.id, state.dateKey); } catch {}
  if (data) { badge.textContent = `${data.players.toLocaleString()} players`; body.textContent = `You beat ${data.pctBeaten}% of players.`; return; } // TODO: richer render
  badge.textContent = "Coming soon";
  body.innerHTML = `No player data yet. This prototype has no backend; once one is connected this shows what % of players you beat and the average per round.` +
    ["Round 1", "Round 2", "Round 3", "Round 4", "Round 5"].map(n => `<div class="crow" aria-hidden="true"><span class="cn">${n}</span><span class="cb"><i style="width:0"></i></span><span class="cp">–</span></div>`).join("");
}

// ================================================================ stats (today's daily only)
function recordStats(g) {
  const s = load(LS.stats, { played: 0, sum: 0, best: 0, streak: 0, bestStreak: 0, lastDay: null, dist: {} });
  const dn = dayNumber(state.dateKey); if (s.lastDay === dn) return;
  s.streak = s.lastDay === dn - 1 ? s.streak + 1 : 1; s.bestStreak = Math.max(s.bestStreak || 0, s.streak); s.lastDay = dn; s.played++;
  s.sum += g.total; s.best = Math.max(s.best, g.total);
  const k = g.total >= 20000 ? "20k–25k" : g.total >= 15000 ? "15k–20k" : g.total >= 10000 ? "10k–15k" : g.total >= 5000 ? "5k–10k" : "0–5k";
  s.dist[k] = (s.dist[k] || 0) + 1; save(LS.stats, s);
}
function currentStreak() { const s = load(LS.stats, null); if (!s) return 0; const dn = dayNumber(todayKey()); return (s.lastDay === dn || s.lastDay === dn - 1) ? s.streak : 0; }

// ================================================================ sharing
function shareUrl() { return CONFIG.siteUrl.replace(/#.*$/, "") + linkHash(); }
function shareTitle() { return state.mode === "practice" ? `${CONFIG.brand} practice` : `${CONFIG.brand} #${pad3(dayNumber(state.dateKey) + 1)}`; }
function challengeText() { return `${shareTitle()} 📍\nFive photos. One ${W(state.puzzle).noun}. ${whereQ(state.puzzle).replace("Where ", "Where in the world ")}\n${shareUrl()}`; }
function resultText() {
  const g = getResult(); if (!g || !g.done) return "";
  return `${shareTitle()} 📍 ${n0(totalOf(g))}/${n0(maxTotal())}\n${g.rounds.map(x => band(x.dist)[1]).join("")}\n${shareUrl()}`;
}
async function doShare(text) {
  if (!text) return; window.__lastShare = text;
  if (navigator.share && matchMedia("(pointer:coarse)").matches) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(text); toast("Copied to clipboard!"); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied to clipboard!"); } catch { prompt("Copy this:", text); } ta.remove(); }
}

// ================================================================ views / navigation
function showView(v) {
  $("#playView").classList.toggle("hidden", v !== "play"); $("#archiveView").classList.toggle("hidden", v !== "archive"); $("#optinView").classList.toggle("hidden", v !== "optin");
  const tab = v === "optin" ? "" : v === "archive" ? "archive" : state.mode === "practice" ? "practice" : state.mode === "archive" ? "archive" : "today";
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === tab));
  if (v !== "play") setDock("mini");      // never leave a fixed map overlay on top of another view
  if (v === "play" && map) setTimeout(() => map.invalidateSize(), 0);
}
function goToday() { state.mode = "daily"; state.dateKey = todayKey(); openPuzzle(puzzleForDate(state.dateKey)); }
function goPreview(key) {   // any date, past or future; nothing is written to storage
  if (!validKey(key) || dayNumber(key) < 0) { toast("No such day"); return goToday(); }
  state.mode = "preview"; state.dateKey = key; openPuzzle(puzzleForDate(key));
}
function goDate(key) {
  const today = todayKey();
  if (!validKey(key) || dayNumber(key) < 0) { toast("That puzzle doesn't exist"); return goToday(); }
  if (utc(key) > utc(today)) { toast("That puzzle isn't out yet 👀"); return goToday(); }   // never expose future dailies
  if (key === today) return goToday();
  state.mode = "archive"; state.dateKey = key; openPuzzle(puzzleForDate(key));
}
function goPractice(idx) {
  state.mode = "practice";
  if (idx == null) idx = (dayNumber(todayKey()) + 1) % ALL.length;
  state.practiceIdx = ((idx % ALL.length) + ALL.length) % ALL.length; openPuzzle(ALL[state.practiceIdx]);
}
const whoHint = p => `Who ${W(p).subj === "they" ? "are" : "is"} ${W(p).subj}? Find out after the game.`;   // in-game reminder (handle only on the Meet card)
const dayLabel = p => p.featured ? `Featured day · ${whoHint(p)}` : "Custom day";
function goArchive() {
  showView("archive"); setHash("#archive");
  const today = todayKey(), last = dayNumber(today), rows = [];
  for (let n = last; n >= 0; n--) {          // only today and earlier; future dailies are never listed
    const key = keyFromDay(n), p = puzzleForDate(key), mine = savedFor(keyFor("archive", key, p), p);
    const badge = mine && mine.done ? `<span class="ar done">${n0(mine.total ?? totalOf(mine))}</span>` : mine && mine.rounds?.length ? `<span class="ar">${mine.rounds.length}/5</span>` : `<span class="ar">Play →</span>`;
    rows.push(`<li><button class="arch ${n === last ? "today" : ""}" data-key="${key}" data-id="${esc(p.id)}"><span class="an">#${pad3(n + 1)}<small>${n === last ? "Today" : prettyDate(key).replace(/, \d{4}$/, "")}</small></span>
      <span class="aq">📍 ${esc(p.id)}<small>${esc(dayLabel(p))}</small></span>${badge}</button></li>`);
  }
  $("#archiveList").innerHTML = rows.join("");
  $$(".arch").forEach(b => b.onclick = () => goDate(b.dataset.key));
  window.scrollTo({ top: 0 });
}
function next() { if (state.mode === "practice") goPractice(state.practiceIdx + 1); else if (state.mode === "archive") goArchive(); else if (isPreview()) location.href = "schedule.html"; else goPractice(); }

// ================================================================ opt-in ("Feature me") + removal
function goOptin() { showView("optin"); setHash("#optin"); window.scrollTo({ top: 0 }); }
const mailto = (subject, body) => `mailto:${CONFIG.contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
async function postOrMail(endpoint, payload, subject, body) {
  window.__lastSubmission = { endpoint, payload, mailto: mailto(subject, body) };
  if (endpoint) {
    try { const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (res.ok) return "posted"; } catch {}
  }
  if (!window.__noMailto) location.href = mailto(subject, body);   // fallback: pre-filled email
  return "mailto";
}
async function submitOptin(e) {
  e.preventDefault();
  const f = e.target, handle = handleOf(f.handle.value), email = f.email.value.trim(), msg = $("#optinMsg");
  const errs = [];
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) errs.push("a valid Instagram handle");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push("a valid email");
  if (!f.isMe.checked) errs.push("confirmation that you're the person in the photos and consent to their use");
  if (!f.adult.checked) errs.push("confirmation that you're 18 or older");
  if (!f.removal.checked) errs.push("acknowledgement of the removal right");
  if (errs.length) { msg.className = "form-msg bad"; msg.textContent = "Please add " + errs.join(", ") + "."; return; }
  const payload = { handle, email, ig_url: `https://www.instagram.com/${handle}/`, consent_photos: true, adult: true, removal_ack: true,
    note: f.note.value.trim(), submitted_at: new Date().toISOString(), consent_text: $("#consentText").textContent.trim() };
  const how = await postOrMail(CONFIG.optinEndpoint, payload, `WhereIsShe opt-in: @${handle}`,
    `Please feature me on WhereIsShe.\n\nInstagram: @${handle}\nEmail: ${email}\n\n✔ I am the person in the photos and consent to them being used in the game.\n✔ I am 18 or older.\n✔ I understand I can have my photos removed at any time.\n\nNote: ${payload.note || "-"}\n\nSubmitted ${payload.submitted_at}`);
  msg.className = "form-msg good";
  msg.textContent = how === "posted" ? "Thanks! We got your request and will email you before anything goes live." : "Thanks! Your email app should open with your request filled in. Hit send to finish.";
  f.reset();
}
function removalModal() {
  openModal(`<h2>Remove my photos</h2><p style="color:var(--muted);font-size:14px">Featured on WhereIsShe and want out? We'll take your photos and profile link down, no questions asked.</p>
    <form id="removeForm" class="optin-form" novalidate>
      <label>Instagram handle<input name="handle" placeholder="@yourhandle" autocomplete="off"></label>
      <label>Email<input name="email" type="email" placeholder="you@example.com"></label>
      <button class="pill-btn primary" type="submit">Request removal</button><p class="form-msg" id="removeMsg"></p></form>`);
  $("#removeForm").onsubmit = async e => {
    e.preventDefault(); const f = e.target, handle = handleOf(f.handle.value), email = f.email.value.trim();
    if (!handle && !email) { $("#removeMsg").className = "form-msg bad"; $("#removeMsg").textContent = "Add your handle or email."; return; }
    const how = await postOrMail(CONFIG.removalEndpoint, { handle, email, requested_at: new Date().toISOString() }, `WhereIsShe removal: @${handle}`,
      `Please remove my photos and profile link from WhereIsShe.\n\nInstagram: @${handle}\nEmail: ${email}`);
    $("#removeMsg").className = "form-msg good"; $("#removeMsg").textContent = how === "posted" ? "Done. We'll confirm by email." : "Your email app should open with the request filled in. Hit send.";
  };
}

// ================================================================ modals
function openModal(html) { $("#modalBody").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
function statsModal() {
  const s = load(LS.stats, { played: 0, sum: 0, best: 0, dist: {} });
  const order = ["20k–25k", "15k–20k", "10k–15k", "5k–10k", "0–5k"];
  const dist = s.played ? order.map(k => { const v = s.dist?.[k] || 0; return `<div class="crow"><span class="cn">${k}</span><span class="cb"><i style="width:${v / Math.max(1, s.played) * 100}%"></i></span><span class="cp">${v}</span></div>`; }).join("")
    : "<p style='color:var(--muted)'>Play today's puzzle to start your stats.</p>";
  openModal(`<h2>Your stats</h2><div class="stat-grid"><div><b>${s.played}</b><span>Played</span></div><div><b>${s.played ? n0(s.sum / s.played) : "–"}</b><span>Average</span></div><div><b>${currentStreak()}</b><span>Streak</span></div><div><b>${s.best ? n0(s.best) : "–"}</b><span>Best</span></div></div>
    <h3>Daily scores</h3>${dist}<p style="font-size:12px;color:var(--muted)">Only today's daily counts. Stats live in this browser (localStorage).</p>`);
}
function menuModal() {
  openModal(`<h2>Menu</h2><div class="menu-list">
    <button id="mArchive">🗓 Archive<small>Every past daily</small></button>
    <button id="mList">🗂 All puzzles (practice)<small>Pick any day to play</small></button>
    <button id="mOptin">💌 Feature me<small>Opt in to be a future "She"</small></button>
    <button id="mSettings">⚙️ Settings<small>Theme, load a puzzle file</small></button>
    <button id="mHow">❓ How to play</button>
    <button id="mAbout">📚 About &amp; photo credits</button>
    <button id="mClear">🧹 Clear my game data<small>Progress, scores, streak and settings in this browser</small></button></div>`);
  $("#mArchive").onclick = () => { closeModal(); goArchive(); }; $("#mList").onclick = listModal; $("#mSettings").onclick = settingsModal;
  $("#mHow").onclick = howModal; $("#mAbout").onclick = aboutModal; $("#mOptin").onclick = () => { closeModal(); goOptin(); };
  $("#mClear").onclick = clearDataModal;
}
// "Clear my game data": confirm, then drop every WhereIsShe key from this browser (the marking tool's wis.mark.* is a
// separate page and is kept), and reload from a clean URL so the app starts fresh on today's daily.
// ---- v10 first-visit welcome card (sound default) + future cross-promo (disabled by CONFIG.crossPromo.enabled)
function countVisit() {   // one per browser session (reloads in the same tab don't count)
  try { if (sessionStorage.getItem("wis.visitCounted")) return load(LS.visits, 0); sessionStorage.setItem("wis.visitCounted", "1"); } catch {}
  const n = (+load(LS.visits, 0) || 0) + 1; save(LS.visits, n); return n;
}
const welcomeDone = () => !!load(LS.welcome, null);
function showWelcome() {
  const p = state.puzzle || ALL[0], sj = W(p).subj;
  $("#welSub").innerHTML = `Every day, 5 photos and clips of someone somewhere on Earth.<br>Look for clues and guess where ${esc(sj)} ${sj === "they" ? "are" : "is"}!`;
  $("#welcome").classList.remove("hidden"); document.body.classList.add("welcome-open"); setTimeout(() => $("#welSoundOn").focus(), 50);
}
function chooseSound(choice) {   // a click = user gesture, so unmuted playback of the first clip is allowed right here
  settings.sound = choice === "on"; saveSettings(); save(LS.welcome, { choice, at: Date.now() });
  $("#welcome").classList.add("hidden"); document.body.classList.remove("welcome-open");
  const v = $("#video");
  if (!v.classList.contains("hidden")) { v.muted = !settings.sound; setMuteLabel(); pulseMute(); vidPlay(); }
}
const promoCfg = () => Object.assign({}, CONFIG.crossPromo, window.__WIS_PROMO_TEST__ || {});   // test override only
function crossPromoCheck() {   // why the cross-promo would or wouldn't show (test hook)
  const c = promoCfg();
  if (!c.enabled) return "disabled";
  if (!c.url) return "no url";
  if (isPreview()) return "preview";
  if (!welcomeDone()) return "first visit";
  if (load(LS.promo, null)) return "already shown";
  if ((+load(LS.visits, 0) || 0) < (c.minVisit || 2)) return "too early";
  return "show";
}
function maybeCrossPromo() {
  if (crossPromoCheck() !== "show") return;
  const c = promoCfg(); save(LS.promo, { at: Date.now() });
  openModal(`<div class="promo"><div class="promo-emoji">🏆</div><h2>Try ${esc(c.title)}</h2><p>${esc(c.blurb || "")}</p>
    <a class="pill-btn primary" id="promoGo" href="${esc(c.url)}" target="_blank" rel="noopener">Play ${esc(c.title)} →</a>
    <button class="link-btn" id="promoLater">Not now</button></div>`);
  $("#promoLater").onclick = closeModal;
}
function wisKeys(store) { const out = []; try { for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k && k.startsWith("wis.") && !k.startsWith("wis.mark.")) out.push(k); } } catch {} return out; }
function clearGameData() {
  [localStorage, sessionStorage].forEach(st => { try { wisKeys(st).forEach(k => st.removeItem(k)); } catch {} });
  location.replace(location.pathname + "?cleared=" + Date.now());
}
function clearDataModal() {
  openModal(`<h2>Clear my game data?</h2>
    <p>This removes your WhereIsShe progress, scores, streak, stats and settings from this browser. It can't be undone.</p>
    <div class="confirm-row"><button class="pill-btn" id="clearCancel">Cancel</button><button class="pill-btn primary danger" id="clearConfirm">Clear data</button></div>`);
  $("#clearCancel").onclick = closeModal; $("#clearConfirm").onclick = clearGameData;
}
function settingsModal() {
  const seg = (name, opts, cur) => `<div class="seg" data-set="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${cur === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
  openModal(`<h2>Settings</h2>
    <h3>Theme</h3>${seg("theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]], settings.theme)}
    <h3>Puzzles</h3><div class="menu-list">
    <button id="mLoad">📄 Load puzzle file<small>puzzles.json, a CSV with the same columns, or an .xlsx</small></button>
    ${custom ? `<button id="mReset">↩️ Back to built-in puzzles<small>Using: ${esc(custom.name)} (${ALL.length} days)</small></button>` : ""}</div>`);
  $$(".seg").forEach(sg => sg.querySelectorAll("button").forEach(b => b.onclick = () => {
    settings[sg.dataset.set] = b.dataset.v; saveSettings(); sg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); applyTheme();
  }));
  $("#mLoad").onclick = () => $("#fileInput").click();
  if ($("#mReset")) $("#mReset").onclick = () => { localStorage.removeItem(LS.custom); custom = null; ALL = parseRows(window.WIS_PUZZLE_ROWS || []); closeModal(); toast("Built-in puzzles restored"); goToday(); };
}
function listModal() {
  openModal(`<h2>All puzzles (${ALL.length})</h2><div class="plist">${ALL.map((p, i) => { const r = savedFor(keyFor("practice", null, p), p);
    return `<button data-i="${i}"><span>📍 ${esc(p.id)} · ${esc(dayLabel(p))}</span><span class="done">${r && r.done ? n0(totalOf(r)) : ""}</span></button>`; }).join("")}</div>`);
  $$(".plist button").forEach(b => b.onclick = () => { closeModal(); goPractice(+b.dataset.i); });
}
function howModal() {
  openModal(`<h2>How to play</h2>
   <p>Every day there are <b>5 photos</b> of the same person somewhere in the world. For each one, tap the map to drop your pin, then hit <b>Guess</b>.</p>
   <p>You'll see where they really were, how far off you were, and your points: up to <b>5,000</b> per round, so <b>25,000</b> max. Anywhere within <b>${CONFIG.fullScoreRadiusKm} km</b> of the real spot is a perfect 5,000; further out, the closer you are the more you score.</p>
   <p>🟩 under 100 km · 🟨 under 500 km · 🟧 under 2,000 km · 🟥 further.</p>
   <p>Everyone featured has opted in. We never pin a home address.</p>
   <p>A new daily drops at local midnight. Missed one? It's in the Archive.</p>`);
}
function aboutModal() {
  // no per-round credits here: they would spoil the answers and name the featured woman before round 5
  openModal(`<h2>About &amp; credits</h2><p style="color:var(--muted);font-size:14px">WhereIsShe is a prototype. Every day features someone who opted in; their photos are used with their permission, and they're credited (with a link to their Instagram) on the Meet card after round 5.</p>
    <p style="font-size:12px;color:var(--muted)">Map data © OpenStreetMap contributors · Basemap: OpenFreeMap / OpenMapTiles (fallback: Esri). Rendering: MapLibre GL JS (BSD-3-Clause). Map library: Leaflet (BSD-2-Clause).</p>`);
}

// ================================================================ puzzle file upload (json / csv / xlsx)
async function handleFiles(files) {
  try {
    let rows = [], name = [];
    for (const file of files) {
      name.push(file.name);
      if (/\.json$/i.test(file.name)) { const j = JSON.parse(await file.text()); rows = rows.concat(Array.isArray(j) ? j : j.rows || []); continue; }
      if (!window.XLSX) { toast("Spreadsheet reader failed to load"); return; }
      const wb = /\.csv$/i.test(file.name) ? XLSX.read(await file.text(), { type: "string" }) : XLSX.read(await file.arrayBuffer(), { type: "array" });
      for (const sn of wb.SheetNames) rows = rows.concat(XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: "" }).filter(r => "puzzle_id" in lowerKeys(r)));
    }
    const parsed = parseRows(rows);
    if (!parsed.length) { toast("No valid days found. Each day needs 5 rounds (and real days need featured_handle + consent_on)."); return; }
    custom = { name: name.join(", "), rows, loadedAt: Date.now() }; save(LS.custom, custom); ALL = parsed;
    closeModal(); toast(`Loaded ${parsed.length} days`); goPractice(0);
  } catch (e) { console.error(e); toast("Couldn't read that file: " + e.message); }
}
window.WISLoadFiles = handleFiles;
window.WIS = { videoState: () => ({ state: VS.state, tries: VS.tries, round: VS.round, src: VS.url, log: VS.log.slice(), preload: preloadNext.el ? preloadNext.el.dataset.src : null }), crossPromoCheck, visits: () => load(LS.visits, 0), Zoom, fitMedia, summaryMap: () => summaryMap, CONFIG, dailyPool, puzzleForDate, schedule: () => SCHED, mode: () => state.mode, dockMode, scoreFor, isPerfect, haversineKm, band, resultText, puzzles: () => ALL, map: () => map };   // test hooks

// ================================================================ wire up
$("#guessBtn").onclick = submitGuess; $("#nextRoundBtn").onclick = nextRound; $("#nextBtn").onclick = next;
$("#shareResultBtn").onclick = () => doShare(resultText());
$("#shareChallengeBtn").onclick = $("#shareChallengeTop").onclick = () => doShare(challengeText());
$("#statsBtn").onclick = statsModal; $("#menuBtn").onclick = menuModal; $("#modalClose").onclick = closeModal;
$("#themeBtn").onclick = () => { settings.theme = effectiveTheme() === "dark" ? "light" : "dark"; saveSettings(); applyTheme(); };
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
$("#aboutLink").onclick = e => { e.preventDefault(); aboutModal(); };
$("#removeLink").onclick = e => { e.preventDefault(); removalModal(); };
$("#homeLink").onclick = e => { e.preventDefault(); goToday(); };
$("#expandBtn").onclick = e => { e.stopPropagation(); openFullMap(); };
$("#miniCatch").onclick = e => { e.stopPropagation(); openFullMap(); };     // mobile: first tap opens the full-screen map
$("#closeMapBtn").onclick = e => { e.stopPropagation(); closeFullMap(); };
$("#dock").addEventListener("transitionend", e => { if (e.target.classList.contains("map-area") && map) map.invalidateSize(); });   // hover-grow
$("#dock").addEventListener("mouseenter", () => { if (dockMode() === "mini") setTimeout(() => map && map.invalidateSize(), 200); });
window.addEventListener("resize", () => { if (map) map.invalidateSize(); if (summaryMap) summaryMap.invalidateSize(); });
$("#muteBtn").onclick = e => { e.stopPropagation(); toggleMute(); };
$("#video").onclick = () => { const v = $("#video"); if (v.paused) v.play().catch(() => {}); };
$("#zoomBtn").onclick = () => { $("#lightImg").src = $("#photo").src; $("#lightbox").classList.remove("hidden"); };
$("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");
$("#optinForm").onsubmit = submitOptin;
$("#clearLink").onclick = e => { e.preventDefault(); clearDataModal(); };
if (/[?&]cleared=/.test(location.search)) { try { history.replaceState(null, "", location.pathname + location.hash); } catch {} setTimeout(() => toast("Game data cleared"), 300); }
$("#fileInput").onchange = e => { const f = [...e.target.files]; if (f.length) handleFiles(f); e.target.value = ""; };
$$(".tab").forEach(b => b.onclick = () => b.dataset.view === "today" ? goToday() : b.dataset.view === "archive" ? goArchive() : goPractice());
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#welcome").classList.contains("hidden")) { chooseSound("skip"); return; }
  if (e.key === "Escape") { closeModal(); $("#lightbox").classList.add("hidden"); closeFullMap(); return; }
  if (e.key !== "Enter" || $("#playView").classList.contains("hidden") || !$("#modal").classList.contains("hidden") || /^(INPUT|TEXTAREA|BUTTON|A|SELECT)$/.test(document.activeElement?.tagName)) return;
  if (dockMode() !== "reveal" && !$("#guessBtn").disabled) submitGuess();
  else if (dockMode() === "reveal") nextRound();
});

applyTheme();
$("#welSoundOn").onclick = () => chooseSound("on"); $("#welSoundOff").onclick = () => chooseSound("off");
$("#welSkip").onclick = e => { e.preventDefault(); chooseSound("skip"); };
["pointerdown", "mousedown", "touchstart"].forEach(ev => $("#vidLoading .vl-btn").addEventListener(ev, e => e.stopPropagation(), { passive: true }));   // keep the media's drag/zoom from capturing the tap
$("#vidLoading .vl-btn").onclick = e => { e.stopPropagation(); const r = state.puzzle.rounds[VS.round];
  if (VS.state === "tap") { vidOverlay("loading", "Loading clip…"); vidPlay(); } else { VS.tries = 0; vidLoad(r, true); } };
countVisit();
if (!ALL.length) { $("#question").textContent = "No puzzles found. Run build.py or load a puzzle file."; return; }
function route() {
  const h = location.hash, d = h.match(/(?:^#|&)d=(\d{4}-\d{2}-\d{2})/), p = h.match(/(?:^#|&)p=([^&]+)/);
  const pv = h.match(/preview=(\d{4}-\d{2}-\d{2})/) || (/[?&]preview=1/.test(location.search) && location.search.match(/[?&]date=(\d{4}-\d{2}-\d{2})/));
  if (pv) return goPreview(pv[1]);
  if (h.startsWith("#archive")) return goArchive();
  if (h.startsWith("#optin")) return goOptin();
  if (d) return goDate(d[1]);
  if (p) { const i = ALL.findIndex(x => x.id === decodeURIComponent(p[1])); if (i >= 0) return goPractice(i); }
  goToday();
}
window.addEventListener("hashchange", () => { if (location.hash !== linkHash()) route(); });
route();
if (!welcomeDone() && !isPreview() && !location.hash.startsWith("#optin")) showWelcome();
else setTimeout(maybeCrossPromo, 1500);
})();
