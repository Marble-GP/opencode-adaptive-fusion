// OpenCode Adaptive Fusion - TypeSafe System One (Jev) client
//
// Jev (System One model) understands natural language and returns typed
// judgments with probabilities (Choice / Score / Noul). The code owns the
// control flow; the model only returns narrowly typed judgments — consistent
// with fusion's design of "composable judgments, code-owned control".
//
// On failure this client does not throw; it returns undefined. Callers are
// expected to degrade to a fallback path (LLM / keyword / legacy behavior)
// (TypeSafe degraded-operation policy).
//
// The API key is held only by the server side (the caller of this file).
// It is never exposed to RPC or the display path. Sources, in order:
//   1. ctx.storage["fusion/jev-key"] (registered via /fusion-jev-key)
//   2. process.env.TYPESAFE_API_KEY  (environment variable)
// The model defaults to jev-latest (the name available from GET /v1/models).

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
  // The API's ScoreAnswer also returns a legend (score-level mapping). Kept for reference
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

  // Send multiple independent questions in parallel in a single request (the standard System One pattern).
  // All questions are evaluated in one round trip, minimizing round-trip latency.
  // Returns undefined on failure (callers degrade).
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
