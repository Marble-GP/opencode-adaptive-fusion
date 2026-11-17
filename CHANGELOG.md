# Changelog

## [Unreleased] — v1.1.0 (in development)

### Added
- **Task-shape topology prior (v1.1)**: topology selection no longer relies on
  Jev alone (or on a track record that could never accumulate for non-single
  shapes). A deterministic prior built from the load band (light/middle/heavy)
  and the category nudges heavy or analytically shaped tasks (`research` /
  `coding` / `writing` / `debugging`) toward `sequential-chain` and
  `review` / `ops` toward `single`. The prior is multiplied by `(0.5 + D-4
  score)` when ≥ 3 observations exist for the category, then normalized.
- **Jev blend**: with a Jev key, its Choice distribution is blended with the
  prior — `(1 - topologyWeightJev) × heuristic + topologyWeightJev × Jev`
  (default 0.5/0.5) instead of the confidence-threshold fallback to single.
- **`topologyExploreRate` (default 0.1)**: ε-greedy exploration — with this
  probability a non-greedy allowed topology is adopted, so non-single shapes
  can accumulate track records. Configurable via plugin options, the config
  RPC, and `/fusion-weights` (`topoexplore`).
- **`topologyPriorStrength` (default 4, 1..20)**: pseudocount of the Bayesian
  prior on topology rewards. Configurable via plugin options, the config RPC,
  and `/fusion-weights` (`topo-prior`).
- **Attempt-aware rescue (`rescueAttemptsBeforeSwitch`, default 3, 1..10)**:
  transient failures no longer trigger an immediate model switch. Consecutive
  failed attempts are counted per session/model (10 min window); rescue only
  runs after the threshold is reached. `session.retry.scheduled` events are
  treated as retry announcements, not terminal failures — they keep the
  attempt counter in sync and never switch models. Definitive signals
  (`Model unavailable`, quota) still rescue immediately because retrying them
  cannot succeed. Configurable via plugin options, the config RPC, and
  `/fusion-params` (`rescuattempts`).
- **Reasoning-effort (thinking level) selection (`variantMode`, default
  `auto`; also `fixed`)**: model first, then variant. After routing/tier
  selection has picked the model, the effort level (0 low / 1 medium / 2
  high) is **asked from Jev in the same round trip as task classification**
  (no extra API call; the legacy LLM classifier and the load band are the
  fallbacks), then compensated against the chosen model's weight class —
  matched pairs keep the provider default, a task heavier than the model
  compensates with the highest variant (`variantLevelFor`/`variantLevelForLevel`
  clamps the delta to 0..2), a task lighter than the model drops to the
  lowest for cost. Model class is the tier membership (manual or
  benchmark-derived auto tiers) or the benchmark overall score. The variant
  id itself is positional over the model's own list ranked by an effort scale
  (`variantEffortRank`, unknown ids mid), so provider-specific naming does not
  matter; a model with fewer than 2 variants is left untouched. Two
  anti-ossification mechanisms: ε-greedy exploration
  (`variantExploreRate`, default 0.1) samples non-computed variants, and a
  closed-loop bandit over the adjacent effort levels — per-(model, variant)
  ok-rates (`fusion/variant/*`, visible in `/fusion-stats`; no-override
  dispatches are recorded under the synthetic `#default`) compete with the
  computed pick on Laplace-smoothed ok-rate, so a hint or band rule that
  keeps producing failures demotes itself to an adjacent level and can never
  lock the session into a poorly performing effort. `variantMode=fixed` (UI:
  select
  in `/fusion-variantmode`, e.g. `high`) forces one variant for every
  same-provider dispatch where the model exposes it. The user's explicit
  variant (`ctrl+t`, agent config, session ref) always wins, and rescue
  switches keep the target model's default variant. Tune with
  `/fusion-params` (`varexplore`).
- **`/fusion-params`**: `/fusion-weights` renamed — the editor now covers
  non-weight knobs too (`topocalls`, `topo-prior`, `rescuattempts`,
  `costin`/`costout`). The old `/fusion-weights` name keeps working as an
  alias.
- **Slash-command cleanup**: `/fusion-audit` and `/fusion-costcap` removed —
  both are covered by `/fusion-params` (`audit`, `costin`/`costout`). The
  command set is now 15 entries, each with a unique job: display
  (`stats`, `config`, `lang`), routing control (`toggle`, `provider`,
  `whitelist`), coefficient tuning (`params`), mode selectors
  (`chainmode`, `variantmode`, `tiermode`), list/string editors (`tiers`,
  `reviewmodel`, `jev-key`) and actions (`review`, `probe`, `reset`).

### Changed
- Topology selection logs now carry the blended distribution and the selection
  trace (`heuristic` / `blend` / `explore`) in `/fusion-stats`'s route log
  instead of only `TOPOLOGY single`.
- Route log now records the wait-for-retry decision (`WAIT ... attempt n/N`,
  `RETRY ... attempt n/N (no switch)`) so switch storms are diagnosable, the
  effort hint (`EFFORT hint <low|medium|high> via jev/llm`) asked in the
  classification round trip, and the variant choice as
  `VARIANT <kind> <ref> -> #<id> (<note>, load=<band>, hint=<0..2>)` — the
  note distinguishes `explore`, `matched <class> (provider default)`,
  `fixed`, compensated levels and `learned` upgrades — plus
  `VARIANT obs <ref>#<variant> ok/fail (n/N)` for the per-variant learning
  records.

### Fixed
- Frequent "Switched model to ..." churn: the after-fail event handler
  previously treated every `session.retry.scheduled` (core retry
  announcement) as a terminal failure, cooling the model down and switching
  on each retry. Retries now wait for the attempt budget; a rescue switch
  also suppresses a second switch for the same failure episode (15 s).

## [1.0.0] - 2026-11-17

### Added
- **Audit auto-review in routing scores (`autoReviewWeight`)**: the independent
  audit model (`reviewModel`, a separate harness — not self-scoring) can feed the
  quality term of the routing score with weight `0..1` (`0` = shadow display only,
  default preserved). Sample gate (N ≥ 10), quality axes only (`efficiency`
  excluded), and a divergence guard that halves the weight when shadow/human
  `|Δ| ≥ 1.0`. New command `/fusion-audit`, new `autoReviewWeight` config field.
- **Full-turn cost model**: the routing cost penalty now compares
  `input + output + cache.read + cache.write` unit prices (USD/1M tokens)
  instead of output price alone.
- **OFF stops every model switch**: `/fusion-toggle` OFF previously kept the
  rescue path active (cooling models were still switched away). OFF now stops
  all user-visible behavior — routing, pre-prompt rescue, after-fail rescue
  and rescue-restore never touch the session model while disabled — while
  passive learning (observation stats, task classification, shadow review,
  cooldown/recovery probes) keeps running in the background, so nothing is
  lost while paused and re-enabling is instant.
- **Benchmark library auto-refresh (`benchAutoUpdate`)**: while fusion is ON,
  the benchmark priors are refreshed from the public OpenRouter models API
  (`artificial_analysis` indices, same ÷100 normalization as the seed file) at
  most once per day, judged at the start of each turn. The fetched snapshot is
  persisted to OpenCode storage (`fusion/benchmarks`) and takes precedence over
  the bundled seed; non-OpenRouter keys are retained. Any failure keeps the
  previous snapshot (fail-safe), and `/fusion-stats` reports the last result.
- **`/fusion-weights`**: adjust the routing/topology weights that were
  previously only reachable through `opencode.json` options — five presets
  (`balanced`, `cost-first`, `quality-first`, `snappy`, `audit-on`) plus a
  `custom` editor: a searchable picker of all eleven tunables (`cost`,
  `latency`, `explore`, `learning`, `minobs`, `bench`, `audit`, `topojev`,
  `topocp`, `topoauto`, `topocalls`) with per-option help descriptions and
  range-validated, prefilled prompts.

### Fixed
- **Probe strictness**: the recovery probe (`Reply with exactly: OK`) now
  requires an exact `OK` reply; any other non-empty answer is treated as a
  failure, because a model that cannot follow a trivial instruction is not
  evidence of recovery.
- **Startup race (`rpc.unavailable`)**: TUI RPC calls now retry briefly while
  the server-side plugin finishes loading, so commands run immediately after a
  restart no longer fail with "RPC unavailable".
- **RPC schema**: the `config` output now declares `classifierModel` as
  `string | null`, matching what the server stores when no classifier model is
  configured.

### Changed
- README: routing score section documents the three quality sources and their
  gates; topology section now states that only `sequential-chain` is a genuinely
  different execution mode (`single`/`router` share classification and selection).

## [0.9.1] - 2026-11-15

Packaging and release hygiene. No functional changes to the plugin logic.

### Added
- **Repository-root `package.json`**: the repository itself is now a valid OpenCode
  plugin package — `exports` maps `.` / `./server` / `./tui` / `./rpc` into
  `plugins/adaptive-fusion/`, and the published tarball packs `plugins/` and
  `data/` (including the `data/benchmarks.json` seed). Git/CLI installs work
  out of the box:
  `opencode plugin add 'github:Marble-GP/opencode-adaptive-fusion#v0.9.1'`
- README: installation via the OpenCode CLI (`opencode plugin add` / `list` /
  `update` / `remove`), in addition to the clone-and-register method.
- README: verified tarball contents with `npm pack --dry-run`.

### Changed
- Source comments in `plugins/adaptive-fusion/*.ts(x)` translated from Japanese to
  English for the open-source release. No code, identifiers, regular expressions,
  or user-facing strings were changed.

## [0.9.0] - 2026-11-15

Review-focused release. Verified live against OpenCode 2.3 on Windows.

### Added
- **Localized UI (Japanese / English)**: every command title, dialog, toast and
  statistics line follows a `lang` setting (`"ja"` / `"en"`). Choose the default per
  installation with the `lang` plugin option, or switch at runtime with `/fusion-lang`
  (persisted). The configured language also drives the summary and shadow auto-review
  prompt wording.
- **Retroactive review (`offset`)**: `/fusion-review` can target `0 = latest`,
  `1 = one turn back`, `2 = two turns back`, … so older responses can be rated after a
  bug surfaces. Navigate with `[◀ older]` / `[▶ newer]` inside the panel.
  `reviewInfo` / `reviewSummary` / `reviewRate` RPC methods accept an optional
  `offset` (number, default 0).
- **Turn statistics**: per-turn input/output/reasoning/cache-read tokens, cost (USD),
  measured latency and measured throughput (tok/s) in the review panel. Derived from
  the tokens/cost/timestamps recorded on each message, so **past turns are computed
  retroactively**.
- **Results enumeration (`results`)**: shadow auto-review now lists what the response
  actually accomplished (files created/changed, commands executed, answers and values
  given) with evidence instead of generic praise. Displayed in the review panel.
- **Cost-efficiency axis (`efficiency`, 1–5)**: fourth auto-review axis, judged with
  the turn statistics in the prompt (tokens, latency, tok/s, cost).
- Review panel layout: restored dialog height, prevented mid-word wrapping, added
  topology and load-band display.

### Changed
- Auto-review prompt redesigned for four axes + `results`. JSON extraction now uses
  brace-balanced parsing so multi-line output with a `results` array is never truncated.
  Legacy three-axis outputs still parse.
- `AutoReviewStat` gains `efficiency`, `efficiencyCount` and `results` (old records are
  treated as "not collected").

### Compatibility
- All new RPC schema keys are optional; existing storage data and outputs remain
  compatible.

## [0.8.1] - 2026-11-15

Robustness release. Fixes confirmed by live reproduction experiments.

### Fixed
- OpenCode 2.3's `experimental.model.resolve` only resolves a rewrite **within the same
  provider** (the core resolves only when `providerID` is unchanged). Cross-provider
  moves now go through `ctx.session.switchModel` (the same path as manual model
  selection) and apply from the next dispatch — the **DEFER path**. Ordinary routing
  skips cross-provider rewrites (`KEEP`) to keep caches warm.
- **Stale instance overwriting `fusion/cooldowns`** (OpenCode can load two `role=server`
  plugin instances): persistence now **merges into the stored kv value** instead of
  overwriting it, with tombstones (25 h TTL) so deletions stick and `/fusion-reset`
  cannot be undone by a stale writer.
- Pre-prompt rescue did nothing on sessions whose `session.model` was unset (new
  sessions). The resolve hook now records the actually-dispatched model in
  `lastResolved`, used as a fallback by pre-prompt rescue (`PRE hint`) and by
  `step.failed` attribution — preventing a second consecutive failure on a dead default
  model and preventing healthy models from being cooled down by mistake.
- TUI toggle ↔ server re-sync on the `prompt` hook (`CONFIG synced` log).

### Added
- **Verified cooldowns**: a 1-hour quota timer expiring does not mean recovery.
  Cooldowns with `needsVerify` are lifted only after a live probe
  (`Reply with exactly: OK`) succeeds; a failed probe extends the cooldown by another
  hour.
- `RECOVER ok <ref>` logging when a success clears a cooldown, `logRoute` for
  `after-fail` failures, and the routing log history enlarged from 20 to 200 entries.

## [0.8.0] - 2026-11-14

- **Tier routing**: candidates are selected within a tier for the task's load band
  (Light/Middle/Heavy). Tiers are user-defined (`manual`) or benchmark-split (`auto`).
  Depleted tiers cascade upward; a fully depleted set falls back to normal selection.
  Disabled by default.

## [0.7a] - 2026-11-14

- Jev (TypeSafe System One) task classification and topology choice
  (confidence < 0.7 degrades), heuristic topology-score degradation, D-4 weighted
  topology score composition.
- Sequential-chain auxiliary execution (plan injected via the `context` hook, off by
  default).
- Two-axis review display; topology statistics in `fusion/topology/*`.

## [0.6] - 2026-11-14

- **Shadow auto-review harness**: after a successful `http.response`, a separate model
  scores the request/response pair on three axes and stores results in
  `fusion/auto/*` (display only, not used for scoring). `reviewModel` selects the
  reviewer.
- **Benchmark priors**: `data/benchmarks.json` seeds a Beta prior
  (`benchmarkPriorWeight`, default k = 5) that smooths observed success rates.

## [0.5] - Initial release

- Manual review (three-line summary + 1–5 rating) and cost caps (input/output token
  rate limits when the whitelist is empty; default 0 = free models only).
