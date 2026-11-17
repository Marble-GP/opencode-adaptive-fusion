// OpenCode Adaptive Fusion - RPC contract
// Implemented by the server part (index.ts) and called from the TUI part (tui.ts).

import { Rpc } from "@opencode/plugin/rpc"

export const AdaptiveFusion = Rpc.define({
  id: "adaptive-fusion",
  events: {},
  methods: {
    stats: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      errors: {},
    },
    toggle: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
      errors: {},
    },
    probe: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      errors: {},
    },
    reset: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      errors: {},
    },
    config: {
      input: {
        type: "object",
        properties: {
          update: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              providerID: { type: "string" },
              crossProvider: { type: "boolean" },
              exploreRate: { type: "number" },
              learningRate: { type: "number" },
              minObservations: { type: "number" },
              costWeight: { type: "number" },
              latencyWeight: { type: "number" },
              // Server stores null when unset (TUI tolerates both).
              classifierModel: { type: ["string", "null"] },
              kinds: { type: "array", items: { type: "string" } },
              models: { type: "array", items: { type: "string" } },
              maxInputCost: { type: "number" },
              maxOutputCost: { type: "number" },
              benchmarkPriorWeight: { type: "number" },
              benchmarksFile: { type: "string" },
              reviewModel: { type: ["string", "null"] },
              jevMode: { type: "string", enum: ["auto", "off"] },
              topologyMode: { type: "string", enum: ["auto", "fixed"] },
              maxTopologyCalls: { type: "number" },
              allowedTopologies: { type: "array", items: { type: "string" } },
              topologyWeightJev: { type: "number" },
              topologyWeightHumanCP: { type: "number" },
              topologyWeightAuto: { type: "number" },
              // v1.1: probability of adopting a non-greedy topology at selection time
              topologyExploreRate: { type: "number" },
              chainMode: { type: "string", enum: ["off", "active"] },
              tierMode: { type: "string", enum: ["off", "manual", "auto"] },
              tiers: {
                type: "object",
                properties: {
                  heavy: { type: "array", items: { type: "string" } },
                  middle: { type: "array", items: { type: "string" } },
                  light: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
              // v0.9.0: display language (ja/en)
              lang: { type: "string", enum: ["ja", "en"] },
              // v1.0: independent-audit auto-review weight in routing quality
              autoReviewWeight: { type: "number" },
              // v1.0: daily auto-refresh of the benchmark library (toggle-ON linked)
              benchAutoUpdate: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              providerID: { type: "string" },
              crossProvider: { type: "boolean" },
              exploreRate: { type: "number" },
              learningRate: { type: "number" },
              minObservations: { type: "number" },
              costWeight: { type: "number" },
              latencyWeight: { type: "number" },
              // Server stores null when unset (TUI tolerates both).
              classifierModel: { type: ["string", "null"] },
              kinds: { type: "array", items: { type: "string" } },
              models: { type: "array", items: { type: "string" } },
              maxInputCost: { type: "number" },
              maxOutputCost: { type: "number" },
              benchmarkPriorWeight: { type: "number" },
              benchmarksFile: { type: "string" },
              reviewModel: { type: ["string", "null"] },
              jevMode: { type: "string", enum: ["auto", "off"] },
              topologyMode: { type: "string", enum: ["auto", "fixed"] },
              maxTopologyCalls: { type: "number" },
              allowedTopologies: { type: "array", items: { type: "string" } },
              topologyWeightJev: { type: "number" },
              topologyWeightHumanCP: { type: "number" },
              topologyWeightAuto: { type: "number" },
              // v1.1: probability of adopting a non-greedy topology at selection time
              topologyExploreRate: { type: "number" },
              chainMode: { type: "string", enum: ["off", "active"] },
              tierMode: { type: "string", enum: ["off", "manual", "auto"] },
              tiers: {
                type: "object",
                properties: {
                  heavy: { type: "array", items: { type: "string" } },
                  middle: { type: "array", items: { type: "string" } },
                  light: { type: "array", items: { type: "string" } },
                },
                required: ["heavy", "middle", "light"],
                additionalProperties: false,
              },
              jevAvailable: { type: "boolean" },
              // v0.9.0: display language
              lang: { type: "string", enum: ["ja", "en"] },
              // v1.0: independent-audit auto-review weight
              autoReviewWeight: { type: "number" },
              // v1.0: daily auto-refresh of the benchmark library
              benchAutoUpdate: { type: "boolean" },
            },
            required: [
              "enabled",
              "providerID",
              "crossProvider",
              "exploreRate",
              "learningRate",
              "minObservations",
              "costWeight",
              "latencyWeight",
              "classifierModel",
              "kinds",
              "models",
              "maxInputCost",
              "maxOutputCost",
              "benchmarkPriorWeight",
              "benchmarksFile",
              "reviewModel",
              "jevMode",
              "topologyMode",
              "maxTopologyCalls",
              "allowedTopologies",
              "topologyWeightJev",
              "topologyWeightHumanCP",
              "topologyWeightAuto",
              "topologyExploreRate",
              "chainMode",
              "tierMode",
              "tiers",
              "jevAvailable",
              "lang",
              "autoReviewWeight",
              "benchAutoUpdate",
            ],
          },
        },
        required: ["config"],
        additionalProperties: false,
      },
      errors: {},
    },
    jevKey: {
      input: {
        type: "object",
        properties: {
          // Omitted / empty string just reports current availability; empty string unregisters, non-empty registers
          key: { type: "string" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          // Never return the key itself. Only return availability
          available: { type: "boolean" },
        },
        required: ["available"],
        additionalProperties: false,
      },
      errors: {},
    },
    reviewInfo: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          // v0.9.0: review target turn (0 = latest, 1 = one before, ...). Defaults to 0.
          offset: { type: "number" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          // v0.9.0: normalized value of the target turn (0 = latest)
          offset: { type: "number" },
          category: { type: "string" },
          messageID: { type: "string" },
          providerID: { type: "string" },
          modelID: { type: "string" },
          assignedAt: { type: "string" },
          preview: { type: "string" },
          instructionPreview: { type: "string" },
          responseLength: { type: "number" },
          feedbackAverage: { type: "number" },
          feedbackCount: { type: "number" },
          // v0.9.0: turn statistics (input/output tokens, cost, measured speed).
          // Present only for turns where the message has recorded tokens/cost/time (optional)
          turn: {
            type: "object",
            properties: {
              inputTokens: { type: "number" },
              outputTokens: { type: "number" },
              reasoningTokens: { type: "number" },
              cacheRead: { type: "number" },
              cacheWrite: { type: "number" },
              cost: { type: "number" },
              durationMs: { type: "number" },
              tps: { type: "number" },
              finish: { type: "string" },
              createdAt: { type: "number" },
            },
            required: [
              "inputTokens",
              "outputTokens",
              "reasoningTokens",
              "cacheRead",
              "cacheWrite",
              "cost",
              "durationMs",
              "tps",
              "finish",
              "createdAt",
            ],
            additionalProperties: false,
          },
          // The orchestration topology decided in this session (the "topology used" row of /fusion-review)
          topology: { type: "string" },
          topologyRatingAverage: { type: "number" },
          topologyRatingCount: { type: "number" },
          // v0.9.0: observation metrics (D-3): overall stats of this topology (runs, ok-rate, measured latency, quality)
          topologyCount: { type: "number" },
          topologyOkRate: { type: "number" },
          topologyAvgMs: { type: "number" },
          topologyQualityAverage: { type: "number" },
          // Execution plan injected via sequential-chain (only when present; optional, so not in required)
          chainPlan: { type: "string" },
          // Tier routing (v0.8) load band (only when present)
          load: { type: "string", enum: ["heavy", "middle", "light"] },
          autoReview: {
            type: "object",
            properties: {
              average: { type: "number" },
              instruction: { type: "number" },
              accuracy: { type: "number" },
              completeness: { type: "number" },
              // v0.9.0: efficiency axis average (omitted when uncollected, per key)
              efficiency: { type: "number" },
              // v0.9.0: list of recent results (omitted when uncollected, per key)
              results: { type: "array", items: { type: "string" } },
              reason: { type: "string" },
              reviewerRef: { type: "string" },
              total: { type: "number" },
            },
            required: [
              "average",
              "instruction",
              "accuracy",
              "completeness",
              "reason",
              "reviewerRef",
              "total",
            ],
            additionalProperties: false,
          },
        },
        required: [
          "sessionID",
          "offset",
          "category",
          "messageID",
          "providerID",
          "modelID",
          "assignedAt",
          "preview",
          "instructionPreview",
          "responseLength",
          "feedbackAverage",
          "feedbackCount",
          "topology",
          "topologyRatingAverage",
          "topologyRatingCount",
          "topologyCount",
          "topologyOkRate",
          "topologyAvgMs",
          "topologyQualityAverage",
        ],
        additionalProperties: false,
      },
      errors: {},
    },
    reviewSummary: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          // v0.9.0: review target turn (0 = latest, 1 = one before, ...). Defaults to 0.
          offset: { type: "number" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      errors: {},
    },
    reviewRate: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          // Model quality rating (1-5). Optional (if omitted, only the topology cost-performance is recorded)
          rating: { type: "number" },
          // Topology (orchestration shape) cost-performance rating (1-5, /fusion-review second row)
          topologyRating: { type: "number" },
          // v0.9.0: review target turn (0 = latest, 1 = one before, ...). Defaults to 0.
          offset: { type: "number" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
          category: { type: "string" },
          providerID: { type: "string" },
          modelID: { type: "string" },
          feedbackAverage: { type: "number" },
          feedbackCount: { type: "number" },
          topology: { type: "string" },
          topologyRatingAverage: { type: "number" },
          topologyRatingCount: { type: "number" },
          topologyCount: { type: "number" },
          topologyOkRate: { type: "number" },
          topologyAvgMs: { type: "number" },
          topologyQualityAverage: { type: "number" },
        },
        required: [
          "ok",
          "message",
          "category",
          "providerID",
          "modelID",
          "feedbackAverage",
          "feedbackCount",
          "topology",
          "topologyRatingAverage",
          "topologyRatingCount",
          "topologyCount",
          "topologyOkRate",
          "topologyAvgMs",
          "topologyQualityAverage",
        ],
        additionalProperties: false,
      },
      errors: {},
    },
  },
})
