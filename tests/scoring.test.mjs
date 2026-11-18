// Regression tests for the pure scoring helpers of Adaptive Fusion.
//
// These functions are defined inside the plugin's setup() closure, so they are
// mirrored here until the planned module split (routing/scoring) makes them
// directly importable. Keep this file in sync with plugins/adaptive-fusion/index.ts.
// Run with: node tests/scoring.test.mjs

const num = (v, fb) => (typeof v === "number" ? v : fb);
const AUTO_REVIEW_MIN_SAMPLES = 10;

// --- mirrors of index.ts helpers -------------------------------------------

const autoReviewScore = (auto) => {
  if (!auto || typeof auto !== "object") return 0.5;
  const a = auto;
  const n = num(a.total, 0);
  if (n < AUTO_REVIEW_MIN_SAMPLES) return 0.5;
  const sum3 =
    num(a.instruction, 0) + num(a.accuracy, 0) + num(a.completeness, 0);
  const normalizedSum = (sum3 - 3 * n) / 4;
  return (normalizedSum + 1) / (3 * n + 6);
};

const feedbackScore = (feedback) => {
  const n = num(feedback?.count, 0);
  const raw = num(feedback?.ratingSum, 0);
  if (n <= 0) return 0.5;
  const normalizedSum = (raw - n) / 4;
  return (normalizedSum + 1) / (n + 2);
};

const effectiveAutoWeight = (cfgW, auto, feedback) => {
  if (cfgW <= 0 || !auto) return 0;
  const autoN = num(auto.total, 0);
  if (autoN < AUTO_REVIEW_MIN_SAMPLES) return 0;
  const autoAvg =
    (auto.instruction + auto.accuracy + auto.completeness) / (autoN * 3);
  const humanN = num(feedback?.count, 0);
  if (humanN < 5) return cfgW;
  const humanAvg = num(feedback?.ratingSum, 0) / humanN;
  return Math.abs(autoAvg - humanAvg) >= 1.0 ? cfgW / 2 : cfgW;
};

const routingCostOf = (model) => {
  const tier = model?.cost?.[0];
  if (!tier) return Infinity;
  return (
    num(tier.input, 0) +
    num(tier.output, 0) +
    num(tier.cache?.read, 0) +
    num(tier.cache?.write, 0)
  );
};

// --- tests ------------------------------------------------------------------

let failures = 0;
const check = (name, actual, expected, tol = 1e-9) => {
  const ok = typeof expected === "number"
    ? (Number.isFinite(expected)
      ? Math.abs(actual - expected) < tol
      : actual === expected)
    : actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name} => ${actual}`);
  if (!ok) failures++;
};

// Audit signal: gates
check("missing auto -> neutral", autoReviewScore(undefined), 0.5);
check("weight 0 -> no effect", effectiveAutoWeight(0, undefined, undefined), 0);
check(
  "9 samples -> sample gate (neutral)",
  autoReviewScore({ total: 9, instruction: 45, accuracy: 45, completeness: 45 }),
  0.5,
);
check(
  "10 mid samples -> 0.4444",
  autoReviewScore({ total: 10, instruction: 30, accuracy: 30, completeness: 30 }),
  (15 + 1) / 36,
);
check(
  "10 max samples -> 0.8611",
  autoReviewScore({ total: 10, instruction: 50, accuracy: 50, completeness: 50 }),
  31 / 36,
);
check(
  "10 min samples -> 0.0278",
  autoReviewScore({ total: 10, instruction: 10, accuracy: 10, completeness: 10 }),
  1 / 36,
);

// Human feedback smoothing
check("no feedback -> neutral", feedbackScore(undefined), 0.5);
check("10 mid ratings -> neutral", feedbackScore({ count: 10, ratingSum: 30 }), 0.5);
check("10 max ratings -> 11/12", feedbackScore({ count: 10, ratingSum: 50 }), 11 / 12);

// Divergence guard
const goodAuto = { total: 10, instruction: 40, accuracy: 40, completeness: 40 };
check("delta >= 1.0 halves weight", effectiveAutoWeight(0.5, goodAuto, { count: 10, ratingSum: 20 }), 0.25);
check("delta < 1.0 keeps weight", effectiveAutoWeight(0.5, goodAuto, { count: 10, ratingSum: 38 }), 0.5);
check("few human ratings -> guard not fired", effectiveAutoWeight(0.5, goodAuto, { count: 2, ratingSum: 2 }), 0.5);
check("below sample gate -> weight 0", effectiveAutoWeight(0.5, { total: 9, instruction: 45, accuracy: 45, completeness: 45 }, { count: 10, ratingSum: 50 }), 0);

// Quality blend bounds
const human = feedbackScore({ count: 10, ratingSum: 40 });
const auto = autoReviewScore({ total: 10, instruction: 20, accuracy: 20, completeness: 20 });
check("blend w=0 -> human only", (1 - 0) * human + 0 * auto, human);
check("blend w=1 -> audit only", (1 - 1) * human + 1 * auto, auto);

// Full-turn cost model
check(
  "cost sums input+output+cache",
  routingCostOf({ cost: [{ input: 0.1, output: 1.5, cache: { read: 0.02, write: 0.2 } }] }),
  1.82,
);
check("missing tier -> Infinity", routingCostOf({}), Infinity);
check("missing cache -> input+output only", routingCostOf({ cost: [{ input: 0.5, output: 2 }] }), 2.5);

// Probe strictness (documented behavior of VERIFY/probeOne):
// the reply must be exactly "OK" — case-insensitive, optional trailing
// punctuation, surrounding whitespace ignored. Anything else (verbose
// answers, refusals, empty) is a failure.
const probeOk = (text) => /^ok[.!]?$/i.test(String(text ?? "").trim());
check("probe accepts exact OK", probeOk("OK"), true);
check("probe accepts lowercase ok", probeOk("ok"), true);
check("probe accepts OK with period", probeOk("OK."), true);
check("probe accepts padded OK", probeOk("  OK  "), true);
check("probe rejects verbose prefix", probeOk("OK, here is what I found..."), false);
check("probe rejects prose", probeOk("Certainly! The answer is OK"), false);
check("probe rejects okay", probeOk("okay"), false);
check("probe rejects empty", probeOk(""), false);
check("probe rejects undefined", probeOk(undefined), false);

// Task-shape topology prior (mirror of index.ts heuristicTopologyWeights /
// normalizeTopologyWeights / jevTopologyDistribution). The prior favors
// single by construction; heavy load shifts mass onto sequential-chain;
// coding/research/writing/debugging boost chain, review/ops boost single.
const heuristicTopologyWeights = (load, category) => {
  let single, chain, router;
  if (load === "light") {
    single = 0.85; chain = 0.03; router = 0.02;
  } else if (load === "middle") {
    single = 0.6; chain = 0.14; router = 0.04;
  } else if (load === "heavy") {
    single = 0.3; chain = 0.52; router = 0.08;
  } else {
    single = 0.6; chain = 0.1; router = 0.04;
  }
  const cat = category ?? "";
  if (cat === "research") { chain *= 1.6; router *= 2.0; }
  else if (cat === "coding") chain *= 1.4;
  else if (cat === "writing") chain *= 1.3;
  else if (cat === "debugging") chain *= 1.2;
  else if (cat === "review") { chain *= 0.7; single *= 1.2; router *= 1.5; }
  else if (cat === "ops") { chain *= 0.5; single *= 1.3; }
  return { single, router, "sequential-chain": chain };
};
const normalizeTopologyWeights = (weights) => {
  let total = 0;
  for (const v of Object.values(weights)) total += v;
  if (total <= 0) return { single: 1 };
  const out = {};
  for (const [k, v] of Object.entries(weights)) out[k] = v / total;
  return out;
};
const TOPOLOGY_CATALOG = { single: true, router: true, "sequential-chain": true };
const jevTopologyDistribution = (probabilities, choice, allowed) => {
  const filtered = {};
  for (const t of allowed) {
    if (!(t in TOPOLOGY_CATALOG)) continue;
    const v = probabilities?.[t];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) filtered[t] = v;
  }
  if (Object.keys(filtered).length === 0) {
    for (const t of allowed) filtered[t] = 1;
    if (choice && choice in filtered)
      for (const t of Object.keys(filtered)) filtered[t] = t === choice ? 1 : 0;
  }
  return normalizeTopologyWeights(filtered);
};
const allowedThree = ["single", "router", "sequential-chain"];
const sum1 = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const normSingle = normalizeTopologyWeights(heuristicTopologyWeights(undefined, undefined));
const normLight = normalizeTopologyWeights(heuristicTopologyWeights("light", undefined));
const normHeavy = normalizeTopologyWeights(heuristicTopologyWeights("heavy", undefined));
const normReview = normalizeTopologyWeights(heuristicTopologyWeights("heavy", "review"));
const normCoding = normalizeTopologyWeights(heuristicTopologyWeights("heavy", "coding"));
check("topology prior normalizes to 1 (unknown load)", sum1(normSingle), 1);
check("topology prior normalizes to 1 (light)", sum1(normLight), 1);
check("topology prior normalizes to 1 (heavy)", sum1(normHeavy), 1);
check("light: single dominant", normLight.single > 0.7, true);
check("heavy: chain probability > single probability", normHeavy["sequential-chain"] > normHeavy.single, true);
check("heavy: chain prob >= 0.4", normHeavy["sequential-chain"] >= 0.4, true);
check("review: chain reduced vs coding (heavy)", normReview["sequential-chain"] < normCoding["sequential-chain"], true);
check("review: single boosted", normReview.single > normHeavy.single, true);
check(
  "topology weights normalize proportionally",
  JSON.stringify(normalizeTopologyWeights({ single: 2, router: 1, "sequential-chain": 1 })),
  JSON.stringify({ single: 0.5, router: 0.25, "sequential-chain": 0.25 }),
);
check(
  "jev distribution: unknown keys excluded",
  JSON.stringify(jevTopologyDistribution({ single: 0.9, hier: 0.1 }, "single", allowedThree)),
  JSON.stringify({ single: 1 }),
);
check(
  "jev distribution: uniform fallback without probabilities",
  JSON.stringify(jevTopologyDistribution(undefined, undefined, allowedThree)),
  JSON.stringify({ single: 1 / 3, router: 1 / 3, "sequential-chain": 1 / 3 }),
);
check(
  "jev distribution: one-hot on choice when probs missing",
  JSON.stringify(jevTopologyDistribution({}, "sequential-chain", allowedThree)),
  JSON.stringify({ single: 0, router: 0, "sequential-chain": 1 }),
);
// --- Bayesian topology reward (mirror of topologyReward / bayesianTopologyDistribution) ---
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const topologyReward = (stat, priorMean, strength = 4, wAuto = 0.25, wCP = 0.25) => {
  const pm = clampN(priorMean, 0, 1);
  const strengthClamped = clampN(Math.floor(strength ?? 4), 1, 20);
  const a0 = 1 + strengthClamped * pm;
  const b0 = 1 + strengthClamped * (1 - pm);
  const auto =
    stat && stat.qualityCount > 0
      ? (stat.sumQuality / 5 + a0) / (stat.qualityCount + a0 + b0)
      : stat && stat.count > 0
        ? (stat.ok + a0) / (stat.count + a0 + b0)
        : pm;
  const cp =
    stat && stat.costPerformanceCount > 0
      ? (stat.sumCostPerformance / 5 + a0) / (stat.costPerformanceCount + a0 + b0)
      : 0.5;
  const total = wAuto + wCP;
  if (total <= 0) return auto;
  return (wAuto * auto + wCP * cp) / total;
};
check("reward no data returns prior mean", topologyReward(undefined, 0.6), 0.55, 1e-9);
check("reward quality 4/5 no data inherits prior", topologyReward({ qualityCount: 0, count: 0, ok: 0, sumQuality: 0 }, 0.6), 0.55, 1e-9);
// strength 4, prior 0.5: a0=b0=3, quality 4/5=0.8, 1 sample -> auto=(0.8+3)/7≈0.543, cp=0.5, reward=(0.25*0.543+0.25*0.5)/0.5≈0.5214
check("reward one quality sample pulls toward data", topologyReward({ qualityCount: 1, sumQuality: 4, count: 1, ok: 1 }, 0.5), 0.5214285714285714, 1e-9);
// higher strength anchors more to prior: strength 20, prior 0.9, 1 quality 0.2 sample stays close to 0.9
const rLowPrior = topologyReward({ qualityCount: 1, sumQuality: 1, count: 1, ok: 0 }, 0.9, 4);
const rHighPrior = topologyReward({ qualityCount: 1, sumQuality: 1, count: 1, ok: 0 }, 0.9, 20);
check("higher strength anchors to prior (higher reward)", rHighPrior > rLowPrior, true);

// Benchmark auto-refresh mapping (mirror of index.ts buildBenchmarkModels).
// OpenRouter payload: benchmarks.artificial_analysis indices (0..100) are
// normalized to 0..1; models without indices are skipped; coding falls back
// to intelligence, ops falls back agentic->intelligence, review is the mean
// of intelligence and (agentic ?? intelligence).
const buildBenchmarkModels = (rawModels) => {
  const clampIdx = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.min(1, Math.max(0, value / 100));
  };
  const out = {};
  for (const raw of rawModels) {
    const id = typeof raw?.id === "string" ? raw.id : undefined;
    if (!id) continue;
    const aa = raw?.benchmarks?.artificial_analysis;
    const intelligence = clampIdx(aa?.intelligence_index);
    if (intelligence === undefined) continue;
    const coding = clampIdx(aa?.coding_index) ?? intelligence;
    const agentic = clampIdx(aa?.agentic_index);
    out[`openrouter/${id}`] = {
      overall: intelligence,
      coding,
      debugging: coding,
      research: intelligence,
      writing: intelligence,
      ops: agentic ?? intelligence,
      review: (intelligence + (agentic ?? intelligence)) / 2,
    };
  }
  return out;
};
const aaOf = (i, c, a) => ({
  benchmarks: {
    artificial_analysis: {
      intelligence_index: i,
      coding_index: c,
      agentic_index: a,
    },
  },
});
const mapped = buildBenchmarkModels([
  { id: "acme/full", ...aaOf(31.7, 74.8, 53.1) },
  { id: "acme/no-coding", ...aaOf(20, null, 40) },
  { id: "acme/no-agentic", ...aaOf(10, 30, null) },
  { id: "acme/no-indices", ...({}) },
  { id: 42, ...aaOf(50, 50, 50) },
]);
check("maps 3 of 5 entries", Object.keys(mapped).length, 3);
check("normalizes /100", mapped["openrouter/acme/full"].overall, 0.317);
check("coding passes through", mapped["openrouter/acme/full"].coding, 0.748);
check("review = mean(intel, agentic)", mapped["openrouter/acme/full"].review, (0.317 + 0.531) / 2);
check("coding null falls back to intelligence", mapped["openrouter/acme/no-coding"].coding, 0.2);
check("agentic null: ops falls back to intelligence", mapped["openrouter/acme/no-agentic"].ops, 0.1);
check("agentic null: review = intelligence", mapped["openrouter/acme/no-agentic"].review, 0.1);
check("out-of-range clipped", buildBenchmarkModels([{ id: "x/clip", ...aaOf(150, -20, 50) }])["openrouter/x/clip"].overall, 1);

// --- Attempt-aware rescue counter (mirror of noteAttemptFailure / attemptGateOpen) ---
// The counter does NOT time-dedupe genuine retries (A11 regression: a 15 s
// window suppressed fast retries). Cross-path (HTTP + event) dedupe is done
// by the caller's seenViaHttp peek; the counter only collapses the same
// attempt's double sighting within ATTEMPT_RACE_MS, resets after the window,
// and is reset on success (consecutive-failure semantics).
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const ATTEMPT_RACE_MS = 2_000;
const attemptFailures = new Map();
const attemptKey = (sid, ref) => `${sid}\n${ref}`;
const clock = { now: 1_000_000_000 };
const peekAttemptFailures = (sid, ref, now = clock.now) => {
  const entry = attemptFailures.get(attemptKey(sid, ref));
  if (!entry || now - entry.at > ATTEMPT_WINDOW_MS) return 0;
  return entry.count;
};
const noteAttemptFailure = (sid, ref, now = clock.now) => {
  const key = attemptKey(sid, ref);
  const entry = attemptFailures.get(key);
  if (entry && now - entry.at <= ATTEMPT_RACE_MS) return entry.count;
  if (entry && now - entry.at > ATTEMPT_WINDOW_MS) {
    attemptFailures.set(key, { count: 1, at: now });
    return 1;
  }
  const count = (entry?.count ?? 0) + 1;
  attemptFailures.set(key, { count, at: now });
  return count;
};
// attemptLimit clamps 1..10 with default 3 (mirror of index.ts attemptLimit)
const attemptLimitOf = (configured) =>
  Math.max(1, Math.min(10, Math.floor(configured ?? 3)));
// attemptGateOpen mirror: counts, then gates on count < limit
const attemptGateOpen = (sid, ref, configured, now = clock.now) => {
  const count = noteAttemptFailure(sid, ref, now);
  return count >= attemptLimitOf(configured);
};
// one failure, seen through both channels within the race window: counts once
check("attempt 1 via HTTP", noteAttemptFailure("s1", "p/m", clock.now), 1);
check("same attempt second sighting deduped", noteAttemptFailure("s1", "p/m", clock.now + 500), 1);
// A11 regression: failures at t=0/5s/10s are 3 distinct retries and must all count
check("attempt 2 counted (5s later)", noteAttemptFailure("s1", "p/m", clock.now + 5_000), 2);
check("attempt 2 second sighting deduped", noteAttemptFailure("s1", "p/m", clock.now + 5_500), 2);
check("attempt 3 counted (10s later)", noteAttemptFailure("s1", "p/m", clock.now + 10_000), 3);
check("gate open at 3/3 (default limit)", peekAttemptFailures("s1", "p/m", clock.now + 10_000) >= attemptLimitOf(undefined), true);
// gate stays closed below the (configurable) limit
check("gate closed at 1/2", attemptGateOpen("s2", "p/m", 2, clock.now), false);
check("gate open at 2/2", attemptGateOpen("s2", "p/m", 2, clock.now + 5_000), true);
check("limit clamped to >=1", attemptLimitOf(0), 1);
check("limit clamped to <=10", attemptLimitOf(99), 10);
// success resets the budget (A1-4: consecutive-failure semantics)
attemptFailures.delete(attemptKey("s1", "p/m"));
check("reset clears budget", peekAttemptFailures("s1", "p/m"), 0);
// window expiry restarts counting
check("attempt after first failure", noteAttemptFailure("s3", "p/m", clock.now), 1);
check(
  "window expiry restarts counting",
  noteAttemptFailure("s3", "p/m", clock.now + ATTEMPT_WINDOW_MS + 1),
  1,
);

// --- Variant (reasoning-effort) selection (mirror of pickVariantIndex / variantLevelFor) ---
// "Model first, then variant": the effort LEVEL is a function of the task band
// and the CHOSEN MODEL's weight class — matched pairs keep the provider
// default, heavier-than-model tasks compensate up, lighter ones down. The
// variant itself is positional over the model's own list ranked by effort.
const VARIANT_EFFORT_RANK = {
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  med: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  thinking: 3,
  reasoning: 3,
};
const variantEffortRank = (id) => VARIANT_EFFORT_RANK[id.toLowerCase()] ?? 2;
const variantBandLevel = (load) => 2 - ["heavy", "middle", "light"].indexOf(load);
// Production rounds the raw hint at the call site:
// variantLevelForLevel(clamp(Math.round(bandLevel), 0, 2), cls)
const variantLevelForLevel = (band, cls) => {
  const b = Math.min(2, Math.max(0, Math.round(band)));
  if (!cls) return b;
  const delta = b - variantBandLevel(cls);
  if (delta === 0) return undefined;
  return Math.max(0, Math.min(2, 1 + delta));
};
const pickVariantIndex = (variants, level) => {
  if (!Array.isArray(variants) || variants.length < 2) return -1;
  const ranked = variants
    .map((v, i) => ({ rank: variantEffortRank(String(v)), i }))
    .sort((a, b) => a.rank - b.rank);
  if (level >= 2) return ranked[ranked.length - 1].i;
  if (level === 1)
    return ranked[Math.max(0, Math.ceil(ranked.length / 2) - 1)].i;
  return ranked[0].i;
};
const variantLevelFor = (load, cls) => {
  const band = variantBandLevel(load);
  if (!cls) return band;
  const delta = band - variantBandLevel(cls);
  if (delta === 0) return undefined;
  return Math.max(0, Math.min(2, 1 + delta));
};
const pickOf = (list, level) => (pickVariantIndex(list, level) >= 0 ? list[pickVariantIndex(list, level)] : undefined);
// level computation: matched -> default, mismatch -> compensate
check("light on light -> default (no override)", variantLevelFor("light", "light"), undefined);
check("heavy on heavy -> default (no override)", variantLevelFor("heavy", "heavy"), undefined);
check("heavy on light -> compensate up (highest)", variantLevelFor("heavy", "light"), 2);
check("light on heavy -> save cost (lowest)", variantLevelFor("light", "heavy"), 0);
check("middle on light -> compensate up", variantLevelFor("middle", "light"), 2);
check("light on middle -> lowest", variantLevelFor("light", "middle"), 0);
check("unknown class -> band itself", variantLevelFor("heavy", undefined), 2);
check("unknown class light -> 0", variantLevelFor("light", undefined), 0);
check("fractional hint rounds up (2.4->2)", variantLevelForLevel(2.4, undefined), 2);
check("fractional hint rounds (0.4->0)", variantLevelForLevel(0.4, undefined), 0);
check("fractional hint rounds (1.6->2)", variantLevelForLevel(1.6, undefined), 2);
// positional pick over the model's own list
check("no variants -> no pick", pickOf(["high"], 2), undefined);
check("level 0 picks lowest effort", pickOf(["low", "medium", "high"], 0), "low");
check("level 1 picks median", pickOf(["low", "medium", "high"], 1), "medium");
check("level 2 picks highest effort", pickOf(["low", "medium", "high"], 2), "high");
check("even count median picks lower median", pickOf(["high", "max"], 1), "high");
check("openai scale level 2", pickOf(["none", "minimal", "low", "medium", "high", "xhigh"], 2), "xhigh");
check("unknown ids rank mid", pickOf(["fast", "turbo", "ultra"], 2), "ultra");
check("unknown ids level 0", pickOf(["fast", "turbo", "ultra"], 0), "fast");
check("stable order for ties", pickOf(["a", "b", "c", "d"], 0), "a");

// --- Closed-loop variant bandit (mirror of the neighbor competition) ---
// The computed pick competes on Laplace-smoothed ok-rate with adjacent effort
// levels: data-bearing neighbors (count >= 2) with a better rate take over;
// an unobserved neighbor rescues a pick performing below neutral (0.5);
// ties keep the computed pick.
const variantOkScore = (stat) => (stat && stat.count > 0 ? (stat.ok + 1) / (stat.count + 2) : 0.5);
const variantBanditPos = (stats, computedPos, len) => {
  let pos = computedPos;
  let bestScore = variantOkScore(stats[computedPos]);
  for (const j of [computedPos - 1, computedPos + 1]) {
    if (j < 0 || j >= len) continue;
    const neighbor = stats[j];
    const score = variantOkScore(neighbor);
    const compete =
      neighbor && neighbor.count >= 2
        ? score > bestScore
        : !neighbor && bestScore < 0.5;
    if (compete) {
      pos = j;
      bestScore = score;
    }
  }
  return pos;
};
const S = (ok, count) => ({ ok, count });
check("bandit: all unobserved keeps computed", variantBanditPos([undefined, undefined, undefined], 1, 3), 1);
check("bandit: bad pick escapes to unobserved lower neighbor", variantBanditPos([undefined, S(0, 3), undefined], 1, 3), 0);
check("bandit: unobserved tie bias is neutral (escape picks one side)", variantBanditPos([undefined, S(1, 3), undefined], 1, 3), 0);
check("bandit: neutral pick not stolen by unobserved", variantBanditPos([undefined, undefined, undefined], 1, 3), 1);
check("bandit: single lucky sample does not churn", variantBanditPos([S(1, 1), undefined, undefined], 1, 3), 1);
check("bandit: 2/2 evidence beats neutral", variantBanditPos([S(2, 2), undefined, undefined], 1, 3), 0);
check("bandit: 1/3 evidence loses to unobserved pick", variantBanditPos([S(1, 3), undefined, undefined], 1, 3), 1);
check("bandit: good pick keeps despite 2/2 neighbor", variantBanditPos([S(2, 2), S(4, 4), undefined], 1, 3), 1);
check("bandit: boundary pos 0 escapes right", variantBanditPos([S(0, 3), undefined, undefined], 0, 3), 1);
check("bandit: boundary pos 2 escapes left", variantBanditPos([undefined, undefined, S(0, 3)], 2, 3), 1);

// --- Review turn grouping (mirror of groupReviewTurns, v1.1.1) ---
// A turn = one user prompt + its assistant messages. A tool-using response has
// several assistant messages; the review target is the turn's LAST assistant
// message with text, and offset counts LOGICAL TURNS (not messages — the old
// behavior landed on steps of the same turn and showed "stuck" stats).
const groupReviewTurns = (context, messageText, userTextOf) => {
  const chronological = [...context].sort(
    (a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0),
  );
  const turns = [];
  let current;
  for (const message of chronological) {
    if (message?.type === "user") {
      const text = userTextOf(message).trim();
      if (text.length === 0) continue;
      current = { instruction: text, assistants: [] };
      turns.push(current);
    } else if (message?.type === "assistant" && message?.model) {
      if (!current) {
        current = { instruction: "", assistants: [] };
        turns.push(current);
      }
      current.assistants.push(message);
    }
  }
  return turns
    .map((t) => ({
      instruction: t.instruction,
      assistant:
        [...t.assistants].reverse().find((a) => messageText(a).length > 0) ??
        t.assistants[t.assistants.length - 1],
    }))
    .filter((t) => t.assistant !== undefined)
    .reverse();
};
const mt = (m) => (m?.text ?? "").trim();
const ut = (m) => (m?.text ?? "").trim();
const M = (type, id, text, created) => ({
  type,
  id,
  text,
  time: { created },
  ...(type === "assistant" ? { model: { providerID: "p", id: "m" } } : {}),
});
// one logical turn with multiple steps (tool use): a single review target
const multiStep = groupReviewTurns(
  [
    M("user", "u1", "fix the bug", 100),
    M("assistant", "a1", "reading files...", 200),
    M("assistant", "a2", "", 300), // tool-call step, no text
    M("assistant", "a3", "fixed the bug", 400),
  ],
  mt,
  ut,
);
check("multi-step turn is ONE review target", multiStep.length, 1);
check("multi-step turn targets the final body", multiStep[0].assistant.id, "a3");
check("multi-step turn keeps its instruction", multiStep[0].instruction, "fix the bug");
// two logical turns: offset 0 = newest, offset 1 = previous
const twoTurns = groupReviewTurns(
  [
    M("user", "u1", "first request", 100),
    M("assistant", "a1", "first answer", 200),
    M("user", "u2", "second request", 300),
    M("assistant", "a2", "second answer", 400),
  ],
  mt,
  ut,
);
check("two turns counted", twoTurns.length, 2);
check("offset 0 targets the newest turn", twoTurns[0].assistant.id, "a2");
check("offset 1 targets the previous turn", twoTurns[1].assistant.id, "a1");
check("offset 1 instruction is that turn's", twoTurns[1].instruction, "first request");
// empty user messages (attachments) do not split a turn
const withAttach = groupReviewTurns(
  [
    M("user", "u1", "check this", 100),
    M("user", "u2", "", 150), // attachment-only, no text
    M("assistant", "a1", "checked", 200),
  ],
  mt,
  ut,
);
check("attachment-only user message does not split a turn", withAttach.length, 1);
// turn without any text body keeps its last assistant (preview shows empty)
const noBody = groupReviewTurns(
  [M("user", "u1", "do it", 100), M("assistant", "a1", "", 200)],
  mt,
  ut,
);
check("turn with no body still targetable", noBody.length, 1);
check("no-body turn targets last assistant", noBody[0].assistant.id, "a1");

// --- Provider chain priority (mirror of firstHealthyChainIndex, v1.1.1) ---
// Candidates come from the FIRST chain entry that still has eligible
// candidates; -1 when every entry is exhausted (caller keeps the full pool).
const firstHealthyChainIndex = (models, chain, eligible) => {
  for (let i = 0; i < chain.length; i++) {
    if (models.some((m) => m.providerID === chain[i] && eligible(m))) return i;
  }
  return -1;
};
const P = (providerID) => ({ providerID });
const okM = () => true;
check("chain: first healthy entry wins", firstHealthyChainIndex([P("opencode-go"), P("opencode")], ["opencode-go", "opencode", "openrouter"], okM), 0);
check("chain: exhausted primary falls to next", firstHealthyChainIndex([P("opencode"), P("openrouter")], ["opencode-go", "opencode", "openrouter"], okM), 1);
check("chain: last entry works", firstHealthyChainIndex([P("openrouter")], ["opencode-go", "opencode", "openrouter"], okM), 2);
check("chain: eligibility filter respected", firstHealthyChainIndex([P("opencode-go"), P("opencode")], ["opencode-go", "opencode"], (m) => m.providerID !== "opencode-go"), 1);
check("chain: all exhausted -> -1", firstHealthyChainIndex([P("anthropic")], ["opencode-go", "opencode"], okM), -1);
check("chain: empty chain -> -1", firstHealthyChainIndex([P("opencode-go")], [], okM), -1);
check("chain: out-of-chain candidates ignored", firstHealthyChainIndex([P("anthropic"), P("opencode")], ["opencode-go", "opencode"], okM), 1);
// rescue: chain[0] has only UNOBSERVED non-cooling models -> falls through to chain[1]
// (the observed-only rule must apply in the emergency branch too — otherwise
// rescue narrows to an unobservable provider and stalls)
check(
  "chain: rescue falls through when chain[0] is unobserved",
  firstHealthyChainIndex([P("opencode-go"), P("opencode")], ["opencode-go", "opencode"], (m) => m.providerID !== "opencode-go"),
  1,
);

// --- Model list mode (mirror of the candidates() list predicate, v1.1.1) ---
// whitelist: only listed models (empty = all); blacklist: everything except
// the listed ones. Entries match the full `provider/model-id` form and the
// bare `model-id` form (a bare id matches/excludes that model on every
// provider), with the `:free` suffix normalized away (mirror of listHas).
const normRefOf = (ref) => ref.replace(/:free$/, "");
const listAllows = (listMode, list, providerID, modelID) => {
  const full = `${providerID}/${modelID}`;
  const has =
    list.includes(full) ||
    list.includes(normRefOf(full)) ||
    list.includes(modelID) ||
    list.includes(normRefOf(modelID));
  if (listMode === "blacklist") return !has;
  return list.length === 0 || has;
};
check("whitelist: empty list allows all", listAllows("whitelist", [], "opencode-go", "qwen4-max"), true);
check("whitelist: full ref allows", listAllows("whitelist", ["opencode-go/qwen4-max"], "opencode-go", "qwen4-max"), true);
check("whitelist: bare id allows", listAllows("whitelist", ["qwen4-max"], "opencode-go", "qwen4-max"), true);
check("whitelist: unlisted denied", listAllows("whitelist", ["opencode-go/qwen4-max"], "opencode", "iceman-free"), false);
check("blacklist: empty list allows all", listAllows("blacklist", [], "opencode", "iceman-free"), true);
check("blacklist: full ref excludes", listAllows("blacklist", ["opencode-go/qwen4-max"], "opencode-go", "qwen4-max"), false);
check("blacklist: bare id excludes across providers", listAllows("blacklist", ["iceman-free"], "opencode", "iceman-free"), false);
check("blacklist: others allowed", listAllows("blacklist", ["opencode-go/qwen4-max"], "opencode", "iceman-free"), true);
check("whitelist: :free suffix normalized", listAllows("whitelist", ["opencode/iceman"], "opencode", "iceman-free"), true);
check("blacklist: :free suffix normalized", listAllows("blacklist", ["opencode/iceman"], "opencode", "iceman-free"), false);


if (failures > 0) {
  console.log(`\nTOTAL: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nTOTAL: ALL PASS");
