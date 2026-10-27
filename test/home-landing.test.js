const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const homeSrc = fs.readFileSync(path.join(root, "home.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261027203000_feature_suggestions.sql"), "utf8");

const sandbox = { console, Date, Math, JSON, Intl, Number, String, Array, Object, RegExp, isFinite };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(homeSrc, sandbox, { filename: "home.js" });
const home = sandbox.WISHome;

function sliceBetween(src, startMark, endMark) {
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark);
  assert.ok(start >= 0, startMark);
  assert.ok(end > start, endMark);
  return src.slice(start, end);
}

test("home helpers stay off the round answers", () => {
  assert.doesNotMatch(homeSrc, /poster|place_name|Zhangye|\.mp4|sources\//);
  const copy = home.homeCardCopy({
    id: "she-006",
    featured: {
      name: "Yvonne",
      handle: "ye_8911",
      avatar: "sources/ye_8911/avatar.jpg",
      igUrl: "https://www.instagram.com/ye_8911/"
    },
    rounds: [{
      place: "Zhangye Danxia",
      country: "Gansu",
      poster: "sources/ye_8911/videos/004-4-poster.jpg",
      video: "sources/ye_8911/videos/004-4.mp4",
      lat: 38.6,
      lng: 100.1
    }]
  }, "2026-10-27", "2026-10-21");
  assert.equal(copy.kind, "Today's traveler");
  assert.equal(copy.no, "No. 007");
  assert.equal(copy.date, "October 27, 2026");
  assert.equal(copy.who, "Yvonne · @ye_8911");
  assert.equal(copy.avatar, "sources/ye_8911/avatar.jpg");
  const blob = JSON.stringify(copy);
  assert.doesNotMatch(blob, /Zhangye|Gansu|004-4|poster|lat|lng|video/i);
  assert.equal(home.safeAsset("javascript:alert(1)"), "");
  assert.equal(home.safeAsset("../etc/passwd"), "");
  assert.equal(home.safeAsset("https://example.com/a.jpg"), "https://example.com/a.jpg");
  const empty = home.homeCardCopy(null, "2026-10-27", "2026-10-21");
  assert.equal(empty.who, "");
  assert.equal(empty.avatar, "");
  assert.equal(empty.no, "No. 007");
});

test("the landing page leads with play, then premium, how to play, and suggest", () => {
  const play = html.indexOf('id="homePlay"');
  const prem = html.indexOf('id="homePremium"');
  const how = html.indexOf('id="homeHow"');
  const suggest = html.indexOf('id="homeSuggest"');
  assert.ok(play >= 0 && play < prem && prem < how && how < suggest);
  assert.match(html, /Play today's puzzle/);
  assert.match(html, /Go Premium:/);
  assert.match(html, /no ads, full archive, and unlocks Ranki too/);
  assert.match(html, /You're Premium\. No ads, and Ranki is included\./);
  assert.match(html, /id="playView" class="hidden"/);
  assert.match(html, /wis-boot-home/);
  assert.match(html, /wis-boot-play/);
  assert.match(html, /wis-boot-archive/);
  assert.match(html, /wis-boot-optin/);
  assert.match(css, /html\.wis-boot-play #playView/);
  assert.match(css, /html\.wis-boot-archive #archiveView/);
  assert.match(css, /html\.wis-boot-optin #optinView/);
  assert.match(css, /html\.wis-boot-home #adTop/);
  assert.match(css, /--stage-top/);
  assert.match(html, /WhereIsShe\.gg · Play today's where-in-the-world puzzle/);
});

test("the how-to demo is a sample round with a tappable Instagram credit", () => {
  const how = sliceBetween(html, 'id="homeHow"', 'id="homeSuggest"');
  assert.match(how, /Step 1/);
  assert.match(how, /Watch the clip/);
  assert.match(how, /Drop a pin on the map/);
  assert.match(how, /See the score and the distance/);
  assert.match(how, /Next round/);
  assert.match(how, /4,820/);
  assert.match(how, /48 km/);
  assert.match(how, /Instagram ↗/);
  assert.match(how, /https:\/\/www\.instagram\.com\//);
  assert.match(how, /not today's puzzle/);
  for (const bad of ["Zhangye", "Hollywood", "ye_8911", "weakrhymes", "angelyussof", "sources/", ".mp4", "place_name", "Gansu", "Lisbon"]) {
    assert.equal(how.includes(bad), false, bad);
  }
  assert.match(css, /prefers-reduced-motion:\s*no-preference/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(app, /motion"\) === "reduce"|get\("motion"\) === "reduce"/);
});

test("suggestions validate, honeypot, and rate-limit without sending typed text", () => {
  const bad = home.validateFeatureSuggestion({ handle: "  " });
  assert.equal(bad.ok, false);
  assert.equal(bad.field, "handle");
  const weird = home.validateFeatureSuggestion({ handle: "not a handle!" });
  assert.equal(weird.ok, false);
  const mail = home.validateFeatureSuggestion({ handle: "ada", email: "nope" });
  assert.equal(mail.ok, false);
  assert.equal(mail.field, "email");
  const ok = home.validateFeatureSuggestion({ handle: " @Ada.lane ", note: "  next week ", email: "ada@example.com" });
  assert.equal(ok.ok, true);
  assert.equal(ok.spam, false);
  assert.equal(JSON.stringify(ok.row), JSON.stringify({ handle: "Ada.lane", note: "next week", email: "ada@example.com" }));
  const spam = home.validateFeatureSuggestion({ handle: "", company: "viagra" });
  assert.equal(spam.ok, true);
  assert.equal(spam.spam, true);

  const t0 = 1700000000000;
  let stamps = [];
  for (let i = 0; i < 5; i++) {
    const gate = home.suggestionRate(stamps, t0 + i * 21000);
    assert.equal(gate.ok, true, "send " + i);
    stamps = gate.stamps;
  }
  const hour = home.suggestionRate(stamps, t0 + 5 * 21000);
  assert.equal(hour.ok, false);
  assert.equal(hour.reason, "hour");
  const first = home.suggestionRate([], t0);
  const gap = home.suggestionRate(first.stamps, t0 + 1000);
  assert.equal(gap.ok, false);
  assert.equal(gap.reason, "gap");

  assert.equal(home.suggestionErrorKind(404, ""), "missing");
  assert.equal(home.suggestionErrorKind(400, '{"code":"PGRST205","message":"Could not find the table public.feature_suggestions"}'), "missing");
  assert.equal(home.suggestionErrorKind(400, '{"code":"P0001","message":"rate limited"}'), "rate");
  assert.equal(home.suggestionErrorKind(0, ""), "network");
  const missing = home.suggestionErrorMessage("missing");
  assert.match(missing, /aren't open yet/);
  assert.match(missing, /mikelyaps@gmail.com/);
  assert.doesNotMatch(missing, /PGRST|stack|SQL/i);
  assert.match(home.suggestionErrorMessage("rate"), /little while/);
});

test("the page wires the three home events and leaves checkout alone", () => {
  assert.match(app, /home_play_clicked/);
  assert.match(app, /home_premium_clicked/);
  assert.match(app, /track\("suggestion_submitted"\)/);
  assert.doesNotMatch(app, /track\("suggestion_submitted",/);
  assert.match(app, /feature_suggestions/);
  assert.match(app, /function goPremium\(/);
  assert.match(app, /LemonSqueezy\.Url\.Open/);
  assert.match(app, /function goHome\(/);
  assert.match(html, /name="company"/);
  assert.match(html, /id="suggestForm"/);
  assert.match(html, /href="#optin"/);
  const card = sliceBetween(app, "function fillHomeCard", "function syncHomeMotion");
  assert.doesNotMatch(card, /poster|place_name|\.lat|\.lng|rounds/);
  assert.match(sw, /wis-shell-v2/);
  assert.match(sw, /\/home\.js/);
});

test("the suggestions migration is insert-only and rate-limited in private", () => {
  assert.match(migration, /NOT applied to production/);
  assert.match(migration, /create table if not exists public\.feature_suggestions/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.feature_suggestions from anon, authenticated/i);
  assert.match(migration, /grant insert \(/i);
  assert.match(migration, /to anon, authenticated/i);
  assert.match(migration, /for insert\s+to anon, authenticated/i);
  assert.match(migration, /with check \(true\)/i);
  assert.equal(/for select/i.test(migration), false);
  assert.equal(/for update/i.test(migration), false);
  assert.equal(/for delete/i.test(migration), false);
  assert.match(migration, /create schema if not exists private/i);
  assert.match(migration, /function private\.feature_suggestions_guard/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /search_path = ''/);
  assert.match(migration, /rate limited/);
  assert.match(migration, /P0001/);
  assert.match(migration, /execute function private\.feature_suggestions_guard\(\)/i);
  assert.match(migration, /char_length\(btrim\(handle\)\) between 1 and 30/);
});
