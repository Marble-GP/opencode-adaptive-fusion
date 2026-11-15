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

// Probe strictness (documented behavior of VERIFY/probeOne)
const probeOk = (text) => String(text ?? "").trim() === "OK";
check("probe accepts exact OK", probeOk("OK"), true);
check("probe accepts padded OK", probeOk("  OK  "), true);
check("probe rejects verbose answer", probeOk("OK, here is what I found..."), false);
check("probe rejects empty", probeOk(""), false);
check("probe rejects undefined", probeOk(undefined), false);

if (failures > 0) {
  console.log(`\nTOTAL: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nTOTAL: ALL PASS");
