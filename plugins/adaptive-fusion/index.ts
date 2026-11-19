// OpenCode Adaptive Fusion - Server part
//
// Prototype corresponding to Phase1 + Phase2 (task classification) of the proposal.
//  - The prompt hook classifies tasks (using ctx.experimental.generate.text) and keeps the result per session
//  - The experimental.model.resolve hook swaps models based on per-task-category x model learned scores
//    v1.1: it also selects the reasoning-effort variant (#low/#high/#max...) matching the task's load band
//  - The http.request / http.response hooks collect latency and success/failure, persisted to ctx.storage
//  - RPC provides stats display / config changes / reset to the TUI part (tui.tsx)
//
// Settings are persisted to fusion/config and can be changed from the TUI (/fusion-config / /fusion-whitelist).
// Priority: saved settings > opencode.json options.
//
// Stats have two layers (keys include the actual provider):
//  - fusion/stat/<provider>/<model>            : overall stats (fallback)
//  - fusion/task/<category>/<provider>/<model> : per-category stats (preferred)
//
// With crossProvider, candidates are expanded to all providers, and the whitelist
// uses the full-reference form `provider/model-id`.
//
// Failure detection and safe fallback:
//  - resolve-level "model unavailable" (Model unavailable) is detected from session.step.failed /
//    session.retry.scheduled events; the offending model is cooled down and excluded from candidates
//  - v1.1: session.retry.scheduled is a retry announcement, not a failure — transient
//    failures are counted per session/model and rescue only runs after
//    rescueAttemptsBeforeSwitch (default 3) consecutive attempts; definitive
//    signals (Model unavailable / quota) still rescue immediately
//  - Free-tier (quota) failures are excluded from the quality penalty and only get a long cooldown (6h)
//  - quota failures cool down per provider (free tier is account-wide)
//  - when a successful HTTP observation arrives, the cooldown is lifted (recovery detection)
//  - rescue mode (v1.0: ON only): if the current model is cooling down, automatically fall back to a healthy model.
//    OFF stops every model switch (routing + rescue); passive learning (observation, classification,
//    shadow review, recovery probes) keeps running in the background.

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { Plugin } from "@opencode/plugin"
import { AdaptiveFusion } from "./rpc"
import { JevClient } from "./jev"

const STAT_PREFIX = "fusion/stat/"
const TASK_STAT_PREFIX = "fusion/task/"
const FEEDBACK_PREFIX = "fusion/feedback/"
const TASK_FEEDBACK_PREFIX = "fusion/feedback/task/"
const AUTO_PREFIX = "fusion/auto/"
const TASK_AUTO_PREFIX = "fusion/auto/task/"
const AUTO_SKIP_PREFIX = "fusion/auto-skip/"
const AUTO_SKIP_KEY = "fusion/auto-skip/latest"
const TOPOLOGY_PREFIX = "fusion/topology/"
const VARIANT_PREFIX = "fusion/variant/"
const TASK_TOPOLOGY_PREFIX = "fusion/topology/task/"
const JEV_KEY_KEY = "fusion/jev-key"
const REVIEW_PREFIX = "fusion/review/"
const CONFIG_KEY = "fusion/config"
const COOLDOWN_KEY = "fusion/cooldowns"
const RESCUE_KEY = "fusion/rescue-attempts"
// Benchmark seed (default: data/benchmarks.json at the repository root)
const BENCHMARKS_DEFAULT_RELATIVE = ["data", "benchmarks.json"]
// Auto-refresh (v1.0): when fusion is ON and cfg.benchAutoUpdate is set, the
// benchmark library is refreshed from the public OpenRouter models API at most
// once per day. Fetched data is persisted to OpenCode storage (never written
// into the plugin directory); the bundled data/benchmarks.json remains as the
// seed/fallback. Any failure keeps the previous snapshot (fail-safe).
const BENCHMARKS_AUTO_KEY = "fusion/benchmarks"
const BENCH_CHECK_KEY = "fusion/bench-check"
const BENCH_API_URL = "https://openrouter.ai/api/v1/models"
const BENCH_CHECK_INTERVAL_MS = 24 * 60 * 60_000
const BENCH_FETCH_TIMEOUT_MS = 15_000
const BENCH_AUTO_MIN_MODELS = 20 // refuse to store a suspiciously small snapshot

type Stat = {
  model: { providerID: string; id: string }
  success: number
  failure: number
  totalMs: number
  updatedAt: string
  category?: string
}

type FeedbackStat = {
  model: { providerID: string; id: string }
  // Store raw sums (1..5) and counts so the rating distribution can be averaged
  ratingSum: number
  count: number
  updatedAt: string
  category?: string
}

type AutoReviewStat = {
  model: { providerID: string; id: string }
  // Model that ran the review (for detecting self-scoring bias)
  reviewerRef?: string
  total: number
  lastAt: number
  instruction: number
  accuracy: number
  completeness: number
  // v0.9.0: cost-performance axis (1..5 sum and sample count).
  // Old data (before efficiency collection) is 0/0 = uncollected.
  efficiency: number
  efficiencyCount: number
  // v0.9.0: Enumeration of "what the response actually accomplished" (keeps the latest reviews).
  // Old data is an empty array.
  results: string[]
  reasons: string[]
  updatedAt: string
  category?: string
}

// Display snapshot for TUI/RPC (rolling averages)
type AutoReviewSnapshot = {
  average: number
  instruction: number
  accuracy: number
  completeness: number
  // v0.9.0: cost-performance axis average (omitted per key when uncollected)
  efficiency?: number
  // v0.9.0: enumeration of recent accomplishments (omitted per key when uncollected)
  results?: string[]
  reason: string
  reviewerRef: string
  total: number
}

// Observed stats for topologies (orchestration shapes) (v0.7a).
// Accumulate "the shape that was decided" and "the results when it actually ran in that shape",
// as the foundation for later selection-score composition (w2 manual cost-performance / w3 automatic observation).
type TopologyStat = {
  topology: string
  category?: string
  count: number
  ok: number
  totalMs: number
  // Inner-review (autoReview) score sum (5 points max x count). 1 response = max 5
  sumQuality: number
  qualityCount: number
  // Human "how cost-effective is this shape?" 1-5 sum (/fusion-review row 2, D-3)
  sumCostPerformance: number
  costPerformanceCount: number
  // Sum of Jev Choice probability distributions (the D-4 w1 prior). 1 judgment = probability 1 distributed across shapes
  sumJevPrior: number
  jevPriorCount: number
  // Auxiliary calls (full v0.7a): call count and duration other than the main response, e.g. chain planner
  auxCalls: number
  auxMs: number
  // Time of last execution (ms)
  lastUsedAt: number
  updatedAt: string
}

// Definitions of the topology choices passed to Jev (v0.7a: single / router / sequential-chain only).
// criteria is a contrastive definition of "which requests should pick this shape".
const TOPOLOGY_CATALOG: Record<string, string> = {
  single:
    "単一の質問・編集・説明など、1つのモデル応答で十分な依頼。分解・並列化の利点がない、または小さすぎる",
  router:
    "タスクの種類(実装/デバッグ/レビュー等)によって専門モデルへ振り分けるべき依頼。分類してからカテゴリ別の最適モデルに回すのが適切",
  "sequential-chain":
    "計画→実行→検証のような順序依存の多段階処理。前の段階の成果物を次の段階へ引き継ぐ必要がある依頼",
  "fan-out":
    "独立したサブタスクへ分解でき、並列に処理して統合すべき依頼(v0.7b)",
  hierarchical:
    "planner が複数ワーカーへ割り当て、synthesizer が統合すべき大規模依頼(v0.7b)",
}
const KNOWN_TOPOLOGIES = Object.keys(TOPOLOGY_CATALOG)

// Benchmark priors (v0.6): keep prior scores (0-1) per model x category.
// Smooth the observed success rate with a Beta(benchmark * k, (1 - benchmark) * k) prior.
// With the default empty value (= file missing / k=0) the result matches the current Laplace smoothing.
type BenchmarkEntry = Partial<
  Record<
    | "coding"
    | "debugging"
    | "research"
    | "writing"
    | "ops"
    | "review"
    | "overall",
    number
  >
>
type BenchmarkFile = {
  fetchedAt?: string
  source?: string
  note?: string
  models?: Record<string, BenchmarkEntry>
}

let benchmarkCache: { mtimeMs: number; file: string; data: BenchmarkFile } | undefined

type FusionConfig = {
  enabled: boolean
  providerID: string
  crossProvider: boolean
  // v1.1.1: priority-ordered provider fallback chain. Empty = legacy single
  // providerID routing. When set, routing considers only these providers (in
  // order): candidates come from the first chain entry that still has healthy
  // (non-cooling) models; when that provider is exhausted (quota / account-
  // wide free-tier cooldown), the next entry takes over. Falling back records
  // the original model as a restore candidate, so the session returns to it
  // once it recovers (existing rescue-restore, 24 h window). The primary
  // (chain[0]) is mirrored into providerID for display and legacy fallback.
  providerChain: string[]
  // v1.2.1: chain promotion. When routing is ON, a session whose current
  // provider sits at a LOWER chain priority than the highest healthy chain
  // entry is switched to that entry once per prompt (not per dispatch — no
  // provider ping-pong). The switch records a restore ticket, so a later
  // demotion (e.g. after rescue fell through to a lower entry) climbs back
  // the same way. OFF = only rescue moves sessions across chain entries.
  chainPromote: boolean
  exploreRate: number
  learningRate: number
  minObservations: number
  costWeight: number
  latencyWeight: number
  classifierModel: string | null
  kinds: string[]
  models: string[]
  // v1.1.1: how the `models` list is interpreted. "whitelist" (default) =
  // only listed models are candidates (empty = all candidates + cost caps).
  // "blacklist" = every candidate EXCEPT the listed ones, subject to the cost
  // caps. The same `models` field holds the entries in both modes.
  listMode: "whitelist" | "blacklist"
  // Model ID when a single provider is used;
  // full-reference form `provider/model-id` with crossProvider. Empty = all candidates.
  maxInputCost: number // USD/1M tokens. Applied only when the whitelist is empty
  maxOutputCost: number // USD/1M tokens. 0 = only free models
  // Strength of the benchmark prior (k of the Bayesian prior). 0 disables it = current smoothing
  benchmarkPriorWeight: number
  // Path of the benchmark seed. Default is relative to the plugin
  benchmarksFile: string
  // Daily auto-refresh of the benchmark library from the public OpenRouter
  // models API (v1.0). ON by default and linked to the fusion toggle: it only
  // runs while routing is enabled. Disable via opencode.json options
  // (benchAutoUpdate: false) or the config RPC.
  benchAutoUpdate: boolean
  // Model in charge of inner review (shadow). Defaults to the same fallback path as classifierModel
  reviewModel: string | null
  // Jev (TypeSafe) integration. auto = enabled when an API key is detected / off = always the legacy path
  jevMode: "auto" | "off"
  // Topology selection. auto = choose via Jev/track record / fixed = always single (legacy behavior)
  topologyMode: "auto" | "fixed"
  // Upper limit of auxiliary calls per response (cost guard). chain requires 3 or more
  maxTopologyCalls: number
  // Whitelist of topologies allowed to run (tied to the staged rollout)
  allowedTopologies: string[]
  // ε probability of adopting a non-greedy allowed topology at selection time
  // (tracks the cold-start problem of never-chosen shapes). Default 0.1.
  topologyExploreRate: number
  // Weights of the topology selection score (v0.7a/D-4).
  //   score = w1 x Jev prior probability + w2 x human cost-performance + w3 x automatic observation (quality/ok rate)
  // Without a Jev key, w1 is treated as 0 automatically and selection uses w2/w3 only.
  // topologyWeightJev also sets the Jev share of the blended selection distribution (v1.1).
  topologyWeightJev: number
  topologyWeightHumanCP: number
  topologyWeightAuto: number
  // Auxiliary execution of sequential-chain (full v0.7a).
  // off = selection and recording only (current behavior) / active = when chain is selected, run the planner
  // and inject the plan into the main model's system prompt as "reference" (context hook, does not pollute history)
  chainMode: "off" | "active"
  // Tier routing (v0.8, load-based selection à la Copilot Fusion / HydraFusion).
  // off = legacy behavior / manual = user-defined tiers / auto = derived by trisecting the benchmark
  tierMode: "off" | "manual" | "auto"
  // Reasoning-effort (thinking level) auto-selection (v1.1). OpenCode models can
  // expose named variants (#low/#high/#max...) that switch request settings such
  // as reasoningEffort / thinking budget. Modes:
  //   off   = never touch the variant
  //   auto  = model first, then variant: the effort level comes from the
  //           per-turn Jev/LLM hint (same round trip as classification), is
  //           compensated against the CHOSEN MODEL's weight class, explored
  //           with ε (variantExploreRate) and refined by per-(model,variant)
  //           outcome learning. An explicit variant choice always wins.
  //   fixed = always apply cfg.variantFixed (when the model has it)
  variantMode: "off" | "auto" | "fixed"
  // Variant forced in variantMode=fixed (e.g. "high"). null = unset.
  variantFixed: string | null
  // ε probability of exploring a non-computed variant (0..1). Default 0.1.
  variantExploreRate: number
  // Model groups per tier (an enhanced whitelist).
  // Each tier can hold multiple provider/model entries; within a tier, the existing statScore+exploration applies.
  tiers: { heavy: string[]; middle: string[]; light: string[] }
  // Display language (v0.9.0). Chosen per install via options.lang,
  // and can also be switched with /fusion-lang. Default is ja.
  lang: "ja" | "en"
  // Weight (0..1) of the independent-audit auto-review signal in the quality term
  // of the routing score (v1.0). 0 = shadow only (scores displayed but not used
  // for routing). The audit model runs in a separate harness (reviewModel),
  // so its scores are only mixed into the human-quality term after its own
  // gates pass: sample gate, quality-axis selection, and shadow/human
  // divergence check (see autoReviewScore / effectiveAutoWeight).
  autoReviewWeight: number
  // Rescue (v1.1): how many consecutive transient failures on the same
  // session/model are allowed before the model is cooled down and the session
  // is switched. Definitive signals (Model unavailable / quota) rescue
  // immediately because retrying them cannot succeed. Default 3.
  rescueAttemptsBeforeSwitch: number
}

// Load bands (three levels of task/intelligence load). The difficulty score 0-100 is
// split into three tiers by TIER_THRESHOLD_*.
type TierName = "heavy" | "middle" | "light"
const TIER_NAMES: TierName[] = ["heavy", "middle", "light"]
const TIER_THRESHOLD_MIDDLE = 34
const TIER_THRESHOLD_HEAVY = 67

// v1.1.1: provider chain sanitization. Non-empty strings only, deduped
// (first occurrence wins), capped at 8 entries.
const sanitizeProviderChain = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== "string") continue
    const trimmed = v.trim()
    if (trimmed.length === 0 || out.includes(trimmed)) continue
    out.push(trimmed)
    if (out.length >= 8) break
  }
  return out
}

// Inner review (autoReview) skip log (A-2).
// Persists the fact that a review could not run (with reviewerRef),
// surfacing the blind spots of the shadow aggregation (missed reviews).
type AutoSkipStat = {
  total: number
  recent: { at: string; reason: string; reviewerRef: string }[]
  updatedAt: string
}

const DEFAULT_CATEGORIES = [
  "coding", // implementation / code editing
  "debugging", // errors / bug fixes
  "review", // review / verification
  "research", // investigation / questions / explanations
  "writing", // docs / prose
  "ops", // shell / environment setup / execution
]

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const num = (value: unknown, fallback: number) =>
  typeof value === "number" ? value : fallback

// Tier config (v0.8) validation. Accepts only provider/model-formatted strings;
// invalid values / missing tiers are normalized to empty arrays (shared by opencode.json options / RPC update).
const sanitizeTiers = (raw: unknown):
  { heavy: string[]; middle: string[]; light: string[] } => {
  const out: { heavy: string[]; middle: string[]; light: string[] } = {
    heavy: [],
    middle: [],
    light: [],
  }
  if (!raw || typeof raw !== "object") return out
  const src = raw as Record<string, unknown>
  for (const tier of TIER_NAMES) {
    const list = src[tier]
    if (!Array.isArray(list)) continue
    out[tier] = [
      ...new Set(
        list.filter(
          (r): r is string => typeof r === "string" && r.includes("/"),
        ),
      ),
    ]
  }
  return out
}

export default Plugin.define({
  id: "adaptive-fusion",
  async setup(ctx) {
    // ------------------------------------------------------------------
    // Settings (priority: saved fusion/config > opencode.json options)
    // ------------------------------------------------------------------
    const cfg: FusionConfig = {
      enabled: ctx.options.enabled === true,
      providerID:
        typeof ctx.options.providerID === "string"
          ? ctx.options.providerID
          : "opencode",
      crossProvider: ctx.options.crossProvider === true,
      // v1.1.1: provider chain (priority-ordered fallback). Set via
      // /fusion-provider; providerID mirrors chain[0] when set.
      providerChain: sanitizeProviderChain(ctx.options.providerChain),
      // v1.2.1: chain promotion (auto-assign to the highest healthy entry)
      chainPromote: ctx.options.chainPromote !== false,
      // v1.1.1: whitelist / blacklist interpretation of the model list
      listMode: ctx.options.listMode === "blacklist" ? "blacklist" : "whitelist",
      exploreRate: clamp(num(ctx.options.exploreRate, 0.05), 0, 1),
      learningRate: clamp(num(ctx.options.learningRate, 0.3), 0, 1),
      minObservations: Math.max(
        1,
        Math.floor(num(ctx.options.minObservations, 5)),
      ),
      costWeight: clamp(num(ctx.options.costWeight, 0.1), 0, 1),
      latencyWeight: clamp(num(ctx.options.latencyWeight, 0.05), 0, 1),
      maxInputCost: Math.max(0, num(ctx.options.maxInputCost, 0)),
      maxOutputCost: Math.max(0, num(ctx.options.maxOutputCost, 0)),
      benchmarkPriorWeight: Math.max(
        0,
        num(ctx.options.benchmarkPriorWeight, 5),
      ),
      benchmarksFile:
        typeof ctx.options.benchmarksFile === "string" &&
        ctx.options.benchmarksFile.length > 0
          ? ctx.options.benchmarksFile
          : "",
      benchAutoUpdate: ctx.options.benchAutoUpdate !== false,
      topologyExploreRate: clamp(num(ctx.options.topologyExploreRate, 0.1), 0, 1),
      topologyPriorStrength: Math.max(1, Math.min(20, Math.floor(num(ctx.options.topologyPriorStrength, 4)))),
      classifierModel:
        typeof ctx.options.classifierModel === "string" &&
        ctx.options.classifierModel.includes("/")
          ? ctx.options.classifierModel
          : null,
      kinds:
        Array.isArray(ctx.options.kinds) && ctx.options.kinds.length > 0
          ? ctx.options.kinds
          : ["primary"],
      models:
        Array.isArray(ctx.options.models) &&
        ctx.options.models.every((m) => typeof m === "string")
          ? [...(ctx.options.models as string[])]
          : [],
      reviewModel:
        typeof ctx.options.reviewModel === "string" &&
        ctx.options.reviewModel.includes("/")
          ? ctx.options.reviewModel
          : null,
      jevMode: ctx.options.jevMode === "off" ? "off" : "auto",
      topologyMode: ctx.options.topologyMode === "fixed" ? "fixed" : "auto",
      maxTopologyCalls: Math.max(
        1,
        Math.min(16, Math.floor(num(ctx.options.maxTopologyCalls, 4))),
      ),
      allowedTopologies: Array.isArray(ctx.options.allowedTopologies)
        ? (() => {
            const filtered = (ctx.options.allowedTopologies as unknown[])
              .filter(
                (t): t is string =>
                  typeof t === "string" && KNOWN_TOPOLOGIES.includes(t),
              )
              .slice(0, 16)
            return filtered.length > 0 ? filtered : ["single"]
          })()
        : ["single", "router", "sequential-chain"],
      topologyWeightJev: clamp(num(ctx.options.topologyWeightJev, 0.5), 0, 1),
      topologyWeightHumanCP: clamp(
        num(ctx.options.topologyWeightHumanCP, 0.25),
        0,
        1,
      ),
      topologyWeightAuto: clamp(num(ctx.options.topologyWeightAuto, 0.25), 0, 1),
      chainMode: ctx.options.chainMode === "active" ? "active" : "off",
      tierMode: (() => {
        const raw = ctx.options.tierMode
        return raw === "manual" || raw === "auto" || raw === "off" ? raw : "off"
      })(),
      tiers: sanitizeTiers(ctx.options.tiers),
      // Reasoning-effort (variant) selection. "auto" = hint + class
      // compensation + exploration + learning; "fixed" = variantFixed.
      variantMode: (["off", "auto", "fixed"] as const).includes(
        ctx.options.variantMode as any,
      )
        ? (ctx.options.variantMode as any)
        : "auto",
      variantFixed:
        typeof ctx.options.variantFixed === "string" &&
        ctx.options.variantFixed.length > 0
          ? ctx.options.variantFixed
          : null,
      variantExploreRate: clamp(num(ctx.options.variantExploreRate, 0.1), 0, 1),
      // Display language. Can be chosen per install via opencode.json options.lang
      // (same saved-settings > options priority as other items).
      lang: ctx.options.lang === "en" ? "en" : "ja",
      // Weight of the independent-audit auto-review signal. 0 (default) = shadow
      // only, i.e. displayed but not used for routing.
      autoReviewWeight: clamp(num(ctx.options.autoReviewWeight, 0), 0, 1),
      rescueAttemptsBeforeSwitch: Math.max(
        1,
        Math.min(
          10,
          Math.floor(num(ctx.options.rescueAttemptsBeforeSwitch, 3)),
        ),
      ),
    }

    // v1.1.1: enforce the chain invariants right after the options init (the
    // update path enforces them; the options path did not): a chain wins over
    // crossProvider, and without an explicit options.providerID the primary
    // chain entry is the display/fallback provider.
    if (cfg.providerChain.length > 0) {
      if (typeof ctx.options.providerID !== "string")
        cfg.providerID = cfg.providerChain[0]
      cfg.crossProvider = false
    }

    // Display-language helper (v0.9.0). First argument is Japanese, second is English.
    // Also changeable from TUI/RPC, applied immediately.
    const tr = (ja: string, en: string): string =>
      cfg.lang === "en" ? en : ja

    // Apply saved settings (only validated values).
    // Used both at setup-time for restore and at prompt-time for resync (the TUI-side instance may
    // have persisted changes to reflect server-side, v0.8.1).
    // Note: kinds is captured by reference after setup, so it must not be swapped;
    // apply changes by destructively mutating the same array.
    const applyPersistedConfig = (saved: unknown): boolean => {
      if (!saved || typeof saved !== "object") return false
      const s = saved as Record<string, unknown>
      const before = JSON.stringify(cfg)
      if (typeof s.enabled === "boolean") cfg.enabled = s.enabled
      if (typeof s.providerID === "string") cfg.providerID = s.providerID
      if (typeof s.crossProvider === "boolean") cfg.crossProvider = s.crossProvider
      // v1.1.1: provider chain restore
      if (Array.isArray(s.providerChain))
        cfg.providerChain = sanitizeProviderChain(s.providerChain)
      if (typeof s.chainPromote === "boolean") cfg.chainPromote = s.chainPromote
      // v1.1.1: a restored chain wins over crossProvider (the routing
      // path prefers the chain; keep the flags mutually exclusive).
      if (cfg.providerChain.length > 0) cfg.crossProvider = false
      if (typeof s.exploreRate === "number")
        cfg.exploreRate = clamp(s.exploreRate, 0, 1)
      if (typeof s.learningRate === "number")
        cfg.learningRate = clamp(s.learningRate, 0, 1)
      if (typeof s.minObservations === "number")
        cfg.minObservations = Math.max(1, Math.floor(s.minObservations))
      if (typeof s.costWeight === "number") cfg.costWeight = clamp(s.costWeight, 0, 1)
      if (typeof s.latencyWeight === "number")
        cfg.latencyWeight = clamp(s.latencyWeight, 0, 1)
      if (typeof s.maxInputCost === "number")
        cfg.maxInputCost = Math.max(0, s.maxInputCost)
      if (typeof s.maxOutputCost === "number")
        cfg.maxOutputCost = Math.max(0, s.maxOutputCost)
      if (typeof s.benchmarkPriorWeight === "number")
        cfg.benchmarkPriorWeight = Math.max(0, s.benchmarkPriorWeight)
      if (typeof s.benchmarksFile === "string")
        cfg.benchmarksFile = s.benchmarksFile
      if (typeof s.benchAutoUpdate === "boolean")
        cfg.benchAutoUpdate = s.benchAutoUpdate
      if (typeof s.classifierModel === "string")
        cfg.classifierModel = s.classifierModel.includes("/")
          ? s.classifierModel
          : null
      else if (s.classifierModel === null) cfg.classifierModel = null
      if (typeof s.reviewModel === "string")
        cfg.reviewModel = s.reviewModel.includes("/")
          ? s.reviewModel
          : null
      else if (s.reviewModel === null) cfg.reviewModel = null
      if (s.jevMode === "auto" || s.jevMode === "off") cfg.jevMode = s.jevMode
      if (s.topologyMode === "auto" || s.topologyMode === "fixed")
        cfg.topologyMode = s.topologyMode
      if (typeof s.maxTopologyCalls === "number")
        cfg.maxTopologyCalls = clamp(Math.floor(s.maxTopologyCalls), 1, 16)
      if (Array.isArray(s.allowedTopologies)) {
        const filtered = (s.allowedTopologies as unknown[]).filter(
          (t): t is string =>
            typeof t === "string" && KNOWN_TOPOLOGIES.includes(t),
        )
        if (filtered.length > 0) cfg.allowedTopologies = filtered
        else cfg.allowedTopologies = ["single"]
      }
      if (typeof s.topologyExploreRate === "number")
        cfg.topologyExploreRate = clamp(s.topologyExploreRate, 0, 1)
      if (typeof s.topologyPriorStrength === "number")
        cfg.topologyPriorStrength = Math.max(1, Math.min(20, Math.floor(s.topologyPriorStrength)))
      if (typeof s.topologyWeightJev === "number")
        cfg.topologyWeightJev = clamp(s.topologyWeightJev, 0, 1)
      if (typeof s.topologyWeightHumanCP === "number")
        cfg.topologyWeightHumanCP = clamp(s.topologyWeightHumanCP, 0, 1)
      if (typeof s.topologyWeightAuto === "number")
        cfg.topologyWeightAuto = clamp(s.topologyWeightAuto, 0, 1)
      if (s.chainMode === "active" || s.chainMode === "off")
        cfg.chainMode = s.chainMode
      if (
        s.tierMode === "off" ||
        s.tierMode === "manual" ||
        s.tierMode === "auto"
      )
        cfg.tierMode = s.tierMode
      if (s.tiers && typeof s.tiers === "object")
        cfg.tiers = sanitizeTiers(s.tiers)
      if (
        s.variantMode === "off" ||
        s.variantMode === "auto" ||
        s.variantMode === "fixed"
      )
        cfg.variantMode = s.variantMode
      if (typeof s.variantFixed === "string")
        cfg.variantFixed = s.variantFixed.length > 0 ? s.variantFixed : null
      else if (s.variantFixed === null) cfg.variantFixed = null
      if (typeof s.variantExploreRate === "number")
        cfg.variantExploreRate = clamp(s.variantExploreRate, 0, 1)
      if (s.lang === "ja" || s.lang === "en") cfg.lang = s.lang
      if (typeof s.autoReviewWeight === "number")
        cfg.autoReviewWeight = clamp(s.autoReviewWeight, 0, 1)
      if (typeof s.rescueAttemptsBeforeSwitch === "number")
        cfg.rescueAttemptsBeforeSwitch = Math.max(
          1,
          Math.min(10, Math.floor(s.rescueAttemptsBeforeSwitch)),
        )
      if (Array.isArray(s.kinds) && s.kinds.every((k) => typeof k === "string")) {
        cfg.kinds.length = 0
        cfg.kinds.push(...(s.kinds as string[]))
      }
      if (Array.isArray(s.models) && s.models.every((m) => typeof m === "string"))
        cfg.models = s.models as string[]
      // v1.1.1: whitelist/blacklist interpretation of the model list
      if (s.listMode === "whitelist" || s.listMode === "blacklist")
        cfg.listMode = s.listMode
      return JSON.stringify(cfg) !== before
    }

    applyPersistedConfig(await ctx.storage.get(CONFIG_KEY))

    // ------------------------------------------------------------------
    // Jev (TypeSafe System One) key management
    // ------------------------------------------------------------------
    // The key is read from storage["fusion/jev-key"] or the TYPESAFE_API_KEY environment variable.
    // Priority: storage (dialog registration) > environment variable.
    // An empty string means "not registered" (storage has no delete, so disable via empty string).
    let jevStoredKey: string | undefined
    {
      const stored = await ctx.storage.get(JEV_KEY_KEY)
      if (typeof stored === "string" && stored.trim().length > 0)
        jevStoredKey = stored.trim()
    }
    const jevEffectiveKey = (): string | undefined => {
      const env = process.env.TYPESAFE_API_KEY?.trim()
      return jevStoredKey ?? (env && env.length > 0 ? env : undefined)
    }
    // Jev is used only when both a key is present and jevMode=auto (graceful degradation otherwise)
    const jevAvailable = (): boolean =>
      cfg.jevMode !== "off" && Boolean(jevEffectiveKey())
    const jevClient = (): JevClient | undefined => {
      const key = jevEffectiveKey()
      return cfg.jevMode !== "off" && key ? new JevClient(key) : undefined
    }

    // Request kinds eligible for routing. Default is agent-loop only.
    const kinds = cfg.kinds

    // Task classification categories (opencode.json options only; not changeable dynamically)
    const categories: string[] =
      Array.isArray(ctx.options.categories) &&
      ctx.options.categories.every((c) => typeof c === "string") &&
      ctx.options.categories.length > 0
        ? (ctx.options.categories as string[])
        : [...DEFAULT_CATEGORIES]

    // Keys include the actual provider (same format as opencode's existing stats)
    const refFor = (providerID: string, modelID: string) =>
      `${providerID}/${modelID}`
    const keyFor = (providerID: string, modelID: string) =>
      `${STAT_PREFIX}${refFor(providerID, modelID)}`
    const taskKeyFor = (category: string, providerID: string, modelID: string) =>
      `${TASK_STAT_PREFIX}${category}/${refFor(providerID, modelID)}`
    const feedbackKeyFor = (providerID: string, modelID: string) =>
      `${FEEDBACK_PREFIX}${refFor(providerID, modelID)}`
    const taskFeedbackKeyFor = (
      category: string,
      providerID: string,
      modelID: string,
    ) => `${TASK_FEEDBACK_PREFIX}${category}/${refFor(providerID, modelID)}`
    const autoKeyFor = (providerID: string, modelID: string) =>
      `${AUTO_PREFIX}${refFor(providerID, modelID)}`
    const taskAutoKeyFor = (
      category: string,
      providerID: string,
      modelID: string,
    ) => `${TASK_AUTO_PREFIX}${category}/${refFor(providerID, modelID)}`

    const loadStat = (providerID: string, modelID: string) =>
      ctx.storage.get(keyFor(providerID, modelID))
    const loadTaskStat = (
      category: string,
      providerID: string,
      modelID: string,
    ) => ctx.storage.get(taskKeyFor(category, providerID, modelID))
    const loadFeedback = (providerID: string, modelID: string) =>
      ctx.storage.get(feedbackKeyFor(providerID, modelID))
    const loadTaskFeedback = (
      category: string,
      providerID: string,
      modelID: string,
    ) => ctx.storage.get(taskFeedbackKeyFor(category, providerID, modelID))
    const loadAutoReview = (providerID: string, modelID: string) =>
      ctx.storage.get(autoKeyFor(providerID, modelID))
    const loadTaskAutoReview = (
      category: string,
      providerID: string,
      modelID: string,
    ) => ctx.storage.get(taskAutoKeyFor(category, providerID, modelID))

    const saveFeedback = async (stat: FeedbackStat) => {
      stat.updatedAt = new Date().toISOString()
      await ctx.storage.set(
        feedbackKeyFor(stat.model.providerID, stat.model.id),
        stat,
      )
    }
    const saveTaskFeedback = async (stat: FeedbackStat) => {
      stat.updatedAt = new Date().toISOString()
      await ctx.storage.set(
        taskFeedbackKeyFor(
          stat.category!,
          stat.model.providerID,
          stat.model.id,
        ),
        stat,
      )
    }
    const saveStat = async (stat: Stat) => {
      stat.updatedAt = new Date().toISOString()
      await ctx.storage.set(
        keyFor(stat.model.providerID, stat.model.id),
        stat,
      )
    }
    const saveTaskStat = async (stat: Stat) => {
      stat.updatedAt = new Date().toISOString()
      await ctx.storage.set(
        taskKeyFor(stat.category!, stat.model.providerID, stat.model.id),
        stat,
      )
    }
    const saveAutoReview = async (stat: AutoReviewStat) => {
      stat.updatedAt = new Date().toISOString()
      await ctx.storage.set(
        autoKeyFor(stat.model.providerID, stat.model.id),
        stat,
      )
    }
    const saveTaskAutoReview = async (stat: AutoReviewStat) => {
      stat.updatedAt = new Date().toISOString()
      await ctx.storage.set(
        taskAutoKeyFor(stat.category!, stat.model.providerID, stat.model.id),
        stat,
      )
    }
    // Inner-review skip log (A-2). Records the fact that a review could not run, with reviewerRef.
    const loadAutoSkip = async (): Promise<AutoSkipStat | undefined> => {
      const saved = await ctx.storage.get(AUTO_SKIP_KEY)
      if (!saved || typeof saved !== "object") return undefined
      const s = saved as Record<string, unknown>
      if (typeof s.total !== "number") return undefined
      return {
        total: s.total,
        recent: Array.isArray(s.recent)
          ? (s.recent as AutoSkipStat["recent"]).filter(
              (r) =>
                r &&
                typeof r === "object" &&
                typeof r.at === "string" &&
                typeof r.reason === "string" &&
                typeof r.reviewerRef === "string",
            )
          : [],
        updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
      }
    }
    const recordAutoSkip = async (reason: string, reviewerRef: string) => {
      try {
        const existing = (await loadAutoSkip()) ?? {
          total: 0,
          recent: [],
          updatedAt: "",
        }
        existing.total += 1
        existing.recent.unshift({
          at: new Date().toISOString().slice(0, 16).replace("T", " "),
          reason: reason.slice(0, 120),
          reviewerRef: reviewerRef.slice(0, 120),
        })
        if (existing.recent.length > 5) existing.recent.length = 5
        existing.updatedAt = new Date().toISOString()
        await ctx.storage.set(AUTO_SKIP_KEY, existing)
        logRoute(`AUTO review skip recorded: ${reason}`)
      } catch {
        // Failure to record a skip must not block normal processing
      }
    }
    // ------------------------------------------------------------------
    // Failure detection (cooldown) -> safe fallback
    // ------------------------------------------------------------------
    // resolve-level "model unavailable" (Model unavailable) never reaches HTTP
    // and is invisible to stats. The offending model is detected from the
    // session.step.failed / session.retry.scheduled event error message and excluded
    // from routing targets for a while (exponential backoff). A successful HTTP observation lifts it.
    // The free tier (account-wide for both opencode / openrouter): once one model hits quota,
    // all free models of that provider are treated as down,
    // and cooled down via a provider-scoped, timer-based unavailable flag.
    const cooldowns = new Map<
      string,
      {
        until: number
        failures: number
        quota: boolean
        // needsVerify flag (v0.8.1). Timer expiry alone does not count as "recovered".
        // The cooldown is lifted once a minimal real probe succeeds.
        // (The timer is only a guess; actual usage limits may lift in a different window.
        //  Returning unverified leads to repeated forced stops via Model unavailable)
        needsVerify: boolean
        lastVerifyAt?: number
      }
    >()
    // Provider-scoped unavailable flag (timer-based).
    // The free tier of OpenCode / OpenRouter is account-wide, so once quota is hit,
    // all free models of that provider go down. Cool down per provider, not per model.
    const providerCooldowns = new Map<
      string,
      { until: number; quota: boolean }
    >()
    const COOLDOWN_BASE_MS = 10 * 60_000 // resolve failure: exponential backoff starting at 10 minutes
    const COOLDOWN_MAX_MS = 6 * 60 * 60_000
    // Free tier / quota: every hour. After timer expiry, verify with a real probe;
    // pass -> back into the pool, fail -> extended by another hour (verified recovery).
    // With a long fixed timer, "the timer expired but the limit was not lifted"
    // led to repeated forced stops via Model unavailable, so this moved to a short cycle + verification.
    const QUOTA_COOLDOWN_MS = 60 * 60_000

    // --- Rescue restore ---
    // When a session fell back to another model via rescue, record it so the
    // original model can be automatically restored on the next prompt once its cooldown lifts.
    const rescueAttempts = new Map<string, { originalRef: string; deadline: number }>()
    const RESCUE_WINDOW_MS = 24 * 60 * 60_000 // valid for 24 hours only

    // Decide rescue restore in the hook just before the prompt.
    const maybeRestoreFromRescue = (sessionID: string) => {
      const entry = rescueAttempts.get(sessionID)
      if (!entry) return
      const now = Date.now()
      if (now >= entry.deadline) {
        rescueAttempts.delete(sessionID)
        rescueTombstones.set(sessionID, Date.now())
        void persistRescue()
        return
      }
      // entry.originalRef is a full provider/model reference. The model side may
      // contain slashes, so split on the first slash
      const slash = entry.originalRef.indexOf("/")
      const origProv = entry.originalRef.slice(0, slash)
      const origMod = entry.originalRef.slice(slash + 1)
      const modelRef = entry.originalRef
      // Restore decisions are unified into cool() (v0.8.1). cool() checks not only the timer
      // but also needsVerify and provider-scoped cooldowns,
      // preventing returns to models whose timer expired but whose limit was not lifted.
      if (!cool(modelRef)) {
        logRoute(`RESCUE restore ${sessionID} -> ${entry.originalRef} (recovered)`)
        return { providerID: origProv, id: origMod, ref: entry.originalRef }
      }
      return null
    }

    // ------------------------------------------------------------------
    // Routing decision log (latest 20 entries. Shown in stats. For debugging)
    // ------------------------------------------------------------------
    const routeLog: string[] = []
    const logRoute = (line: string) => {
      routeLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
      // v0.8.1: 20 entries caused evidence to evaporate while investigating failure cascades (measured), so enlarged.
      if (routeLog.length > 200) routeLog.splice(0, routeLog.length - 200)
    }

    // Persisting cooldowns (unavailable flags):
    // Even if the plugin hot-reloads and memory is lost, models already known to be dead
    // are saved to fusion/cooldowns and restored late in setup so they are not hit again.
    //
    // Added in v0.8.1 (problem verified in production): the server process may load the same plugin
    // as 2 instances (the role=server double load was confirmed in logs), and when the instance
    // without hooks persists the "stale map captured at restore time",
    // the entire kv gets overwritten and cooldowns recorded by the hooked side disappear
    // (reproduced in a gemini cooldown-loss experiment).
    // Therefore persist is a "merge memory onto the kv" scheme.
    // Deletes go through a tombstone (so clearCooldown's success-time delete cannot resurrect).
    const cooldownTombstones = new Map<string, number>()
    const TOMBSTONE_TTL_MS = 25 * 60 * 60_000
    const tomb = (key: string) => {
      cooldownTombstones.set(key, Date.now())
      if (cooldownTombstones.size > 500) {
        const now = Date.now()
        for (const [k, ts] of cooldownTombstones)
          if (now - ts > TOMBSTONE_TTL_MS) cooldownTombstones.delete(k)
      }
    }
    const persistCooldowns = async () => {
      const now = Date.now()
      // Base: latest kv (does not erase cooldowns recorded by other instances)
      let models: Record<string, unknown> = {}
      let providers: Record<string, unknown> = {}
      try {
        const saved = await ctx.storage.get(COOLDOWN_KEY)
        if (saved && typeof saved === "object") {
          const s = saved as { models?: unknown; providers?: unknown }
          if (s.models && typeof s.models === "object")
            models = { ...(s.models as Record<string, unknown>) }
          if (s.providers && typeof s.providers === "object")
            providers = { ...(s.providers as Record<string, unknown>) }
        }
      } catch {
        // If unreadable, write memory-only (legacy behavior)
      }
      // Overwrite-merge with the live entries on the memory side
      for (const [ref, c] of cooldowns)
        if (c.until > now || c.needsVerify === true) models[ref] = c
      for (const [id, p] of providerCooldowns)
        if (p.until > now) providers[id] = p
      // tombstone: keys explicitly deleted in memory are dropped even if still present in kv
      const tnow = Date.now()
      for (const [key, ts] of cooldownTombstones) {
        if (tnow - ts > TOMBSTONE_TTL_MS) {
          cooldownTombstones.delete(key)
          continue
        }
        if (key.startsWith("m:")) delete models[key.slice(2)]
        else if (key.startsWith("p:")) delete providers[key.slice(2)]
      }
      await ctx.storage.set(COOLDOWN_KEY, { models, providers })
    }

    const savedCooldowns = await ctx.storage.get(COOLDOWN_KEY)
    if (savedCooldowns && typeof savedCooldowns === "object") {
      const s = savedCooldowns as Record<string, unknown>
      const restore = (
        source: unknown,
        target: Map<string, unknown>,
      ) => {
        if (!source || typeof source !== "object") return
        for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
          const v = value as
            | { until?: unknown; needsVerify?: unknown }
            | null
          if (
            v &&
            typeof v === "object" &&
            typeof v.until === "number" &&
            // Restore cooldowns with needsVerify even if the timer expired.
            // Dropping them makes unrecovered models look healthy and seeds forced stops.
            (v.until > Date.now() || v.needsVerify === true)
          )
            target.set(key, value)
        }
      }
      restore(s.models, cooldowns)
      restore(s.providers, providerCooldowns)
    }

    // Persist pending rescue-restore entries as well.
    // So restore decisions are not lost even if the plugin hot-reloads and memory is wiped.
    // v0.8.1: same merge scheme as cooldowns (guards against stale overwrites from other instances).
    // Deletes are not just "dropped when missing from memory and deadline passed";
    // explicit deletes go through the tombstones map.
    const rescueTombstones = new Map<string, number>()
    const persistRescue = async () => {
      const now = Date.now()
      let attempts: Record<string, unknown> = {}
      try {
        const saved = await ctx.storage.get(RESCUE_KEY)
        if (saved && typeof saved === "object")
          attempts = { ...(saved as Record<string, unknown>) }
      } catch {
        // If unreadable, write memory-only
      }
      for (const [sessionID, entry] of rescueAttempts)
        if (entry.deadline > now) attempts[sessionID] = entry
      const tnow = Date.now()
      for (const [sid, ts] of rescueTombstones) {
        if (tnow - ts > TOMBSTONE_TTL_MS) {
          rescueTombstones.delete(sid)
          continue
        }
        delete attempts[sid]
      }
      await ctx.storage.set(RESCUE_KEY, attempts)
    }

    const savedRescue = await ctx.storage.get(RESCUE_KEY)
    if (savedRescue && typeof savedRescue === "object") {
      for (const [sessionID, value] of Object.entries(
        savedRescue as Record<string, unknown>,
      )) {
        const v = value as { originalRef?: unknown; deadline?: unknown } | null
        if (
          v &&
          typeof v === "object" &&
          typeof v.originalRef === "string" &&
          typeof v.deadline === "number" &&
          v.deadline > Date.now()
        ) {
          rescueAttempts.set(sessionID, {
            originalRef: v.originalRef,
            deadline: v.deadline,
          })
        }
      }
    }

    // Failure types: quota (free tier / rate limit) is excluded from the quality penalty
    const classifyFailure = (error: {
      message?: unknown
      status?: unknown
      body?: unknown
    }): "quota" | "error" => {
      const message = typeof error.message === "string" ? error.message : ""
      const body = typeof error.body === "string" ? error.body : ""
      const status = typeof error.status === "number" ? error.status : 0
      const text = `${message} ${body}`
      if (
        status === 402 ||
        status === 429 ||
        /usage limit|free usage|quota|rate.?limit|exceeded|insufficient/i.test(
          text,
        )
      )
        return "quota"
      return "error"
    }

    const cool = (ref: string) => {
      const c = cooldowns.get(ref)
      if (c !== undefined) {
        if (c.until > Date.now()) return true
        // Even if the timer has expired but needsVerify is set, treat it as "not recovered" (v0.8.1).
        // The timer is only a rough guide; actual usage limits may lift in a different window,
        // and returning to an unverified model led to repeated forced stops via Model unavailable.
        // Only a successful real probe (VERIFY ok) lifts the cooldown.
        if (c.needsVerify) {
          scheduleVerification(ref)
          return true
        }
      }
      // Even if per-model cooldowns have expired, the provider-scoped
      // quota cooldown (free tier goes down account-wide) means unavailable.
      // Note: provider cooldown applies only to "free models" (v0.8.1).
      // Quota limits are about the free tier; paid models of the same provider are a separate bucket.
      // Sweeping paid models in too left no fallback targets,
      // seeding forced stops via Model unavailable.
      if (providerCool(ref.slice(0, ref.indexOf("/")))) return isFreeRef(ref)
      return false
    }
    // Detect free models (simple heuristic based on id naming).
    // openrouter uses the ":free" suffix, opencode uses the "-free" suffix.
    const isFreeRef = (ref: string) =>
      ref.endsWith(":free") || ref.endsWith("-free")
    // Provider-scoped cooldown decision. The free tier of OpenCode / OpenRouter
    // is account-wide, so the moment one model hits quota,
    // all free models of that provider are treated as down.
    const providerCool = (providerID: string) => {
      const p = providerCooldowns.get(providerID)
      return p !== undefined && p.until > Date.now()
    }
    const markProviderCool = (providerID: string, quota: boolean) => {
      providerCooldowns.set(providerID, {
        until: Date.now() + QUOTA_COOLDOWN_MS,
        quota,
      })
      void persistCooldowns()
      if (ctx.options.debug === true)
        console.log(
          `[adaptive-fusion] provider cooldown ${providerID} (${quota ? "quota" : "error"})`,
        )
    }
    const markFailure = (ref: string, cls: "quota" | "error" = "error") => {
      const failures = Math.min((cooldowns.get(ref)?.failures ?? 0) + 1, 10)
      const ms =
        cls === "quota"
          ? QUOTA_COOLDOWN_MS
          : Math.min(COOLDOWN_BASE_MS * 2 ** (failures - 1), COOLDOWN_MAX_MS)
      cooldowns.set(ref, {
        until: Date.now() + ms,
        failures,
        quota: cls === "quota",
        needsVerify: true,
      })
      // Quota limits cool down per provider (assuming the free tier goes down together)
      if (cls === "quota") markProviderCool(ref.slice(0, ref.indexOf("/")), true)
      void persistCooldowns()
      if (ctx.options.debug === true)
        console.log(
          `[adaptive-fusion] cooldown ${ref} (${cls}, ${Math.round(ms / 1000)}s)`,
        )
    }
    const clearCooldown = (ref: string): boolean => {
      const existed = cooldowns.delete(ref)
      // Only "free model" success lifts a provider-scoped cooldown (v0.8.1).
      // Success of a paid model does not imply the free tier's limit was lifted.
      // (Free models are guarded by both the provider cooldown and the model cooldown,
      //  so if a paid success erased the provider cooldown, unverified free models
      //  would return as candidates and could seed Model unavailable)
      let providerExisted = false
      if (isFreeRef(ref)) {
        const pid = ref.slice(0, ref.indexOf("/"))
        providerExisted = providerCooldowns.delete(pid)
        if (providerExisted) tomb(`p:${pid}`)
      }
      // Deleted keys go into the tombstone. Even with the merge-style persist,
      // they won't lose to stale entries remaining in kv or to rewrites from other instances.
      if (existed) tomb(`m:${ref}`)
      void persistCooldowns()
      // Return whether a lift occurred (for the observation log)
      return existed || providerExisted
    }

    // ------------------------------------------------------------------
    // Attempt-aware rescue (v1.1)
    // ------------------------------------------------------------------
    // OpenCode retries a failing request internally and emits
    // session.retry.scheduled for every attempt. Treating that announcement as a
    // terminal failure cooled the model down and switched the session on each
    // retry, which produced the repeated "Switched model to ..." messages.
    // Instead, count the actual failed attempts per session/model and rescue
    // only after cfg.rescueAttemptsBeforeSwitch (default 3) failures.
    // NOTE: "Model unavailable" and quota are definitive — retrying them cannot
    // succeed — so they keep the v1.0 immediate rescue behavior.
    //
    // The same failed attempt is usually observed twice (http.response AND
    // session.step.failed, within moments of each other). Cross-path dedupe
    // is handled by seenViaHttp (the event path only peeks when HTTP already
    // counted the attempt), so the counter itself must NOT time-dedupe: a
    // 15 s window suppressed legitimate rapid retries — failures at t=0, 5 s,
    // 10 s all counted as 1 and the gate never opened for fast retry loops.
    // A short 2 s backstop remains only for the (theoretical) event-first
    // race where step.failed arrives before http.response: the two sightings
    // of one attempt are milliseconds apart, while distinct retries need a
    // full new request round-trip.
    const ATTEMPT_WINDOW_MS = 10 * 60_000 // consecutive-failure window
    const ATTEMPT_RACE_MS = 2_000 // same-attempt two-sighting collapse
    const RESCUE_SUPPRESS_MS = 15_000 // never switch twice in one episode
    const attemptFailures = new Map<string, { count: number; at: number }>()
    const lastHttpFailure = new Map<string, { ref: string; at: number }>()
    const rescueSwitchedAt = new Map<string, number>()
    // Sessions with an in-flight rescue switch (A1-9): the event loop and the
    // http.response hook run concurrently, so both could pass the suppression
    // check during an awaited pick/switch. The claim makes the check atomic.
    const rescueInFlight = new Set<string>()

    const attemptKey = (sessionID: string, ref: string) =>
      `${sessionID}\n${ref}`
    const attemptLimit = () =>
      Math.max(1, Math.min(10, Math.floor(cfg.rescueAttemptsBeforeSwitch ?? 3)))

    const peekAttemptFailures = (sessionID: string, ref: string) => {
      const entry = attemptFailures.get(attemptKey(sessionID, ref))
      if (!entry || Date.now() - entry.at > ATTEMPT_WINDOW_MS) return 0
      return entry.count
    }

    // Record one failed attempt. Returns the updated count. The 2 s backstop
    // collapses only the same attempt's near-simultaneous double sighting;
    // genuine retries (>2 s apart) always count.
    const noteAttemptFailure = (sessionID: string, ref: string) => {
      const now = Date.now()
      const key = attemptKey(sessionID, ref)
      const entry = attemptFailures.get(key)
      if (entry && now - entry.at <= ATTEMPT_RACE_MS)
        return entry.count // same attempt's second sighting (race backstop)
      if (entry && now - entry.at > ATTEMPT_WINDOW_MS) {
        attemptFailures.set(key, { count: 1, at: now })
        return 1
      }
      const count = (entry?.count ?? 0) + 1
      attemptFailures.set(key, { count, at: now })
      // A1-5: bound the map — evict stale entries, then oldest if still big
      if (attemptFailures.size > 256) {
        for (const [k, v] of attemptFailures)
          if (now - v.at > ATTEMPT_WINDOW_MS) attemptFailures.delete(k)
        while (attemptFailures.size > 256) {
          const oldest = attemptFailures.keys().next().value
          if (!oldest) break
          attemptFailures.delete(oldest)
        }
      }
      return count
    }

    const resetAttemptFailures = (sessionID: string, ref: string) => {
      attemptFailures.delete(attemptKey(sessionID, ref))
    }

    const rescueSuppressed = (sessionID: string) =>
      Date.now() - (rescueSwitchedAt.get(sessionID) ?? 0) < RESCUE_SUPPRESS_MS

    // Atomically claim the right to switch this session. Returns false when
    // another rescue is in flight or within the suppression window.
    const tryClaimRescue = (sessionID: string) => {
      if (rescueInFlight.has(sessionID) || rescueSuppressed(sessionID))
        return false
      rescueInFlight.add(sessionID)
      return true
    }
    const releaseRescue = (sessionID: string) => {
      rescueInFlight.delete(sessionID)
    }

    // Called after a successful rescue switch: reset the failed model's budget
    // and suppress a second switch while the same failure episode is still
    // producing events.
    const markRescueSwitch = (sessionID: string, ref: string) => {
      rescueSwitchedAt.set(sessionID, Date.now())
      resetAttemptFailures(sessionID, ref)
      lastHttpFailure.delete(sessionID)
    }

    // Record the attempt and decide whether the budget is exhausted. The gate
    // stays closed (with a WAIT trace) while retries should still run.
    const attemptGateOpen = (sessionID: string, ref: string) => {
      const count = noteAttemptFailure(sessionID, ref)
      const limit = attemptLimit()
      if (count < limit) {
        logRoute(
          `WAIT ${sessionID} ${ref} attempt ${count}/${limit} (letting retries run)`,
        )
        return false
      }
      if (rescueSuppressed(sessionID)) {
        logRoute(
          `WAIT ${sessionID} ${ref} attempt ${count}/${limit} (rescue already switched)`,
        )
        return false
      }
      return true
    }

    // ------------------------------------------------------------------
    // Verified lifting of cooldowns (v0.8.1)
    // ------------------------------------------------------------------
    // Timer expiry != recovery (limits may lift in a different window), so
    // cooldowns with needsVerify are treated as "not recovered" even after timer expiry,
    // and are lifted only when a minimal real probe passes.
    // Verification runs on a 1-hour cycle (every QUOTA_COOLDOWN_MS); on failure
    // it is extended by another hour and keeps falling back to healthy models.
    const VERIFY_RETRY_MS = 10 * 60_000 // minimum interval between re-verifications (prevents bursts)
    const VERIFY_TIMEOUT_MS = 10_000
    const verifyingNow = new Set<string>()

    const scheduleVerification = (ref: string) => {
      // v1.0: verification probes are passive learning (recovery detection for
      // the cooldown map), not session model switches, so they keep running
      // while OFF. The tiny "Reply with exactly: OK" call is the only way to
      // learn that a quota window has actually lifted.
      const entry = cooldowns.get(ref)
      if (!entry || !entry.needsVerify) return
      if (verifyingNow.has(ref)) return
      if (Date.now() - (entry.lastVerifyAt ?? 0) < VERIFY_RETRY_MS) return
      const slash = ref.indexOf("/")
      const providerID = ref.slice(0, slash)
      const modelID = ref.slice(slash + 1)
      verifyingNow.add(ref)
      entry.lastVerifyAt = Date.now()
      void (async () => {
        try {
          const result: any = await Promise.race([
            ctx.experimental.generate.text({
              model: { providerID, id: modelID },
              prompt: "Reply with exactly: OK",
            }),
            new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), VERIFY_TIMEOUT_MS),
            ),
          ])
          const text = String(result?.text ?? "").trim()
          // Accept exactly "OK" (case-insensitive, optional trailing punctuation).
          // Verbose answers mean the model cannot follow a trivial instruction.
          const ok = /^ok[.!]?$/i.test(text)
          if (ok) {
            // Verify success: proof the limit actually lifted, so clear the cooldown
            clearCooldown(ref)
            logRoute(`VERIFY ok ${ref} (cooldown cleared)`)
          } else {
            // Anything else is not evidence of recovery: keep it cooled down.
            entry.until = Date.now() + QUOTA_COOLDOWN_MS
            logRoute(
              text.length === 0
                ? `VERIFY empty ${ref} (cooldown +1h)`
                : `VERIFY unexpected ${ref} "${text.slice(0, 20)}" (cooldown +1h)`,
            )
          }
        } catch (error) {
          // Still unavailable: extend by 1 hour, keeping the verification state
          entry.until = Date.now() + QUOTA_COOLDOWN_MS
          logRoute(
            `VERIFY fail ${ref}: ${String(error).slice(0, 60).replace(/\n/g, " ")} (+1h)`,
          )
        } finally {
          verifyingNow.delete(ref)
          void persistCooldowns()
        }
      })()
    }

    const abortEventWatch = new AbortController()
    // A1-10: started at the end of setup (startEventWatch()), not here. The
    // loop body closes over consts defined later in setup (pending,
    // lastResolved, record, pick...); subscribing now would TDZ-throw if an
    // event arrived mid-setup (e.g. a run already in flight during a hot
    // reload), and the outer catch would silently kill the subscription.
    const startEventWatch = () => {
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.step.failed", "session.retry.scheduled"],
          signal: abortEventWatch.signal,
        }) as AsyncIterable<{ type: string; data?: any }>) {
          const sid = event.data?.sessionID
          if (typeof sid !== "string") continue
          const isRetry = event.type === "session.retry.scheduled"
          const message: string = event.data?.error?.message ?? ""
          const match = /^Model unavailable:\s*(\S+)/.exec(message)
          // Identify the failed model regardless of message format (v0.8.1).
          // Cooldown + fallback must work even for model errors that are not of the
          // "Model unavailable: <ref>" shape (in some environments session.step.failed itself
          // never fires; this also covers prevention for environments where it does).
          let ref: string | undefined = match?.[1]
          if (!ref) {
            // Mitigate mis-attribution (v0.8.1): session.model may already have been rewritten
            // to a healthy model by rescue's switchModel,
            // and blaming it would wrongly cool down a healthy model.
            // Prefer the latest HTTP observation (the model actually dispatched);
            // for failures with no HTTP flight (billing precheck, etc.),
            // use the actually dispatched model recorded by resolve (lastResolved);
            // if that is also absent, fall back to session.model.
            const obs = pending.get(sid)
            if (obs) ref = refFor(obs.providerID, obs.modelID)
            if (!ref) {
              const hint = lastResolved.get(sid)
              if (hint?.providerID && hint?.id)
                ref = refFor(hint.providerID, hint.id)
            }
            if (!ref) {
              try {
                const session: any = await ctx.session.get({ sessionID: sid })
                const m = session?.model
                if (!m?.providerID || !m?.id) continue
                ref = refFor(m.providerID, m.id)
              } catch {
                continue
              }
            }
          }
          const cls = classifyFailure({
            message,
            status: event.data?.error?.status,
            body: event.data?.error?.response?.body,
          })
          if (!ref) continue

          // v1.1: session.retry.scheduled is NOT a terminal failure — the core
          // is about to retry the same request. Log the core's attempt number
          // for the route log only; never cool down or switch here.
          if (isRetry) {
            logRoute(
              `RETRY ${sid} ${ref} attempt ${event.data?.attempt ?? "?"} (no switch, ${peekAttemptFailures(sid, ref)}/${attemptLimit()} failed attempts)`,
            )
            continue
          }

          // "Model unavailable" and quota cannot be fixed by retrying, so they
          // keep the v1.0 immediate rescue. Every other (transient) failure must
          // first exhaust cfg.rescueAttemptsBeforeSwitch attempts.
          const observed = lastHttpFailure.get(sid)
          const seenViaHttp =
            observed?.ref === ref &&
            Date.now() - observed.at <= ATTEMPT_WINDOW_MS
          const definitive = cls === "quota" || match !== null
          // The HTTP path counts its own attempt (attemptGateOpen); when this
          // event is the second sighting of the same attempt, only peek — do
          // not count again, or rapid retries double-count. When there was
          // no HTTP flight (pre-HTTP failure), the event path counts itself.
          const allowSwitch = definitive
            ? !rescueSuppressed(sid)
            : seenViaHttp
              ? peekAttemptFailures(sid, ref) >= attemptLimit()
              : attemptGateOpen(sid, ref)

          if (!allowSwitch) {
            // Passive learning still runs; the model stays for the remaining
            // attempts (seenViaHttp means http.response already recorded it).
            if (cls === "error" && !seenViaHttp) {
              const slash = ref.indexOf("/")
              await record(
                ref.slice(slash + 1),
                ref.slice(0, slash),
                undefined,
                false,
                0,
                true,
              )
            }
            continue
          }

          // Only mark the cooldown if HTTP did not already do so for this
          // attempt (A1-7): http.response marks quota definitively, and a
          // second markFailure from this event would double the failure count.
          if (!seenViaHttp) markFailure(ref, cls)
          // Quota failures are not penalized in quality (don't skew stats success rate)
          if (cls === "error" && !seenViaHttp) {
            const slash = ref.indexOf("/")
            await record(
              ref.slice(slash + 1),
              ref.slice(0, slash),
              undefined,
              false,
              0,
              true,
            )
          }
          // v1.0: cooldown marking + failure stats are passive learning and keep
          // running while OFF. The after-fail model switch is ACTIVE behavior —
          // skip it while OFF ("it switched models even though I turned it off").
          // tryClaimRescue serializes concurrent http.response/event switches.
          if (cfg.enabled && tryClaimRescue(sid)) {
            try {
              const targetRef = ref
              const currentCategory = sessionCategory.get(sid)
              const choice = await pick(
                targetRef,
                currentCategory,
                true,
                sid,
              )
              if (choice) {
                const nextRef = refFor(choice.providerID, choice.id)
                if (nextRef === targetRef) {
                  logRoute(
                    `KEEP after-fail ${targetRef} (best candidate is the failed model)`,
                  )
                } else {
                  try {
                    await ctx.session.switchModel({
                      sessionID: sid,
                      model: { providerID: choice.providerID, id: choice.id },
                    })
                    // Record the originally failed model as a restore candidate
                    rescueAttempts.set(sid, {
                      originalRef: targetRef,
                      deadline: Date.now() + RESCUE_WINDOW_MS,
                    })
                    void persistRescue()
                    markRescueSwitch(sid, targetRef)
                    logRoute(
                      `SWITCH after-fail ${targetRef} -> ${choice.providerID}/${choice.id} (${choice.reason})`,
                    )
                  } catch (error) {
                    logRoute(
                      `after-fail rescue failed ${sid}: ${String(error).slice(0, 80)}`,
                    )
                    console.log(`[adaptive-fusion] after-fail rescue failed: ${error}`)
                  }
                }
              }
            } finally {
              releaseRescue(sid)
            }
          }
        }
      } catch {
        // Failure to subscribe to events is ignored (can happen on reload)
      }
    })()
    }

    // (The watch is intentionally started at the end of setup, below.)

    // ------------------------------------------------------------------
    // Merge attempt tracking (v1.1)
    // ------------------------------------------------------------------
    // Record HTTP failures for dedupe: seenViaHttp in the event path uses
    // this to avoid counting/record the same attempt twice. The timestamp is
    // refreshed on every HTTP failure (A1-2) so it never goes stale.
    const recordHttpFailure = (sid: string, ref: string) => {
      if (!sid || !ref) return
      lastHttpFailure.set(sid, { ref, at: Date.now() })
      if (lastHttpFailure.size > 256) {
        const now = Date.now()
        for (const [k, v] of lastHttpFailure.entries())
          if (now - v.at > ATTEMPT_WINDOW_MS) lastHttpFailure.delete(k)
      }
    }

    // ------------------------------------------------------------------
    // Loading benchmark priors (v0.6)
    // ------------------------------------------------------------------
    const defaultBenchmarksPath = (): string => {
      try {
        const here = path.dirname(fileURLToPath(import.meta.url))
        return path.join(here, "..", "..", ...BENCHMARKS_DEFAULT_RELATIVE)
      } catch {
        return path.join(process.cwd(), ...BENCHMARKS_DEFAULT_RELATIVE)
      }
    }
    const loadBenchmarks = (): BenchmarkFile | undefined => {
      const file = cfg.benchmarksFile?.length > 0
        ? cfg.benchmarksFile
        : defaultBenchmarksPath()
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        benchmarkCache = undefined
        return undefined
      }
      if (benchmarkCache && benchmarkCache.file === file && benchmarkCache.mtimeMs === stat.mtimeMs)
        return benchmarkCache.data
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BenchmarkFile
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof parsed.models !== "object" ||
          parsed.models === null
        )
          return undefined
        benchmarkCache = { mtimeMs: stat.mtimeMs, file, data: parsed }
        return parsed
      } catch {
        return undefined
      }
    }
    // ---- auto-refresh (v1.0): storage-backed benchmark snapshot ----
    // Fetched snapshots stored via the OpenRouter refresh take precedence over
    // the bundled seed file. Set at setup (from storage) and on every refresh.
    let storedBenchmarks: BenchmarkFile | undefined
    // Resolution order: an explicit benchmarksFile always wins (user intent),
    // then the auto-refreshed storage snapshot, then the bundled seed file.
    const currentBenchmarks = (): BenchmarkFile | undefined =>
      cfg.benchmarksFile?.length > 0
        ? loadBenchmarks()
        : storedBenchmarks ?? loadBenchmarks()
    // Pure mapping from the OpenRouter models payload to normalized priors.
    // Mirrors the seed-file normalization (÷100, clip). Unusable models (no
    // artificial_analysis indices) are skipped; coding falls back to the
    // intelligence index; ops falls back agentic→intelligence; review is the
    // mean of intelligence and (agentic ?? intelligence).
    const buildBenchmarkModels = (
      rawModels: unknown[],
    ): Record<string, BenchmarkEntry> => {
      const clampIdx = (value: unknown): number | undefined => {
        // typeof check: Number(null) is 0 (finite) and would poison the
        // agentic/intelligence fallbacks; null/undefined mean "missing".
        if (typeof value !== "number" || !Number.isFinite(value))
          return undefined
        return Math.min(1, Math.max(0, value / 100))
      }
      const out: Record<string, BenchmarkEntry> = {}
      for (const raw of rawModels) {
        const m = raw as {
          id?: unknown
          benchmarks?: { artificial_analysis?: Record<string, unknown> }
        } | null
        const id = typeof m?.id === "string" ? m.id : undefined
        if (!id) continue
        const aa = m?.benchmarks?.artificial_analysis
        const intelligence = clampIdx(aa?.intelligence_index)
        if (intelligence === undefined) continue
        const coding = clampIdx(aa?.coding_index) ?? intelligence
        const agentic = clampIdx(aa?.agentic_index)
        out[`openrouter/${id}`] = {
          overall: intelligence,
          coding,
          debugging: coding,
          research: intelligence,
          writing: intelligence,
          ops: agentic ?? intelligence,
          review: (intelligence + (agentic ?? intelligence)) / 2,
        }
      }
      return out
    }
    type BenchCheckMeta = {
      lastCheckAt: number
      lastResult: string
      lastModelCount?: number
      lastFetchedAt?: string
      updatedAt: string
    }
    let benchCheckRunning = false
    // Refreshes the benchmark library from the public API when fusion is ON
    // and cfg.benchAutoUpdate is set. At most once per day. Any failure keeps
    // the previous snapshot (fail-safe); the marker is written BEFORE the
    // fetch so the duplicate role=server plugin instance does not double-fetch.
    const maybeAutoUpdateBenchmarks = async () => {
      if (!cfg.enabled || !cfg.benchAutoUpdate) return
      // A custom benchmarksFile is an explicit user choice: the refresh must
      // not silently compete with it (the file always wins in resolution).
      if (cfg.benchmarksFile.length > 0) return
      if (benchCheckRunning) return
      let meta: BenchCheckMeta | undefined
      try {
        meta = (await ctx.storage.get(BENCH_CHECK_KEY)) as BenchCheckMeta | undefined
      } catch {
        meta = undefined
      }
      const last = typeof meta?.lastCheckAt === "number" ? meta.lastCheckAt : 0
      if (Date.now() - last < BENCH_CHECK_INTERVAL_MS) return
      benchCheckRunning = true
      try {
        // Mark the check as done up-front (lock for other instances).
        await ctx.storage
          .set(BENCH_CHECK_KEY, {
            ...(meta ?? {}),
            lastCheckAt: Date.now(),
            lastResult: "checking",
            updatedAt: new Date().toISOString(),
          })
          .catch(() => {})
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), BENCH_FETCH_TIMEOUT_MS)
        let parsed: Record<string, BenchmarkEntry> = {}
        try {
          const resp = await fetch(BENCH_API_URL, {
            signal: controller.signal,
            headers: { accept: "application/json" },
          })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const body: unknown = await resp.json()
          const rawModels = Array.isArray((body as { data?: unknown[] })?.data)
            ? ((body as { data: unknown[] }).data as unknown[])
            : []
          parsed = buildBenchmarkModels(rawModels)
        } finally {
          clearTimeout(timer)
        }
        if (Object.keys(parsed).length < BENCH_AUTO_MIN_MODELS)
          throw new Error(`too few usable models (${Object.keys(parsed).length})`)
        // Keep entries that cannot be refreshed from this source
        // (any non-openrouter key, e.g. opencode/* provider ids).
        const previous = currentBenchmarks()
        const retained: Record<string, BenchmarkEntry> = {}
        for (const [key, value] of Object.entries(previous?.models ?? {}))
          if (!key.startsWith("openrouter/")) retained[key] = value
        const next: BenchmarkFile = {
          fetchedAt: new Date().toISOString(),
          source:
            "auto-refresh: OpenRouter /api/v1/models (artificial_analysis, normalized /100)",
          note: "Auto-updated by the plugin (fusion ON + benchAutoUpdate). Non-OpenRouter keys are retained from the previous snapshot.",
          models: { ...parsed, ...retained },
        }
        await ctx.storage.set(BENCHMARKS_AUTO_KEY, next)
        storedBenchmarks = next
        const retainedCount = Object.keys(retained).length
        const result = `ok ${Object.keys(parsed).length} models (${retainedCount} retained)`
        await ctx.storage.set(BENCH_CHECK_KEY, {
          lastCheckAt: Date.now(),
          lastResult: result,
          lastModelCount: Object.keys(parsed).length,
          lastFetchedAt: next.fetchedAt,
          updatedAt: new Date().toISOString(),
        })
        logRoute(`BENCH auto-update ${result}`)
      } catch (error) {
        const result = `fail: ${String(error).slice(0, 120)}`
        try {
          await ctx.storage.set(BENCH_CHECK_KEY, {
            ...(meta ?? {}),
            lastCheckAt: Date.now(),
            lastResult: result,
            updatedAt: new Date().toISOString(),
          })
        } catch {
          // Even failure-marker persistence must not block normal processing
        }
        logRoute(`BENCH auto-update ${result}`)
      } finally {
        benchCheckRunning = false
      }
    }
    // Setup-time restore: prefer the storage snapshot (newer, auto-refreshed),
    // fall back to the bundled seed file.
    try {
      const stored = (await ctx.storage.get(BENCHMARKS_AUTO_KEY)) as
        | BenchmarkFile
        | undefined
      if (
        stored &&
        typeof stored === "object" &&
        stored.models &&
        typeof stored.models === "object" &&
        Object.keys(stored.models).length > 0
      )
        storedBenchmarks = stored
    } catch {
      // Storage unreadable: fall back to the file seed
    }
    // If the priors file is older than 90 days, halve k (staleness mitigation)
    const benchmarkPriorK = (benchmarks?: BenchmarkFile): number => {
      const k = cfg.benchmarkPriorWeight
      if (k <= 0) return 0
      const ts = Date.parse(benchmarks?.fetchedAt ?? "")
      if (Number.isFinite(ts) && Date.now() - ts > 90 * 24 * 60 * 60_000)
        return k / 2
      return k
    }
    const benchmarkFor = (
      benchmarks: BenchmarkFile | undefined,
      ref: string,
      category?: string,
    ): number | undefined => {
      const models = benchmarks?.models
      if (!models) return undefined
      const lookup = (key: string): BenchmarkEntry | undefined => models[key]
      const entry =
        lookup(ref) ?? lookup(ref.replace(/:free$/, ""))
      if (!entry) return undefined
      const key = category as keyof BenchmarkEntry | undefined
      const byCategory = key ? entry[key] : undefined
      const overall = entry.overall
      const value =
        typeof byCategory === "number"
          ? byCategory
          : typeof overall === "number"
            ? overall
            : undefined
      return typeof value === "number" && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : undefined
    }
    const blendBenchmarkPrior = (
      success: number,
      failure: number,
      benchmark: number | undefined,
      k: number,
    ): number => {
      if (benchmark === undefined || k <= 0)
        return (success + 1) / (success + failure + 2)
      return (success + benchmark * k) / (success + failure + k)
    }

    // ------------------------------------------------------------------
    // Candidate models (fetched with normalized shape)
    // ------------------------------------------------------------------
    // Single provider: models under cfg.providerID only.
    // crossProvider: all providers (whitelist uses full-reference form).
    // expand (emergency): all providers, whitelist ignored.
    //   Free tier is account-wide, so if the current provider is cooling down on quota
    //   all of its models are down. Rescue needs to fall back to models on other providers
    //   that are "observed to be healthy".
    // v1.1.1 listMode: "whitelist" (default) = only listed models (empty = all
    // + cost caps). "blacklist" = every candidate EXCEPT the listed ones;
    // the cost caps always apply in blacklist mode (the caps guard the
    // "everything else" pool), and a blacklisted model stays excluded even
    // during emergency expansion (it is a deliberate user exclusion).
    const candidates = async (expand = false) => {
      const raw: any = await ctx.model.list()
      const models: any[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.data)
          ? raw.data
          : Array.isArray(raw?.models)
            ? raw.models
            : []
      const blacklistMode = cfg.listMode === "blacklist"
      const list = new Set(cfg.models)
      // The cost caps apply when they are the only guard (empty whitelist, or
      // blacklist mode where the pool is "everything else").
      const costLimitsApply = blacklistMode || list.size === 0
      const costOK = (m: any) => {
        const tier = m.cost?.[0]
        if (!tier) return false
        const input = Number(tier.input ?? NaN)
        const output = Number(tier.output ?? NaN)
        return (
          Number.isFinite(input) &&
          Number.isFinite(output) &&
          input <= cfg.maxInputCost &&
          output <= cfg.maxOutputCost
        )
      }
      // v1.1.1: blacklist exclusion. Entries match the full
      // `provider/model-id` form and the bare `model-id` form (a bare id
      // excludes that model on every provider — handy for blocking one
      // model family everywhere).
      const excluded = (m: any) => blacklistMode && listHas(m)
      // v1.1.1: provider chain scoping. With a chain set, candidates come
      // from the chain's providers only (priority narrowing happens later in
      // pick()). The whitelist accepts full `provider/model` refs and bare
      // model ids (matched within chain providers). The `:free` suffix is
      // normalized away (same as tier matching), so an entry without the
      // exact suffix still matches its free model.
      const normListRef = (ref: string) => ref.replace(/:free$/, "")
      const listHas = (m: any) =>
        list.has(refFor(m.providerID, m.id)) ||
        list.has(normListRef(refFor(m.providerID, m.id))) ||
        list.has(m.id) ||
        list.has(normListRef(m.id))
      const chainSet =
        cfg.providerChain.length > 0
          ? new Set(cfg.providerChain)
          : undefined
      const inWhitelist = (m: any) =>
        list.size === 0 || listHas(m)
      return models.filter(
        (m) =>
          m.enabled !== false &&
          Array.isArray(m.cost) &&
          m.cost.length > 0 &&
          !excluded(m) &&
          (!costLimitsApply || costOK(m)) &&
          (expand
            ? // Emergency expansion (v0.8.1): goes beyond the whitelist, but applies costOK
              // to keep seamless fallback to paid models within the user's budget.
              // Free models are unaffected by the cap and pass through as-is
              // (v1.1.1: both entry forms match, like the normal branches;
              //  :free suffix normalized).
              // Blacklisted models stay excluded (deliberate user exclusion).
              blacklistMode ||
              list.size === 0 ||
              listHas(m) ||
              costOK(m)
            : blacklistMode
              ? // Blacklist mode: chain/provider scope still applies; the
                // entries themselves are exclusions, not an allowlist.
                chainSet
                  ? chainSet.has(m.providerID)
                  : cfg.crossProvider ||
                    m.providerID === cfg.providerID
              : chainSet
                ? chainSet.has(m.providerID) && inWhitelist(m)
                : cfg.crossProvider
                  ? list.size === 0 || listHas(m)
                  : m.providerID === cfg.providerID &&
                    // v1.1.1: accept both entry forms (the /fusion-modellist UI
                    // recommends provider/model-id even in single-provider mode)
                    (list.size === 0 || listHas(m))),
      )
    }
    // ------------------------------------------------------------------
    // Task Classifier
    // ------------------------------------------------------------------
    // Classify at the prompt hook (admission) with a lightweight model, kept per session.
    const sessionCategory = new Map<string, string>()
    // Keep the "adopted topology" per session (for recording at http.response)
    const sessionTopology = new Map<string, string>()
    // Per-session load band (v0.8 tier routing). Estimated at admission classify,
    // used by the tier selection in experimental.model.resolve. Updated per turn.
    const sessionLoad = new Map<string, TierName>()
    // Per-session reasoning-effort hint (v1.1 variant auto-selection, 0=low,
    // 1=medium, 2=high). Asked from Jev in the same round trip as the task
    // classification (no extra API call), from the legacy LLM classifier, or
    // derived from the load band as the last resort. Consumed by the resolve
    // hook's variant selection.
    const sessionEffort = new Map<string, number>()

    // Load-band heuristic (last-resort fallback when Jev/LLM is unavailable).
    // Estimate 0-100 from category defaults + text length + multi-step keywords.
    const heuristicLoad = (text: string, category?: string): TierName => {
      let score = 30
      if (category === "coding" || category === "debugging") score += 25
      else if (category === "research" || category === "review") score += 15
      else if (category === "writing") score += 10
      if (text.length > 200) score += 10
      if (text.length > 600) score += 15
      if (
        /(リファクタ|設計|アーキテクチャ|全ての|すべての|一括|移行|実装|migrate|refactor|architect|design|implement|across all files|multi-step)/i
          .test(text)
      )
        score += 25
      if (/(タイポ|typo|直して|修正して|rename|fix this)/i.test(text)) score -= 20
      if (score >= TIER_THRESHOLD_HEAVY) return "heavy"
      if (score >= TIER_THRESHOLD_MIDDLE) return "middle"
      return "light"
    }

    const loadFromScore = (value: number): TierName => {
      if (value >= TIER_THRESHOLD_HEAVY) return "heavy"
      if (value >= TIER_THRESHOLD_MIDDLE) return "middle"
      return "light"
    }

    const setSessionLoad = (
      sessionID: string,
      load: TierName,
      source: string,
      raw?: number,
    ) => {
      sessionLoad.set(sessionID, load)
      if (sessionLoad.size > 200) {
        const oldest = sessionLoad.keys().next().value
        if (oldest) sessionLoad.delete(oldest)
      }
      logRoute(
        `LOAD ${load}${raw === undefined ? "" : `(${Math.round(raw)})`} via ${source}`,
      )
    }

    // ------------------------------------------------------------------
    // Reasoning-effort (variant) auto-selection (v1.1)
    // ------------------------------------------------------------------
    // OpenCode models expose named variants ("#low", "#high", "#max", ...)
    // that switch request settings such as reasoningEffort / thinking budget.
    // The variant ids are provider-specific, so selection is positional over
    // the model's OWN variant list ranked by an effort scale — not by name.
    //
    // The design is "model first, then variant": the routing/tier step picks
    // the model, and the variant is then chosen against the CHOSEN MODEL's
    // weight class, not the task band alone. This avoids the rigid coupling
    // "light task -> light model -> low effort, heavy task -> heavy model ->
    // high effort":
    //   matched pair  (task band == model class) -> provider default (no override)
    //   heavier task  than model (compensate)    -> highest variant
    //   lighter task  than model (save cost)     -> lowest variant
    //   model class unknown                      -> the task band itself
    // Two anti-ossification mechanisms sit on top:
    //   - ε-greedy exploration (variantExploreRate) samples non-computed
    //     variants so they accumulate observations
    //   - a closed-loop bandit over the adjacent effort levels: the computed
    //     pick competes on observed ok-rate (Laplace-smoothed, unobserved =
    //     neutral 0.5), so a hint or band rule that keeps producing failures
    //     demotes itself to an adjacent level — it cannot lock the session
    //     into a poorly performing effort
    const VARIANT_EFFORT_RANK: Record<string, number> = {
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
    }
    const variantEffortRank = (id: string) =>
      VARIANT_EFFORT_RANK[id.toLowerCase()] ?? 2

    // Pure helpers (mirrored in tests).
    const variantBandLevel = (load: TierName) => 2 - TIER_NAMES.indexOf(load)
    const pickVariantIndex = (variants: string[], level: number) => {
      if (!Array.isArray(variants) || variants.length < 2) return -1
      const ranked = variants
        .map((v, i) => ({ rank: variantEffortRank(String(v)), i }))
        .sort((a, b) => a.rank - b.rank)
      if (level >= 2) return ranked[ranked.length - 1].i
      if (level === 1) return ranked[Math.max(0, Math.ceil(ranked.length / 2) - 1)].i
      return ranked[0].i
    }
    // Which effort level the task asks of the model: undefined = matched
    // pair (no compensation needed, keep the provider default). `band` is a
    // raw level 0..2 — either derived from the load band or from the per-turn
    // Jev/LLM effort hint.
    const variantLevelForLevel = (band: number, cls: TierName | undefined) => {
      if (!cls) return band
      const delta = band - variantBandLevel(cls)
      if (delta === 0) return undefined
      return Math.max(0, Math.min(2, 1 + delta))
    }
    const variantLevelFor = (load: TierName, cls: TierName | undefined) =>
      variantLevelForLevel(variantBandLevel(load), cls)

    // Weight class of the dispatched model: the effective tier lists first
    // (manual/auto), otherwise the benchmark overall score. undefined when
    // neither is available (class compensation is then skipped).
    const modelClassOf = (providerID: string, modelID: string): TierName | undefined => {
      try {
        const ref = refFor(providerID, modelID)
        const tiers = resolveTiers()
        if (tiers) {
          for (const tier of TIER_NAMES) {
            if (tiers[tier].some((r) => normRef(r) === normRef(ref)))
              return tier
          }
        }
        const score = benchmarkFor(currentBenchmarks(), ref)
        return score === undefined
          ? undefined
          : loadFromScore(Math.round(score * 100))
      } catch {
        return undefined
      }
    }

    // Per-(model,variant) outcome records. Learning data for the neighbor
    // upgrade and /fusion-stats. Light persistence: one key per variant.
    type VariantStat = {
      model: { providerID: string; id: string }
      variant: string
      count: number
      ok: number
      totalMs: number
      updatedAt: string
    }
    const loadVariantStat = async (
      providerID: string,
      modelID: string,
      variant: string,
    ): Promise<VariantStat | undefined> => {
      try {
        const saved = await ctx.storage.get(
          `${VARIANT_PREFIX}${providerID}/${modelID}/${variant}`,
        )
        if (
          saved &&
          typeof saved === "object" &&
          typeof (saved as VariantStat).count === "number"
        )
          return saved as VariantStat
      } catch {
        // Unreadable records fall back to the neutral prior
      }
      return undefined
    }
    const saveVariantStat = async (stat: VariantStat) => {
      try {
        await ctx.storage.set(
          `${VARIANT_PREFIX}${stat.model.providerID}/${stat.model.id}/${stat.variant}`,
          stat,
        )
      } catch {
        // Recording failure must not block the dispatch
      }
    }
    const recordVariantOutcome = (
      providerID: string,
      modelID: string,
      variant: string | undefined,
      ok: boolean,
      ms: number,
    ) => {
      // Dispatches without an explicit variant (matched pair -> provider
      // default) are recorded under the synthetic id "default" so the
      // learning data covers the no-override choice as well.
      const key = variant || "default"
      void (async () => {
        const saved =
          (await loadVariantStat(providerID, modelID, key)) ?? {
            model: { providerID, id: modelID },
            variant: key,
            count: 0,
            ok: 0,
            totalMs: 0,
            updatedAt: "",
          }
        saved.count += 1
        if (ok) saved.ok += 1
        saved.totalMs += ms
        saved.updatedAt = new Date().toISOString()
        await saveVariantStat(saved)
        logRoute(
          `VARIANT obs ${providerID}/${modelID}#${key} ${ok ? "ok" : "fail"} (${saved.ok}/${saved.count})`,
        )
      })()
    }

    // Laplace-smoothed ok-rate (unobserved = neutral 0.5)
    const variantOkScore = (stat: VariantStat | undefined) =>
      stat && stat.count > 0 ? (stat.ok + 1) / (stat.count + 2) : 0.5

    // Decide the variant for one dispatch. Returns the variant id (or
    // undefined = keep provider default) and a human-readable note.
    // `bandLevel` is the requested effort level 0..2 — the per-turn Jev/LLM
    // hint when available, otherwise derived from the load band by the caller.
    const variantForDispatch = async (
      providerID: string,
      modelID: string,
      load: TierName | undefined,
      bandLevel?: number,
    ): Promise<{ variant?: string; note: string }> => {
      try {
        const info: any = await (ctx.model as any).get(providerID, modelID)
        const ids: string[] = ((info?.variants ?? []) as any[])
          .map((v) => (typeof v === "string" ? v : v?.id))
          .filter((v): v is string => typeof v === "string" && v.length > 0)
        if (ids.length < 2) return { note: "no variants" }
        // ε-greedy exploration: sometimes sample a non-computed variant so
        // alternatives accumulate outcome records (anti-ossification).
        if (Math.random() < clamp(cfg.variantExploreRate, 0, 1)) {
          return {
            variant: ids[Math.floor(Math.random() * ids.length)],
            note: "explore",
          }
        }
        const cls = modelClassOf(providerID, modelID)
        const level =
          typeof bandLevel === "number" && Number.isFinite(bandLevel)
            ? variantLevelForLevel(clamp(Math.round(bandLevel), 0, 2), cls)
            : variantLevelFor(load ?? "middle", cls)
        if (level === undefined) {
          // Matched pair (provider default). If the default keeps failing
          // (>=2 observations, ok-rate below the neutral prior), the
          // matched-pair judgment was likely wrong — the task is heavier than
          // judged. Escape upward: fall through with level=2 (highest
          // variant) instead of returning the failing default forever (B3).
          const defaultStat = await loadVariantStat(
            providerID,
            modelID,
            "default",
          )
          if (
            defaultStat &&
            defaultStat.count >= 2 &&
            variantOkScore(defaultStat) < 0.5
          ) {
            const ranked = ids
              .map((v, i) => ({ id: v, rank: variantEffortRank(v), i }))
              .sort((a, b) => a.rank - b.rank)
            return {
              variant: ranked[ranked.length - 1].id,
              note: `default failing ok=${(variantOkScore(defaultStat) * 100).toFixed(0)}% -> compensate up (matched ${cls})`,
            }
          }
          return { note: `matched ${cls} (provider default)` }
        }
        // Ranked by effort; the computed pick is the level's position.
        // pickVariantIndex (tested mirror) is the single source for the
        // position; the bandit below works in ranked coordinates.
        const ranked = ids
          .map((v, i) => ({ id: v, rank: variantEffortRank(v), i }))
          .sort((a, b) => a.rank - b.rank)
        const computedIdx = pickVariantIndex(ids, level)
        if (computedIdx < 0) return { note: "no variants" }
        const computedPos = ranked.findIndex((r) => r.i === computedIdx)
        if (computedPos < 0) return { note: "no variants" }
        let pos = computedPos
        // v1.1: closed-loop learning (anti-ossification). The computed pick
        // does not just get "upgraded" when a neighbor is better — it
        // competes with its adjacent effort levels on observed ok-rate
        // (Laplace-smoothed, unobserved = neutral 0.5). A computed variant
        // performing below the neutral prior (repeated failures) demotes
        // itself to an unobserved adjacent level, so a fixed Jev/LLM hint can
        // never lock the session into a poorly performing effort: the loop
        // escapes through the data. Ties keep the computed pick (no churn).
        const base = await loadVariantStat(providerID, modelID, ranked[pos].id)
        let bestScore = variantOkScore(base)
        // Randomize evaluation order (B4): with two unobserved neighbors the
        // escape victim must not deterministically be the cheaper one.
        const neighbors =
          Math.random() < 0.5
            ? [computedPos - 1, computedPos + 1]
            : [computedPos + 1, computedPos - 1]
        for (const j of neighbors) {
          if (j < 0 || j >= ranked.length) continue
          const neighbor = await loadVariantStat(
            providerID,
            modelID,
            ranked[j].id,
          )
          const score = variantOkScore(neighbor) // unobserved = 0.5
          // Two ways a neighbor may take over:
          //  - evidence: 2+ observations with a better ok-rate beat the pick
          //    (a single lucky ε sample must not churn it away)
          //  - escape: an unobserved neighbor rescues a pick performing below
          //    the neutral prior (repeated failures) — the loop stays closed
          //    even when no alternative has been sampled yet
          const compete =
            neighbor && neighbor.count >= 2
              ? score > bestScore
              : !neighbor && bestScore < 0.5
          if (compete) {
            pos = j
            bestScore = score
          }
        }
        const picked = ranked[pos]
        return {
          variant: picked.id,
          note: `level ${level} of cls=${cls ?? "?"}${pos !== computedPos ? ` learned ok=${(bestScore * 100).toFixed(0)}%` : ""}`,
        }
      } catch {
        return { note: "catalog unavailable" }
      }
    }

    // Mode-aware variant decision for one session dispatch: "fixed" forces
    // cfg.variantFixed (verified against the model's catalog), "auto" runs the
    // hint + class-compensation + exploration pipeline, undefined = do not touch.
    const variantForSession = async (
      providerID: string,
      modelID: string,
      sessionID: string,
    ): Promise<{ variant?: string; note: string } | undefined> => {
      if (cfg.variantMode === "fixed") {
        const wanted = cfg.variantFixed
        if (!wanted) return undefined
        try {
          const info: any = await (ctx.model as any).get(providerID, modelID)
          const has = ((info?.variants ?? []) as any[]).some(
            (v) => (typeof v === "string" ? v : v?.id) === wanted,
          )
          if (!has) return { note: `#${wanted} not available` }
          return { variant: wanted, note: "fixed" }
        } catch {
          return { note: "catalog unavailable" }
        }
      }
      if (cfg.variantMode === "auto")
        return variantForDispatch(
          providerID,
          modelID,
          sessionLoad.get(sessionID),
          sessionEffort.get(sessionID),
        )
      return undefined
    }

    const saveReviewAssignment = async (sessionID: string, category: string) => {
      try {
        // Preserve the per-turn metadata/rated markers when overwriting the
        // assignment (v1.1.1 review fix).
        const prev = await loadReviewTurns(sessionID)
        await ctx.storage.set(`${REVIEW_PREFIX}${sessionID}`, {
          category,
          assignedAt: new Date().toISOString(),
          ...(Object.keys(prev).length > 0 ? { turns: prev } : {}),
        })
      } catch {
        // Failure to persist review-assignment metadata does not block normal processing
      }
    }
    const loadReviewAssignment = async (
      sessionID: string,
    ): Promise<{ category?: string; assignedAt?: string }> => {
      const saved = await ctx.storage.get(`${REVIEW_PREFIX}${sessionID}`)
      if (!saved || typeof saved !== "object") return {}
      const s = saved as Record<string, unknown>
      return {
        category: typeof s.category === "string" ? s.category : undefined,
        assignedAt: typeof s.assignedAt === "string" ? s.assignedAt : undefined,
      }
    }

    // ------------------------------------------------------------------
    // Per-turn review metadata + rated markers (v1.1.1 review fix)
    // ------------------------------------------------------------------
    // One review per turn: each assistant turn's metadata (topology/category
    // actually used) and its human ratings are recorded under
    // fusion/review/<sessionID>.turns keyed by the target messageID. The
    // rated markers stop the same turn from being rated twice, and the
    // per-turn topology/category stop adjacent turns from showing the
    // session-current stats ("stuck stats" across turns).
    type ReviewTurnMeta = {
      topology: string
      category: string
      at: number
      rating?: number
      topologyRating?: number
    }
    const loadReviewTurns = async (
      sessionID: string,
    ): Promise<Record<string, ReviewTurnMeta>> => {
      try {
        const saved = await ctx.storage.get(`${REVIEW_PREFIX}${sessionID}`)
        if (!saved || typeof saved !== "object") return {}
        const turns = (saved as Record<string, unknown>).turns
        if (!turns || typeof turns !== "object") return {}
        const out: Record<string, ReviewTurnMeta> = {}
        for (const [id, v] of Object.entries(
          turns as Record<string, unknown>,
        )) {
          if (!v || typeof v !== "object") continue
          const t = v as Record<string, unknown>
          if (typeof t.topology !== "string") continue
          out[id] = {
            topology: t.topology,
            category: typeof t.category === "string" ? t.category : "",
            at: typeof t.at === "number" ? t.at : 0,
            ...(typeof t.rating === "number" ? { rating: t.rating } : {}),
            ...(typeof t.topologyRating === "number"
              ? { topologyRating: t.topologyRating }
              : {}),
          }
        }
        return out
      } catch {
        return {}
      }
    }
    const saveReviewTurns = async (
      sessionID: string,
      turns: Record<string, ReviewTurnMeta>,
    ) => {
      try {
        const saved = await ctx.storage.get(`${REVIEW_PREFIX}${sessionID}`)
        const s =
          saved && typeof saved === "object"
            ? (saved as Record<string, unknown>)
            : {}
        // Bound the map: keep the latest 100 turn entries.
        const entries = Object.entries(turns).sort((a, b) => b[1].at - a[1].at)
        const bounded: Record<string, ReviewTurnMeta> = {}
        for (const [id, meta] of entries.slice(0, 100)) bounded[id] = meta
        await ctx.storage.set(`${REVIEW_PREFIX}${sessionID}`, {
          ...s,
          turns: bounded,
        })
      } catch {
        // Failure to persist turn metadata does not block the review flow
      }
    }
    const upsertReviewTurn = async (
      sessionID: string,
      messageID: string,
      patch: Partial<ReviewTurnMeta> & { topology: string; category: string },
    ) => {
      if (!messageID) return
      const turns = await loadReviewTurns(sessionID)
      const existing = turns[messageID]
      turns[messageID] = {
        topology: patch.topology ?? existing?.topology ?? "single",
        category: patch.category ?? existing?.category ?? "",
        at: Date.now(),
        ...(existing?.rating !== undefined ? { rating: existing.rating } : {}),
        ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
        ...(existing?.topologyRating !== undefined
          ? { topologyRating: existing.topologyRating }
          : {}),
        ...(patch.topologyRating !== undefined
          ? { topologyRating: patch.topologyRating }
          : {}),
      }
      await saveReviewTurns(sessionID, turns)
    }

    // ------------------------------------------------------------------
    // Topology observation (v0.7a)
    // ------------------------------------------------------------------
    // Link "the judged shape" via Jev or track record/heuristics to the http.response
    // result (ok/ms), and accumulate into fusion/topology/*.
    // Failures (other than quota) are also recorded. quota is excluded as it does not measure model quality.
    const loadTopologyStat = async (key: string): Promise<TopologyStat | undefined> => {
      const saved = await ctx.storage.get(key)
      if (!saved || typeof saved !== "object") return undefined
      const s = saved as Record<string, unknown>
      if (typeof s.topology !== "string") return undefined
      return {
        topology: s.topology,
        category: typeof s.category === "string" ? s.category : undefined,
        count: num(s.count, 0),
        ok: num(s.ok, 0),
        totalMs: num(s.totalMs, 0),
        sumQuality: num(s.sumQuality, 0),
        qualityCount: num(s.qualityCount, 0),
        sumCostPerformance: num(s.sumCostPerformance, 0),
        costPerformanceCount: num(s.costPerformanceCount, 0),
        sumJevPrior: num(s.sumJevPrior, 0),
        jevPriorCount: num(s.jevPriorCount, 0),
        auxCalls: num(s.auxCalls, 0),
        auxMs: num(s.auxMs, 0),
        lastUsedAt: num(s.lastUsedAt, 0),
        updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
      }
    }
    const writeTopologyStat = async (stat: TopologyStat, key: string) => {
      stat.updatedAt = new Date().toISOString()
      await ctx.storage.set(key, stat)
    }
    const emptyTopologyStat = (
      topology: string,
      category?: string,
    ): TopologyStat => ({
      topology,
      ...(category !== undefined ? { category } : {}),
      count: 0,
      ok: 0,
      totalMs: 0,
      sumQuality: 0,
      qualityCount: 0,
      sumCostPerformance: 0,
      costPerformanceCount: 0,
      sumJevPrior: 0,
      jevPriorCount: 0,
      auxCalls: 0,
      auxMs: 0,
      lastUsedAt: 0,
      updatedAt: "",
    })
    const recordTopology = async (
      sessionID: string,
      ok: boolean,
      ms: number,
    ) => {
      try {
        const topology = sessionTopology.get(sessionID) ?? "single"
        const category = sessionCategory.get(sessionID)
        const global = (await loadTopologyStat(TOPOLOGY_PREFIX + topology)) ??
          emptyTopologyStat(topology)
        global.count += 1
        if (ok) global.ok += 1
        global.totalMs += ms
        global.lastUsedAt = Date.now()
        await writeTopologyStat(global, TOPOLOGY_PREFIX + topology)
        if (category) {
          const taskKey = `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`
          const task = (await loadTopologyStat(taskKey)) ??
            emptyTopologyStat(topology, category)
          task.count += 1
          if (ok) task.ok += 1
          task.totalMs += ms
          task.lastUsedAt = Date.now()
          await writeTopologyStat(task, taskKey)
        }
      } catch {
        // Topology observation failure does not block normal processing
      }
    }
    // Add the inner review (autoReview) score into the topology stats (v0.7a).
    // Called right after http.response, when runAutoReview completes.
    const recordTopologyQuality = async (
      sessionID: string,
      quality: number,
    ) => {
      try {
        const topology = sessionTopology.get(sessionID) ?? "single"
        const category = sessionCategory.get(sessionID)
        const apply = (stat: TopologyStat) => {
          stat.sumQuality += quality
          stat.qualityCount += 1
          stat.lastUsedAt = Date.now()
        }
        const global = (await loadTopologyStat(TOPOLOGY_PREFIX + topology)) ??
          emptyTopologyStat(topology)
        apply(global)
        await writeTopologyStat(global, TOPOLOGY_PREFIX + topology)
        if (category) {
          const taskKey = `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`
          const task = (await loadTopologyStat(taskKey)) ??
            emptyTopologyStat(topology, category)
          apply(task)
          await writeTopologyStat(task, taskKey)
        }
      } catch {
        // Adding topology quality failure does not block normal processing
      }
    }
    // Add the human "cost-performance of this topology" rating (1-5).
    const recordTopologyCostPerformance = async (
      sessionID: string,
      rating: number,
      // v1.1.1: the TURN's topology (per-turn metadata). Falls back to the
      // session's current topology (legacy behavior) when absent.
      turnTopology?: string,
      turnCategory?: string,
    ) => {
      try {
        const topology = turnTopology ?? sessionTopology.get(sessionID) ?? "single"
        const category = turnCategory ?? sessionCategory.get(sessionID)
        const apply = (stat: TopologyStat) => {
          stat.sumCostPerformance += rating
          stat.costPerformanceCount += 1
          stat.lastUsedAt = Date.now()
        }
        const global = (await loadTopologyStat(TOPOLOGY_PREFIX + topology)) ??
          emptyTopologyStat(topology)
        apply(global)
        await writeTopologyStat(global, TOPOLOGY_PREFIX + topology)
        if (category) {
          const taskKey = `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`
          const task = (await loadTopologyStat(taskKey)) ??
            emptyTopologyStat(topology, category)
          apply(task)
          await writeTopologyStat(task, taskKey)
        }
      } catch {
        // Adding topology cost-performance failure does not block normal processing
      }
    }
    // Record the Jev Choice probability distribution as the topology prior (the w1 of D-4).
    // Each judgment distributes probability 1 across the shapes; the average prior probability feeds the selection score.
    const recordTopologyPrior = async (
      category: string | undefined,
      probabilities: Record<string, number> | undefined,
    ) => {
      if (!probabilities || typeof probabilities !== "object") return
      const entries = Object.entries(probabilities).filter(
        (e): e is [string, number] =>
          cfg.allowedTopologies.includes(e[0]) &&
          typeof e[1] === "number" &&
          Number.isFinite(e[1]),
      )
      if (entries.length === 0) return
      try {
        for (const [topology, rawProb] of entries) {
          const prob = Math.min(1, Math.max(0, rawProb))
          const apply = (stat: TopologyStat) => {
            stat.sumJevPrior += prob
            stat.jevPriorCount += 1
          }
          const global = (await loadTopologyStat(TOPOLOGY_PREFIX + topology)) ??
            emptyTopologyStat(topology)
          apply(global)
          await writeTopologyStat(global, TOPOLOGY_PREFIX + topology)
          if (category) {
            const taskKey = `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`
            const task = (await loadTopologyStat(taskKey)) ??
              emptyTopologyStat(topology, category)
            apply(task)
            await writeTopologyStat(task, taskKey)
          }
        }
      } catch {
        // Recording prior failure does not block normal processing
      }
    }
    // Add the duration of auxiliary calls (planner, etc.) to the topology stats.
    // Kept in auxCalls/auxMs to distinguish from the main response's totalMs.
    const recordTopologyAux = async (sessionID: string, ms: number) => {
      try {
        const topology = sessionTopology.get(sessionID) ?? "single"
        const category = sessionCategory.get(sessionID)
        const apply = (stat: TopologyStat) => {
          stat.auxCalls += 1
          stat.auxMs += ms
          stat.lastUsedAt = Date.now()
        }
        const global = (await loadTopologyStat(TOPOLOGY_PREFIX + topology)) ??
          emptyTopologyStat(topology)
        apply(global)
        await writeTopologyStat(global, TOPOLOGY_PREFIX + topology)
        if (category) {
          const taskKey = `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`
          const task = (await loadTopologyStat(taskKey)) ??
            emptyTopologyStat(topology, category)
          apply(task)
          await writeTopologyStat(task, taskKey)
        }
      } catch {
        // Auxiliary-call measurement failure does not block normal processing
      }
    }
    // Topology selection score (D-4 weighted combination).
    //   score = w1 x Jev prior probability + w2 x human cost-performance + w3 x automatic observation
    // Axes without a signal use the neutral 0.5. Without a Jev key, w1=0 with normalization.
    const topologyScore = (stat: TopologyStat, useJevPrior: boolean): number => {
      const wJev = useJevPrior ? cfg.topologyWeightJev : 0
      const wCP = cfg.topologyWeightHumanCP
      const wAuto = cfg.topologyWeightAuto
      const total = wJev + wCP + wAuto
      if (total <= 0) return 0
      const prior =
        stat.jevPriorCount > 0
          ? stat.sumJevPrior / stat.jevPriorCount
          : 0.5
      const cp =
        stat.costPerformanceCount > 0
          ? stat.sumCostPerformance / stat.costPerformanceCount / 5
          : 0.5
      // Automatic observation: primarily the inner-review quality average, falling back to the ok rate
      const auto =
        stat.qualityCount > 0
          ? stat.sumQuality / stat.qualityCount / 5
          : stat.count > 0
            ? stat.ok / stat.count
            : 0.5
      return (wJev * prior + wCP * cp + wAuto * auto) / total
    }
    // Summary of per-category topology track record (passed to Jev's state).
    // Includes ALL allowed topologies with explicit "no data" for shapes with zero observations.
    // Example: "coding: single 12x (ok 83%, quality 4.1), router 5x (ok 60%, quality 3.2), sequential-chain: no data"
    const topologyStatsSummary = async (
      category: string | undefined,
    ): Promise<string> => {
      if (!category) return "(no prior stats)"
      const parts: string[] = []
      for (const topology of cfg.allowedTopologies) {
        const key = `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`
        const stat = await loadTopologyStat(key)
        if (stat && stat.count > 0) {
          const okPct = Math.round((stat.ok / stat.count) * 100)
          const quality =
            stat.qualityCount > 0
              ? (stat.sumQuality / stat.qualityCount).toFixed(1)
              : "n/a"
          parts.push(
            `${topology}: ${stat.count}件 (ok ${okPct}%, quality ${quality})`,
          )
        } else {
          parts.push(`${topology}: no data`)
        }
      }
      return parts.join(", ")
    }

    // Deterministic topology prior from the task shape (load band + category).
    // Weights favor single by construction; heavy/analytical tasks shift mass
    // onto sequential-chain. Renormalized into probabilities by the caller.
    // Category multipliers reflect where multi-step shapes historically pay off:
    //   research/coding/writing/debugging -> chain-boost, review/ops -> single-boost.
    const heuristicTopologyWeights = (
      load: TierName | undefined,
      category: string | undefined,
    ): Record<string, number> => {
      let single: number
      let chain: number
      let router: number
      if (load === "light") {
        single = 0.85; chain = 0.03; router = 0.02
      } else if (load === "middle") {
        single = 0.6; chain = 0.14; router = 0.04
      } else if (load === "heavy") {
        single = 0.3; chain = 0.52; router = 0.08
      } else {
        // No load estimate: keep single dominant, chain merely visible
        single = 0.6; chain = 0.1; router = 0.04
      }
      const cat = category ?? ""
      if (cat === "research") { chain *= 1.6; router *= 2.0 }
      else if (cat === "coding") chain *= 1.4
      else if (cat === "writing") chain *= 1.3
      else if (cat === "debugging") chain *= 1.2
      else if (cat === "review") { chain *= 0.7; single *= 1.2; router *= 1.5 }
      else if (cat === "ops") { chain *= 0.5; single *= 1.3 }
      return { single, router, "sequential-chain": chain }
    }
    // Normalize a weight map into probabilities (sums to 1). Keys absent
    // from the map are dropped; empty map normalizes to single.
    const normalizeTopologyWeights = (
      weights: Record<string, number>,
    ): Record<string, number> => {
      let total = 0
      for (const v of Object.values(weights)) total += v
      if (total <= 0) return { single: 1 }
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(weights)) out[k] = v / total
      return out
    }
    // Bayesian reward for a topology given its track record.
    //   auto component: Beta-style posterior mean of (shadow-review quality
    //     normalized to 0..1), falling back to the ok rate when no quality
    //     samples exist yet. With no data at all it returns the prior mean,
    //     so an untested shape is never preferred or penalized by data — it
    //     simply inherits the heuristic prior.
    //   cp component: Beta smoothing of the human cost-performance mean
    //     (0..1), neutral 0.5 when unrated.
    //   Final: weighted sum with wAuto / wCP (Jev enters separately as the
    //   blend term in selectTopology, not here).
    // TOPO_PRIOR_STRENGTH is now configurable via cfg.topologyPriorStrength
    // (default 4, pseudo-observations). Larger = stronger anchoring to the
    // task-shape prior; smaller = track record decides faster.
    const topologyReward = (
      stat: TopologyStat | undefined,
      priorMean: number,
    ): number => {
      const pm = clamp(priorMean, 0, 1)
      const strength = clamp(cfg.topologyPriorStrength ?? 4, 1, 20)
      const a0 = 1 + strength * pm
      const b0 = 1 + strength * (1 - pm)
      const auto =
        stat && stat.qualityCount > 0
          ? (stat.sumQuality / 5 + a0) / (stat.qualityCount + a0 + b0)
          : stat && stat.count > 0
            ? (stat.ok + a0) / (stat.count + a0 + b0)
            : pm
      const cp =
        stat && stat.costPerformanceCount > 0
          ? (stat.sumCostPerformance / 5 + a0) /
            (stat.costPerformanceCount + a0 + b0)
          : 0.5
      const wAuto = cfg.topologyWeightAuto
      const wCP = cfg.topologyWeightHumanCP
      const total = wAuto + wCP
      if (total <= 0) return auto
      return (wAuto * auto + wCP * cp) / total
    }
    // Bayesian topology distribution: for every allowed topology the reward
    // above is computed (prior from the load band + category, track record
    // from fusion/topology/task/*) and normalized to probabilities.
    const bayesianTopologyDistribution = async (
      category: string | undefined,
      load: TierName | undefined,
    ): Promise<Record<string, number>> => {
      const prior = normalizeTopologyWeights(heuristicTopologyWeights(load, category))
      const rewards: Record<string, number> = {}
      for (const topology of cfg.allowedTopologies) {
        if (!(topology in TOPOLOGY_CATALOG)) continue
        let stat: TopologyStat | undefined
        if (category) {
          stat = await loadTopologyStat(
            `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`,
          )
        }
        rewards[topology] = topologyReward(stat, prior[topology] ?? 0.01)
      }
      return normalizeTopologyWeights(rewards)
    }
    // Probability distribution from a Jev Choice answer restricted to the
    // allowed topologies. Falls back to one-hot on the chosen choice (or a
    // uniform distribution) when probabilities are missing/garbled.
    const jevTopologyDistribution = (
      probabilities: Record<string, number> | undefined,
      choice: string | undefined,
    ): Record<string, number> => {
      const filtered: Record<string, number> = {}
      for (const t of cfg.allowedTopologies) {
        if (!(t in TOPOLOGY_CATALOG)) continue
        const v = probabilities?.[t]
        if (typeof v === "number" && Number.isFinite(v) && v > 0) filtered[t] = v
      }
      if (Object.keys(filtered).length === 0) {
        for (const t of cfg.allowedTopologies)
          if (t in TOPOLOGY_CATALOG) filtered[t] = 1
        if (choice && choice in filtered) {
          for (const t of Object.keys(filtered)) filtered[t] = t === choice ? 1 : 0
        }
      }
      return normalizeTopologyWeights(filtered)
    }
    // Blend two distributions: (1 - wJev) * heuristic + wJev * jev.
    const blendTopologyDistributions = (
      heuristic: Record<string, number>,
      jev: Record<string, number>,
      wJev: number,
    ): Record<string, number> => {
      const w = clamp(wJev, 0, 1)
      const out: Record<string, number> = {}
      for (const t of new Set([...Object.keys(heuristic), ...Object.keys(jev)]))
        if (t in TOPOLOGY_CATALOG)
          out[t] = (1 - w) * (heuristic[t] ?? 0) + w * (jev[t] ?? 0)
      return normalizeTopologyWeights(out)
    }
    const bestTopologyOf = (p: Record<string, number>): string => {
      let best = "single"
      let bestP = -1
      for (const [t, v] of Object.entries(p)) {
        if (t === "sequential-chain" && cfg.maxTopologyCalls < 2) continue
        if (v > bestP) {
          bestP = v
          best = t
        }
      }
      return best
    }
    // ε-greedy exploration: with probability cfg.topologyExploreRate pick a
    // random allowed topology other than the greedy pick (recorded like any
    // other, so the track record can accumulate for non-single shapes).
    const exploreTopology = (greedy: string, allowed: string[]): string => {
      const rest = allowed.filter(
        (t) => t !== greedy && t in TOPOLOGY_CATALOG &&
          (t !== "sequential-chain" || cfg.maxTopologyCalls >= 2),
      )
      if (rest.length === 0) return greedy
      return rest[Math.floor(Math.random() * rest.length)]
    }
    // Greedy selection using the task-shape prior and (optionally) Jev's
    // distribution. Returns the chosen topology plus a trace string.
    // Sequential-chain additionally requires maxTopologyCalls >= 2.
    const selectTopology = async (
      category: string | undefined,
      load: TierName | undefined,
      jevProb: Record<string, number> | undefined,
    ): Promise<{ topology: string; trace: string }> => {
      if (cfg.topologyMode === "fixed") return { topology: "single", trace: "fixed" }
      const allowed = cfg.allowedTopologies.filter((t) => t in TOPOLOGY_CATALOG)
      if (allowed.length <= 1)
        return { topology: resolveTopology(allowed[0]), trace: "only one allowed" }
      const heuristic = await bayesianTopologyDistribution(category, load)
      const combined =
        jevProb !== undefined
          ? blendTopologyDistributions(heuristic, jevProb, cfg.topologyWeightJev)
          : heuristic
      // If the blended argmax lands on sequential-chain but the auxiliary-call
      // budget is insufficient, take the next best.
      let greedy = bestTopologyOf(combined)
      if (greedy === "sequential-chain" && cfg.maxTopologyCalls < 2) {
        const rest = { ...combined }
        delete rest["sequential-chain"]
        greedy = bestTopologyOf(rest)
      }
      const explore =
        Math.random() < clamp(cfg.topologyExploreRate, 0, 1)
          ? exploreTopology(greedy, allowed)
          : undefined
      const topology = explore ?? greedy
      const mode = explore ? "explore" : jevProb !== undefined ? "blend" : "heuristic"
      const dist = Object.entries(combined)
        .sort((a, b) => b[1] - a[1])
        .map(([t, v]) => `${t}=${v.toFixed(2)}`)
        .join(" ")
      return { topology, trace: `${mode}(${dist}${explore ? ` -> explore` : ""})` }
    }
    // Decide the adopted topology from Jev's Choice answer.
    // If confidence < 0.7, fall back to the most conservative single (README §4 policy).
    const resolveTopology = (choice: string | undefined): string => {
      if (cfg.topologyMode === "fixed") return "single"
      if (!choice) return "single"
      if (!cfg.allowedTopologies.includes(choice)) return "single"
      // sequential-chain assumes 1 planner call (verifier is shared with autoReview).
      // Fall back if the cost guard is insufficient
      if (choice === "sequential-chain" && cfg.maxTopologyCalls < 2)
        return "single"
      return choice
    }
    // Topology selection (pickTopology). Called after the category is settled.
    //   Greedy: argmax of the blended distribution
    //     = (1 - topologyWeightJev) * task-shape prior (load band + category + D-4
    //       track record) + topologyWeightJev * Jev Choice distribution.
    //     Jev is used only when a key is present and jevMode=auto; otherwise the
    //     task-shape prior stands alone.
    //   Exploration: with probability topologyExploreRate (default 0.1), a random
    //   non-greedy allowed topology is adopted instead, so non-single shapes can
    //   accumulate a track record (track record + D-4 scoring then feeds back
    //   into the prior).
    //   sequential-chain additionally requires maxTopologyCalls >= 2.
    const pickTopology = async (
      text: string,
      category: string | undefined,
      load: TierName | undefined,
    ): Promise<string> => {
      if (cfg.topologyMode === "fixed") return "single"
      const allowed = cfg.allowedTopologies.filter((t) => t in TOPOLOGY_CATALOG)
      if (allowed.length <= 1) return resolveTopology(allowed[0])
      const jev = jevClient()
      let jevProb: Record<string, number> | undefined
      if (jev) {
        const statsSummary = await topologyStatsSummary(category)
        const answers = await jev.ask(
          {
            instruction: text.slice(0, 1000),
            category: category ?? "unknown",
            categoryTopologyStats: statsSummary,
          },
          {
            topology: {
              type: "choice",
              instructions:
                "Choose the orchestration topology for this task. Use the category and past performance stats to decide. Prioritize accuracy and cost-effectiveness based on load and historical performance.",
              criteria: Object.fromEntries(
                allowed.map((t) => [t, TOPOLOGY_CATALOG[t]]),
              ),
            },
          },
        )
        const answer = answers?.topology
        if (answer?.type === "choice") {
          // Record the probability distribution as the topology prior (used for the w1 combination of D-4)
          await recordTopologyPrior(category, answer.probabilities)
          jevProb = jevTopologyDistribution(
            answer.probabilities,
            answer.choice,
          )
          logRoute(
            `TOPOLOGY jev ${answer.choice} (conf ${answer.confidence.toFixed(2)})`,
          )
        } else {
          logRoute("TOPOLOGY jev unavailable -> task-shape prior")
        }
      }
      const { topology, trace } = await selectTopology(category, load, jevProb)
      if (topology !== "single") {
        logRoute(`TOPOLOGY ${topology} ${trace}`)
      } else {
        logRoute(`TOPOLOGY single ${trace}`)
      }
      return topology
    }

    // ------------------------------------------------------------------
    // Human feedback (manual review)
    // ------------------------------------------------------------------
    // Accept 1-5 satisfaction on the response panel and feed it back into
    // the orchestration selection mechanism. Covers quality gaps that HTTP success rate alone cannot measure.
    const feedbackScore = (feedback: Record<string, unknown> | undefined) => {
      const n = num(feedback?.count, 0)
      const raw = num(feedback?.ratingSum, 0)
      if (n <= 0) return 0.5 // no evaluation = neutral
      // Normalize 1..5 to 0..4 and smooth beta-distribution-style (2 pseudo-observations)
      const normalizedSum = (raw - n) / 4
      return (normalizedSum + 1) / (n + 2)
    }

    // ------------------------------------------------------------------
    // Independent-audit auto-review signal (v1.0)
    // ------------------------------------------------------------------
    // The audit model (reviewModel) runs in a separate harness after the
    // response has already been returned; it never sees the generator's
    // internals and never blocks the user-visible answer. Its scores are
    // therefore NOT self-scoring, so with gates they can safely contribute
    // to the quality term of the routing score.
    //
    // Integration design (preserving the 0.65 machine / 0.35 human split):
    //   quality = (1 - w) * humanScore + w * autoScore     (0 <= w <= 1)
    //   score   = 0.65 * machineRate + 0.35 * quality - costPenalties
    // Gates:
    //   1. Sample gate: autoReviewWeight == 0 (default) keeps legacy shadow
    //      behavior. With w > 0, autoScore is neutral (0.5) until the model
    //      has >= AUTO_REVIEW_MIN_SAMPLES reviews, so a few early scores
    //      cannot move routing. Beta smoothing shrinks toward 0.5 anyway.
    //   2. Quality axes only: instruction / accuracy / completeness.
    //      efficiency is cost-perf and already overlaps with cost penalties.
    //   3. Divergence guard: if a reviewer systematically disagrees with
    //      human ratings, its effective weight is halved, never doubled.
    const AUTO_REVIEW_MIN_SAMPLES = 10
    const autoReviewScore = (auto: unknown): number => {
      if (!auto || typeof auto !== "object") return 0.5
      const a = auto as AutoReviewStat
      const n = num(a.total, 0)
      if (n < AUTO_REVIEW_MIN_SAMPLES) return 0.5
      const sum3 =
        num(a.instruction, 0) + num(a.accuracy, 0) + num(a.completeness, 0)
      const normalizedSum = (sum3 - 3 * n) / 4
      // Same beta smoothing as feedbackScore (2 pseudo-observations) so
      // small-but-passing samples still sit near neutral.
      return (normalizedSum + 1) / (3 * n + 6)
    }
    // Effective weight after divergence guard. Human average is only trusted
    // with enough samples; below that, the guard does not fire.
    const effectiveAutoWeight = (
      auto: AutoReviewStat | undefined,
      feedback: Record<string, unknown> | undefined,
    ): number => {
      const w = cfg.autoReviewWeight
      if (w <= 0 || !auto) return 0
      const autoN = num(auto.total, 0)
      if (autoN < AUTO_REVIEW_MIN_SAMPLES) return 0
      const autoAvg = (auto.instruction + auto.accuracy + auto.completeness) / (autoN * 3)
      const humanN = num(feedback?.count, 0)
      if (humanN < 5) return w
      const humanAvg = num(feedback?.ratingSum, 0) / humanN
      return Math.abs(autoAvg - humanAvg) >= 1.0 ? w / 2 : w
    }

    const recordFeedback = async (
      providerID: string,
      modelID: string,
      category: string | undefined,
      rating: number,
    ) => {
      const existingGlobal = (await loadFeedback(providerID, modelID)) as
        | FeedbackStat
        | undefined
      const global: FeedbackStat = existingGlobal ?? {
        model: { providerID, id: modelID },
        ratingSum: 0,
        count: 0,
        updatedAt: "",
      }
      global.ratingSum += rating
      global.count += 1
      await saveFeedback(global)
      if (category) {
        const existingTask = (await loadTaskFeedback(
          category,
          providerID,
          modelID,
        )) as FeedbackStat | undefined
        const task: FeedbackStat = existingTask ?? {
          model: { providerID, id: modelID },
          ratingSum: 0,
          count: 0,
          updatedAt: "",
          category,
        }
        task.ratingSum += rating
        task.count += 1
        await saveTaskFeedback(task)
      }
    }

    type ReviewTarget = {
      messageID: string
      providerID: string
      modelID: string
      category: string
      assignedAt: string
      instruction: string
      instructionPreview: string
      text: string
      preview: string
      // v1.1.1: the topology actually used for THIS turn (per-turn metadata;
      // falls back to the session's current topology for old turns recorded
      // before per-turn tracking existed).
      topology: string
      // v0.9.0: target turn (0 = latest, 1 = one before, ...). Earlier responses can also be reviewed.
      offset: number
      // v0.9.0: turn stats (tokens/cost/time are persisted on the message, so
      // past turns can be computed after the fact). Turns with no record (e.g. error responses) are omitted.
      turn?: {
        inputTokens: number
        outputTokens: number
        reasoningTokens: number
        cacheRead: number
        cacheWrite: number
        cost: number
        durationMs: number
        tps: number
        finish: string
        createdAt: number
      }
    }

    // v1.1.1 review fix: group the session context into logical TURNS. A turn
    // = one user prompt + the assistant messages that answer it. A tool-using
    // response produces several assistant messages (one per step), so the old
    // message-indexed offset landed on different steps of the SAME turn —
    // adjacent offsets showed the same instruction/category/topology stats
    // ("stuck stats"). Turn targets are the turn's LAST assistant message
    // with text (the completed response body).
    const groupReviewTurns = (
      context: any[],
      messageText: (message: any) => string,
      userTextOf: (message: any) => string,
    ): { instruction: string; assistant: any }[] => {
      const chronological = [...context].sort(
        (a: any, b: any) =>
          num(a?.time?.created, 0) - num(b?.time?.created, 0),
      )
      const turns: { instruction: string; assistants: any[] }[] = []
      let current: { instruction: string; assistants: any[] } | undefined
      for (const message of chronological) {
        if (message?.type === "user") {
          const text = userTextOf(message).trim()
          if (text.length === 0) continue // attachments only, not a new turn
          current = { instruction: text, assistants: [] }
          turns.push(current)
        } else if (message?.type === "assistant" && message?.model) {
          if (!current) {
            current = { instruction: "", assistants: [] }
            turns.push(current)
          }
          current.assistants.push(message)
        }
      }
      // Turn target: the last assistant message with a body; a turn without
      // any body keeps its last assistant message (preview shows "(empty)").
      return turns
        .map((t) => ({
          instruction: t.instruction,
          assistant:
            [...t.assistants]
              .reverse()
              .find((a) => messageText(a).length > 0) ??
            t.assistants[t.assistants.length - 1],
        }))
        .filter((t) => t.assistant !== undefined)
        .reverse() // newest turn first; offset 0 = latest turn
    }

    const getReviewTarget = async (
      sessionID: string,
      offset = 0,
    ): Promise<ReviewTarget | undefined> => {
      let raw: any
      try { raw = await ctx.session.context({ sessionID }) } catch { return undefined }
      const context: any[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.data)
          ? raw.data
          : Array.isArray(raw?.messages)
            ? raw.messages
            : []
      const messageText = (message: any): string =>
        (message?.content ?? [])
          .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
          .map((block: any) => block.text)
          .join("\n")
          .trim() ||
        (typeof message?.text === "string" ? message.text : "")
      const userTextOf = (message: any): string => {
        if (typeof message?.text === "string") return message.text
        if (typeof message?.payload?.text === "string") return message.payload.text
        return (message?.content ?? [])
          .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
          .map((block: any) => block.text)
          .join("\n")
          .trim()
      }
      const turnList = groupReviewTurns(context, messageText, userTextOf)
      const entry = turnList[offset]
      const assistant = entry?.assistant
      if (!assistant) return undefined
      const instruction = entry.instruction ?? ""
      const text = messageText(assistant)
      const assignment = await loadReviewAssignment(sessionID)
      const turnsMeta = await loadReviewTurns(sessionID)
      const messageID = String(assistant.id ?? "")
      const meta = turnsMeta[messageID]
      // v1.1.1: per-turn topology/category. For the latest turn (offset 0) the
      // session maps still hold this turn's values — record them so later
      // offset views (and re-opens after restart) show the values this turn
      // actually used instead of the session's current ones.
      const sessionTopo = sessionTopology.get(sessionID) ?? "single"
      const topology = meta?.topology ?? sessionTopo
      const category =
        meta?.category ?? assignment.category ?? sessionCategory.get(sessionID) ?? ""
      if (offset === 0 && messageID && !meta) {
        void upsertReviewTurn(sessionID, messageID, {
          topology: sessionTopo,
          category:
            assignment.category ?? sessionCategory.get(sessionID) ?? "",
        })
      }
      // v0.9.0: turn stats. Only included when tokens/cost/time are recorded on the message
      // (omitted for error responses, etc.). tps = output tokens ÷
      // (completed - firstToken), the actual streamed duration.
      const tokens = (assistant as any)?.tokens
      const time = (assistant as any)?.time
      const inputTokens = typeof tokens?.input === "number" ? tokens.input : 0
      const outputTokens = typeof tokens?.output === "number" ? tokens.output : 0
      const reasoningTokens =
        typeof tokens?.reasoning === "number" ? tokens.reasoning : 0
      const cacheRead = typeof tokens?.cache?.read === "number" ? tokens.cache.read : 0
      const cacheWrite = typeof tokens?.cache?.write === "number" ? tokens.cache.write : 0
      const cost = typeof (assistant as any)?.cost === "number" ? (assistant as any).cost : 0
      const durationMs =
        typeof time?.firstToken === "number" && typeof time?.completed === "number"
          ? Math.max(time.completed - time.firstToken, 0)
          : 0
      const tps =
        durationMs > 0 && outputTokens > 0
          ? outputTokens / (durationMs / 1000)
          : 0
      const hasTurnStats =
        tokens !== undefined || (assistant as any)?.cost !== undefined
      return {
        messageID,
        providerID: String(assistant.model.providerID ?? ""),
        modelID: String(assistant.model.id ?? ""),
        category,
        assignedAt: assignment.assignedAt ?? "",
        instruction,
        instructionPreview: instruction.slice(0, 160),
        text,
        preview: text.slice(0, 480),
        topology,
        offset,
        ...(hasTurnStats
          ? {
              turn: {
                inputTokens,
                outputTokens,
                reasoningTokens,
                cacheRead,
                cacheWrite,
                cost,
                durationMs,
                tps,
                finish: String((assistant as any)?.finish ?? ""),
                createdAt: typeof time?.created === "number" ? time.created : 0,
              },
            }
          : {}),
      }
    }

    const parseClassifierModel = () => {
      if (!cfg.classifierModel) return undefined
      const slash = cfg.classifierModel.indexOf("/")
      return {
        providerID: cfg.classifierModel.slice(0, slash),
        id: cfg.classifierModel.slice(slash + 1),
      }
    }
    const parseReviewModel = () => {
      if (!cfg.reviewModel) return undefined
      const slash = cfg.reviewModel.indexOf("/")
      return {
        providerID: cfg.reviewModel.slice(0, slash),
        id: cfg.reviewModel.slice(slash + 1),
      }
    }

    // Auxiliary LLM (classification / summary / review): prefer the configured model,
    // automatically falling back to candidates with good observations that are not in quota cooldown.
    // If preferred is given, that model is tried first
    // (use a dedicated model for inner review to avoid same-identity bias with the main response model).
    const auxiliaryCandidates = async (
      preferred?: { providerID: string; id: string },
    ) => {
      const models: { providerID: string; id: string }[] = []
      const seen = new Set<string>()
      const add = (model: { providerID: string; id: string } | undefined) => {
        if (!model) return
        const ref = refFor(model.providerID, model.id)
        if (seen.has(ref) || cool(ref)) return
        seen.add(ref)
        models.push(model)
      }
      add(preferred)
      add(parseClassifierModel())

      const raw = await candidates()
      const scored = await Promise.all(
        raw.map(async (model: any) => {
          const ref = refFor(model.providerID, model.id)
          const stat: any = await loadStat(model.providerID, model.id)
          const n = num(stat?.success, 0) + num(stat?.failure, 0)
          const rate = n > 0 ? (num(stat?.success, 0) + 1) / (n + 2) : 0.5
          const cost = num(model?.cost?.[0]?.output, Infinity)
          return { model, rate, n, cost }
        }),
      )
      scored.sort(
        (a, b) => b.rate - a.rate || a.cost - b.cost || b.n - a.n,
      )
      for (const entry of scored)
        add({
          providerID: entry.model.providerID,
          id: entry.model.id,
        })
      return models.slice(0, 4)
    }

    const generateWithFallback = async (
      promptForModel: (model: { providerID: string; id: string }) => string,
      preferred?: { providerID: string; id: string },
    ): Promise<{ text: string; model: string } | undefined> => {
      const models = await auxiliaryCandidates(preferred)
      for (const model of models) {
        const ref = refFor(model.providerID, model.id)
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("auxiliary generation timeout")),
            12_000,
          ),
        )
        try {
          const result: any = await Promise.race([
            ctx.experimental.generate.text({
              model,
              prompt: promptForModel(model),
            }),
            timeout,
          ])
          const text = String(result?.text ?? "").trim()
          if (!text) continue
          logRoute(`AUX ok ${ref}`)
          return { text, model: ref }
        } catch (error) {
          logRoute(`AUX fallback ${ref}: ${String(error).slice(0, 80)}`)
        }
      }
      return undefined
    }

    const summarizeAssistant = async (
      instruction: string,
      text: string,
    ): Promise<string> => {
      const compact = (value: string, max: number) =>
        value.replace(/\s+/g, " ").trim().slice(0, max)
      const fallback = (): string => {
        const instructionLine =
          compact(instruction, 90) ||
          tr("(指示文を取得できませんでした)", "(could not read the instruction)")
        const resultLines = text
          .replace(/\s+/g, " ")
          .trim()
          .split(/(?<=[。！？.!?])\s*|[\n;]+/u)
          .map((line) => line.trim())
          .filter(Boolean)
        const result = compact(resultLines.slice(-2).join(" ") || text, 120)
        return [
          tr(`指示: ${instructionLine}`, `Instruction: ${instructionLine}`),
          tr(`実施: ${result}`, `Work: ${result}`),
          tr(`成果: ${result}`, `Outcome: ${result}`),
        ].join("\n")
      }
      if (text.length === 0) return fallback()
      const prompt = [
        tr(
          "以下はユーザー指示とアシスタントの応答です。",
          "Below are the user instruction and the assistant response.",
        ),
        tr(
          "ユーザーには、次の3行の日本語だけを返してください。",
          "Return exactly three English lines to the user.",
        ),
        tr(
          "1行目: 指示: 何を依頼されたか",
          "Line 1: Instruction: what was requested",
        ),
        tr(
          "2行目: 実施: どのような作業をしたか",
          "Line 2: Work: what was actually done",
        ),
        tr(
          "3行目: 成果: 何を達成・改善したか",
          "Line 3: Outcome: what was achieved or improved",
        ),
        tr(
          "箇条書き記号、見出し、余分な前置きは禁止です。各行を簡潔にしてください。",
          "No bullet symbols, headings, or extra preamble. Keep each line concise.",
        ),
        "Original user instruction:",
        instruction.slice(0, 4_000),
        "Assistant result:",
        text.slice(0, 4_000),
      ].join("\n")
      const result = await generateWithFallback(() => prompt)
      if (!result) return fallback()
      const lines = result.text
        .split("\n")
        .map((line) => line.trim().replace(/^(?:[-*•]|\d+\.)\s*/, ""))
        .filter(Boolean)
        .slice(0, 3)
      return lines.length === 3 ? lines.join("\n") : fallback()
    }

    // Also provide a local classifier when the LLM is unavailable (to avoid unclassified requests piling up).
    // Without clear lexical signals, do not guess — leave it "unclassified".
    const keywordCategory = (text: string): string | undefined => {
      const lower = text.toLowerCase()
      const patterns: [string, RegExp[]][] = [
        ["debugging", [/エラー|バグ|障害|例外|crash|exception|fix/i, /修正|直して|原因/i]],
        ["coding", [/実装|コード|プログラム|関数|クラス|implement|code|function|class/i]],
        ["review", [/レビュー|検証|確認|監査|review|verify|check/i]],
        ["writing", [/文章|ドキュメント|README|記事|文書|document|writing/i]],
        ["ops", [/シェル|コマンド|環境|ビルド|デプロイ|実行|shell|command|environment|build|deploy/i]],
        ["research", [/調査|質問|説明|調べ|なぜ|どう|research|question|explain/i]],
      ]
      const scored = patterns.map(([category, groups]) => {
        let score = 0
        for (const group of groups) if (group.test(lower)) score += 1
        return { category, score }
      })
      const best = scored.sort((a, b) => b.score - a.score)[0]
      return best && best.score > 0 ? best.category : undefined
    }

    // Contrastive definitions of categories passed to Jev's Choice
    const CATEGORY_CRITERIA: Record<string, string> = {
      coding: "write, modify, or create code/files",
      debugging: "fix errors, bugs, or failing tests",
      review: "review or verify existing code/output",
      research: "question, explanation, or investigation",
      writing: "write or edit documents/prose",
      ops: "shell, environment, build, or deploy tasks",
    }
    const classify = async (sessionID: string, text: string): Promise<void> => {
      let category: string | undefined
      // New turn: discard the previous turn's plan (keep the chain execution framework per turn)
      chainPlans.delete(sessionID)
      // New turn: also discard the previous turn's load band (v0.8 tier routing.
      // Lets the "set if unset" decision in the LLM/heuristic paths work correctly)
      sessionLoad.delete(sessionID)
      // New turn: also discard the previous turn's effort hint (v1.1 variant
      // auto-selection). Set again below from Jev/LLM/heuristic.
      sessionEffort.delete(sessionID)

      // --- Jev path (highest priority when an API key exists and jevMode=auto) ---
      // Classify the category with Choice (confidence < 0.5 -> fall back to the legacy path).
      // Topology selection runs in a separate request via pickTopology() after the category is settled
      // (so the state can carry the category and the summary of past records).
      const jev = jevClient()
      let effortHint: number | undefined
      if (jev) {
        const answers = await jev.ask(text.slice(0, 1000), {
          category: {
            type: "choice",
            instructions:
              "Classify the user request into exactly one task category.",
            criteria: CATEGORY_CRITERIA,
          },
          // Tier routing (v0.8): also judge the load in the same round trip as classification
          // (no extra API call). difficulty is 0-100.
          difficulty: {
            type: "score",
            instructions:
              "Estimate the cognitive and execution load of this request (0-100).",
            criteria: [
              "0-25 = trivial: quick question, rename, typo fix, tiny edit",
              "26-50 = light: single-file change, simple explanation, small script",
              "51-75 = middle: multi-step implementation, debugging across a few files, detailed writing",
              "76-100 = heavy: architecture design, large refactor, multi-file feature, deep research",
            ],
          },
          // v1.1: reasoning-effort hint in the same round trip (no extra call).
          // Consumed by the variant auto-selection in the resolve hook.
          effort: {
            type: "choice",
            instructions:
              "Pick the reasoning effort (thinking depth) this request needs, weighing the risk of a wrong or shallow answer against wasted tokens.",
            criteria: {
              low: "quick lookup, simple edit, formatting, trivial fix — deep thinking would be wasted",
              medium: "ordinary implementation, debugging, explanation — some reasoning pays off",
              high: "hard design, large refactor, subtle bug, deep research — a shallow answer is risky",
            },
          },
        })
        const catAnswer = answers?.category
        // Load estimation is adopted independently of classification (Jev score trustworthiness is not the selector.
        // The score itself is a continuous 0-100 value, assumed always more accurate than the heuristic)
        const diffAnswer = answers?.difficulty
        if (diffAnswer?.type === "score" && typeof diffAnswer.score === "number") {
          setSessionLoad(
            sessionID,
            loadFromScore(diffAnswer.score),
            "jev",
            diffAnswer.score,
          )
        }
        const effAnswer = answers?.effort
        if (effAnswer?.type === "choice") {
          const level = { low: 0, medium: 1, high: 2 }[effAnswer.choice]
          if (level !== undefined) {
            effortHint = level
            logRoute(
              `EFFORT hint ${effAnswer.choice} via jev (conf ${effAnswer.confidence?.toFixed?.(2) ?? "?"})`,
            )
          }
        }
        if (
          catAnswer?.type === "choice" &&
          catAnswer.confidence >= 0.5 &&
          categories.includes(catAnswer.choice)
        ) {
          category = catAnswer.choice
          logRoute(
            `CLASSIFY jev ${category} (conf ${catAnswer.confidence.toFixed(2)})`,
          )
        } else if (catAnswer?.type === "choice") {
          logRoute(
            `CLASSIFY jev low conf ${catAnswer.confidence.toFixed(2)} -> fallback`,
          )
        }
      }

      // --- Legacy path (LLM -> keyword estimation). Skipped when Jev succeeds ---
      if (!category) {
        const prompt = [
          "Classify the following user request into exactly one category.",
          `Categories: ${categories.join(", ")}`,
          "coding = write or modify code, debugging = fix errors or bugs,",
          "review = review or verify, research = question / explain / search,",
          "writing = documents or prose, ops = shell / environment / execution.",
          "Also estimate the cognitive and execution load (difficulty 0-100):",
          "0-25 trivial / 26-50 light / 51-75 middle / 76-100 heavy,",
          "and the reasoning effort the answer needs (effort low/medium/high).",
          'Respond with JSON only: {"category":"<name>","difficulty":<0-100>,"effort":"<low|medium|high>"}',
          "---",
          text.slice(0, 600),
        ].join("\n")
        const result = await generateWithFallback(() => prompt)
        const match = /"category"\s*:\s*"([a-z-]+)"/i.exec(result?.text ?? "")
        const llmCategory = match?.[1]?.toLowerCase()
        category =
          llmCategory && categories.includes(llmCategory)
            ? llmCategory
            : keywordCategory(text)
        // The LLM path can also produce the load. difficulty absent/out of range -> heuristic
        const diffMatch = /"difficulty"\s*:\s*([0-9.]+)/i.exec(
          result?.text ?? "",
        )
        const diffRaw = diffMatch ? Number(diffMatch[1]) : NaN
        if (
          !sessionLoad.has(sessionID) &&
          Number.isFinite(diffRaw) &&
          diffRaw >= 0 &&
          diffRaw <= 100
        ) {
          setSessionLoad(sessionID, loadFromScore(diffRaw), "llm", diffRaw)
        }
        // v1.1: effort hint from the same LLM call (no extra round trip)
        if (effortHint === undefined) {
          const effMatch = /"effort"\s*:\s*"(low|medium|high)"/i.exec(
            result?.text ?? "",
          )
          if (effMatch) {
            effortHint = { low: 0, medium: 1, high: 2 }[
              effMatch[1].toLowerCase() as "low" | "medium" | "high"
            ]
            logRoute(`EFFORT hint ${effMatch[1]} via llm`)
          }
        }
        if (category && categories.includes(category) && !llmCategory) {
          logRoute(`CLASSIFY keyword ${category}`)
        }
      }

      // Final fallback: heuristic when neither Jev nor the LLM produced a load.
      // Even with tierMode=off, the estimate itself is recorded (for display and later stats)
      if (!sessionLoad.has(sessionID)) {
        setSessionLoad(
          sessionID,
          heuristicLoad(text, category),
          "heuristic",
        )
      }
      // v1.1: effort hint for the variant auto-selection. Explicit Jev/LLM
      // answer wins; otherwise derive from the load band as before.
      sessionEffort.set(
        sessionID,
        effortHint ?? variantBandLevel(sessionLoad.get(sessionID) ?? "middle"),
      )
      if (sessionEffort.size > 200) {
        const oldest = sessionEffort.keys().next().value
        if (oldest) sessionEffort.delete(oldest)
      }

      if (category && categories.includes(category)) {
        sessionCategory.set(sessionID, category)
        void saveReviewAssignment(sessionID, category)
        // Simple cap to avoid unbounded growth
        if (sessionCategory.size > 200) {
          const oldest = sessionCategory.keys().next().value
          if (oldest) sessionCategory.delete(oldest)
        }
      } else {
        console.log(
          "[adaptive-fusion] classify failed: no classifier response or category",
        )
      }

      const resolvedTopology = await pickTopology(
        text,
        category,
        sessionLoad.get(sessionID),
      )
      sessionTopology.set(sessionID, resolvedTopology)
      if (sessionTopology.size > 200) {
        const oldest = sessionTopology.keys().next().value
        if (oldest) sessionTopology.delete(oldest)
      }
      // sequential-chain の補助実行(v0.7a 完全版)。admission 時に pending を積み、
      // 実行は主モデル dispatch 直前の context フックで行う。
      if (
        resolvedTopology === "sequential-chain" &&
        cfg.chainMode === "active" &&
        cfg.maxTopologyCalls >= 2
      ) {
        chainPending.set(sessionID, { category, text })
      } else {
        chainPending.delete(sessionID)
      }
      if (resolvedTopology !== "single") {
        logRoute(
          resolvedTopology === "sequential-chain"
            ? chainPending.has(sessionID)
              ? "TOPOLOGY sequential-chain (planner pending, chainMode=active)"
              : "TOPOLOGY sequential-chain (record only: chainMode=off or cost guard)"
            : `TOPOLOGY ${resolvedTopology}`,
        )
      }
    }

    // ------------------------------------------------------------------
    // Admission handling: pre-rescue
    // ------------------------------------------------------------------
    // If the model is cooling down (recently "unavailable"), do not only swap via the resolve hook;
    // instead, directly switch the session's own model to a healthy candidate.
    // This also activates the provider and avoids the case where a resolve swap
    // becomes ModelUnavailableError.
    // Returns whether the session model was actually switched (for the
    // caller's rescue bookkeeping: suppression of duplicate switches).
    const switchSessionIfCooling = async (
      sessionID: string,
      category?: string,
    ): Promise<boolean> => {
      // v1.0: OFF stops all behavior (double safety: every caller is gated,
      // this guard keeps future call sites safe too).
      if (!cfg.enabled) return false
      try {
        const session: any = await ctx.session.get({ sessionID })
        let model = session?.model
        let currentRef =
          model?.providerID && model?.id
            ? refFor(model.providerID, model.id)
            : undefined
        if (!model?.providerID || !model?.id) {
          // Unswitched sessions (e.g. new session default model)
          // have no session.model set. Fall back to the actually dispatched model
          // recorded by resolve (lastResolved) (v0.8.1). If that is also missing, no recovery is possible.
          const hint = lastResolved.get(sessionID)
          if (hint?.providerID && hint?.id) {
            logRoute(`PRE hint ${hint.providerID}/${hint.id} (session model unset)`)
            model = hint
            currentRef = refFor(model.providerID, model.id)
          }
        }
        // rescue restore: when this session was moved to another model via rescue
        // and that model's cooldown has since lifted, automatically
        // switch back to the original model on the next prompt
        if (currentRef) {
          const restored = maybeRestoreFromRescue(sessionID)
          if (restored && restored.ref !== currentRef) {
            try {
              await ctx.session.switchModel({
                sessionID,
                model: { providerID: restored.providerID, id: restored.id },
              })
              rescueAttempts.delete(sessionID)
              rescueTombstones.set(sessionID, Date.now())
              void persistRescue()
              return true
            } catch (error) {
              logRoute(`RESCUE restore failed ${sessionID}: ${error}`)
            }
          }
        }
        if (!model?.providerID || !model?.id) {
          logRoute(`PRE skip (session model unreadable, no resolve hint)`)
          return false
        }
        if (!cool(currentRef!)) {
          // Even if the current model is healthy, the rescue-restore pending entry
          // is kept until it expires (24h) (to detect recovery of the original model)
          logRoute(`PRE alive ${currentRef} (no rescue needed)`)
          return false
        }

        const choice = await pick(currentRef!, category, true, sessionID)
        if (!choice) {
          logRoute(`KEEP pre-prompt ${currentRef} (no rescue candidate)`)
          return false
        }
        const next = { providerID: choice.providerID, id: choice.id }
        rescueAttempts.set(sessionID, {
          originalRef: currentRef!,
          deadline: Date.now() + RESCUE_WINDOW_MS,
        })
        void persistRescue()
        await ctx.session.switchModel({ sessionID, model: next })
        logRoute(
          `SWITCH pre-prompt ${currentRef} -> ${next.providerID}/${next.id} (${choice.reason})`,
        )
        return true
      } catch (error) {
        logRoute(`PRE error: ${String(error).slice(0, 80)}`)
        console.log(`[adaptive-fusion] pre-prompt rescue failed: ${error}`)
        return false
      }
    }

    // v1.2.1: best-score pick inside a pre-narrowed pool (chain promotion).
    // Same scoring as pick()'s non-rescue path but restricted to `pool` —
    // no exploration (a promotion is an ordered move, not a random trial).
    const pickBestInPool = async (
      pool: any[],
      category?: string,
    ): Promise<{ providerID: string; id: string; reason: string } | undefined> => {
      const maxCost = Math.max(...pool.map((m) => routingCostOf(m))) || 1
      const benchmarks = currentBenchmarks()
      const benchK = benchmarkPriorK(benchmarks)
      let best: { ref: string; providerID: string; id: string; score: number } | undefined
      for (const model of pool) {
        const ref = refFor(model.providerID, model.id)
        if (cool(ref)) continue
        const benchmark = benchmarkFor(benchmarks, ref, category)
        const global = await loadStat(model.providerID, model.id)
        const n = global ? global.success + global.failure : 0
        const feedback = await loadFeedback(model.providerID, model.id)
        const auto = await loadAutoReview(model.providerID, model.id)
        const stat =
          global && n > 0
            ? global
            : // unobserved: neutral machine score blended with the benchmark prior
              ({
                success: 0,
                failure: 0,
                totalMs: 0,
              } as Stat)
        const score = statScore(
          stat,
          feedback,
          routingCostOf(model) / maxCost,
          benchmark,
          benchK,
          auto,
        )
        if (!best || score > best.score)
          best = { ref, providerID: model.providerID, id: model.id, score }
      }
      return best
        ? {
            providerID: best.providerID,
            id: best.id,
            reason: `score=${best.score.toFixed(3)}`,
          }
        : undefined
    }

    // v1.2.1: chain promotion. When routing is ON and chainPromote is set, a
    // session whose current provider sits at a LOWER chain priority than the
    // highest healthy chain entry is switched to that entry once, at prompt
    // time (not per dispatch — a per-dispatch rewrite would ping-pong
    // providers and break caches). Candidate selection within the target
    // entry reuses pick() with rescue=false so the usual score/warmup logic
    // picks the model; the switch records a restore ticket only when moving
    // DOWN was possible (i.e. the current model's provider is itself a chain
    // entry — otherwise there is nothing to restore back to).
    // Returns whether the session model was switched.
    const promoteSessionChain = async (
      sessionID: string,
      category?: string,
    ): Promise<boolean> => {
      if (!cfg.enabled || !cfg.chainPromote) return false
      if (cfg.providerChain.length < 2) return false
      try {
        const session: any = await ctx.session.get({ sessionID })
        let model = session?.model
        if (!model?.providerID || !model?.id) {
          const hint = lastResolved.get(sessionID)
          if (hint?.providerID && hint?.id) model = hint
        }
        if (!model?.providerID || !model?.id) return false
        const currentProvider = model.providerID
        const currentRef = refFor(model.providerID, model.id)
        const currentIdx = cfg.providerChain.indexOf(currentProvider)
        // Sessions on providers outside the chain are left alone (the chain
        // governs fallback order between its own entries; a user's explicit
        // non-chain provider choice is respected).
        if (currentIdx <= 0) return false
        // The resolve hook's normal routing handles same-provider swaps; the
        // promotion only moves the session UP the chain.
        const models = await candidates()
        const chainIdx = firstHealthyChainIndex(
          models,
          cfg.providerChain,
          (m) => !cool(refFor(m.providerID, m.id)),
        )
        // Nothing above the current entry is healthy (or the current entry
        // is already the highest healthy one).
        if (chainIdx < 0 || chainIdx >= currentIdx) return false
        const pid = cfg.providerChain[chainIdx]
        const pool = models.filter((m: any) => m.providerID === pid)
        // Pick the best model within the target entry (score/warmup logic,
        // excluding the current model like a rescue would — the goal is a
        // different provider).
        let chosen: { providerID: string; id: string; reason: string } | undefined
        const subset = pool.filter(
          (m: any) => refFor(m.providerID, m.id) !== currentRef,
        )
        if (subset.length === 0) return false
        // Simple best-score pick within the entry (reuses statScore via pick
        // is provider-scoped to the whole pool; here we narrow manually).
        chosen = await pickBestInPool(subset, category)
        if (!chosen) return false
        await ctx.session.switchModel({
          sessionID,
          model: { providerID: chosen.providerID, id: chosen.id },
        })
        // Record the restore ticket: if the higher entry later dies, rescue
        // restore can bring the session back to the previous entry.
        rescueAttempts.set(sessionID, {
          originalRef: currentRef,
          deadline: Date.now() + RESCUE_WINDOW_MS,
        })
        void persistRescue()
        logRoute(
          `PROMOTE ${sessionID} ${currentRef} -> ${chosen.providerID}/${chosen.id} (chain[${chainIdx}] ${pid} > chain[${currentIdx}] ${currentProvider}, ${chosen.reason})`,
        )
        return true
      } catch (error) {
        logRoute(`PROMOTE error: ${String(error).slice(0, 80)}`)
        return false
      }
    }

    // Consolidate admission-time handling into a single hook (v0.8 audit fix):
    // 1) classify (category/topology/load band) -> 2) pre-rescue.
    // Splitting them makes execution order across hooks depend on the runtime implementation,
    // so rescue might use the previous turn's category/load band — hence the explicit order.
    await ctx.session.hook("prompt", async (event) => {
      // TUI toggle durable fix (v0.8.1): reload the settings persisted by the TUI-side plugin
      // instance into the server side at the start of a turn (which always runs). Only effective
      // if storage is shared between both instances (if not shared, changed=false, no harm).
      try {
        if (applyPersistedConfig(await ctx.storage.get(CONFIG_KEY)))
          logRoute(`CONFIG synced from storage (enabled=${cfg.enabled})`)
      } catch {
        // Resync failure does not block normal processing
      }
      // v1.0: benchmark auto-refresh (toggle-ON gated, at most once per day).
      // Fire-and-forget: it never blocks the prompt; failures only mark the
      // check marker and keep the previous snapshot.
      if (cfg.enabled) void maybeAutoUpdateBenchmarks()
      // v1.0: OFF stops the ACTIVE behavior only — no model switching at all
      // (pre-rescue and rescue-restore are self-guarded in switchSessionIfCooling).
      // Classification keeps running: it is passive learning (per-category stats),
      // makes no model switches, and keeps the observations usable the moment
      // routing is re-enabled.
      try {
        await classify(event.sessionID, event.prompt.text)
      } catch (error) {
        // Classification failure does not block normal processing (continue unclassified)
        logRoute(`CLASSIFY error: ${String(error).slice(0, 80)}`)
      }
      // v1.2.1: chain promotion first — a healthy higher chain entry takes
      // the session before (and instead of) rescue checks: if the current
      // model is cooling, the pre-prompt rescue below would handle it with
      // the chain priority anyway; if it is healthy, the promotion moves the
      // session up the chain as configured.
      try {
        if (await promoteSessionChain(
          event.sessionID,
          sessionCategory.get(event.sessionID) ?? undefined,
        ))
          return // promoted this prompt; skip the rescue pass
      } catch {
        // Promotion failure does not block normal processing
      }
      try {
        await switchSessionIfCooling(
          event.sessionID,
          sessionCategory.get(event.sessionID) ?? undefined,
        )
      } catch {
        // Pre-rescue failure does not block normal processing (double safety net; also caught internally)
      }
    })

    // ------------------------------------------------------------------
    // Auxiliary execution of sequential-chain (full v0.7a, context hook verified with P0 probes)
    // ------------------------------------------------------------------
    // Only turns where chain was selected at admission get pushed into chainPending; the planner
    // runs just before the main model dispatch, and the plan is injected into the system prompt as "reference".
    // Injection affects only the single outgoing call; it does not touch history/settings (per the official spec).
    // For tool-continuation dispatches, the same turn's plan is re-injected and reused.
    // On failure/timeout, no injection happens and it continues as single (degraded operation).
    const PLANNER_TIMEOUT_MS = 8_000
    const chainPending = new Map<string, { category?: string; text: string }>()
    const chainPlans = new Map<string, { plan: string; at: number }>()

    const runPlanner = async (
      text: string,
    ): Promise<{ plan: string; model: string; ms: number } | undefined> => {
      const prompt = [
        tr(
          "以下の指示を達成するための手順を3〜5行で列挙してください。",
          "List the steps needed to accomplish the instruction below in 3 to 5 lines.",
        ),
        tr(
          "工程の順序依存と検証方法を明示してください。",
          "Make ordering dependencies and the verification method explicit.",
        ),
        tr(
          "前置き・見出し・整形は不要で、手順の行だけを返してください。",
          "No preamble, headings, or formatting — return only the step lines.",
        ),
        "---",
        text.slice(0, 1_000),
      ].join("\n")
      const started = performance.now()
      const result = await Promise.race([
        generateWithFallback(() => prompt),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), PLANNER_TIMEOUT_MS),
        ),
      ])
      const ms = performance.now() - started
      const plan = String(result?.text ?? "")
        .split("\n")
        .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, ""))
        .filter(Boolean)
        .slice(0, 8)
        .join("\n")
        .slice(0, 1_200)
      if (plan.length < 10) return undefined
      return { plan, model: String(result?.model ?? ""), ms }
    }

    const chainPlanSystemText = (plan: string) =>
      [
        "【オーケストレーション補助: 実行計画(参考)】",
        "以下は補助モデルが作成した手順案です。拘束ではなく参考として扱い、",
        "手順の過不足や誤りはあなたの判断で修正して成果を出してください。",
        "--- 計画 ---",
        plan,
      ].join("\n")

    await ctx.session.hook("context", async (event: any) => {
      try {
        const sessionID = String(event?.sessionID ?? "")
        if (!sessionID) return
        const pending = chainPending.get(sessionID)
        if (pending) {
          chainPending.delete(sessionID)
          const planner = await runPlanner(pending.text)
          if (!planner || !Array.isArray(event?.system)) {
            logRoute("CHAIN planner unavailable -> single (no injection)")
            return
          }
          event.system.push({
            type: "text",
            text: chainPlanSystemText(planner.plan),
          })
          chainPlans.set(sessionID, { plan: planner.plan, at: Date.now() })
          if (chainPlans.size > 200) {
            const oldest = chainPlans.keys().next().value
            if (oldest) chainPlans.delete(oldest)
          }
          await recordTopologyAux(sessionID, planner.ms)
          logRoute(
            `CHAIN plan injected (${Math.round(planner.ms)} ms, ${planner.plan.length} chars, planner ${planner.model || "-"})`,
          )
          return
        }
        // Tool-continuation dispatch within the same turn: re-inject the plan and keep using it.
        // chainPlans is cleared per turn by classify at admission (prompt hook),
        // so an old plan never leaks into the next turn.
        const existing = chainPlans.get(sessionID)
        if (existing && Array.isArray(event?.system)) {
          event.system.push({
            type: "text",
            text: chainPlanSystemText(existing.plan),
          })
        }
      } catch (error) {
        // context hook failure does not block the main response (exception tolerance verified in P0)
        logRoute(`CHAIN context error: ${String(error).slice(0, 80)}`)
      }
    })

    // ------------------------------------------------------------------
    // Metrics collection (measuring the http.request / http.response interval)
    // ------------------------------------------------------------------
    // Keyed by sessionID. Per session, the same kind of requests are expected to run sequentially.
    // To stay provider-agnostic, hooks are registered unscoped,
    // and the callback reads cfg.providerID.
    // ------------------------------------------------------------------
    // Internal review harness (v0.6) — shadow mode
    // ------------------------------------------------------------------
    // Right after http.response(ok=true), review the instruction + response body with a separate model
    // and accumulate into fusion/auto/*. Does not block the user-facing response.
    // Scores are not applied yet at this stage (record-only / display-only).
    const clampScore = (v: unknown): number | undefined => {
      const n = Number(v)
      if (!Number.isFinite(n)) return undefined
      return Math.min(5, Math.max(1, Math.round(n)))
    }

    const runAutoReview = async (sessionID: string): Promise<void> => {
      try {
        const target = await getReviewTarget(sessionID)
        if (!target) return
        if (target.text.length < 120) return // shorter responses are not reviewed
        // v0.9.0: turn stats passed to the cost-performance axis (efficiency).
        // tokens/cost/time are persisted on the message, so they can be referenced.
        const t = target.turn
        const statsLine = t
          ? [
              tr(
                "--- ターン統計(参考) ---",
                "--- turn statistics (reference) ---",
              ),
              tr(
                `モデル: ${target.providerID}/${target.modelID} / 入力 ${t.inputTokens} tok (cache読み ${t.cacheRead}) / 出力 ${t.outputTokens} tok / 実測 ${(t.durationMs / 1000).toFixed(1)}s / ${t.tps > 0 ? t.tps.toFixed(1) + " tok/s" : "速度不明"} / コスト $${t.cost.toFixed(6)}`,
                `model: ${target.providerID}/${target.modelID} / input ${t.inputTokens} tok (cache read ${t.cacheRead}) / output ${t.outputTokens} tok / measured ${(t.durationMs / 1000).toFixed(1)}s / ${t.tps > 0 ? t.tps.toFixed(1) + " tok/s" : "throughput unknown"} / cost $${t.cost.toFixed(6)}`,
              ),
            ]
          : []
        const prompt = [
          tr(
            "以下はユーザー指示とアシスタント応答のペアを評価してください。",
            "Evaluate the following user-instruction / assistant-response pair.",
          ),
          tr(
            "4つの軸を1〜5の整数で採点します。",
            "Score four axes as integers from 1 to 5.",
          ),
          tr(
            "instruction = 依頼を正しく理解し意図に応えたか(5=完全に応えた / 3=部分的 / 1=答えず)",
            "instruction = understood the request and served its intent (5 = fully met / 3 = partial / 1 = did not answer)",
          ),
          tr(
            "accuracy = 内容は正確か(5=正確かつ根拠あり / 3=概ね正しいが要修正 / 1=誤りが多い)",
            "accuracy = is the content correct (5 = correct with evidence / 3 = mostly right but needs fixes / 1 = many errors)",
          ),
          tr(
            "completeness = 必要な作業をやり切ったか(5=完遂 / 3=途中まで / 1=未着手)",
            "completeness = finished the required work (5 = complete / 3 = partial / 1 = not started)",
          ),
          tr(
            "efficiency = コストパフォーマンス(消費トークン・時間に対する成果)(5=最小の労力で完遂 / 3=やや冗長または低速 / 1=資源を浪費した割に成果が薄い)",
            "efficiency = cost-performance (outcome per token and per second) (5 = done with minimal effort / 3 = somewhat verbose or slow / 1 = wasted resources with little outcome)",
          ),
          tr("reason は日本語で1行。", "Write reason as a single English line."),
          tr(
            'results は「応答が実際に成し遂げた実績」を列挙してください(日本語、各項目1行)。具体的な証拠ベースで: 作成・変更したファイル、実行したコマンド、提示した回答・数値など。抽象的な感想(丁寧だった等)は実績に含めない。実績を確認できない場合は ["実績なし"] のみ。',
            'results must enumerate what the response actually accomplished (English, one item per line), evidence-based: files created or changed, commands executed, answers and values given. Do not include vague impressions (such as "was polite"). If nothing can be verified, use ["no verified results"] only.',
          ),
          'Return JSON only: {"instruction":n,"accuracy":n,"completeness":n,"efficiency":n,"results":["..."],"reason":"..."}',
          tr("--- ユーザー指示 ---", "--- user instruction ---"),
          target.instruction.slice(0, 4_000),
          tr("--- アシスタント応答 ---", "--- assistant response ---"),
          target.text.slice(0, 4_000),
          ...statsLine,
        ].join("\n")

        const result = await generateWithFallback(() => prompt, parseReviewModel())
        if (!result) {
          logRoute("AUTO review skip (no reviewer available)")
          await recordAutoSkip("no reviewer available", "(none)")
          return
        }
        // Parse the review output. JSON -> labeled lines -> independent integers, 3-stage fallback.
        const parseAxis = (re: RegExp): number | undefined => {
          const m = re.exec(result.text)
          if (!m) return undefined
          const n = Number(m[1])
          return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined
        }
        // v0.9.0: extract the non-empty JSON portion. To avoid dropping new-format JSON
        // (multi-line, symbols inside strings, containing a results array),
        // find the "{" before the position of "instruction" and track parentheses with a counter
        // through the matching "}". Also works unchanged for the old format (3 axes only).
        const extractJson = (text: string): string | undefined => {
          const keyAt = text.indexOf('"instruction"')
          if (keyAt < 0) return undefined
          const start = text.lastIndexOf("{", keyAt)
          if (start < 0) return undefined
          let depth = 0
          let inString = false
          let escaped = false
          for (let i = start; i < text.length; i++) {
            const ch = text[i]
            if (inString) {
              if (escaped) escaped = false
              else if (ch === "\\") escaped = true
              else if (ch === '"') inString = false
              continue
            }
            if (ch === '"') inString = true
            else if (ch === "{") depth++
            else if (ch === "}") {
              depth--
              if (depth === 0) return text.slice(start, i + 1)
            }
          }
          return undefined
        }
        let instruction: number | undefined
        let accuracy: number | undefined
        let completeness: number | undefined
        let efficiency: number | undefined
        let results: string[] = []
        let reasonText = ""
        let hadJson = false
        {
          const jsonMatch = extractJson(result.text)
          let parsed: Record<string, unknown> | undefined
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch)
              hadJson = parsed !== undefined && parsed !== null
            } catch {
              parsed = undefined
            }
          }
          if (parsed) {
            instruction = clampScore(parsed.instruction)
            accuracy = clampScore(parsed.accuracy)
            completeness = clampScore(parsed.completeness)
            // v0.9.0: efficiency is an optional axis (absent in old reviewer model output).
            // The review itself is still valid when it is missing (backward compatible).
            efficiency = clampScore(parsed.efficiency)
            const rawResults = parsed.results
            if (Array.isArray(rawResults))
              results = rawResults
                .map((item) => String(item ?? "").trim())
                .filter((item) => item.length > 0)
                .slice(0, 5)
            reasonText = String(parsed.reason ?? "")
          } else {
            // Line parsing (A-2): when no JSON is available, look for label + number / Japanese labels
            instruction = parseAxis(/instruction[^\d]{0,40}([1-5])/i) ??
              parseAxis(/指示[^\d]{0,40}([1-5])/)
            accuracy = parseAxis(/accuracy[^\d]{0,40}([1-5])/i) ??
              parseAxis(/正確[^\d]{0,40}([1-5])/)
            completeness = parseAxis(/completeness[^\d]{0,40}([1-5])/i) ??
              parseAxis(/完了|完遂[^\d]{0,40}([1-5])/)
            // v0.9.0: also pick up efficiency via line parsing (continue even if missing)
            efficiency = parseAxis(/efficiency[^\d]{0,40}([1-5])/i) ??
              parseAxis(/効率|コスパ[^\d]{0,40}([1-5])/)
            // If still missing, assign the standalone 1-5 integers in the text to axes in order
            if (
              instruction === undefined ||
              accuracy === undefined ||
              completeness === undefined
            ) {
              const ints = [
                ...result.text.matchAll(/(?<!\d)([1-5])(?!\d)/g),
              ].map((m) => Number(m[1]))
              if (ints.length >= 3) {
                instruction ??= ints[0]
                accuracy ??= ints[1]
                completeness ??= ints[2]
                if (efficiency === undefined && ints.length >= 4)
                  efficiency = ints[3]
              }
            }
            reasonText = result.text
          }
        }
        if (
          instruction === undefined ||
          accuracy === undefined ||
          completeness === undefined
        ) {
          const why = hadJson ? "invalid axis values" : "unparseable output"
          logRoute(`AUTO review skip (${why})`)
          await recordAutoSkip(why, result.model.slice(0, 100))
          return
        }
        const reason = reasonText
          .trim()
          .split("\n")[0]
          .slice(0, 200)
        const category = sessionCategory.get(sessionID)
        const ref = refFor(target.providerID, target.modelID)
        const persist = async (existing?: AutoReviewStat): Promise<AutoReviewStat> => {
          const stat: AutoReviewStat = existing ?? {
            model: { providerID: target.providerID, id: target.modelID },
            total: 0,
            lastAt: 0,
            instruction: 0,
            accuracy: 0,
            completeness: 0,
            efficiency: 0,
            efficiencyCount: 0,
            results: [],
            reasons: [],
            updatedAt: new Date().toISOString(),
          }
          stat.total += 1
          stat.lastAt = Date.now()
          stat.instruction += instruction
          stat.accuracy += accuracy
          stat.completeness += completeness
          // v0.9.0: efficiency is added only for reviews that output it (count is tracked separately).
          // Old data (efficiencyCount undefined) is treated as 0 for backward compatibility.
          if (efficiency !== undefined) {
            stat.efficiency = (stat.efficiency ?? 0) + efficiency
            stat.efficiencyCount = (stat.efficiencyCount ?? 0) + 1
          }
          // v0.9.0: the results enumeration replaces with the latest review (max 5 entries)
          if (results.length > 0) stat.results = results
          stat.reviewerRef = result.model
          stat.reasons.push(
            `${new Date().toISOString().slice(5, 16).replace("T", " ")} ${reason}`,
          )
          if (stat.reasons.length > 5) stat.reasons.shift()
          if (category) stat.category = category
          return stat
        }
        const globalExisting = (await loadAutoReview(
          target.providerID,
          target.modelID,
        )) as AutoReviewStat | undefined
        await saveAutoReview(await persist(globalExisting))
        if (category) {
          const taskExisting = (await loadTaskAutoReview(
            category,
            target.providerID,
            target.modelID,
          )) as AutoReviewStat | undefined
          await saveTaskAutoReview(await persist(taskExisting))
        }
        // Also add the quality score to the topology stats (v0.7a, 5-axis -> 3-axis average)
        await recordTopologyQuality(
          sessionID,
          (instruction + accuracy + completeness) / 3,
        )
        logRoute(
          `AUTO review ${ref} i=${instruction} a=${accuracy} c=${completeness}${efficiency !== undefined ? ` e=${efficiency}` : ""} results=${results.length} by ${result.model}`,
        )
      } catch (error) {
        logRoute(`AUTO review error: ${String(error).slice(0, 80)}`)
        await recordAutoSkip(`error: ${String(error).slice(0, 80)}`, "(error)")
      }
    }

    const pending = new Map<
      string,
      { start: number; modelID: string; providerID: string; variant?: string }
    >()
    // Recording the actually dispatched model (v0.8.1).
    // - Unswitched sessions have no session.model, so the observation usable for pre-rescue
    //   and for identifying the culprit of step.failed exists only in pending (HTTP executed only).
    //   The resolve hook always fires per dispatch, so remember
    //   "the model last resolved for this session" here.
    // - This value also identifies the culprit when no HTTP flight happens (billing precheck, etc.).
    const lastResolved = new Map<
      string,
      { providerID: string; id: string }
    >()
    const record = async (
      modelID: string,
      providerID: string,
      category: string | undefined,
      ok: boolean,
      ms: number,
      // force is for compatibility with explicit observations like probes (currently always recorded)
      _force = false,
    ) => {
      // Observations are recorded for all providers:
      // needed to grasp the health of rescue targets and crossProvider candidates.
      // (Stats display is grouped per provider)
      const write = async (stat: Stat, task?: boolean) => {
        if (ok) stat.success += 1
        else stat.failure += 1
        stat.totalMs += ms
        if (task) stat.category = category
        await (task ? saveTaskStat(stat) : saveStat(stat))
      }

      const global = (await loadStat(providerID, modelID)) ?? {
        model: { providerID, id: modelID },
        success: 0,
        failure: 0,
        totalMs: 0,
        updatedAt: "",
      }
      await write(global)

      if (category) {
        const task = (await loadTaskStat(category, providerID, modelID)) ?? {
          model: { providerID, id: modelID },
          success: 0,
          failure: 0,
          totalMs: 0,
          updatedAt: "",
          category,
        }
        await write(task, true)
      }
    }

    await ctx.session.hook("http.request", (event) => {
      if (!kinds.includes(event.kind)) return
      // v1.0: passive observation (learning) keeps running while OFF.
      // Record providers other than the target too (for assessing rescue-target health).
      // crossProvider decisions happen in the resolve hook.
      pending.set(event.sessionID, {
        start: performance.now(),
        modelID: event.model.id,
        providerID: event.model.providerID,
        // v1.1: dispatched variant (for per-(model,variant) outcome learning)
        variant: event.model?.variant,
      })
    })

    await ctx.session.hook("http.response", async (event) => {
      if (!kinds.includes(event.kind)) return
      // v1.0: observation, recovery detection and the shadow review are passive
      // learning and keep running while OFF; the model switches inside are
      // self-guarded in switchSessionIfCooling.
      const observed = pending.get(event.sessionID)
      pending.delete(event.sessionID)
      if (!observed) return

      const ref = refFor(observed.providerID, observed.modelID)
      const ms = performance.now() - observed.start
      const ok = event.response.ok
      const category = sessionCategory.get(event.sessionID)

      if (ok) {
        // Successful observations lift the cooldown (recovery from temporary unavailability).
        // Log only when a lift actually happened (v0.8.1: unrecorded would make
        // "why did the cooldown disappear" impossible to investigate).
        if (clearCooldown(ref))
          logRoute(`RECOVER ok ${ref} (success observation)`)
        await record(observed.modelID, observed.providerID, category, true, ms)
        // v1.1: a success breaks the consecutive-failure run (A1-4) — reset
        // the attempt budget so non-consecutive failures cannot trip the gate.
        resetAttemptFailures(event.sessionID, ref)
        lastHttpFailure.delete(event.sessionID)
        // v1.1: per-(model,variant) outcome learning
        recordVariantOutcome(
          observed.providerID,
          observed.modelID,
          observed.variant,
          true,
          ms,
        )
        void recordTopology(event.sessionID, true, ms)
        // Inner review (shadow): review in the background without blocking the main response
        void runAutoReview(event.sessionID)
        return
      }

      // v1.1: Record this HTTP failure for deduplication against retry.scheduled
      recordHttpFailure(event.sessionID, ref)

      // On failure: free tier / rate limit (quota) is excluded from the quality penalty,
      // and only a long cooldown is applied (do not skew stats success rate)
      const resp: any = event.response
      let respText = ""
      try {
        respText = JSON.stringify(resp)
      } catch {
        respText = ""
      }
      const cls = classifyFailure({
        message: "",
        status: typeof resp?.status === "number" ? resp.status : 0,
        body: respText,
      })
      if (cls === "quota") {
        // Definitive signal: retrying quota errors cannot succeed, so keep the
        // v1.0 immediate cooldown + fallback (not attempt-gated).
        markFailure(ref, "quota")
        // Immediately after a failure, fall back the session model to a healthy candidate (v0.8.1).
        // So OpenCode's retry / the next step / drain resume
        // can use the saved healthy model. Awaited (not void) so a successful
        // switch marks the rescue suppression (A1-8): the following
        // session.step.failed must not switch again.
        if (tryClaimRescue(event.sessionID)) {
          try {
            if (await switchSessionIfCooling(event.sessionID, category))
              markRescueSwitch(event.sessionID, ref)
          } finally {
            releaseRescue(event.sessionID)
          }
        }
        return
      }
      await record(observed.modelID, observed.providerID, category, false, ms)
      recordVariantOutcome(
        observed.providerID,
        observed.modelID,
        observed.variant,
        false,
        ms,
      )
      void recordTopology(event.sessionID, false, ms)
      // v1.1: attempt-aware after-fail rescue. Transient failures wait for the
      // attempt budget (attemptGateOpen logs WAIT while letting retries run);
      // only when the budget is exhausted is the model cooled down and the
      // session moved to a healthy candidate.
      const sid = event.sessionID
      if (!attemptGateOpen(sid, ref)) return
      markFailure(ref, cls)
      if (cfg.enabled && tryClaimRescue(sid)) {
        try {
          const targetRef = ref
          const currentCategory = sessionCategory.get(sid)
          const choice = await pick(targetRef, currentCategory, true, sid)
          if (choice) {
            const nextRef = refFor(choice.providerID, choice.id)
            if (nextRef === targetRef) {
              logRoute(
                `KEEP after-fail ${targetRef} (best candidate is the failed model)`,
              )
            } else {
              try {
                await ctx.session.switchModel({
                  sessionID: sid,
                  model: { providerID: choice.providerID, id: choice.id },
                })
                rescueAttempts.set(sid, {
                  originalRef: targetRef,
                  deadline: Date.now() + RESCUE_WINDOW_MS,
                })
                void persistRescue()
                markRescueSwitch(sid, targetRef)
                logRoute(
                  `SWITCH after-fail ${targetRef} -> ${choice.providerID}/${choice.id} (${choice.reason})`,
                )
              } catch (error) {
                logRoute(
                  `after-fail rescue failed ${sid}: ${String(error).slice(0, 80)}`,
                )
                console.log(`[adaptive-fusion] after-fail rescue failed: ${error}`)
              }
            }
          }
        } finally {
          releaseRescue(sid)
        }
      }
      void switchSessionIfCooling(sid, category)
    })
    // ------------------------------------------------------------------
    // Tier routing (v0.8, Copilot Fusion / HydraFusion style)
    // ------------------------------------------------------------------
    // Narrow the candidate pool into a tier based on task load (Light/Middle/Heavy).
    // Within a tier, the existing statScore+exploration works untouched; the tier just
    // defines "the pool" (an enhanced whitelist). On exhaustion, cascade upward
    // (Light -> Middle -> Heavy); if all tiers are exhausted, degrade to the legacy all-candidate selection.
    // auto mode: trisect the candidates by benchmark overall, descending.
    // Cost caps / whitelist enforcement is handled by pick's candidates(), so
    // this returns only the pure tier set.
    const normRef = (ref: string) => ref.replace(/:free$/, "")

    const autoTiers = (): Record<TierName, string[]> | undefined => {
      const benchmarks = currentBenchmarks()
      const models = benchmarks?.models
      if (!models) return undefined
      const entries: { ref: string; score: number }[] = []
      for (const [ref, entry] of Object.entries(models)) {
        if (typeof entry?.overall === "number")
          entries.push({ ref, score: entry.overall })
      }
      // Auto derivation not possible when the minimum for trisection is not met (undefined)
      if (entries.length < 3) return undefined
      entries.sort((a, b) => b.score - a.score)
      const third = Math.ceil(entries.length / 3)
      return {
        heavy: entries.slice(0, third).map((e) => e.ref),
        middle: entries.slice(third, third * 2).map((e) => e.ref),
        light: entries.slice(third * 2).map((e) => e.ref),
      }
    }

    // The currently effective tier set for tierMode. undefined when unresolvable (equivalent to off)
    const resolveTiers = (): Record<TierName, string[]> | undefined => {
      if (cfg.tierMode === "manual") return cfg.tiers
      if (cfg.tierMode === "auto") return autoTiers()
      return undefined
    }

    // Cascade order for the load band (upward only: Light -> Middle -> Heavy).
    // No demotion to lower tiers (prioritize cache effects and predictable response quality).
    const tierCascade = (load: TierName): TierName[] =>
      load === "light"
        ? ["light", "middle", "heavy"]
        : load === "middle"
          ? ["middle", "heavy"]
          : ["heavy"]

    // ------------------------------------------------------------------
    // Routing (experimental.model.resolve)
    // ------------------------------------------------------------------
    // Routing Score (v1.0):
    //   score = 0.65 * machineSuccess + 0.35 * quality
    //           - costWeight    x normalized cost (relative ratio among candidates)
    //           - latencyWeight x normalized latency (relative ratio among candidates. 0-1)
    // Machine success is blended with a benchmark prior. Quality is human
    // ratings blended with the independent-audit auto-review signal when
    // autoReviewWeight > 0 (see autoReviewScore). Human ratings are
    // normalized from 1-5 to 0-1 and smoothed beta-distribution-style.
    // If per-task-category stats are sufficient (>= minObservations), they
    // take priority; otherwise fall back to overall stats, then neutral 0.5.
    // Routing cost (v1.0) compares the expected full-turn cost, not just the
    // output unit price: input + output + cache-read unit prices (USD/Mtoken),
    // normalized by the candidate maximum. Long-input coding tasks can make an
    // input-expensive model the more expensive choice even if its output is cheap.
    const routingCostOf = (model: { cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } }[] }): number => {
      const tier = model.cost?.[0]
      if (!tier) return Infinity
      const input = num(tier.input, 0)
      const output = num(tier.output, 0)
      const cacheRead = num(tier.cache?.read, 0)
      const cacheWrite = num(tier.cache?.write, 0)
      return input + output + cacheRead + cacheWrite
    }
    const statScore = (
      stat: Stat,
      feedback: unknown,
      refCost: number,
      benchmark?: number,
      benchmarkK = 0,
      autoReview?: unknown,
    ): number => {
      const n = stat.success + stat.failure
      const machine = blendBenchmarkPrior(
        stat.success,
        stat.failure,
        benchmark,
        benchmarkK,
      )
      const human = feedbackScore(feedback as Record<string, unknown> | undefined)
      const w = effectiveAutoWeight(
        autoReview as AutoReviewStat | undefined,
        feedback as Record<string, unknown> | undefined,
      )
      const auto = autoReviewScore(autoReview)
      const quality = (1 - w) * human + w * auto
      const score = 0.65 * machine + 0.35 * quality
      return score - cfg.costWeight * refCost
    }

    // v1.1.1: provider-chain priority (pure helper, mirrored in tests).
    // Returns the index of the first chain entry that still has at least one
    // eligible candidate, or -1 when every entry is exhausted.
    const firstHealthyChainIndex = (
      models: { providerID: string }[],
      chain: string[],
      eligible: (m: { providerID: string }) => boolean,
    ): number => {
      for (let i = 0; i < chain.length; i++) {
        if (models.some((m) => m.providerID === chain[i] && eligible(m)))
          return i
      }
      return -1
    }

    const pick = async (
      currentRef: string,
      category: string | undefined,
      rescue = false,
      sessionID?: string,
    ): Promise<
      { providerID: string; id: string; reason: string } | undefined
    > => {
      const currentProvider = currentRef.slice(0, currentRef.indexOf("/"))
      // Emergency expansion: on rescue, widen candidates to all providers to find a fallback target.
      // The whitelist is also ignored in emergencies (limited to models within budget).
      // - When the current provider is provider-cooling (free tier is down account-wide)
      // - Always with crossProvider (so that even if the whitelist's free models are all down,
      //   we can seamlessly fall back to paid models within budget)
      const emergency =
        rescue && (providerCool(currentProvider) || cfg.crossProvider || cfg.providerChain.length > 0)
      let models = await candidates(emergency)
      if (models.length === 0) return undefined

      // v1.1.1: provider-chain priority narrowing. Restrict candidates to the
      // earliest chain entry that still has eligible, non-cooling candidates.
      // On rescue, only models with observed records count (same rule as the
      // tier narrowing below) — a chain entry whose only healthy models are
      // unobserved is skipped so the chain falls through to the next entry
      // instead of stalling on an unobservable provider. When every chain
      // entry is exhausted, keep the full candidate pool (emergency-expanded
      // on rescue) as the last resort.
      let chainTag: string | undefined
      if (cfg.providerChain.length > 0) {
        const observed = new Set<string>()
        if (rescue) {
          for (const m of models) {
            const st = await loadStat(m.providerID, m.id)
            if (st && st.success + st.failure > 0)
              observed.add(refFor(m.providerID, m.id))
          }
        }
        const chainIdx = firstHealthyChainIndex(
          models,
          cfg.providerChain,
          (m) => {
            const ref = refFor(m.providerID, m.id)
            // cool() also honors the provider-scoped free-tier cooldown
            // (which only blocks free models — paid ones stay eligible).
            return !cool(ref) && (!rescue || observed.has(ref))
          },
        )
        if (chainIdx >= 0) {
          const pid = cfg.providerChain[chainIdx]
          models = models.filter((m) => m.providerID === pid)
          chainTag = `chain[${chainIdx}] ${pid}`
          logRoute(
            `CHAIN ${chainTag}${emergency ? " (emergency, " : " ("}${models.length} models, load=${sessionID ? sessionLoad.get(sessionID) ?? "?" : "?"})`,
          )
        } else {
          logRoute(
            `CHAIN exhausted (${cfg.providerChain.join(" -> ")}) -> full pool`,
          )
        }
      }

      // Tier selection (v0.8): when the load band is set, narrow candidates to
      // healthy (not cooling down) models within the tier. Within a tier, the existing statScore+exploration
      // works untouched. If the tier is exhausted, cascade upward
      // (Light -> Middle -> Heavy); if all tiers are exhausted, degrade to legacy all-candidate selection.
      // Presence of the :free suffix is treated as the same model (same normalization as benchmarkFor).
      let tierTag: TierName | undefined
      const load = sessionID ? sessionLoad.get(sessionID) : undefined
      if (cfg.tierMode !== "off" && load) {
        const tiers = resolveTiers()
        if (tiers) {
          for (const tier of tierCascade(load)) {
            const allowed = new Set(tiers[tier].map(normRef))
            if (allowed.size === 0) continue
            const inTier: typeof models = []
            for (const m of models) {
              const ref = refFor(m.providerID, m.id)
              if (!allowed.has(normRef(ref)) || cool(ref)) continue
              // On rescue, only tiers with observed records count as real (v0.8 audit fix).
              // Narrowing to an all-unobserved tier makes rescue's healthy filter
              // (n>0) empty, breaking the upward cascade and leaving no fallback target.
              if (rescue) {
                const st = await loadStat(m.providerID, m.id)
                if (!st || st.success + st.failure === 0) continue
              }
              inTier.push(m)
            }
            if (inTier.length > 0) {
              logRoute(`TIER ${tier} (load=${load}, ${inTier.length} models)`)
              models = inTier
              tierTag = tier
              break
            }
          }
          if (!tierTag) {
            logRoute(`TIER exhausted (load=${load}) -> normal selection`)
          }
        }
      }
      const tierPrefix = () =>
        `${chainTag ? `${chainTag} ` : ""}${tierTag ? `tier:${tierTag} ` : ""}`

      const maxCost =
        Math.max(...models.map((m) => routingCostOf(m))) || 1
      // Benchmark prior (v0.6): applied to candidates after the budget filter.
      // If the file is missing / k=0, the benchmark side is disabled.
      const benchmarks = currentBenchmarks()
      const benchK = benchmarkPriorK(benchmarks)

      const entries: {
        ref: string
        providerID: string
        id: string
        score: number
        n: number
        avgMs: number
      }[] = []
      for (const model of models) {
        const ref = refFor(model.providerID, model.id)
        const benchmark = benchmarkFor(benchmarks, ref, category)
        const task = category
          ? await loadTaskStat(category, model.providerID, model.id)
          : undefined
        if (task && task.success + task.failure >= cfg.minObservations) {
          const n = task.success + task.failure
          const avgMs = task.totalMs / n
          const taskFeedback = category
            ? await loadTaskFeedback(category, model.providerID, model.id)
            : undefined
          const globalFeedback = taskFeedback ?? await loadFeedback(model.providerID, model.id)
          const taskAuto = category
            ? await loadTaskAutoReview(category, model.providerID, model.id)
            : undefined
          const globalAuto =
            taskAuto ?? (await loadAutoReview(model.providerID, model.id))
          entries.push({
            ref,
            providerID: model.providerID,
            id: model.id,
            n,
            avgMs,
            score: statScore(
              task,
              globalFeedback,
              routingCostOf(model) / maxCost,
              benchmark,
              benchK,
              globalAuto,
            ),
          })
          continue
        }
        const global = await loadStat(model.providerID, model.id)
        if (global && global.success + global.failure > 0) {
          const n = global.success + global.failure
          const avgMs = global.totalMs / n
          const feedback = await loadFeedback(model.providerID, model.id)
          const auto = await loadAutoReview(model.providerID, model.id)
          entries.push({
            ref,
            providerID: model.providerID,
            id: model.id,
            n,
            avgMs,
            score: statScore(
              global,
              feedback,
              routingCostOf(model) / maxCost,
              benchmark,
              benchK,
              auto,
            ),
          })
          continue
        }
        const feedback = await loadFeedback(model.providerID, model.id)
        const auto = await loadAutoReview(model.providerID, model.id)
        const human = feedbackScore(feedback as Record<string, unknown> | undefined)
        const w = effectiveAutoWeight(
          auto as AutoReviewStat | undefined,
          feedback as Record<string, unknown> | undefined,
        )
        const quality =
          (1 - w) * human + w * autoReviewScore(auto)
        // With only human ratings, do not treat unobserved models as a flat 0.5
        const coldMachine = blendBenchmarkPrior(0, 0, benchmark, benchK)
        entries.push({ ref, providerID: model.providerID, id: model.id, n: 0, avgMs: 0, score: 0.65 * coldMachine + 0.35 * quality - cfg.costWeight * (routingCostOf(model) / maxCost) })
      }
      // Penalize latency normalized by the relative ratio among candidates.
      // (Previously fixed at avgMs / 60_000, so a ~0.5s model was only penalized
      //  by ~0.003 and snappiness was effectively ignored)
      // Use the max among observed candidates as the baseline; unobserved candidates get the neutral 0.5.
      {
        const observed =
          entries.filter((e) => e.n > 0 && e.avgMs > 0).map((e) => e.avgMs)
        const maxAvg = observed.length > 0 ? Math.max(...observed) : 60_000
        for (const entry of entries) {
          const rel =
            entry.n > 0 && entry.avgMs > 0 ? entry.avgMs / maxAvg : 0.5
          entry.score -= cfg.latencyWeight * rel
        }
      }
      // Exclude models in cooldown (recently "unavailable").
      // cool() also checks provider-scoped cooldowns (assuming the free tier goes down together).
      const usable = entries.filter((e) => !cool(e.ref))
      // During rescue (current model unavailable/cooling down):
      //  - pick the best-scoring observed healthy model (no fallback to unverified models)
      //  - no exploration. The current model is excluded from candidates
      //  - this path runs even with routing OFF (prevents session stalls)
      //  - if the current provider is provider-cooling (free tier is down account-wide),
      //    emergency-expand candidates to all providers to find a fallback target
      if (rescue) {
        if (usable.length === 0) return undefined
        const healthy = usable.filter(
          (e) =>
            e.n > 0 &&
            e.ref !== currentRef &&
            (emergency ||
              cfg.crossProvider ||
              e.providerID === cfg.providerID ||
              e.providerID === currentProvider),
        )
        if (healthy.length === 0) return undefined
        const best = healthy.reduce((a, b) => (b.score > a.score ? b : a))
        return {
          providerID: best.providerID,
          id: best.id,
          reason: `${tierPrefix()}rescue${emergency ? "!" : ""}=${best.score.toFixed(3)}`,
        }
      }
      if (usable.length === 0) return undefined
      // Conservative with crossProvider: do not use unobserved models (n=0) as replacement targets.
      // Prevents turnout replacements with unverified models.
      // Note: models of the current provider still allow cold-start as before.
      const eligible = cfg.crossProvider
        ? usable.filter((e) => e.n > 0 || e.providerID === currentProvider)
        : usable
      if (eligible.length === 0) return undefined
      // Exploration (eps-greedy + learning period):
      // - While models with little observation (< minObservations) remain, learningRate
      //   is the exploration rate, and only such "cold" models are candidates.
      // - After all models are sufficiently observed, pick from all candidates at the usual exploreRate.
      const cold = eligible.filter(
        (e) => e.n < cfg.minObservations && e.ref !== currentRef,
      )
      const rate = cold.length > 0 ? cfg.learningRate : cfg.exploreRate
      if (Math.random() < rate) {
        const pool = cold.length > 0 ? cold : eligible.filter((e) => e.ref !== currentRef)
        if (pool.length === 0) return undefined
        const chosen = pool[Math.floor(Math.random() * pool.length)]
        return {
          providerID: chosen.providerID,
          id: chosen.id,
          reason:
            cold.length > 0
              ? `${tierPrefix()}warmup(${chosen.n}/${cfg.minObservations})`
              : `${tierPrefix()}explore`,
        }
      }
      const best = eligible.reduce((a, b) => (b.score > a.score ? b : a))
      if (best.ref === currentRef) return undefined
      const source = best.n === 0 ? "neutral" : "score"
      return {
        providerID: best.providerID,
        id: best.id,
        reason: `${tierPrefix()}${source}=${best.score.toFixed(3)}`,
      }
    }

    await ctx.session.hook("experimental.model.resolve", async (event) => {
      // Debug (v0.8.1 verification): always record hook firing and kind.
      // If it does not fire, the routing path itself is disabled in this environment.
      logRoute(
        `RESOLVE kind=${event.kind} ${event.model.providerID}/${event.model.id} agent=${event.agent ?? "?"}`,
      )
      // Record the actual dispatched model (fallback for pre-rescue and culprit misidentification).
      // Taken before the kinds filter (title and other auxiliary dispatches are also real dispatches).
      lastResolved.set(event.sessionID, {
        providerID: event.model.providerID,
        id: event.model.id,
      })
      if (!kinds.includes(event.kind)) return
      // Single provider: do not touch providers other than the target.
      // v1.1.1: a set provider chain is in scope like crossProvider (its
      // providers are valid routing targets). crossProvider: every provider.
      const chainScope =
        cfg.providerChain.length > 0 &&
        cfg.providerChain.includes(event.model.providerID)
      if (
        !cfg.crossProvider &&
        !chainScope &&
        event.model.providerID !== cfg.providerID
      )
        return
      const currentRef = refFor(event.model.providerID, event.model.id)
      // v1.0: OFF stops every model switch, rescue included. While disabled this
      // hook never rewrites models ("it switched models even though I turned it
      // off" was the reported confusion); ON is restored by the config resync
      // that runs at the start of every prompt. Passive learning (observation,
      // classification, shadow review, recovery probes) keeps running in the
      // other hooks.
      if (!cfg.enabled) {
        logRoute(`SKIP ${event.kind} ${currentRef} (routing off, no model switches)`)
        return
      }
      // Rescue decision (ON only): if the current model is cooling down (recently
      // unavailable), fall back to a healthy model instead of scoring.
      // (Free-tier models remain enabled in the catalog but resolve becomes impossible,
      //  so detection is based on failure history = cooldown)
      const rescue = cool(currentRef)
      // v1.1: reasoning-effort (variant) selection for THIS dispatch.
      // Model first, then variant: applied to the current (or routed) model.
      // "auto" = Jev/LLM effort hint + weight-class compensation + exploration
      // + per-variant learning; "fixed" = cfg.variantFixed (when the model
      // actually has it). The session/agent's explicit variant always wins;
      // rescue switches keep the target's default. Remember whether the
      // variant was present BEFORE fusion sets one, so the routed-model
      // handling below can tell user picks from fusion picks (B2).
      const hadExplicitVariant = !!event.model.variant
      if (cfg.variantMode !== "off" && !rescue && !event.model.variant) {
        const picked = await variantForSession(
          event.model.providerID,
          event.model.id,
          event.sessionID,
        )
        if (picked?.variant) {
          event.model = { ...event.model, variant: picked.variant }
          logRoute(
            `VARIANT ${event.kind} ${currentRef} -> #${picked.variant} (${picked.note}, load=${sessionLoad.get(event.sessionID) ?? "?"}${sessionEffort.get(event.sessionID) !== undefined ? `, hint=${sessionEffort.get(event.sessionID)}` : ""})`,
          )
        } else if (picked) {
          logRoute(`VARIANT ${event.kind} ${currentRef} (${picked.note})`)
        }
      }
      const choice = await pick(
        currentRef,
        sessionCategory.get(event.sessionID),
        rescue,
        event.sessionID,
      )
      if (!choice) {
        logRoute(
          `KEEP ${event.kind} ${currentRef} (rescue=${rescue}, no candidate)`,
        )
        return
      }
      const nextRef = refFor(choice.providerID, choice.id)
      if (nextRef === currentRef) return

      // OpenCode 2.3's model.resolve path only resolves "same-provider rewrites"
      // (the core only resolves when y.providerID === m.providerID;
      // cross-provider throws ModelUnavailableError immediately).
      // Therefore swaps inside the resolve hook are limited to the same provider,
      // and cross-provider fallback happens via switchModel (the same path as manual model selection)
      // by updating the session model so the next dispatch uses it.
      if (choice.providerID === event.model.providerID) {
        // B2: the variant decided earlier was for the ORIGINAL model (or the
        // user's explicit pick). It must not be blindly carried to the routed
        // model — a positional id like #high may not exist on it. Decide again
        // for the routed model, keeping an explicit (user) variant only when
        // the new model actually exposes it.
        let variant = event.model.variant
        if (choice.id !== event.model.id) {
          if (hadExplicitVariant && variant) {
            let available = false
            try {
              const info: any = await (ctx.model as any).get(
                choice.providerID,
                choice.id,
              )
              const ids: string[] = ((info?.variants ?? []) as any[])
                .map((v) => (typeof v === "string" ? v : v?.id))
                .filter((v): v is string => typeof v === "string")
              available = ids.includes(variant)
            } catch {
              available = false
            }
            if (!available) {
              logRoute(
                `VARIANT ${event.kind} ${choice.providerID}/${choice.id} #${variant} not available on routed model (dropped)`,
              )
              variant = undefined
            }
          } else {
            variant = undefined
            if (cfg.variantMode !== "off") {
              const picked = await variantForSession(
                choice.providerID,
                choice.id,
                event.sessionID,
              )
              variant = picked?.variant
              if (variant)
                logRoute(
                  `VARIANT ${event.kind} ${choice.providerID}/${choice.id} -> #${variant} (${picked?.note}, routed model)`,
                )
            }
          }
        }
        event.model = {
          providerID: choice.providerID,
          id: choice.id,
          ...(variant ? { variant } : {}),
        }
        logRoute(
          `ROUTE ${event.kind} ${currentRef} -> ${choice.providerID}/${choice.id}${variant ? `#${variant}` : ""} (${choice.reason})`,
        )
        // Persist the routing result into the session's saved model as well (v0.8.1 fix).
        // resolve swaps are per-dispatch; the saved model remains the original.
        // If a quota-dead model stays saved, drain (resume from the queue) or resume after restart
        // would use the saved model directly and force-stop on ModelUnavailableError,
        // so align it to a healthy model here.
        // Note: persist only when the swap is a rescue fallback.
        // Saving even ordinary score-routing swaps would rewrite the session model on every step,
        // breaking caches and persisting unintended paid models — persistent behavior changes are limited to rescue.
        if (rescue) {
          try {
            await ctx.session.switchModel({
              sessionID: event.sessionID,
              model: { providerID: choice.providerID, id: choice.id },
            })
            // v1.1.1: record the restore ticket here too (every other rescue
            // site does) — without it the original model is never restored.
            rescueAttempts.set(event.sessionID, {
              originalRef: currentRef,
              deadline: Date.now() + RESCUE_WINDOW_MS,
            })
            void persistRescue()
          } catch {
            // Persist failure does not affect the swap for the current dispatch
          }
        }
        return
      }

      // Cross-provider fallback (rescue only). The current dispatch proceeds with the current model
      // (if it is dead, after-fail follows). Switching the session model
      // ensures a healthy model is used from the next dispatch.
      if (rescue) {
        try {
          await ctx.session.switchModel({
            sessionID: event.sessionID,
            model: { providerID: choice.providerID, id: choice.id },
          })
          rescueAttempts.set(event.sessionID, {
            originalRef: currentRef,
            deadline: Date.now() + RESCUE_WINDOW_MS,
          })
          void persistRescue()
          logRoute(
            `DEFER ${event.kind} ${currentRef} -> ${choice.providerID}/${choice.id} (cross-provider, next dispatch) (${choice.reason})`,
          )
        } catch (error) {
          logRoute(
            `DEFER failed ${currentRef} -> ${choice.providerID}/${choice.id}: ${String(error).slice(0, 60)}`,
          )
        }
        return
      }
      // Cross-provider swaps are not done during normal routing.
      // They would ping-pong providers on every dispatch, breaking caches
      // and worse cost/latency (the swipe problem).
      logRoute(
        `KEEP ${event.kind} ${currentRef} (cross-provider best=${choice.providerID}/${choice.id}, no rewrite)`,
      )
    })

    // ------------------------------------------------------------------
    // Manual review (1-5 rating of the response + 3-line summary)
    // ------------------------------------------------------------------
    // v0.9.0: normalize offset (0 = latest, 1 = one before ...). Invalid values fall to 0.
    const normalizeOffset = (value: unknown): number => {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) return 0
      return Math.min(Math.floor(n), 50)
    }
    // Return the topology stats tied to the session as a display snapshot.
    // D-3: includes not only the cost-performance rating, but also observed records
    // (run count / ok rate / measured latency / quality).
    // v1.1.1: accepts the TURN's topology (from per-turn metadata) so that
    // reviewing an older turn shows that turn's topology stats instead of the
    // session's current one. Falls back to the session map for old turns.
    const topologySnapshot = async (
      sessionID: string,
      turnTopology?: string,
    ) => {
      const topology = turnTopology ?? sessionTopology.get(sessionID) ?? "single"
      const stat = await loadTopologyStat(TOPOLOGY_PREFIX + topology)
      const cpCount = stat?.costPerformanceCount ?? 0
      const qCount = stat?.qualityCount ?? 0
      return {
        topology,
        topologyRatingAverage:
          cpCount > 0 ? (stat?.sumCostPerformance ?? 0) / cpCount : 0,
        topologyRatingCount: cpCount,
        topologyCount: stat?.count ?? 0,
        topologyOkRate:
          stat && stat.count > 0 ? stat.ok / stat.count : 0,
        topologyAvgMs:
          stat && stat.count > 0 ? Math.round(stat.totalMs / stat.count) : 0,
        topologyQualityAverage:
          qCount > 0 ? (stat?.sumQuality ?? 0) / qCount : 0,
      }
    }

    const reviewSnapshot = async (sessionID: string, offset = 0) => {
      const target = await getReviewTarget(sessionID, offset)
      if (!target) {
        return {
          sessionID,
          offset,
          category: "",
          messageID: "",
          providerID: "",
          modelID: "",
          assignedAt: "",
          preview: tr("(応答なし)", "(no response)"),
          instructionPreview: "",
          responseLength: 0,
          feedbackAverage: 0,
          feedbackCount: 0,
          ...(await topologySnapshot(sessionID)),
          // sequential-chain plan (when injected). optional means omitting the key entirely
          ...(chainPlans.has(sessionID)
            ? { chainPlan: chainPlans.get(sessionID)!.plan }
            : {}),
        }
      }
      const feedback = (await loadFeedback(target.providerID, target.modelID)) as
        | FeedbackStat
        | undefined
      const count = feedback?.count ?? 0
      // v1.1.1: rated markers for this turn (one review per turn)
      const turnsMeta = await loadReviewTurns(sessionID)
      const ratedMeta = turnsMeta[target.messageID]
      const rated =
        ratedMeta &&
        (ratedMeta.rating !== undefined ||
          ratedMeta.topologyRating !== undefined)
          ? {
              ...(ratedMeta.rating !== undefined
                ? { rating: ratedMeta.rating }
                : {}),
              ...(ratedMeta.topologyRating !== undefined
                ? { topologyRating: ratedMeta.topologyRating }
                : {}),
            }
          : undefined
      const auto = (await loadAutoReview(target.providerID, target.modelID)) as
        | AutoReviewStat
        | undefined
      const autoTotal = auto?.total ?? 0
      const autoReview: AutoReviewSnapshot | undefined =
        auto && autoTotal > 0
          ? {
              average:
                (auto.instruction + auto.accuracy + auto.completeness) /
                (autoTotal * 3),
              instruction: auto.instruction / autoTotal,
              accuracy: auto.accuracy / autoTotal,
              completeness: auto.completeness / autoTotal,
              // v0.9.0: cost-performance axis (efficiency) average (only for collected samples)
              ...((auto.efficiencyCount ?? 0) > 0
                ? { efficiency: auto.efficiency / auto.efficiencyCount }
                : {}),
              // v0.9.0: enumeration of recent accomplishments
              ...(auto.results && auto.results.length > 0
                ? { results: auto.results }
                : {}),
              reason: auto.reasons[auto.reasons.length - 1] ?? "",
              reviewerRef: auto.reviewerRef ?? "",
              total: autoTotal,
            }
          : undefined
      return {
        sessionID,
        offset,
        category: target.category || tr("(未分類)", "(unclassified)"),
        messageID: target.messageID,
        providerID: target.providerID,
        modelID: target.modelID,
        assignedAt: target.assignedAt,
        preview: target.preview || tr("(空の応答)", "(empty response)"),
        instructionPreview: target.instructionPreview,
        responseLength: target.text.length,
        feedbackAverage: count > 0 ? (feedback?.ratingSum ?? 0) / count : 0,
        feedbackCount: count,
        // v0.9.0: turn statistics (input/output tokens / cost / measured speed). Included only for turns that have it (optional)
        ...(target.turn ? { turn: target.turn } : {}),
        ...(await topologySnapshot(sessionID, target.topology)),
        // v1.1.1: this turn's human ratings (one review per turn; shown and
        // used to disable re-rating)
        ...(rated ? { rated } : {}),
        // sequential-chain plan (when injected). optional means omitting the key entirely
        ...(chainPlans.has(sessionID)
          ? { chainPlan: chainPlans.get(sessionID)!.plan }
          : {}),
        // Tier routing (v0.8): the load band of this session.
        // Fall back to a heuristic estimate from the reviewed turn when the
        // in-memory map has no entry (plugin restarted, or the session
        // predates tier tracking), so the panel always shows a load band.
        load: sessionLoad.get(sessionID) ??
          heuristicLoad(target.instruction, target.category || undefined),
        // RPC schema is an optional object. Never pass undefined as a key
        ...(autoReview ? { autoReview } : {}),
      }
    }

    const reviewSummary = async (sessionID: string, offset = 0): Promise<string> => {
      const target = await getReviewTarget(sessionID, offset)
      if (!target || target.text.length === 0)
        return offset > 0
          ? tr(
              `${offset}個前の応答は評価できる内容がありません`,
              `The response ${offset} turn(s) back has no rateable content.`,
            )
          : tr(
              "まだ評価できる応答がありません",
              "There is no rateable response yet.",
            )
      return summarizeAssistant(target.instruction, target.text)
    }

    const reviewRate = async (
      sessionID: string,
      rating: number | undefined,
      topologyRating?: number,
      offset = 0,
    ): Promise<{
      ok: boolean
      message: string
      category: string
      providerID: string
      modelID: string
      feedbackAverage: number
      feedbackCount: number
      topology: string
      topologyRatingAverage: number
      topologyRatingCount: number
      topologyCount: number
      topologyOkRate: number
      topologyAvgMs: number
      topologyQualityAverage: number
    }> => {
      const hasRating = rating !== undefined
      const hasTopologyRating = topologyRating !== undefined
      const fail = (message: string) => ({
        ok: false,
        message,
        category: "",
        providerID: "",
        modelID: "",
        feedbackAverage: 0,
        feedbackCount: 0,
        ...(sessionTopology.get(sessionID)
          ? { topology: sessionTopology.get(sessionID)! }
          : { topology: "single" }),
        topologyRatingAverage: 0,
        topologyRatingCount: 0,
        topologyCount: 0,
        topologyOkRate: 0,
        topologyAvgMs: 0,
        topologyQualityAverage: 0,
      })
      if (!hasRating && !hasTopologyRating)
        return fail(
          tr(
            "rating または topologyRating のどちらかを指定してください",
            "Specify either rating or topologyRating.",
          ),
        )
      if (hasRating && (!Number.isInteger(rating) || rating! < 1 || rating! > 5))
        return fail(
          tr(
            "rating は 1〜5 の整数で入力してください",
            "rating must be an integer from 1 to 5.",
          ),
        )
      if (hasTopologyRating &&
          (!Number.isInteger(topologyRating) || topologyRating! < 1 || topologyRating! > 5))
        return fail(
          tr(
            "topologyRating は 1〜5 の整数で入力してください",
            "topologyRating must be an integer from 1 to 5.",
          ),
        )
      const target = await getReviewTarget(sessionID, offset)
      if (!target)
        return fail(
          offset > 0
            ? tr(
                `${offset}個前の応答が見つかりません`,
                `No response found ${offset} turn(s) back.`,
              )
            : tr(
                "最新応答が見つかりません",
                "No response found.",
              ),
        )
      // v1.1.1: one review per turn. A rating already recorded for this
      // target message (quality or topology cost-performance) is final —
      // re-pressing the buttons must not record a second sample.
      const turnsMeta = await loadReviewTurns(sessionID)
      const already = turnsMeta[target.messageID]
      if (hasRating && already?.rating !== undefined)
        return fail(
          tr(
            `このターンは評価済みです(${already.rating}/5)。1ターン1回のみ評価できます`,
            `This turn is already rated (${already.rating}/5). One review per turn.`,
          ),
        )
      if (hasTopologyRating && already?.topologyRating !== undefined)
        return fail(
          tr(
            `このターンのトポロジーコスパは評価済みです(${already.topologyRating}/5)`,
            `This turn's topology cost-performance is already rated (${already.topologyRating}/5).`,
          ),
        )
      if (hasRating) {
        await recordFeedback(
          target.providerID,
          target.modelID,
          target.category || undefined,
          rating!,
        )
      }
      if (hasTopologyRating) {
        await recordTopologyCostPerformance(
          sessionID,
          topologyRating!,
          target.topology,
          target.category || undefined,
        )
      }
      // Record the rating on the turn (persisted marker)
      await upsertReviewTurn(sessionID, target.messageID, {
        topology: target.topology,
        category: target.category,
        ...(hasRating ? { rating: rating! } : {}),
        ...(hasTopologyRating ? { topologyRating: topologyRating! } : {}),
      })
      const global = (await loadFeedback(target.providerID, target.modelID)) as
        | FeedbackStat
        | undefined
      const count = global?.count ?? 0
      const topologyInfo = await topologySnapshot(sessionID, target.topology)
      const parts = [
        hasRating
          ? tr(
              `評価を記録しました: ${rating}/5`,
              `Rating recorded: ${rating}/5`,
            )
          : undefined,
        hasTopologyRating
          ? tr(
              `トポロジーコスパを記録しました: ${topologyRating}/5 (${topologyInfo.topology})`,
              `Topology cost-performance recorded: ${topologyRating}/5 (${topologyInfo.topology})`,
            )
          : undefined,
      ].filter(Boolean) as string[]
      return {
        ok: true,
        message: parts.join(" / "),
        category: target.category || tr("(未分類)", "(unclassified)"),
        providerID: target.providerID,
        modelID: target.modelID,
        feedbackAverage: count > 0 ? (global?.ratingSum ?? 0) / count : 0,
        feedbackCount: count,
        ...topologyInfo,
      }
    }
    // ------------------------------------------------------------------
    // Probe (bulk health check of candidate models)
    // ------------------------------------------------------------------
    // Send a lightweight prompt to candidates (whitelist first; otherwise the first 16 of all candidates),
    // and record pass/fail and latency into stats.
    // Used as a "pre-test" before enabling routing and to exclude unavailable models up front.
    const PROBE_PROMPT = "Reply with exactly: OK"
    const PROBE_LIMIT = 16
    const PROBE_CONCURRENCY = 4
    const PROBE_TIMEOUT_MS = 20_000

    const probeOne = async (model: any) => {
      const started = performance.now()
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timeout")),
            PROBE_TIMEOUT_MS,
          ),
        )
        const result: any = await Promise.race([
          ctx.experimental.generate.text({
            model: { providerID: model.providerID, id: model.id },
            prompt: PROBE_PROMPT,
          }),
          timeout,
        ])
        const ms = performance.now() - started
        const text = String(result?.text ?? "").trim()
        // Same acceptance rule as the VERIFY probe: exactly "OK"
        // (case-insensitive, optional trailing punctuation).
        const ok = /^ok[.!]?$/i.test(text)
        return {
          model,
          ok,
          ms,
          note: ok ? "" : text.length === 0 ? "empty response" : "unexpected response",
          preview: text.slice(0, 40),
        }
      } catch (error) {
        return {
          model,
          ok: false,
          ms: performance.now() - started,
          note: String(error).slice(0, 100),
          preview: "",
        }
      }
    }

    const runPool = async <T, R>(
      items: T[],
      worker: (item: T) => Promise<R>,
      size: number,
    ): Promise<R[]> => {
      const results = new Array<R>(items.length)
      let index = 0
      await Promise.all(
        Array.from({ length: Math.min(size, items.length) }, async () => {
          while (index < items.length) {
            const current = index++
            results[current] = await worker(items[current])
          }
        }),
      )
      return results
    }

    const runProbe = async (): Promise<string> => {
      const all = await candidates()
      const capped = all.length > PROBE_LIMIT
      const targets = all.slice(0, PROBE_LIMIT)
      if (targets.length === 0)
        return tr(
          "(プローブ対象のモデルがありません)",
          "(no models to probe)",
        )
      const lines = [
        tr(
          `プローブ対象: ${targets.length} 件${capped ? `(候補${all.length} 件から先頭のみ)` : ""}`,
          `Probing ${targets.length} model(s)${capped ? ` (first ${targets.length} of ${all.length} candidates)` : ""}`,
        ),
        "",
      ]
      const results = await runPool(targets, probeOne, PROBE_CONCURRENCY)
      let okCount = 0
      for (const r of results) {
        const ref = refFor(r.model.providerID, r.model.id)
        if (r.ok) {
          okCount += 1
          // Success: record into learning stats and lift the cooldown
          clearCooldown(ref)
          await record(
            r.model.id,
            r.model.providerID,
            undefined,
            true,
            r.ms,
            true,
          )
          lines.push(`ok   ${Math.round(r.ms)}ms  ${ref}  "${r.preview}"`)
        } else {
          // Failure types: free tier / rate limit (quota) does not go into the quality penalty.
          // Do not skew the stats success rate. The cooldown is applied.
          const cls = classifyFailure({ message: r.note })
          markFailure(ref, cls)
          if (cls === "error")
            await record(
              r.model.id,
              r.model.providerID,
              undefined,
              false,
              r.ms,
              true,
            )
          lines.push(`FAIL      ${ref}  (${r.note}) [${cls}]`)
        }
      }
      lines.push(
        "",
        tr(
          `結果: ok ${okCount} / fail ${results.length - okCount}`,
          `Result: ok ${okCount} / fail ${results.length - okCount}`,
        ),
      )
      return lines.join("\n")
    }

    // ------------------------------------------------------------------
    // RPC (called from the TUI part)
    // ------------------------------------------------------------------
    const buildStatsText = async (): Promise<string> => {
      const lines: string[] = []
      lines.push(
        tr(
          `(コスト上限: input ${cfg.maxInputCost} / output ${cfg.maxOutputCost} USD/Mtoken` +
            `${cfg.listMode === "blacklist" ? " — ブラックリストモードでは常に適用" : cfg.models.length === 0 ? " — リスト空時に適用" : " (ホワイトリスト優先)"})`,
          `(cost cap: input ${cfg.maxInputCost} / output ${cfg.maxOutputCost} USD/Mtoken` +
            `${cfg.listMode === "blacklist" ? " — always applied in blacklist mode" : cfg.models.length === 0 ? " — applied when the list is empty" : " (whitelist takes precedence)"})`,
        ),
      )
      if (!cfg.enabled)
        lines.push(
          tr(
            "(ルーティング: OFF / モデル切替はすべて停止・学習(観測)は継続)",
            "(routing: OFF / no model switches; passive learning continues)",
          ),
        )
      if (cfg.providerChain.length > 0)
        lines.push(
          tr(
            `(モード: プロバイダーチェーン ${cfg.providerChain.join(" -> ")} / 先頭を優先、尽きたら次へ)`,
            `(mode: provider chain ${cfg.providerChain.join(" -> ")} / prefer the first, fall through on exhaustion)`,
          ),
        )
      else if (cfg.crossProvider)
        lines.push(
          tr(
            "(モード: crossProvider / 全プロバイダー混合)",
            "(mode: crossProvider / all providers mixed)",
          ),
        )
      else
        lines.push(
          tr(
            `(モード: 単一プロバイダー ${cfg.providerID})`,
            `(mode: single provider ${cfg.providerID})`,
          ),
        )
      {
        const benchmarks = currentBenchmarks()
        const k = benchmarkPriorK(benchmarks)
        if (cfg.benchmarkPriorWeight <= 0) {
          lines.push(
            tr(
              "(ベンチマーク事前: 無効 / k=0)",
              "(benchmark prior: disabled / k=0)",
            ),
          )
        } else if (!benchmarks) {
          lines.push(
            tr(
              "(ベンチマーク事前: ファイルが読めません。全モデル中立 0.5 扱い)",
              "(benchmark prior: file unreadable. All models treated as neutral 0.5)",
            ),
          )
        } else {
          const ts = Date.parse(benchmarks.fetchedAt ?? "")
          const stale =
            Number.isFinite(ts) && Date.now() - ts > 90 * 24 * 60 * 60_000
          const source =
            storedBenchmarks && storedBenchmarks === benchmarks
              ? tr("自動更新スナップショット", "auto-refreshed snapshot")
              : tr("同梱シード", "bundled seed")
          lines.push(
            tr(
              `(ベンチマーク事前: 有効 k=${k} / モデル数 ${Object.keys(benchmarks.models ?? {}).length}` +
                ` / fetchedAt ${(benchmarks.fetchedAt ?? "不明").slice(0, 10)}${stale ? " / 90日経過: kを半減(陳腐化対策)" : ""} / ${source})`,
              `(benchmark prior: active k=${k} / models ${Object.keys(benchmarks.models ?? {}).length}` +
                ` / fetchedAt ${(benchmarks.fetchedAt ?? "unknown").slice(0, 10)}${stale ? " / older than 90 days: k halved (staleness guard)" : ""} / ${source})`,
            ),
          )
          // Auto-refresh status (toggle-ON linked, once per day)
          try {
            const meta = (await ctx.storage.get(BENCH_CHECK_KEY)) as
              | { lastResult?: string; lastFetchedAt?: string }
              | undefined
            const last = meta?.lastResult ?? tr("未チェック", "not checked yet")
            const mode = cfg.benchmarksFile
              ? tr("スキップ(カスタム benchmarksFile 使用)", "skipped (custom benchmarksFile)")
              : cfg.benchAutoUpdate
                ? tr("ON(トグル連動・1日1回)", "ON (toggle-linked, once per day)")
                : "OFF"
            lines.push(
              tr(
                `(自動更新: ${mode} / 状態: ${last})`,
                `(auto-refresh: ${mode} / status: ${last})`,
              ),
            )
          } catch {
            // Meta unreadable: ignore
          }
        }
      }
          // Jev availability and topology-mode status
      if (cfg.jevMode === "off") {
        lines.push(
          tr(
            "(Jev: OFF / jevMode=off — 従来経路で動作)",
            "(Jev: OFF / jevMode=off — using the legacy path)",
          ),
        )
      } else if (jevAvailable()) {
        lines.push(
          tr(
            `(Jev: 利用可能 / ${process.env.TYPESAFE_API_KEY?.trim() ? "環境変数" : "登録キー"}で認証` +
              ` — 分類・トポロジー判定を Jev で実行)`,
            `(Jev: available / authenticated via ${process.env.TYPESAFE_API_KEY?.trim() ? "environment variable" : "stored key"}` +
              ` — classification and topology decisions run on Jev)`,
          ),
        )
      } else {
        lines.push(
          tr(
            "(Jev: キー未登録 — 従来経路で動作 / /fusion-jev-key で登録)",
            "(Jev: no key — using the legacy path / register with /fusion-jev-key)",
          ),
        )
      }
      lines.push(
        cfg.topologyMode === "fixed"
          ? tr(
              "(トポロジー: fixed / single 固定)",
              "(topology: fixed / always single)",
            )
          : tr(
              `(トポロジー: auto / 許可: ${cfg.allowedTopologies.join(", ")} / 補助呼出上限 ${cfg.maxTopologyCalls})`,
              `(topology: auto / allowed: ${cfg.allowedTopologies.join(", ")} / aux call limit ${cfg.maxTopologyCalls})`,
            ),
      )

      const all = await candidates()
      const cold: string[] = []
      for (const model of all) {
        const s = await loadStat(model.providerID, model.id)
        if (!s || s.success + s.failure < cfg.minObservations)
          cold.push(refFor(model.providerID, model.id))
      }
      if (cold.length > 0)
        lines.push(
          tr(
            `(学習期間: 探索率 ${Math.round(cfg.learningRate * 100)}% / 未熟モデル ${cold.length} 件)`,
            `(learning phase: explore rate ${Math.round(cfg.learningRate * 100)}% / ${cold.length} under-sampled model(s))`,
          ),
        )

      const cooled = [...cooldowns.entries()]
        .filter(([, c]) => c.until > Date.now() || c.needsVerify === true)
        .sort((a, b) => a[1].until - b[1].until)
      const cooledProviders = [...providerCooldowns.entries()].filter(
        ([, p]) => p.until > Date.now(),
      )
      if (cooledProviders.length > 0)
        lines.push(
          tr(
            `(プロバイダー冷却: ${cooledProviders.length} 件 — 無料枠はアカウント単位で全滅)`,
            `(provider cooldowns: ${cooledProviders.length} — free tiers fail account-wide)`,
          ),
          ...cooledProviders.map(
            ([id, p]) =>
              `- ${id}: ${p.quota ? tr("クオータ制限", "quota limited") : tr("エラー", "error")} / ${tr("残り", "remaining")} ${Math.max(0, Math.round((p.until - Date.now()) / 1000))}s`,
          ),
        )
      if (cooled.length > 0)
        lines.push(
          tr(
            `(クールダウン: ${cooled.length} 件)`,
            `(cooldowns: ${cooled.length})`,
          ),
          ...cooled.map(
            ([ref, c]) =>
              `- ${ref}: ${
                c.until <= Date.now() && c.needsVerify
                  ? tr(
                      "検証待ち(制限の再確認中 — 1hごとに再プローブ)",
                      "awaiting verification (re-checking the limit — reprobe every hour)",
                    )
                  : c.quota
                    ? tr("クオータ制限", "quota limited")
                    : tr(`失敗${c.failures} 回`, `${c.failures} failure(s)`)
              } / ${
                c.until > Date.now()
                  ? tr(
                      `残り ${Math.max(0, Math.round((c.until - Date.now()) / 1000))}s`,
                      `remaining ${Math.max(0, Math.round((c.until - Date.now()) / 1000))}s`,
                    )
                  : tr("再検証待ち", "awaiting reprobe")
              }`,
          ),
        )

      const page = await ctx.storage.scan({ prefix: STAT_PREFIX, limit: 100 })
      lines.push(tr("全体統計", "Overall statistics"))
      for (const entry of page.entries) {
        const stat = entry.value as Stat
        const n = stat.success + stat.failure
        const rate = n > 0 ? ((stat.success / n) * 100).toFixed(0) : "-"
        const avg = n > 0 ? Math.round(stat.totalMs / n) : 0
        lines.push(
          `- ${refFor(stat.model.providerID, stat.model.id)}: ${n} req / ok ${rate}% / avg ${avg} ms`,
        )
      }
      if (page.entries.length === 0)
        lines.push(tr("(データなし)", "(no data)"))

      // v1.1: per-(model,variant) outcome learning (variantMode auto)
      const variantPage = await ctx.storage.scan({
        prefix: VARIANT_PREFIX,
        limit: 100,
      })
      if (variantPage.entries.length > 0) {
        lines.push(
          tr(
            `variant統計 (variantMode ${cfg.variantMode} / 探索ε=${cfg.variantExploreRate})`,
            `variant stats (variantMode ${cfg.variantMode} / explore ε=${cfg.variantExploreRate})`,
          ),
        )
        const variantEntries = variantPage.entries
          .map((entry) => entry.value as VariantStat)
          .filter((s) => s && s.count > 0)
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
        for (const s of variantEntries) {
          const rate = ((s.ok / s.count) * 100).toFixed(0)
          const avg = Math.round(s.totalMs / s.count)
          lines.push(
            `- ${refFor(s.model.providerID, s.model.id)}#${s.variant}: ${s.count} obs / ok ${rate}% / avg ${avg} ms`,
          )
        }
        if (variantEntries.length === 0)
          lines.push(tr("(観測なし — ε探索を待機中)", "(no observations — waiting for ε exploration)"))
      }

      const feedbackPage = await ctx.storage.scan({
        prefix: FEEDBACK_PREFIX,
        limit: 100,
      })
      const globalFeedbackEntries = feedbackPage.entries.filter(
        (entry) => !entry.key.startsWith(TASK_FEEDBACK_PREFIX),
      )
      if (globalFeedbackEntries.length > 0) {
        lines.push(tr("人間評価:", "Human ratings:"))
        for (const entry of globalFeedbackEntries) {
          const stat = entry.value as FeedbackStat
          const avg = stat.count > 0 ? (stat.ratingSum / stat.count).toFixed(1) : "-"
          lines.push(
            `- ${refFor(stat.model.providerID, stat.model.id)}: ${avg}/5 (${stat.count} ${tr("件", "entries")})`,
          )
        }
      }

      const autoPage = await ctx.storage.scan({
        prefix: AUTO_PREFIX,
        limit: 100,
      })
      const globalAutoEntries = autoPage.entries.filter(
        (entry) => !entry.key.startsWith(TASK_AUTO_PREFIX),
      )
      // Collect ref -> average here for the shadow-vs-human divergence (reconciliation)
      const autoAvgByRef = new Map<string, number>()
      const reviewerAgg = new Map<string, { total: number; sum: number }>()
      if (globalAutoEntries.length > 0) {
        lines.push(tr("内部審査(shadow):", "Auto-review (shadow):"))
        for (const entry of globalAutoEntries) {
          const stat = entry.value as AutoReviewStat
          const n = Math.max(stat.total, 1)
          const avg =
            (stat.instruction + stat.accuracy + stat.completeness) / (n * 3)
          autoAvgByRef.set(refFor(stat.model.providerID, stat.model.id), avg)
          if (stat.reviewerRef) {
            const agg = reviewerAgg.get(stat.reviewerRef) ?? {
              total: 0,
              sum: 0,
            }
            agg.total += stat.total
            agg.sum += stat.instruction + stat.accuracy + stat.completeness
            reviewerAgg.set(stat.reviewerRef, agg)
          }
          lines.push(
            `- ${refFor(stat.model.providerID, stat.model.id)}: ${avg.toFixed(2)}/5 (${stat.total} ${tr("件", "entries")}, reviewer ${stat.reviewerRef ?? "-"})`,
          )
        }
        // Distribution per reviewer model (for detecting self-scoring bias, risk 2)
        if (reviewerAgg.size > 1) {
          lines.push(tr("審査モデル別(shadow):", "By reviewer model (shadow):"))
          for (const [reviewer, agg] of reviewerAgg) {
            const avg = agg.sum / Math.max(agg.total * 3, 1)
            lines.push(
              `- reviewer ${reviewer}: ${avg.toFixed(2)}/5 (${agg.total} ${tr("件", "entries")})`,
            )
          }
        }
        // skip log (A-2): the fact that a review could not run
        const skip = await loadAutoSkip()
        if (skip && skip.total > 0) {
          lines.push(
            tr(
              `内部審査スキップ: ${skip.total} 件`,
              `Auto-review skips: ${skip.total}`,
            ),
          )
          for (const r of skip.recent) {
            lines.push(`- ${r.at} ${r.reviewerRef} (${r.reason})`)
          }
        }
        // shadow vs human divergence (reconciliation, completion criterion of A-4 "|divergence| < 1.0")
        const divergences: string[] = []
        for (const entry of globalFeedbackEntries) {
          const fstat = entry.value as FeedbackStat
          if (fstat.count <= 0) continue
          const ref = refFor(fstat.model.providerID, fstat.model.id)
          const autoAvg = autoAvgByRef.get(ref)
          if (autoAvg === undefined) continue
          const humanAvg = fstat.ratingSum / fstat.count
          const delta = autoAvg - humanAvg
          const flag = Math.abs(delta) >= 1.0 ? " ⚠" : ""
          divergences.push(
            tr(
              `- ${ref}: shadow ${autoAvg.toFixed(2)} vs 人間 ${humanAvg.toFixed(2)} (差 ${delta >= 0 ? "+" : ""}${delta.toFixed(2)})${flag}`,
              `- ${ref}: shadow ${autoAvg.toFixed(2)} vs human ${humanAvg.toFixed(2)} (delta ${delta >= 0 ? "+" : ""}${delta.toFixed(2)})${flag}`,
            ),
          )
        }
        if (divergences.length > 0) {
          lines.push(
            tr(
              "乖離(shadow − 人間、|差|≥1.0 は要確認):",
              "Divergence (shadow − human, |delta| ≥ 1.0 needs review):",
            ),
            ...divergences,
          )
        }
      }

      // Topology observation (v0.7a): execution results per judged shape
      const topologyPage = await ctx.storage.scan({
        prefix: TOPOLOGY_PREFIX,
        limit: 100,
      })
      const topologyEntries = topologyPage.entries.filter(
        (entry) => !entry.key.startsWith(TASK_TOPOLOGY_PREFIX),
      )
      // Independent-audit auto-review (v1.0): weight in routing quality
      lines.push(
        tr(
          cfg.autoReviewWeight > 0
            ? `自動監査重み: ${cfg.autoReviewWeight} (品質項内。N≥${AUTO_REVIEW_MIN_SAMPLES} 未満は中立 / 乖離|Δ|≥1.0 では半減)。0 で無効。`
            : `自動監査重み: 0 (無効; shadow 表示のみ)。`,
          cfg.autoReviewWeight > 0
            ? `audit weight: ${cfg.autoReviewWeight} (within the quality term. Below N≥${AUTO_REVIEW_MIN_SAMPLES} it is neutral / halved when |Δ|≥1.0). 0 disables it.`
            : `audit weight: 0 (disabled; shadow display only).`,
        ),
      )
      if (topologyEntries.length > 0) {
        lines.push(
          tr(
            `(トポロジー選定スコア重み: Jev事前 w1=${cfg.topologyWeightJev}${jevAvailable() ? "" : " (キー無しのため w1=0 運用)"} / コスパ w2=${cfg.topologyWeightHumanCP} / 自動観測 w3=${cfg.topologyWeightAuto} / 探索 ε=${cfg.topologyExploreRate})`,
            `(topology score weights: Jev prior w1=${cfg.topologyWeightJev}${jevAvailable() ? "" : " (no key, so w1=0)"} / cost-performance w2=${cfg.topologyWeightHumanCP} / auto observation w3=${cfg.topologyWeightAuto} / exploration ε=${cfg.topologyExploreRate})`,
          ),
        )
        lines.push(
          cfg.chainMode === "active"
            ? tr(
                "(chain 実行: active — sequential-chain 選択時に planner を実行し計画を system 参照として注入)",
                "(chain execution: active — when sequential-chain is chosen, a planner runs and its plan is injected as system reference)",
              )
            : tr(
                "(chain 実行: off — 判定と記録のみ / /fusion-chainmode で切替)",
                "(chain execution: off — decision and recording only / toggle with /fusion-chainmode)",
              ),
        )
        // Tier routing (v0.8): show mode and per-tier aggregates.
        // Aggregates are derived values summing overall stats of tier members (no extra storage)
        if (cfg.tierMode !== "off") {
          const tiers = resolveTiers()
          if (!tiers) {
            lines.push(
              tr(
                `(ティア: mode=${cfg.tierMode} — 導出不可(auto はベンチマーク3件以上が必要)/ 従来選択で動作)`,
                `(tiers: mode=${cfg.tierMode} — cannot derive (auto needs at least 3 benchmarks) / using legacy selection)`,
              ),
            )
          } else {
            lines.push(
              tr(
                `(ティア: mode=${cfg.tierMode} / 負荷帯 Light/Middle/Heavy → 該当層から上方カスケード)`,
                `(tiers: mode=${cfg.tierMode} / load band Light/Middle/Heavy → cascade upward from the matching tier)`,
              ),
            )
            const tierLines: string[] = []
            for (const tier of TIER_NAMES) {
              let success = 0
              let failure = 0
              let totalMs = 0
              for (const raw of tiers[tier]) {
                const slash = raw.indexOf("/")
                if (slash <= 0) continue
                const stat = await loadStat(
                  raw.slice(0, slash),
                  raw.slice(slash + 1),
                )
                if (!stat) continue
                success += stat.success
                failure += stat.failure
                totalMs += stat.totalMs
              }
              const n = success + failure
              const okPct = n > 0 ? Math.round((success / n) * 100) : 0
              const avgMs = n > 0 ? Math.round(totalMs / n) : 0
              tierLines.push(
                tr(
                  `- ${tier}: ${tiers[tier].length} モデル (${tiers[tier].join(", ") || "空"}) / ${n} req / ok ${okPct}% / avg ${avgMs} ms`,
                  `- ${tier}: ${tiers[tier].length} model(s) (${tiers[tier].join(", ") || "empty"}) / ${n} req / ok ${okPct}% / avg ${avgMs} ms`,
                ),
              )
            }
            lines.push(tr("ティア別集計:", "Per-tier totals:"), ...tierLines)
          }
        } else {
          lines.push(
            tr(
              "(ティア: off — 全候補から選択 / /fusion-tiermode で切替)",
              "(tiers: off — selecting from all candidates / toggle with /fusion-tiermode)",
            ),
          )
        }
        lines.push(tr("トポロジー(観測):", "Topologies (observed):"))
        for (const entry of topologyEntries) {
          const stat = entry.value as TopologyStat
          if (stat.count <= 0) continue
          const okPct = Math.round((stat.ok / stat.count) * 100)
          const avgMs = Math.round(stat.totalMs / stat.count)
          const q = stat.qualityCount > 0
            ? `quality ${(stat.sumQuality / stat.qualityCount).toFixed(2)}/5 (${stat.qualityCount})`
            : "quality -"
          const cp = stat.costPerformanceCount > 0
            ? tr(
                `コスパ ${(stat.sumCostPerformance / stat.costPerformanceCount).toFixed(2)}/5 (${stat.costPerformanceCount})`,
                `cost-perf ${(stat.sumCostPerformance / stat.costPerformanceCount).toFixed(2)}/5 (${stat.costPerformanceCount})`,
              )
            : tr("コスパ -", "cost-perf -")
          const prior = stat.jevPriorCount > 0
            ? tr(
                `jev事前 ${(stat.sumJevPrior / stat.jevPriorCount).toFixed(2)} (${stat.jevPriorCount})`,
                `jev prior ${(stat.sumJevPrior / stat.jevPriorCount).toFixed(2)} (${stat.jevPriorCount})`,
              )
            : tr("jev事前 -", "jev prior -")
          const aux = stat.auxCalls > 0
            ? tr(
                ` / aux ${stat.auxCalls}回(${Math.round(stat.auxMs / stat.auxCalls)}ms)`,
                ` / aux ${stat.auxCalls} calls (${Math.round(stat.auxMs / stat.auxCalls)}ms)`,
              )
            : ""
          lines.push(
            tr(
              `- ${stat.topology}: ${stat.count} 回 / ok ${okPct}% / avg ${avgMs} ms / ${q} / ${cp} / ${prior}${aux} / score ${topologyScore(stat, jevAvailable()).toFixed(3)}`,
              `- ${stat.topology}: ${stat.count} runs / ok ${okPct}% / avg ${avgMs} ms / ${q} / ${cp} / ${prior}${aux} / score ${topologyScore(stat, jevAvailable()).toFixed(3)}`,
            ),
          )
        }
      }

      const taskPage = await ctx.storage.scan({
        prefix: TASK_STAT_PREFIX,
        limit: 500,
      })
      if (taskPage.entries.length > 0) {
        lines.push(tr("タスク種別統計", "Per-category statistics"))
        const byCategory = new Map<string, string[]>()
        for (const entry of taskPage.entries) {
          const stat = entry.value as Stat
          const category = entry.key.split("/")[2] ?? "?"
          const n = stat.success + stat.failure
          const rate = n > 0 ? ((stat.success / n) * 100).toFixed(0) : "-"
          const avg = n > 0 ? Math.round(stat.totalMs / n) : 0
          const line = `- ${refFor(stat.model.providerID, stat.model.id)}: ${n} req / ok ${rate}% / avg ${avg} ms`
          const bucket = byCategory.get(category) ?? []
          bucket.push(line)
          byCategory.set(category, bucket)
        }
        for (const [category, bucket] of byCategory)
          lines.push(`[${category}]`, ...bucket)
      }

      if (routeLog.length > 0) {
        lines.push(
          tr("(ルーティングログ:)", "(routing log:)"),
          ...routeLog.map((l) => `- ${l}`),
        )
      }
      return lines.join("\n")
    }

    const resetStats = async (): Promise<void> => {
      for (const prefix of [
        STAT_PREFIX,
        TASK_STAT_PREFIX,
        TASK_FEEDBACK_PREFIX,
        FEEDBACK_PREFIX,
        AUTO_PREFIX,
        TASK_AUTO_PREFIX,
        AUTO_SKIP_PREFIX,
        TOPOLOGY_PREFIX,
        TASK_TOPOLOGY_PREFIX,
        // v1.1: variant outcome learning (B6) — reset clears it too
        VARIANT_PREFIX,
      ]) {
        // v1.1.1: page through the whole prefix (>500 keys left residue before)
        for (;;) {
          const page = await ctx.storage.scan({ prefix, limit: 500 })
          for (const entry of page.entries) await ctx.storage.remove(entry.key)
          if (page.entries.length < 500) break
        }
      }
      // クールダウン(利用不可フラグ)もクリア
      // v0.8.1: マージ方式の persist に削除が反映されるよう tombstone 化。
      // 他インスタンスが stale map で再書き込みしても復活しないようにする。
      const tnow = Date.now()
      for (const [ref] of cooldowns) tomb(`m:${ref}`)
      for (const [id] of providerCooldowns) tomb(`p:${id}`)
      for (const [sid] of rescueAttempts) rescueTombstones.set(sid, tnow)
      cooldowns.clear()
      providerCooldowns.clear()
      await ctx.storage.remove(COOLDOWN_KEY)
      // rescue 復帰待機も全クリア
      rescueAttempts.clear()
      await ctx.storage.remove(RESCUE_KEY)
      // v1.1.1: レビューのターン別メタ+評価済みマーカーもクリア
      // (統計リセット後は各ターンを再度評価できるようにする。分類の割当て自体は残す)
      try {
        // v1.1.1: page through every review record (>500 sessions left residue)
        for (;;) {
          const reviewPage = await ctx.storage.scan({
            prefix: REVIEW_PREFIX,
            limit: 500,
          })
          for (const entry of reviewPage.entries) {
            const value = entry.value as Record<string, unknown>
            if (!value || typeof value !== "object") continue
            if (!("turns" in value)) continue
            const { turns: _drop, ...rest } = value
            await ctx.storage.set(entry.key, rest)
          }
          if (reviewPage.entries.length < 500) break
        }
      } catch {
        // レビュー記録のクリア失敗は統計リセットを妨げない
      }
      // sequential-chain の実行状態もクリア
      chainPending.clear()
      chainPlans.clear()
      // 負荷帯(v0.8 ティアルーティング)もクリア
      sessionLoad.clear()
      // variant自動選択のeffortヒント(v1.1)もクリア
      sessionEffort.clear()
      // attempt-aware rescue の状態も全クリア (A1-5)
      attemptFailures.clear()
      lastHttpFailure.clear()
      rescueSwitchedAt.clear()
      rescueInFlight.clear()
      // in-flight recovery probes also stop re-marking cooldowns after reset
      verifyingNow.clear()
      lastResolved.clear()
    }

    // Partial config update (only validated values are applied and saved)
    const applyConfigUpdate = (update: Record<string, unknown>) => {
      if (typeof update.enabled === "boolean") cfg.enabled = update.enabled
      if (typeof update.providerID === "string" && update.providerID.length > 0) {
        // When the provider changes, the whitelist contains old provider model IDs, so it should be cleared by default.
        // However, if update.models is provided, that takes precedence.
        if (update.providerID !== cfg.providerID && !("models" in update))
          cfg.models = []
        cfg.providerID = update.providerID
        // v1.1.1: /fusion-provider returns to single-provider mode — a chain
        // pointing at the old primary would silently override the new one.
        if (!("providerChain" in update)) cfg.providerChain = []
        // Single-provider mode and crossProvider are mutually exclusive.
        if (!("crossProvider" in update)) cfg.crossProvider = false
      }
      if (typeof update.crossProvider === "boolean") {
        // Switching crossProvider changes the whitelist format (model IDs vs provider/model-ids), so clear by default.
        // However, if update.models is provided, that takes precedence.
        if (update.crossProvider !== cfg.crossProvider && !("models" in update))
          cfg.models = []
        cfg.crossProvider = update.crossProvider
      }
      // v1.1.1: provider chain update. Empty array clears the chain (back to
      // single-provider routing). A non-empty chain mirrors chain[0] into
      // providerID and clears crossProvider (mutually exclusive modes).
      if (Array.isArray(update.providerChain)) {
        const chain = sanitizeProviderChain(update.providerChain)
        cfg.providerChain = chain
        if (chain.length > 0) {
          // Same rule as a plain providerID change: mirroring chain[0] into
          // providerID is a provider change, so a stale list from the old
          // provider is cleared unless the update carries its own models.
          if (!("providerID" in update)) {
            if (chain[0] !== cfg.providerID && !("models" in update))
              cfg.models = []
            cfg.providerID = chain[0]
          }
          cfg.crossProvider = false
        }
      }
      // v1.2.1: chain promotion toggle
      if (typeof update.chainPromote === "boolean")
        cfg.chainPromote = update.chainPromote
      if (typeof update.exploreRate === "number") cfg.exploreRate = clamp(update.exploreRate, 0, 1)
      if (typeof update.learningRate === "number") cfg.learningRate = clamp(update.learningRate, 0, 1)
      if (typeof update.minObservations === "number") cfg.minObservations = Math.max(1, Math.floor(update.minObservations))
      if (typeof update.costWeight === "number") cfg.costWeight = clamp(update.costWeight, 0, 1)
      if (typeof update.latencyWeight === "number") cfg.latencyWeight = clamp(update.latencyWeight, 0, 1)
      if (typeof update.maxInputCost === "number") cfg.maxInputCost = Math.max(0, update.maxInputCost)
      if (typeof update.maxOutputCost === "number") cfg.maxOutputCost = Math.max(0, update.maxOutputCost)
      if (typeof update.benchmarkPriorWeight === "number") cfg.benchmarkPriorWeight = Math.max(0, update.benchmarkPriorWeight)
      if (typeof update.benchmarksFile === "string") cfg.benchmarksFile = update.benchmarksFile
      if (typeof update.benchAutoUpdate === "boolean")
        cfg.benchAutoUpdate = update.benchAutoUpdate
      if (update.jevMode === "auto" || update.jevMode === "off") cfg.jevMode = update.jevMode
      if (update.topologyMode === "auto" || update.topologyMode === "fixed") cfg.topologyMode = update.topologyMode
      if (typeof update.maxTopologyCalls === "number") cfg.maxTopologyCalls = clamp(Math.floor(update.maxTopologyCalls), 1, 16)
      if (typeof update.topologyWeightJev === "number") cfg.topologyWeightJev = clamp(update.topologyWeightJev, 0, 1)
      if (typeof update.topologyExploreRate === "number") cfg.topologyExploreRate = clamp(update.topologyExploreRate, 0, 1)
      if (typeof update.topologyPriorStrength === "number") cfg.topologyPriorStrength = Math.max(1, Math.min(20, Math.floor(update.topologyPriorStrength)))
      if (typeof update.topologyWeightHumanCP === "number") cfg.topologyWeightHumanCP = clamp(update.topologyWeightHumanCP, 0, 1)
      if (typeof update.topologyWeightAuto === "number") cfg.topologyWeightAuto = clamp(update.topologyWeightAuto, 0, 1)
      if (update.chainMode === "active" || update.chainMode === "off") cfg.chainMode = update.chainMode
      if (
        update.tierMode === "off" ||
        update.tierMode === "manual" ||
        update.tierMode === "auto"
      )
        cfg.tierMode = update.tierMode
      if (update.tiers && typeof update.tiers === "object") {
        // v1.1.1: merge per tier — only tiers present in the update change.
        // The /fusion-tiers dialog omits empty tiers (meaning "unchanged"),
        // and a whole-object replace cleared them against that promise.
        const incoming = update.tiers as Record<string, unknown>
        for (const tier of ["heavy", "middle", "light"] as const) {
          if (!Array.isArray(incoming[tier])) continue
          if (!incoming[tier].every((m) => typeof m === "string")) continue
          cfg.tiers[tier] = sanitizeTiers({
            [tier]: incoming[tier] as string[],
          })[tier]
        }
      }
      if (
        update.variantMode === "off" ||
        update.variantMode === "auto" ||
        update.variantMode === "fixed"
      )
        cfg.variantMode = update.variantMode
      if (typeof update.variantFixed === "string")
        cfg.variantFixed = update.variantFixed.length > 0 ? update.variantFixed : null
      if (update.variantFixed === null) cfg.variantFixed = null
      if (typeof update.variantExploreRate === "number") cfg.variantExploreRate = clamp(update.variantExploreRate, 0, 1)
      if (
        Array.isArray(update.allowedTopologies) &&
        update.allowedTopologies.every((t) => typeof t === "string")
      ) {
        const filtered = (update.allowedTopologies as string[]).filter((t) =>
          KNOWN_TOPOLOGIES.includes(t),
        )
        cfg.allowedTopologies = filtered.length > 0 ? filtered : ["single"]
      }
      // v1.1.1: kinds updates were silently dropped (rpc accepted them).
      // Mutate in place — `kinds` is captured by reference elsewhere.
      if (Array.isArray(update.kinds) && update.kinds.every((k) => typeof k === "string") && (update.kinds as string[]).length > 0) {
        cfg.kinds.length = 0
        cfg.kinds.push(...(update.kinds as string[]))
      }
      if (typeof update.classifierModel === "string") {
        cfg.classifierModel =
          update.classifierModel.includes("/") ? update.classifierModel : null
      }
      // v1.1.1: explicit null clears (mirrors variantFixed)
      if (update.classifierModel === null) cfg.classifierModel = null
      if (typeof update.reviewModel === "string") {
        // Empty string means the review model is unset (= revert to classifierModel / shared fallback)
        if (update.reviewModel.length === 0) cfg.reviewModel = null
        else if (update.reviewModel.includes("/"))
          cfg.reviewModel = update.reviewModel
      }
      if (update.reviewModel === null) cfg.reviewModel = null
      if (Array.isArray(update.models) && update.models.every((m) => typeof m === "string"))
        cfg.models = update.models as string[]
      // v1.1.1: whitelist/blacklist interpretation of the model list
      if (update.listMode === "whitelist" || update.listMode === "blacklist")
        cfg.listMode = update.listMode
      // Display language (v0.9.0). Default per install is options.lang,
      // but the switch with /fusion-lang is persisted and reflected in later display.
      if (update.lang === "ja" || update.lang === "en") cfg.lang = update.lang
      if (typeof update.autoReviewWeight === "number")
        cfg.autoReviewWeight = clamp(update.autoReviewWeight, 0, 1)
      if (typeof update.rescueAttemptsBeforeSwitch === "number")
        cfg.rescueAttemptsBeforeSwitch = Math.max(
          1,
          Math.min(10, Math.floor(update.rescueAttemptsBeforeSwitch)),
        )
    }

    // 永続化用(jevAvailable のような導出値は保存しない)
    const configPersisted = () => ({ ...cfg })
    // RPC 応答用(導出値を含む表示スナップショット)
    const configSnapshot = () => ({
      ...cfg,
      jevAvailable: jevAvailable(),
    })

    await ctx.rpc.register(AdaptiveFusion, {
      stats: async () => ({ text: await buildStatsText() }),
      probe: async () => ({ text: await runProbe() }),
      toggle: async () => {
        cfg.enabled = !cfg.enabled
        await ctx.storage.set(CONFIG_KEY, configPersisted())
        return { enabled: cfg.enabled }
      },
      reset: async () => {
        await resetStats()
        return {}
      },
      config: async (input) => {
        const update = (input as any)?.update
        if (update && typeof update === "object") {
          applyConfigUpdate(update as Record<string, unknown>)
          await ctx.storage.set(CONFIG_KEY, configPersisted())
        }
        return { config: configSnapshot() }
      },
      jevKey: async (input) => {
        const raw = (input as any)?.key
        const key = typeof raw === "string" ? raw.trim() : undefined
        if (key !== undefined) {
          // 空文字は登録解除(storage 上は空文字で無効化し、環境変数があればそちらを優先)
          if (key.length === 0) jevStoredKey = undefined
          else jevStoredKey = key
          await ctx.storage.set(JEV_KEY_KEY, jevStoredKey ?? "")
          logRoute(key.length === 0 ? "JEV key cleared" : "JEV key stored")
        }
        // キー自体は絶対に返さない。利用可否だけを返す
        return { available: jevAvailable() }
      },
      reviewInfo: async (input) => {
        const snapshot = await reviewSnapshot(
          String((input as any)?.sessionID ?? ""),
          normalizeOffset((input as any)?.offset),
        )
        const reqCategory = (input as any)?.category
        const reqSession = (input as any)?.sessionID
        const dist = await bayesianTopologyDistribution(
          typeof reqCategory === "string" ? reqCategory : undefined,
          sessionLoad.get(String(reqSession ?? "")),
        )
        return {
          ...snapshot,
          topologyRewards: { distribution: dist },
        }
      },
      reviewSummary: async (input) => ({
        text: await reviewSummary(
          String((input as any)?.sessionID ?? ""),
          normalizeOffset((input as any)?.offset),
        ),
      }),
      reviewRate: async (input) => {
        const raw = input as any
        const rating =
          raw?.rating === undefined ? undefined : Number(raw.rating)
        const topologyRating =
          raw?.topologyRating === undefined
            ? undefined
            : Number(raw.topologyRating)
        return await reviewRate(
          String(raw?.sessionID ?? ""),
          rating,
          topologyRating,
          normalizeOffset(raw?.offset),
        )
      },
    })

    // All definitions the event watch closes over are initialized now —
    // safe to start consuming failure events (A1-10).
    startEventWatch()

    return () => {
      abortEventWatch.abort()
      pending.clear()
      lastResolved.clear()
      cooldownTombstones.clear()
      rescueTombstones.clear()
      sessionCategory.clear()
      sessionTopology.clear()
      sessionLoad.clear()
      sessionEffort.clear()
      attemptFailures.clear()
      lastHttpFailure.clear()
      rescueSwitchedAt.clear()
      rescueInFlight.clear()
      chainPending.clear()
      chainPlans.clear()
    }
  },
})
