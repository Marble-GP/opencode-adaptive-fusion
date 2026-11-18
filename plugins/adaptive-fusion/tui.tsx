// OpenCode Adaptive Fusion - TUI part
//
// Handles slash commands on the TUI side and operates/displays the state of
// the server part via RPC. No messages are injected into the session, so the
// agent's response is not triggered.
//
// /fusion-stats      Show learning statistics
// /fusion-toggle     Toggle routing ON/OFF
// /fusion-config     Show the current configuration
// /fusion-provider   Change the routing target provider (stack UI: add entries, swap up/down; 2+ entries form a priority chain)
// /fusion-modellist Edit the model list (whitelist/blacklist mode, provider-grouped stack editor)
//                    (/fusion-whitelist works as an alias)
// /fusion-params     Adjust routing/topology coefficients (presets + combobox editor with descriptions)
//                    (/fusion-weights works as an alias; includes cost caps and the former /fusion-audit)
// /fusion-review     Summarize a response / rate model and topology cost-performance (1-5 each). Supports retroactive review by turn offset
// /fusion-probe      Send a simultaneous test prompt to candidate models (response evaluation)
// /fusion-reset      Reset learning statistics, cooldowns, and human ratings
// /fusion-reviewmodel Set the model responsible for internal (shadow) review
// /fusion-chainmode  Toggle sequential-chain auxiliary execution (plan injection) off/active
// /fusion-variantmode Configure reasoning-effort (thinking level) selection (auto / fixed / off)
// /fusion-lang     Switch display language (ja / en)
// /fusion-weights  Alias for /fusion-params
// /fusion-tiermode   Toggle tier routing (Light/Middle/Heavy by load)
// /fusion-tiers      Edit the model groups per tier (whitelist on steroids)
// /fusion-jev-key     Register/clear the Jev (TypeSafe) API key (optional)

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { AdaptiveFusion } from "./rpc"

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

// Tunable weights/coefficients of the routing and topology scores (v1.0).
// These are adjustable server-side via the config RPC but had no TUI surface;
// /fusion-params edits them in one place. Aliases, validation ranges, and
// localized help descriptions (shown in the picker and the edit prompt).
const WEIGHT_FIELDS: {
  alias: string
  server: string
  min: number
  max: number
  integer?: boolean
  // One-line help shown in the picker row (must stay short: the host renders
  // title and description on a single line). ja / en
  sja: string
  sen: string
  // Full explanation, shown on demand via the ctrl+h help action. ja / en
  ja: string
  en: string
}[] = [
  {
    alias: "cost",
    server: "costWeight",
    min: 0,
    max: 1,
    sja: "コストペナルティの重み",
    sen: "cost penalty weight",
    ja: "コストペナルティの重み。大きいほど安いモデルを優先",
    en: "weight of the cost penalty; higher prefers cheaper models",
  },
  {
    alias: "costin",
    server: "maxInputCost",
    min: 0,
    max: 1000,
    sja: "コスト上限: input",
    sen: "cost cap: input",
    ja: "input上限(USD/1Mトークン)。ホワイトリスト空時のみ適用。0 = 無料モデルのみ",
    en: "input cap (USD/1M tokens), applied when the whitelist is empty; 0 = free models only",
  },
  {
    alias: "costout",
    server: "maxOutputCost",
    min: 0,
    max: 1000,
    sja: "コスト上限: output",
    sen: "cost cap: output",
    ja: "output上限(USD/1Mトークン)。ホワイトリスト空時のみ適用。0 = 無料モデルのみ",
    en: "output cap (USD/1M tokens), applied when the whitelist is empty; 0 = free models only",
  },
  {
    alias: "latency",
    server: "latencyWeight",
    min: 0,
    max: 1,
    sja: "レイテンシペナルティの重み",
    sen: "latency penalty weight",
    ja: "レイテンシペナルティの重み。大きいほど速いモデルを優先",
    en: "weight of the latency penalty; higher prefers faster models",
  },
  {
    alias: "explore",
    server: "exploreRate",
    min: 0,
    max: 1,
    sja: "定常状態の探索率",
    sen: "steady-state explore rate",
    ja: "定常状態の探索率(ε-greedy)。大きいほど多様なモデルを試す",
    en: "steady-state exploration rate (eps-greedy); higher tries more models",
  },
  {
    alias: "learning",
    server: "learningRate",
    min: 0,
    max: 1,
    sja: "学習期間の探索率",
    sen: "warm-up explore rate",
    ja: "学習期間の探索率。観測が少ないモデルを優先的に試す",
    en: "exploration rate while models are under-sampled",
  },
  {
    alias: "minobs",
    server: "minObservations",
    min: 1,
    max: 100,
    integer: true,
    sja: "信頼に必要な最小観測数",
    sen: "min observations",
    ja: "モデルを信頼するまでの最小観測数。小さいほど早く本命選択に移る",
    en: "minimum observations before a model is trusted",
  },
  {
    alias: "bench",
    server: "benchmarkPriorWeight",
    min: 0,
    max: 50,
    sja: "ベンチマーク事前の強さ(k)",
    sen: "benchmark prior strength (k)",
    ja: "ベンチマーク事前分布の強さ(k)。0 で無効",
    en: "strength (k) of the benchmark prior; 0 disables it",
  },
  {
    alias: "audit",
    server: "autoReviewWeight",
    min: 0,
    max: 1,
    sja: "監査スコアの品質項への重み",
    sen: "audit weight in quality term",
    ja: "監査(自動審査)スコアを品質項に混ぜる重み。0 = shadow 表示のみ",
    en: "how much the audit auto-review score mixes into the quality term; 0 = shadow display only",
  },
  {
    alias: "topojev",
    server: "topologyWeightJev",
    min: 0,
    max: 1,
    sja: "トポロジー: Jev事前",
    sen: "topology: Jev prior weight",
    ja: "トポロジー選択での Jev 事前確率の重み",
    en: "weight of the Jev prior in topology selection",
  },
  {
    alias: "topocp",
    server: "topologyWeightHumanCP",
    min: 0,
    max: 1,
    sja: "トポロジー: 人間コスパ",
    sen: "topology: human cost-perf",
    ja: "トポロジー選択での人間コスパ評価の重み",
    en: "weight of human cost-performance ratings in topology selection",
  },
  {
    alias: "topoauto",
    server: "topologyWeightAuto",
    min: 0,
    max: 1,
    sja: "トポロジー: 自動観測",
    sen: "topology: auto observations",
    ja: "トポロジー選択での自動観測(品質/ok率)の重み",
    en: "weight of automatic observations (quality/ok-rate) in topology selection",
  },
  {
    alias: "topocalls",
    server: "maxTopologyCalls",
    min: 1,
    max: 16,
    integer: true,
    sja: "応答あたりの補助呼出上限",
    sen: "max auxiliary calls",
    ja: "応答あたりの補助呼び出し上限(コストガード)",
    en: "max auxiliary calls per response (cost guard)",
  },
  {
    alias: "topoexplore",
    server: "topologyExploreRate",
    min: 0,
    max: 1,
    sja: "トポロジー: 探索率(ε)",
    sen: "topology: exploration rate",
    ja: "トポロジー選択の ε-greedy 探索確率(0..1)。0 で貪欲選択のみ",
    en: "ε-greedy exploration probability for topology selection (0..1). 0 = greedy only",
  },
  {
    alias: "topo-prior",
    server: "topologyPriorStrength",
    min: 1,
    max: 20,
    integer: true,
    sja: "トポロジー: ベイズ事前の強さ",
    sen: "topology: Bayesian prior strength",
    ja: "トポロジー選択におけるベイズ事前の疑似観測数(1..20)。大きいほど事前分布に強く引っ張られる",
    en: "pseudocount (1..20) of the Bayesian prior in topology selection; higher anchors more strongly to the prior",
  },
  {
    alias: "rescuattempts",
    server: "rescueAttemptsBeforeSwitch",
    min: 1,
    max: 10,
    integer: true,
    sja: "レスキュー: 切替前に許す試行数",
    sen: "rescue: attempts before switch",
    ja: "レスキュー切替前に許す連続失敗回数（デフォルト 3、範囲 1..10）。\n- 1回目の失敗は待機し、リトライに備える",
    en: "rescue: attempts before switch before the session is moved to a healthy model (default 3, range 1..10). 1st failure waits; let retries happen",
  },
  {
    alias: "varexplore",
    server: "variantExploreRate",
    min: 0,
    max: 1,
    sja: "variant: 探索率(ε)",
    sen: "variant: exploration rate",
    ja: "variant選択の ε-greedy 探索確率(0..1)。0 で計算値のみ",
    en: "ε-greedy exploration probability for variant selection (0..1). 0 = computed pick only",
  },
]

// Presets for /fusion-params (select option -> partial update).
const WEIGHT_PRESETS: Record<string, Record<string, number>> = {
  balanced: {
    costWeight: 0.1,
    latencyWeight: 0.05,
    exploreRate: 0.05,
    learningRate: 0.3,
  },
  "cost-first": { costWeight: 0.25, latencyWeight: 0.1 },
  "quality-first": { costWeight: 0.02, latencyWeight: 0.02 },
  snappy: { costWeight: 0.05, latencyWeight: 0.2 },
  "audit-on": { autoReviewWeight: 0.2 },
}

type FusionConfig = {
  enabled?: boolean
  providerID?: string
  crossProvider?: boolean
  // v1.1.1: priority-ordered provider fallback chain (empty = single-provider mode)
  providerChain?: string[]
  exploreRate?: number
  learningRate?: number
  minObservations?: number
  costWeight?: number
  latencyWeight?: number
  classifierModel?: string | null
  kinds?: string[]
  models?: string[]
  // v1.1.1: how the models list is interpreted (whitelist / blacklist)
  listMode?: "whitelist" | "blacklist"
  maxInputCost?: number
  maxOutputCost?: number
  benchmarkPriorWeight?: number
  benchmarksFile?: string
  reviewModel?: string | null
  jevMode?: "auto" | "off"
  topologyMode?: "auto" | "fixed"
  maxTopologyCalls?: number
  allowedTopologies?: string[]
  topologyWeightJev?: number
  topologyWeightHumanCP?: number
  topologyWeightAuto?: number
  // v1.1: ε-greedy exploration rate for topology selection
  topologyExploreRate?: number
  // v1.1: Bayesian prior strength (pseudo-observations, 1..20)
  topologyPriorStrength?: number
  // v1.1: rescue (after-fail) switch: allow up to N consecutive transient failures before the session is moved to a healthy model.
  rescueAttemptsBeforeSwitch?: number
  // v1.1: reasoning-effort (variant) selection (off/auto/fixed)
  variantMode?: "off" | "auto" | "fixed"
  // v1.1: variant forced in variantMode=fixed (null = unset)
  variantFixed?: string | null
  // v1.1: ε for exploring non-computed variants (0..1)
  variantExploreRate?: number
  chainMode?: "off" | "active"
  tierMode?: "off" | "manual" | "auto"
  tiers?: { heavy?: string[]; middle?: string[]; light?: string[] }
  jevAvailable?: boolean
  // v0.9.0: display language (ja/en)
  lang?: "ja" | "en"
  // v1.0: independent-audit auto-review weight in routing quality (0 = shadow only)
  autoReviewWeight?: number
  // v1.0: daily auto-refresh of the benchmark library (toggle-ON linked)
  benchAutoUpdate?: boolean
}

const formatConfig = (c: FusionConfig, en = false): string => {
  const T = (ja: string, eng: string) => (en ? eng : ja)
  const lines = [
    `provider      : ${c.providerID ?? "-"}${c.crossProvider ? T(" (cross: 全プロバイダー混合)", " (cross: all providers mixed)") : (c.providerChain ?? []).length > 0 ? T(` (chain: ${(c.providerChain ?? []).join(" -> ")})`, ` (chain: ${(c.providerChain ?? []).join(" -> ")})`) : ""}`,
    `routing       : ${c.enabled ? "ON" : "OFF"}`,
    `lang          : ${c.lang ?? "-"}`,
    `exploreRate   : ${c.exploreRate ?? "-"} (learning ${c.learningRate ?? "-"} / minObs ${c.minObservations ?? "-"})`,
    `weights       : cost ${c.costWeight ?? "-"} / latency ${c.latencyWeight ?? "-"}`,
    `autoReview    : ${c.autoReviewWeight ?? "-"} (v1.0: audit weight inside the quality term, 0 = shadow only)`,
    `classifier    : ${c.classifierModel ?? T("(分類なし)", "(none)")}`,
    `reviewModel   : ${c.reviewModel ?? T("(classifierModel と同じ経路 / 共有フォールバック)", "(same path as classifierModel / shared fallback)")}`,
    `jev           : ${c.jevMode === "off" ? "OFF (jevMode=off)" : c.jevAvailable ? T("利用可能 (分類・トポロジー判定を Jev で実行)", "available (classification and topology run on Jev)") : T("キー未登録 — 従来経路で動作", "no key — using the legacy path")}`,
    `topology      : ${c.topologyMode === "fixed" ? T("fixed / single 固定", "fixed / always single") : T(`auto / ${(c.allowedTopologies ?? []).join(", ")} / 補助呼出上限 ${c.maxTopologyCalls ?? 4}`, `auto / ${(c.allowedTopologies ?? []).join(", ")} / aux call limit ${c.maxTopologyCalls ?? 4}`)}`,
    `topo weights  : ${T("jev事前", "jev prior")} ${c.topologyWeightJev ?? "-"} / ${T("コスパ", "cost-perf")} ${c.topologyWeightHumanCP ?? "-"} / ${T("自動観測", "auto")} ${c.topologyWeightAuto ?? "-"} / ${T("探索ε", "explore ε")} ${c.topologyExploreRate ?? "-"} / ${T("事前", "prior")} ${c.topologyPriorStrength ?? "-"} / ${T("レスキュー試行", "rescue attempts")} ${c.rescueAttemptsBeforeSwitch ?? "-"}`,
    `chain         : ${c.chainMode === "active" ? T("active (chain選択時にplanner計画をsystem注入)", "active (injects a planner plan as system context on chain turns)") : T("off (判定と記録のみ / /fusion-chainmode で切替)", "off (decide and record only / toggle with /fusion-chainmode)")}`,
    `tiers         : ${c.tierMode === "manual" ? "manual" : c.tierMode === "auto" ? T("auto (ベンチマークから3分割)", "auto (split from benchmarks)") : T("off (/fusion-tiermode で切替)", "off (toggle with /fusion-tiermode)")}`,
    `variant       : ${c.variantMode === "fixed" ? T(`fixed (#${c.variantFixed ?? "-"} / モデルに無い場合はスキップ / ε ${c.variantExploreRate ?? "-"})`, `fixed (#${c.variantFixed ?? "-"} / skipped when the model lacks it / ε ${c.variantExploreRate ?? "-"})`) : c.variantMode === "off" ? T(`off (effort/thinking は変更しない / ε ${c.variantExploreRate ?? "-"})`, `off (never touch effort/thinking / ε ${c.variantExploreRate ?? "-"})`) : T(`auto (Jev/LLMヒント+重量クラス補正+探索ε ${c.variantExploreRate ?? "-"}+観測学習 / 明示指定は優先)`, `auto (Jev/LLM hint + weight-class compensation + explore ε ${c.variantExploreRate ?? "-"} + outcome learning; explicit choice wins)`)}`,
    `  heavy        : ${((c.tiers?.heavy ?? []).join(", ")) || T("(空)", "(empty)")}`,
    `  middle       : ${((c.tiers?.middle ?? []).join(", ")) || T("(空)", "(empty)")}`,
    `  light        : ${((c.tiers?.light ?? []).join(", ")) || T("(空)", "(empty)")}`,
    `cost cap      : input ${c.maxInputCost ?? 0} / output ${c.maxOutputCost ?? 0} USD/Mtoken${T("(ホワイトリスト空時のみ)", " (only when the whitelist is empty)")}`,
    `bench prior   : weight ${c.benchmarkPriorWeight ?? "-"}${c.benchmarksFile ? ` / ${c.benchmarksFile}` : ""}${c.benchAutoUpdate === false ? " / auto-refresh OFF" : c.benchAutoUpdate === true ? (c.benchmarksFile ? " / auto-refresh skipped (custom file)" : " / auto-refresh ON (daily)") : ""}`,
    `kinds         : ${(c.kinds ?? []).join(", ")}`,
    `models        : ${c.listMode === "blacklist" ? T("ブラックリスト(リスト以外はコスト上限内で全候補)", "blacklist (everything except the list, within the cost caps)") : T("ホワイトリスト", "whitelist")} — ${(c.models ?? []).length === 0 ? (c.listMode === "blacklist" ? T("(無効=全候補)", "(inactive = all candidates)") : T("(全候補 + コスト上限)", "(all candidates + cost cap)")) : (c.models ?? []).join(", ")}`,
  ]
  return lines.join("\n")
}

export default Plugin.define({
  id: "adaptive-fusion.tui",
  setup(context) {
    // RPC client with a startup-race guard. The server loads plugins in the
    // background, so a command run right after a restart can hit
    // "rpc.unavailable" before the server part registers its RPC. Retry
    // briefly (up to ~3 s) for that case only; other errors surface as-is.
    const fusionClient = context.client.rpc(AdaptiveFusion)
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms))
    // Declared as a function statement: generic arrow functions in .tsx are
    // ambiguous with JSX and fail to parse.
    async function fusionReady<R>(call: () => Promise<R>): Promise<R> {
      let lastError: unknown
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          return await call()
        } catch (error) {
          lastError = error
          const text = `${(error as { message?: string })?.message ?? error}`
          if (!text.includes("rpc.unavailable")) throw error
          await sleep(400)
        }
      }
      throw lastError
    }
    const fusion = new Proxy(fusionClient, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver) as unknown
        if (typeof original !== "function") return original
        return (...callArgs: unknown[]) =>
          fusionReady(() =>
            (original as (...a: unknown[]) => unknown).apply(target, callArgs),
          )
      },
    }) as typeof fusionClient
    // RPC is registered per location scope, so the current TUI location must be
    // passed explicitly (if omitted, it falls back to the server working directory
    // and would reference an unregistered location, causing rpc.unavailable).
    const location = () => context.location ?? context.data.location.default()

    // v0.9.0: display language (ja/en). Install defaults are selected via options.lang in opencode.json.
    // Saved configuration (fusion/config's lang) takes priority and can be switched on-the-fly with /fusion-lang.
    const [lang, setLang] = createSignal<"ja" | "en">(
      (context as any).options?.lang === "en" ? "en" : "ja",
    )
    const tr = (ja: string, en: string): string =>
      lang() === "en" ? en : ja

    // fusion: signal for the persistent ON/OFF display (initial value is fetched from RPC on startup).
    // Jev's availability is not shown on the badge; check it with /fusion-config.
    const [fusionEnabled, setFusionEnabled] = createSignal<boolean | undefined>(
      undefined,
    )
    void (async () => {
      try {
        const result: any = await fusion.config({}, { location: location() })
        if (typeof result?.config?.enabled === "boolean")
          setFusionEnabled(result.config.enabled)
        // Apply the saved language setting (if unsaved, keep options.lang)
        if (result?.config?.lang === "ja" || result?.config?.lang === "en")
          setLang(result.config.lang)
      } catch {
        // On fetch failure, do not display (never block the TUI)
      }
    })()
    const fusionBadge = () => {
      const enabled = fusionEnabled()
      if (enabled === undefined) return null
      return (
        <text fg={context.theme.text.base}>
          {enabled ? "● fusion: ON" : "○ fusion: OFF"}
        </text>
      )
    }
    // Built-in footer shown by the home/prompt (after the built-in status,
    // before the version display); always visible
    context.ui.slot({ append: "home.footer.status", render: fusionBadge })
    context.ui.slot({ append: "prompt.footer.status", render: fusionBadge })

    const currentSessionID = async (): Promise<string | undefined> => {
      // Get it from the current root on screen (usually the session view)
      try {
        const route: any = (context.ui as any).router?.current?.()
        const routed = route?.sessionID ?? route?.data?.sessionID ?? route?.params?.sessionID
        if (typeof routed === "string" && routed.length > 0) return routed
      } catch {
        // In environments where the router is unavailable, fall back to the active session
      }

      // If there is exactly one active session, use it
      try {
        const active: any = await (context.client as any).session?.active?.({
          location: location(),
        })
        const source = active?.data ?? active
        const ids = Object.keys(source ?? {}).filter((id) => typeof source[id] === "object")
        if (ids.length === 1) return ids[0]
      } catch {
        // In environments where the active session cannot be retrieved, undefined
      }
      return undefined
    }

    type AutoReviewInfo = {
      average: number
      instruction: number
      accuracy: number
      completeness: number
      // v0.9.0: efficiency axis average (omitted when uncollected)
      efficiency?: number
      // v0.9.0: list of recent results (omitted when uncollected)
      results?: string[]
      reason: string
      reviewerRef: string
      total: number
    }
    type TurnStatsInfo = {
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
    type ReviewInfo = {
      sessionID: string
      // v0.9.0: target turn (0 = latest, 1 = one turn back, ...)
      offset?: number
      category: string
      messageID: string
      providerID: string
      modelID: string
      assignedAt: string
      preview: string
      instructionPreview: string
      responseLength: number
      feedbackAverage: number
      feedbackCount: number
      // v0.9.0: turn statistics (input/output tokens, cost, measured speed)
      turn?: TurnStatsInfo
      // v1.1.1: this turn's recorded human ratings (one review per turn)
      rated?: { rating?: number; topologyRating?: number }
      topology?: string
      topologyRatingAverage?: number
      topologyRatingCount?: number
      topologyCount?: number
      topologyOkRate?: number
      topologyAvgMs?: number
      topologyQualityAverage?: number
      chainPlan?: string
      load?: "heavy" | "middle" | "light"
      autoReview?: AutoReviewInfo
    }

    // Large dialog for displaying long text. Only the body is scrollable;
    // the title and close button stay fixed so they are always visible.
    const showLongText = (title: string, message: string) => {
      context.ui.dialog.set({ size: "large", centered: true })
      context.ui.dialog.show(
        () => (
          <box
            width={84}
            height={30}
            border
            borderColor={context.theme.border.base}
            backgroundColor={context.theme.background.raised.base}
            padding={1}
            flexDirection="column"
            gap={1}
          >
            <text fg={context.theme.text.base}>{title}</text>
            <scrollbox
              flexGrow={1}
              minHeight={4}
              borderColor={context.theme.border.base}
              backgroundColor={context.theme.background.raised.base}
            >
              <text fg={context.theme.text.base}>{message}</text>
            </scrollbox>
            <text
              fg={context.theme.text.base}
              flexShrink={0}
              onMouseDown={() => context.ui.dialog.clear()}
            >
              {tr("[閉じる] (Esc)", "[close] (Esc)")}
            </text>
          </box>
        ),
        () => undefined,
      )
    }

    const closeReviewUI = () => {
      // Allow closing from either the review panel or a custom dialog
      try {
        (context.ui.dialog as any).clear?.()
      } catch {
        // In built-ins where the dialog API is unavailable, leave closing to the panel side
      }
      try {
        (context.ui as any).panel?.close?.()
      } catch {
        // In environments where the panel API is unavailable, ignore it
      }
    }

    const ReviewPanel = (props: {
      sessionID: string
      close: () => void
      // v0.9.0: target turn (0 = latest, 1 = one turn back, ...). Defaults to 0 (latest).
      initialOffset?: number
    }) => {
      const [offset, setOffset] = createSignal(
        props.initialOffset !== undefined && props.initialOffset > 0
          ? props.initialOffset
          : 0,
      )
      const [info, setInfo] = createSignal<ReviewInfo>()
      const [summary, setSummary] = createSignal("")
      const [busy, setBusy] = createSignal(false)
      const [message, setMessage] = createSignal(
        tr(
          "応答の質を1〜5で評価してください。",
          "Rate the response quality from 1 to 5.",
        ),
      )

      const load = async () => {
        try {
          const result = (await fusion.reviewInfo(
            { sessionID: props.sessionID, offset: offset() },
            { location: location() },
          )) as ReviewInfo
          setInfo(result)
        } catch (error) {
          setMessage(tr(`読込失敗: ${errorText(error)}`, `Load failed: ${errorText(error)}`))
        }
      }
      void load()

      // v0.9.0: move the target turn (0 = latest, 1 = one turn back, ...).
      const shiftOffset = async (delta: number) => {
        const next = Math.max(0, offset() + delta)
        if (next === offset()) return
        setOffset(next)
        setSummary("")
        await load()
      }

      const generateSummary = async () => {
        setBusy(true)
        try {
          const result = await fusion.reviewSummary(
            { sessionID: props.sessionID, offset: offset() },
            { location: location() },
          )
          setSummary(result.text)
        } catch (error) {
          setMessage(
            tr(`サマリー失敗: ${errorText(error)}`, `Summary failed: ${errorText(error)}`),
          )
        } finally {
          setBusy(false)
        }
      }

      const rate = async (rating: number) => {
        setBusy(true)
        try {
          const result = await fusion.reviewRate(
            { sessionID: props.sessionID, rating, offset: offset() },
            { location: location() },
          )
          setMessage(result.ok
            ? tr(
                `${result.message} — 平均 ${result.feedbackAverage.toFixed(1)}/5 (${result.feedbackCount}件)`,
                `${result.message} — average ${result.feedbackAverage.toFixed(1)}/5 (${result.feedbackCount} entries)`,
              )
            : result.message)
          await load()
        } catch (error) {
          setMessage(tr(`評価失敗: ${errorText(error)}`, `Rating failed: ${errorText(error)}`))
        } finally {
          setBusy(false)
        }
      }
      // Cost-performance rating of the topology (orchestration shape) [second row]
      const rateTopology = async (topologyRating: number) => {
        setBusy(true)
        try {
          const result = await fusion.reviewRate(
            { sessionID: props.sessionID, topologyRating, offset: offset() },
            { location: location() },
          )
          setMessage(result.ok ? result.message : result.message)
          await load()
        } catch (error) {
          setMessage(
            tr(
              `トポロジーコスパ評価失敗: ${errorText(error)}`,
              `Topology cost-performance rating failed: ${errorText(error)}`,
            ),
          )
        } finally {
          setBusy(false)
        }
      }

      return (
        <box flexDirection="column" padding={1} gap={0} flexGrow={1} minHeight={0} backgroundColor={context.theme.background.raised.base}>
          <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <text fg={context.theme.text.base}>
              {tr(
                `Adaptive Fusion — 応答レビュー${offset() > 0 ? `(ターン: ${offset()}個前)` : "(最新応答)"}`,
                `Adaptive Fusion — Response review ${offset() > 0 ? `(${offset()} turn(s) back)` : "(latest)"}`,
              )}
            </text>
            <text fg={context.theme.text.base} onMouseDown={() => props.close()}>{tr("[閉じる]", "[close]")}</text>
          </box>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text
              fg={context.theme.text.base}
              onMouseDown={() => void shiftOffset(1)}
            >
              {tr("[◀ 古い方へ]", "[◀ older]")}
            </text>
            <text
              fg={context.theme.text.base}
              onMouseDown={() => void shiftOffset(-1)}
            >
              {offset() > 0 ? tr("[▶ 新しい方へ]", "[▶ newer]") : tr("[▶ 最新(現在)]", "[▶ latest]")}
            </text>
          </box>
          <text fg={context.theme.text.base}>
            {tr("担当", "Category")}: {info()?.category ?? tr("(読込中)", "(loading)")} | {tr("負荷", "Load")}: {info()?.load ?? tr("(未推定)", "(unset)")} | {tr("モデル", "Model")}: {info() ? `${info()!.providerID}/${info()!.modelID}` : "-"}
          </text>
          <text fg={context.theme.text.base}>
            {tr("依頼", "Request")}: {info()?.instructionPreview
              ? info()!.instructionPreview.replace(/\s+/g, " ").slice(0, 84) + (info()!.instructionPreview.replace(/\s+/g, " ").length > 84 ? "…" : "")
              : tr("(読込中)", "(loading)")}
          </text>
          <text fg={context.theme.text.base}>
            {info()?.turn
              ? tr(
                  `ターン統計: 入 ${info()!.turn!.inputTokens.toLocaleString("en-US")} → 出 ${info()!.turn!.outputTokens.toLocaleString("en-US")} tok / 推論 ${info()!.turn!.reasoningTokens.toLocaleString("en-US")} / cache読み ${info()!.turn!.cacheRead.toLocaleString("en-US")} / $${info()!.turn!.cost.toFixed(6)}`,
                  `Turn stats: in ${info()!.turn!.inputTokens.toLocaleString("en-US")} → out ${info()!.turn!.outputTokens.toLocaleString("en-US")} tok / reasoning ${info()!.turn!.reasoningTokens.toLocaleString("en-US")} / cache-read ${info()!.turn!.cacheRead.toLocaleString("en-US")} / $${info()!.turn!.cost.toFixed(6)}`,
                )
              : tr("ターン統計: (記録なし)", "Turn stats: (none recorded)")}
          </text>
          {info()?.turn
            ? (
              <text fg={context.theme.text.base}>
                {tr("↳ 実測", "↳ measured")} {(info()!.turn!.durationMs / 1000).toFixed(1)}s{info()!.turn!.tps > 0 ? ` / ${info()!.turn!.tps.toFixed(1)} tok/s` : ""} / finish: {info()!.turn!.finish || "?"}
              </text>
            )
            : null}
          <text fg={context.theme.text.base}>
            {tr("人間評価", "Human rating")}: {info() && info()!.feedbackCount > 0
              ? `${info()!.feedbackAverage.toFixed(1)}/5 (${info()!.feedbackCount}${tr("件", " entries")})`
              : tr("まだ評価なし", "no ratings yet")}
            {"  "}
            {tr("トポロジー", "Topology")}: {info()?.topology ?? "single"}
            {info() && (info()!.topologyCount ?? 0) > 0
              ? tr(
                  ` (${info()!.topologyCount}回 / ok ${Math.round((info()!.topologyOkRate ?? 0) * 100)}% / ${((info()!.topologyAvgMs ?? 0) / 1000).toFixed(1)}s`,
                  ` (${info()!.topologyCount} runs / ok ${Math.round((info()!.topologyOkRate ?? 0) * 100)}% / ${((info()!.topologyAvgMs ?? 0) / 1000).toFixed(1)}s`,
                )
              : tr(" (観測なし)", " (no observations)")}
            {info() && (info()!.topologyCount ?? 0) > 0
              ? `${(info()!.topologyQualityAverage ?? 0) > 0 ? `, ${tr("品質", "quality")} ${info()!.topologyQualityAverage!.toFixed(1)}` : ""}, ${tr("コスパ", "cost-perf")} ${(info()!.topologyRatingCount ?? 0) > 0 ? info()!.topologyRatingAverage!.toFixed(1) : tr("未評価", "n/a")})`
              : ""}
          </text>
          {info()?.chainPlan
            ? (
              <text fg={context.theme.text.base}>
                {tr("実行計画(chain)", "Chain plan")}: {info()!.chainPlan!.replace(/\s+/g, " ").slice(0, 84)}{info()!.chainPlan!.replace(/\s+/g, " ").length > 84 ? "…" : ""}
              </text>
            )
            : null}
          <text fg={context.theme.text.base}>
            {tr("自動審査(shadow)", "Auto-review (shadow)")}: {info()?.autoReview
              ? `${info()!.autoReview!.average.toFixed(2)}/5 (${info()!.autoReview!.total}${tr("件", " entries")}) — ${tr("指示", "instr")}${info()!.autoReview!.instruction.toFixed(1)} / ${tr("正確性", "acc")}${info()!.autoReview!.accuracy.toFixed(1)} / ${tr("完全性", "comp")}${info()!.autoReview!.completeness.toFixed(1)}${info()!.autoReview!.efficiency !== undefined ? ` / ${tr("コスパ", "eff")}${info()!.autoReview!.efficiency.toFixed(1)}` : ""}`
              : tr("未審査(次の応答から記録)", "not reviewed yet (recorded from the next response)")}
          </text>
          <scrollbox
            flexGrow={1}
            minHeight={4}
            border
            borderColor={context.theme.border.base}
            backgroundColor={context.theme.background.raised.base}
            padding={1}
          >
            {info()?.autoReview?.results?.length
              ? (
                <box flexDirection="column" flexShrink={0}>
                  {info()!.autoReview!.results!.map((item, index) => (
                    <text key={String(index)} fg={context.theme.text.base}>
                      {tr("実績", "Result")}{index + 1}: {item}
                    </text>
                  ))}
                </box>
              )
              : null}
            {info()?.autoReview?.reason
              ? <text fg={context.theme.text.base}>{tr("自動理由", "Auto reason")}: {info()!.autoReview!.reason}</text>
              : null}
            {(info()?.autoReview?.results?.length || info()?.autoReview?.reason)
              ? (
                <text fg={context.theme.textMuted?.base ?? context.theme.text.base}>
                  ─── {tr("応答本文", "Response body")} ───
                </text>
              )
              : null}
            <text fg={context.theme.text.base}>{info()?.preview ?? tr("(読込中)", "(loading)")}</text>
          </scrollbox>
          {summary() && (
            <box
              border
              borderColor={context.theme.border.base}
              backgroundColor={context.theme.background.raised.base}
              padding={1}
              height={4}
              flexShrink={0}
            >
              <text fg={context.theme.text.base}>{tr("3行サマリー", "Three-line summary")}</text>
              <text fg={context.theme.text.base}>{summary()}</text>
            </box>
          )}
          <text fg={context.theme.text.base}>{tr("モデル評価(1〜5)", "Model rating (1-5)")}</text>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={context.theme.text.base} onMouseDown={() => void generateSummary()}>
              {busy() ? tr("[サマリー生成中…]", "[generating summary…]") : tr("[サマリーを生成]", "[generate summary]")}
            </text>
            {info()?.rated?.rating !== undefined
              ? <text fg={context.theme.textMuted?.base ?? context.theme.text.base}>{tr(`評価済み: ${info()!.rated!.rating}/5`, `rated: ${info()!.rated!.rating}/5`)}</text>
              : [1, 2, 3, 4, 5].map((n) => (
                <text key={n} fg={context.theme.text.base} onMouseDown={() => void rate(n)}>[{n}]</text>
              ))}
          </box>
          <text fg={context.theme.text.base}>{tr("トポロジーコスパ評価(1〜5)", "Topology cost-performance rating (1-5)")}</text>
          <box flexDirection="row" gap={1} flexShrink={0}>
            {info()?.rated?.topologyRating !== undefined
              ? <text fg={context.theme.textMuted?.base ?? context.theme.text.base}>{tr(`評価済み: ${info()!.rated!.topologyRating}/5`, `rated: ${info()!.rated!.topologyRating}/5`)}</text>
              : [1, 2, 3, 4, 5].map((n) => (
                <text key={n} fg={context.theme.text.base} onMouseDown={() => void rateTopology(n)}>[{n}]</text>
              ))}
          </box>
          <text fg={context.theme.text.base}>{message()}</text>
        </box>
      )
    }

    // /fusion-params (v1.1: renamed from /fusion-weights): presets + custom
    // coefficient editor. Defined once; /fusion-weights reuses it as an alias.
    async function fusionParamsDialog() {
      try {
        const current = await fusion.config({}, { location: location() })
        const c = current.config
        const choice = await context.ui.dialog.select({
          title: "adaptive-fusion params",
          current: "balanced",
          options: [
            {
              title: "balanced",
              value: "balanced",
              category: tr("プリセット", "presets"),
              description: tr("既定のバランス", "default balance"),
            },
            {
              title: "cost-first",
              value: "cost-first",
              description: tr("コスト重視", "cost matters most"),
            },
            {
              title: "quality-first",
              value: "quality-first",
              description: tr("品質重視(コスト弱め)", "weaker cost penalty"),
            },
            {
              title: "snappy",
              value: "snappy",
              description: tr("速度重視", "latency first"),
            },
            {
              title: "audit-on",
              value: "audit-on",
              description: tr("監査重み 0.2", "audit weight 0.2"),
            },
            {
              title: "custom",
              value: "custom",
              category: tr("編集", "edit"),
              description: tr("係数を検索して編集", "search and edit coefficients"),
            },
          ],
        })
        if (!choice) return
        if (choice !== "custom") {
          const update = WEIGHT_PRESETS[choice]
          const result = await fusion.config(
            { update },
            { location: location() },
          )
          context.ui.toast.show({
            message: `params: ${choice}`,
            variant: "success",
          })
          showLongText(
            "adaptive-fusion config",
            formatConfig(result.config, lang() === "en"),
          )
          return
        }
        // Custom = combobox (v1.0). A single native combobox widget is
        // not available in the dialog API, so compose a searchable
        // select with per-option descriptions (type-to-filter, help
        // text shown by the host without cluttering the list) with a
        // prompt prefilled with the current value per field. Editing
        // loops back to the list; Esc finishes.
        {
          let cur: FusionConfig = c
          for (;;) {
            const picked = await context.ui.dialog.select({
              title: tr(
                "編集する係数を選択(Esc で終了)",
                "Pick a coefficient to edit (Esc to finish)",
              ),
              options: WEIGHT_FIELDS.map((f) => ({
                title: `${f.alias} = ${(cur as any)[f.server] ?? "-"}`,
                value: f.alias,
                // One-line help: kept short so each row stays on one
                // line (the host renders title + description inline).
                description: tr(
                  `${f.sja}(${f.min}〜${f.max}${f.integer ? "・整数" : ""})`,
                  `${f.sen} (${f.min}..${f.max}${f.integer ? ", integer" : ""})`,
                ),
              })),
              // Match aliases and description words (e.g. "topo" or "コスト")
              search: (query, options) =>
                options.filter(
                  (o) =>
                    o.title.toLowerCase().includes(query.toLowerCase()) ||
                    (o.description ?? "")
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                ),
              // Full help on demand, without cluttering the list
              actions: [
                {
                  bind: "ctrl+h",
                  title: tr("help", "help"),
                  onTrigger: (value) => {
                    const f = WEIGHT_FIELDS.find((x) => x.alias === value)
                    if (!f) return
                    context.ui.toast.show({
                      title: `adaptive-fusion: ${f.alias}`,
                      message: tr(f.ja, f.en),
                      duration: 8000,
                    })
                  },
                },
              ],
            })
            if (!picked) break
            const field = WEIGHT_FIELDS.find((f) => f.alias === picked)
            if (!field) break
            const help = tr(field.sja, field.sen)
            const range = tr(
              `${field.min}〜${field.max}${field.integer ? "・整数" : ""}`,
              `${field.min}..${field.max}${field.integer ? ", integer" : ""}`,
            )
            const input = await context.ui.dialog.prompt({
              title: `adaptive-fusion params: ${field.alias}`,
              // Description shown while editing too
              placeholder: `${help} — ${range}`,
              default: String((cur as any)[field.server] ?? ""),
            })
            if (input === undefined) continue
            const num = Number(input.trim())
            if (!Number.isFinite(num) || num < field.min || num > field.max) {
              context.ui.toast.show({
                message: tr(
                  `${field.alias} は ${field.min}〜${field.max} の数値で入力してください`,
                  `${field.alias} must be a number from ${field.min} to ${field.max}`,
                ),
                variant: "error",
              })
              continue
            }
            const value = field.integer ? Math.floor(num) : num
            const result = await fusion.config(
              { update: { [field.server]: value } },
              { location: location() },
            )
            cur = result.config
            context.ui.toast.show({
              message: `params: ${field.alias} = ${value}`,
              variant: "success",
            })
          }
          return
        }
      } catch (error) {
        context.ui.toast.show({
          message: `fusion-params: ${errorText(error)}`,
          variant: "error",
        })
      }
    }

    // /fusion-modellist (v1.1.1: renamed from /fusion-whitelist): stack editor
    // with a whitelist/blacklist mode toggle and provider-grouped entries.
    // Defined once; /fusion-whitelist reuses it as an alias.
    async function fusionModelListDialog() {
      try {
        const current = await fusion.config({}, { location: location() })
        const seedMode = current.config.listMode ?? "whitelist"
        const seedList = [...(current.config.models ?? [])]
        let mode: "whitelist" | "blacklist" = seedMode
        let list: string[] = [...seedList]
        let focusIndex = -1
        let modeToggled = false

        const entryCategory = (entry: string) => {
          const slash = entry.indexOf("/")
          return slash > 0
            ? entry.slice(0, slash)
            : (current.config.providerID ?? "provider")
        }

        const addModel = async (): Promise<void> => {
          const input = await context.ui.dialog.prompt({
            title: tr(
              "adaptive-fusion: モデルを入力(例: opencode-go/qwen4-max)",
              "adaptive-fusion: enter a model (e.g. opencode-go/qwen4-max)",
            ),
            placeholder: tr(
              "provider/model-id(推奨)または model-id。入力して Enter でリストに追加",
              "provider/model-id (recommended) or model-id. Enter to add it to the list",
            ),
          })
          if (input === undefined) return
          const entry = input.trim()
          if (entry.length === 0) return
          if (list.includes(entry)) {
            context.ui.toast.show({
              message: tr(
                `${entry} は既にリストに含まれています`,
                `${entry} is already in the list`,
              ),
              variant: "error",
            })
            return
          }
          if (list.length >= 200) {
            context.ui.toast.show({
              message: tr(
                "リストは最大200件です",
                "the list holds at most 200 entries",
              ),
              variant: "error",
            })
            return
          }
          list.push(entry)
          focusIndex = list.length - 1
        }

        for (;;) {
          // Group entries by provider (stable: list order kept within a group)
          const byProvider = new Map<string, number[]>()
          list.forEach((entry, i) => {
            const cat = entryCategory(entry)
            if (!byProvider.has(cat)) byProvider.set(cat, [])
            byProvider.get(cat)!.push(i)
          })
          const groupOrder = [...byProvider.keys()].sort()
          const picked = await context.ui.dialog.select({
            title: tr(
              `モデルリスト(${mode === "blacklist" ? "ブラックリスト: リスト以外を利用" : "ホワイトリスト: リストのみ利用"} / Esc で終了)`,
              `Model list (${mode === "blacklist" ? "blacklist: everything except the list" : "whitelist: only the list"} / Esc to finish)`,
            ),
            ...(focusIndex >= 0 && focusIndex < list.length
              ? { current: `item:${focusIndex}` }
              : {}),
            options: [
              {
                title: tr(
                  `⇄ モード: ${mode === "blacklist" ? "ブラックリスト" : "ホワイトリスト"}(切替)`,
                  `⇄ mode: ${mode === "blacklist" ? "blacklist" : "whitelist"} (toggle)`,
                ),
                value: "mode",
                category: tr("操作", "actions"),
                description: tr(
                  mode === "blacklist"
                    ? "現在: リスト以外の全候補(コスト上限内)を利用 → ホワイトリストへ"
                    : "現在: リストのモデルのみ利用 → ブラックリストへ(リストは消去)",
                  mode === "blacklist"
                    ? "now: every candidate except the list (within cost caps) -> whitelist"
                    : "now: only the listed models -> blacklist (list is cleared)",
                ),
              },
              ...groupOrder.flatMap((cat) =>
                byProvider.get(cat)!.map((i) => ({
                  title: list[i],
                  value: `item:${i}`,
                  category: cat,
                  description:
                    mode === "blacklist"
                      ? tr("除外対象(候補から除く)", "excluded (kept out of candidates)")
                      : tr("候補として許可", "allowed as a candidate"),
                })),
              ),
              {
                title: tr("➕ モデルを追加", "➕ add a model"),
                value: "add",
                category: tr("操作", "actions"),
                description: tr(
                  "入力して Enter で追加(provider/model-id 推奨)",
                  "type and press Enter (provider/model-id recommended)",
                ),
              },
              ...(list.length > 0
                ? [
                    {
                      title: tr("✕ リストを全消去", "✕ clear the list"),
                      value: "clear",
                      category: tr("操作", "actions") as string,
                      description: tr(
                        "すべてのエントリを削除",
                        "remove every entry",
                      ) as string,
                    },
                  ]
                : []),
              {
                title: tr("✔ 完了(保存して終了)", "✔ done (save and finish)"),
                value: "done",
                category: tr("操作", "actions"),
                description: tr(
                  "リストとモードを保存(Esc でも終了)",
                  "save the list and mode (Esc also finishes)",
                ),
              },
            ],
          })
          if (!picked || picked === "done") break
          if (picked === "mode") {
            mode = mode === "blacklist" ? "whitelist" : "blacklist"
            // Toggling reinterprets every entry: clear to avoid accidentally
            // blocking the old allowlist (confirm first).
            if (list.length > 0) {
              const ok = await context.ui.dialog.confirm({
                title: tr("モデルリストのモード切替", "Model list mode toggle"),
                message: tr(
                  "モードを切り替えるとリストの意味が反転します。現在のリストを消去しますか?(キャンセルでモード切替も中止)",
                  "Toggling the mode inverts the meaning of the list. Clear the current list? (Cancel aborts the toggle.)",
                ),
                label: { confirm: tr("消去して切替", "Clear and toggle"), cancel: "Cancel" },
              })
              if (!ok) {
                mode = mode === "blacklist" ? "whitelist" : "blacklist"
                continue
              }
              list = []
              focusIndex = -1
            }
            modeToggled = true
            continue
          }
          if (picked === "add") {
            await addModel()
            continue
          }
          if (picked === "clear") {
            list = []
            focusIndex = -1
            continue
          }
          const m = /^item:(\d+)$/.exec(picked)
          if (!m) continue
          const index = Number(m[1])
          if (index < 0 || index >= list.length) continue
          focusIndex = index
          const action = await context.ui.dialog.select({
            title: list[index],
            current: "remove",
            options: [
              {
                title: tr("✕ リストから削除", "✕ remove from the list"),
                value: "remove",
                description:
                  mode === "blacklist"
                    ? tr("除外を解除し候補に戻す", "lift the exclusion; it becomes a candidate again")
                    : tr("候補から外す", "drop it from the candidates"),
              },
              {
                title: tr("✏ エントリを編集", "✏ edit the entry"),
                value: "edit",
                description: tr("provider/model-id を修正", "fix the provider/model-id"),
              },
              {
                title: tr("← 戻る", "← back"),
                value: "back",
                category: tr("操作", "actions"),
                description: tr("リストに戻る", "back to the list"),
              },
            ],
          })
          if (!action || action === "back") continue
          if (action === "remove") {
            list.splice(index, 1)
            focusIndex = Math.min(index, list.length - 1)
          } else if (action === "edit") {
            const input = await context.ui.dialog.prompt({
              title: tr("adaptive-fusion: エントリを編集", "adaptive-fusion: edit the entry"),
              placeholder: "provider/model-id",
              default: list[index],
            })
            if (input === undefined) continue
            const entry = input.trim()
            if (entry.length === 0 || entry === list[index]) continue
            if (list.includes(entry)) {
              context.ui.toast.show({
                message: tr(
                  `${entry} は既にリストに含まれています`,
                  `${entry} is already in the list`,
                ),
                variant: "error",
              })
              continue
            }
            list[index] = entry
          }
        }

        const unchanged =
          !modeToggled &&
          JSON.stringify(list) === JSON.stringify(seedList)
        if (unchanged) return
        const result = await fusion.config(
          { update: { models: list, listMode: mode } },
          { location: location() },
        )
        const c = result.config
        const entries = c.models ?? []
        context.ui.toast.show({
          message:
            c.listMode === "blacklist"
              ? tr(
                  `blacklist: ${entries.length}件除外(それ以外はコスト上限内で全候補)`,
                  `blacklist: ${entries.length} excluded (everything else, within cost caps)`,
                )
              : entries.length === 0
                ? tr("whitelist: (空=全候補+コスト上限)", "whitelist: (empty = all candidates + cost caps)")
                : tr(`whitelist: ${entries.length}件`, `whitelist: ${entries.length} entries`),
          variant: "success",
        })
        showLongText("adaptive-fusion config", formatConfig(c, lang() === "en"))
      } catch (error) {
        context.ui.toast.show({
          message: `fusion-modellist: ${errorText(error)}`,
          variant: "error",
        })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fusion.stats",
          title: tr("adaptive-fusion: 学習統計を表示", "adaptive-fusion: show learning statistics"),
          slash: { name: "fusion-stats" },
          run: async () => {
            try {
              const result = await fusion.stats({}, { location: location() })
              showLongText("adaptive-fusion stats", result.text)
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-stats: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.toggle",
          title: tr("adaptive-fusion: ルーティングの有効/無効を切替", "adaptive-fusion: toggle routing on/off"),
          slash: { name: "fusion-toggle" },
          run: async () => {
            try {
              const result = await fusion.toggle({}, { location: location() })
              if (typeof result?.enabled === "boolean") setFusionEnabled(result.enabled)
              context.ui.toast.show({
                message: `routing ${result.enabled ? "ON" : "OFF"}`,
                variant: "success",
              })
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-toggle: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.lang",
          title: tr("adaptive-fusion: 表示言語を切り替え (ja/en)", "adaptive-fusion: switch display language (ja/en)"),
          slash: { name: "fusion-lang" },
          run: async () => {
            const choice = await context.ui.dialog.select({
              title: tr("表示言語", "Display language"),
              current: lang(),
              options: [
                { title: "日本語 (ja)", value: "ja" },
                { title: "English (en)", value: "en" },
              ],
            })
            if (choice !== "ja" && choice !== "en") return
            try {
              await fusion.config({ update: { lang: choice } }, { location: location() })
              setLang(choice)
              context.ui.toast.show({
                message: choice === "en" ? "language: English" : "言語: 日本語",
                variant: "success",
              })
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-lang: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.config",
          title: tr("adaptive-fusion: 現在の設定を表示", "adaptive-fusion: show current configuration"),
          slash: { name: "fusion-config" },
          run: async () => {
            try {
              const result = await fusion.config({}, { location: location() })
              showLongText("adaptive-fusion config", formatConfig(result.config, lang() === "en"))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-config: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.params",
          title: tr(
            "adaptive-fusion: ルーティング/トポロジーの重み係数を一括調整",
            "adaptive-fusion: batch-adjust routing/topology weights",
          ),
          slash: { name: "fusion-params" },
          run: () => fusionParamsDialog(),
        },
        {
          // v1.1: legacy alias kept for muscle memory; identical behavior.
          id: "fusion.weights",
          title: tr(
            "adaptive-fusion: 重み係数を一括調整 (/fusion-params と同じ)",
            "adaptive-fusion: batch-adjust weights (same as /fusion-params)",
          ),
          slash: { name: "fusion-weights" },
          run: () => fusionParamsDialog(),
        },
        {
          id: "fusion.reviewmodel",
          title: tr("adaptive-fusion: 内部審査(shadow)の担当モデルを設定", "adaptive-fusion: set the shadow auto-review model"),
          slash: { name: "fusion-reviewmodel" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const currentModel = current.config.reviewModel ?? ""
              const input = await context.ui.dialog.prompt({
                title: "adaptive-fusion review model",
                placeholder: tr("provider/model (空で解除 = classifierModel と同じフォールバック)", "provider/model (empty clears it = same fallback as classifierModel)"),
                default: currentModel,
              })
              if (input === undefined) return
              const reviewModel = input.trim()
              if (reviewModel !== "" && !reviewModel.includes("/")) {
                context.ui.toast.show({
                  message: tr("review model は provider/model 形式で入力してください(空で解除)", "review model must be in provider/model form (empty clears it)"),
                  variant: "error",
                })
                return
              }
              const result = await fusion.config(
                { update: { reviewModel: reviewModel === "" ? "" : reviewModel } },
                { location: location() },
              )
              context.ui.toast.show({
                message: reviewModel === "" ? tr("review model: 解除", "review model: cleared") : `review model: ${reviewModel}`,
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(result.config, lang() === "en"))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-reviewmodel: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.variantmode",
          title: tr("adaptive-fusion: reasoning effort(thinking レベル)の選択方法を設定", "adaptive-fusion: configure reasoning-effort (thinking level) selection"),
          slash: { name: "fusion-variantmode" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const choice = await context.ui.dialog.select({
                title: "adaptive-fusion variant mode",
                current: current.config.variantMode ?? "auto",
                options: [
                  {
                    title: "auto",
                    value: "auto",
                    description: tr(
                      "Jev/LLMのeffortヒント+モデル重量クラス補正+探索+観測学習(明示指定は優先)",
                      "Jev/LLM effort hint + weight-class compensation + exploration + outcome learning (explicit choice wins)",
                    ),
                  },
                  {
                    title: "fixed",
                    value: "fixed",
                    description: tr(
                      "常に指定variantを使用(モデルに無い場合はスキップ)",
                      "always use the fixed variant (skipped when the model lacks it)",
                    ),
                  },
                  {
                    title: "off",
                    value: "off",
                    description: tr(
                      "effort/thinking は変更しない",
                      "never touch effort/thinking",
                    ),
                  },
                ],
              })
              if (!choice) return
              let variantFixed: string | null =
                current.config.variantFixed ?? null
              if (choice === "fixed") {
                const input = await context.ui.dialog.prompt({
                  title: tr(
                    "adaptive-fusion: 固定するvariant (例: high / medium / max / xhigh)",
                    "adaptive-fusion: variant to fix (e.g. high / medium / max / xhigh)",
                  ),
                  placeholder: tr(
                    "low / medium / high / xhigh / max など。空でキャンセル",
                    "low / medium / high / xhigh / max... Empty cancels",
                  ),
                  default: current.config.variantFixed ?? "high",
                })
                if (input === undefined) return
                const trimmed = input.trim()
                if (trimmed.length === 0) return
                variantFixed = trimmed
              } else if (choice === "auto") {
                // Switching back to auto clears the stale fixed variant
                variantFixed = null
              }
              const result = await fusion.config(
                {
                  update: {
                    variantMode: choice,
                    ...(choice === "fixed" ? { variantFixed } : { variantFixed: null }),
                  },
                },
                { location: location() },
              )
              const c = result.config
              context.ui.toast.show({
                message:
                  c.variantMode === "auto"
                    ? tr(
                        `variant: auto(Jev/LLMヒント+クラス補正+探索ε ${c.variantExploreRate ?? "-"})`,
                        `variant: auto (Jev/LLM hint + class compensation + explore ε ${c.variantExploreRate ?? "-"})`,
                      )
                    : c.variantMode === "fixed"
                      ? tr(
                          `variant: fixed (#${c.variantFixed ?? "?"})`,
                          `variant: fixed (#${c.variantFixed ?? "?"})`,
                        )
                      : tr("variant: off(effort/thinking は変更しない)", "variant: off (never touch effort/thinking)"),
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(c, lang() === "en"))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-variantmode: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.chainmode",
          title: tr("adaptive-fusion: sequential-chain 補助実行(計画注入)の切替", "adaptive-fusion: toggle sequential-chain planning injection"),
          slash: { name: "fusion-chainmode" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const next = current.config.chainMode === "active" ? "off" : "active"
              const result = await fusion.config(
                { update: { chainMode: next } },
                { location: location() },
              )
              context.ui.toast.show({
                message:
                  result.config.chainMode === "active"
                    ? tr("chain 実行: active(chain 選択時に planner 計画を注入)", "chain execution: active (injects the planner plan on chain turns)")
                    : tr("chain 実行: off(判定と記録のみ)", "chain execution: off (decide and record only)"),
                variant: "success",
              })
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-chainmode: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.tiermode",
          title: tr("adaptive-fusion: ティアルーティング(負荷別 Light/Middle/Heavy)の切替", "adaptive-fusion: cycle tier routing (Light/Middle/Heavy)"),
          slash: { name: "fusion-tiermode" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const order = ["off", "manual", "auto"] as const
              const currentMode = current.config.tierMode ?? "off"
              const next = order[(order.indexOf(currentMode as any) + 1) % 3]
              const result = await fusion.config(
                { update: { tierMode: next } },
                { location: location() },
              )
              const label =
                next === "manual"
                  ? tr("manual(ユーザー定義ティア)", "manual (user-defined tiers)")
                  : next === "auto"
                  ? tr("auto(ベンチマークから3分割)", "auto (split from benchmarks)")
                  : tr("off(全候補から選択)", "off (select from all candidates)")
              context.ui.toast.show({
                message: `tier mode: ${label}`,
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(result.config, lang() === "en"))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-tiermode: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.tiers",
          title: tr("adaptive-fusion: ティアのモデル編成を設定(Heavy/Middle/Light)", "adaptive-fusion: edit tier model groups (Heavy/Middle/Light)"),
          slash: { name: "fusion-tiers" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const update: Record<string, string[]> = {}
              const specs: [string, string][] = [
                ["heavy", "Heavy"],
                ["middle", "Middle"],
                ["light", "Light"],
              ]
              for (const [tier, label] of specs) {
                const input = await context.ui.dialog.prompt({
                  title: `adaptive-fusion ${label} tier`,
                  placeholder:
                    tr("provider/model をカンマ区切りで(例: openrouter/z-ai/glm-5.3, openrouter/deepseek/...)。空でこのティアは変更なし", "Comma-separated provider/model refs (e.g. openrouter/z-ai/glm-5.3, openrouter/deepseek/...). Empty keeps this tier unchanged"),
                  default: (current.config.tiers?.[tier as "heavy"] ?? []).join(", "),
                })
                if (input === undefined) return // cancel
                const models = input
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                const invalid = models.filter((s) => !s.includes("/"))
                if (invalid.length > 0) {
                  context.ui.toast.show({
                    message: tr(`${label} tier: provider/model 形式で入力してください(不正: ${invalid.join(", ")})`, `${label} tier: enter provider/model refs (invalid: ${invalid.join(", ")})`),
                    variant: "error",
                  })
                  return
                }
                if (models.length > 0) update[tier] = models
              }
              const result = await fusion.config(
                { update: { tiers: update } },
                { location: location() },
              )
              context.ui.toast.show({
                message: tr("ティア編成を保存しました(tierMode が off の場合は /fusion-tiermode で有効化)", "Tier configuration saved (enable it with /fusion-tiermode when tierMode is off)"),
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(result.config, lang() === "en"))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-tiers: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.jevkey",
          title: tr("adaptive-fusion: Jev(TypeSafe) APIキーを登録/解除", "adaptive-fusion: register or clear the Jev (TypeSafe) API key"),
          slash: { name: "fusion-jev-key" },
          run: async () => {
            try {
              const status = await fusion.jevKey({}, { location: location() })
              const input = await context.ui.dialog.prompt({
                title: "adaptive-fusion jev key",
                placeholder: status.available
                  ? tr("現在利用可能 — 新しいキーを入力 / 空で解除", "Currently available — enter a new key, or leave empty to clear")
                  : tr("Jev APIキーを入力 / 空で解除(TYPESAFE_API_KEY 環境変数でも可)", "Enter the Jev API key, or leave empty to clear (TYPESAFE_API_KEY also works)"),
                default: "",
              })
              if (input === undefined) return
              const key = input.trim()
              const result = await fusion.jevKey({ key }, { location: location() })
              context.ui.toast.show({
                message: result.available
                  ? key === ""
                    ? tr("jev key: 解除(環境変数 TYPESAFE_API_KEY があればそちらを使用)", "jev key: cleared (TYPESAFE_API_KEY is used if set)")
                    : tr("jev key: 登録しました(利用可能)", "jev key: stored (available)")
                  : key === ""
                    ? tr("jev key: 解除しました", "jev key: cleared")
                    : tr("jev key: 登録しましたが、現在の設定では無効です(jevMode=off?)", "jev key: stored, but disabled by the current configuration (jevMode=off?)"),
                variant: "success",
              })
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-jev-key: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.review",
          title: tr("adaptive-fusion: 応答をサマリー/1〜5評価", "adaptive-fusion: summarize and rate a response (1-5)"),
          slash: { name: "fusion-review" },
          run: async () => {
            const sessionID = await currentSessionID()
            if (!sessionID) {
              context.ui.toast.show({
                message: tr("fusion-review: 現在のセッションを特定できませんでした", "fusion-review: could not identify the current session"),
                variant: "error",
              })
              return
            }
            // v0.9.0: target turn selection (0 = latest, 1 = one turn back, ...).
            // Responses whose bugs are found later can also be reviewed retroactively.
            let initialOffset = 0
            try {
              const turnInput = await context.ui.dialog.prompt({
                title: tr("adaptive-fusion review 対象ターン", "adaptive-fusion review: target turn"),
                placeholder: tr("0=最新, 1=1個前, 2=2個前… (空で最新)", "0=latest, 1=one turn back, 2=two turns back… (empty = latest)"),
                default: "0",
              })
              if (turnInput !== undefined && turnInput.trim().length > 0) {
                const parsed = Number(turnInput.trim())
                initialOffset =
                  Number.isInteger(parsed) && parsed > 0
                    ? Math.min(parsed, 50)
                    : 0
              }
            } catch {
              // In environments where the prompt is unavailable, fall back to the latest response
            }
            context.ui.dialog.set({ size: "large", centered: true })
            context.ui.dialog.show(
              () => (
                <box
                  width={92}
                  height={48}
                  border
                  borderColor={context.theme.border.base}
                  backgroundColor={context.theme.background.raised.base}
                >
                  <ReviewPanel
                    sessionID={sessionID}
                    close={closeReviewUI}
                    initialOffset={initialOffset}
                  />
                </box>
              ),
              () => undefined,
            )
          },
        },
        {
          // v1.1.1: renamed from /fusion-whitelist. Stack editor with a
          // whitelist/blacklist mode toggle and provider-grouped entries.
          id: "fusion.modellist",
          title: tr(
            "adaptive-fusion: モデルリスト編集(ホワイト/ブラックリスト・プロバイダー別)",
            "adaptive-fusion: edit the model list (whitelist/blacklist, grouped by provider)",
          ),
          slash: { name: "fusion-modellist" },
          run: () => fusionModelListDialog(),
        },
        {
          // v1.1.1: legacy alias of /fusion-modellist.
          id: "fusion.whitelist",
          title: tr(
            "adaptive-fusion: モデルリスト編集(/fusion-modellist と同じ)",
            "adaptive-fusion: edit the model list (same as /fusion-modellist)",
          ),
          slash: { name: "fusion-whitelist" },
          run: () => fusionModelListDialog(),
        },
        {
          id: "fusion.provider",
          title: tr("adaptive-fusion: ルーティング対象プロバイダーを変更(優先順付きチェーン可)", "adaptive-fusion: change the routing target provider (priority chain supported)"),
          slash: { name: "fusion-provider" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const originalChain = current.config.providerChain ?? []
              const seed =
                originalChain.length > 0
                  ? [...originalChain]
                  : current.config.providerID
                    ? [current.config.providerID]
                    : []
              // Working stack: add (type + Enter) appends; entries can be
              // swapped up/down, edited, or removed one by one.
              let chain: string[] = [...seed]
              // Reopen the list with this entry highlighted after an action
              let focusIndex = -1

              const addProvider = async (): Promise<void> => {
                const input = await context.ui.dialog.prompt({
                  title: tr(
                    "adaptive-fusion: プロバイダーIDを入力(例: opencode-go)",
                    "adaptive-fusion: enter a provider id (e.g. opencode-go)",
                  ),
                  placeholder: tr(
                    "入力して Enter でチェーンの末尾にスタック",
                    "type and press Enter to stack it at the end of the chain",
                  ),
                })
                if (input === undefined) return
                const id = input.trim()
                if (id.length === 0) return
                if (chain.includes(id)) {
                  context.ui.toast.show({
                    message: tr(
                      `${id} は既にチェーンに含まれています`,
                      `${id} is already in the chain`,
                    ),
                    variant: "error",
                  })
                  return
                }
                if (chain.length >= 8) {
                  context.ui.toast.show({
                    message: tr(
                      "チェーンは最大8件です",
                      "the chain holds at most 8 entries",
                    ),
                    variant: "error",
                  })
                  return
                }
                chain.push(id)
                focusIndex = chain.length - 1
              }

              const editProvider = async (index: number): Promise<void> => {
                const input = await context.ui.dialog.prompt({
                  title: tr(
                    "adaptive-fusion: プロバイダーIDを編集",
                    "adaptive-fusion: edit the provider id",
                  ),
                  placeholder: tr(
                    "新しい provider-id。空にすると削除",
                    "new provider-id. Empty removes the entry",
                  ),
                  default: chain[index],
                })
                if (input === undefined) return
                const id = input.trim()
                if (id.length === 0) {
                  chain.splice(index, 1)
                  focusIndex = Math.min(index, chain.length - 1)
                  return
                }
                if (chain.includes(id)) {
                  context.ui.toast.show({
                    message: tr(
                      `${id} は既にチェーンに含まれています`,
                      `${id} is already in the chain`,
                    ),
                    variant: "error",
                  })
                  return
                }
                chain[index] = id
              }

              for (;;) {
                const picked = await context.ui.dialog.select({
                  title: tr(
                    "ルーティングプロバイダーチェーン(上ほど優先 / Esc で終了)",
                    "Routing provider chain (higher = preferred; Esc to finish)",
                  ),
                  ...(focusIndex >= 0 && focusIndex < chain.length
                    ? { current: `item:${focusIndex}` }
                    : {}),
                  options: [
                    ...chain.map((p, i) => ({
                      title: `${i + 1}. ${p}`,
                      value: `item:${i}`,
                      description:
                        i === 0
                          ? tr(
                              "最優先(健全な限りここから選ばれる)",
                              "highest priority (used while healthy)",
                            )
                          : tr(
                              `${chain[i - 1]} が尽きたときのフォールバック`,
                              `fallback when ${chain[i - 1]} is exhausted`,
                            ),
                    })),
                    {
                      title: tr("➕ プロバイダーを追加", "➕ add a provider"),
                      value: "add",
                      category: tr("操作", "actions"),
                      description: tr(
                        "入力して Enter で末尾にスタック",
                        "type and press Enter to stack it at the end",
                      ),
                    },
                    {
                      title: tr("✔ 完了(保存して終了)", "✔ done (save and finish)"),
                      value: "done",
                      category: tr("操作", "actions"),
                      description: tr(
                        "チェーンを保存(Esc でも終了)",
                        "save the chain (Esc also finishes)",
                      ),
                    },
                  ],
                })
                if (!picked || picked === "done") break
                if (picked === "add") {
                  await addProvider()
                  continue
                }
                // Entry menu: swap up/down, edit, remove
                const m = /^item:(\d+)$/.exec(picked)
                if (!m) continue
                const index = Number(m[1])
                if (index < 0 || index >= chain.length) continue
                focusIndex = index
                const action = await context.ui.dialog.select({
                  title: `${index + 1}. ${chain[index]}`,
                  current: "up",
                  options: [
                    {
                      title: tr("↑ 一つ上へ(優先度を上げる)", "↑ move up (raise priority)"),
                      value: "up",
                      description:
                        index === 0
                          ? tr("既に最上位です", "already at the top")
                          : tr(
                              `${chain[index - 1]} と交換`,
                              `swap with ${chain[index - 1]}`,
                            ),
                    },
                    {
                      title: tr("↓ 一つ下へ(優先度を下げる)", "↓ move down (lower priority)"),
                      value: "down",
                      description:
                        index === chain.length - 1
                          ? tr("既に最下位です", "already at the bottom")
                          : tr(
                              `${chain[index + 1]} と交換`,
                              `swap with ${chain[index + 1]}`,
                            ),
                    },
                    {
                      title: tr("✏ プロバイダーIDを編集", "✏ edit the provider id"),
                      value: "edit",
                      description: tr(
                        "空入力でこのエントリを削除",
                        "empty input removes this entry",
                      ),
                    },
                    {
                      title: tr("✕ このエントリを削除", "✕ remove this entry"),
                      value: "remove",
                      description: tr(
                        "チェーンから取り除く",
                        "take it out of the chain",
                      ),
                    },
                    {
                      title: tr("← 戻る", "← back"),
                      value: "back",
                      category: tr("操作", "actions"),
                      description: tr(
                        "チェーン一覧に戻る",
                        "back to the chain list",
                      ),
                    },
                  ],
                })
                if (!action || action === "back") continue
                if (action === "up") {
                  if (index > 0) {
                    ;[chain[index - 1], chain[index]] = [
                      chain[index],
                      chain[index - 1],
                    ]
                    focusIndex = index - 1
                  }
                } else if (action === "down") {
                  if (index < chain.length - 1) {
                    ;[chain[index + 1], chain[index]] = [
                      chain[index],
                      chain[index + 1],
                    ]
                    focusIndex = index + 1
                  }
                } else if (action === "edit") {
                  await editProvider(index)
                } else if (action === "remove") {
                  chain.splice(index, 1)
                  focusIndex = Math.min(index, chain.length - 1)
                }
              }

              // Esc / done: persist only when the stack actually changed.
              const unchanged =
                JSON.stringify(chain) === JSON.stringify(seed)
              if (unchanged) return
              const result =
                chain.length >= 2
                  ? await fusion.config(
                      { update: { providerChain: chain, models: [] } },
                      { location: location() },
                    )
                  : chain.length === 1
                    ? await fusion.config(
                        // Single entry left = plain single-provider mode
                        { update: { providerID: chain[0], models: [] } },
                        { location: location() },
                      )
                    : await fusion.config(
                        // Empty stack = clear the chain (single provider stays)
                        { update: { providerChain: [], models: [] } },
                        { location: location() },
                      )
              const c = result.config
              context.ui.toast.show({
                message:
                  (c.providerChain ?? []).length > 1
                    ? tr(
                        `provider chain: ${(c.providerChain ?? []).join(" -> ")}(先頭を優先、尽きたら次へ)`,
                        `provider chain: ${(c.providerChain ?? []).join(" -> ")} (prefer the first, fall through on exhaustion)`,
                      )
                    : tr(
                        `provider: ${c.providerID}(単一プロバイダー)`,
                        `provider: ${c.providerID} (single provider)`,
                      ),
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(c, lang() === "en"))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-provider: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.probe",
          title: tr("adaptive-fusion: 候補モデルに一斉テストプロンプトを送信", "adaptive-fusion: probe all candidate models"),
          slash: { name: "fusion-probe" },
          run: async () => {
            const ok = await context.ui.dialog.confirm({
              title: "adaptive-fusion probe",
              message:
                tr(
                  "候補モデルに一斉にテストプロンプトを送信します。\n成否・レイテンシを学習統計に記録し、失敗モデルはクールダウンします。\n最大16モデル・並列4・1件20秒程度かかる場合があります。実行しますか?",
                  "Send a test prompt to all candidate models.\nSuccess and latency are recorded in the learning statistics, and failing models are cooled down.\nUp to 16 models, 4 in parallel, about 20 s each. Run it now?",
                ),
              label: { confirm: "Run", cancel: "Cancel" },
            })
            if (!ok) return
            try {
              context.ui.toast.show({
                message: tr("probe: 実行中…", "probe: running…"),
                variant: "info",
              })
              const result = await fusion.probe({}, { location: location() })
              showLongText("adaptive-fusion probe", result.text)
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-probe: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.reset",
          title: tr("adaptive-fusion: 学習統計・クールダウンをリセット", "adaptive-fusion: reset learning statistics and cooldowns"),
          slash: { name: "fusion-reset" },
          run: async () => {
            const ok = await context.ui.dialog.confirm({
              title: "adaptive-fusion",
              message: tr("学習統計とクールダウン(利用不可フラグ)をリセットしますか?", "Reset learning statistics and cooldowns (unusable flags)?"),
              label: { confirm: "Reset", cancel: "Cancel" },
            })
            if (!ok) return
            try {
              await fusion.reset({}, { location: location() })
              context.ui.toast.show({
                message: "stats reset",
                variant: "success",
              })
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-reset: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
      ],
    }))
  },
})
