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
  assert.match(html, /no ads, full archive, and unlocks ranki\.gg too/);
  assert.match(html, /You're Premium\. No ads, and ranki\.gg is included\./);
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
  assert.match(html, /whereisshe\.gg · Play today's where-in-the-world puzzle/);
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
  assert.match(sw, /wis-shell-v5/);
  assert.match(sw, /\/home\.js/);
});

test("the home page has no under-construction copy for AdSense review", () => {
  assert.match(html, /© 2026 whereisshe\.gg · Photos used with permission/);
  assert.doesNotMatch(html, /whereisshe\.gg prototype/);
  assert.match(html, /id="communityBadge">Community</);
  assert.doesNotMatch(html, /Coming soon/);
  assert.doesNotMatch(html, /Banner ad placeholder/);
  assert.doesNotMatch(html, /Interstitial ad placeholder/);
  assert.doesNotMatch(html, /<!--(?:(?!-->)[\s\S])*placeholder(?:(?!-->)[\s\S])*-->/i);
  assert.match(html, /ca-pub-5196178239625142/);
  assert.match(html, /posthog\.init\(/);
  assert.match(sw, /const CACHE = "wis-shell-v5"/);
  assert.doesNotMatch(sw, /wis-shell-v4/);
  assert.match(app, /ca-pub-5196178239625142/);
  assert.match(app, /7982022596/);
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

const GUIDE_PAGES = [
  ["guides/index.html", "https://whereisshe.gg/guides/"],
  ["guides/scoring.html", "https://whereisshe.gg/guides/scoring.html"],
  ["guides/reading-clues.html", "https://whereisshe.gg/guides/reading-clues.html"],
  ["guides/featured-people.html", "https://whereisshe.gg/guides/featured-people.html"],
  ["guides/daily-and-archive.html", "https://whereisshe.gg/guides/daily-and-archive.html"],
  ["guides/beginner-clues.html", "https://whereisshe.gg/guides/beginner-clues.html"],
  ["guides/cities-and-countryside.html", "https://whereisshe.gg/guides/cities-and-countryside.html"],
  ["guides/sharing-and-streaks.html", "https://whereisshe.gg/guides/sharing-and-streaks.html"],
  ["guides/map-and-distance.html", "https://whereisshe.gg/guides/map-and-distance.html"]
];

function visibleWords(src) {
  const text = src
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  return text.split(/\s+/).filter(Boolean);
}

test("the home intro, empty state, and footers keep ads off screens with no puzzle", () => {
  const intro = sliceBetween(html, 'id="homeIntro"', 'id="homePremium"');
  const paras = [...intro.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => m[1]).join(" ");
  const words = visibleWords(paras);
  assert.ok(words.length >= 140 && words.length <= 180, "intro words " + words.length);
  assert.match(intro, /href="guides\/"/);
  assert.match(intro, /whereisshe\.gg is a free daily geography game/);
  assert.doesNotMatch(intro, /—|–|prototype|coming soon|placeholder/i);

  const empty = sliceBetween(html, 'id="emptyDay"', 'id="shareChallengeTop"');
  assert.match(empty, /Nothing scheduled/);
  assert.match(empty, /id="emptyArchive" href="#archive"/);
  assert.match(empty, /Play the archive/);
  assert.match(empty, /href="guides\/"/);
  assert.match(empty, /href="guides\/scoring\.html"/);
  assert.match(html, /href="guides\/">Guides<\/a>/);
  assert.match(html, /href="contact\.html">Contact<\/a>/);

  assert.match(css, /html:not\(\.ads-live\) #adTop/);
  assert.match(css, /html\.ads-held #interstitial/);
  assert.match(css, /html\.ads-held \.inter-ph/);
  assert.match(app, /function syncAdSlots\(/);
  assert.match(app, /function puzzleOnScreen\(/);
  assert.match(app, /ads-held/);
  assert.match(app, /ads-live/);
  const banner = sliceBetween(app, "function renderBannerAd()", "function ensureAdSense()");
  assert.match(banner, /ads-held/);
  assert.match(banner, /!state\.puzzle/);
  assert.doesNotMatch(banner, /\.push\(/);
  const inter = sliceBetween(app, "function renderInterstitialAd()", "function renderAccountUI()");
  const guard = inter.indexOf("return;");
  const push = inter.indexOf(".push(");
  assert.ok(guard >= 0 && push > guard, "interstitial push stays behind the empty-state return");
  assert.match(inter, /!state\.puzzle \|\| document\.documentElement\.classList\.contains\("ads-held"\)/);
  assert.match(app, /if \(!state\.puzzle \|\| document\.documentElement\.classList\.contains\("ads-held"\)\) \{ done\(\); return; \}/);

  for (const file of ["about.html", "how-to-play.html", "privacy.html", "terms.html", "refund.html", "contact.html"]) {
    const page = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(page, /<footer>/);
    assert.match(page, /href="guides\/"/);
    assert.match(page, /href="contact\.html"/);
  }
  const privacy = fs.readFileSync(path.join(root, "privacy.html"), "utf8");
  const terms = fs.readFileSync(path.join(root, "terms.html"), "utf8");
  assert.match(privacy, /<meta name="description" content="[^"]{40,}"/);
  assert.match(terms, /<meta name="description" content="[^"]{40,}"/);
  assert.match(fs.readFileSync(path.join(root, "contact.html"), "utf8"), /mailto:mikelyaps@gmail\.com/);
});

test("guide pages, contact, and the sitemap are crawlable", () => {
  const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.ok(locs.includes("https://whereisshe.gg/contact.html"));
  assert.ok(locs.includes("https://whereisshe.gg/guides/"));
  for (const block of sitemap.split("</url>")) {
    if (!block.includes("<loc>")) continue;
    assert.match(block, /<lastmod>2026-11-04<\/lastmod>/);
  }
  for (const [file, canonical] of GUIDE_PAGES) {
    const page = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(page, /<title>[^<]+<\/title>/);
    assert.match(page, new RegExp('<link rel="canonical" href="' + canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '">'));
    assert.match(page, /<meta name="description" content="[^"]{40,}"/);
    assert.match(page, /<footer>/);
    assert.match(page, /href="[^"]*contact\.html"/);
    assert.doesNotMatch(page.replace(/<script[\s\S]*?<\/script>/gi, " "), /—|prototype|coming soon|placeholder|swimwear|bikini/i);
    const card = page.slice(page.indexOf('<div class="card">'), page.indexOf("<footer>"));
    const count = visibleWords(card).length;
    const min = file.endsWith("index.html") ? 250 : 300;
    assert.ok(count >= min && count <= 600, file + " words " + count);
    assert.ok(sitemap.includes("<loc>" + canonical + "</loc>"), canonical);
    assert.match(sw, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.ok(sw.includes("/^\\/guides\\/[^/]+\\.html$/i"));
  assert.match(sw, /\/guides\/index\.html/);
});

