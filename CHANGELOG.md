# Changelog

## [1.2.2] - 2026-11-20

### Added
- **Suggested workflow (topology rename + agent-visible hints)**: the
  topology selection is now presented as a *suggested workflow*. Beyond the
  existing planner-plan injection (sequential-chain + chainMode=active),
  every non-single selection now injects a short, non-binding **workflow
  suggestion** into the system context (`WORKFLOW hint ... injected` in the
  route log) — including how to decompose the task and when to consider
  delegating independent parts to sub-agents. The plugin still cannot spawn
  sub-agents itself (OpenCode plugin hooks rewrite models and inject context
  only), but the selection is finally visible to the main agent instead of
  only being recorded in the stats. Display labels renamed
  (トポロジー → ワークフロー); internal config keys are unchanged.
- **`/fusion-provider` promotion toggle**: a `⇄ chain promotion` row in the
  stack editor toggles `chainPromote` interactively (previously RPC/config
  only).
- **`/fusion-whitelist` alias** for `/fusion-modellist` (back-compat with
  the pre-v1.1.1 command name).

### Fixed — workflow/topology selection
- **Neutral, criteria-first Jev prompt**: the old prompt let Jev default to
  `single` for anything ambiguous (98%+ single in production, making the
  feature effectively dead). The new prompt describes when each shape pays
  off and explicitly forbids defaulting to `single` for multi-step tasks.
- **Jev confidence gating enforced**: answers with confidence < 0.7 no
  longer drive the blend (the documented fallback finally exists), and the
  Jev block is exception-safe (a malformed-but-200 payload used to abort
  classification; `confidence.toFixed` could throw).
- **Observation attribution**: the turn's workflow shape/category is
  captured at `http.request` time and threaded through the topology stats,
  auto-review quality and per-turn review metadata — a later prompt (or an
  auto-review completing after the next classify) no longer re-attributes
  the observation to the newer turn's shape. Insertion-order refresh keeps
  the 200-entry session map evicting genuinely old sessions.
- Older never-reviewed turns no longer inherit the session's CURRENT
  workflow/category (conservative default instead); turn metadata upserts
  are awaited; assistant messages without an id get a stable synthetic key
  (marker persistence and re-rating prevention used to be silently
  disabled); review assignments are persisted awaited (race with an
  immediate review).
- Tie-breaking no longer secretly favors `single`; zero-weight score
  display is neutral 0.5; zero Jev probabilities are not recorded as prior
  samples; unknown `allowedTopologies` strings are filtered before the Jev
  summary.

### Fixed — rescue/routing robustness (audit)
- **Emergency expansion is provider-scoped**: single-provider routing no
  longer leaks rescue candidates to every connected provider (the chain /
  crossProvider / single-provider scope now applies to the emergency branch
  too; blacklists still survive).
- **Rescue serialization unified**: the resolve hook's rescue switches now
  claim (`tryClaimRescue`) and mark (`markRescueSwitch`) like every other
  rescue site; `switchSessionIfCooling` honors the 15 s suppression window
  (and marks its own switches, restore included); chain promotion marks its
  switch and only clears a restore ticket that still points at the entry it
  left; the prompt hook no longer early-returns after a promotion (the
  suppression-guarded rescue pass still runs).
- **Definitive failures rescue immediately** even inside the suppression
  window when the session is still dispatched on the failed model; "model
  not found / unknown model / does not exist" messages are definitive too.
- **Quota double-marking deduped**: the event-first race (session.step.failed
  before http.response) no longer marks the same failure twice (failure
  count + cooldown extension were doubled); quota outcomes now feed the
  per-variant bandit as well.
- **Attempt counters reset per episode**: a successful observation clears
  ALL of the session's attempt counters (a recovered model no longer trips
  the gate on its next single failure).
- Map bounds: `lastHttpFailure`/`lastEventFailure` evict oldest past 256
  even inside the window; `pending` and `lastResolved` cap at 200.
- `resolve` and `http.response` hooks are fully exception-safe (an
  unexpected throw used to reject the hook and leave partial state).
- Verification probes re-fetch the cooldown entry (a probe completing after
  a clear/reset can no longer resurrect the dead cooldown); TDZ hazard on
  `rescueTombstones`/`persistRescue` removed (declarations moved above
  their first reference).
- Chain-entry "observed" checks accept task-level stats (matching the
  scoring precedence); candidate filter requires a usable cost tier
  (undefined `cost[0]` poisoned maxCost/scores via Infinity).

### Fixed — variant selection
- `variantLevelForLevel` is self-normalizing (fractional hints used to
  produce fractional levels; aligned with the test mirror).
- A routed model whose explicit variant is unavailable now gets a fusion
  variant (auto mode) instead of dispatching with none.
- Rescue dispatches clear a pre-existing explicit variant ("rescue keeps the
  target's default" now actually holds for the in-flight request).
- ε-exploration never re-samples the computed pick (part of the exploration
  budget was a no-op); `variantFixed` is trimmed in all three config paths;
  the variant stats scan is paginated (was silently capped at 100 rows).

### Fixed — config plumbing
- Provider/crossProvider/chain transitions reset the model list in
  **whitelist mode only** — blacklist exclusions are deliberate and survive
  (the server previously dropped them, contradicting the TUI's promise).
- Enabling `crossProvider` clears a stale provider chain (the chain silently
  won routing otherwise).
- `topologyPriorStrength` added to the `FusionConfig` type (was read/written
  without being declared); invalid `reviewModel` strings clear to null
  (aligned with `classifierModel`); persisted empty `providerID` rejected;
  a restored chain mirrors `chain[0]` into `providerID` when stale; empty
  `kinds` arrays rejected on restore; mixed `allowedTopologies` arrays are
  filtered (not dropped wholesale) on update.

### Fixed — reset hygiene
- `/fusion-reset` now also clears the workflow/category session maps, both
  tombstone maps, in-flight request bookkeeping and the event-side dedupe
  markers (stale entries used to suppress re-creation and re-attribute
  post-reset observations).

## [1.2.1] - 2026-11-19

### Added
- **Chain promotion (`chainPromote`, default ON)**: with routing ON and a
  provider chain set, a session whose current provider sits at a lower chain
  priority than the highest healthy chain entry is switched to that entry
  **once per prompt** (not per dispatch — no provider ping-pong, caches stay
  warm). The target model is the best-scoring candidate within the entry
  (score/warmup logic, no exploration); the promotion does **not** record a
  rescue restore ticket (it is a priority decision, not a rescue — the lower
  entry is still healthy), and any stale ticket pointing at it is cleared so
  the session is not dragged back down next prompt. A later rescue that falls
  through to a lower entry records its own restore ticket for the failed
  higher entry. This fixes the "free
  models keep winning despite `opencode-go` being chain[0]" confusion:
  previously only *rescue* moved sessions across chain entries — a healthy
  session on `opencode`'s free tier never climbed back to the subscription
  tier, because ordinary score routing never rewrites across providers.
  Sessions on providers **outside** the chain are left alone (an explicit
  user choice is respected). Route log: `PROMOTE <ref> -> <ref>
  (chain[i] X > chain[j] Y, score=...)`. Disable with the `chainPromote`
  option (`false`).

## [1.2.0] - 2026-11-18

### Fixed
- **One review per turn (`/fusion-review`)**: a turn could be rated any number
  of times — every button press recorded another sample. Ratings are now
  recorded per target message (`fusion/review/<sessionID>.turns`), re-rating a
  rated turn is rejected server-side, and the panel shows the recorded rating
  instead of the buttons. `/fusion-reset` clears the markers, so turns become
  rateable again after a stats reset.
- **Review offset counts logical turns, not assistant messages**: a tool-using
  response produces several assistant messages, so adjacent offsets landed on
  different steps of the SAME turn and the panel looked stuck (same
  instruction, same stats). Turns are now grouped by user prompt; the target
  is the turn's final response body.
- **Per-turn topology/category in the review panel**: the topology row and its
  stats used the session's CURRENT topology for every offset (identical
  across turns). Each turn's topology/category is now recorded with the turn
  (`fusion/review/<sessionID>.turns`), shown for that turn, and topology
  cost-performance ratings are recorded against the turn's own topology.
  Turns recorded before this fix fall back to the session's current values.

### Added
- **Priority provider chain (`providerChain`, set with `/fusion-provider`)**:
  `/fusion-provider` is now a stack editor — `➕ add a provider` stacks a
  typed id (Enter to add), and each entry can be swapped up/down (priority),
  edited, or removed from its entry menu. One entry keeps the plain
  single-provider behavior; two or more form a priority chain (e.g.
  `opencode-go` -> `opencode` free tier -> `openrouter`): candidates always
  come from the first entry that still has healthy (non-cooling) models;
  when that provider is exhausted (quota / account-wide free-tier cooldown)
  the next entry takes over, and sessions are restored to the original
  provider once it recovers (rescue-restore, 24 h window). Setting a chain
  turns `crossProvider` off. Falls back to the full (emergency-expanded on
  rescue) pool only when every chain entry is exhausted, so replies never
  stop.
- **`/fusion-modellist` (renamed from `/fusion-whitelist`)**: the model list
  is now a stack editor with a `⇄ mode` toggle — **whitelist** (default:
  only listed models are candidates; empty = all + cost caps) or
  **blacklist** (`listMode`: every candidate except the listed ones, within
  the cost caps — handy for excluding a few bad models; a bare `model-id`
  entry excludes that model on every provider; blacklisted models stay
  excluded even during rescue's emergency expansion). Entries are grouped
  by provider, added via a typed prompt (Enter to stack), and removable or
  editable per entry. Toggling the mode clears the list (the meaning
  inverts, so stale entries are dangerous). The `/fusion-whitelist` command
  was removed (it renamed into `/fusion-modellist`).

### Fixed (v1.2.0 audit)

- **Single-provider whitelist ignored full refs**: the default
  single-provider mode matched only bare `model-id` entries, so the
  `provider/model-id` entries the `/fusion-modellist` UI recommends silently
  matched nothing (empty candidate pool, routing always `KEEP`). Both entry
  forms now match in every branch, including emergency expansion (bare ids
  were dropped there too).
- **Provider chain rescue stalled on unobserved providers (audit)**: the
  emergency chain narrowing skipped the "observed records only on rescue"
  rule, so a chain[0] with only unobserved non-cooling models (e.g. paid
  models after the free tier died) narrowed rescue to an unobservable
  provider and the session stalled instead of falling through to chain[1].
  The rule now applies in both branches (the dead branch was removed).
- **`models` option was never read (audit)**: the documented
  `opencode.json` `models` whitelist/blacklist was silently ignored; options
  now seed the list like every other option.
- **`/fusion-tiers` empty input cleared the tier (audit)**: the server
  full-replaced the `tiers` object, so the dialog's "empty keeps this tier
  unchanged" promise was false. Tiers now merge per-tier — only tiers present
  in the update change.
- **`classifierModel`/`reviewModel` null round-trip (audit)**: an explicit
  `null` (or empty-string) clear now survives config resync/restart even
  when `opencode.json` options set the field; `kinds` updates via RPC were
  silently dropped and are now applied (in-place, like the persisted path).
- **Mode-transition symmetry (audit)**: saving a single provider stack entry
  also turns `crossProvider` off; a chain update mirrors `chain[0]` into
  `providerID` and clears a stale model list (same rule as a plain provider
  change); options-only chains enforce the same invariants (mirror +
  `crossProvider=false`); a restored chain wins over `crossProvider`.
- **`costWeight`/`latencyWeight` unclamped (audit)**: negative values turned
  the cost/latency penalty into a bonus for expensive/slow models. All three
  config stages now clamp to 0..1.
- **Resolve-hook same-provider rescue never recorded a restore ticket
  (audit)**: the original model was permanently replaced with no
  auto-restore; it now records `rescueAttempts` like every other rescue site.
- **`/fusion-provider` wiped blacklist exclusions (audit)**: saving a
  provider/chain change cleared the model list even in blacklist mode, where
  entries are deliberate exclusions that stay valid across providers. The
  list is now reset only in whitelist mode.
- **`resetStats` pagination (audit)**: storage scans paged through all keys
  (>500 left residue); in-flight recovery probes no longer re-mark cooldowns
  after a reset.
- **Display precedence (audit)**: a provider chain now takes precedence over
  `crossProvider` in both `/fusion-stats` and `/fusion-config` (the routing
  path already preferred the chain), and the cost-cap line reflects blacklist
  mode (caps always apply).

## [1.1.0] - 2026-11-18

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
  RPC, and `/fusion-params` (`topoexplore`).
- **`topologyPriorStrength` (default 4, 1..20)**: pseudocount of the Bayesian
  prior on topology rewards. Configurable via plugin options, the config RPC,
  and `/fusion-params` (`topo-prior`).
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
  non-weight knobs too (`topocalls`, `topo-prior`, `topoexplore`,
  `varexplore`, `rescuattempts`, `costin`/`costout`). The old
  `/fusion-weights` name keeps working as an alias.
- **Slash-command cleanup**: `/fusion-audit` and `/fusion-costcap` removed —
  both are covered by `/fusion-params` (`audit`, `costin`/`costout`). The
  command set is now 17 entries (16 dialogs: `params`/`weights` share one),
  each with a unique job: display
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
