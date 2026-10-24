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
  siteUrl: (location.protocol.startsWith("http") ? location.origin + location.pathname : "https://whereisshe.gg/"),
  // Daily No. 1 date (launch day).
  dailyEpoch: "2026-10-21",          // Daily No. 001 = Oct 21 2026 = she-001; later days come from the schedule (empty rotation plays nothing)
  rounds: 5,
  maxRoundScore: 5000,
  scoreScaleKm: 1492.7,              // decay beyond the radius: 5000 * e^(-(km - radius) / 1492.7)
  fullScoreRadiusKm: 30,
  // Ranki card on the daily results screen, after the share buttons. Not an ad: free and Premium both see it,
  // and it is separate from interstitialBeforeResults. Shows when stats.played >= minPlayed OR the current
  // streak >= minStreak. Once per tab session. "Not now" snoozes snoozeDays via LS.promo. Opening Ranki
  // (clickedAt) stops it. Never in preview, archive, or on Loading Zone (that page does not load this app).
  crossPromo: {
    enabled: true, url: "https://ranki.gg",
    title: "From the same creator",
    blurb: "Ranki is a separate daily ranking puzzle, not an ad.",
    cta: "Play Ranki →", dismiss: "Not now",
    minPlayed: 5, minStreak: 3, snoozeDays: 7,
  },
  videoRetries: 2,                   // automatic reloads of a clip after an error or a stall
  videoStallMs: 8000,                // no playback progress for this long while loading = stalled -> retry             // within this many km of the answer = full 5000 ("Perfect!")
  interstitialBeforeResults: true,   // ALWAYS show the ad after guess 5, before the results screen (daily too)
  interstitialSeconds: 5,            // skip countdown
  includePlaceholderDays: false,      // placeholder (non-featured) days are not in the daily rotation
  // Opt-in / removal. Leave the endpoints "" to fall back to a pre-filled email (mailto:).
  optinEndpoint: "",                 // e.g. "https://api.whereisshe.gg/optin"  (POST JSON)
  removalEndpoint: "",               // e.g. "https://api.whereisshe.gg/remove" (POST JSON)
  contactEmail: "mikelyaps@gmail.com",   // THE contact address. To change it everywhere (app + legal/about pages): python3 tools/set_contact.py NEW@EMAIL
  // Map tiles: see tiles.js (OpenFreeMap vector basemap via MapLibre, Esri raster fallback; no API keys).
  // ---- v11 (see SETUP.md). All OFF on the live site until the Supabase migration is applied and RLS is verified.
  // backend: PUBLIC values only. anonKey = the publishable key (sb_publishable_…) or the legacy anon JWT. NEVER a sb_secret_ key.
  backend: { enabled: true, supabaseUrl: "https://xhaduveumhtikwoekxdi.supabase.co", anonKey: "sb_publishable_Aoj_rFQBnwqahuEpCJFqww_9umiFFxx" },
  // Lemon Squeezy checkout link of the Premium variant (Share -> checkout URL), e.g. https://STORE.lemonsqueezy.com/buy/<uuid>.
  // testMode: true while using the store's test-mode link (shows a "no real charge" note); set false after going live.
  premium: { enabled: true, testMode: true, checkoutUrl: "https://mikelyaps.lemonsqueezy.com/checkout/buy/ca1efbfa-7ab8-4fe6-b96a-694c1f5691fa", price: "From $2.67/month · suggested $6.70", billing: "Monthly subscription · cancel anytime" },   // pay-what-you-want monthly (min $2.67, suggested $6.70)
  // "Feature me" v11 form (links and/or uploads). Login required; limits enforced by the submit_feature() SQL function.
  submissions: { enabled: true, maxFiles: 5, maxFileMB: 25, maxLinks: 10 },
  // Google AdSense Display unit "whereisshe" for the post-round-5 placement. Never requested for Premium players.
  ads: { enabled: true, client: "ca-pub-5196178239625142", slot: "7982022596" },
  // PostHog product analytics. The <head> snippet inits early with this key and host; custom events fire only when enabled and posthog.capture exists.
  analytics: { enabled: true, provider: "posthog", apiKey: "phc_BFzhf5CAX9wKcoGBVXnX3uPb4T2LAjeD3ZfBGiHWvFxc", apiHost: "https://us.i.posthog.com" },
};
// Tests only (never on the live site): a localhost page may override CONFIG, e.g. to point at the mock backend.
(function mergeTestConfig(dst, src) { if (!src || !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  for (const k in src) { if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === "object") mergeTestConfig(dst[k], src[k]); else dst[k] = src[k]; } })(CONFIG, window.__WIS_TEST_CONFIG__);
// v6: saved progress is namespaced by mode + day + puzzle id + a hash of the puzzle's content, under fresh v2 keys.
// Anything from earlier versions (v1 keys, other daily numbering, other puzzle content) is discarded, never resumed.
const LS = { results: "wis.results.v2", stats: "wis.stats.v2", settings: "wis.settings.v1", custom: "wis.custom.v1", welcome: "wis.welcome.v1", visits: "wis.visits.v1", promo: "wis.promo.v1",
  auth: "wis.auth.v1", sync: "wis.sync.v1", premium: "wis.premium.v1" };   // v11: Supabase session (cleared by "Clear my game data" = signed out here), sync status, Premium cache
const LEGACY_LS = ["wis.results.v1", "wis.stats.v1"];
const BUILD = "3148c28028";   // stamped by tools/deploy.sh; must match window.WIS_BUILD in puzzles-data.js
const BANDS = [[100, "🟩", "e-g"], [500, "🟨", "e-y"], [2000, "🟧", "e-o"], [Infinity, "🟥", "e-r"]];   // km thresholds

// ================================================================
// COMMUNITY STATS
// ----------------------------------------------------------------
// Snapshots live in Supabase (community_snapshots). A finished daily game
// inserts one community_play_events row. The 12-hour refresh blends a
// deterministic seed until 40 real finishes, then switches to real scores.
// fetch() returns { players, avgTotal, pctBeaten, perRoundAvg } or null.
// The same seed formula is communitySeed(), used only when the row can't be read.
// See SETUP.md.
// ================================================================
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function communitySeed(puzzleId, dayKey) {
  const h = salt => fnv1a(puzzleId + "|" + dayKey + "|" + salt);
  const players = 48 + (h("n") % 133);
  const baseW = [8, 18, 38, 26, 10];
  const weights = baseW.map((w, i) => Math.max(1, w + (h("w" + i) % 5) - 2));
  const sumW = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map(w => Math.floor(players * w / sumW));
  counts[2] += players - counts.reduce((a, b) => a + b, 0);
  const mins = [0, 5000, 10000, 15000, 20000], maxs = [5000, 10000, 15000, 20000, 25001], mids = [2500, 7500, 12500, 17500, 22500];
  const histogram = counts.map((n, i) => ({ min: mins[i], max: maxs[i], n }));
  const avgTotal = Math.round(counts.reduce((s, n, i) => s + n * mids[i], 0) / players);
  const avgs = [0, 1, 2, 3, 4].map(i => Math.max(600, Math.min(4600, Math.round(avgTotal / 5 + (h("r" + i) % 801) - 400))));
  avgs[4] = Math.max(0, Math.min(5000, avgs[4] + (avgTotal - avgs.reduce((a, b) => a + b, 0))));
  return { players, avgTotal, histogram, perRoundAvg: avgs, seeded: true };
}
function pctFromHistogram(hist, total) {
  const bands = Array.isArray(hist) ? hist : [];
  let players = 0, below = 0;
  for (const b of bands) {
    const n = +b.n || 0, min = +b.min, max = +b.max;
    if (!n || !(max > min)) continue;
    players += n;
    if (total >= max) below += n;
    else if (total > min) below += n * (total - min) / (max - min);
  }
  if (!players) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * below / players)));
}
function communityFromRow(row, total) {
  if (!row || !(+row.players > 0)) return null;
  const per = row.perRoundAvg || row.per_round_avg;
  return {
    players: +row.players,
    avgTotal: +row.avgTotal || +row.avg_total || 0,
    pctBeaten: pctFromHistogram(row.histogram, total),
    perRoundAvg: Array.isArray(per) ? per.map(Number) : [],
    seeded: !!row.seeded,
  };
}
const CommunityStats = {
  async submit(result) {
    try {
      if (!result || result.mode !== "daily" || !accountsOn()) return false;
      const rounds = (result.rounds || []).map(r => Math.round(+r.pts || 0));
      const total = Math.round(+result.total || 0);
      if (rounds.length !== 5 || rounds.some(n => n < 0 || n > 5000) || total !== rounds.reduce((a, b) => a + b, 0)) return false;
      const sentKey = "wis.communitySent.v1", sent = load(sentKey, {}), id = result.day + ":" + result.puzzleId;
      if (sent[id]) return true;
      if (Cloud.ready) await Cloud.ready;
      if (!Cloud.sb) return false;
      const { error } = await Cloud.sb.rpc("submit_community_play", { p_puzzle_id: result.puzzleId, p_day_key: result.day, p_total: total, p_rounds: rounds });
      if (error) return false;
      sent[id] = 1; save(sentKey, sent); return true;
    } catch { return false; }
  },
  async fetch(puzzleId, dayKey, total) {
    if (!puzzleId || !dayKey) return null;
    let row = null;
    try {
      if (accountsOn()) {
        if (Cloud.ready) await Promise.race([Cloud.ready, new Promise(r => setTimeout(r, 4000))]);
        if (Cloud.sb) {
          const { data, error } = await Cloud.sb.from("community_snapshots").select("players,avg_total,histogram,per_round_avg,seeded").eq("puzzle_id", puzzleId).eq("day_key", dayKey).maybeSingle();
          if (!error && data) row = data;
        }
      }
    } catch {}
    return communityFromRow(row, total) || communityFromRow(communitySeed(puzzleId, dayKey), total);
  },
  // Raw public snapshot, or null. The platforms graphic peels real finishes out of this
  // in community-distribution.js. fetch() is unchanged and still falls back to communitySeed().
  async snapshot(puzzleId, dayKey) {
    if (!puzzleId || !dayKey || !accountsOn()) return null;
    try {
      if (Cloud.ready) await Promise.race([Cloud.ready, new Promise(r => setTimeout(r, 4000))]);
      if (!Cloud.sb) return null;
      const { data, error } = await Cloud.sb.from("community_snapshots").select("players,avg_total,histogram,per_round_avg,seeded").eq("puzzle_id", puzzleId).eq("day_key", dayKey).maybeSingle();
      if (error || !data) return null;
      return data;
    } catch { return null; }
  },
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
const COLS = ["puzzle_id","daily_order","round","set","placeholder","featured_name","featured_handle","featured_ig_url","featured_avatar","featured_pronoun","consent_on",
  "media_type","image_url","video_url","poster_url","lat","lng","place_name","country","fun_fact","photo_date","credit","license","license_url","source_url","focus","focus_mobile","in_frame"];
const str = v => { v = String(v ?? "").trim(); return v.endsWith(".0") ? v.slice(0, -2) : v; };
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
const yes = v => v === true || ["yes", "y", "true", "1"].includes(str(v).toLowerCase());
const lowerKeys = r => { const o = {}; for (const k in r) o[String(k).trim().toLowerCase()] = r[k]; return o; };
const handleOf = h => str(h).replace(/^@/, "");
// Optional Meet-card photo. A site-relative file (sources/<set>/avatar.jpg) or an https URL. Anything else is ignored.
const avatarOf = v => { const s = str(v); if (!s || /[\s"'<>]/.test(s) || s.includes("..")) return "";
  return /^https:\/\//i.test(s) || /^[A-Za-z0-9_./-]+$/.test(s) ? s : ""; };
// per-day wording: featured_pronoun "she" (default) or "he" (anything else falls back to "they")
const PRONOUNS = { she: { subj: "she", obj: "her", noun: "woman" }, he: { subj: "he", obj: "him", noun: "man" }, they: { subj: "they", obj: "them", noun: "person" } };
const pronounOf = v => { v = str(v).toLowerCase(); return v === "he" || v === "him" ? "he" : v === "they" || v === "them" ? "they" : "she"; };
const W = p => PRONOUNS[(p && p.featured && p.featured.pronoun) || "she"];
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
// v10 heading: just the day code (+ daily No. on dated days). Never "Who is she?" (only the bottom reminder says that), never the handle.
const dayTitle = p => !state.dateKey ? p.id : `${p.id} · No. ${pad3(dayNumber(state.dateKey) + 1)}`;
const whereQ = () => "Guess where it was taken";   // place, not the person: keeps photo alt text off dating-style "where is she" phrasing
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
      p.featured = { name: str(r.featured_name), handle: h, igUrl: str(r.featured_ig_url) || `https://www.instagram.com/${encodeURIComponent(h)}/`, avatar: avatarOf(r.featured_avatar), consentOn: str(r.consent_on), pronoun: pronounOf(r.featured_pronoun) };
    } else if (p.featured && !p.featured.avatar) { const a = avatarOf(r.featured_avatar); if (a) p.featured.avatar = a; }
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
const dailyPool = () => { const days = ALL.filter(p => !p.practiceOnly), real = days.filter(p => !p.placeholder);   // practice_only rows (legacy column) are never played
  return CONFIG.includePlaceholderDays || !real.length ? days : real; };

// ================================================================ settings + theme
const settings = Object.assign({ theme: "dark", sound: false }, load(LS.settings, {}));
const saveSettings = () => { settings._at = Date.now(); save(LS.settings, settings); };   // _at: newest settings win when syncing
const mq = matchMedia("(prefers-color-scheme: dark)");
const effectiveTheme = () => settings.theme === "system" ? (mq.matches ? "dark" : "light") : settings.theme;
function applyTheme() {
  const t = effectiveTheme(); document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
  $("#themeBtn").title = t === "dark" ? "Switch to light mode" : "Switch to dark mode";
}
mq.addEventListener?.("change", () => settings.theme === "system" && applyTheme());

// ================================================================ state
const state = { mode: "daily", dateKey: todayKey(), puzzle: null, game: null, pin: null, busy: false };   // mode: daily | archive | preview (v11: Practice removed)
const puzzleForDay = n => { const pool = dailyPool(); if (!pool.length) return null; return pool[((n % pool.length) + pool.length) % pool.length]; };
// v9: the daily schedule is data (schedule.json -> window.WIS_SCHEDULE, edited with tools/schedule.py).
// A date listed in "dates" plays that puzzle. Any other date uses "rotation" when that list is non-empty.
// An empty rotation is valid and returns nothing: earlier days are not replayed. A custom puzzle file loaded in
// Settings ignores the schedule and uses the order-based pool.
const SCHED = window.WIS_SCHEDULE || null;
if (SCHED && validKey(SCHED.epoch)) CONFIG.dailyEpoch = SCHED.epoch;
function puzzleForDate(key) {
  if (SCHED && !custom) {
    const byId = id => ALL.find(p => p.id === id && !p.practiceOnly);
    const pinned = SCHED.dates && SCHED.dates[key] && byId(SCHED.dates[key]); if (pinned) return pinned;
    const rot = (SCHED.rotation || []).map(byId).filter(Boolean);
    if (!rot.length) return null;
    const keys = Object.keys(SCHED.dates || {}).filter(validKey).sort(), last = keys[keys.length - 1];
    const n = last && utc(key) > utc(last) ? Math.round((utc(key) - utc(last)) / 864e5) - 1 : dayNumber(key);
    return rot[((n % rot.length) + rot.length) % rot.length];
  }
  return puzzleForDay(dayNumber(key));
}
// content hash (FNV-1a) of what a player actually guesses on: media + answer of each round, in order
const puzzleHash = p => { if (p._h) return p._h; let h = 0x811c9dc5; const t = JSON.stringify(p.rounds.map(r => [r.media, r.img, r.video, r.lat, r.lng]));
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return (p._h = h.toString(36)); };
const keyFor = (mode, dateKey, p) => `d:${dateKey}:${p.id}@${puzzleHash(p)}`;   // old "p:" (Practice) saves are left alone and simply never read
const resultKey = () => keyFor(state.mode, state.dateKey, state.puzzle);
// preview mode (schedule.html "Play this day"): progress lives only in memory, never in localStorage, stats or streaks
const previewStore = {};
const isPreview = () => state.mode === "preview";
// Custom events only. The head snippet already loaded PostHog; this never injects a script and never sends typed text.
function track(event, props) {
  const a = CONFIG.analytics;
  if (!a || !a.enabled || a.provider !== "posthog" || !a.apiKey) return;
  if (typeof posthog === "undefined" || typeof posthog.capture !== "function") return;
  try { props ? posthog.capture(event, props) : posthog.capture(event); } catch {}
}
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
function linkHash() { return isPreview() ? `#preview=${state.dateKey}` : `#d=${state.dateKey}`; }
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
  $("#heroNo").textContent = `No. ${pad3(n)}`;
  $("#heroDate").textContent = `${CONFIG.brand} #${pad3(n)} · ${longDate(state.dateKey)}${isToday() ? "" : isPreview() ? " · Preview" : " · Archive"}`;
  let bar = $("#previewBar");
  if (isPreview()) {
    if (!bar) { bar = document.createElement("div"); bar.id = "previewBar"; bar.className = "preview-bar"; $("#stage").before(bar); }
    bar.innerHTML = `👀 Preview · No. ${pad3(n)} · ${esc(prettyDate(state.dateKey))} · progress isn't saved <a href="loadingzone.html#preview">Loading zone</a> <a href="#" id="previewExit">Exit</a>`;
    $("#previewExit").onclick = e => { e.preventDefault(); goToday(); }; setTimeout(fitStage, 0);
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

function showUnscheduled(key) {
  state.puzzle = null; state.game = null; state.busy = false; state.pin = null;
  const vid = $("#video"); try { vid.pause(); } catch {}
  $("#stage").classList.add("hidden"); $("#result").classList.add("hidden"); $(".under-card").classList.add("hidden");
  showView("play"); renderHero();
  $("#heroKind").textContent = "No puzzle";
  $("#question").textContent = "Nothing scheduled";
  document.title = "WhereIsShe.gg · Nothing scheduled";
  const empty = $("#emptyDay"); empty.classList.remove("hidden");
  $("#emptyDayText").textContent = `No puzzle is pinned for ${prettyDate(key)}.`;
  setHash(linkHash()); window.scrollTo({ top: 0 });
}
function openPuzzle(p) {
  if (!p) return showUnscheduled(state.dateKey);
  $("#emptyDay").classList.add("hidden"); $(".under-card").classList.remove("hidden");
  state.puzzle = p; state.busy = false; state.pin = null;
  showView("play"); renderHero(); $("#result").classList.add("hidden"); $("#stage").classList.remove("hidden");
  setHash(linkHash());
  const saved = getResult();
  state.game = saved ? { ...saved } : { rounds: [], cur: 0, done: false, adSeen: false };
  ensureMap();
  const g = state.game;
  // Resume only this puzzle's own progress, and always at a playable point: never re-open an old guess's reveal map.
  if (g.done) { g.adSeen = true; showRound(CONFIG.rounds - 1, true); showResults(false); }
  else {
    // A new daily or archive session (round 1, nothing guessed yet). Resumes and Loading Zone previews are not starts.
    if (!isPreview() && !(g.rounds && g.rounds.length)) track("game_started");
    showRound(g.rounds.length, false);                     // next unguessed round (round 1 on a fresh game)
  }
  window.scrollTo({ top: 0 });
}
function showRound(i, revealed) {
  const p = state.puzzle, g = state.game, r = p.rounds[i]; g.cur = i; state.pin = null;
  $("#heroKind").textContent = `Round ${i + 1} / ${CONFIG.rounds}`;
  $("#question").textContent = dayTitle(p);   // v10: the day code ("she-001 · No. 001"); name/handle only on the Meet card
  document.title = `WhereIsShe.gg · ${p.id}`;
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
    vid.setAttribute("aria-label", `Round ${i + 1} video. ${whereQ()}.`);
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
    img.classList.add("loading"); img.onload = () => { img.classList.remove("loading"); fitMedia(); }; img.src = r.img; img.alt = `Round ${i + 1} photo. ${whereQ()}.`;
    $("#media").style.setProperty("--media-bg", `url("${r.img}")`);   // blurred fill behind the contain-fit photo
  }
  setTimeout(() => preloadNext(i), 1200);
}
function setMuteLabel() {
  const v = $("#video"), b = $("#muteBtn");
  b.innerHTML = v.muted ? `<span class="mi" aria-hidden="true">🔇</span><span class="mt">Tap for sound</span>` : `<span class="mi" aria-hidden="true">🔊</span><span class="mt">Sound on</span>`;
  b.setAttribute("aria-pressed", String(!v.muted)); b.setAttribute("aria-label", v.muted ? "Sound off. Tap for sound" : "Sound on. Tap to mute");
  b.classList.toggle("on", !v.muted); setSoundBtn();
}
// a brief pulse when a muted video round starts, so the control is noticed
function pulseMute() { const b = $("#muteBtn"); b.classList.remove("pulse"); if (!$("#video").muted) return; void b.offsetWidth; b.classList.add("pulse"); }
function toggleMute() {
  const v = $("#video"); v.muted = !v.muted; settings.sound = !v.muted; saveSettings();   // remembered across rounds and days
  if (v.paused) v.play().catch(() => {}); $("#muteBtn").classList.remove("pulse"); setMuteLabel();
}
// phones: size the stage to what's left of the first screen (top bar + ad above it can change, e.g. Premium removes the ad)
function fitStage() {
  const st = $("#stage"); if (!st || st.classList.contains("hidden") || $("#playView").classList.contains("hidden")) return;
  const t = Math.round(st.getBoundingClientRect().top + scrollY), cur = document.documentElement.style.getPropertyValue("--stage-top");
  if (cur !== t + "px") { document.documentElement.style.setProperty("--stage-top", t + "px"); if (typeof fitMedia === "function") try { fitMedia(); } catch {} if (map) map.invalidateSize(); }
}
// top-bar sound toggle (works on photo rounds too: it sets the default for the next clip)
function toggleSound() {
  const v = $("#video");
  if (!v.classList.contains("hidden")) return toggleMute();
  settings.sound = !settings.sound; saveSettings(); setSoundBtn(); toast(settings.sound ? "🔊 Sound on for video rounds" : "🔇 Sound off");
}
function setSoundBtn() {
  const b = $("#soundBtn"); if (!b) return; const v = $("#video"), on = !v.classList.contains("hidden") ? !v.muted : !!settings.sound;
  b.querySelector(".tb-ic").textContent = on ? "🔊" : "🔇"; b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "Sound on. Tap to mute" : "Sound off. Tap for sound"); b.classList.toggle("on", on);
}

function submitGuess() {
  const p = state.puzzle, g = state.game; if (!state.pin || state.busy || g.rounds.length > g.cur) return;
  const r = p.rounds[g.cur], dist = haversineKm(state.pin, r), pts = scoreFor(dist);
  g.rounds.push({ lat: +state.pin.lat.toFixed(5), lng: +state.pin.lng.toFixed(5), dist: +dist.toFixed(3), pts });
  if (g.rounds.length === CONFIG.rounds) {
    g.done = true; g.total = totalOf(g); g.emoji = g.rounds.map(x => band(x.dist)[1]).join("");
    // won = a perfect day or all greens (every pin under 100 km; a full-score pin is inside that).
    if (!isPreview()) track("game_completed", { won: g.rounds.every(x => band(x.dist)[1] === "🟩"), guesses: g.rounds.length });
    if (isToday()) recordStats(g);
    if (!isPreview()) CommunityStats.submit({ puzzleId: p.id, day: state.dateKey, mode: state.mode, total: g.total, rounds: g.rounds }).catch(() => {});
  }
  setResult(g); revealRound(g.cur, true);
  if (g.done && !isPreview()) cloudAfterGame();   // v11: sync after each finished game (signed-in players only)
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
  // Featured days: no handle / IG link until the traveler card after round 5
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
  if (CONFIG.interstitialBeforeResults && !g.adSeen && !isPremium()) showInterstitial(finish); else finish();   // Premium: no ad
}

// ================================================================ interstitial
function showInterstitial(done) {
  const ov = $("#interstitial"), btn = $("#skipAd"); let s = CONFIG.interstitialSeconds; state.busy = true;
  ov.classList.remove("hidden"); btn.disabled = true; btn.textContent = `Skip in ${s}`;
  renderInterstitialAd();   // AdSense unit when CONFIG.ads is on (placeholder otherwise / if blocked)
  const t = setInterval(() => { s--; if (s <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = "See results ✕"; } else btn.textContent = `Skip in ${s}`; }, 1000);
  btn.onclick = () => { if (btn.disabled) return; clearInterval(t); ov.classList.add("hidden"); state.busy = false; done(); };
}

// ================================================================ results
function titleFor(t) { const f = t / maxTotal(); return f >= .9 ? "Pin-perfect 🌍" : f >= .7 ? "Great eye! 👀" : f >= .45 ? "Solid trip ✈️" : f >= .2 ? "Scenic route 🗺️" : "Lost in transit 😅"; }
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
  $("#nextBtn").textContent = state.mode === "archive" ? "Back to archive →" : isPreview() ? "Back to loading zone →" : "Play past days →";
  renderCommunity(p, t);
  renderPlatforms(p, g);   // reward staircase. Total points, same number as the score card. Partial days are not ranked.
  renderCrossPromo();   // daily results only; the pre-results interstitial is a separate step and already finished
  $("#result").classList.remove("hidden");
  drawSummary(p, g);
  if (scroll) setTimeout(() => $("#result").scrollIntoView({ behavior: "smooth", block: "start" }), 80);
}
function meetAvatar(f) {
  const initial = esc((f.name || f.handle || "?").slice(0, 1).toUpperCase());
  if (!f.avatar) return `<div class="mh-av">${initial}</div>`;
  return `<div class="mh-av has-photo"><img alt="" src="${esc(f.avatar)}" data-fallback="${initial}"></div>`;
}
function renderMeetHer(p) {
  const box = $("#meetHer"), f = p.featured, w = W(p);
  if (f) {
    box.innerHTML = `<div class="mh-k">Today's traveler</div><div class="mh-row">${meetAvatar(f)}
      <div><div class="mh-name">${esc(f.name || "@" + f.handle)}</div><div class="mh-handle">@${esc(f.handle)}</div></div>
      <a class="pill-btn primary mh-btn" id="meetHerLink" href="${esc(f.igUrl)}" target="_blank" rel="noopener">Instagram ↗</a></div>
      <p class="mh-note">Featured with ${w.subj === "she" ? "her" : w.subj === "he" ? "his" : "their"} consent${f.consentOn ? ` (opted in ${esc(f.consentOn)})` : ""}. We never pin a home address.</p>`;
    const img = box.querySelector(".mh-av img");
    if (img) img.onerror = () => { const slot = img.parentElement; if (!slot) return; slot.classList.remove("has-photo"); slot.textContent = img.dataset.fallback || ""; };
  } else {
    box.innerHTML = `<div class="mh-k">Today's traveler</div><p class="mh-note">No traveler is linked to this day.</p><a class="link-btn" href="#optin">Want to be featured? Opt in →</a>`;
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
  badge.textContent = "…";
  let data = null; try { data = await CommunityStats.fetch(p.id, state.dateKey, total); } catch {}
  if (!data) {
    badge.textContent = "Coming soon";
    body.innerHTML = `No player data yet.` +
      ["Round 1", "Round 2", "Round 3", "Round 4", "Round 5"].map(n => `<div class="crow" aria-hidden="true"><span class="cn">${n}</span><span class="cb"><i style="width:0"></i></span><span class="cp">–</span></div>`).join("");
    return;
  }
  badge.textContent = `${n0(data.players)} players`;
  const bars = (data.perRoundAvg || []).slice(0, 5).map((avg, i) => {
    const w = Math.max(0, Math.min(100, Math.round(+avg / CONFIG.maxRoundScore * 100)));
    return `<div class="crow"><span class="cn">Round ${i + 1}</span><span class="cb"><i style="width:${w}%"></i></span><span class="cp">${n0(avg)}</span></div>`;
  }).join("");
  body.innerHTML = `<p class="community-lead">You beat <b>${data.pctBeaten}%</b> of players. Average score ${n0(data.avgTotal)}.</p>${bars}`;
}

// ================================================================ platforms reward
// Metric: total points for a finished 5-round day (sum of round scores, max 25,000).
// That is the number on the score card, in the share text, and in stats. Distance is
// per round, so it is not the ranking. A partial game (under 5 scored rounds) is not
// compared — those points are not a full day.
// The field is community-distribution.js: a seeded stand-in, blended with real
// finishes peeled out of the public snapshot when one exists. COMMUNITY_REAL_TAKEOVER
// is the handoff. Until that many real plays are in, the percent is partly synthetic.
function realScoresFromSnapshot(row, puzzleId, dayKey) {
  if (!row || !window.CommunityDistribution) return [];
  let seedHist = [];
  try { seedHist = communitySeed(puzzleId, dayKey).histogram; } catch { seedHist = []; }
  return CommunityDistribution.realScoresFromSnapshot(row, seedHist);
}
function figureSvg(opts) {
  const you = !!opts.you;
  const pose = opts.pose || "stand";
  const arms = pose === "cheer" ? "M7.6 16.2 L1.6 9.2 M16.4 16.2 L22.4 9.2"
    : pose === "wave" ? "M8.2 16 L3.6 24.2 M15.6 15.2 L21.4 6.4"
    : "M8.2 16 L4.2 24.4 M15.8 16 L19.8 24.4";
  const cls = you ? "platforms-figure player-figure" : "platforms-figure";
  const tier = you && opts.tier ? ` data-tier="${opts.tier}"` : "";
  return `<svg class="${cls}"${tier} viewBox="0 0 24 36" aria-hidden="true" focusable="false"><circle cx="12" cy="6.6" r="4.1"></circle><path class="pf-limb" d="${arms}"></path><path class="pf-body" d="M8.1 12.8 h7.8 l-1 10.6 H9.1 z"></path><path class="pf-limb" d="M10.1 23.2 l-1.7 10.4 M13.9 23.2 l1.7 10.4"></path></svg>`;
}
function confettiHtml(tier) {
  const n = tier === "high" ? 12 : tier === "mid" ? 6 : 3;
  const reach = tier === "high" ? 22 : tier === "mid" ? 14 : 8;
  const colors = ["#FFE48A", "#3B5BFF", "#16B364", "#F5B82E", "#FFFFFF", "#8EA2FF"];
  let html = "";
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = Math.round((t - 0.5) * reach * 2.1);
    const lift = Math.max(0.4, 1 - Math.abs(t - 0.5) * 1.2);
    const y = Math.round(-8 - lift * reach);
    const delay = (0.2 + (i % 5) * 0.05).toFixed(2);
    const dur = (tier === "low" ? 0.85 : tier === "mid" ? 1.05 : 1.25).toFixed(2);
    const rot = i % 2 ? 150 : -130;
    html += `<i class="platforms-confetti" style="--x:${x}px;--y:${y}px;--delay:${delay}s;--dur:${dur}s;--rot:${rot}deg;background:${colors[i % colors.length]}"></i>`;
  }
  return html;
}
function platformsMarkup(cmp) {
  const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cols = [];
  for (let i = 0; i < cmp.n; i++) {
    const t = cmp.n <= 1 ? 1 : i / (cmp.n - 1);
    const you = i === cmp.bandIndex;
    const crowd = Math.max(0, (cmp.figures[i] || 0) - (you ? 1 : 0));
    const pose = !you ? "stand" : cmp.tier === "high" ? "cheer" : cmp.tier === "mid" ? "wave" : "stand";
    const people = [];
    const left = Math.floor(crowd / 2), right = crowd - left;
    for (let k = 0; k < left; k++) people.push(figureSvg({}));
    if (you) people.push(figureSvg({ you: true, pose, tier: cmp.tier }));
    for (let k = 0; k < right; k++) people.push(figureSvg({}));
    const marker = you ? `<div class="you-marker"><span>You!</span><i aria-hidden="true"></i></div>` : "";
    const confetti = you && motion ? confettiHtml(cmp.tier) : "";
    cols.push(`<div class="platform${you ? " is-you" : ""}" style="--t:${t.toFixed(4)}" data-band="${i}"><div class="platform-people">${marker}${people.join("")}${confetti}</div><div class="platform-block"></div></div>`);
  }
  const note = cmp.seeded ? `<p class="platforms-note">Stand-in scores until more finished games are counted.</p>` : "";
  return `<p class="platforms-kicker">Where you stand</p><div class="platforms-stage" role="img" aria-label="You are on platform ${cmp.bandIndex + 1} of ${cmp.n}, better than ${cmp.percent}% of players.">${cols.join("")}</div><p class="platforms-caption">Better than ${cmp.percent}% of players</p>${note}`;
}
function paintPlatforms(root, total, synthetic, real) {
  const cmp = CommunityDistribution.compareScore(total, synthetic, real);
  const sig = [cmp.percent, cmp.n, cmp.bandIndex, cmp.tier, cmp.seeded ? 1 : 0, real.length].join(":");
  if (root.dataset.sig === sig) return cmp;
  root.dataset.sig = sig;
  root.dataset.percent = String(cmp.percent);
  root.dataset.n = String(cmp.n);
  root.dataset.band = String(cmp.bandIndex);
  root.dataset.tier = cmp.tier;
  root.dataset.seeded = cmp.seeded ? "1" : "0";
  root.innerHTML = platformsMarkup(cmp);
  return cmp;
}
async function renderPlatforms(p, game) {
  const seedOnly = !!renderPlatforms.seedOnly;
  const root = $("#platforms");
  const CD = window.CommunityDistribution;
  if (!root || !CD || !p) return;
  const seq = ++renderPlatforms.seq;
  root.classList.remove("hidden");
  const total = CD.finishedTotal(game, CONFIG.rounds);
  if (total == null) {
    root.dataset.sig = "partial";
    delete root.dataset.percent;
    root.innerHTML = `<p class="platforms-kicker">Where you stand</p><p class="platforms-caption">Finish all five rounds to see where you stand.</p>`;
    return;
  }
  const dayKey = state.dateKey || "undated";
  const synthetic = CD.syntheticScores(p.id, dayKey);
  root.dataset.sig = "";
  paintPlatforms(root, total, synthetic, []);
  if (seedOnly) return;
  const pending = CommunityStats.snapshot(p.id, dayKey).catch(() => null);
  const quick = await Promise.race([pending, new Promise(r => setTimeout(() => r(undefined), 800))]);
  if (seq !== renderPlatforms.seq) return;
  const apply = row => {
    if (!row || seq !== renderPlatforms.seq) return;
    paintPlatforms(root, total, synthetic, realScoresFromSnapshot(row, p.id, dayKey));
  };
  if (quick) apply(quick);
  else pending.then(apply).catch(() => {});
}
renderPlatforms.seq = 0;
// Localhost only: open the real results screen on a finished total, for screenshots.
function debugResults(opts) {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return null;
  opts = opts || {};
  const p = state.puzzle;
  if (!p) return null;
  const total = Math.max(0, Math.min(25000, Math.round(+opts.total || 0)));
  const share = Math.floor(total / CONFIG.rounds);
  const rounds = p.rounds.map(r => ({ lat: r.lat, lng: r.lng, dist: 800, pts: share }));
  rounds[rounds.length - 1].pts += total - share * CONFIG.rounds;
  state.game = { rounds, cur: CONFIG.rounds - 1, done: true, adSeen: true, total };
  const wel = $("#welcome"); if (wel) wel.classList.add("hidden");
  const inter = $("#interstitial"); if (inter) inter.classList.add("hidden");
  state.busy = false;
  $("#stage").classList.add("hidden");
  renderPlatforms.seedOnly = !!opts.seedOnly;
  showResults(false);
  renderPlatforms.seedOnly = false;
  const el = $("#platforms");
  if (el) setTimeout(() => el.scrollIntoView({ block: "center", behavior: "instant" }), 40);
  return el ? { percent: +el.dataset.percent, n: +el.dataset.n, band: +el.dataset.band, tier: el.dataset.tier, total } : null;
}
function platformScoreForPercent(target) {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return null;
  const CD = window.CommunityDistribution, p = state.puzzle;
  if (!CD || !p) return null;
  const synth = CD.syntheticScores(p.id, state.dateKey || "undated");
  const blend = CD.blendSamples(synth, []);
  let best = 0, bestPct = 0, bestDiff = 1e9;
  for (let t = 0; t <= 25000; t += 25) {
    const pct = CD.percentBeaten(t, blend);
    const d = Math.abs(pct - target);
    if (d < bestDiff || (d === bestDiff && pct >= target && bestPct < target)) { best = t; bestPct = pct; bestDiff = d; }
  }
  return { total: best, percent: bestPct };
}

// ================================================================ stats (today's daily only)
function recordStats(g) {
  const s = load(LS.stats, { played: 0, sum: 0, best: 0, streak: 0, bestStreak: 0, lastDay: null, dist: {} });
  const dn = dayNumber(state.dateKey); if (s.lastDay === dn) return;
  if (!s.days) s.days = s.played ? ledgerFromResults(load(LS.results, {})) : {};   // v11 per-day ledger: lets two devices' stats merge
  s.days[dn] = g.total;
  s.streak = s.lastDay === dn - 1 ? s.streak + 1 : 1; s.bestStreak = Math.max(s.bestStreak || 0, s.streak); s.lastDay = dn; s.played++;
  s.sum += g.total; s.best = Math.max(s.best, g.total);
  const k = g.total >= 20000 ? "20k–25k" : g.total >= 15000 ? "15k–20k" : g.total >= 10000 ? "10k–15k" : g.total >= 5000 ? "5k–10k" : "0–5k";
  s.dist[k] = (s.dist[k] || 0) + 1; save(LS.stats, s);
}
function currentStreak() { const s = load(LS.stats, null); if (!s) return 0; const dn = dayNumber(todayKey()); return (s.lastDay === dn || s.lastDay === dn - 1) ? s.streak : 0; }

// ================================================================ sharing
function shareUrl() { return CONFIG.siteUrl.replace(/#.*$/, "") + linkHash(); }
function shareTitle() { return `${CONFIG.brand} #${pad3(dayNumber(state.dateKey) + 1)}`; }
function challengeText() { return `${shareTitle()} 📍\nFive travel photos. Where in the world were they taken?\n${shareUrl()}`; }
function resultText() {
  const g = getResult(); if (!g || !g.done) return "";
  return `${shareTitle()} 📍 ${n0(totalOf(g))}/${n0(maxTotal())}\n${g.rounds.map(x => band(x.dist)[1]).join("")}\n${shareUrl()}`;
}
async function doShare(text) {
  if (!text) return; track("share_clicked"); window.__lastShare = text;
  if (navigator.share && matchMedia("(pointer:coarse)").matches) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(text); toast("Copied to clipboard!"); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied to clipboard!"); } catch { prompt("Copy this:", text); } ta.remove(); }
}

// ================================================================ views / navigation
function showView(v) {
  $("#playView").classList.toggle("hidden", v !== "play"); $("#archiveView").classList.toggle("hidden", v !== "archive"); $("#optinView").classList.toggle("hidden", v !== "optin");
  const tab = v === "optin" ? "" : v === "archive" ? "archive" : state.mode === "archive" ? "archive" : "today";
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === tab));
  if (v !== "play") setDock("mini");      // never leave a fixed map overlay on top of another view
  if (v === "play") fitStage();
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
// v11: Practice is gone. An old "#p=<id>" link opens the latest past day that played that puzzle (else today).
function goLegacyPuzzle(id) {
  for (let n = dayNumber(todayKey()); n >= 0; n--) { const k = keyFromDay(n), p = puzzleForDate(k); if (p && p.id === id) return goDate(k); }
  goToday();
}
const whoHint = () => "Name and profile appear after the last round.";   // in-game reminder (handle only on the traveler card)
const dayLabel = p => p.featured ? `Featured day · ${whoHint(p)}` : "Custom day";
function goArchive() {
  showView("archive"); setHash("#archive");
  const today = todayKey(), last = dayNumber(today), rows = [];
  for (let n = last; n >= 0; n--) {          // only today and earlier; future dailies are never listed
    const key = keyFromDay(n), p = puzzleForDate(key);
    const when = n === last ? "Today" : prettyDate(key).replace(/, \d{4}$/, "");
    if (!p) { rows.push(`<li><button class="arch ${n === last ? "today" : ""}" data-key="${key}"><span class="an">#${pad3(n + 1)}<small>${when}</small></span><span class="aq">Nothing scheduled<small>No puzzle pinned</small></span></button></li>`); continue; }
    const mine = savedFor(keyFor("archive", key, p), p);
    const badge = mine && mine.done ? `<span class="ar done">${n0(mine.total ?? totalOf(mine))}</span>` : mine && mine.rounds?.length ? `<span class="ar">${mine.rounds.length}/5</span>` : `<span class="ar">Play →</span>`;
    rows.push(`<li><button class="arch ${n === last ? "today" : ""}" data-key="${key}" data-id="${esc(p.id)}"><span class="an">#${pad3(n + 1)}<small>${when}</small></span>
      <span class="aq">📍 ${esc(p.id)}<small>${esc(dayLabel(p))}</small></span>${badge}</button></li>`);
  }
  $("#archiveList").innerHTML = rows.join("");
  $$(".arch").forEach(b => b.onclick = () => goDate(b.dataset.key));
  window.scrollTo({ top: 0 });
}
function next() { if (state.mode === "archive") goArchive(); else if (isPreview()) location.href = "loadingzone.html#preview"; else goArchive(); }

// ================================================================ opt-in ("Feature me") + removal
function goOptin() { showView("optin"); setHash("#optin"); setupFeatureForm(); window.scrollTo({ top: 0 }); }
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
function openModal(html, kind = "") { $("#modalBody").innerHTML = html; $("#modal").dataset.kind = kind; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
function statsModal() {
  const s = load(LS.stats, { played: 0, sum: 0, best: 0, dist: {} });
  const order = ["20k–25k", "15k–20k", "10k–15k", "5k–10k", "0–5k"];
  const dist = s.played ? order.map(k => { const v = s.dist?.[k] || 0; return `<div class="crow"><span class="cn">${k}</span><span class="cb"><i style="width:${v / Math.max(1, s.played) * 100}%"></i></span><span class="cp">${v}</span></div>`; }).join("")
    : "<p style='color:var(--muted)'>Play today's puzzle to start your stats.</p>";
  openModal(`<h2>Your stats</h2><div class="stat-grid"><div><b>${s.played}</b><span>Played</span></div><div><b>${s.played ? n0(s.sum / s.played) : "–"}</b><span>Average</span></div><div><b>${currentStreak()}</b><span>Streak</span></div><div><b>${s.best ? n0(s.best) : "–"}</b><span>Best</span></div></div>
    <h3>Daily scores</h3>${dist}<p style="font-size:12px;color:var(--muted)">Only today's daily counts. ${Cloud.user ? "Stats live in this browser and sync to your account." : "Stats live in this browser (localStorage)."}</p>
    ${accountsOn() && !Cloud.user ? `<button class="link-btn" id="statsSignIn" type="button">☁️ Sign in to keep them on all your devices</button>` : ""}`);
  if ($("#statsSignIn")) $("#statsSignIn").onclick = () => accountModal();
}
function menuModal() {
  openModal(`<h2>Settings &amp; more</h2><div class="menu-list">
    <button id="mArchive">🗓 Archive<small>Every past daily</small></button>
    ${accountsOn() ? `<button id="mAccount">${Cloud.user ? "👤 Your account" : "👤 Sign in"}<small>${Cloud.user ? esc(Cloud.user.email || "") : "Optional: sync stats across devices"}</small></button>` : ""}
    ${premiumOn() ? `<button id="mPremium">⭐ ${isPremium() ? "Premium" : "Go Premium"}<small>${isPremium() ? "No ads · priority review" : "No ads + priority review for submissions"}</small></button>` : ""}
    <button id="mOptin">📷 Feature me<small>${submissionsOn() ? "Submit your own travel photos to be featured" : "Opt in to be featured in a future puzzle"}</small></button>
    <button id="mSettings">⚙️ Settings<small>Theme, load a puzzle file</small></button>
    <button id="mHow">❓ How to play</button>
    <button id="mAbout">📚 About &amp; photo credits</button>
    <button id="mClear">🧹 Clear my game data<small>Progress, scores, streak and settings in this browser</small></button></div>`);
  $("#mArchive").onclick = () => { closeModal(); goArchive(); }; $("#mSettings").onclick = settingsModal;
  $("#mHow").onclick = howModal; $("#mAbout").onclick = aboutModal; $("#mOptin").onclick = () => { closeModal(); goOptin(); };
  $("#mClear").onclick = clearDataModal;
  if ($("#mAccount")) $("#mAccount").onclick = () => accountModal();
  if ($("#mPremium")) $("#mPremium").onclick = premiumModal;
}
// "Clear my game data": confirm, then drop every WhereIsShe key from this browser (the marking tool's wis.mark.* is a
// separate page and is kept), and reload from a clean URL so the app starts fresh on today's daily.
// ---- v10 first-visit welcome card (sound default). Ranki cross-promo is renderCrossPromo() on daily results.
function countVisit() {   // one per browser session (reloads in the same tab don't count)
  try { if (sessionStorage.getItem("wis.visitCounted")) return load(LS.visits, 0); sessionStorage.setItem("wis.visitCounted", "1"); } catch {}
  const n = (+load(LS.visits, 0) || 0) + 1; save(LS.visits, n); return n;
}
const welcomeDone = () => !!load(LS.welcome, null);
function showWelcome() {
  $("#welSub").innerHTML = `Every day, 5 photos and clips from one trip somewhere on Earth.<br>Look for clues and guess where each one was taken.`;
  $("#welcome").classList.remove("hidden"); document.body.classList.add("welcome-open"); setTimeout(() => $("#welSoundOn").focus(), 50);
}
function chooseSound(choice) {   // a click = user gesture, so unmuted playback of the first clip is allowed right here
  settings.sound = choice === "on"; saveSettings(); save(LS.welcome, { choice, at: Date.now() });
  $("#welcome").classList.add("hidden"); document.body.classList.remove("welcome-open");
  const v = $("#video");
  if (!v.classList.contains("hidden")) { v.muted = !settings.sound; setMuteLabel(); pulseMute(); vidPlay(); }
}
// wis.promo.v1: { clickedAt } never again, { dismissedAt, dismissUntil } is the "Not now" snooze.
// A legacy { at } stamp from the unshipped visit modal is ignored. Once per tab: sessionStorage wis.promo.session.
const PROMO_SESSION = "wis.promo.session";
const promoCfg = () => Object.assign({}, CONFIG.crossPromo, window.__WIS_PROMO_TEST__ || {});   // devtools override only; unset in production
function promoRecord() { const v = load(LS.promo, null); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
function promoUrl(url) { try { const u = new URL(url, location.href); if (u.protocol === "https:" || u.protocol === "http:") return u.href; } catch {} return ""; }
function promoNum(v, d) { return Number.isFinite(+v) ? +v : d; }
function promoSessionSeen() { try { return sessionStorage.getItem(PROMO_SESSION) === "1"; } catch { return false; } }
function markPromoSession() { try { sessionStorage.setItem(PROMO_SESSION, "1"); } catch {} }
function crossPromoCheck() {   // why the results card would or wouldn't show on the next render (test hook)
  const c = promoCfg();
  if (!c.enabled) return "disabled";
  if (!promoUrl(c.url)) return "no url";
  if (isPreview()) return "preview";                 // ?preview= and the Loading Zone Play sandbox
  if (!isToday()) return "not daily";                // archive, and Practice if it ever returns
  if (!state.game || !state.game.done) return "not finished";
  const played = +(load(LS.stats, null) || {}).played || 0;
  if (played < promoNum(c.minPlayed, 5) && currentStreak() < promoNum(c.minStreak, 3)) return "threshold";
  const rec = promoRecord();
  if (rec.clickedAt) return "clicked";
  if (rec.dismissUntil && Date.now() < +rec.dismissUntil) return "snoozed";
  if (promoSessionSeen()) return "session";
  return "show";
}
function renderCrossPromo() {
  const el = $("#crossPromo"); if (!el) return;
  if (crossPromoCheck() !== "show") { el.classList.add("hidden"); return; }
  const c = promoCfg(), go = $("#crossPromoGo");
  $("#crossPromoTitle").textContent = c.title || "From the same creator";
  $("#crossPromoBody").textContent = c.blurb || "";
  go.href = promoUrl(c.url); go.target = "_blank"; go.rel = "noopener"; go.textContent = c.cta || "Play Ranki →";
  $("#crossPromoDismiss").textContent = c.dismiss || "Not now";
  el.classList.remove("hidden"); markPromoSession();
}
function onCrossPromoGo() {   // they already went: don't nag again, including a middle-click
  save(LS.promo, { ...promoRecord(), clickedAt: Date.now() }); markPromoSession();
  const el = $("#crossPromo"); if (el) el.classList.add("hidden");
}
function onCrossPromoDismiss() {
  const days = promoNum(promoCfg().snoozeDays, 7), now = Date.now();
  save(LS.promo, { ...promoRecord(), dismissedAt: now, dismissUntil: now + days * 864e5 });
  markPromoSession(); $("#crossPromo").classList.add("hidden");
}
function wisKeys(store) { const out = []; try { for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k && k.startsWith("wis.") && !k.startsWith("wis.mark.")) out.push(k); } } catch {} return out; }
function clearGameData() {
  [localStorage, sessionStorage].forEach(st => { try { wisKeys(st).forEach(k => st.removeItem(k)); } catch {} });
  location.replace(location.pathname + "?cleared=" + Date.now());
}
function clearDataModal() {
  openModal(`<h2>Clear my game data?</h2>
    <p>This removes your WhereIsShe progress, scores, streak, stats and settings from this browser${Cloud.user ? " and signs you out here (your account's synced copy stays)" : ""}. It can't be undone.</p>
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
function howModal() {
  openModal(`<h2>How to play</h2>
   <p>Every day there are <b>5 photos</b> of the same person somewhere in the world. For each one, tap the map to drop your pin, then hit <b>Guess</b>.</p>
   <p>You'll see the real place, how far off you were, and your points: up to <b>5,000</b> per round, so <b>25,000</b> max. Anywhere within <b>${CONFIG.fullScoreRadiusKm} km</b> of the real spot is a perfect 5,000; further out, the closer you are the more you score.</p>
   <p>🟩 under 100 km · 🟨 under 500 km · 🟧 under 2,000 km · 🟥 further.</p>
   <p>Everyone featured has opted in. We never pin a home address.</p>
   <p>A new daily drops at local midnight. Missed one? It's in the Archive.</p>`);
}
function aboutModal() {
  // no per-round credits here: they would spoil the answers and name the featured woman before round 5
  openModal(`<h2>About &amp; credits</h2><p style="color:var(--muted);font-size:14px">WhereIsShe is a prototype. Every day features someone who opted in; their photos are used with their permission, and they're credited (with a link to their Instagram) on the traveler card after round 5.</p>
    <p style="font-size:13px"><a href="about.html" target="_blank" rel="noopener">About</a> · <a href="how-to-play.html" target="_blank" rel="noopener">How to play</a> · <a href="terms.html" target="_blank" rel="noopener">Terms</a> · <a href="privacy.html" target="_blank" rel="noopener">Privacy</a> · <a href="refund.html" target="_blank" rel="noopener">Refunds</a></p>
    <p style="font-size:12px;color:var(--muted)">Map data © OpenStreetMap contributors · Basemap: OpenFreeMap / OpenMapTiles (fallback: Esri). Rendering: MapLibre GL JS (BSD-3-Clause). Map library: Leaflet (BSD-2-Clause).</p>`);
}

// ================================================================ v11: accounts (cross-device sync), Premium, ads, Feature me
// Everything here is behind CONFIG flags and does nothing (no network, no extra scripts, no UI) while they're off.
const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const accountsOn = () => !!(CONFIG.backend.enabled && CONFIG.backend.supabaseUrl && CONFIG.backend.anonKey && !/^sb_secret_/i.test(CONFIG.backend.anonKey));
const premiumOn = () => accountsOn() && !!CONFIG.premium.enabled;
const submissionsOn = () => accountsOn() && !!CONFIG.submissions.enabled;
const googleOn = () => !!(Cloud.providers && Cloud.providers.google);
const adsOn = () => !!(CONFIG.ads.enabled && CONFIG.ads.client);
if (/^sb_secret_/i.test(CONFIG.backend.anonKey || "")) console.error("WhereIsShe: CONFIG.backend.anonKey is a SECRET key. Never ship it; use the publishable key. Accounts disabled.");
const vq = BUILD.startsWith("__") ? "" : "?v=" + BUILD;
const scriptP = {};
function loadScript(src, attrs = {}) {
  return scriptP[src] || (scriptP[src] = new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.async = true;
    Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v)); s.onload = () => res(); s.onerror = () => { delete scriptP[src]; s.remove(); rej(new Error("couldn't load " + src)); }; document.head.appendChild(s); }));
}
const Cloud = { sb: null, providers: {}, session: null, user: null, profile: null, state: "off", syncing: null, again: false, watch: 0 };

// ---- merging (local-first: localStorage stays the source of truth; the cloud row is merged in, never blindly copied)
const statsDefault = () => ({ played: 0, sum: 0, best: 0, streak: 0, bestStreak: 0, lastDay: null, dist: {}, days: {} });
const distKey = t => t >= 20000 ? "20k–25k" : t >= 15000 ? "15k–20k" : t >= 10000 ? "10k–15k" : t >= 5000 ? "5k–10k" : "0–5k";
// pre-v11 stats have no per-day ledger: rebuild it from saved dailies that were finished on their own day (= counted)
function ledgerFromResults(results) {
  const days = {};
  for (const [k, r] of Object.entries(results || {})) {
    const m = k.match(/^d:(\d{4}-\d{2}-\d{2}):/); if (!m || !r || !r.done || !r.at || !Array.isArray(r.rounds)) continue;
    if (keyOf(new Date(r.at)) !== m[1]) continue;
    const t = isFinite(r.total) ? r.total : r.rounds.reduce((s, x) => s + (x.pts || 0), 0), dn = dayNumber(m[1]);
    days[dn] = Math.max(days[dn] ?? -1, t);
  }
  return days;
}
const withLedger = (s, results) => s && s.played && !s.days ? { ...s, days: ledgerFromResults(results) } : s;
function statsFromDays(days) {
  const s = statsDefault(); let run = 0, prev = null;
  Object.keys(days).map(Number).filter(isFinite).sort((a, b) => a - b).forEach(d => { const t = +days[d];
    s.days[d] = t; s.played++; s.sum += t; s.best = Math.max(s.best, t); s.dist[distKey(t)] = (s.dist[distKey(t)] || 0) + 1;
    run = prev !== null && d === prev + 1 ? run + 1 : 1; s.bestStreak = Math.max(s.bestStreak, run); prev = d; });
  s.streak = run; s.lastDay = prev; return s;
}
// union of per-day scores (a day played on two devices counts once, best score), streak recomputed over the union
// (day 1 on the phone + day 2 on the laptop = a 2-day streak); best / best streak / legacy counters never go down.
function mergeStats(a, b) {
  a = a || statsDefault(); b = b || statsDefault();
  const days = {}; [a.days, b.days].forEach(d => d && typeof d === "object" && Object.entries(d).forEach(([k, v]) => { if (isFinite(+k) && isFinite(+v)) days[k] = Math.max(days[k] ?? -1, +v); }));
  const L = statsFromDays(days);
  const big = (b.played || 0) > (a.played || 0) ? b : a;
  if ((big.played || 0) > L.played) { L.played = big.played; L.sum = big.sum || 0; L.dist = { ...(big.dist || {}) }; }
  L.best = Math.max(L.best, a.best || 0, b.best || 0); L.bestStreak = Math.max(L.bestStreak, a.bestStreak || 0, b.bestStreak || 0);
  const last = Math.max(a.lastDay ?? -1, b.lastDay ?? -1);
  if (last > (L.lastDay ?? -1)) { const src = (a.lastDay ?? -1) >= (b.lastDay ?? -1) ? a : b; L.lastDay = src.lastDay; L.streak = src.streak || 0; }
  else if (last >= 0 && last === L.lastDay) L.streak = Math.max(L.streak, ...[a, b].filter(x => x.lastDay === last).map(x => x.streak || 0));
  L.bestStreak = Math.max(L.bestStreak, L.streak); L.v = 2; return L;
}
const okResult = r => r && typeof r === "object" && typeof r.id === "string" && Array.isArray(r.rounds) && r.rounds.length <= CONFIG.rounds;
function pickResult(l, r) {
  if (!okResult(r)) return l; if (!okResult(l)) return r;
  if (!!r.done !== !!l.done) return r.done ? r : l;
  if (l.done) return (l.at || 0) <= (r.at || 0) ? l : r;          // both finished: the first finish counts
  return (r.rounds.length > l.rounds.length) ? r : l;              // both in progress: the further one
}
function mergeResults(a, b) { const out = { ...(a || {}) }; Object.entries(b || {}).forEach(([k, r]) => { const v = pickResult(out[k], r); if (v) out[k] = v; }); return out; }
function mergeSettings(local, cloud) { return cloud && (cloud._at || 0) > (local._at || 0) ? { theme: cloud.theme || local.theme, sound: !!cloud.sound, _at: cloud._at } : null; }

// ---- auth
// A magic-link / Google redirect lands on index.html#access_token=…; take the tokens out of the URL before the router sees it.
const AUTH_REDIRECT = (() => {
  const h = location.hash; if (!/(^#|&)(access_token|error_description)=/.test(h)) return null;
  const q = new URLSearchParams(h.slice(1)); try { history.replaceState(null, "", location.pathname + location.search); } catch {}
  return { access_token: q.get("access_token"), refresh_token: q.get("refresh_token"), error: q.get("error_description") || q.get("error") };
})();
function cloudInit() {
  Cloud.ready = (async () => {
  if (!accountsOn()) return;
  Cloud.state = "loading";
  try { await loadScript("vendor/supabase/supabase.js" + vq); } catch (e) { Cloud.state = "error"; console.warn(e); return; }
  Cloud.sb = window.supabase.createClient(CONFIG.backend.supabaseUrl, CONFIG.backend.anonKey,   // publishable (sb_publishable_…) or legacy anon key
    { auth: { storageKey: LS.auth, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "implicit" } });
  // which sign-in providers are switched on in Supabase (public endpoint): the Google button only shows when Google is enabled
  const providersReady = Promise.race([
    fetch(CONFIG.backend.supabaseUrl.replace(/\/$/, "") + "/auth/v1/settings", { headers: { apikey: CONFIG.backend.anonKey } })
      .then(r => r.ok ? r.json() : {}).then(j => { Cloud.providers = (j && j.external) || {}; }).catch(() => { Cloud.providers = {}; }),
    new Promise(r => setTimeout(r, 4000))]);
  Cloud.sb.auth.onAuthStateChange((ev, session) => setTimeout(() => onAuth(ev, session), 0));    // never await supabase calls inside the callback
  if (AUTH_REDIRECT) {
    if (AUTH_REDIRECT.error) toast("Sign-in didn't work: " + AUTH_REDIRECT.error);
    else if (AUTH_REDIRECT.access_token) { const { error } = await Cloud.sb.auth.setSession({ access_token: AUTH_REDIRECT.access_token, refresh_token: AUTH_REDIRECT.refresh_token }); if (error) toast("Sign-in link expired. Request a new one."); }
  }
  Cloud.state = "ready";
  await providersReady;
  const { data } = await Cloud.sb.auth.getSession(); if (data && data.session) onAuth("INITIAL", data.session); else renderAccountUI();
  window.addEventListener("online", () => { if ((load(LS.sync, {}) || {}).pending) syncNow("online"); });
  window.addEventListener("focus", () => { if (Cloud.user && premiumOn() && !isPremium()) refreshProfile(); });
  })();
  return Cloud.ready;
}
function onAuth(ev, session) {
  Cloud.session = session || null;
  const u = session && session.user;
  if (!u) { if (Cloud.user) { Cloud.user = null; Cloud.profile = null; localStorage.removeItem(LS.premium); applyPremium(); } renderAccountUI(); return; }
  const changed = !Cloud.user || Cloud.user.id !== u.id; Cloud.user = u;
  if (changed) { if (AUTH_REDIRECT && !AUTH_REDIRECT.toasted && (AUTH_REDIRECT.toasted = true)) toast(`Signed in as ${u.email || "you"}`); refreshProfile(); syncNow(ev === "INITIAL" ? "load" : "login"); }
  renderAccountUI();
}
async function signInEmail(email) {
  const { error } = await Cloud.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } });
  return error;
}
async function signInGoogle() { const { error } = await Cloud.sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } }); if (error) toast(error.message); }
async function signOut() { try { await Cloud.sb.auth.signOut(); } catch {} onAuth("SIGNED_OUT", null); save(LS.sync, {}); toast("Signed out. Your stats stay in this browser."); }

// ---- sync: pull, merge into localStorage, push the merged copy. On any error it's retried on the next load / when back online.
function setSync(v) { save(LS.sync, { ...(load(LS.sync, {}) || {}), ...v }); renderAccountUI(); }
async function syncNow(reason) {
  if (!Cloud.user || !Cloud.sb) return false;
  if (Cloud.syncing) { Cloud.again = true; return Cloud.syncing; }
  Cloud.syncing = (async () => {
    setSync({ state: "syncing", reason });
    try {
      const uid = Cloud.user.id;
      const { data: row, error } = await Cloud.sb.from("stats").select("stats,results,settings").eq("user_id", uid).maybeSingle();
      if (error) throw error;
      const lr = load(LS.results, {}), ls = load(LS.stats, null);
      const results = mergeResults(lr, row && row.results);
      const stats = ls || (row && row.stats && row.stats.played) ? mergeStats(withLedger(ls, lr), row && row.stats) : null;
      const ns = mergeSettings(settings, row && row.settings);
      if (ns) { Object.assign(settings, ns); save(LS.settings, settings); applyTheme(); }
      save(LS.results, results); if (stats) save(LS.stats, stats);
      const { error: e2 } = await Cloud.sb.from("stats").upsert({ user_id: uid, results, stats: stats || {}, settings: { theme: settings.theme, sound: !!settings.sound, _at: settings._at || 0 }, version: 1 }, { onConflict: "user_id" });
      if (e2) throw e2;
      setSync({ state: "ok", at: Date.now(), pending: false, err: null });
      afterSyncRefresh();
      return true;
    } catch (e) { setSync({ state: "error", pending: true, err: String((e && e.message) || e) }); return false; }
    finally { Cloud.syncing = null; if (Cloud.again) { Cloud.again = false; setTimeout(() => syncNow("again"), 0); } }
  })();
  return Cloud.syncing;
}
function afterSyncRefresh() {   // a game finished on another device: show it here too (never interrupts a round being played)
  if (!state.puzzle || isPreview() || $("#playView").classList.contains("hidden")) return;
  const saved = getResult(), g = state.game;
  if (saved && g && !g.done && dockMode() !== "reveal" && !state.pin && (saved.done || saved.rounds.length > g.rounds.length)) openPuzzle(state.puzzle);
  if (!$("#archiveView").classList.contains("hidden")) goArchive();
}
function cloudAfterGame() { if (Cloud.user) syncNow("game"); else if (accountsOn()) setSync({ pending: false }); }

// ---- Premium (Lemon Squeezy). premium/premium_until are only ever written by the webhook (service role).
const premiumActive = p => !!(p && p.premium && (!p.premium_until || new Date(p.premium_until).getTime() > Date.now()));
function isPremium() {
  if (!premiumOn()) return false;
  if (Cloud.user && Cloud.profile) return premiumActive(Cloud.profile);
  const c = load(LS.premium, null); let hasSession = false; try { hasSession = !!localStorage.getItem(LS.auth); } catch {}
  return hasSession && !!c && premiumActive(c) && (!Cloud.user || c.uid === Cloud.user.id);   // cached until the profile loads, so ads don't flash
}
async function refreshProfile() {
  if (!Cloud.user || !Cloud.sb) return null;
  const uid = Cloud.user.id;
  const { data, error } = await Cloud.sb.from("profiles").select("premium,premium_until,ls_status").eq("id", uid).maybeSingle();
  if (error || !Cloud.user || Cloud.user.id !== uid) return null;     // signed out / switched account while this was in flight
  Cloud.profile = data || { premium: false, premium_until: null };
  save(LS.premium, { uid, premium: !!Cloud.profile.premium, premium_until: Cloud.profile.premium_until || null, at: Date.now() });
  applyPremium(); renderAccountUI(); return Cloud.profile;
}
let adTopNode = null;
function applyPremium() { setTimeout(fitStage, 0);
  const on = isPremium(); document.documentElement.classList.toggle("is-premium", on);
  const ad = $("#adTop");
  if (on && ad) { adTopNode = ad; ad.remove(); }                                   // Premium: the ad slot is removed, not just hidden
  else if (!on && !ad && adTopNode) { $("#topbar").after(adTopNode); }
}
function checkoutUrl() {
  const u = new URL(CONFIG.premium.checkoutUrl, location.href);
  u.searchParams.set("checkout[custom][user_id]", Cloud.user.id);                  // echoed back to the webhook as meta.custom_data.user_id
  if (Cloud.user.email) u.searchParams.set("checkout[email]", Cloud.user.email);
  u.searchParams.set("embed", "1"); u.searchParams.set("media", "0");
  return u.toString();
}
async function ensureLemon() {
  await loadScript("https://app.lemonsqueezy.com/js/lemon.js");
  if (window.createLemonSqueezy) window.createLemonSqueezy();
  window.LemonSqueezy.Setup({ eventHandler: e => { if (e && e.event === "Checkout.Success") onCheckoutSuccess(); } });
}
async function goPremium() {
  if (!premiumOn()) return;
  if (!Cloud.user) return accountModal("premium");
  if (isPremium()) { toast("You're already Premium ⭐"); return; }
  if (!CONFIG.premium.checkoutUrl) { toast("Premium checkout opens soon"); return; }
  const url = checkoutUrl(); window.__lastCheckout = url;
  try { await ensureLemon(); window.LemonSqueezy.Url.Open(url); } catch { window.open(url, "_blank", "noopener"); }
}
function onCheckoutSuccess() {
  try { window.LemonSqueezy.Url.Close(); } catch {}
  toast("Payment received. Turning on Premium…");
  const t0 = Date.now(); clearInterval(Cloud.watch);
  Cloud.watch = setInterval(async () => {   // the webhook usually lands within seconds
    const p = await refreshProfile();
    if (premiumActive(p)) { clearInterval(Cloud.watch); toast("⭐ Premium is on. No more ads!"); rerenderOpen(); }
    else if (Date.now() - t0 > 90000) { clearInterval(Cloud.watch); toast("Premium is taking a while. It'll switch on as soon as the payment is confirmed."); }
  }, 1500);
}
function rerenderOpen() {
  const m = $("#modal"); if (!m.classList.contains("hidden")) { const k = m.dataset.kind; if (k === "account") accountModal(); else if (k === "premium") premiumModal(); }
  renderFeatureExtras();
}
// ---- AdSense: post-round-5 unit only, never for Premium (the script isn't even loaded); placeholder if no slot / blocked
let interPlaceholder = null;
function ensureAdSense() {
  if (!adsOn() || isPremium()) return Promise.reject(new Error("ads off"));
  return loadScript(`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(CONFIG.ads.client)}`, { crossorigin: "anonymous" });
}
function renderInterstitialAd() {
  const fill = $("#interstitial .inter-fill"); if (interPlaceholder == null) interPlaceholder = fill.innerHTML;
  fill.innerHTML = interPlaceholder;
  if (!adsOn() || !CONFIG.ads.slot || isPremium()) return;
  ensureAdSense().then(() => {
    fill.innerHTML = `<ins class="adsbygoogle" style="display:block;min-height:250px" data-ad-client="${esc(CONFIG.ads.client)}" data-ad-slot="${esc(CONFIG.ads.slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { fill.innerHTML = interPlaceholder; return; }
    setTimeout(() => { const ins = fill.querySelector("ins.adsbygoogle"); if (ins && (ins.dataset.adStatus === "unfilled" || !ins.offsetHeight)) fill.innerHTML = interPlaceholder; }, 3000);
  }).catch(() => { fill.innerHTML = interPlaceholder; });
}

// ---- account UI
function renderAccountUI() {
  const b = $("#accountBtn"); if (!b) return;
  b.classList.toggle("hidden", !accountsOn());
  if (!accountsOn()) return;
  const u = Cloud.user, prem = isPremium();
  b.innerHTML = u ? `<span class="acc-ini">${esc((u.email || "?").slice(0, 1).toUpperCase())}</span>${prem ? '<span class="acc-star">⭐</span>' : ""}`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>`;
  b.title = b.ariaLabel = u ? `Account (${u.email || "signed in"})` : "Sign in to sync your stats";
  renderFeatureExtras();
}
const syncLine = () => { const s = load(LS.sync, {}) || {};
  if (s.state === "syncing") return "Syncing…";
  if (s.state === "error") return `⚠️ Couldn't sync (we'll retry automatically)`;
  if (s.at) return `✓ Synced ${new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`; return "Not synced yet"; };
function accountModal(reason) {
  if (!accountsOn()) return;
  const u = Cloud.user;
  if (!u) {
    openModal(`<div class="acc" data-k="login"><h2>Sign in</h2>
      <p class="acc-sub">Keep your streak, results and settings on every device. <b>Optional:</b> you can always play without an account.</p>
      ${reason === "premium" ? `<div class="notice">⭐ Sign in first, so Premium is tied to your account on every device.</div>` : ""}
      ${googleOn() ? `<button class="acc-google" id="accGoogle" type="button"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.8-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>Continue with Google</button>
      <div class="acc-or"><span>or</span></div>` : ""}
      <form id="accEmailForm" class="optin-form" novalidate><label>Email<input name="email" type="email" placeholder="you@example.com" autocomplete="email" required></label>
      <button class="pill-btn primary" type="submit">Email me a sign-in link</button><p class="form-msg" id="accMsg" aria-live="polite"></p></form>
      <p class="acc-fine">We only use your email to sign you in and, if you submit photos, to reach you about them. <a href="privacy.html" target="_blank" rel="noopener">Privacy</a> · <a href="terms.html" target="_blank" rel="noopener">Terms</a></p></div>`, "account");
    if ($("#accGoogle")) $("#accGoogle").onclick = signInGoogle;
    $("#accEmailForm").onsubmit = async e => { e.preventDefault(); const em = e.target.email.value.trim(), msg = $("#accMsg");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { msg.className = "form-msg bad"; msg.textContent = "Please enter a valid email."; return; }
      msg.className = "form-msg"; msg.textContent = "Sending…"; const err = await signInEmail(em);
      if (err) { msg.className = "form-msg bad"; msg.textContent = /rate|seconds/i.test(err.message) ? "Too many requests. Please wait a minute and try again." : "Couldn't send the link: " + err.message; return; }
      msg.className = "form-msg good"; msg.innerHTML = `📬 Check your inbox at <b>${esc(em)}</b> and tap the link <b>on this device</b> to sign in.`; };
    return;
  }
  const prem = isPremium(), p = Cloud.profile || {};
  openModal(`<div class="acc" data-k="account"><h2>Your account</h2>
    <div class="acc-row"><div class="acc-av">${esc((u.email || "?").slice(0, 1).toUpperCase())}</div><div><b class="acc-email">${esc(u.email || "")}</b><small>Signed in · stats sync across your devices</small></div></div>
    <div class="acc-sync"><span id="accSync">${esc(syncLine())}</span><button class="link-btn" id="accSyncNow" type="button">Sync now</button></div>
    ${premiumOn() ? (prem ? `<div class="acc-plan prem">⭐ <b>Premium</b> · no ads${p.premium_until ? ` · until ${esc(new Date(p.premium_until).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))}` : ""}</div>`
      : `<div class="acc-plan"><span>Free plan</span><button class="pill-btn primary" id="accPremium" type="button">⭐ Go Premium</button></div>`) : ""}
    <div class="confirm-row"><button class="pill-btn ghost" id="accSignOut" type="button">Sign out</button></div></div>`, "account");
  $("#accSyncNow").onclick = async () => { $("#accSync").textContent = "Syncing…"; await syncNow("manual"); if ($("#accSync")) $("#accSync").textContent = syncLine(); };
  $("#accSignOut").onclick = async () => { await signOut(); closeModal(); };
  if ($("#accPremium")) $("#accPremium").onclick = premiumModal;
}
function premiumModal() {
  if (!premiumOn()) return;
  const c = CONFIG.premium, prem = isPremium(), u = Cloud.user;
  const label = prem ? "You're Premium ⭐" : !u ? "Sign in to go Premium" : !c.checkoutUrl ? "Checkout opens soon" : `Go Premium${c.price ? ` · ${esc(c.price)}` : ""}`;
  openModal(`<div class="prem-card" data-k="premium"><div class="prem-badge">⭐ Premium</div><h2>WhereIsShe Premium</h2>
    <div class="prem-price">${c.price ? esc(c.price) : "Price coming soon"}</div>${c.billing ? `<div class="prem-billing">${esc(c.billing)}</div>` : ""}
    <ul class="prem-list"><li><span>🚫</span>No ads: no banner and no ad after round 5</li><li><span>⚡</span>Priority review for your Feature me submissions</li>
      <li><span>☁️</span>On every device you sign in on</li><li><span>❤️</span>Supports a small indie game</li></ul>
    ${c.testMode ? `<p class="prem-test">🧪 Test mode: no real charge. Use the Lemon Squeezy test card 4242 4242 4242 4242.</p>` : ""}
    <button class="pill-btn primary prem-go" id="premGo" type="button" ${prem || (u && !c.checkoutUrl) ? "disabled" : ""}>${label}</button>
    <p class="prem-fine">Renews monthly until you cancel; cancel anytime from your Lemon Squeezy receipt email. Payments are handled by Lemon Squeezy, our merchant of record. <a href="terms.html" target="_blank" rel="noopener">Terms</a> · <a href="refund.html" target="_blank" rel="noopener">Refunds</a> · <a href="privacy.html" target="_blank" rel="noopener">Privacy</a></p></div>`, "premium");
  $("#premGo").onclick = goPremium;
}

// ---- Feature me (v11): links and/or uploads, self-submission only. Login required; the server (submit_feature() + storage RLS)
// enforces: verified email, not banned, honeypot empty, 1 per 24 h, <= 3 pending, <= 10 links, <= 5 files of <= 25 MB image/video.
const FF = { files: [], busy: false };
const FF_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "video/mp4", "video/quicktime", "video/webm"];
const mb = n => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
function checkLink(u) { const s = String(u || "").trim(); if (!s || s.length > 500) return null; let x; try { x = new URL(s); } catch { return null; }
  return x.protocol === "https:" && x.hostname.includes(".") && !x.username && !x.password ? x.toString() : null; }
function setupFeatureForm() {
  const on = submissionsOn();
  $("#optinForm").classList.toggle("hidden", on); $("#featureDone").classList.add("hidden");
  if (!on) { $("#featureForm").classList.add("hidden"); $("#ffGate").classList.add("hidden"); return; }
  $("#optinSub").textContent = "Want to be featured? Send us your own travel photos and clips, as links, uploads, or both. We review every submission by hand.";
  if (!$("#ffLinks").children.length) addLinkRow();
  renderFeatureExtras();
}
function addLinkRow(v = "") {
  const box = $("#ffLinks"); if (box.children.length >= CONFIG.submissions.maxLinks) { toast(`Up to ${CONFIG.submissions.maxLinks} links`); return; }
  const row = document.createElement("div"); row.className = "ff-link";
  row.innerHTML = `<input type="url" name="link" placeholder="https://www.instagram.com/p/…" inputmode="url" autocomplete="off" value="${esc(v)}"><input name="linkLoc" placeholder="Where was it taken? (optional)" maxlength="200"><button type="button" class="ff-x" aria-label="Remove link">✕</button>`;
  row.querySelector(".ff-x").onclick = () => { row.remove(); if (!box.children.length) addLinkRow(); $("#ffAddLink").disabled = false; };
  box.appendChild(row); $("#ffAddLink").disabled = box.children.length >= CONFIG.submissions.maxLinks;
}
function renderFileList() {
  $("#ffFileList").innerHTML = FF.files.map((f, i) => `<div class="ff-file" data-i="${i}"><span class="ff-fname">${f.type.startsWith("video") ? "🎬" : "🖼"} ${esc(f.name)} <small>${mb(f.size)}</small></span>
    <input name="fileLoc" data-i="${i}" placeholder="Where was it taken? (city, country)" maxlength="200" value="${esc(f._loc || "")}" required><button type="button" class="ff-x" data-i="${i}" aria-label="Remove file">✕</button></div>`).join("");
  $$("#ffFileList input").forEach(inp => inp.oninput = () => { FF.files[+inp.dataset.i]._loc = inp.value; });
  $$("#ffFileList .ff-x").forEach(x => x.onclick = () => { FF.files.splice(+x.dataset.i, 1); renderFileList(); });
}
function addFiles(list) {
  const S = CONFIG.submissions, bad = [];
  for (const f of list) {
    if (FF.files.length >= S.maxFiles) { bad.push(`only ${S.maxFiles} files`); break; }
    if (!FF_TYPES.includes(f.type)) { bad.push(`${f.name}: photos and videos only`); continue; }
    if (f.size > S.maxFileMB * 1048576) { bad.push(`${f.name}: over ${S.maxFileMB} MB`); continue; }
    FF.files.push(f);
  }
  renderFileList(); const msg = $("#ffMsg");
  if (bad.length) { msg.className = "form-msg bad"; msg.textContent = "Skipped: " + bad.join("; ") + "."; } else if (msg.classList.contains("bad")) msg.textContent = "";
}
const userVerified = u => !!(u && u.email && (u.email_confirmed_at || u.confirmed_at));
function renderFeatureExtras() {
  if (!$("#featureForm") || !submissionsOn()) return;
  const u = Cloud.user, ok = userVerified(u), done = !$("#featureDone").classList.contains("hidden");
  $("#ffGate").classList.toggle("hidden", ok || done); if (!done) $("#featureForm").classList.toggle("hidden", !ok);
  $("#ffGateText").textContent = u && !ok ? `Please verify your email (${u.email || "no email on this account"}) first: open the sign-in link we emailed you, then come back.`
    : `To keep out spam, submissions need a free account with a verified email. Sign in with ${googleOn() ? "Google or " : ""}a one-time email link, no password.`;
  $("#ffGateBtn").textContent = u && !ok ? "Account" : "Log in to submit";
  if (ok) $("#ffSignedIn").innerHTML = `Signed in as <b>${esc(u.email)}</b>. We'll only use this email to reach you about your submission.`;
  const up = premiumOn() ? (isPremium() ? `<div class="ff-prio">⭐ You're Premium: your submission gets <b>priority review</b>.</div>`
    : `<div class="upsell"><div><b>⭐ Premium submitters get priority review</b><small>Plus no ads. ${[CONFIG.premium.price, CONFIG.premium.billing].filter(Boolean).map(esc).join(" · ")}</small></div><button class="pill-btn primary" type="button" data-go-premium>Go Premium</button></div>`) : "";
  $$("#ffUpsell, #ffDoneUpsell, #ffGateUpsell").forEach(b => { b.innerHTML = b.id !== "ffUpsell" && isPremium() ? "" : up; });
  $$("[data-go-premium]").forEach(b => b.onclick = goPremium);
}
const FF_ERR = {
  login_required: "Please log in to submit.", email_not_verified: "Please verify your email first (open the sign-in link we emailed you).",
  banned: "This account can't send submissions. If you think that's a mistake, email us (see Privacy).",
  rate_limited_daily: "You've already sent a submission in the last 24 hours. Please try again tomorrow.",
  too_many_pending: "You already have 3 submissions waiting for review. Please wait until we've looked at them.",
  too_many_links: "At most 10 links per submission.", too_many_files: "At most 5 files per submission.",
  invalid_file_type: "Photos and videos only.", file_too_large: "Each file must be 25 MB or less.", location_required: "Please say where each uploaded photo/video was taken.",
  invalid_link: "Please check your links (they must start with https://).", invalid_handle: "Please check your Instagram handle.",
  consent_required: "Please tick the three confirmations.", empty: "Please add at least one link or file.", rejected: "Couldn't send your submission." };
async function submitFeature(e) {
  e.preventDefault(); if (FF.busy) return;
  const f = e.target, msg = $("#ffMsg"), S = CONFIG.submissions, errs = [];
  if (!userVerified(Cloud.user)) { renderFeatureExtras(); return; }
  const handle = handleOf(f.handle.value);
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) errs.push("your Instagram handle");
  const links = []; let badLinks = 0;
  $$("#ffLinks .ff-link").forEach(r => { const v = r.querySelector("[name=link]").value.trim(); if (!v) return; const ok = checkLink(v);
    r.classList.toggle("bad", !ok); if (!ok) badLinks++; else links.push({ url: ok, location: r.querySelector("[name=linkLoc]").value.trim() }); });
  if (badLinks) errs.push(`${badLinks === 1 ? "a valid link" : "valid links"} (must start with https://)`);
  if (links.length > S.maxLinks) errs.push(`at most ${S.maxLinks} links`);
  FF.files.forEach(x => { x._loc = (x._loc || "").trim(); });
  if (FF.files.some(x => !x._loc)) errs.push("where each uploaded photo/video was taken");
  if (!links.length && !FF.files.length && !badLinks) errs.push("at least one link or file");
  if (!f.isSelf.checked) errs.push("confirmation that you're the person in these photos / it's your account");
  if (!f.consent.checked) errs.push("your consent to being featured");
  if (!f.adult.checked) errs.push("confirmation that you're 18 or older");
  if (errs.length) { msg.className = "form-msg bad"; msg.textContent = "Please add " + errs.join(", ") + "."; return; }
  FF.busy = true; $("#ffSubmit").disabled = true; msg.className = "form-msg"; msg.textContent = "Sending…";
  const p = { handle, links, is_self: true, consent: true, adult: true, website: f.website.value,   // honeypot: the server rejects it if filled
    consent_text: $$("#featureForm .check span").map(s => s.textContent.trim()).join(" | "),
    items: FF.files.map(x => ({ name: x.name, type: x.type, size: x.size, location: x._loc })) };
  try {
    const { data: j, error } = await Cloud.sb.rpc("submit_feature", { p });
    if (error) throw Object.assign(new Error(error.message), { code: String(error.message || "").trim() });
    let up = 0; const failed = [];
    for (let i = 0; i < (j.uploads || []).length; i++) {     // straight to Storage with the player's own session; RLS checks the path
      const path = j.uploads[i], file = FF.files[i]; msg.textContent = `Uploading ${i + 1} of ${j.uploads.length}…`;
      const { error: ue } = await Cloud.sb.storage.from("submissions").upload(path, file, { contentType: file.type, upsert: false });
      if (ue) failed.push(file.name); else up++;
    }
    let fin = { status: j.status };
    if (j.status === "uploading") { const r2 = await Cloud.sb.rpc("complete_submission", { sid: j.id }); if (!r2.error) fin = r2.data; }
    window.__lastFeature = { id: j.id, priority: !!j.priority, uploaded: up, failed, links: links.length, status: fin.status };
    showFeatureDone({ id: j.id, priority: !!j.priority, links: links.length, uploaded: up, failed });
  } catch (err) {
    msg.className = "form-msg bad";
    msg.textContent = FF_ERR[err.code] || "Couldn't send your submission. Please try again in a moment.";
    window.__lastFeatureError = err.code || String(err.message || err);
  } finally { FF.busy = false; $("#ffSubmit").disabled = false; }
}
function showFeatureDone(r) {
  $("#featureForm").classList.add("hidden"); const d = $("#featureDone"); d.classList.remove("hidden");
  const parts = [r.links ? `${r.links} link${r.links > 1 ? "s" : ""}` : "", r.uploaded ? `${r.uploaded} file${r.uploaded > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
  $("#ffDoneText").innerHTML = `We got your submission${parts ? ` (${parts})` : ""}. We review every one by hand and will email you before anything goes live.
    ${r.failed.length ? `<br><span class="bad">⚠️ ${r.failed.length} file(s) didn't upload: ${esc(r.failed.join(", "))}. You can send them as links instead.</span>` : ""}
    ${r.priority ? `<br><b class="ff-prio-tag">⭐ Priority review (Premium)</b>` : ""}`;
  renderFeatureExtras(); window.scrollTo({ top: 0 });
}
function resetFeatureForm() {
  const f = $("#featureForm"); f.reset(); FF.files = []; renderFileList(); $("#ffLinks").innerHTML = ""; addLinkRow(); $("#ffMsg").textContent = "";
  $("#featureDone").classList.add("hidden"); f.classList.remove("hidden"); renderFeatureExtras();
}
function wireV11() {
  $("#accountBtn").onclick = () => accountModal();
  $("#featureForm").onsubmit = submitFeature;
  $("#ffAddLink").onclick = () => addLinkRow();
  $("#ffFiles").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; };
  $("#ffAnother").onclick = resetFeatureForm;
  $("#ffGateBtn").onclick = () => accountModal();
  renderAccountUI(); applyPremium();
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
    closeModal(); toast(`Loaded ${parsed.length} days`); goToday();
  } catch (e) { console.error(e); toast("Couldn't read that file: " + e.message); }
}
window.WISLoadFiles = handleFiles;
window.WIS = { videoState: () => ({ state: VS.state, tries: VS.tries, round: VS.round, src: VS.url, log: VS.log.slice(), preload: preloadNext.el ? preloadNext.el.dataset.src : null }), crossPromoCheck, visits: () => load(LS.visits, 0), Zoom, fitMedia, summaryMap: () => summaryMap, CONFIG, dailyPool, puzzleForDate, schedule: () => SCHED, mode: () => state.mode, dockMode, puzzleHash, scoreFor, isPerfect, haversineKm, band, resultText, puzzles: () => ALL, map: () => map, communitySeed, pctFromHistogram,
  features: () => ({ accounts: accountsOn(), premium: premiumOn(), submissions: submissionsOn(), ads: adsOn() }),
  cloud: () => ({ state: Cloud.state, user: Cloud.user ? { id: Cloud.user.id, email: Cloud.user.email } : null, premium: isPremium(), profile: Cloud.profile, sync: load(LS.sync, null), syncing: !!Cloud.syncing }),
  syncNow, mergeStats, mergeResults, statsFromDays, ledgerFromResults, feature: () => ({ files: FF.files.length, gate: !$("#ffGate").classList.contains("hidden"), form: !$("#featureForm").classList.contains("hidden") }),
  debugResults, platformScoreForPercent };   // test hooks

// ================================================================ wire up
$("#guessBtn").onclick = submitGuess; $("#nextRoundBtn").onclick = nextRound; $("#nextBtn").onclick = next;
$("#shareResultBtn").onclick = () => doShare(resultText());
$("#shareChallengeBtn").onclick = $("#shareChallengeTop").onclick = () => doShare(challengeText());
if ($("#crossPromoGo")) { $("#crossPromoGo").addEventListener("click", onCrossPromoGo); $("#crossPromoGo").addEventListener("auxclick", e => { if (e.button === 1) onCrossPromoGo(); }); }
if ($("#crossPromoDismiss")) $("#crossPromoDismiss").onclick = onCrossPromoDismiss;
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
window.addEventListener("resize", () => { fitStage(); if (map) map.invalidateSize(); if (summaryMap) summaryMap.invalidateSize(); });
$("#muteBtn").onclick = e => { e.stopPropagation(); toggleMute(); };
$("#video").onclick = () => { const v = $("#video"); if (v.paused) v.play().catch(() => {}); };
$("#zoomBtn").onclick = () => { $("#lightImg").src = $("#photo").src; $("#lightbox").classList.remove("hidden"); };
$("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");
$("#optinForm").onsubmit = submitOptin;
$("#clearLink").onclick = e => { e.preventDefault(); clearDataModal(); };
if (/[?&]cleared=/.test(location.search)) { try { history.replaceState(null, "", location.pathname + location.hash); } catch {} setTimeout(() => toast("Game data cleared"), 300); }
$("#fileInput").onchange = e => { const f = [...e.target.files]; if (f.length) handleFiles(f); e.target.value = ""; };
$$(".tab").forEach(b => b.onclick = () => b.dataset.view === "archive" ? goArchive() : goToday());
$("#soundBtn").onclick = () => toggleSound();
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#welcome").classList.contains("hidden")) { chooseSound("skip"); return; }
  if (e.key === "Escape") { closeModal(); $("#lightbox").classList.add("hidden"); closeFullMap(); return; }
  if (e.key !== "Enter" || $("#playView").classList.contains("hidden") || !$("#modal").classList.contains("hidden") || /^(INPUT|TEXTAREA|BUTTON|A|SELECT)$/.test(document.activeElement?.tagName)) return;
  if (dockMode() !== "reveal" && !$("#guessBtn").disabled) submitGuess();
  else if (dockMode() === "reveal") nextRound();
});

applyTheme();
wireV11();
$("#welSoundOn").onclick = () => chooseSound("on"); $("#welSoundOff").onclick = () => chooseSound("off");
$("#welSkip").onclick = e => { e.preventDefault(); chooseSound("skip"); };
["pointerdown", "mousedown", "touchstart"].forEach(ev => $("#vidLoading .vl-btn").addEventListener(ev, e => e.stopPropagation(), { passive: true }));   // keep the media's drag/zoom from capturing the tap
$("#vidLoading .vl-btn").onclick = e => { e.stopPropagation(); const r = state.puzzle.rounds[VS.round];
  if (VS.state === "tap") { vidOverlay("loading", "Loading clip…"); vidPlay(); } else { VS.tries = 0; vidLoad(r, true); } };
countVisit();
if (!ALL.length) { $("#question").textContent = "No puzzles found. Run build.py or load a puzzle file."; return; }
function route() {
  // Localhost only: #platforms-demo=90 opens the results staircase on a seeded percentile.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    const demo = location.hash.match(/^#platforms-demo=(\d{1,3})$/);
    if (demo) {
      if (!state.puzzle) { state.mode = "daily"; state.dateKey = todayKey(); state.puzzle = puzzleForDate(state.dateKey); }
      const picked = state.puzzle && platformScoreForPercent(Math.max(0, Math.min(100, +demo[1])));
      if (picked) { const wel = $("#welcome"); if (wel) wel.classList.add("hidden"); debugResults({ total: picked.total, seedOnly: true }); return; }
    }
  }
  const h = location.hash, d = h.match(/(?:^#|&)d=(\d{4}-\d{2}-\d{2})/), p = h.match(/(?:^#|&)p=([^&]+)/);
  const pv = h.match(/preview=(\d{4}-\d{2}-\d{2})/) || location.search.match(/[?&]preview=(\d{4}-\d{2}-\d{2})/) || (/[?&]preview=1/.test(location.search) && location.search.match(/[?&]date=(\d{4}-\d{2}-\d{2})/));
  if (pv) return goPreview(pv[1]);
  if (h.startsWith("#archive")) return goArchive();
  if (h.startsWith("#optin")) return goOptin();
  if (d) return goDate(d[1]);
  if (p) return goLegacyPuzzle(decodeURIComponent(p[1]));
  goToday();
}
window.addEventListener("hashchange", () => { if (location.hash !== linkHash()) route(); });
route(); fitStage(); setSoundBtn();
if (!welcomeDone() && !isPreview() && !location.hash.startsWith("#optin")) showWelcome();
cloudInit();   // v11: no-op unless CONFIG.backend.enabled
})();
