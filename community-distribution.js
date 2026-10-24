/* WhereIsShe community comparison for the results platforms.
   Isolated on purpose: swap this file's sample for a live feed later.
   Scores are total points for a finished day (0–25000), the same total the
   score card, share text, and stats already use.

   Synthetic plays are a wide, seeded stand-in whose average sits a little
   under REALISTIC_AVERAGE_TOTAL. They blend with real finished totals.
   COMMUNITY_REAL_TAKEOVER is the one knob for that handoff: synthetic weight
   falls in a straight line from 1 (no real plays) to 0 (that many real plays),
   and stays 0 after that. Until then, a percentile is partly synthetic. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CommunityDistribution = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // A realistic finished day: about 2,640 points a round. Right region of the
  // world, not standing on the pin. The seed aims a little under this.
  const REALISTIC_AVERAGE_TOTAL = 13200;
  // Linear handoff. At this many real finished totals, synthetic weight is 0.
  const COMMUNITY_REAL_TAKEOVER = 40;
  const PLATFORM_N_MIN = 7;
  const PLATFORM_N_MAX = 12;
  const SYNTHETIC_PLAYERS = 240;
  const MAX_TOTAL = 25000;
  // 4% under REALISTIC_AVERAGE_TOTAL. Subtle on purpose: the stand-in should
  // feel like an ordinary day, not a stingy one. The draw is shifted onto this
  // so one lucky seed cannot drift up to, or past, the realistic average.
  const SEED_MEAN_RATIO = 0.96;
  const PERFECT_PLAYS = 6;
  const BULK_MEAN = 11800;
  const BULK_SD = 5900;
  const LOW_SHELF = [450, 1200, 2100, 3100, 4300, 5600, 7000, 8500];
  const HIGH_SHELF = [19200, 20500, 21600, 22600, 23500, 24400];

  function fnv1a(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function boxMuller(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function clampScore(n) {
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(MAX_TOTAL, n));
  }

  function average(scores) {
    let sum = 0;
    for (const s of scores) sum += s;
    return scores.length ? sum / scores.length : 0;
  }

  function syntheticScores(puzzleId, dayKey) {
    const rng = mulberry32(fnv1a(String(puzzleId) + "|" + String(dayKey) + "|wis-platforms-v1"));
    const free = [];
    for (const base of LOW_SHELF) {
      free.push(clampScore(base + Math.round((rng() - 0.5) * 380)));
    }
    for (const base of HIGH_SHELF) {
      free.push(clampScore(base + Math.round((rng() - 0.5) * 240)));
    }
    while (free.length < SYNTHETIC_PLAYERS - PERFECT_PLAYS) {
      free.push(clampScore(BULK_MEAN + boxMuller(rng) * BULK_SD));
    }
    // Shift the free plays so the whole sample, including a fixed perfect
    // shelf, lands on SEED_MEAN_RATIO * REALISTIC_AVERAGE_TOTAL.
    const target = REALISTIC_AVERAGE_TOTAL * SEED_MEAN_RATIO;
    const freeTarget = (target * SYNTHETIC_PLAYERS - PERFECT_PLAYS * MAX_TOTAL) / free.length;
    const place = (list, aim) => {
      const delta = aim - average(list);
      return list.map(s => clampScore(s + delta));
    };
    let shifted = place(free, freeTarget);
    const again = freeTarget - average(shifted);
    if (Math.abs(again) > 25) shifted = place(shifted, freeTarget);
    for (let i = 0; i < PERFECT_PLAYS; i++) shifted.push(MAX_TOTAL);
    return shifted;
  }

  function blendSamples(synthetic, realScores, takeover) {
    const take = takeover == null ? COMMUNITY_REAL_TAKEOVER : takeover;
    const takeN = take > 0 ? take : 1;
    const synth = [];
    const real = [];
    for (const s of synthetic || []) {
      const n = clampScore(s);
      if (n != null) synth.push(n);
    }
    for (const s of realScores || []) {
      const n = clampScore(s);
      if (n != null) real.push(n);
    }
    const realWeight = Math.max(0, Math.min(1, real.length / takeN));
    return {
      synthetic: synth,
      real,
      realWeight,
      syntheticWeight: 1 - realWeight,
    };
  }

  function shareBelow(score, list) {
    if (!list.length) return 0;
    let below = 0;
    for (const s of list) if (s < score) below++;
    return below / list.length;
  }

  // Percent of the blended field strictly below this total. Rounded.
  // 100 only when every weighted play is actually below the player.
  function percentBeaten(playerScore, blend) {
    const score = Number(playerScore);
    if (!Number.isFinite(score)) return 0;
    const sw = blend.syntheticWeight;
    const rw = blend.realWeight;
    let frac = 0;
    if (rw > 0 && sw > 0) frac = sw * shareBelow(score, blend.synthetic) + rw * shareBelow(score, blend.real);
    else if (rw > 0) frac = shareBelow(score, blend.real);
    else frac = shareBelow(score, blend.synthetic);
    return Math.max(0, Math.min(100, Math.round(frac * 100)));
  }

  // Equal bands across the 0–100 percentile line.
  // centerRemainder is how far the player sits from the middle of their band
  // (0 = dead center, 0.5 = on an edge). Percentile 100 is clamped into the
  // top band instead of falling off the end.
  function bandFit(percentile, n) {
    const p = Math.max(0, Math.min(100, Number(percentile) || 0));
    const pos = p >= 100 ? n - 1e-6 : (p / 100) * n;
    const bandIndex = Math.min(n - 1, Math.max(0, Math.floor(pos)));
    const fraction = pos - Math.floor(pos);
    return { bandIndex, fraction, centerRemainder: Math.abs(fraction - 0.5) };
  }

  // Smallest centerRemainder wins, so the player sits most cleanly inside a band.
  // Tie-break: the smaller N.
  function choosePlatformCount(percentile) {
    let best = null;
    for (let n = PLATFORM_N_MIN; n <= PLATFORM_N_MAX; n++) {
      const fit = bandFit(percentile, n);
      if (!best
        || fit.centerRemainder < best.centerRemainder - 1e-9
        || (Math.abs(fit.centerRemainder - best.centerRemainder) <= 1e-9 && n < best.n)) {
        best = { n, bandIndex: fit.bandIndex, fraction: fit.fraction, centerRemainder: fit.centerRemainder };
      }
    }
    return best;
  }

  function bandWeights(blend, n) {
    const atoms = [];
    if (blend.syntheticWeight > 0 && blend.synthetic.length) {
      const w = blend.syntheticWeight / blend.synthetic.length;
      for (const s of blend.synthetic) atoms.push({ s, w });
    }
    if (blend.realWeight > 0 && blend.real.length) {
      const w = blend.realWeight / blend.real.length;
      for (const s of blend.real) atoms.push({ s, w });
    }
    atoms.sort((a, b) => a.s - b.s || a.w - b.w);
    const weights = Array.from({ length: n }, () => 0);
    const total = atoms.reduce((sum, a) => sum + a.w, 0);
    if (!total) return weights;
    let cum = 0;
    for (const a of atoms) {
      const mid = (cum + a.w / 2) / total;
      const band = Math.min(n - 1, Math.floor(mid * n));
      weights[band] += a.w;
      cum += a.w;
    }
    return weights;
  }

  // Crowd size on each platform, roughly proportional to band weight.
  function figureCounts(weights, maxFigures) {
    const cap = maxFigures == null ? 3 : maxFigures;
    const max = weights.reduce((m, w) => w > m ? w : m, 0);
    if (!(max > 0) || !(cap > 0)) return weights.map(() => 0);
    return weights.map(w => w <= 0 ? 0 : Math.max(1, Math.round(w / max * cap)));
  }

  // Bottom third of the staircase celebrates quietly, top third the most.
  function celebrationTier(bandIndex, n) {
    const t = n <= 1 ? 1 : Math.min(1, Math.max(0, bandIndex / (n - 1)));
    if (t < 1 / 3) return "low";
    if (t < 2 / 3) return "mid";
    return "high";
  }

  function scoresFromHistogram(hist) {
    const out = [];
    for (const b of hist || []) {
      const n = Math.max(0, Math.round(+b.n || 0));
      const min = +b.min, max = +b.max;
      if (!n || !(max > min)) continue;
      const mid = clampScore((min + Math.min(max, MAX_TOTAL)) / 2);
      for (let i = 0; i < n; i++) out.push(mid);
    }
    return out;
  }

  // Snapshot histograms mix the server stand-in with real finishes while
  // `seeded` is true. Subtract that stand-in (matched on band min) to recover
  // the real counts. Negative leftovers clamp to 0.
  function peelRealScores(snapshotHist, seedHist) {
    const seedN = new Map();
    for (const b of seedHist || []) seedN.set(+b.min, +b.n || 0);
    const peeled = (snapshotHist || []).map(b => ({
      min: +b.min,
      max: +b.max,
      n: Math.max(0, Math.round((+b.n || 0) - (seedN.get(+b.min) || 0))),
    }));
    return scoresFromHistogram(peeled);
  }

  function realScoresFromSnapshot(row, seedHist) {
    if (!row || !Array.isArray(row.histogram)) return [];
    if (row.seeded) return peelRealScores(row.histogram, seedHist);
    return scoresFromHistogram(row.histogram);
  }

  // Null unless this is a finished game with a full set of round scores.
  // A partial day is not compared against full-day totals.
  function finishedTotal(game, roundsRequired) {
    const need = roundsRequired == null ? 5 : roundsRequired;
    if (!game || !game.done || !Array.isArray(game.rounds) || game.rounds.length < need) return null;
    const rounds = game.rounds.slice(0, need);
    if (!rounds.every(r => r && Number.isFinite(+r.pts))) return null;
    return rounds.reduce((sum, r) => sum + (+r.pts), 0);
  }

  function compareScore(playerTotal, synthetic, realScores) {
    const blend = blendSamples(synthetic, realScores);
    const percent = percentBeaten(playerTotal, blend);
    const place = choosePlatformCount(percent);
    const weights = bandWeights(blend, place.n);
    return {
      percent,
      n: place.n,
      bandIndex: place.bandIndex,
      fraction: place.fraction,
      centerRemainder: place.centerRemainder,
      syntheticWeight: blend.syntheticWeight,
      realWeight: blend.realWeight,
      seeded: blend.syntheticWeight > 0,
      bandWeights: weights,
      figures: figureCounts(weights, 3),
      tier: celebrationTier(place.bandIndex, place.n),
    };
  }

  return {
    REALISTIC_AVERAGE_TOTAL,
    SEED_MEAN_RATIO,
    COMMUNITY_REAL_TAKEOVER,
    PLATFORM_N_MIN,
    PLATFORM_N_MAX,
    SYNTHETIC_PLAYERS,
    MAX_TOTAL,
    fnv1a,
    syntheticScores,
    blendSamples,
    percentBeaten,
    bandFit,
    choosePlatformCount,
    bandWeights,
    figureCounts,
    celebrationTier,
    scoresFromHistogram,
    peelRealScores,
    realScoresFromSnapshot,
    finishedTotal,
    compareScore,
  };
});
