const test = require("node:test");
const assert = require("node:assert/strict");
const CD = require("../community-distribution.js");

const DAYS = [
  ["she-001", "2026-10-21"],
  ["she-004", "2026-10-24"],
  ["he-001", "2026-10-26"],
  ["she-010", "2026-10-31"],
  ["she-002", "2026-11-02"],
  ["she-008", "2026-12-01"],
];

function mean(scores) {
  return scores.reduce((sum, n) => sum + n, 0) / scores.length;
}
function stdev(scores) {
  const m = mean(scores);
  return Math.sqrt(scores.reduce((sum, n) => sum + (n - m) ** 2, 0) / scores.length);
}

test("platform count is 7–12 and minimises distance to the band center", () => {
  assert.equal(CD.PLATFORM_N_MIN, 7);
  assert.equal(CD.PLATFORM_N_MAX, 12);
  for (let p = 0; p <= 100; p++) {
    const choice = CD.choosePlatformCount(p);
    assert.ok(choice.n >= 7 && choice.n <= 12, `N out of range at ${p}`);
    assert.equal(choice.bandIndex, CD.bandFit(p, choice.n).bandIndex);
    for (let n = 7; n <= 12; n++) {
      const fit = CD.bandFit(p, n);
      assert.ok(fit.centerRemainder + 1e-9 >= choice.centerRemainder, `p=${p} n=${n} fits better`);
      if (Math.abs(fit.centerRemainder - choice.centerRemainder) <= 1e-9) {
        assert.ok(choice.n <= n, `p=${p}: tie should keep the smaller N`);
      }
    }
  }
});

test("tie-break is the smaller N, and a few percentiles land where expected", () => {
  // 50% is the exact center of a band for N = 7, 9, and 11. Smaller N wins.
  const mid = CD.choosePlatformCount(50);
  assert.equal(mid.n, 7);
  assert.equal(mid.bandIndex, 3);
  assert.ok(mid.centerRemainder < 1e-9);

  // 95% is the exact center of the top band when N = 10.
  const high = CD.choosePlatformCount(95);
  assert.equal(high.n, 10);
  assert.equal(high.bandIndex, 9);
  assert.ok(high.centerRemainder < 1e-9);

  // 90% sits nearest the center on 7 platforms, on the top step.
  const ninety = CD.choosePlatformCount(90);
  assert.equal(ninety.n, 7);
  assert.equal(ninety.bandIndex, 6);

  // 15% is the exact center of band 2 (index 1) when N = 10.
  const low = CD.choosePlatformCount(15);
  assert.equal(low.n, 10);
  assert.equal(low.bandIndex, 1);

  // Every N puts 0 and 100 on an edge, so the tie-break keeps 7 platforms.
  assert.equal(CD.choosePlatformCount(0).n, 7);
  assert.equal(CD.choosePlatformCount(0).bandIndex, 0);
  assert.equal(CD.choosePlatformCount(100).n, 7);
  assert.equal(CD.choosePlatformCount(100).bandIndex, 6);
});

test("synthetic scores sit slightly under a realistic average, with a wide spread", () => {
  const realistic = CD.REALISTIC_AVERAGE_TOTAL;
  const target = realistic * CD.SEED_MEAN_RATIO;
  assert.ok(CD.SEED_MEAN_RATIO > 0.9 && CD.SEED_MEAN_RATIO < 1, "the shift should be slight");
  const means = [];
  for (const [id, day] of DAYS) {
    const scores = CD.syntheticScores(id, day);
    assert.equal(scores.length, CD.SYNTHETIC_PLAYERS);
    assert.deepEqual(scores, CD.syntheticScores(id, day));
    const m = mean(scores);
    const sd = stdev(scores);
    means.push(m);
    assert.ok(m < realistic, `${id} mean ${m} should be under the realistic average`);
    assert.ok(Math.abs(m - target) < realistic * 0.015, `${id} mean ${m} drifted from the ${CD.SEED_MEAN_RATIO} target`);
    // A narrow cluster around the middle would be an sd of a couple thousand.
    assert.ok(sd > 5000, `${id} sd ${sd} is too tight to be a realistic spread`);
    assert.ok(sd < 9000, `${id} sd ${sd} is wider than a plausible day`);
    assert.ok(scores.some(s => s < 3000), `${id} has no low scores`);
    assert.ok(scores.filter(s => s > 22000).length >= 8, `${id} top end is too thin`);
    assert.ok(Math.max(...scores) - Math.min(...scores) > 20000);
  }
  const avg = mean(means);
  const gap = (realistic - avg) / realistic;
  assert.ok(gap > 0.03 && gap < 0.06, `average gap ${(gap * 100).toFixed(2)}% should be a small, subtle dip`);
  assert.notDeepEqual(CD.syntheticScores("she-004", "2026-10-24"), CD.syntheticScores("she-004", "2026-10-25"));
});

test("nobody beats 100% of the seeded field, including a strong score", () => {
  for (const [id, day] of DAYS) {
    const scores = CD.syntheticScores(id, day);
    const blend = CD.blendSamples(scores, []);
    assert.equal(blend.syntheticWeight, 1);
    assert.equal(blend.realWeight, 0);
    for (const total of [0, 8000, 15000, 17500, 20000, 22000, 24000, 25000]) {
      const pct = CD.percentBeaten(total, blend);
      assert.ok(pct < 100, `${id} ${day} total ${total} beat ${pct}% of the seed`);
    }
    // A decent / strong day (20,000 is 80% of a perfect 25,000) still has company above it.
    const strong = CD.percentBeaten(20000, blend);
    assert.ok(strong < 97, `${id} 20,000 beat ${strong}%, which is effectively everyone`);
    assert.ok(scores.filter(s => s > 20000).length >= 8);
    const cmp = CD.compareScore(20000, scores, []);
    assert.equal(cmp.seeded, true);
    assert.ok(cmp.bandWeights.every(w => w > 0), "every performance band should have some seeded players");
    assert.ok(cmp.figures.every(n => n >= 1));
  }
});

test("synthetic weight shrinks in a straight line until COMMUNITY_REAL_TAKEOVER", () => {
  const take = CD.COMMUNITY_REAL_TAKEOVER;
  assert.equal(typeof take, "number");
  assert.ok(take >= 10 && take <= 500);
  const synth = [10000, 10000, 10000, 10000];
  const weight = n => CD.blendSamples(synth, Array(n).fill(0)).syntheticWeight;
  assert.equal(weight(0), 1);
  assert.equal(weight(take), 0);
  assert.equal(weight(take + 25), 0);
  assert.ok(Math.abs(weight(take / 2) - 0.5) < 1e-12);

  // Player on 5,000 loses to a field of 10,000s and beats a field of zeros.
  // The displayed percent walks from the synthetic answer to the real one.
  const pct = n => CD.percentBeaten(5000, CD.blendSamples(synth, Array(n).fill(0)));
  assert.equal(pct(0), 0);
  assert.equal(pct(take / 2), 50);
  assert.equal(pct(take), 100);
  let prev = -1;
  for (const n of [0, 1, Math.round(take / 4), take / 2, Math.round(take * 0.75), take - 1, take, take * 2]) {
    const next = pct(n);
    assert.ok(next >= prev, `percent went backwards at ${n} real plays`);
    prev = next;
  }

  // Once the takeover count is met, the synthetic sample is ignored.
  assert.equal(CD.percentBeaten(5000, CD.blendSamples([0, 0, 0, 0], Array(take).fill(0))), 100);
  assert.equal(CD.percentBeaten(5000, CD.blendSamples([0, 0, 0, 0], Array(take).fill(20000))), 0);
  const handed = CD.compareScore(5000, synth, Array(take).fill(0));
  assert.equal(handed.seeded, false);
  assert.equal(handed.syntheticWeight, 0);
  assert.equal(handed.percent, 100);
});

test("seeded snapshots give back only the real finishes stacked on the stand-in", () => {
  const seed = [
    { min: 0, max: 5000, n: 10 },
    { min: 5000, max: 10000, n: 20 },
    { min: 10000, max: 15000, n: 30 },
  ];
  const mixed = [
    { min: 0, max: 5000, n: 10 },
    { min: 5000, max: 10000, n: 22 },
    { min: 10000, max: 15000, n: 31 },
  ];
  const peeled = CD.peelRealScores(mixed, seed);
  assert.equal(peeled.length, 3);
  assert.deepEqual(peeled.slice().sort((a, b) => a - b), [7500, 7500, 12500]);
  assert.equal(CD.peelRealScores(seed, seed).length, 0);
  // A fully real snapshot is not peeled, even if a seed histogram is passed in.
  const raw = CD.realScoresFromSnapshot({ seeded: false, histogram: mixed }, seed);
  assert.equal(raw.length, 63);
  const onlyReal = CD.realScoresFromSnapshot({ seeded: true, histogram: mixed }, seed);
  assert.equal(onlyReal.length, 3);
  assert.deepEqual(CD.realScoresFromSnapshot({ seeded: false, histogram: null }, seed), []);
});

test("unfinished games are not ranked against full-day totals", () => {
  const five = [{ pts: 1000 }, { pts: 2000 }, { pts: 3000 }, { pts: 4000 }, { pts: 5000 }];
  assert.equal(CD.finishedTotal(null), null);
  assert.equal(CD.finishedTotal({ done: false, rounds: five }), null);
  assert.equal(CD.finishedTotal({ done: true, rounds: five.slice(0, 3) }), null);
  assert.equal(CD.finishedTotal({ done: true, rounds: [{ pts: 1 }, { pts: 1 }, { pts: 1 }, { pts: 1 }, { pts: "nope" }] }), null);
  assert.equal(CD.finishedTotal({ done: true, rounds: five }), 15000);
  assert.equal(CD.finishedTotal({ done: true, rounds: five.map(() => ({ pts: 0 })) }), 0);
});

test("figure counts track band size, and celebration grows toward the top", () => {
  assert.deepEqual(CD.figureCounts([1, 2, 4], 4), [1, 2, 4]);
  assert.deepEqual(CD.figureCounts([5, 5, 5], 3), [3, 3, 3]);
  assert.deepEqual(CD.figureCounts([0, 2], 3), [0, 3]);
  assert.equal(CD.celebrationTier(0, 7), "low");
  assert.equal(CD.celebrationTier(3, 7), "mid");
  assert.equal(CD.celebrationTier(6, 7), "high");
  assert.equal(CD.celebrationTier(0, 12), "low");
  assert.equal(CD.celebrationTier(11, 12), "high");
});
