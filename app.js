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
  // Daily No. 1 date. Set this to your launch date. (Prototype: 2 days back so the Archive has all 3 demo days.)
  dailyEpoch: "2026-10-19",
  rounds: 5,
  maxRoundScore: 5000,
  scoreScaleKm: 1492.7,              // GeoGuessr-style world-map decay: 5000 * e^(-km / 1492.7)
  perfectKm: 0.05,                   // within 50 m = full 5000
  interstitialBeforeResults: true,   // ALWAYS show the ad after guess 5, before the results screen (daily too)
  interstitialSeconds: 5,            // skip countdown
  includePlaceholderDays: true,      // set false once real featured days exist, to drop the Wikimedia demo days from the daily rotation
  // Opt-in / removal. Leave the endpoints "" to fall back to a pre-filled email (mailto:).
  optinEndpoint: "",                 // e.g. "https://api.whereisshe.example/optin"  (POST JSON)
  removalEndpoint: "",               // e.g. "https://api.whereisshe.example/remove" (POST JSON)
  contactEmail: "hello@whereisshe.example",   // PLACEHOLDER: set a real inbox before launch
  // Map tiles: see tiles.js (OpenFreeMap vector basemap via MapLibre, Esri raster fallback; no API keys).
};
const LS = { results: "wis.results.v1", stats: "wis.stats.v1", settings: "wis.settings.v1", custom: "wis.custom.v1" };
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
const scoreFor = km => km <= CONFIG.perfectKm ? CONFIG.maxRoundScore : Math.round(CONFIG.maxRoundScore * Math.exp(-km / CONFIG.scoreScaleKm));
const band = km => BANDS.find(b => km < b[0]);
const fmtKm = km => km < 1 ? `${Math.round(km * 1000)} m` : km < 10 ? `${km.toFixed(1)} km` : `${n0(km)} km`;

// ================================================================ data (mirrors build.py)
// One row per round. Puzzle-level fields (daily_order, set, placeholder, featured_*, consent_on) are read from the
// first row of each puzzle_id that has them. See README "Data format".
const COLS = ["puzzle_id","daily_order","round","set","placeholder","featured_name","featured_handle","featured_ig_url","consent_on",
  "media_type","image_url","video_url","poster_url","lat","lng","place_name","country","fun_fact","photo_date","credit","license","license_url","source_url"];
const str = v => { v = String(v ?? "").trim(); return v.endsWith(".0") ? v.slice(0, -2) : v; };
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
const yes = v => v === true || ["yes", "y", "true", "1"].includes(str(v).toLowerCase());
const lowerKeys = r => { const o = {}; for (const k in r) o[String(k).trim().toLowerCase()] = r[k]; return o; };
const handleOf = h => str(h).replace(/^@/, "");
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
      p.featured = { name: str(r.featured_name), handle: h, igUrl: str(r.featured_ig_url) || `https://www.instagram.com/${encodeURIComponent(h)}/`, consentOn: str(r.consent_on) };
    }
    const lat = num(r.lat), lng = num(r.lng), media = str(r.media_type).toLowerCase() === "video" ? "video" : "image";
    if (lat == null || lng == null || (media === "video" ? !str(r.video_url) : !str(r.image_url))) return;
    p.rounds.push({ n: num(r.round) ?? p.rounds.length + 1, media, img: str(r.image_url), video: str(r.video_url), poster: str(r.poster_url), lat, lng, place: str(r.place_name), country: str(r.country),
      fact: str(r.fun_fact), credit: str(r.credit), license: str(r.license), licenseUrl: str(r.license_url), sourceUrl: str(r.source_url) });
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
const settings = Object.assign({ theme: "system" }, load(LS.settings, {}));
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
const resultKey = () => state.mode === "practice" ? `p:${state.puzzle.id}` : `d:${state.dateKey}`;
const getResult = () => { const r = load(LS.results, {})[resultKey()]; return r && r.id === state.puzzle.id ? r : null; };
const setResult = r => { const all = load(LS.results, {}); all[resultKey()] = { ...r, id: state.puzzle.id, at: Date.now() }; save(LS.results, all); };
const isToday = () => state.mode === "daily";
function linkHash() { return state.mode === "practice" ? `#p=${encodeURIComponent(state.puzzle.id)}` : `#d=${state.dateKey}`; }
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
    $("#guessBtn").disabled = false; $("#pinNote").textContent = "Pin dropped"; $("#mapHint").classList.add("gone");
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
    : `${CONFIG.brand} #${pad3(n)} · ${longDate(state.dateKey)}${isToday() ? "" : " · Archive"}`;
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
  state.game = saved || { rounds: [], cur: 0, done: false, adSeen: false };
  ensureMap();
  const g = state.game;
  if (g.done && g.adSeen) { showRound(CONFIG.rounds - 1, true); showResults(false); }
  else if (g.rounds.length > g.cur) showRound(g.cur, true);    // guessed but didn't press Next
  else showRound(g.cur, false);
  window.scrollTo({ top: 0 });
}
function showRound(i, revealed) {
  const p = state.puzzle, g = state.game, r = p.rounds[i]; g.cur = i; state.pin = null;
  $("#heroKind").textContent = `Round ${i + 1} / ${CONFIG.rounds}`;
  $("#question").textContent = "Where is she?";   // her name/handle only appears on the Meet her card after round 5
  showMedia(r, i);
  $("#phTag").classList.toggle("hidden", !p.placeholder);
  $("#phTag").textContent = r.media === "video" ? "Placeholder clip" : "Placeholder photo";
  if (p.featured) $("#credit").innerHTML = `<span class="who-hint">👀 Find out who she is after round 5</span>`;
  else $("#credit").textContent = `${r.media === "video" ? "Video" : "Photo"} credit is shown after you guess`;
  setDock("mini");
  $("#mapHint").textContent = compact.matches ? "Tap to open the map" : "Click the map to drop your pin";
  $("#mapHint").classList.remove("gone"); $("#pinNote").textContent = "No pin yet";
  $("#guessBtn").disabled = true;
  resetMap(); renderDots();
  if (revealed) revealRound(i, false);
}
// ---- per-media layout (wide desktop only): choose the frame from the media's aspect ratio so she is never
// cropped (object-fit: contain) and, where possible, never under the minimap. Candidates: whole stage (if the
// contained media misses the minimap), symmetric side gutters (portrait), or a band above the minimap (landscape).
const wideStage = matchMedia("(min-width:1101px)");
function fitMedia() {
  const m = $("#media"), vid = $("#video"), img = $("#photo"), isVid = !vid.classList.contains("hidden");
  const nw = isVid ? vid.videoWidth : img.naturalWidth, nh = isVid ? vid.videoHeight : img.naturalHeight;
  const set = (t, r, b, l, kind) => { m.style.setProperty("--pt", t + "px"); m.style.setProperty("--pr", r + "px"); m.style.setProperty("--pb", b + "px"); m.style.setProperty("--pl", l + "px"); m.dataset.fit = kind; };
  if (!nw || !nh) return;
  m.dataset.orient = nw / nh > 1.1 ? "landscape" : nw / nh < 0.9 ? "portrait" : "square";
  if (!wideStage.matches) { ["--pt", "--pr", "--pb", "--pl"].forEach(k => m.style.removeProperty(k)); m.dataset.fit = "stack"; return; }
  const st = $("#stage").getBoundingClientRect(), W = st.width, H = st.height, a = nw / nh;
  const dw = 300 + 14 + 14, dh = 200 + 8 + 44 + 14 + 14;       // minimap + Guess button + margins (mini mode, not hovered)
  const T = 54, E = 14;                                         // HUD row on top, edge margin
  const fit = (t, r, b, l) => { const bw = W - l - r, bh = H - t - b, s = Math.min(bw / nw, bh / nh), w = nw * s, h = nh * s;
    const x = l + (bw - w) / 2, y = t + (bh - h) / 2; return { t, r, b, l, w, h, x, y }; };
  const hitsDock = c => c.x + c.w > W - dw && c.y + c.h > H - dh;
  const opts = [[T, E, E, E, "full"], [T, dw, E, dw, "gutters"], [T, E, dh, E, "above-map"], [T, dw, E, E, "left-of-map"]]
    .map(o => ({ ...fit(o[0], o[1], o[2], o[3]), kind: o[4] }));
  const ok = opts.filter(c => !hitsDock(c));
  const best = (ok.length ? ok : opts).reduce((A, B) => (B.w * B.h > A.w * A.h * 1.02 ? B : A));
  set(best.t, best.r, best.b, best.l, best.kind);
}
wideStage.addEventListener ? wideStage.addEventListener("change", fitMedia) : 0;
window.addEventListener("resize", () => { fitMedia(); Zoom.reset(); });

// ---- touch pinch-zoom / pan / double-tap on photos (mobile). Starts fully fit; one-finger drags scroll the page
// until you zoom in (touch-action: pan-y), then pan the photo (touch-action: none). Videos are left alone.
const Zoom = (() => {
  let s = 1, tx = 0, ty = 0, pts = new Map(), start = null, lastTap = 0;
  const el = () => $("#photo"), box = () => $("#media");
  function geom() { const e = el(), bw = e.offsetWidth, bh = e.offsetHeight, nw = e.naturalWidth || bw, nh = e.naturalHeight || bh, k = Math.min(bw / nw, bh / nh);
    const cw = nw * k, ch = nh * k; return { bw, bh, cw, ch, ox: (bw - cw) / 2, oy: (bh - ch) / 2 }; }
  function clamp() { const g = geom();
    const ax = (bw, c, o, t) => s * c <= bw ? (bw - s * c) / 2 - s * o : Math.min(-s * o, Math.max(bw - s * (o + c), t));
    tx = ax(g.bw, g.cw, g.ox, tx); ty = ax(g.bh, g.ch, g.oy, ty); }
  function apply() { if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
    clamp(); const e = el(); e.style.transform = s === 1 ? "" : `translate(${tx}px,${ty}px) scale(${s})`;
    box().classList.toggle("zoomed", s > 1); }
  function zoomAt(ns, px, py) { ns = Math.max(1, Math.min(5, ns)); tx = px - (px - tx) * (ns / s); ty = py - (py - ty) * (ns / s); s = ns; apply(); }
  // coordinates relative to the untransformed image box (transform-origin 0 0)
  const rel = (x, y) => { const b = box().getBoundingClientRect(), e = el(); return { x: x - b.left - e.offsetLeft, y: y - b.top - e.offsetTop }; };
  function down(e) { if (e.pointerType !== "touch" || !box().classList.contains("zoomable")) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; start = { d: Math.hypot(a.x - b.x, a.y - b.y), s, tx, ty, m: rel((a.x + b.x) / 2, (a.y + b.y) / 2) }; }
    else if (pts.size === 1) { start = { pan: true, x: e.clientX, y: e.clientY, tx, ty };
      const now = Date.now(); if (now - lastTap < 300) { const p = rel(e.clientX, e.clientY); if (s > 1) { s = 1; apply(); } else zoomAt(2.5, p.x, p.y); lastTap = 0; } else lastTap = now; } }
  function move(e) { if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size >= 2 && start && start.d) { e.preventDefault(); const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), m = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
      const ns = Math.max(1, Math.min(5, start.s * d / start.d)); tx = m.x - (start.m.x - start.tx) * (ns / start.s); ty = m.y - (start.m.y - start.ty) * (ns / start.s); s = ns; apply(); }
    else if (pts.size === 1 && start && start.pan && s > 1) { e.preventDefault(); tx = start.tx + e.clientX - start.x; ty = start.ty + e.clientY - start.y; apply(); } }
  function up(e) { pts.delete(e.pointerId); if (pts.size === 1) { const [a] = [...pts.values()]; start = { pan: true, x: a.x, y: a.y, tx, ty }; } else if (!pts.size) start = null; }
  function attach() { const b = box(); b.addEventListener("pointerdown", down); b.addEventListener("pointermove", move, { passive: false });
    ["pointerup", "pointercancel", "pointerleave"].forEach(t => b.addEventListener(t, up));
    // iOS Safari: stop its page-level pinch while a pinch is on the photo
    b.addEventListener("touchmove", e => { if (b.classList.contains("zoomable") && (e.touches.length > 1 || s > 1)) e.preventDefault(); }, { passive: false });
    ["gesturestart", "gesturechange"].forEach(t => b.addEventListener(t, e => { if (b.classList.contains("zoomable")) e.preventDefault(); }));
    return true; }
  return { attach, reset() { s = 1; tx = 0; ty = 0; pts.clear(); start = null; const e = $("#photo"); if (e) e.style.transform = ""; $("#media") && $("#media").classList.remove("zoomed"); },
           state: () => ({ s, tx, ty }), zoomAt: (ns, x, y) => zoomAt(ns, x, y), attached: false };
})();
Zoom.attached = Zoom.attach();

// ---- media: photo or looping muted video (autoplay needs muted + playsinline on iOS/Android)
function showMedia(r, i) {
  const img = $("#photo"), vid = $("#video"), mute = $("#muteBtn"), isVid = r.media === "video";
  Zoom.reset(); $("#media").classList.toggle("zoomable", !isVid);
  img.classList.toggle("hidden", isVid); vid.classList.toggle("hidden", !isVid); mute.classList.toggle("hidden", !isVid); $("#zoomBtn").classList.toggle("hidden", isVid);
  if (isVid) {
    img.removeAttribute("src");
    vid.muted = true; vid.defaultMuted = true; vid.setAttribute("muted", ""); vid.loop = true; vid.playsInline = true; vid.autoplay = true;
    if (r.poster) vid.poster = r.poster; else vid.removeAttribute("poster");
    $("#media").style.setProperty("--media-bg", r.poster ? `url("${r.poster}")` : "none");
    vid.onloadedmetadata = fitMedia;
    if (vid.getAttribute("src") !== r.video) { vid.src = r.video; vid.load(); } else fitMedia();
    vid.setAttribute("aria-label", `Round ${i + 1} video`); setMuteLabel();
    const pr = vid.play(); if (pr && pr.catch) pr.catch(() => {});   // if autoplay is blocked the poster shows; tapping the video plays it
  } else {
    if (!vid.paused) vid.pause(); vid.removeAttribute("src"); vid.removeAttribute("poster"); vid.load();
    img.classList.add("loading"); img.onload = () => { img.classList.remove("loading"); fitMedia(); }; img.src = r.img; img.alt = `Round ${i + 1} photo`;
    $("#media").style.setProperty("--media-bg", `url("${r.img}")`);   // blurred fill behind the contain-fit photo
  }
}
function setMuteLabel() { const v = $("#video"), b = $("#muteBtn"); b.textContent = v.muted ? "🔇 Tap to unmute" : "🔊 Sound on"; b.setAttribute("aria-pressed", String(!v.muted)); }
function toggleMute() { const v = $("#video"); v.muted = !v.muted; if (v.paused) v.play().catch(() => {}); setMuteLabel(); }

function submitGuess() {
  const p = state.puzzle, g = state.game; if (!state.pin || state.busy || g.rounds.length > g.cur) return;
  const r = p.rounds[g.cur], dist = haversineKm(state.pin, r), pts = scoreFor(dist);
  g.rounds.push({ lat: +state.pin.lat.toFixed(5), lng: +state.pin.lng.toFixed(5), dist: +dist.toFixed(3), pts });
  if (g.rounds.length === CONFIG.rounds) {
    g.done = true; g.total = totalOf(g); g.emoji = g.rounds.map(x => band(x.dist)[1]).join("");
    if (isToday()) recordStats(g);
    CommunityStats.submit({ puzzleId: p.id, day: state.dateKey, mode: state.mode, total: g.total, rounds: g.rounds });
  }
  setResult(g); revealRound(g.cur, true);
}
function revealRound(i, animate) {
  const p = state.puzzle, g = state.game, r = p.rounds[i], gr = g.rounds[i];
  setDock("reveal");
  drawReveal(gr, r, animate);
  $("#rvPoints").textContent = n0(gr.pts);
  $("#rvDist").textContent = `${band(gr.dist)[1]} ${fmtKm(gr.dist)} away`;
  $("#rvPlace").textContent = `📍 ${r.place}${r.country ? ", " + r.country : ""}`;
  $("#rvFact").innerHTML = r.fact ? `<b>Fun fact:</b> ${esc(r.fact)}` : "";
  // Featured days: no handle / IG link until the Meet her card after round 5
  $("#credit").innerHTML = $("#rvCredit").innerHTML = state.puzzle.featured
    ? `${r.media === "video" ? "Video" : "Photo"} used with permission · <span class="who-hint">find out who she is after round 5</span>` : creditHtml(r);
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
  $("#nextBtn").textContent = state.mode === "practice" ? "Next puzzle →" : state.mode === "archive" ? "Back to archive →" : "More puzzles →";
  renderCommunity(p, t);
  $("#result").classList.remove("hidden");
  drawSummary(p, g);
  if (scroll) setTimeout(() => $("#result").scrollIntoView({ behavior: "smooth", block: "start" }), 80);
}
function renderMeetHer(p) {
  const box = $("#meetHer"), f = p.featured;
  if (f) {
    box.innerHTML = `<div class="mh-k">Meet her</div><div class="mh-row"><div class="mh-av">${esc((f.name || f.handle).slice(0, 1).toUpperCase())}</div>
      <div><div class="mh-name">${esc(f.name || "@" + f.handle)}</div><div class="mh-handle">@${esc(f.handle)}</div></div>
      <a class="pill-btn primary mh-btn" id="meetHerLink" href="${esc(f.igUrl)}" target="_blank" rel="noopener">Instagram ↗</a></div>
      <p class="mh-note">Featured with her consent${f.consentOn ? ` (opted in ${esc(f.consentOn)})` : ""}. We never pin a home address.</p>`;
  } else {
    box.innerHTML = `<div class="mh-k">Meet her</div><p class="mh-note">This is a <b>demo day</b> with placeholder landmark photos from Wikimedia Commons, so there's no featured woman yet.
      On real days this card links to the featured woman's Instagram.</p><a class="link-btn" href="#optin">Want to be featured? Opt in →</a>`;
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
function challengeText() { return `${shareTitle()} 📍\nFive photos. One woman. Where in the world is she?\n${shareUrl()}`; }
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
function goToday() { state.mode = "daily"; state.dateKey = todayKey(); openPuzzle(puzzleForDay(dayNumber(state.dateKey))); }
function goDate(key) {
  const today = todayKey();
  if (!validKey(key) || dayNumber(key) < 0) { toast("That puzzle doesn't exist"); return goToday(); }
  if (utc(key) > utc(today)) { toast("That puzzle isn't out yet 👀"); return goToday(); }   // never expose future dailies
  if (key === today) return goToday();
  state.mode = "archive"; state.dateKey = key; openPuzzle(puzzleForDay(dayNumber(key)));
}
function goPractice(idx) {
  state.mode = "practice";
  if (idx == null) idx = (dayNumber(todayKey()) + 1) % ALL.length;
  state.practiceIdx = ((idx % ALL.length) + ALL.length) % ALL.length; openPuzzle(ALL[state.practiceIdx]);
}
const dayLabel = p => p.featured ? "Featured day · she's revealed after round 5" : "Demo day · placeholder photos";
function goArchive() {
  showView("archive"); setHash("#archive");
  const today = todayKey(), last = dayNumber(today), all = load(LS.results, {}), rows = [];
  for (let n = last; n >= 0; n--) {          // only today and earlier; future dailies are never listed
    const key = keyFromDay(n), p = puzzleForDay(n), r = all[`d:${key}`], mine = r && r.id === p.id ? r : null;
    const badge = mine && mine.done ? `<span class="ar done">${n0(mine.total ?? totalOf(mine))}</span>` : mine && mine.rounds?.length ? `<span class="ar">${mine.rounds.length}/5</span>` : `<span class="ar">Play →</span>`;
    rows.push(`<li><button class="arch ${n === last ? "today" : ""}" data-key="${key}"><span class="an">#${pad3(n + 1)}<small>${n === last ? "Today" : prettyDate(key).replace(/, \d{4}$/, "")}</small></span>
      <span class="aq">📍 Where is she?<small>${esc(dayLabel(p))}</small></span>${badge}</button></li>`);
  }
  $("#archiveList").innerHTML = rows.join("");
  $$(".arch").forEach(b => b.onclick = () => goDate(b.dataset.key));
  window.scrollTo({ top: 0 });
}
function next() { if (state.mode === "practice") goPractice(state.practiceIdx + 1); else if (state.mode === "archive") goArchive(); else goPractice(); }

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
    <button id="mAbout">📚 About &amp; photo credits</button></div>`);
  $("#mArchive").onclick = () => { closeModal(); goArchive(); }; $("#mList").onclick = listModal; $("#mSettings").onclick = settingsModal;
  $("#mHow").onclick = howModal; $("#mAbout").onclick = aboutModal; $("#mOptin").onclick = () => { closeModal(); goOptin(); };
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
  const all = load(LS.results, {});
  openModal(`<h2>All puzzles (${ALL.length})</h2><div class="plist">${ALL.map((p, i) => { const r = all["p:" + p.id];
    return `<button data-i="${i}"><span>📍 ${esc(p.id)} · ${esc(dayLabel(p))}</span><span class="done">${r && r.done ? n0(totalOf(r)) : ""}</span></button>`; }).join("")}</div>`);
  $$(".plist button").forEach(b => b.onclick = () => { closeModal(); goPractice(+b.dataset.i); });
}
function howModal() {
  openModal(`<h2>How to play</h2>
   <p>Every day there are <b>5 photos</b> of the same woman somewhere in the world. For each one, tap the map to drop your pin, then hit <b>Guess</b>.</p>
   <p>You'll see where she really was, how far off you were, and your points: up to <b>5,000</b> per round (closer = more), so <b>25,000</b> max.</p>
   <p>🟩 under 100 km · 🟨 under 500 km · 🟧 under 2,000 km · 🟥 further.</p>
   <p>Everyone featured has opted in. We never pin a home address.</p>
   <p>A new daily drops at local midnight. Missed one? It's in the Archive.</p>`);
}
function aboutModal() {
  const rows = ALL.flatMap(p => p.rounds.map(r => ({ p, r })));
  openModal(`<h2>About &amp; credits</h2><p style="color:var(--muted);font-size:14px">WhereIsShe is a prototype. The demo days use openly licensed landmark photos from Wikimedia Commons as placeholders; real days feature women who opted in.</p>
    <ol class="credits">${rows.map(({ p, r }) => `<li>${esc(r.place)} (${esc(p.id)}) · ${creditHtml(r)}</li>`).join("")}</ol>
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
window.WIS = { Zoom, fitMedia, summaryMap: () => summaryMap, CONFIG, dailyPool, dockMode, scoreFor, haversineKm, band, resultText, puzzles: () => ALL, map: () => map };   // test hooks

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
$("#fileInput").onchange = e => { const f = [...e.target.files]; if (f.length) handleFiles(f); e.target.value = ""; };
$$(".tab").forEach(b => b.onclick = () => b.dataset.view === "today" ? goToday() : b.dataset.view === "archive" ? goArchive() : goPractice());
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeModal(); $("#lightbox").classList.add("hidden"); closeFullMap(); return; }
  if (e.key !== "Enter" || $("#playView").classList.contains("hidden") || !$("#modal").classList.contains("hidden") || /^(INPUT|TEXTAREA|BUTTON|A|SELECT)$/.test(document.activeElement?.tagName)) return;
  if (dockMode() !== "reveal" && !$("#guessBtn").disabled) submitGuess();
  else if (dockMode() === "reveal") nextRound();
});

applyTheme();
if (!ALL.length) { $("#question").textContent = "No puzzles found. Run build.py or load a puzzle file."; return; }
function route() {
  const h = location.hash, d = h.match(/d=(\d{4}-\d{2}-\d{2})/), p = h.match(/p=([^&]+)/);
  if (h.startsWith("#archive")) return goArchive();
  if (h.startsWith("#optin")) return goOptin();
  if (d) return goDate(d[1]);
  if (p) { const i = ALL.findIndex(x => x.id === decodeURIComponent(p[1])); if (i >= 0) return goPractice(i); }
  goToday();
}
window.addEventListener("hashchange", () => { if (location.hash !== linkHash()) route(); });
route();
})();
