import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { ReviewAttempt } from "../../core/review-attempt.ts"
import { isSystemOneReviewerModel, splitModel } from "../../config.ts"
import {
  createSystemOneInvoker,
  SystemOneReviewerBackend,
  type SystemOneInvoke,
} from "../../system-one/backend.ts"
import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../../types.ts"
import { V2ReviewerBackend } from "./reviewer-backend.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]

export interface V2ReviewBackend {
  owns(sessionID: string): boolean
  review(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    client: OpenCodeClient,
  ): Promise<ReviewExecutionResult>
  waitForIdle(): Promise<void>
  dispose(): Promise<void>
}

function escalationConfig(config: ReviewerConfig): ReviewerConfig | undefined {
  const escalation = config.escalationReviewer
  if (!escalation) return
  const base = { ...config }
  delete base.escalationReviewer
  return {
    ...base,
    ...escalation,
  }
}

export function createV2ReviewerBackend(context: Context, config: ReviewerConfig): V2ReviewBackend {
  if (!isSystemOneReviewerModel(config.model)) return new V2ReviewerBackend(context, config)
  const secondaryConfig = escalationConfig(config)
  const secondary = secondaryConfig ? new V2ReviewerBackend(context, secondaryConfig) : undefined
  const primary = new SystemOneReviewerBackend(
    config,
    undefined,
    secondaryConfig?.model,
    createZenInvoker(context, config),
  )
  return {
    owns: (sessionID) => secondary?.owns(sessionID) ?? false,
    review: (envelope, attempt, client) =>
      primary.review(
        envelope,
        attempt,
        secondary ? (value, current) => secondary.review(value, current, client) : undefined,
      ),
    waitForIdle: async () => {
      await Promise.all([primary.waitForIdle(), secondary?.waitForIdle()])
    },
    dispose: async () => {
      await Promise.all([primary.waitForIdle(), secondary?.dispose()])
    },
  }
}

function createZenInvoker(context: Context, config: ReviewerConfig): SystemOneInvoke | undefined {
  if (splitModel(config.model).providerID !== "opencode") return
  return async (state, signal) => {
    const explicitKey = process.env.OPENCODE_API_KEY?.trim()
    if (explicitKey) return createSystemOneInvoker(config, undefined, explicitKey)(state, signal)

    for (const integrationID of ["opencode", "opencode-go"]) {
      const connection = await context.integration.connection.active(integrationID)
      if (!connection) continue
      const credential = await context.integration.connection.resolve(connection)
      if (credential?.type !== "key" || !credential.key.trim()) continue
      return createSystemOneInvoker(config, undefined, credential.key)(state, signal)
    }
    throw new Error(
      "Missing OPENCODE_API_KEY or a saved OpenCode API key; connect through /connect",
    )
  }
}
