// OpenCode Adaptive Fusion - TUI part
//
// スラッシュコマンドを TUI 側で処理し、RPC 経由でサーバー部の状態を
// 操作・表示する。セッションにメッセージを注入しないため、
// エージェントの応答を誘発しない。
//
// /fusion-stats      統計表示
// /fusion-toggle     ルーティング ON/OFF
// /fusion-config     現在の設定を表示
// /fusion-provider   ルーティング対象プロバイダーを変更
// /fusion-whitelist  ルーティング候補モデルのホワイトリスト編集
// /fusion-costcap    ホワイトリスト空時の入力/出力コスト上限を編集
// /fusion-review     応答をサマリー/モデル評価・トポロジーコスパ評価(各1〜5)。ターン指定で遡及レビュー可
// /fusion-probe      候補モデルに一斉テストプロンプトを送信(応答評価)
// /fusion-reset      学習統計・クールダウン・人間評価リセット
// /fusion-reviewmodel 内部審査(shadow)の担当モデルを設定
// /fusion-chainmode  sequential-chain 補助実行(計画注入)の切替 off/active
// /fusion-tiermode   ティアルーティング(負荷別 Light/Middle/Heavy)の切替
// /fusion-tiers      ティアごとのモデルグループ編成(ホワイトリスト強化版)
// /fusion-jev-key     Jev(TypeSafe) APIキーを登録/解除(optional)

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

type FusionConfig = {
  enabled?: boolean
  providerID?: string
  crossProvider?: boolean
  exploreRate?: number
  learningRate?: number
  minObservations?: number
  costWeight?: number
  latencyWeight?: number
  classifierModel?: string | null
  kinds?: string[]
  models?: string[]
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
  chainMode?: "off" | "active"
  tierMode?: "off" | "manual" | "auto"
  tiers?: { heavy?: string[]; middle?: string[]; light?: string[] }
  jevAvailable?: boolean
}

const formatConfig = (c: FusionConfig): string => {
  const lines = [
    `provider      : ${c.providerID ?? "-"}${c.crossProvider ? " (cross: 全プロバイダー混合)" : ""}`,
    `routing       : ${c.enabled ? "ON" : "OFF"}`,
    `exploreRate   : ${c.exploreRate ?? "-"} (learning ${c.learningRate ?? "-"} / minObs ${c.minObservations ?? "-"})`,
    `weights       : cost ${c.costWeight ?? "-"} / latency ${c.latencyWeight ?? "-"}`,
    `classifier    : ${c.classifierModel ?? "(分類なし)"}`,
    `reviewModel   : ${c.reviewModel ?? "(classifierModel と同じ経路 / 共有フォールバック)"}`,
    `jev           : ${c.jevMode === "off" ? "OFF (jevMode=off)" : c.jevAvailable ? "利用可能 (分類・トポロジー判定を Jev で実行)" : "キー未登録 — 従来経路で動作"}`,
    `topology      : ${c.topologyMode === "fixed" ? "fixed / single 固定" : `auto / ${(c.allowedTopologies ?? []).join(", ")} / 補助呼出上限 ${c.maxTopologyCalls ?? 4}`}`,
    `topo weights  : jev事前 ${c.topologyWeightJev ?? "-"} / コスパ ${c.topologyWeightHumanCP ?? "-"} / 自動観測 ${c.topologyWeightAuto ?? "-"}`,
    `chain         : ${c.chainMode === "active" ? "active (chain選択時にplanner計画をsystem注入)" : "off (判定と記録のみ / /fusion-chainmode で切替)"}`,
    `tiers         : ${c.tierMode === "manual" ? "manual" : c.tierMode === "auto" ? "auto (ベンチマークから3分割)" : "off (/fusion-tiermode で切替)"}`,
    `  heavy        : ${((c.tiers?.heavy ?? []).join(", ")) || "(空)"}`,
    `  middle       : ${((c.tiers?.middle ?? []).join(", ")) || "(空)"}`,
    `  light        : ${((c.tiers?.light ?? []).join(", ")) || "(空)"}`,
    `cost cap      : input ${c.maxInputCost ?? 0} / output ${c.maxOutputCost ?? 0} USD/Mtoken(ホワイトリスト空時のみ)`,
    `bench prior   : weight ${c.benchmarkPriorWeight ?? "-"}${c.benchmarksFile ? ` / ${c.benchmarksFile}` : ""}`,
    `kinds         : ${(c.kinds ?? []).join(", ")}`,
    `models(white) : ${(c.models ?? []).length === 0 ? "(全候補 + コスト上限)" : (c.models ?? []).join(", ")}`,
  ]
  return lines.join("\n")
}

export default Plugin.define({
  id: "adaptive-fusion.tui",
  setup(context) {
    const fusion = context.client.rpc(AdaptiveFusion)
    // RPC は location スコープで登録されるため、TUI の現在ロケーションを
    // 明示的に渡す(省略するとサーバー作業ディレクトリにフォールバックし、
    // プラグイン未登録のロケーションを参照して rpc.unavailable になる)。
    const location = () => context.location ?? context.data.location.default()

    // fusion: ON/OFF の永続表示用シグナル(初期値は起動時にRPCから取得)。
    // jev の利用状態はバッジに出さず /fusion-config で確認する。
    const [fusionEnabled, setFusionEnabled] = createSignal<boolean | undefined>(
      undefined,
    )
    void (async () => {
      try {
        const result: any = await fusion.config({}, { location: location() })
        if (typeof result?.config?.enabled === "boolean")
          setFusionEnabled(result.config.enabled)
      } catch {
        // 取得失敗時は表示しない(TUIの動作は妨げない)
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
    // ホーム/プロンプトのビルトインフッター(内蔵ステータスより後ろ、
    // バージョン表示より前)に常時表示する
    context.ui.slot({ append: "home.footer.status", render: fusionBadge })
    context.ui.slot({ append: "prompt.footer.status", render: fusionBadge })

    const currentSessionID = async (): Promise<string | undefined> => {
      // 画面上の現在ルート(通常はセッションビュー)から取得する
      try {
        const route: any = (context.ui as any).router?.current?.()
        const routed = route?.sessionID ?? route?.data?.sessionID ?? route?.params?.sessionID
        if (typeof routed === "string" && routed.length > 0) return routed
      } catch {
        // ルーターが使えない環境ではactive sessionへフォールバック
      }

      // 実行中セッションが1つだけの場合はそれを使う
      try {
        const active: any = await (context.client as any).session?.active?.({
          location: location(),
        })
        const source = active?.data ?? active
        const ids = Object.keys(source ?? {}).filter((id) => typeof source[id] === "object")
        if (ids.length === 1) return ids[0]
      } catch {
        // active sessionが取れない環境ではundefined
      }
      return undefined
    }

    type AutoReviewInfo = {
      average: number
      instruction: number
      accuracy: number
      completeness: number
      // v0.9.0: コストパフォーマンス軸の平均(未収集は省略)
      efficiency?: number
      // v0.9.0: 直近の実績列挙(未収集は省略)
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
      // v0.9.0: 対象ターン(0=最新, 1=1個前, …)
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
      // v0.9.0: ターン統計(入出力トークン/コスト/実測速度)
      turn?: TurnStatsInfo
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

    // 長文を表示する大型ダイアログ。本文だけをスクロール可能にし、
    // タイトルと閉じるボタンは常に見えるように固定する。
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
            <text fg={context.theme.text.base} flexShrink={0}>{title}</text>
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
              [閉じる] (Esc)
            </text>
          </box>
        ),
        () => undefined,
      )
    }

    const closeReviewUI = () => {
      // レビューパネルからでも、カスタムダイアログからでも閉じられるようにする
      try {
        (context.ui.dialog as any).clear?.()
      } catch {
        // dialog APIが使えない組み込みではパネル側のcloseに任せる
      }
      try {
        (context.ui as any).panel?.close?.()
      } catch {
        // panel APIが使えない環境では無視
      }
    }

    const ReviewPanel = (props: {
      sessionID: string
      close: () => void
      // v0.9.0: 対象ターン(0=最新, 1=1個前, …)。省略時は 0(最新)。
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
      const [message, setMessage] = createSignal("応答の質を1〜5で評価してください。")

      const load = async () => {
        try {
          const result = (await fusion.reviewInfo(
            { sessionID: props.sessionID, offset: offset() },
            { location: location() },
          )) as ReviewInfo
          setInfo(result)
        } catch (error) {
          setMessage(`読込失敗: ${errorText(error)}`)
        }
      }
      void load()

      // v0.9.0: 対象ターンの移動(0=最新, 1=1個前, …)。
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
          setMessage(`サマリー失敗: ${errorText(error)}`)
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
            ? `${result.message} — 平均 ${result.feedbackAverage.toFixed(1)}/5 (${result.feedbackCount}件)`
            : result.message)
          await load()
        } catch (error) {
          setMessage(`評価失敗: ${errorText(error)}`)
        } finally {
          setBusy(false)
        }
      }
      // トポロジー(オーケストレーション形態)のコスパ評価【第2行】
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
          setMessage(`トポロジーコスパ評価失敗: ${errorText(error)}`)
        } finally {
          setBusy(false)
        }
      }

      return (
        <box flexDirection="column" padding={1} gap={1} flexGrow={1} minHeight={0} backgroundColor={context.theme.background.raised.base}>
          <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
            <text fg={context.theme.text.base}>
              Adaptive Fusion — 応答レビュー{offset() > 0 ? `(ターン: ${offset()}個前)` : "(最新応答)"}
            </text>
            <text fg={context.theme.text.base} onMouseDown={() => props.close()}>[閉じる]</text>
          </box>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text
              fg={context.theme.text.base}
              onMouseDown={() => void shiftOffset(1)}
            >
              [◀ 古い方へ]
            </text>
            <text
              fg={context.theme.text.base}
              onMouseDown={() => void shiftOffset(-1)}
            >
              {offset() > 0 ? "[▶ 新しい方へ]" : "[▶ 最新(現在)]"}
            </text>
          </box>
          <text fg={context.theme.text.base} flexShrink={0}>
            担当: {info()?.category ?? "(読込中)"} | モデル: {info() ? `${info()!.providerID}/${info()!.modelID}` : "-"}
          </text>
          <text fg={context.theme.text.base} flexShrink={0}>
            依頼: {info()?.instructionPreview ?? "(読込中)"}
          </text>
          <text fg={context.theme.text.base} flexShrink={0}>
            {info()?.turn
              ? `ターン統計: 入 ${info()!.turn!.inputTokens.toLocaleString("en-US")} → 出 ${info()!.turn!.outputTokens.toLocaleString("en-US")} tok`
              : "ターン統計: (記録なし)"}
          </text>
          {info()?.turn
            ? (
              <text fg={context.theme.text.base} flexShrink={0}>
                ↳ 推論 {info()!.turn!.reasoningTokens.toLocaleString("en-US")} / cache読み {info()!.turn!.cacheRead.toLocaleString("en-US")} tok / コスト ${info()!.turn!.cost.toFixed(6)}
              </text>
            )
            : null}
          {info()?.turn
            ? (
              <text fg={context.theme.text.base} flexShrink={0}>
                ↳ 実測 {(info()!.turn!.durationMs / 1000).toFixed(1)}s{info()!.turn!.tps > 0 ? ` / ${info()!.turn!.tps.toFixed(1)} tok/s` : ""} / finish: {info()!.turn!.finish || "?"}
              </text>
            )
            : null}
          <text fg={context.theme.text.base} flexShrink={0}>
            人間評価: {info() && info()!.feedbackCount > 0
              ? `${info()!.feedbackAverage.toFixed(1)}/5 (${info()!.feedbackCount}件)`
              : "まだ評価なし"}
          </text>
          <text fg={context.theme.text.base} flexShrink={0}>
            トポロジー: {info()?.topology ?? "single"}
            {info() && (info()!.topologyCount ?? 0) > 0
              ? ` — 実行 ${info()!.topologyCount}回 / ok ${Math.round((info()!.topologyOkRate ?? 0) * 100)}% / avg ${((info()!.topologyAvgMs ?? 0) / 1000).toFixed(1)}s`
              : " — 観測なし"}
          </text>
          {info() &&
            ((info()!.topologyCount ?? 0) > 0 ||
              (info()!.topologyRatingCount ?? 0) > 0)
            ? (
              <text fg={context.theme.text.base} flexShrink={0}>
                ↳ {(info()!.topologyQualityAverage ?? 0) > 0 ? `品質 ${info()!.topologyQualityAverage!.toFixed(1)}/5 ・ ` : ""}コスパ {(info()!.topologyRatingCount ?? 0) > 0 ? `${info()!.topologyRatingAverage!.toFixed(1)}/5 (${info()!.topologyRatingCount}件)` : "未評価"}
              </text>
            )
            : null}
          {info()?.chainPlan
            ? (
              <text fg={context.theme.text.base} flexShrink={0}>
                実行計画(chain): {info()!.chainPlan!.slice(0, 160)}
                {info()!.chainPlan!.length > 160 ? "…" : ""}
              </text>
            )
            : null}
          {info()?.load
            ? (
              <text fg={context.theme.text.base} flexShrink={0}>
                負荷帯(tier): {info()!.load!}
              </text>
            )
            : null}
          <text fg={context.theme.text.base} flexShrink={0}>
            自動審査(shadow): {info()?.autoReview
              ? `${info()!.autoReview!.average.toFixed(2)}/5 (指示${info()!.autoReview!.instruction.toFixed(1)} / 正確性${info()!.autoReview!.accuracy.toFixed(1)} / 完全性${info()!.autoReview!.completeness.toFixed(1)}${info()!.autoReview!.efficiency !== undefined ? ` / コスパ${info()!.autoReview!.efficiency.toFixed(1)}` : ""}, ${info()!.autoReview!.total}件)`
              : "未審査(次の応答から記録)"}
          </text>
          {info()?.autoReview?.results?.length
            ? (
              <box flexDirection="column" flexShrink={0}>
                {info()!.autoReview!.results!.map((item, index) => (
                  <text key={String(index)} fg={context.theme.text.base}>
                    実績{index + 1}: {item}
                  </text>
                ))}
              </box>
            )
            : null}
          {info()?.autoReview?.reason
            ? <text fg={context.theme.text.base} flexShrink={0}>自動理由: {info()!.autoReview!.reason}</text>
            : null}
          <scrollbox
            flexGrow={1}
            minHeight={4}
            border
            borderColor={context.theme.border.base}
            backgroundColor={context.theme.background.raised.base}
            padding={1}
          >
            <text fg={context.theme.text.base}>{info()?.preview ?? "(読込中)"}</text>
          </scrollbox>
          {summary() && (
            <box
              border
              borderColor={context.theme.border.base}
              backgroundColor={context.theme.background.raised.base}
              padding={1}
              height={5}
              flexShrink={0}
            >
              <text fg={context.theme.text.base}>3行サマリー</text>
              <text fg={context.theme.text.base}>{summary()}</text>
            </box>
          )}
          <text fg={context.theme.text.base} flexShrink={0}>モデル評価(1〜5)</text>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={context.theme.text.base} onMouseDown={() => void generateSummary()}>
              {busy() ? "[サマリー生成中…]" : "[サマリーを生成]"}
            </text>
            <text fg={context.theme.text.base} onMouseDown={() => void rate(1)}>[1]</text>
            <text fg={context.theme.text.base} onMouseDown={() => void rate(2)}>[2]</text>
            <text fg={context.theme.text.base} onMouseDown={() => void rate(3)}>[3]</text>
            <text fg={context.theme.text.base} onMouseDown={() => void rate(4)}>[4]</text>
            <text fg={context.theme.text.base} onMouseDown={() => void rate(5)}>[5]</text>
          </box>
          <text fg={context.theme.text.base} flexShrink={0}>トポロジーコスパ評価(1〜5)</text>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={context.theme.text.base} onMouseDown={() => void rateTopology(1)}>[1]</text>
            <text fg={context.theme.text.base} onMouseDown={() => void rateTopology(2)}>[2]</text>
            <text fg={context.theme.text.base} onMouseDown={() => void rateTopology(3)}>[3]</text>
            <text fg={context.theme.text.base} onMouseDown={() => void rateTopology(4)}>[4]</text>
            <text fg={context.theme.text.base} onMouseDown={() => void rateTopology(5)}>[5]</text>
          </box>
          <text fg={context.theme.text.base} flexShrink={0}>{message()}</text>
        </box>
      )
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fusion.stats",
          title: "adaptive-fusion: 学習統計を表示",
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
          title: "adaptive-fusion: ルーティングの有効/無効を切替",
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
          id: "fusion.config",
          title: "adaptive-fusion: 現在の設定を表示",
          slash: { name: "fusion-config" },
          run: async () => {
            try {
              const result = await fusion.config({}, { location: location() })
              showLongText("adaptive-fusion config", formatConfig(result.config))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-config: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.costcap",
          title: "adaptive-fusion: ホワイトリスト空時の入力/出力コスト上限を編集",
          slash: { name: "fusion-costcap" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const currentMaxInput = current.config.maxInputCost ?? 0
              const currentMaxOutput = current.config.maxOutputCost ?? 0
              const input = await context.ui.dialog.prompt({
                title: "adaptive-fusion cost cap",
                placeholder: "input,output (USD/Mtoken) — 0,0で無料モデルのみ",
                default: `${currentMaxInput},${currentMaxOutput}`,
              })
              if (input === undefined) return
              const values = input.split(",").map((s) => Number(s.trim()))
              if (values.length !== 2 || values.some((v) => !Number.isFinite(v) || v < 0)) {
                context.ui.toast.show({
                  message: "cost cap: input,output を 0 以上の数値で入力してください",
                  variant: "error",
                })
                return
              }
              const [maxInputCost, maxOutputCost] = values
              const result = await fusion.config(
                { update: { maxInputCost, maxOutputCost } },
                { location: location() },
              )
              context.ui.toast.show({
                message: `cost cap: input ${maxInputCost} / output ${maxOutputCost}`,
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(result.config))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-costcap: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.reviewmodel",
          title: "adaptive-fusion: 内部審査(shadow)の担当モデルを設定",
          slash: { name: "fusion-reviewmodel" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const currentModel = current.config.reviewModel ?? ""
              const input = await context.ui.dialog.prompt({
                title: "adaptive-fusion review model",
                placeholder: "provider/model (空で解除 = classifierModel と同じフォールバック)",
                default: currentModel,
              })
              if (input === undefined) return
              const reviewModel = input.trim()
              if (reviewModel !== "" && !reviewModel.includes("/")) {
                context.ui.toast.show({
                  message: "review model は provider/model 形式で入力してください(空で解除)",
                  variant: "error",
                })
                return
              }
              const result = await fusion.config(
                { update: { reviewModel: reviewModel === "" ? "" : reviewModel } },
                { location: location() },
              )
              context.ui.toast.show({
                message: reviewModel === "" ? "review model: 解除" : `review model: ${reviewModel}`,
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(result.config))
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-reviewmodel: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.chainmode",
          title: "adaptive-fusion: sequential-chain 補助実行(計画注入)の切替",
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
                    ? "chain 実行: active(chain 選択時に planner 計画を注入)"
                    : "chain 実行: off(判定と記録のみ)",
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
          title: "adaptive-fusion: ティアルーティング(負荷別 Light/Middle/Heavy)の切替",
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
                  ? "manual(ユーザー定義ティア)"
                  : next === "auto"
                  ? "auto(ベンチマークから3分割)"
                  : "off(全候補から選択)"
              context.ui.toast.show({
                message: `tier mode: ${label}`,
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(result.config))
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
          title: "adaptive-fusion: ティアのモデル編成を設定(Heavy/Middle/Light)",
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
                    "provider/model をカンマ区切りで(例: openrouter/z-ai/glm-5.3, openrouter/deepseek/...)。空でこのティアをクリア",
                  default: (current.config.tiers?.[tier as "heavy"] ?? []).join(", "),
                })
                if (input === undefined) return // キャンセル
                const models = input
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                const invalid = models.filter((s) => !s.includes("/"))
                if (invalid.length > 0) {
                  context.ui.toast.show({
                    message: `${label} tier: provider/model 形式で入力してください(不正: ${invalid.join(", ")})`,
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
                message: "ティア編成を保存しました(tierMode が off の場合は /fusion-tiermode で有効化)",
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(result.config))
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
          title: "adaptive-fusion: Jev(TypeSafe) APIキーを登録/解除",
          slash: { name: "fusion-jev-key" },
          run: async () => {
            try {
              const status = await fusion.jevKey({}, { location: location() })
              const input = await context.ui.dialog.prompt({
                title: "adaptive-fusion jev key",
                placeholder: status.available
                  ? "現在利用可能 — 新しいキーを入力 / 空で解除"
                  : "Jev APIキーを入力 / 空で解除(TYPESAFE_API_KEY 環境変数でも可)",
                default: "",
              })
              if (input === undefined) return
              const key = input.trim()
              const result = await fusion.jevKey({ key }, { location: location() })
              context.ui.toast.show({
                message: result.available
                  ? key === ""
                    ? "jev key: 解除(環境変数 TYPESAFE_API_KEY があればそちらを使用)"
                    : "jev key: 登録しました(利用可能)"
                  : key === ""
                    ? "jev key: 解除しました"
                    : "jev key: 登録しましたが、現在の設定では無効です(jevMode=off?)",
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
          title: "adaptive-fusion: 応答をサマリー/1〜5評価",
          slash: { name: "fusion-review" },
          run: async () => {
            const sessionID = await currentSessionID()
            if (!sessionID) {
              context.ui.toast.show({
                message: "fusion-review: 現在のセッションを特定できませんでした",
                variant: "error",
              })
              return
            }
            // v0.9.0: 対象ターンの選択(0=最新, 1=1個前, …)。
            // 後からバグが見つかった応答も遡ってレビューできる。
            let initialOffset = 0
            try {
              const turnInput = await context.ui.dialog.prompt({
                title: "adaptive-fusion review 対象ターン",
                placeholder: "0=最新, 1=1個前, 2=2個前… (空で最新)",
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
              // prompt が使えない環境では最新応答にフォールバック
            }
            context.ui.dialog.set({ size: "large", centered: true })
            context.ui.dialog.show(
              () => (
                <box
                  width={84}
                  height={44}
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
          id: "fusion.whitelist",
          title: "adaptive-fusion: ルーティング候補モデルのホワイトリスト編集",
          slash: { name: "fusion-whitelist" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const cross = current.config.crossProvider === true
              const currentText = (current.config.models ?? []).join(", ")
              const input = await context.ui.dialog.prompt({
                title: "adaptive-fusion whitelist",
                placeholder: cross
                  ? "provider/model-id, ... (空で全候補 例: openrouter/z-ai/glm-4.6)"
                  : "model-id-1, model-id-2 (空で全候補)",
                ...(currentText ? { default: currentText } : {}),
              })
              if (input === undefined) return
              const models = input
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
              const result = await fusion.config(
                { update: { models } },
                { location: location() },
              )
              context.ui.toast.show({
                message: `whitelist: ${
                  models.length === 0 ? "(全候補)" : models.join(", ")
                }`,
                variant: "success",
              })
              if (result.config) {
                showLongText("adaptive-fusion config", formatConfig(result.config))
              }
            } catch (error) {
              context.ui.toast.show({
                message: `fusion-whitelist: ${errorText(error)}`,
                variant: "error",
              })
            }
          },
        },
        {
          id: "fusion.provider",
          title: "adaptive-fusion: ルーティング対象プロバイダーを変更",
          slash: { name: "fusion-provider" },
          run: async () => {
            try {
              const current = await fusion.config({}, { location: location() })
              const input = await context.ui.dialog.prompt({
                title: "adaptive-fusion provider",
                placeholder: "provider-id (例: openrouter / opencode)",
                ...(current.config.providerID
                  ? { default: current.config.providerID }
                  : {}),
              })
              if (input === undefined) return
              const providerID = input.trim()
              if (!providerID) return
              if (providerID === current.config.providerID) return
              // プロバイダー変更時はホワイトリストもリセットされる
              const result = await fusion.config(
                { update: { providerID, models: [] } },
                { location: location() },
              )
              context.ui.toast.show({
                message: `provider: ${result.config.providerID}`,
                variant: "success",
              })
              showLongText("adaptive-fusion config", formatConfig(result.config))
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
          title: "adaptive-fusion: 候補モデルに一斉テストプロンプトを送信",
          slash: { name: "fusion-probe" },
          run: async () => {
            const ok = await context.ui.dialog.confirm({
              title: "adaptive-fusion probe",
              message:
                "候補モデルに一斉にテストプロンプトを送信します。\n" +
                "成否・レイテンシを学習統計に記録し、失敗モデルはクールダウンします。\n" +
                "最大16モデル・並列4・1件20秒程度かかる場合があります。実行しますか?",
              label: { confirm: "Run", cancel: "Cancel" },
            })
            if (!ok) return
            try {
              context.ui.toast.show({
                message: "probe: 実行中…",
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
          title: "adaptive-fusion: 学習統計・クールダウンをリセット",
          slash: { name: "fusion-reset" },
          run: async () => {
            const ok = await context.ui.dialog.confirm({
              title: "adaptive-fusion",
              message: "学習統計とクールダウン(利用不可フラグ)をリセットしますか?",
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
