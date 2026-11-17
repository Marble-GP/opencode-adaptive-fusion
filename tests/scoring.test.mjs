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


if (failures > 0) {
  console.log(`\nTOTAL: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nTOTAL: ALL PASS");
