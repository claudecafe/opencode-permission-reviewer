import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import { createV2ReviewerBackend } from "../src/opencode/v2/backend-factory.ts"
import type { ReviewEnvelope } from "../src/types.ts"
import { config, request } from "./helpers.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]

function envelope(): ReviewEnvelope {
  return {
    request: request(),
    directory: "/workspace",
    worktree: "/workspace",
    transcript: "Run printf safe",
    intentHistory: "Run printf safe",
    enrichment: "",
    sshAudit: [],
  }
}

function fixture(
  options: {
    active?: (providerID: string) => Promise<{ providerID: string } | undefined>
    resolve?: (connection: { providerID: string }) => Promise<{ type: string; key?: string }>
  } = {},
) {
  const resolutions: string[] = []
  const context = {
    integration: {
      connection: {
        active: async (providerID: string) => options.active?.(providerID),
        resolve: async (connection: { providerID: string }) => {
          resolutions.push(connection.providerID)
          return options.resolve?.(connection) ?? { type: "key", key: "synthetic-stored-key" }
        },
      },
    },
  } as unknown as Context
  const backend = createV2ReviewerBackend(context, config({ model: "opencode/jev-1.13" }))
  return { backend, resolutions }
}

async function withFetch<T>(run: (authorization: string[]) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  const authorization: string[] = []
  globalThis.fetch = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get("authorization") ?? "")
      return Response.json({ error: { message: "Synthetic rejected credential" } }, { status: 401 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    return await run(authorization)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function review(backend: ReturnType<typeof createV2ReviewerBackend>) {
  return backend.review(envelope(), new ReviewAttempt("credential-test", 5000), {} as never)
}

test("V2 System One gives a nonempty environment key precedence without environment mutation", async () => {
  const previous = process.env.OPENCODE_API_KEY
  process.env.OPENCODE_API_KEY = " synthetic-env-key "
  const { backend, resolutions } = fixture({
    active: async () => ({ providerID: "opencode" }),
  })
  try {
    await withFetch(async (authorization) => {
      const result = await review(backend)
      expect(result.kind).toBe("escalate")
      expect(authorization).toEqual(["Bearer synthetic-env-key"])
      expect(resolutions).toEqual([])
      expect(process.env.OPENCODE_API_KEY).toBe(" synthetic-env-key ")
    })
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previous
  }
})

test("V2 resolves saved opencode before opencode-go and filters OAuth credentials", async () => {
  const previous = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  const { backend, resolutions } = fixture({
    active: async (providerID) => ({ providerID }),
    resolve: async ({ providerID }) =>
      providerID === "opencode"
        ? { type: "oauth", key: "synthetic-oauth-token" }
        : { type: "key", key: "synthetic-go-key" },
  })
  try {
    await withFetch(async (authorization) => {
      expect((await review(backend)).kind).toBe("escalate")
      expect(resolutions).toEqual(["opencode", "opencode-go"])
      expect(authorization).toEqual(["Bearer synthetic-go-key"])
    })
  } finally {
    if (previous !== undefined) process.env.OPENCODE_API_KEY = previous
  }
})

test("V2 looks up stored credentials for every request so key rotation takes effect", async () => {
  const previous = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  let key = "synthetic-key-one"
  const { backend, resolutions } = fixture({
    active: async () => ({ providerID: "opencode" }),
    resolve: async () => ({ type: "key", key }),
  })
  try {
    await withFetch(async (authorization) => {
      expect((await review(backend)).kind).toBe("escalate")
      key = "synthetic-key-two"
      expect((await review(backend)).kind).toBe("escalate")
      expect(authorization).toEqual(["Bearer synthetic-key-one", "Bearer synthetic-key-two"])
      expect(resolutions).toEqual(["opencode", "opencode"])
      expect(process.env.OPENCODE_API_KEY).toBeUndefined()
    })
  } finally {
    if (previous !== undefined) process.env.OPENCODE_API_KEY = previous
  }
})

test("OAuth-only, missing, and failed stored lookup never approves", async () => {
  const previous = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  try {
    for (const active of [
      async () => undefined,
      async (providerID: string) => (providerID === "opencode" ? { providerID } : undefined),
    ]) {
      const { backend } = fixture({
        active,
        resolve: async () => ({ type: "oauth", key: "synthetic-oauth-token" }),
      })
      expect((await review(backend)).kind).toBe("escalate")
    }
    const { backend } = fixture({
      active: async () => ({ providerID: "opencode" }),
      resolve: async () => {
        throw new Error("Synthetic connection lookup failure")
      },
    })
    expect((await review(backend)).kind).toBe("escalate")
  } finally {
    if (previous !== undefined) process.env.OPENCODE_API_KEY = previous
  }
})

test("non-Zen System One continues to use its provider environment key", async () => {
  const previous = process.env.CMD_API_KEY
  const previousZen = process.env.OPENCODE_API_KEY
  process.env.CMD_API_KEY = "synthetic-commandcode-key"
  process.env.OPENCODE_API_KEY = "synthetic-unrelated-zen-key"
  const backend = createV2ReviewerBackend(
    {} as Context,
    config({ model: "commandcode/typesafe/jev" }),
  )
  try {
    await withFetch(async (authorization) => {
      expect((await review(backend)).kind).toBe("escalate")
      expect(authorization).toEqual(["Bearer synthetic-commandcode-key"])
    })
  } finally {
    if (previous === undefined) delete process.env.CMD_API_KEY
    else process.env.CMD_API_KEY = previous
    if (previousZen === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousZen
  }
})
