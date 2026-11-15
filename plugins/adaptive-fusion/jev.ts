// OpenCode Adaptive Fusion - TypeSafe System One (Jev) client
//
// Jev(System One モデル)は自然言語を理解し、型付きの判定と確率
// (Choice / Score / Noul)を返す。コードが制御フローを持ち、モデルは
// 狭く型付けされた判断だけを返す — fusion の「判定は composable に、
// 制御はコードが持つ」という設計と整合する。
//
// このクライアントは失敗時に例外を投げず undefined を返す。
// 呼び出し側は必ずフォールバック経路(LLM / キーワード / 従来動作)へ
// 縮退できるように作ってある(TypeSafe 縮退運転方針)。
//
// API キーはサーバー側(このファイルの呼び出し元)だけが保持する。
// RPC や表示経路へは一切載せない。読み込み元:
//   1. ctx.storage["fusion/jev-key"] (/fusion-jev-key で登録)
//   2. process.env.TYPESAFE_API_KEY  (環境変数)
// モデル名は既定で jev-latest (GET /v1/models で取得できる名前)。

export type JevChoiceAnswer = {
  type: "choice"
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export type JevScoreAnswer = {
  type: "score"
  score: number
  confidence: number
  probabilities: Record<string, number>
  // API の ScoreAnswer は legend(スコアレベルの対応表)を返す。参考として保持する
  legend?: Record<string, string>
}

export type JevNoulAnswer = {
  type: "noul"
  noul: number
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer

export type JevQuestion =
  | {
      type: "choice"
      instructions: string
      criteria: Record<string, string>
    }
  | {
      type: "score"
      instructions: string
      criteria: string[]
    }
  | {
      type: "noul"
      instructions: string
      criteria?: { true: string; false: string }
    }

export type JevQuestions = Record<string, JevQuestion>

const API_URL = "https://api.typesafe.ai/v1/systemone"
const TIMEOUT_MS = 12_000
const DEFAULT_MODEL = "jev-latest"

export class JevClient {
  private readonly apiKey: string
  private readonly model: string

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.apiKey = apiKey
    this.model = model
  }

  // 1リクエストに複数の独立した質問を並列で投げる(System One の標準パターン)。
  // 全質問を1回で評価するため、往復レイテンシを最小化できる。
  // 失敗時は undefined を返す(呼び出し側で縮退)。
  async ask(
    state: string | Record<string, unknown>,
    questions: JevQuestions,
  ): Promise<Record<string, JevAnswer> | undefined> {
    if (!this.apiKey) return undefined
    if (Object.keys(questions).length === 0) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: controller.signal,
      })
      if (!response.ok) return undefined
      const json = (await response.json()) as {
        answers?: Record<string, JevAnswer>
      }
      if (!json || typeof json !== "object" || !json.answers) return undefined
      return json.answers
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  async choice(
    state: string | Record<string, unknown>,
    instructions: string,
    criteria: Record<string, string>,
  ): Promise<JevChoiceAnswer | undefined> {
    const answers = await this.ask(state, {
      answer: { type: "choice", instructions, criteria },
    })
    const answer = answers?.answer
    return answer?.type === "choice" ? answer : undefined
  }

  async score(
    state: string | Record<string, unknown>,
    instructions: string,
    criteria: string[],
  ): Promise<JevScoreAnswer | undefined> {
    const answers = await this.ask(state, {
      answer: { type: "score", instructions, criteria },
    })
    const answer = answers?.answer
    return answer?.type === "score" ? answer : undefined
  }

  async noul(
    state: string | Record<string, unknown>,
    instructions: string,
    criteria?: { true: string; false: string },
  ): Promise<JevNoulAnswer | undefined> {
    const answers = await this.ask(state, {
      answer: { type: "noul", instructions, ...(criteria ? { criteria } : {}) },
    })
    const answer = answers?.answer
    return answer?.type === "noul" ? answer : undefined
  }
}
