// OpenCode Adaptive Fusion - Server part
//
// 企画書 Phase1 + Phase2(タスク分類)に相当するプロトタイプ。
//  - prompt フックでタスク分類(ctx.experimental.generate.text を使用)し、セッション単位で保持する
//  - experimental.model.resolve フックで、タスク種別 x モデルの学習スコアに基づきモデルを差し替える
//  - http.request / http.response フックでレイテンシと成否を収集し、ctx.storage に永続化する
//  - RPC で TUI 部(tui.tsx)に統計表示/設定変更/リセットを提供する
//
// 設定は fusion/config に永続化され、TUI(/fusion-config / /fusion-whitelist)から変更できる。
// 優先順位: 保存済み設定 > opencode.json の options。
//
// 統計は2層(キーには実プロバイダーを含む):
//  - fusion/stat/<provider>/<model>            : 全体統計(フォールバック用)
//  - fusion/task/<category>/<provider>/<model> : タスク種別統計(優先)
//
// crossProvider 時は候補を全プロバイダーに拡大し、ホワイトリストは
// `provider/model-id` の完全参照形式で持つ。
//
// 失敗検知と安全なフォールバック:
//  - resolve レベルの「モデル利用不可」(Model unavailable) は session.step.failed /
//    session.retry.scheduled イベントから検知し、該当モデルをクールダウンして対象から外す
//  - 無料枠(quota)は品質ペナルティから除外し、長期クールダウン(6h)のみ課す
//  - quota 失敗時はプロバイダー単位で冷却する(無料枠はアカウント単位)
//  - 成功した HTTP 観測が来たらクールダウンを解除する(復帰検知)
//  - rescue モード: ルーティング OFF でも、現モデルがクールダウン中なら健康なモデルへ自動退避

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
const TASK_TOPOLOGY_PREFIX = "fusion/topology/task/"
const JEV_KEY_KEY = "fusion/jev-key"
const REVIEW_PREFIX = "fusion/review/"
const CONFIG_KEY = "fusion/config"
const COOLDOWN_KEY = "fusion/cooldowns"
const RESCUE_KEY = "fusion/rescue-attempts"
// ベンチマークシード(既定: リポジトリルートの data/benchmarks.json)
const BENCHMARKS_DEFAULT_RELATIVE = ["data", "benchmarks.json"]

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
  // 生の合計(1..5)と件数を保存し、評価分布を平均値化できるようにする
  ratingSum: number
  count: number
  updatedAt: string
  category?: string
}

type AutoReviewStat = {
  model: { providerID: string; id: string }
  // 審査を実行したモデル(自己採点の偏り検出用)
  reviewerRef?: string
  total: number
  lastAt: number
  instruction: number
  accuracy: number
  completeness: number
  // v0.9.0: コストパフォーマンス軸(1..5 の合計と収集件数)。
  // 旧データ(efficiency 収集前)は 0/0 = 未収集扱い。
  efficiency: number
  efficiencyCount: number
  // v0.9.0: 「応答が成し遂げた実績」の列挙(直近の審査分を保持)。
  // 旧データは空配列。
  results: string[]
  reasons: string[]
  updatedAt: string
  category?: string
}

// TUI/RPC へ渡す表示用スナップショット(ローリング平均)
type AutoReviewSnapshot = {
  average: number
  instruction: number
  accuracy: number
  completeness: number
  // v0.9.0: コストパフォーマンス軸の平均(未収集はキーごと省略)
  efficiency?: number
  // v0.9.0: 直近の実績列挙(未収集はキーごと省略)
  results?: string[]
  reason: string
  reviewerRef: string
  total: number
}

// トポロジー(オーケストレーション形態)の観測統計(v0.7a)。
// 「判定した形態」と「実際にその形態で動いた結果」を蓄積し、後続版の
// 選定スコア合成(w2 記録コスパ / w3 自動観測)の土台にする。
type TopologyStat = {
  topology: string
  category?: string
  count: number
  ok: number
  totalMs: number
  // 内部審査(autoReview)のスコア合計(5点満点×回数)。応答1件=最大5
  sumQuality: number
  qualityCount: number
  // 人間による「この形態のコスパは?」1〜5の合計(/fusion-review 第2行、D-3)
  sumCostPerformance: number
  costPerformanceCount: number
  // Jev Choice の確率分布の合計(D-4 の w1 事前)。判定1回=確率1を各形態に分配
  sumJevPrior: number
  jevPriorCount: number
  // 補助呼び出し(v0.7a 完全版): chain の planner など、主応答以外の呼出数と所要時間
  auxCalls: number
  auxMs: number
  // 最後に実行された時刻(ms)
  lastUsedAt: number
  updatedAt: string
}

// Jev へ渡すトポロジー選択肢の定義(v0.7a: single / router / sequential-chain のみ)。
// criteria は「どんな依頼が来たらこの形態を選ぶべきか」の対比定義。
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

// ベンチマーク事前(v0.6): 下馬評スコア(0〜1)をモデル×カテゴリで保持する。
// 観測成功率を Beta(benchmark * k, (1 - benchmark) * k) 事前で平滑化する。
// 既定の空値(= ファイル不在 / k=0)では現行の Laplace 平滑化と同じ結果になる。
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
  exploreRate: number
  learningRate: number
  minObservations: number
  costWeight: number
  latencyWeight: number
  classifierModel: string | null
  kinds: string[]
  models: string[]
  // 単一プロバイダー時はモデルID、crossProvider 時は
  // `provider/model-id` 完全参照形式。空なら全候補。
  maxInputCost: number // USD/1M tokens。ホワイトリストが空の場合のみ適用
  maxOutputCost: number // USD/1M tokens。0なら無料モデルのみ
  // ベンチマーク事前の強さ(ベイズ事前の k)。0 で機能OFF = 現行の平滑化
  benchmarkPriorWeight: number
  // ベンチマークシードのパス。既定はプラグインからの相対パス
  benchmarksFile: string
  // 内部審査(shadow)の担当モデル。未指定なら classifierModel と同じフォールバック経路
  reviewModel: string | null
  // Jev(TypeSafe)統合。auto = APIキー検出で有効化 / off = 常に従来経路
  jevMode: "auto" | "off"
  // トポロジー判定。auto = Jev/実績で選択 / fixed = 常に single(従来動作)
  topologyMode: "auto" | "fixed"
  // 1応答あたりの補助呼び出し上限(コストガード)。chain は3以上必要
  maxTopologyCalls: number
  // 実行を許可するトポロジーのホワイトリスト(段階リリースと連動)
  allowedTopologies: string[]
  // トポロジー選定スコアの重み(v0.7a/D-4)。
  //   score = w1 × Jev事前確率 + w2 × 人間コスパ評価 + w3 × 自動観測(品質/ok率)
  // Jev キー無し時は w1 を自動で 0 扱い、w2/w3 のみで選択する。
  topologyWeightJev: number
  topologyWeightHumanCP: number
  topologyWeightAuto: number
  // sequential-chain の補助実行(v0.7a 完全版)。
  // off = 判定と記録のみ(現行動作)/ active = chain 選択時に planner を実行し、
  // 計画を主モデルの system へ「参考」として注入(context フック、履歴は汚さない)
  chainMode: "off" | "active"
  // ティアルーティング(v0.8、Copilot Fusion / HydraFusion 方式の負荷別選択)。
  // off = 従来動作 / manual = ユーザー定義ティア / auto = ベンチマークから3分割導出
  tierMode: "off" | "manual" | "auto"
  // ティアごとのモデルグループ(ホワイトリストの強化版)。
  // 各層に複数の provider/model を設定でき、層内では既存の statScore+探索が働く。
  tiers: { heavy: string[]; middle: string[]; light: string[] }
  // 表示言語(v0.9.0)。インストールごとに options.lang で選択でき、
  // /fusion-lang でも切り替えられる。既定は ja。
  lang: "ja" | "en"
}

// 負荷帯(タスク負荷・知能負荷の3段階)。diffculty score 0-100 を
// TIER_THRESHOLD_* で3分割する。
type TierName = "heavy" | "middle" | "light"
const TIER_NAMES: TierName[] = ["heavy", "middle", "light"]
const TIER_THRESHOLD_MIDDLE = 34
const TIER_THRESHOLD_HEAVY = 67

// 内部審査(autoReview)のスキップ記録(A-2)。
// 「審査できなかった」ことを reviewerRef 付きで永続化し、
// shadow 集計の盲点(審査漏れ)を可視化する。
type AutoSkipStat = {
  total: number
  recent: { at: string; reason: string; reviewerRef: string }[]
  updatedAt: string
}

const DEFAULT_CATEGORIES = [
  "coding", // 実装・コード編集
  "debugging", // エラー・バグ修正
  "review", // レビュー・検証
  "research", // 調査・質問・説明
  "writing", // ドキュメント・文章
  "ops", // シェル・環境構築・実行
]

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const num = (value: unknown, fallback: number) =>
  typeof value === "number" ? value : fallback

// ティア設定(v0.8)のバリデーション。provider/model 形式の文字列だけを受け入れ、
// 不正な値・不足層は空配列に正規化する(opencode.json options / RPC update 共通)。
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
    // 設定(優先順位: 保存済み fusion/config > opencode.json の options)
    // ------------------------------------------------------------------
    const cfg: FusionConfig = {
      enabled: ctx.options.enabled === true,
      providerID:
        typeof ctx.options.providerID === "string"
          ? ctx.options.providerID
          : "opencode",
      crossProvider: ctx.options.crossProvider === true,
      exploreRate: clamp(num(ctx.options.exploreRate, 0.05), 0, 1),
      learningRate: clamp(num(ctx.options.learningRate, 0.3), 0, 1),
      minObservations: Math.max(
        1,
        Math.floor(num(ctx.options.minObservations, 5)),
      ),
      costWeight: num(ctx.options.costWeight, 0.1),
      latencyWeight: num(ctx.options.latencyWeight, 0.05),
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
      classifierModel:
        typeof ctx.options.classifierModel === "string" &&
        ctx.options.classifierModel.includes("/")
          ? ctx.options.classifierModel
          : null,
      kinds:
        Array.isArray(ctx.options.kinds) && ctx.options.kinds.length > 0
          ? ctx.options.kinds
          : ["primary"],
      models: [],
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
      // 表示言語。opencode.json の options.lang でインストール単位に選択できる
      // (保存済み設定 > options の優先順位は他項目と同じ)。
      lang: ctx.options.lang === "en" ? "en" : "ja",
    }

    // 表示言語ヘルパー(v0.9.0)。第1引数が日本語、第2引数が英語。
    // 設定は TUI/RPC からも変更でき、即座に反映される。
    const tr = (ja: string, en: string): string =>
      cfg.lang === "en" ? en : ja

    // 保存済み設定の適用(検証済みの値のみ)。
    // setup 時の復元と、prompt フックでの再同期(TUI 側インスタンスが
    // 永続化した変更をサーバー側へ反映する。v0.8.1)の両方から使う。
    // 注意: kinds は setup 後に参照キャプチャされるため、差し替えではなく
    // 同一配列への破壊的更新で反映する。
    const applyPersistedConfig = (saved: unknown): boolean => {
      if (!saved || typeof saved !== "object") return false
      const s = saved as Record<string, unknown>
      const before = JSON.stringify(cfg)
      if (typeof s.enabled === "boolean") cfg.enabled = s.enabled
      if (typeof s.providerID === "string") cfg.providerID = s.providerID
      if (typeof s.crossProvider === "boolean") cfg.crossProvider = s.crossProvider
      if (typeof s.exploreRate === "number")
        cfg.exploreRate = clamp(s.exploreRate, 0, 1)
      if (typeof s.learningRate === "number")
        cfg.learningRate = clamp(s.learningRate, 0, 1)
      if (typeof s.minObservations === "number")
        cfg.minObservations = Math.max(1, Math.floor(s.minObservations))
      if (typeof s.costWeight === "number") cfg.costWeight = s.costWeight
      if (typeof s.latencyWeight === "number")
        cfg.latencyWeight = s.latencyWeight
      if (typeof s.maxInputCost === "number")
        cfg.maxInputCost = Math.max(0, s.maxInputCost)
      if (typeof s.maxOutputCost === "number")
        cfg.maxOutputCost = Math.max(0, s.maxOutputCost)
      if (typeof s.benchmarkPriorWeight === "number")
        cfg.benchmarkPriorWeight = Math.max(0, s.benchmarkPriorWeight)
      if (typeof s.benchmarksFile === "string")
        cfg.benchmarksFile = s.benchmarksFile
      if (typeof s.classifierModel === "string")
        cfg.classifierModel = s.classifierModel.includes("/")
          ? s.classifierModel
          : null
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
      if (s.lang === "ja" || s.lang === "en") cfg.lang = s.lang
      if (Array.isArray(s.kinds) && s.kinds.every((k) => typeof k === "string")) {
        cfg.kinds.length = 0
        cfg.kinds.push(...(s.kinds as string[]))
      }
      if (Array.isArray(s.models) && s.models.every((m) => typeof m === "string"))
        cfg.models = s.models as string[]
      return JSON.stringify(cfg) !== before
    }

    applyPersistedConfig(await ctx.storage.get(CONFIG_KEY))

    // ------------------------------------------------------------------
    // Jev(TypeSafe System One)キーの管理
    // ------------------------------------------------------------------
    // キーは storage["fusion/jev-key"] か TYPESAFE_API_KEY 環境変数から読む。
    // 優先順位: storage(ダイアログ登録) > 環境変数。
    // 空文字は「未登録」を意味する(storage に delete が無いため空文字で無効化)。
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
    // キーの有無 + jevMode=auto の両方を満たすときだけ Jev を使う(縮退運転)
    const jevAvailable = (): boolean =>
      cfg.jevMode !== "off" && Boolean(jevEffectiveKey())
    const jevClient = (): JevClient | undefined => {
      const key = jevEffectiveKey()
      return cfg.jevMode !== "off" && key ? new JevClient(key) : undefined
    }

    // ルーティング対象のリクエスト種別。既定はエージェントループのみ。
    const kinds = cfg.kinds

    // タスク分類カテゴリ(opencode.json の options のみ。動的変更は不可)
    const categories: string[] =
      Array.isArray(ctx.options.categories) &&
      ctx.options.categories.every((c) => typeof c === "string") &&
      ctx.options.categories.length > 0
        ? (ctx.options.categories as string[])
        : [...DEFAULT_CATEGORIES]

    // キーには実プロバイダーを含む(既存の opencode 統計と同一形式を維持)
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
    // 内部審査のスキップ記録(A-2)。審査できなかった事実を reviewerRef 付きで残す。
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
        // スキップ記録の失敗は通常処理を妨げない
      }
    }
    // ------------------------------------------------------------------
    // 失敗検知(cooldown)→ 安全なフォールバック
    // ------------------------------------------------------------------
    // resolve レベルの「モデル利用不可」(Model unavailable)は HTTP に到達せず
    // 統計に現れない。session.step.failed / session.retry.scheduled イベントの
    // エラーメッセージから該当モデルを検知し、一定時間ルーティング対象から
    // 外す(指数バックオフ)。成功した HTTP 観測が来たら解除する。
    // 無料枠(opencode / openrouter 共にアカウント単位)は、1モデルがクオータ
    // 制限に触れた時点で該当プロバイダーの無料モデル全滅とみなし、
    // プロバイダー単位のタイマー付き利用不可フラグで冷却する。
    const cooldowns = new Map<
      string,
      {
        until: number
        failures: number
        quota: boolean
        // 検証未了フラグ(v0.8.1)。タイマー満了だけでは「回復」と扱わない。
        // 実機への最小プローブが成功した時点で冷却を解除する。
        // (タイマーは推測でしかなく、実際の利用制限は別の窓で解けるため。
        //  未検証のまま戻ると Model unavailable で強制停止を繰り返す)
        needsVerify: boolean
        lastVerifyAt?: number
      }
    >()
    // プロバイダー単位の利用不可フラグ(タイマー付き)。
    // OpenCode / OpenRouter の無料枠はアカウント単位のため、クオータ制限に
    // 触れた時点で該当プロバイダーの無料モデルは全滅する。モデル単位では
    // なくプロバイダーごと冷却する。
    const providerCooldowns = new Map<
      string,
      { until: number; quota: boolean }
    >()
    const COOLDOWN_BASE_MS = 10 * 60_000 // resolve失敗: 10分から指数バックオフ
    const COOLDOWN_MAX_MS = 6 * 60 * 60_000
    // 無料枠・クオータ: 1時間ごと。タイマー満了後は実機プローブで検証し、
    // 通ればプールへ復帰、通らなければさらに1時間延長(検証付き復帰)。
    // 長い固定タイマーだと「タイマーは切れたが制限は未解除」で
    // Model unavailable の強制停止を繰り返したため、短周期+検証方式へ変更。
    const QUOTA_COOLDOWN_MS = 60 * 60_000

    // --- Rescue復帰 ---
    // セッションが rescue で他モデルへ退避した場合、元モデルの冷却が
    // 解除されたときに次のプロンプトで自動復帰させるための記録。
    const rescueAttempts = new Map<string, { originalRef: string; deadline: number }>()
    const RESCUE_WINDOW_MS = 24 * 60 * 60_000 // 24時間だけ有効

    // プロンプト直前のフックで rescue 復帰を判定する。
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
      // entry.originalRef は provider/model の完全参照。model側に
      // スラッシュが含まれうるため、最初のスラッシュで分割する
      const slash = entry.originalRef.indexOf("/")
      const origProv = entry.originalRef.slice(0, slash)
      const origMod = entry.originalRef.slice(slash + 1)
      const modelRef = entry.originalRef
      // 復帰判定は cool() に一本化する(v0.8.1)。cool() はタイマーに加えて
      // 検証未了(needsVerify)とプロバイダー単位の冷却も見るため、
      // 「タイマーは切れたが利用制限は未解除」のモデルへ戻る事例を防ぐ。
      if (!cool(modelRef)) {
        logRoute(`RESCUE restore ${sessionID} -> ${entry.originalRef} (recovered)`)
        return { providerID: origProv, id: origMod, ref: entry.originalRef }
      }
      return null
    }

    // ------------------------------------------------------------------
    // ルーティング決定のログ(直近20件。stats に表示。デバッグ用)
    // ------------------------------------------------------------------
    const routeLog: string[] = []
    const logRoute = (line: string) => {
      routeLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
      // v0.8.1: 20件では失敗連鎖の調査中に証拠が蒸発した(実測)ため拡大。
      if (routeLog.length > 200) routeLog.splice(0, routeLog.length - 200)
    }

    // クールダウン(利用不可フラグ)の永続化:
    // プラグインのホットリロードでメモリが消えても、死亡済みモデルに
    // 再び当たらないよう fusion/cooldowns に保存し、setup 後半で復元する。
    //
    // v0.8.1 追加(実機検証済みの問題): サーバープロセスは同一プラグインを
    // 2インスタンスでロードすることがあり(role=server の二重ロードをログで
    // 実証)、フックを持たない側が「復元時点の古いマップ」を persist すると
    // kv が丸ごと上書きされ、フック側が記録した冷却が消える
    // (gemini 冷却消失事故の再現実験で実証)。
    // そのため persist は「kv をベースにメモリをマージ」方式にする。
    // 削除は tombstone で貫通させる(成功時の clearCooldown が復活しないように)。
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
      // ベース: 直近の kv(他インスタンスが記録した冷却を消さない)
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
        // 読めなければメモリのみで書く(従来動作)
      }
      // メモリ側の有効エントリで上書きマージ
      for (const [ref, c] of cooldowns)
        if (c.until > now || c.needsVerify === true) models[ref] = c
      for (const [id, p] of providerCooldowns)
        if (p.until > now) providers[id] = p
      // tombstone: メモリで明示削除されたキーは kv に残っていても落とす
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
            // タイマー満了しても検証未了(needsVerify)の冷却は復元する。
            // 落とすと未回復のモデルが健全扱いになり強制停止の種になる。
            (v.until > Date.now() || v.needsVerify === true)
          )
            target.set(key, value)
        }
      }
      restore(s.models, cooldowns)
      restore(s.providers, providerCooldowns)
    }

    // rescue復帰の保留エントリーも永続化する。
    // プラグインのホットリロードでメモリが消えても復帰判定が失われないようにする。
    // v0.8.1: クールダウンと同様にマージ方式(他インスタンスの stale 上書き対策)。
    // 削除は「メモリに無く deadline も過ぎた」場合だけ落とすのではなく、
    // 明示削除を tombstones マップで貫通させる。
    const rescueTombstones = new Map<string, number>()
    const persistRescue = async () => {
      const now = Date.now()
      let attempts: Record<string, unknown> = {}
      try {
        const saved = await ctx.storage.get(RESCUE_KEY)
        if (saved && typeof saved === "object")
          attempts = { ...(saved as Record<string, unknown>) }
      } catch {
        // 読めなければメモリのみで書く
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

    // 失敗の種別: quota(無料枠・レート制限)は品質ペナルティから除外する
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
        // タイマー満了でも検証未了なら「未回復」扱い(v0.8.1)。
        // タイマーは目安でしかなく、実際の利用制限は別の窓で解けるため、
        // 未検証のモデルに戻ると Model unavailable で強制停止を繰り返した。
        // 実機プローブの成功(VERIFY ok)だけが冷却解除の条件。
        if (c.needsVerify) {
          scheduleVerification(ref)
          return true
        }
      }
      // モデル単位のクールダウンが切れていても、プロバイダー単位の
      // クオータ冷却(無料枠はアカウント単位で全滅)中なら利用不可。
      // ただしプロバイダー冷却は「無料モデル」だけに適用する(v0.8.1)。
      // クオータ制限は無料枠の話で、同プロバイダーの有料モデルは別枠。
      // 有料モデルまで巻き込むと退避先が皆無になり、
      // Model unavailable の強制停止の種になった。
      if (providerCool(ref.slice(0, ref.indexOf("/")))) return isFreeRef(ref)
      return false
    }
    // 無料モデルの判定(idの命名規則による簡易判定)。
    // openrouter は ":free" 接尾辞、opencode は "-free" 接尾辞。
    const isFreeRef = (ref: string) =>
      ref.endsWith(":free") || ref.endsWith("-free")
    // プロバイダー単位の冷却判定。OpenCode / OpenRouter の無料枠は
    // アカウント単位のため、1モデルがクオータ制限に触れた時点で
    // そのプロバイダーの無料モデル全滅とみなす。
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
      // クオータ制限はプロバイダー単位で冷却(無料枠全滅前提に)
      if (cls === "quota") markProviderCool(ref.slice(0, ref.indexOf("/")), true)
      void persistCooldowns()
      if (ctx.options.debug === true)
        console.log(
          `[adaptive-fusion] cooldown ${ref} (${cls}, ${Math.round(ms / 1000)}s)`,
        )
    }
    const clearCooldown = (ref: string): boolean => {
      const existed = cooldowns.delete(ref)
      // プロバイダー単位の冷却を解除するのは「無料モデル」の成功だけ(v0.8.1)。
      // 有料モデルの成功は無料枠の制限解除を意味しない。
      // (無料モデルはプロバイダー冷却とモデル冷却の両方に守られるため、
      //  有料成功でプロバイダー冷却が消えると未検証の無料モデルが
      //  候補に復帰し、Model unavailable の種になり得た)
      let providerExisted = false
      if (isFreeRef(ref)) {
        const pid = ref.slice(0, ref.indexOf("/"))
        providerExisted = providerCooldowns.delete(pid)
        if (providerExisted) tomb(`p:${pid}`)
      }
      // 削除が発生したキーは tombstone に入れる。マージ方式の persist でも
      // kv に残る古いエントリや他インスタンスの再書き込みに負けないように。
      if (existed) tomb(`m:${ref}`)
      void persistCooldowns()
      // 解除が発生したかを返す(観測ログ用)
      return existed || providerExisted
    }

    // ------------------------------------------------------------------
    // 冷却の検証付き解除(v0.8.1)
    // ------------------------------------------------------------------
    // タイマー満了 = 回復 ではない(利用制限は別の窓で解ける)ため、
    // needsVerify の付いた冷却はタイマー満了後も「未回復」扱いにし、
    // 実機への最小プローブが通った場合にだけ冷却を解除する。
    // 検証は1時間周期(QUOTA_COOLDOWN_MS ごと)で行い、失敗したら
    // さらに1時間延長して健康モデルへフォールバックし続ける。
    const VERIFY_RETRY_MS = 10 * 60_000 // 再検証の最低間隔(連発防止)
    const VERIFY_TIMEOUT_MS = 10_000
    const verifyingNow = new Set<string>()

    const scheduleVerification = (ref: string) => {
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
          if (text.length > 0) {
            // 検証成功: 実際に制限が解けた証拠なので冷却を解除する
            clearCooldown(ref)
            logRoute(`VERIFY ok ${ref} (cooldown cleared)`)
          } else {
            entry.until = Date.now() + QUOTA_COOLDOWN_MS
            logRoute(`VERIFY empty ${ref} (cooldown +1h)`)
          }
        } catch (error) {
          // まだ利用不可: 1時間延長し、検証状態は維持する
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
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.step.failed", "session.retry.scheduled"],
          signal: abortEventWatch.signal,
        }) as AsyncIterable<{ type: string; data?: any }>) {
          const message: string = event.data?.error?.message ?? ""
          const match = /^Model unavailable:\s*(\S+)/.exec(message)
          // メッセージ形式に関係なく失敗モデルを特定する(v0.8.1)。
          // "Model unavailable: <ref>" 以外の形のモデルエラーでも
          // 冷却+退避が働くようにする(実観測では session.step.failed 自体が
          // 発火しない環境があるため、発火する環境での予防も兼ねる)。
          let ref: string | undefined = match?.[1]
          if (!ref) {
            const sid = event.data?.sessionID
            if (typeof sid !== "string") continue
            // 誤 attribution 対策(v0.8.1): session.model は rescue の
            // switchModel で既に健康モデルへ書き替わっている可能性があり、
            // それを犯人にすると健康モデルが誤って冷却される。
            // 直近の HTTP 観測(実際に dispatch されたモデル)を優先し、
            // HTTP が飛んでいない失敗(課金 precheck 等)では
            // resolve が記録した実 dispatch モデル(lastResolved)を、
            // それも無ければ session.model を使う。
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
          markFailure(ref, cls)
          // クオータ系は品質ペナルティにしない(統計の成功率を歪めない)
          if (cls === "error") {
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
          // 失敗直後にセッションのモデルを切り替え、次の再開で
          // 同じ利用不可モデルを選ばないようにする。
          if (typeof event.data?.sessionID === "string") {
            const targetRef = ref
            const currentCategory = sessionCategory.get(event.data.sessionID)
            const choice = await pick(
              targetRef,
              currentCategory,
              true,
              event.data.sessionID,
            )
            if (choice) {
              try {
                await ctx.session.switchModel({
                  sessionID: event.data.sessionID,
                  model: { providerID: choice.providerID, id: choice.id },
                })
                // 失敗した元モデルを復帰候補として記録する
                if (targetRef !== refFor(choice.providerID, choice.id)) {
                  rescueAttempts.set(event.data.sessionID, {
                    originalRef: targetRef,
                    deadline: Date.now() + RESCUE_WINDOW_MS,
                  })
                  void persistRescue()
                }
                logRoute(
                  `SWITCH after-fail ${targetRef} -> ${choice.providerID}/${choice.id} (${choice.reason})`,
                )
              } catch (error) {
                logRoute(
                  `after-fail rescue failed ${event.data.sessionID}: ${String(error).slice(0, 80)}`,
                )
                console.log(`[adaptive-fusion] after-fail rescue failed: ${error}`)
              }
            }
          }
        }
      } catch {
        // イベント購読の失敗は無視(再読み込み時に発生しうる)
      }
    })()

    // ------------------------------------------------------------------
    // ベンチマーク事前(v0.6)の読み込み
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
    // 下馬評ファイルが90日より古い場合、k を半分にする(陳腐化対策)
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
    // 候補モデル(返却形を正規化して取得)
    // ------------------------------------------------------------------
    // 単一プロバイダー時は cfg.providerID 配下のモデルのみ。
    // crossProvider 時は: 全プロバイダー(ホワイトリストは完全参照形式)。
    // expand(緊急時)は: 全プロバイダー・ホワイトリスト無視。
    //   無料枠はアカウント単位のため、現プロバイダーがクオータ冷却中なら
    //   そのプロバイダーのモデルは全滅している。rescue は別プロバイダーの
    //   「観測のある健康なモデル」へ退避する必要があるため。
    const candidates = async (expand = false) => {
      const raw: any = await ctx.model.list()
      const models: any[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.data)
          ? raw.data
          : Array.isArray(raw?.models)
            ? raw.models
            : []
      const whitelist = new Set(cfg.models)
      const costLimitsApply = whitelist.size === 0
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
      return models.filter(
        (m) =>
          m.enabled !== false &&
          Array.isArray(m.cost) &&
          m.cost.length > 0 &&
          (!costLimitsApply || costOK(m)) &&
          (expand
            ? // 緊急拡大(v0.8.1): ホワイトリスト外にも出るが、有料モデルへの
              // シームレスな退避をユーザーの予算内に留めるため costOK を適用。
              // 無料モデルは上限と無関係なのでそのまま通す
              whitelist.size === 0 ||
              whitelist.has(refFor(m.providerID, m.id)) ||
              costOK(m)
            : cfg.crossProvider
              ? whitelist.size === 0 ||
                whitelist.has(refFor(m.providerID, m.id))
              : m.providerID === cfg.providerID &&
                (whitelist.size === 0 || whitelist.has(m.id))),
      )
    }
    // ------------------------------------------------------------------
    // タスク分類(Task Classifier)
    // ------------------------------------------------------------------
    // prompt フック(受付時)に軽量モデルで分類し、セッション単位で保持する。
    const sessionCategory = new Map<string, string>()
    // セッション単位で「採用したトポロジー」を保持する(http.response での記録用)
    const sessionTopology = new Map<string, string>()
    // セッション単位の負荷帯(v0.8 ティアルーティング)。admission の classify で
    // 推定し、experimental.model.resolve のティア選択で使う。turn 単位で更新。
    const sessionLoad = new Map<string, TierName>()

    // 負荷帯のヒューリスティック(Jev/LLM が使えないときの最終縮退)。
    // カテゴリ既定 + 文字数 + multi-step キーワードで 0-100 を概算する。
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

    const saveReviewAssignment = async (sessionID: string, category: string) => {
      try {
        await ctx.storage.set(`${REVIEW_PREFIX}${sessionID}`, {
          category,
          assignedAt: new Date().toISOString(),
        })
      } catch {
        // レビュー用メタデータの保存失敗は通常処理を妨げない
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
    // トポロジー観測(v0.7a)
    // ------------------------------------------------------------------
    // Jev か実績/ヒューリスティックで「判定した形態」を http.response の
    // 結果(ok/ms)と紐づけ、fusion/topology/* に蓄積する。
    // 失敗(quota 以外)も記録する。quota はモデル品質を測らないため除外。
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
        // トポロジー観測の失敗は通常処理を妨げない
      }
    }
    // 内部審査(autoReview)のスコアをトポロジー統計へ加算する(v0.7a)。
    // http.response の直後に runAutoReview が完了したタイミングで呼ばれる。
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
        // トポロジー品質の加算失敗は通常処理を妨げない
      }
    }
    // 人間による「トポロジーのコストパフォーマンス」評価(1〜5)を加算する。
    const recordTopologyCostPerformance = async (
      sessionID: string,
      rating: number,
    ) => {
      try {
        const topology = sessionTopology.get(sessionID) ?? "single"
        const category = sessionCategory.get(sessionID)
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
        // トポロジーコスパの加算失敗は通常処理を妨げない
      }
    }
    // Jev Choice の確率分布をトポロジー事前として記録する(D-4 の w1)。
    // 判定1回あたり確率1を各形態に分配し、平均事前確率を選定スコアに使う。
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
        // 事前記録の失敗は通常処理を妨げない
      }
    }
    // 補助呼び出し(planner など)の所要時間をトポロジー統計へ加算する。
    // 主応答の totalMs と区別するため auxCalls/auxMs に分けて記録する。
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
        // 補助呼び出し計測の失敗は通常処理を妨げない
      }
    }
    // トポロジー選定スコア(D-4 加重合成)。
    //   score = w1 × Jev事前確率 + w2 × 人間コスパ + w3 × 自動観測
    // 各信号が無い軸は中立 0.5。Jev キー無し時は w1=0 扱いで正規化する。
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
      // 自動観測: 内部審査の品質平均を主に、無ければ ok 率で代用
      const auto =
        stat.qualityCount > 0
          ? stat.sumQuality / stat.qualityCount / 5
          : stat.count > 0
            ? stat.ok / stat.count
            : 0.5
      return (wJev * prior + wCP * cp + wAuto * auto) / total
    }
    // カテゴリ別トポロジー実績の要約(Jev の state に渡す)。
    // 例: "coding: single 12件 (ok 83%, quality 4.1), router 5件 (ok 60%, quality 3.2)"
    const topologyStatsSummary = async (
      category: string | undefined,
    ): Promise<string> => {
      if (!category) return "(no prior stats)"
      const parts: string[] = []
      for (const topology of cfg.allowedTopologies) {
        const key = `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`
        const stat = await loadTopologyStat(key)
        if (!stat || stat.count <= 0) continue
        const okPct = Math.round((stat.ok / stat.count) * 100)
        const quality =
          stat.qualityCount > 0
            ? (stat.sumQuality / stat.qualityCount).toFixed(1)
            : "n/a"
        parts.push(
          `${topology}: ${stat.count}件 (ok ${okPct}%, quality ${quality})`,
        )
      }
      return parts.length > 0 ? parts.join(", ") : "(no prior stats for this category)"
    }

    // 実績ベースのヒューリスティック(Jev 不可時)。
    // カテゴリ別トポロジー実績が3件以上あるものから最高評価を選ぶ。
    // 実績なし/評価不能 → single(従来動作)。
    // "評価"は内部審査スコア平均。quality が1件も無い場合は ok 率で代用する。
    const heuristicTopology = async (
      category: string | undefined,
      useJevPrior = false,
    ): Promise<string> => {
      if (cfg.topologyMode === "fixed") return "single"
      if (!category) return "single"
      let best: { topology: string; score: number } | undefined
      let anyQualified = false
      for (const topology of cfg.allowedTopologies) {
        const key = `${TASK_TOPOLOGY_PREFIX}${category}/${topology}`
        const stat = await loadTopologyStat(key)
        if (!stat || stat.count < 3) continue
        anyQualified = true
        // D-4 加重合成: w1 × Jev事前 + w2 × 人間コスパ + w3 × 自動観測
        const score = topologyScore(stat, useJevPrior)
        if (!best || score > best.score) {
          best = { topology, score }
        }
      }
      if (!anyQualified || !best) return "single"
      // sequential-chain は planner 1呼出が前提(verifier は autoReview と共有)
      if (best.topology === "sequential-chain" && cfg.maxTopologyCalls < 2)
        return "single"
      return best.topology
    }
    // Jev の Choice 回答から採用するトポロジーを決める。
    // confidence < 0.7 なら最も保守的な single へ縮退(README §4 の方針)。
    const resolveTopology = (choice: string | undefined): string => {
      if (cfg.topologyMode === "fixed") return "single"
      if (!choice) return "single"
      if (!cfg.allowedTopologies.includes(choice)) return "single"
      // sequential-chain は planner 1呼出が前提(verifier は autoReview と共有)。
      // コストガードで足りない場合は縮退
      if (choice === "sequential-chain" && cfg.maxTopologyCalls < 2)
        return "single"
      return choice
    }
    // トポロジー判定(pickTopology)。カテゴリ確定後に呼ばれる。
    //   Jev 利用可: Choice(allowedTopologies のみ)。
    //     state = { instruction, category, categoryTopologyStats(過去実績の要約) }
    //     confidence < 0.7 → single へ縮退
    //   Jev 不可: ヒューリスティック(カテゴリ実績 ≥3件 → 最高評価 / それ以外 single)
    const pickTopology = async (
      text: string,
      category: string | undefined,
    ): Promise<string> => {
      if (cfg.topologyMode === "fixed") return "single"
      const allowed = cfg.allowedTopologies.filter((t) => t in TOPOLOGY_CATALOG)
      if (allowed.length <= 1) return resolveTopology(allowed[0])
      const jev = jevClient()
      if (!jev) return heuristicTopology(category, false)
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
              "Choose the orchestration topology for this task. Prefer the simplest topology that suffices. Use the category and past performance stats to decide.",
            criteria: Object.fromEntries(
              allowed.map((t) => [t, TOPOLOGY_CATALOG[t]]),
            ),
          },
        },
      )
      const answer = answers?.topology
      if (answer?.type === "choice") {
        // 確率分布をトポロジー事前として記録(D-4 の w1 合成に使う)
        await recordTopologyPrior(category, answer.probabilities)
        if (answer.confidence >= 0.7) {
          logRoute(
            `TOPOLOGY jev ${answer.choice} (conf ${answer.confidence.toFixed(2)})`,
          )
          return resolveTopology(answer.choice)
        }
        logRoute(
          `TOPOLOGY jev low conf ${answer.confidence.toFixed(2)} -> single`,
        )
        return "single"
      }
      // Jev 失敗時はヒューリスティックへ(縮退運転)。
      // キー自体は有効なので、過去に記録した Jev 事前があれば w1 を使う。
      logRoute("TOPOLOGY jev unavailable -> heuristic")
      return heuristicTopology(category, true)
    }

    // ------------------------------------------------------------------
    // 人間フィードバック(手動レビュー)
    // ------------------------------------------------------------------
    // 応答パネルで1〜5の満足度を受け付け、オーケストレーションの
    // 選択機構へ還元する。HTTP成功率だけでは測れない品質差を補う。
    const feedbackScore = (feedback: Record<string, unknown> | undefined) => {
      const n = num(feedback?.count, 0)
      const raw = num(feedback?.ratingSum, 0)
      if (n <= 0) return 0.5 // 評価なしは中立
      // 1..5 を 0..4 に正規化して、ベータ分布的な平滑化(2件の疑似観測)
      const normalizedSum = (raw - n) / 4
      return (normalizedSum + 1) / (n + 2)
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
      // v0.9.0: 対象ターン(0=最新, 1=1個前, …)。複数個前の応答も審査できる。
      offset: number
      // v0.9.0: ターン統計(tokens/cost/time はメッセージに永続記録されるため
      // 過去ターンも後付け計算できる)。記録が無いターン(エラー応答等)は省略。
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
      const assistants = context
        .filter((message: any) => message?.type === "assistant" && message?.model)
        .sort(
          (a: any, b: any) =>
            num(b?.time?.created, 0) - num(a?.time?.created, 0),
        )
      // v0.9.0: offset 番目の「本文あり」応答を対象にする(0=最新, 1=1個前, …)。
      // offset=0 のみ従来動作(本文なしの最新にもフォールバック)を維持する。
      const withText = assistants.filter((message) => messageText(message).length > 0)
      const assistant = withText[offset] ?? (offset === 0 ? assistants[0] : undefined)
      if (!assistant) return undefined
      const userText = (message: any): string => {
        if (typeof message?.text === "string") return message.text
        if (typeof message?.payload?.text === "string") return message.payload.text
        return (message?.content ?? [])
          .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
          .map((block: any) => block.text)
          .join("\n")
          .trim()
      }
      const users = context
        .filter((message: any) => {
          if (message?.type !== "user") return false
          const created = num(message?.time?.created, 0)
          const assistantCreated = num(assistant?.time?.created, Number.MAX_SAFE_INTEGER)
          return created === 0 || created <= assistantCreated
        })
        .map((message) => ({ message, created: num(message?.time?.created, 0) }))
        .sort((a, b) => b.created - a.created)
      const instruction = users
        .map(({ message }) => userText(message).trim())
        .find((text) => text.length > 0) ?? ""
      const text = messageText(assistant)
      const assignment = await loadReviewAssignment(sessionID)
      // v0.9.0: ターン統計。メッセージに tokens/cost/time が記録されている
      // 場合のみ含める(エラー応答などは省略)。tps = 出力トークン ÷
      // (completed - firstToken) 実測ストリーム時間。
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
        messageID: String(assistant.id ?? ""),
        providerID: String(assistant.model.providerID ?? ""),
        modelID: String(assistant.model.id ?? ""),
        category: assignment.category ?? sessionCategory.get(sessionID) ?? "",
        assignedAt: assignment.assignedAt ?? "",
        instruction,
        instructionPreview: instruction.slice(0, 160),
        text,
        preview: text.slice(0, 480),
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

    // 補助LLM(分類・サマリー・審査): 設定モデルを優先し、観測が良好で
    // クオータ冷却中ではない候補へ自動でフォールバックする。
    // preferred を渡すと、そのモデルを最前位として試みる
    // (内部審査で専用モデルを使い、本応答モデルとの同一性バイアスを避ける)。
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

    // LLMが利用できない場合のローカル分類も用意する(未分類の多発を抑える)。
    // 明確な語彙シグナルがない場合は推測せず「未分類」のままにする。
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

    // Jev の Choice へ渡すカテゴリの対比定義
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
      // 新しい turn: 前 turn の計画を破棄(chain 実行の枠組みを turn 単位に保つ)
      chainPlans.delete(sessionID)
      // 新しい turn: 前 turn の負荷帯も破棄(v0.8 ティアルーティング。
      // LLM/ヒューリスティック経路の「未設定なら設定」判定を正しく働かせる)
      sessionLoad.delete(sessionID)

      // --- Jev 経路(APIキーがあり jevMode=auto のとき最優先) ---
      // カテゴリ分類を Choice で判定する(confidence < 0.5 → 従来経路へ縮退)。
      // トポロジー判定はカテゴリ確定後に pickTopology() で別リクエスト実行
      // (state に category と過去実績の要約を渡せるため)。
      const jev = jevClient()
      if (jev) {
        const answers = await jev.ask(text.slice(0, 1000), {
          category: {
            type: "choice",
            instructions:
              "Classify the user request into exactly one task category.",
            criteria: CATEGORY_CRITERIA,
          },
          // ティアルーティング(v0.8): 分類と同じ1往復で負荷も判定する
          // (追加の API 呼び出しを発生させない)。0-100 の difficulty。
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
        })
        const catAnswer = answers?.category
        // 負荷推定は分類と独立に採用できる(Jev score の信頼度は選ばない。
        // スコア自体は 0-100 の連続値で、ヒューリスティックより常に精度が上と仮定)
        const diffAnswer = answers?.difficulty
        if (diffAnswer?.type === "score" && typeof diffAnswer.score === "number") {
          setSessionLoad(
            sessionID,
            loadFromScore(diffAnswer.score),
            "jev",
            diffAnswer.score,
          )
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

      // --- 従来経路(LLM → キーワード推定)。Jev 成功時はスキップ ---
      if (!category) {
        const prompt = [
          "Classify the following user request into exactly one category.",
          `Categories: ${categories.join(", ")}`,
          "coding = write or modify code, debugging = fix errors or bugs,",
          "review = review or verify, research = question / explain / search,",
          "writing = documents or prose, ops = shell / environment / execution.",
          "Also estimate the cognitive and execution load (difficulty 0-100):",
          "0-25 trivial / 26-50 light / 51-75 middle / 76-100 heavy.",
          'Respond with JSON only: {"category":"<name>","difficulty":<0-100>}',
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
        // LLM 経路でも負荷を取れる。difficulty 無し/範囲外はヒューリスティックへ
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
        if (category && categories.includes(category) && !llmCategory) {
          logRoute(`CLASSIFY keyword ${category}`)
        }
      }

      // 最終縮退: Jev/LLM どちらも負荷を出せなかった場合はヒューリスティック。
      // tierMode=off でも推定自体は記録しておく(表示と後日の統計に使う)
      if (!sessionLoad.has(sessionID)) {
        setSessionLoad(
          sessionID,
          heuristicLoad(text, category),
          "heuristic",
        )
      }

      if (category && categories.includes(category)) {
        sessionCategory.set(sessionID, category)
        void saveReviewAssignment(sessionID, category)
        // 無限成長を避けるための簡易上限
        if (sessionCategory.size > 200) {
          const oldest = sessionCategory.keys().next().value
          if (oldest) sessionCategory.delete(oldest)
        }
      } else {
        console.log(
          "[adaptive-fusion] classify failed: no classifier response or category",
        )
      }

      const resolvedTopology = await pickTopology(text, category)
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
    // プロンプト受信時の事前rescue
    // ------------------------------------------------------------------
    // モデルが冷却中(直近「利用不可」)なら、resolve フックの差し替えだけに
    // 任せず、セッション自身のモデルを健康な候補へ切り替える。
    // これにより provider activation も済み、resolve 差し替えが
    // ModelUnavailableError になるケースを避ける。
    const switchSessionIfCooling = async (
      sessionID: string,
      category?: string,
    ) => {
      try {
        const session: any = await ctx.session.get({ sessionID })
        let model = session?.model
        let currentRef =
          model?.providerID && model?.id
            ? refFor(model.providerID, model.id)
            : undefined
        if (!model?.providerID || !model?.id) {
          // 未切替セッション(新規セッションのデフォルトモデル等)は
          // session.model が未設定。resolve が記録した実 dispatch モデル
          // (lastResolved)で代替する(v0.8.1)。無いなら救済不能。
          const hint = lastResolved.get(sessionID)
          if (hint?.providerID && hint?.id) {
            logRoute(`PRE hint ${hint.providerID}/${hint.id} (session model unset)`)
            model = hint
            currentRef = refFor(model.providerID, model.id)
          }
        }
        // rescue復帰: このセッションがrescueで他モデルへ移された
        // 後で、元モデルの冷却が解除された場合、次のプロンプトで
        // 自動的に元のモデルへ戻す
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
              return
            } catch (error) {
              logRoute(`RESCUE restore failed ${sessionID}: ${error}`)
            }
          }
        }
        if (!model?.providerID || !model?.id) {
          logRoute(`PRE skip (session model unreadable, no resolve hint)`)
          return
        }
        if (!cool(currentRef!)) {
          // 現在のモデルが健全でも、rescue復帰の待機エントリーは
          // 失効(24h)まで残す(元モデルの回復を検知するため)
          logRoute(`PRE alive ${currentRef} (no rescue needed)`)
          return
        }

        const choice = await pick(currentRef!, category, true, sessionID)
        if (!choice) {
          logRoute(`KEEP pre-prompt ${currentRef} (no rescue candidate)`)
          return
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
      } catch (error) {
        logRoute(`PRE error: ${String(error).slice(0, 80)}`)
        console.log(`[adaptive-fusion] pre-prompt rescue failed: ${error}`)
      }
    }

    // admission(受付時)の処理を1つのフックに統合(v0.8 監査修正):
    // 1) 分類(カテゴリ/トポロジー/負荷帯)→ 2) 事前rescue。
    // 分けるとフック間の実行順序がランタイムの実装に依存し、rescue が
    // 前ターンのカテゴリ・負荷帯を使う恐れがあるため、順序を明示する。
    await ctx.session.hook("prompt", async (event) => {
      // TUI トグル恒久対策(v0.8.1): TUI 側プラグインインスタンスが
      // 永続化した設定変更を、ターン開始(必ず通る)時にサーバー側へ
      // 再読込して反映する。storage が両インスタンスで共有されている
      // 場合のみ実効的(非共有なら changed=false で実害なし)。
      try {
        if (applyPersistedConfig(await ctx.storage.get(CONFIG_KEY)))
          logRoute(`CONFIG synced from storage (enabled=${cfg.enabled})`)
      } catch {
        // 再同期の失敗は通常処理を妨げない
      }
      try {
        await classify(event.sessionID, event.prompt.text)
      } catch (error) {
        // 分類の失敗は通常処理を妨げない(未分類のまま続行)
        logRoute(`CLASSIFY error: ${String(error).slice(0, 80)}`)
      }
      try {
        await switchSessionIfCooling(
          event.sessionID,
          sessionCategory.get(event.sessionID) ?? undefined,
        )
      } catch {
        // 事前rescueの失敗は通常処理を妨げない(内部でもcatch済みの二重保険)
      }
    })

    // ------------------------------------------------------------------
    // sequential-chain 補助実行(v0.7a 完全版、P0 プローブ済みの context フック)
    // ------------------------------------------------------------------
    // admission で chain が選ばれた turn だけ chainPending に積み、主モデルの
    // dispatch 直前に planner を実行して計画を system へ「参考」として注入する。
    // 注入は送出する1呼出にのみ影響し、履歴・設定は汚さない(公式仕様)。
    // tool 継続の dispatch でも同一 turn の計画を再注入して使い続ける。
    // 失敗・タイムアウト時は注入せず single 相当で続行(縮退運転)。
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
        // 同一 turn 内の tool 継続 dispatch: 計画を再注入して使い続ける。
        // chainPlans は admission(prompt フック)の classify で turn ごとに
        // クリアされるため、古い計画が次の turn へ漏れることはない。
        const existing = chainPlans.get(sessionID)
        if (existing && Array.isArray(event?.system)) {
          event.system.push({
            type: "text",
            text: chainPlanSystemText(existing.plan),
          })
        }
      } catch (error) {
        // context フックの失敗は主応答を妨げない(P0 で例外耐性を確認済み)
        logRoute(`CHAIN context error: ${String(error).slice(0, 80)}`)
      }
    })

    // ------------------------------------------------------------------
    // メトリクス収集(http.request / http.response の区間を計測)
    // ------------------------------------------------------------------
    // キーは sessionID。セッションあたり同一種別のリクエストは逐次実行される前提。
    // プロバイダー非依存に対応するため、フックは非スコープ登録し、
    // コールバック内で cfg.providerID を参照する。
    // ------------------------------------------------------------------
    // 内部レビューハーネス(v0.6) — shadow mode
    // ------------------------------------------------------------------
    // http.response(ok=true) の直後に、依頼文+応答本文を別モデルで審査し、
    // fusion/auto/* に蓄積する。ユーザーへの応答はブロックしない。
    // 現時点ではスコアへ反映しない(記録のみ・表示のみ)。
    const clampScore = (v: unknown): number | undefined => {
      const n = Number(v)
      if (!Number.isFinite(n)) return undefined
      return Math.min(5, Math.max(1, Math.round(n)))
    }

    const runAutoReview = async (sessionID: string): Promise<void> => {
      try {
        const target = await getReviewTarget(sessionID)
        if (!target) return
        if (target.text.length < 120) return // 短すぎる応答は審査しない
        // v0.9.0: コストパフォーマンス軸(efficiency)に渡すターン統計。
        // tokens/cost/time はメッセージに永続記録されているので参照できる。
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
        // 審査出力のパース。JSON → ラベル付き行 → 独立整数、の3段フォールバック。
        const parseAxis = (re: RegExp): number | undefined => {
          const m = re.exec(result.text)
          if (!m) return undefined
          const n = Number(m[1])
          return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined
        }
        // v0.9.0: 穴あきでない JSON 部分の抽出。results 配列を含む新形式の
        // JSON(複数行・文字列内の記号)でも取りこぼさないよう、
        // "instruction" の位置から前方の "{" を探し、括弧カウンタで対応する
        // "}" まで取る。旧形式(3軸のみ)にもそのまま使える。
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
            // v0.9.0: efficiency は任意軸(旧レビューモデルの出力では欠ける)。
            // 欠けても審査自体は有効とする(後方互換)。
            efficiency = clampScore(parsed.efficiency)
            const rawResults = parsed.results
            if (Array.isArray(rawResults))
              results = rawResults
                .map((item) => String(item ?? "").trim())
                .filter((item) => item.length > 0)
                .slice(0, 5)
            reasonText = String(parsed.reason ?? "")
          } else {
            // 行パース(A-2): JSON が取れない場合はラベル+数値 / 日本語ラベルを探す
            instruction = parseAxis(/instruction[^\d]{0,40}([1-5])/i) ??
              parseAxis(/指示[^\d]{0,40}([1-5])/)
            accuracy = parseAxis(/accuracy[^\d]{0,40}([1-5])/i) ??
              parseAxis(/正確[^\d]{0,40}([1-5])/)
            completeness = parseAxis(/completeness[^\d]{0,40}([1-5])/i) ??
              parseAxis(/完了|完遂[^\d]{0,40}([1-5])/)
            // v0.9.0: efficiency も行パースで拾う(欠けても継続)
            efficiency = parseAxis(/efficiency[^\d]{0,40}([1-5])/i) ??
              parseAxis(/効率|コスパ[^\d]{0,40}([1-5])/)
            // それでも欠けていれば、文中の独立した1〜5整数を軸順に割り当てる
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
          // v0.9.0: efficiency は出力された審査のみ加算(収集件数も別管理)。
          // 旧データ(efficiencyCount 未定義)は 0 扱いで後方互換。
          if (efficiency !== undefined) {
            stat.efficiency = (stat.efficiency ?? 0) + efficiency
            stat.efficiencyCount = (stat.efficiencyCount ?? 0) + 1
          }
          // v0.9.0: 実績列挙は直近の審査分で置き換える(最大5件)
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
        // トポロジー統計にも品質スコアを加算する(v0.7a、5点満点→3軸平均)
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
      { start: number; modelID: string; providerID: string }
    >()
    // 実際に dispatch されたモデルの記録(v0.8.1)。
    // - 未切替セッションは session.model が未設定のため、事前rescueや
    //   step.failed の犯人特定に使える観測が pending(HTTP 実施時のみ)に
    //   しかない。resolve フックは dispatch ごとに必ず来るので、ここで
    //   「このセッションで最後に解決されたモデル」を覚えておく。
    // - HTTP が飛ばない失敗(課金 precheck 等)でもこの値が犯人になる。
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
      // force はプローブなど明示的な観測との互換用(現在は常に記録)
      _force = false,
    ) => {
      // 観測は全プロバイダー分を記録する:
      // rescue 先や crossProvider 候補の健全性把握に必要なため。
      // (統計表示はプロバイダー単位にグループ化される)
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
      // 対象プロバイダー以外も記録対象(rescue 先の健全性把握のため)。
      // crossProvider 判定は resolve フック側で行う。
      pending.set(event.sessionID, {
        start: performance.now(),
        modelID: event.model.id,
        providerID: event.model.providerID,
      })
    })

    await ctx.session.hook("http.response", async (event) => {
      if (!kinds.includes(event.kind)) return
      const observed = pending.get(event.sessionID)
      pending.delete(event.sessionID)
      if (!observed) return

      const ref = refFor(observed.providerID, observed.modelID)
      const ms = performance.now() - observed.start
      const ok = event.response.ok
      const category = sessionCategory.get(event.sessionID)

      if (ok) {
        // 成功した観測はクールダウンを解除する(一時的な利用不可からの復帰)。
        // 解除が実際に発生した場合のみログに出す(v0.8.1: 無記録だと
        // 「冷却が消えた理由不明」になって調査できない)。
        if (clearCooldown(ref))
          logRoute(`RECOVER ok ${ref} (success observation)`)
        await record(observed.modelID, observed.providerID, category, true, ms)
        void recordTopology(event.sessionID, true, ms)
        // 内部審査(shadow): 主応答をブロックせずバックグラウンドで審査
        void runAutoReview(event.sessionID)
        return
      }

      // 失敗時: 無料枠・レート制限(quota)は品質ペナルティから除外し、
      // 長期クールダウンのみを課す(統計の成功率を歪めない)
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
        markFailure(ref, "quota")
        // 失敗直後にセッションモデルを健康な候補へ退避する(v0.8.1)。
        // OpenCode 側の retry / 次の step / drain 再開が
        // 保存された健康モデルを使えるようにするため。
        void switchSessionIfCooling(event.sessionID, category)
        return
      }
      await record(observed.modelID, observed.providerID, category, false, ms)
      void recordTopology(event.sessionID, false, ms)
      void switchSessionIfCooling(event.sessionID, category)
    })
    // ------------------------------------------------------------------
    // ティアルーティング(v0.8、Copilot Fusion / HydraFusion 方式)
    // ------------------------------------------------------------------
    // タスク負荷(Light/Middle/Heavy)に応じて候補プールをティア内に絞る。
    // 層内では既存の statScore+探索がそのまま働き、ティアは「プール」を
    // 定義するだけ(ホワイトリストの強化版)。枯渇時は上方カスケード
    // (Light→Middle→Heavy)、全ティア枯渇時は従来の全候補選択に縮退する。
    // auto モード: ベンチマーク overall の降順で候補を3分割する。
    // コスト上限/ホワイトリストの適用は pick 側の candidates() が担うため、
    // ここでは純粋にティア集合だけを返す。
    const normRef = (ref: string) => ref.replace(/:free$/, "")

    const autoTiers = (): Record<TierName, string[]> | undefined => {
      const benchmarks = loadBenchmarks()
      const models = benchmarks?.models
      if (!models) return undefined
      const entries: { ref: string; score: number }[] = []
      for (const [ref, entry] of Object.entries(models)) {
        if (typeof entry?.overall === "number")
          entries.push({ ref, score: entry.overall })
      }
      // 3分割できる最低数を満たさない場合は auto 導出不可(undefined)
      if (entries.length < 3) return undefined
      entries.sort((a, b) => b.score - a.score)
      const third = Math.ceil(entries.length / 3)
      return {
        heavy: entries.slice(0, third).map((e) => e.ref),
        middle: entries.slice(third, third * 2).map((e) => e.ref),
        light: entries.slice(third * 2).map((e) => e.ref),
      }
    }

    // 現在の tierMode で有効なティア集合。解決できない場合(off 相当)は undefined
    const resolveTiers = (): Record<TierName, string[]> | undefined => {
      if (cfg.tierMode === "manual") return cfg.tiers
      if (cfg.tierMode === "auto") return autoTiers()
      return undefined
    }

    // 負荷帯に対するカスケード順(上方のみ: Light→Middle→Heavy)。
    // 下位への降格は行わない(キャッシュ効果と応答品質の予測可能性を優先)。
    const tierCascade = (load: TierName): TierName[] =>
      load === "light"
        ? ["light", "middle", "heavy"]
        : load === "middle"
          ? ["middle", "heavy"]
          : ["heavy"]

    // ------------------------------------------------------------------
    // ルーティング(experimental.model.resolve)
    // ------------------------------------------------------------------
    // Routing Score(v0.5.1):
    //   score = 自動観測の成功率 × 0.65 + 人間レビュー評価 × 0.35
    //         - costWeight    × 正規化コスト(候補間の相対比)
    //         - latencyWeight × 正規化レイテンシ(候補間の相対比。0〜1)
    // 人間評価は1〜5を0〜1へ正規化し、ベータ分布的に平滑化する。
    // タスク種別統計が十分(minObservations 以上)ならそれを優先し、
    // 不足なら全体統計、なければ中立値 0.5 にフォールバックする。
    const statScore = (
      stat: Stat,
      feedback: unknown,
      refCost: number,
      benchmark?: number,
      benchmarkK = 0,
    ): number => {
      const n = stat.success + stat.failure
      const machine = blendBenchmarkPrior(
        stat.success,
        stat.failure,
        benchmark,
        benchmarkK,
      )
      const human = feedbackScore(feedback as Record<string, unknown> | undefined)
      const score = 0.65 * machine + 0.35 * human
      return score - cfg.costWeight * refCost
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
      // 緊急拡大: rescue 時に候補を全プロバイダーに拡大して退避先を探す。
      // ホワイトリストも緊急時は無視する(予算内のモデルに限る)。
      // - 現プロバイダーがプロバイダー冷却中(無料枠はアカウント単位で全滅)
      // - crossProvider 時は常に(ホワイトリストの無料モデルが全滅しても、
      //   予算内の有料モデルへシームレスに退避できるようにするため)
      const emergency =
        rescue && (providerCool(currentProvider) || cfg.crossProvider)
      let models = await candidates(emergency)
      if (models.length === 0) return undefined

      // ティア選択(v0.8): 負荷帯が決まっているときは、候補をティア内の
      // 健全(非クールダウン)モデルに絞る。層内では既存の statScore+探索が
      // そのまま働く。該当ティアが枯渇していれば上方カスケード
      // (Light→Middle→Heavy)、全ティア枯渇なら従来の全候補選択に縮退。
      // :free 接尾辞の有無は同一モデル扱い(benchmarkFor と同じ正規化)。
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
              // rescue 時は「観測のあるティア」だけを実在とみなす(v0.8 監査修正)。
              // 未観測モデルのみのティアへ絞ると rescue の healthy フィルタ
              // (n>0)で空になり、上方カスケードが働かず退避先なしになるため。
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
      const tierPrefix = () => (tierTag ? `tier:${tierTag} ` : "")

      const maxCost = Math.max(...models.map((m) => m.cost[0].output)) || 1
      // ベンチマーク事前(v0.6): 予算フィルタ通過後の候補に適用する。
      // ファイルが無い場合 / k=0 の場合は benchmark 側が無効化される。
      const benchmarks = loadBenchmarks()
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
          entries.push({
            ref,
            providerID: model.providerID,
            id: model.id,
            n,
            avgMs,
            score: statScore(
              task,
              globalFeedback,
              model.cost[0].output / maxCost,
              benchmark,
              benchK,
            ),
          })
          continue
        }
        const global = await loadStat(model.providerID, model.id)
        if (global && global.success + global.failure > 0) {
          const n = global.success + global.failure
          const avgMs = global.totalMs / n
          const feedback = await loadFeedback(model.providerID, model.id)
          entries.push({
            ref,
            providerID: model.providerID,
            id: model.id,
            n,
            avgMs,
            score: statScore(
              global,
              feedback,
              model.cost[0].output / maxCost,
              benchmark,
              benchK,
            ),
          })
          continue
        }
        const feedback = await loadFeedback(model.providerID, model.id)
        const human = feedbackScore(feedback as Record<string, unknown> | undefined)
        // 人間評価だけがあれば、未観測でも完全に0.5とは扱わない
        const coldMachine = blendBenchmarkPrior(0, 0, benchmark, benchK)
        entries.push({ ref, providerID: model.providerID, id: model.id, n: 0, avgMs: 0, score: 0.65 * coldMachine + 0.35 * human })
      }
      // レイテンシを候補間の相対比で正規化して減点する。
      // (以前の avgMs / 60_000 で固定だったため、0.5秒程度のモデルでも
      //  0.003 程度しか減点されず、軽さが実質無視されていた)
      // 観測済み候補の最大値を基準とし、未観測の候補には中立の0.5を使う。
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
      // クールダウン中(直近で「利用不可」になった)モデルは除外する。
      // cool() はプロバイダー単位の冷却も照会する(無料枠全滅前提)。
      const usable = entries.filter((e) => !cool(e.ref))
      // rescue(現モデルが利用不可/クールダウン中)時は:
      //  - 観測のある健康なモデルから最良スコアを選ぶ(未検証への退避をしない)
      //  - 探索はしない。現モデルは候補から外す
      //  - ルーティング OFF でもこの経路だけは動く(セッション硬直の防止)
      //  - 現プロバイダーがプロバイダー冷却中(無料枠はアカウント単位で
      //    全滅)なら、候補を全プロバイダーに緊急拡大して退避先を探す
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
      // crossProvider 時は保守的に: 観測のないモデル(n=0)を差し替え先に
      // しない。未検証モデルへのなりゆきの差し替えを防ぐ。
      // ただし現在と同じプロバイダーのモデルは従来どおり cold-start を許可。
      const eligible = cfg.crossProvider
        ? usable.filter((e) => e.n > 0 || e.providerID === currentProvider)
        : usable
      if (eligible.length === 0) return undefined
      // 探索(ε-greedy + 学習期間):
      // - 観測が少ないモデル(minObservations 未満)が残っている間は learningRate
      //   を探索率とし、そのような「cold なモデル」だけを候補にする。
      // - 全モデルが十分観測された後は通常の exploreRate で全候補から選ぶ。
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
      // デバッグ(v0.8.1 検証): フックの発火と kind を必ず記録する。
      // 発火しないならルーティング経路自体がこの環境で無効ということになる。
      logRoute(
        `RESOLVE kind=${event.kind} ${event.model.providerID}/${event.model.id} agent=${event.agent ?? "?"}`,
      )
      // 実 dispatch モデルを記録(事前rescue・誤犯人判定のフォールバック用)。
      // kinds フィルタ前に取る(title 等の補助 dispatch も実 dispatch のため)。
      lastResolved.set(event.sessionID, {
        providerID: event.model.providerID,
        id: event.model.id,
      })
      if (!kinds.includes(event.kind)) return
      // 単一プロバイダー時は対象プロバイダー以外を触らない。
      // crossProvider 時はどのプロバイダーのリクエストも再ルーティング対象。
      if (!cfg.crossProvider && event.model.providerID !== cfg.providerID)
        return
      const currentRef = refFor(event.model.providerID, event.model.id)
      // rescue 判定: 現モデルがクールダウン中(直近で利用不可)なら、
      // ルーティング OFF でも介入して健康なモデルへ退避する。
      // (無料枠のモデルはカタログ上 enabled のまま resolve 不可に
      // なるため、検知は失敗履歴=クールダウンで行う)
      const rescue = cool(currentRef)
      if (!cfg.enabled && !rescue) {
        logRoute(`SKIP ${event.kind} ${currentRef} (routing off, alive)`)
        return
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

      // OpenCode 2.3 の model.resolve 経路は「同一プロバイダーへの書き換え」
      // しか解決しない(本体は y.providerID === m.providerID のときだけ
      // resolve し、異プロバイダーは即 ModelUnavailableError を投げる)。
      // そのため resolve フック内での差し替えは同一プロバイダーに限定し、
      // 異プロバイダーへの退避は switchModel(手動モデル選択と同じ経路)で
      // セッションモデルを更新して次の dispatch から適用する。
      if (choice.providerID === event.model.providerID) {
        event.model = { providerID: choice.providerID, id: choice.id }
        logRoute(
          `ROUTE ${event.kind} ${currentRef} -> ${choice.providerID}/${choice.id} (${choice.reason})`,
        )
        // ルーティング結果をセッションの保存モデルにも永続化する(v0.8.1 修正)。
        // resolve による差し替えは dispatch 単位で、保存モデルは元のまま。
        // クオータ死したモデルが保存されたままだと、drain(キュー再開)や
        // 再起動後の再開が保存モデルを直接使って ModelUnavailableError で
        // 強制停止するため、ここで健康なモデルへ揃えておく。
        // ただし保存するのは救済(rescue)による差し替えの場合だけにする。
        // 通常のスコアルーティングまで保存すると、step ごとにセッション
        // モデルが書き換わり、キャッシュが切れ・意図しない有料モデルが
        // 永続化されるため、恒久的な挙動変更は rescue に限定する。
        if (rescue) {
          try {
            await ctx.session.switchModel({
              sessionID: event.sessionID,
              model: { providerID: choice.providerID, id: choice.id },
            })
          } catch {
            // 永続化の失敗は当該 dispatch の差し替えに影響しない
          }
        }
        return
      }

      // 異プロバイダーへの退避(rescue 時のみ)。当該 dispatch は現モデルの
      // まま進む(死んでいれば after-fail が続く)。セッションモデルを
      // 切り替えることで、次の dispatch から確実に健康モデルを使う。
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
      // 通常ルーティングでの異プロバイダー差し替えは行わない。
      // 行うと dispatch ごとにプロバイダーが往復し、キャッシュが切れて
      // コスト・レイテンシが悪化するため(swipe 問題)。
      logRoute(
        `KEEP ${event.kind} ${currentRef} (cross-provider best=${choice.providerID}/${choice.id}, no rewrite)`,
      )
    })

    // ------------------------------------------------------------------
    // 手動レビュー(応答の1〜5評価 + 3行サマリー)
    // ------------------------------------------------------------------
    // v0.9.0: offset の正規化(0=最新, 1=1個前…)。不正値は 0 に倒す。
    const normalizeOffset = (value: unknown): number => {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) return 0
      return Math.min(Math.floor(n), 50)
    }
    // セッションに紐づくトポロジー統計を表示用スナップショットで返す。
    // D-3: コスパ評価に加え、観測実績(実行回数/ok率/実測レイテンシ/品質)も返す。
    const topologySnapshot = async (sessionID: string) => {
      const topology = sessionTopology.get(sessionID) ?? "single"
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
          // sequential-chain の計画(注入済みの場合)。optional はキーごと省略
          ...(chainPlans.has(sessionID)
            ? { chainPlan: chainPlans.get(sessionID)!.plan }
            : {}),
        }
      }
      const feedback = (await loadFeedback(target.providerID, target.modelID)) as
        | FeedbackStat
        | undefined
      const count = feedback?.count ?? 0
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
              // v0.9.0: コストパフォーマンス軸(収集済みの分だけ平均)
              ...((auto.efficiencyCount ?? 0) > 0
                ? { efficiency: auto.efficiency / auto.efficiencyCount }
                : {}),
              // v0.9.0: 直近の実績列挙
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
        // v0.9.0: ターン統計(入出力トークン/コスト/実測速度)。記録が
        // あるターンのみ含める(optional)
        ...(target.turn ? { turn: target.turn } : {}),
        ...(await topologySnapshot(sessionID)),
        // sequential-chain の計画(注入済みの場合)。optional はキーごと省略
        ...(chainPlans.has(sessionID)
          ? { chainPlan: chainPlans.get(sessionID)!.plan }
          : {}),
        // ティアルーティング(v0.8): このセッションの負荷帯(optional)
        ...(sessionLoad.has(sessionID)
          ? { load: sessionLoad.get(sessionID)! }
          : {}),
        // RPCスキーマは optional object。undefined をキーとして渡さない
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
      if (hasRating) {
        await recordFeedback(
          target.providerID,
          target.modelID,
          target.category || undefined,
          rating!,
        )
      }
      if (hasTopologyRating) {
        await recordTopologyCostPerformance(sessionID, topologyRating!)
      }
      const global = (await loadFeedback(target.providerID, target.modelID)) as
        | FeedbackStat
        | undefined
      const count = global?.count ?? 0
      const topologyInfo = await topologySnapshot(sessionID)
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
    // プローブ(候補モデルへの一斉ヘルスチェック)
    // ------------------------------------------------------------------
    // 候補(ホワイトリスト優先、なければ全候補の先頭16件)に軽量プロンプトを
    // 送り、応答の成否・レイテンシを評価して統計に記録する。
    // ルーティング ON 前の「事前テスト」と、利用不可モデルの事前排除に使う。
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
        return {
          model,
          ok: text.length > 0,
          ms,
          note: text.length > 0 ? "" : "empty response",
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
          // 成功は学習統計に記録し、クールダウンを解除する
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
          // 失敗の種別: 無料枠・レート制限(quota)は品質ペナルティに
          // しない。統計の成功率を歪めない。クールダウンは課す。
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
    // RPC(TUI 部から呼び出される)
    // ------------------------------------------------------------------
    const buildStatsText = async (): Promise<string> => {
      const lines: string[] = []
      lines.push(
        tr(
          `(コスト上限: input ${cfg.maxInputCost} / output ${cfg.maxOutputCost} USD/Mtoken` +
            `${cfg.models.length === 0 ? " — ホワイトリスト空時に適用" : " (ホワイトリスト優先)"})`,
          `(cost cap: input ${cfg.maxInputCost} / output ${cfg.maxOutputCost} USD/Mtoken` +
            `${cfg.models.length === 0 ? " — applied when the whitelist is empty" : " (whitelist takes precedence)"})`,
        ),
      )
      if (!cfg.enabled)
        lines.push(tr("(ルーティング: OFF / 観測のみ)", "(routing: OFF / observing only)"))
      if (cfg.crossProvider)
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
        const benchmarks = loadBenchmarks()
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
          lines.push(
            tr(
              `(ベンチマーク事前: 有効 k=${k} / モデル数 ${Object.keys(benchmarks.models ?? {}).length}` +
                ` / fetchedAt ${(benchmarks.fetchedAt ?? "不明").slice(0, 10)}${stale ? " / 90日経過: kを半減(陳腐化対策)" : ""})`,
              `(benchmark prior: active k=${k} / models ${Object.keys(benchmarks.models ?? {}).length}` +
                ` / fetchedAt ${(benchmarks.fetchedAt ?? "unknown").slice(0, 10)}${stale ? " / older than 90 days: k halved (staleness guard)" : ""})`,
            ),
          )
        }
      }
      // Jev の利用可否とトポロジー判定の状態
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
      // shadow vs 人間評価の乖離(突合)用に、ref → 平均を集めておく
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
        // 審査モデル別の分布(自己採点バイアス検出用、リスク2)
        if (reviewerAgg.size > 1) {
          lines.push(tr("審査モデル別(shadow):", "By reviewer model (shadow):"))
          for (const [reviewer, agg] of reviewerAgg) {
            const avg = agg.sum / Math.max(agg.total * 3, 1)
            lines.push(
              `- reviewer ${reviewer}: ${avg.toFixed(2)}/5 (${agg.total} ${tr("件", "entries")})`,
            )
          }
        }
        // skip 記録(A-2): 審査できなかった事実
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
        // shadow vs 人間評価の乖離(突合、A-4 の完了条件 "|乖離| < 1.0")
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

      // トポロジー観測(v0.7a): 判定した形態ごとの実行結果
      const topologyPage = await ctx.storage.scan({
        prefix: TOPOLOGY_PREFIX,
        limit: 100,
      })
      const topologyEntries = topologyPage.entries.filter(
        (entry) => !entry.key.startsWith(TASK_TOPOLOGY_PREFIX),
      )
      if (topologyEntries.length > 0) {
        lines.push(
          tr(
            `(トポロジー選定スコア重み: Jev事前 w1=${cfg.topologyWeightJev}${jevAvailable() ? "" : " (キー無しのため w1=0 運用)"} / コスパ w2=${cfg.topologyWeightHumanCP} / 自動観測 w3=${cfg.topologyWeightAuto})`,
            `(topology score weights: Jev prior w1=${cfg.topologyWeightJev}${jevAvailable() ? "" : " (no key, so w1=0)"} / cost-performance w2=${cfg.topologyWeightHumanCP} / auto observation w3=${cfg.topologyWeightAuto})`,
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
        // ティアルーティング(v0.8): モードと層ごとの集計を表示する。
        // 集計はティア構成メンバーの全体統計を合算した導出値(追加の保存なし)
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
      ]) {
        const page = await ctx.storage.scan({ prefix, limit: 500 })
        for (const entry of page.entries) await ctx.storage.remove(entry.key)
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
      // sequential-chain の実行状態もクリア
      chainPending.clear()
      chainPlans.clear()
      // 負荷帯(v0.8 ティアルーティング)もクリア
      sessionLoad.clear()
      lastResolved.clear()
    }

    // 設定の部分更新(検証済みの値のみ適用し、保存する)
    const applyConfigUpdate = (update: Record<string, unknown>) => {
      if (typeof update.enabled === "boolean") cfg.enabled = update.enabled
      if (typeof update.providerID === "string" && update.providerID.length > 0) {
        // プロバイダー変更時、ホワイトリストは旧プロバイダーのモデルIDを
        // 含むため原則クリアする(update 内に models がある場合はそちらを優先)
        if (update.providerID !== cfg.providerID && !("models" in update))
          cfg.models = []
        cfg.providerID = update.providerID
      }
      if (typeof update.crossProvider === "boolean") {
        // crossProvider 切替時はホワイトリストの記法が変わる
        // (モデルID ⇔ provider/model-id)ため原則クリアする
        if (update.crossProvider !== cfg.crossProvider && !("models" in update))
          cfg.models = []
        cfg.crossProvider = update.crossProvider
      }
      if (typeof update.exploreRate === "number")
        cfg.exploreRate = clamp(update.exploreRate, 0, 1)
      if (typeof update.learningRate === "number")
        cfg.learningRate = clamp(update.learningRate, 0, 1)
      if (typeof update.minObservations === "number")
        cfg.minObservations = Math.max(1, Math.floor(update.minObservations))
      if (typeof update.costWeight === "number")
        cfg.costWeight = update.costWeight
      if (typeof update.latencyWeight === "number")
        cfg.latencyWeight = update.latencyWeight
      if (typeof update.maxInputCost === "number")
        cfg.maxInputCost = Math.max(0, update.maxInputCost)
      if (typeof update.maxOutputCost === "number")
        cfg.maxOutputCost = Math.max(0, update.maxOutputCost)
      if (typeof update.benchmarkPriorWeight === "number")
        cfg.benchmarkPriorWeight = Math.max(0, update.benchmarkPriorWeight)
      if (typeof update.benchmarksFile === "string")
        cfg.benchmarksFile = update.benchmarksFile
      if (update.jevMode === "auto" || update.jevMode === "off")
        cfg.jevMode = update.jevMode
      if (update.topologyMode === "auto" || update.topologyMode === "fixed")
        cfg.topologyMode = update.topologyMode
      if (typeof update.maxTopologyCalls === "number")
        cfg.maxTopologyCalls = clamp(Math.floor(update.maxTopologyCalls), 1, 16)
      if (typeof update.topologyWeightJev === "number")
        cfg.topologyWeightJev = clamp(update.topologyWeightJev, 0, 1)
      if (typeof update.topologyWeightHumanCP === "number")
        cfg.topologyWeightHumanCP = clamp(update.topologyWeightHumanCP, 0, 1)
      if (typeof update.topologyWeightAuto === "number")
        cfg.topologyWeightAuto = clamp(update.topologyWeightAuto, 0, 1)
      if (update.chainMode === "active" || update.chainMode === "off")
        cfg.chainMode = update.chainMode
      if (
        update.tierMode === "off" ||
        update.tierMode === "manual" ||
        update.tierMode === "auto"
      )
        cfg.tierMode = update.tierMode
      if (update.tiers && typeof update.tiers === "object")
        cfg.tiers = sanitizeTiers(update.tiers)
      if (
        Array.isArray(update.allowedTopologies) &&
        update.allowedTopologies.every((t) => typeof t === "string")
      ) {
        const filtered = (update.allowedTopologies as string[]).filter((t) =>
          KNOWN_TOPOLOGIES.includes(t),
        )
        cfg.allowedTopologies = filtered.length > 0 ? filtered : ["single"]
      }
      if (typeof update.classifierModel === "string") {
        cfg.classifierModel =
          update.classifierModel.includes("/") ? update.classifierModel : null
      }
      if (typeof update.reviewModel === "string") {
        // 空文字は審査モデルの未設定(= classifierModel/共有フォールバックへ戻す)
        if (update.reviewModel.length === 0) cfg.reviewModel = null
        else if (update.reviewModel.includes("/"))
          cfg.reviewModel = update.reviewModel
      }
      if (Array.isArray(update.models) && update.models.every((m) => typeof m === "string"))
        cfg.models = update.models as string[]
      // 表示言語(v0.9.0)。インストールごとの既定は options.lang だが、
      // /fusion-lang での切替を保存して以後の表示に反映する。
      if (update.lang === "ja" || update.lang === "en") cfg.lang = update.lang
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
      reviewInfo: async (input) => ({
        ...await reviewSnapshot(
          String((input as any)?.sessionID ?? ""),
          normalizeOffset((input as any)?.offset),
        ),
      }),
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

    return () => {
      abortEventWatch.abort()
      pending.clear()
      lastResolved.clear()
      cooldownTombstones.clear()
      rescueTombstones.clear()
      sessionCategory.clear()
      sessionTopology.clear()
      sessionLoad.clear()
      chainPending.clear()
      chainPlans.clear()
    }
  },
})
