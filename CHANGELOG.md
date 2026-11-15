# Changelog

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
