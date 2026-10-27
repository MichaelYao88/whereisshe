/* Home page helpers. Loaded before app.js. No DOM, no network.
   The play card may show the traveler's name, handle, and profile photo.
   It must not show a round location, a still, or a clip. */
(function (root) {
  "use strict";
  const EPOCH = "2026-10-21";
  const LIMITS = { handle: 30, note: 500, email: 120, user_agent: 240, anon_id: 80, gapMs: 20000, hourMs: 3600000, hourMax: 5 };
  const HOME_DEMO = {
    kicker: "Sample round",
    score: "4,820",
    outOf: "5,000",
    distanceKm: 48,
    distance: "48 km",
    creditLabel: "Instagram ↗",
    creditUrl: "https://www.instagram.com/",
    steps: ["Watch the clip", "Drop a pin on the map", "See the score and the distance", "Next round"]
  };
  const CONTACT = "mikelyaps@gmail.com";

  const utc = k => { const [y, m, d] = String(k || "").split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const pad3 = n => String(n).padStart(3, "0");
  function dayNumber(key, epoch) {
    return Math.round((utc(key) - utc(epoch || EPOCH)) / 864e5);
  }
  function longDate(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key || "")) return "";
    return new Date(utc(key)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  function cleanLine(value) {
    return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  }
  // Same rule as the in-game Meet card: https, or a site-relative path. Nothing else.
  function safeAsset(value) {
    const s = cleanLine(value);
    if (!s || /[\s"'<>]/.test(s) || s.includes("..")) return "";
    if (/^https:\/\//i.test(s)) return s;
    if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
    return "";
  }
  function homeCardCopy(puzzle, key, epoch) {
    const f = puzzle && puzzle.featured;
    const name = cleanLine(f && f.name);
    const handle = cleanLine(f && f.handle).replace(/^@+/, "");
    const who = name && handle ? name + " · @" + handle : name || (handle ? "@" + handle : "");
    return {
      kind: "Today's traveler",
      no: "No. " + pad3(dayNumber(key, epoch) + 1),
      date: longDate(key),
      name: name,
      handle: handle ? "@" + handle : "",
      who: who,
      avatar: safeAsset(f && f.avatar)
    };
  }
  function validateFeatureSuggestion(input) {
    const src = input || {};
    if (cleanLine(src.company || src.honeypot || "")) return { ok: true, spam: true };
    const handle = cleanLine(src.handle).replace(/^@+/, "");
    const note = cleanLine(src.note);
    const email = cleanLine(src.email);
    if (!handle) return { ok: false, field: "handle", message: "Add an Instagram handle." };
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return { ok: false, field: "handle", message: "Use the Instagram handle only, like @name." };
    if (note.length > LIMITS.note) return { ok: false, field: "note", message: "Keep the note under " + LIMITS.note + " characters." };
    if (email.length > LIMITS.email) return { ok: false, field: "email", message: "That email is too long." };
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, field: "email", message: "That email doesn't look right." };
    return { ok: true, spam: false, row: { handle: handle, note: note || null, email: email || null } };
  }
  // 20 seconds between sends, and 5 sends in a rolling hour. Pure: the caller stores stamps.
  function suggestionRate(stamps, now) {
    const t = +now || Date.now();
    const recent = (Array.isArray(stamps) ? stamps : []).map(Number).filter(x => isFinite(x) && t >= x && t - x < LIMITS.hourMs);
    const last = recent.length ? recent[recent.length - 1] : 0;
    if (last && t - last < LIMITS.gapMs) return { ok: false, reason: "gap", stamps: recent };
    if (recent.length >= LIMITS.hourMax) return { ok: false, reason: "hour", stamps: recent };
    return { ok: true, stamps: recent.concat(t) };
  }
  function suggestionErrorKind(status, text) {
    const body = String(text || "");
    if (status === 404 || /PGRST205|42P01|schema cache|Could not find the table/i.test(body)) return "missing";
    if (/P0001|rate limited/i.test(body)) return "rate";
    if (!status) return "network";
    return "fail";
  }
  function suggestionErrorMessage(kind) {
    if (kind === "missing") return "Suggestions aren't open yet. Email " + CONTACT + " and we'll take it from there.";
    if (kind === "rate") return "That's a lot of suggestions from this browser. Try again in a little while.";
    if (kind === "network") return "That didn't send. Check your connection and try again.";
    return "That didn't send. Try again in a moment, or email " + CONTACT + ".";
  }

  root.WISHome = {
    EPOCH: EPOCH, LIMITS: LIMITS, HOME_DEMO: HOME_DEMO, CONTACT: CONTACT,
    safeAsset: safeAsset, homeCardCopy: homeCardCopy, validateFeatureSuggestion: validateFeatureSuggestion,
    suggestionRate: suggestionRate, suggestionErrorKind: suggestionErrorKind, suggestionErrorMessage: suggestionErrorMessage
  };
})(typeof window !== "undefined" ? window : globalThis);
