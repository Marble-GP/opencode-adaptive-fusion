# OpenCode Adaptive Fusion

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Transparent, learning-based model routing and orchestration for [OpenCode](https://opencode.ai).

Adaptive Fusion plugs into OpenCode's experimental hooks and turns the built-in model
picker into a **self-learning router**: it classifies each task, routes requests to the
model that performs best for that task, falls back automatically when providers hit
rate limits, and continuously improves from HTTP outcomes and human/LLM reviews.

- **Zero-touch routing** — requests are rewritten at the hook layer; your session
  history stays clean and no extra "router" messages appear in the conversation.
- **Observe-only by default** — the plugin starts with routing disabled, collects
  success-rate/latency statistics, and only routes after you enable it.
- **Automatic rescue** — detects unusable models (quota exhaustion, provider errors),
  cools them down with live verification, and moves the session to a healthy model.
  **Rescue runs only while routing is enabled**: `/fusion-toggle` OFF stops every
  user-visible model switch (routing, rescue, restore), while passive learning
  (observation, classification, shadow review, recovery probes) keeps running
  in the background so nothing is lost while paused.
- **Review & feedback loop** — `/fusion-review` rates responses (1–5), shows per-turn
  token/cost/throughput statistics, and can review **older turns** after a bug surfaces.
- **Shadow auto-review** — a separate lightweight model scores every response on four
  axes (instruction / accuracy / completeness / cost-efficiency) and enumerates what
  the response actually accomplished. Displayed in the review panel; can optionally
  feed the routing score behind gates (`autoReviewWeight`, default off).
- **Topology awareness** — classifies orchestration shape (single / router /
  sequential-chain) and, with a Jev (TypeSafe) key, selects it probabilistically.
- **Tier routing** — routes by task load (Light / Middle / Heavy) with upward cascading.

All routing decisions, cooldowns, statistics, reviews and configuration are stored per
plugin in OpenCode's own key-value store, shared across projects.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| OpenCode **2.3.x** | Uses `experimental.model.resolve`, `http.request`/`http.response`, `prompt` and `context` hooks. These are experimental APIs; newer OpenCode releases may rename or change them. |
| No build step | The TypeScript sources are loaded directly by OpenCode. Nothing to compile, no `npm install`. |
| Git (recommended) | Only needed for updates (or download a release archive instead). |

The plugin has no runtime npm dependencies. Optional integrations:

- **Jev / TypeSafe** (`TYPESAFE_API_KEY` or `/fusion-jev-key`) for probabilistic
  task classification, topology choice and load estimation.
- **OpenRouter** (or any second provider) for cross-provider routing.

---

## Installation

Two ways to install are supported. Pick one — do not do both (registering the plugin
in two places makes OpenCode load two instances in one process).

### Option A — OpenCode CLI (recommended)

Install the plugin straight from this repository (the repository root is the
plugin package; its `package.json` maps `exports` into `plugins/adaptive-fusion/`):

```bash
opencode plugin add 'github:Marble-GP/opencode-adaptive-fusion#v0.9.1'
```

OpenCode installs it into the **global** plugin configuration. Verify and manage it with:

```bash
opencode plugin list
opencode plugin update opencode-adaptive-fusion
opencode plugin remove  opencode-adaptive-fusion
```

Exact tags such as `v0.9.1` stay pinned to that tag; omit the `#…` suffix to track the
default branch, and use `opencode plugin update` to jump forward. Restart OpenCode
after installing (TUI parts load at startup).

### Option B — clone and register the directory manually

#### 1. Get the plugin

```bash
git clone https://github.com/Marble-GP/opencode-adaptive-fusion.git
cd opencode-adaptive-fusion
```

#### 2. Register the plugin in OpenCode's **global** config

OpenCode loads plugins from the `plugins` array of the *global* configuration file:

| OS | Path |
| --- | --- |
| Linux / macOS | `~/.config/opencode/opencode.json` |
| Windows | `C:\Users\<you>\.config\opencode\opencode.json` |

Add an entry pointing at the `plugins/adaptive-fusion` **folder** (absolute path,
forward slashes work on every platform). The folder contains a `package.json`, so
OpenCode loads its server, TUI and RPC parts through the `exports` map:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      // Absolute path to the plugin folder (the one containing package.json)
      "package": "C:/Users/you/Documents/Dev/opencode-adaptive-fusion/plugins/adaptive-fusion",
      "options": {
        // Routing target provider. Use "openrouter" for OpenRouter-only setups.
        "providerID": "opencode",
        // Start in observe-only mode (recommended). Enable later with /fusion-toggle.
        "enabled": false,
        // Display language: "ja" (Japanese) or "en" (English).
        "lang": "en",
        // A cheap model for task classification (optional but recommended).
        "classifierModel": "opencode/glm-5.3-flash-free",
        // A separate model for shadow auto-review (optional).
        "reviewModel": "openrouter/deepseek/deepseek-v4.1-flash-1017",
        "debug": false
      }
    }
  ]
}
```

> **Important — register the plugin in exactly one place.**
> Do **not** also add it to a project's `opencode.jsonc`. Registering the same folder
> twice makes OpenCode load two plugin instances in one process; they duplicate
> observations and can overwrite each other's persisted state. The repository's own
> `opencode.jsonc` deliberately keeps `"plugins": []` for this reason.

### 3. Restart OpenCode

TUI plugins are loaded at startup, so **fully quit and relaunch** OpenCode after
adding the plugin or changing its options. (The server hot-reloads `index.ts` edits,
but a restart is the reliable way to pick up everything, including TUI changes.)

### 4. Verify the installation

Inside OpenCode:

| Command | Expected |
| --- | --- |
| `/fusion-config` | Shows the current configuration, including whether Jev is available. |
| `/fusion-stats` | Shows accumulated statistics (empty on first run). |
| `/fusion-toggle` | Flips routing on/off and shows a toast. |

A footer indicator on the home screen and prompt input shows `● fusion: ON` /
`○ fusion: OFF` at all times.

### Updating

**Option A (CLI install):**

```bash
opencode plugin update opencode-adaptive-fusion
```

**Option B (clone):**

```bash
cd opencode-adaptive-fusion
git pull
```

Then restart OpenCode. Your statistics and configuration are kept in OpenCode's
storage, not in the repository, so updates never reset them.

### Uninstalling

**Option A (CLI install):**

```bash
opencode plugin remove opencode-adaptive-fusion
```

**Option B (clone):**

1. `/fusion-reset` (optional — deletes statistics, reviews, cooldowns).
2. Remove the `plugins` entry from `~/.config/opencode/opencode.json`.
3. Restart OpenCode and delete the folder.

### Where data is stored

OpenCode 2.3 keeps `ctx.storage` in a single SQLite database
(`~/.local/share/opencode/opencode.db`, table `kv`). Fusion keys live under
`plugin:<hex>:fusion/*` and are shared between the TUI and the server, and across
projects. No telemetry is sent anywhere; the only network calls are the LLM requests
you configure plus optional Jev calls.

---

## Quick start

1. Start OpenCode in any project. The plugin loads from the global config.
2. Work normally. Routing is **off** by default; success rates, latencies and
   auto-reviews accumulate in the background.
3. When enough observations exist, enable routing with `/fusion-toggle`.
4. Review results with `/fusion-stats`, adjust candidates with `/fusion-whitelist`,
   and rate responses with `/fusion-review`.

**Cost cap is zero by default.** When the whitelist is empty, only models whose
input/output rates are within `maxInputCost`/`maxOutputCost` are eligible — and the
default of `0,0` means **free models only**. Raise the cap with `/fusion-costcap`
(`input,output` in USD per 1M tokens, e.g. `0.3,2.0`) or pin paid models explicitly
in the whitelist.

### Language

All command titles, dialog text and statistics are available in **Japanese and
English**. Choose the default per installation with `"lang": "ja"` or `"lang": "en"`
in the plugin options, and change it at any time with `/fusion-lang` (the choice is
persisted and survives restarts). The language also controls the wording the
internal summary and shadow auto-review prompts ask for.

---

## Commands

Fusion commands run inside the TUI and call the server over RPC. They never send
messages to the agent and never pollute session history.

| Command | Description |
| --- | --- |
| `/fusion-stats` | Show learning statistics (including human rating averages and cost caps). |
| `/fusion-toggle` | Toggle routing ON/OFF (toast). **OFF stops every model switch** (routing, rescue, restore); passive learning (observation, classification, shadow review, probes) continues in the background. |
| `/fusion-config` | Show the current configuration. |
| `/fusion-lang` | Switch the display language of commands and dialogs between Japanese and English (persisted). |
| `/fusion-costcap` | Edit input/output cost caps used when the whitelist is empty (default `0,0`). |
| `/fusion-weights` | Adjust routing/topology weights: presets (`balanced` / `cost-first` / `quality-first` / `snappy` / `audit-on`) or `custom` — a searchable, description-annotated picker for all eleven tunables (`cost latency explore learning minobs bench audit topojev topocp topoauto topocalls`), each edited in a prefilled prompt with range validation. |
| `/fusion-review` | Open the response review panel: summary, 1–5 rating, turn statistics. **Pick a turn to review older responses** (`0 = latest`, `1 = one turn back`, …). |
| `/fusion-reviewmodel` | Set the shadow auto-review model (`provider/model`; empty clears it). |
| `/fusion-audit` | Set the auto-review weight (`0` = shadow display only; `0.2` typical when enabled). |
| `/fusion-jev-key` | Register a Jev (TypeSafe) API key via a dialog (empty clears it). The key is stored server-side; `TYPESAFE_API_KEY` also works. |
| `/fusion-chainmode` | Toggle sequential-chain planning injection (`off` / `active`). |
| `/fusion-tiermode` | Cycle tier routing `off → manual → auto`. |
| `/fusion-tiers` | Edit per-tier model groups (Heavy / Middle / Light, comma-separated; empty clears a tier). |
| `/fusion-provider` | Change the routing target provider (resets the whitelist). |
| `/fusion-whitelist` | Edit the candidate whitelist (comma-separated; empty = all eligible candidates + cost caps). |
| `/fusion-probe` | Send a probe prompt to candidates (records results, applies cooldowns). |
| `/fusion-reset` | Reset statistics, cooldowns and human ratings (confirmation dialog). |

TUI changes may require an OpenCode restart to appear.

---

## Configuration

Settings are persisted in `fusion/config` and can be changed from the TUI
(`/fusion-*` commands) — no config-file edit or restart needed for server-side
settings. Precedence: **saved settings > `opencode.json` options**.

| Option | Default | Description |
| --- | --- | --- |
| `providerID` | `"opencode"` | Routing target provider. Use `"openrouter"` for OpenRouter-only setups. Changeable at runtime. |
| `crossProvider` | `false` | Mix all connected providers when routing. Whitelist then uses full `provider/model-id` references. |
| `enabled` | `false` | Initial routing state (toggle at runtime). |
| `exploreRate` | `0.05` | ε-greedy exploration rate in steady state. |
| `learningRate` | `0.3` | Exploration rate during the learning phase. |
| `minObservations` | `5` | Cold-start threshold: models with fewer observations are explored preferentially. |
| `classifierModel` | (none) | Lightweight model for task classification (`provider/model`). Classification is disabled when unset. |
| `categories` | 6 | `coding / debugging / review / research / writing / ops`. |
| `costWeight` | `0.1` | Cost penalty weight in the routing score. |
| `latencyWeight` | `0.05` | Relative latency penalty weight. |
| `maxInputCost` | `0` | Input cost cap (USD / 1M tokens) when the whitelist is empty. `0` = free models only. |
| `maxOutputCost` | `0` | Output cost cap (USD / 1M tokens). |
| `debug` | `false` | Log routing decisions to the server log. |
| `kinds` | `["primary"]` | Request kinds to route (`primary / compaction / title / generate`). |
| `benchmarkPriorWeight` | `5` | Strength (k) of the benchmark prior. `0` disables it. |
| `benchmarksFile` | `data/benchmarks.json` | Benchmark seed file (relative paths resolve against the plugin). |
| `benchAutoUpdate` | `true` | While fusion is ON, refresh the benchmark library from the OpenRouter models API at most once per day (stored in OpenCode storage; fail-safe keeps the previous snapshot). |
| `reviewModel` | (none) | Shadow auto-review model. Falls back like `classifierModel` when unset. |
| `autoReviewWeight` | `0` | Weight (0..1) of the independent-audit auto-review signal inside the routing quality term. `0` = shadow display only. Set with `/fusion-audit`. |
| `topologyMode` | `auto` | `auto` (Jev/observed stats) or `fixed` (single only). |
| `allowedTopologies` | `["single","router","sequential-chain"]` | Whitelist of orchestration shapes. |
| `maxTopologyCalls` | `4` | Upper bound of auxiliary calls per response (cost guard). |
| `topologyWeightJev` | `0.5` | Weight (w1) of the Jev prior in topology selection. Forced to 0 without a Jev key. |
| `topologyWeightHumanCP` | `0.25` | Weight (w2) of human cost-performance ratings. |
| `topologyWeightAuto` | `0.25` | Weight (w3) of automatic quality/ok-rate observations. |
| `chainMode` | `off` | `active` injects a planner-generated plan (8 s timeout) as reference context for sequential-chain turns. |
| `tierMode` | `off` | `off` / `manual` (user-defined tiers) / `auto` (split candidates by benchmark score). |
| `tiers` | all empty | Per-tier groups `{ heavy: [], middle: [], light: [] }` of `provider/model` refs. |
| `jevMode` | `auto` | `auto` (enable when a key is found) / `off`. |
| `lang` | `"ja"` | Display language of commands, stats and dialogs: `"ja"` (Japanese) or `"en"` (English). Per-install default via `options`; switch at runtime with `/fusion-lang`. |

### How the routing score works

```
score = successRate (Laplace-smoothed, benchmark prior optional) × 0.65
      + quality × 0.35
      − costPenalty − relativeLatencyPenalty
```

with

```
quality = (1 − w) × humanReviewScore + w × auditAutoReviewScore
w = autoReviewWeight (0 by default)
```

The three quality sources are deliberately kept distinct:

| Source | Signal | Involvement in routing |
| --- | --- | --- |
| Machine observation | HTTP success/failure rate, per task category | Machine term (0.65), always on |
| Human review | 1–5 ratings via `/fusion-review` | Quality term, always on |
| Audit auto-review | 1–5 by an independent audit model (`reviewModel`) running in a separate harness after the response was returned | Quality term, only when `autoReviewWeight > 0` |

Audit auto-review is not self-scoring: the auditor is a different model, it
runs after the response, and it never blocks the user-visible answer. Even so
it only takes effect behind gates (default `autoReviewWeight = 0` keeps the
legacy shadow behaviour):

1. **Sample gate:** with fewer than 10 audit reviews the audit score is
   neutral, so a few early scores cannot move routing. Beta smoothing shrinks
   toward neutral.
2. **Quality axes only:** instruction / accuracy / completeness. `efficiency`
   is cost-performance and already overlaps with the cost penalty, so it is
   excluded.
3. **Divergence guard:** when the auditor systematically disagrees with human
   ratings (`|shadow − human| ≥ 1.0` with at least 5 human ratings), its
   effective weight is halved. This is the same `|Δ| ≥ 1.0` criterion shown
   in `/fusion-stats`.

The human 0.35 term is preserved: the audit signal only mixes **inside** the
quality term, it never changes the 0.65/0.35 split.

### Cost model

The routing cost penalty compares the **expected full-turn cost**, not just
the output unit price:

```
unit cost = input + output + cache.read + cache.write   (USD / 1M tokens)
refCost   = unit cost / max(unit cost over candidates)
```

Coding-agent tasks are dominated by input and cache-read tokens, so an
input-expensive model can be the more expensive choice even when its output
is cheap. The responsiveness baseline (observed per-task token mixes) is
reserved for a later iteration.

- The success rate is smoothed with a Beta prior seeded from benchmarks, so
  observations eventually dominate the prior.
- Latency is penalised **relative to the candidate set** (0–1), so slow models lose up
  to `latencyWeight` compared with the fastest candidate.
- Unobserved models are treated as neutral (0.5), and ε-greedy exploration gives them
  a chance to prove themselves.
- Statistics are kept per **task category × model** (`fusion/task/<category>/...`) and
  fall back to global stats (or neutral 0.5) below `minObservations`.

### Task classification

When `classifierModel` is set, each prompt is classified once (a single lightweight
call) into `coding / debugging / review / research / writing / ops`. If the classifier
model is unavailable, the plugin falls back to other free models and then to explicit
keyword signals; if there are no explicit signals it returns "unclassified" rather
than guessing.

### Cross-provider routing

With `crossProvider: true`, candidates include every connected provider and the
whitelist uses full `provider/model-id` references (e.g.
`openrouter/z-ai/glm-4.6`). If the routed model turns out to be unavailable, that
step fails **without retry**; success-rate learning therefore pushes flaky models
down over time. Model comparison and rescue still work per real provider
(`fusion/stat/<provider>/<model>`).

---

## Review

### Manual review (`/fusion-review`)

1. Run `/fusion-review` after a response.
2. Choose the target turn: `0 = latest`, `1 = one turn back`, `2 = two turns back`, …
   (leave empty for latest). Older responses remain reviewable after a bug surfaces.
   Use `[◀ older]` / `[▶ newer]` inside the panel to navigate.
3. The panel shows the assigned category, model, existing ratings, the adopted
   topology with its observed statistics, and **turn statistics**:
   input/output/reasoning/cache-read tokens, cost (USD), measured latency and
   measured throughput (tok/s). These are derived from the tokens/cost/timestamps
   recorded on each message, so **past turns are computed retroactively**.
4. `[Generate summary]` produces a three-line summary (Instruction / Work / Outcome)
   from both the request and the response.
5. Rate the response `1–5`. The rating is recorded for the selected turn's model;
   ratings of 3 are neutral, 4+ add score, 2− subtract.

Ratings are stored globally and per category (`fusion/feedback/...`). The routing
score blends observations (65%) and human ratings (35%).

### Shadow auto-review

Immediately after a successful `http.response` (kind=primary), a separate model
scores the response in the background. This never blocks the user-visible response.

- **Rubric (1–5 each + one-line reason):** instruction adherence, accuracy,
  completeness, and **cost-efficiency**. The prompt includes the turn statistics
  (tokens, latency, tok/s, cost) so efficiency is judged on numbers.
- **Results enumeration:** the reviewer must list what the response actually
  accomplished (`results` array) — files created/changed, commands executed, answers
  given — with evidence instead of generic praise. Shown as `実績N` (result N) rows in
  the panel.
- **Parsing:** brace-balanced JSON extraction (handles multi-line output and the
  `results` array) → labeled lines → bare 1–5 integers. Three-axis legacy outputs
  still parse; missing efficiency counts as "not collected".
- **Skip logging:** failures (no reviewer, unparseable output, out-of-range values,
  exceptions) are recorded in `fusion/auto-skip/latest` and shown in `/fusion-stats`.
- **Storage:** separate from human ratings (`fusion/auto/...` globally and per
  category). Results are kept per model (latest 5).
- **Mode:** since v1.0 the auditor can take part in routing when
  `autoReviewWeight > 0` (set with `/fusion-audit`). Default is `0`: shadow
  display only. When enabled, its scores mix only inside the quality term
  behind sample and divergence gates. See "How the routing score works" for
  the full gate list.
- **Cost:** one review call per response. Point `reviewModel` at a cheap model if
  free quotas are scarce.

### Turn statistics in the panel

```
Turn: in 203 → out 513 tok
      ↳ reasoning 0 / cache-read 76,160 tok / cost $0.000000
      ↳ measured 7.1s / 72.5 tok/s / finish: stop
```

- tps = output tokens ÷ (completed − first token) from the message metadata.
- Error responses without token records simply omit the block.

---

## Rescue and verified cooldowns

- When a model is judged unusable (Model unavailable / quota), the session is moved
  to a healthy model **before the next prompt**, even with routing OFF.
- After the original model's cooldown clears (including provider quota cooldown), the
  session is **automatically restored** to it on a later prompt (24 h restore window).
- **Verified cooldown:** the 1-hour quota timer expiring does *not* mean recovery.
  A minimal live probe (`Reply with exactly: OK`) must return exactly `OK`
  (case-insensitive, optional trailing punctuation) before the cooldown is
  lifted (`needsVerify`). A failed probe extends the
  cooldown by another hour. Verified lifts are logged as `VERIFY ok/fail`;
  successes that clear a cooldown are logged as `RECOVER ok`. A probe that
  returns anything else (even a long free-form answer) is treated as a
  failure, because a model that cannot follow a trivial instruction is not
  evidence of recovery.
- Provider-level quota cooldowns apply **only to free models**; paid models of the same
  provider remain eligible as rescue targets.
- Rescue may widen candidates to budget-conforming paid models (always across
  providers when `crossProvider` is on) so a dead free pool never stops replies.
- Only **rescue-driven** model switches are persisted on the session; ordinary
  score-based routing rewrites per dispatch to keep caches warm.

### OpenCode 2.3 constraints we handle

- `experimental.model.resolve` can only rewrite the model **within the same provider**
  (the core resolves only when `providerID` is unchanged and otherwise throws
  `ModelUnavailableError`). Cross-provider moves therefore go through
  `ctx.session.switchModel` (the same safe path as manual model selection) and apply
  from the **next dispatch** — logged as `DEFER ... (cross-provider, next dispatch)`.
  Ordinary cross-provider score routing is skipped (`KEEP ... (no rewrite)`) to avoid
  per-dispatch round trips that would break caching.
- Sessions created without an explicit model have no `session.model` until the first
  switch. The resolve hook records the actually-dispatched model in `lastResolved`,
  which pre-prompt rescue (`PRE hint`) and failure attribution fall back to. This
  prevents a second consecutive failure on a dead default model and prevents
  mis-attributing failures to healthy models.
- Two `role=server` plugin instances can coexist in one process. Cooldown/rescue
  persistence therefore **merges into the stored kv value** (instead of overwriting),
  with tombstones (25 h TTL) to make deletions stick. Without this, a stale instance
  could wipe freshly recorded cooldowns.

---

## Persistence and TUI sync

- Configuration, statistics, cooldowns, rescue state and reviews are persisted through
  `ctx.storage` and survive restarts and plugin hot reloads.
- TUI commands mutate settings through RPC; the server re-reads persisted config on
  the `prompt` hook (logged as `CONFIG synced from storage`), so a toggle takes effect
  on the next prompt without a restart.
- `/fusion-reset` clears statistics, cooldowns, rescue state and human/auto reviews.

---

## Topology and tier routing

### Orchestration shapes

Only `sequential-chain` runs a genuinely different execution. `single` and
`router` share the same underlying classification and model selection (they
differ in whether the classifier runs and how the model is chosen), so do not
treat `single` vs `router` as two independently implemented execution modes.
Planned multi-agent shapes are only comparable once implemented.

| Shape | Execution | Calls |
| --- | --- | --- |
| single | Current behavior (one session model) | 1 |
| router | Classify and pick a category specialist | 1 + classifier |
| sequential-chain | Plan → execute → verify, injected as reference context | 2–3 |
| fan-out / fan-in | Decompose, parallelize, merge *(planned)* | N+1 |
| hierarchical | Planner assigns, workers run, synthesizer merges *(planned)* | N+2 |
| collaboration | Independent answers, judge consensus *(planned)* | N+1 |
| graph | State-machine execution *(planned)* | dynamic |

Topology selection uses, in order:

1. **Jev `Choice`** (with a key): confidence ≥ 0.7 wins; the probability distribution
   is stored as a prior.
2. **Learned weighted score** (without a key): `0.8 × auto-review quality + 0.2 × human
   cost-performance`, requiring at least 3 observations per shape.
3. **single** as the safe fallback.

`chainMode=active` enables sequential-chain planning injection: a planner call
(8 s timeout) produces a 3–5 line plan that is pushed once into the system context
for that turn only. Failures degrade silently to single behavior.

Todo: define execution semantics for every shape before comparing track
records, e.g. Plan → Execute → Verify → Repair for chained runs.

### Tier routing

- Three load tiers: **Light / Middle / Heavy**, split at difficulty 34 / 67.
- Difficulty estimation degrades in three stages without extra API calls: Jev score →
  classifier LLM JSON `difficulty` field → heuristics (category defaults, length,
  multi-step keywords).
- `tierMode=manual` uses your tier groups (`/fusion-tiers`); `tierMode=auto` splits
  candidates by benchmark score. Within a tier the normal routing score applies.
- Depleted tiers cascade **upward** (Light → Middle → Heavy); there is no automatic
  downgrade. Rescue prefers the session's tier when a healthy target exists.
- Logged as `LOAD <tier>(via jev/llm/heuristic)` and `TIER <tier>(load=...)`; the
  review panel shows the load band.

---

## Benchmark priors

`data/benchmarks.json` seeds per-model × per-category scores (0–1). They are applied
as a Beta prior with strength `benchmarkPriorWeight` (default 5): observations of `n`
samples weigh `n / (n + k)`, so **recorded results eventually dominate the prior**.
Models absent from the file are neutral (0.5, no penalty). Priors older than 90 days
(`fetchedAt`) are halved. Priors apply only to candidates that pass the cost cap.

### Auto-refresh (v1.0)

Stale priors are the biggest threat to routing quality, so v1.0 refreshes the library
automatically — but never silently:

- **Linked to the fusion toggle**: the daily check runs only while routing is enabled.
  With `/fusion-toggle` OFF nothing reaches the network *or* the models.
- **Once per day**, judged at the start of each turn (a persisted marker avoids
  duplicate fetches between the server's plugin instances).
- **Fetches the public OpenRouter models API** (`/api/v1/models`,
  `benchmarks.artificial_analysis` indices, normalized ÷100 — the same normalization
  as the seed file). No API key is sent anywhere.
- **Fail-safe**: any error (network, parse, or fewer than 20 usable models) keeps the
  previous snapshot; the failure is recorded in `/fusion-stats`.
- **Explicit files win**: setting `benchmarksFile` to your own path disables the
  auto-refresh (the configured file always takes precedence and is never competed
  with); the status line says `skipped (custom benchmarksFile)`.
- **Stored in OpenCode storage** (`fusion/benchmarks`), never written into the plugin
  directory. Entries that cannot be refreshed from this source (e.g. `opencode/*`
  provider ids) are retained from the previous snapshot.
- **Disable** with `"benchAutoUpdate": false` in the plugin options (or the
  `benchAutoUpdate` field of the config RPC). `/fusion-stats` shows the current state;
  `/fusion-config` shows `auto-refresh ON/OFF`.

---

## Known limitations

- A routed model that is unavailable (e.g. rate-limited free tier) fails that step
  without retry; no HTTP request is made, so nothing can be recorded for that attempt.
  Subsequent attempts recover via rescue/cooldown learning.
- The `model.resolve`, `http.*`, `context` and `prompt` hooks are experimental and may
  change in future OpenCode releases.
- Success is judged from HTTP status; semantic quality comes from reviews, and shadow
  auto-review is not yet reflected in routing scores.
- Fan-out / hierarchical / collaboration / graph topologies are designed but not
  implemented; they are gated by `allowedTopologies`.
- The first response of a brand-new session can fail once if the default model itself
  is dead (billing/quota); pre-prompt rescue can only act on evidence that does not
  exist until the first attempt.

---

## Roadmap

| Version | Scope | Status |
| --- | --- | --- |
| v0.5 | Manual review, cost caps, rescue | Released |
| v0.6 | Shadow auto-review harness, benchmark priors | Released |
| v0.7a | Jev classification/topology, topology scoring, sequential-chain execution | Released |
| v0.8 | Tier routing (Light/Middle/Heavy, upward cascade) | Released |
| v0.8.1 | Verified cooldowns, DEFER path, merge persistence, pre-prompt rescue | Released |
| **v0.9.0** | Retroactive review, turn statistics, results enumeration, efficiency axis | **Released** |
| **v0.9.1** | Repository-root `package.json` (CLI/git installs), `opencode plugin add` docs, source comments translated to English | **Released** |
| **v1.0 (in development)** | Audit auto-review as a gated routing signal (`autoReviewWeight`), full-turn cost model, strict recovery probe, OFF stops every model switch, benchmark library auto-refresh (toggle-ON, daily) | **In development** |
| v0.7b (next) | fan-out/fan-in, hierarchical, cost-guard completion | Planned |
| v0.7c | collaboration, graph, statistic key separation | Planned |
| v1.0+ | test harness, comparative experiments | Planned |

---

## Development

```
plugins/adaptive-fusion/index.ts   Server: hooks, learning, routing, RPC implementation
plugins/adaptive-fusion/rpc.ts     RPC contract (typed interface between TUI and server)
plugins/adaptive-fusion/tui.tsx    TUI: slash commands and the review panel
plugins/adaptive-fusion/jev.ts     Jev (TypeSafe System One) client
plugins/adaptive-fusion/package.json  Plugin package manifest (direct directory installs)
package.json                       Plugin package manifest (git/CLI installs, exports → plugins/adaptive-fusion/)
data/benchmarks.json               Benchmark seed (model × category priors)
opencode.jsonc                     Intentionally registers nothing (avoids double-load)
```

- The plugin is TypeScript loaded directly by OpenCode; there is no build step.
  A syntax check with your bundler of choice (e.g. `npx esbuild ... --outfile=/dev/null`)
  is enough before committing.
- The RPC surface is schema-validated; new optional fields are backward compatible.
- See [CHANGELOG.md](CHANGELOG.md) for the release history.

## License

[MIT](LICENSE)
