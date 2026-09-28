import { describe, expect, test } from "bun:test"
import { resolveActorContext, unknownResolution } from "../src/context/actor-resolver.ts"
import type { MessageWithParts, PermissionRequest } from "../src/types.ts"
import type { ClientResponse, OpenCodeClientLike } from "../src/opencode/types.ts"

// --- mock client ------------------------------------------------------------

interface SessionFixture {
  meta?: Record<string, unknown> // returned by session.get; omit to simulate 404
  messages?: MessageWithParts[]
}

interface MockOptions {
  sessions?: Record<string, SessionFixture>
  getUnavailable?: boolean // host client lacks session.get entirely
  messagesUnavailable?: string[] // sessionIDs whose messages fetch should fail
}

function buildClient(opts: MockOptions = {}): OpenCodeClientLike {
  const sessions = opts.sessions ?? {}
  const failing = new Set(opts.messagesUnavailable ?? [])
  const client: OpenCodeClientLike = {
    session: {
      create: async () => ({ data: {} }),
      messages: async (options: unknown) => {
        const id = readPathId(options)
        if (id === undefined || failing.has(id) || !sessions[id]) {
          return { error: { status: 404 } } as ClientResponse<unknown>
        }
        const all = sessions[id]!.messages ?? []
        const limit =
          typeof options === "object" &&
          options !== null &&
          typeof (options as Record<string, unknown>).query === "object" &&
          (options as Record<string, unknown>).query !== null
            ? ((options as Record<string, unknown>).query as Record<string, unknown>)
            : undefined
        const count = typeof limit?.limit === "number" ? limit.limit : all.length
        return { data: all.slice(-count) }
      },
      prompt: async () => ({ data: {} }),
    },
    tool: { ids: async () => ({ data: [] }) },
  }
  if (!opts.getUnavailable) {
    client.session.get = async (options: unknown) => {
      const id = readPathId(options)
      if (id === undefined || !sessions[id] || sessions[id]!.meta === undefined) {
        return { error: { status: 404 } } as ClientResponse<unknown>
      }
      return { data: sessions[id]!.meta }
    }
  }
  return client
}

function readPathId(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) return undefined
  const path = (options as Record<string, unknown>).path
  if (typeof path === "object" && path !== null) {
    const id = (path as Record<string, unknown>).id
    return typeof id === "string" ? id : undefined
  }
  return undefined
}

function request(
  sessionID = "ses_current",
  tool?: { messageID: string; callID: string },
): PermissionRequest {
  return {
    id: "req_1",
    sessionID,
    permission: "bash",
    patterns: ["*"],
    metadata: {},
    always: [],
    ...(tool === undefined ? {} : { tool }),
  }
}

function assistantMessage(
  id: string,
  opts: { agent?: string; mode?: string } = {},
): MessageWithParts {
  return {
    info: {
      id,
      role: "assistant",
      ...(opts.agent === undefined ? {} : { agent: opts.agent }),
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
    },
    parts: [],
  }
}

function userMessage(id: string, text: string): MessageWithParts {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] }
}

import { DEFAULT_CONFIG } from "../src/config.ts"

const cfg = {
  ...DEFAULT_CONFIG,
  actorProfiles: {},
}

// --- tests ------------------------------------------------------------------

describe("actor resolver — current-session actor", () => {
  test("exact tool message match yields confirmed agent/mode", async () => {
    // Single assistant message carrying BOTH agent/mode and the tool call.
    const messages = [
      {
        info: { id: "msg_a", role: "assistant", agent: "codex", mode: "default" },
        parts: [{ type: "tool", callID: "call_1", tool: "bash" }],
      },
    ] as MessageWithParts[]
    const res = await resolveActorContext(
      request("ses_current", { messageID: "msg_a", callID: "call_1" }),
      messages,
      buildClient(),
      "/repo",
      cfg,
    )
    expect(res.actor.agentName.value).toBe("codex")
    expect(res.actor.mode.value).toBe("default")
    expect(res.actor.agentName.confidence).toBe("confirmed")
    expect(res.actor.identityCompleteness).toBe("complete")
  })

  test("assistant message without agent metadata resolves unknown", async () => {
    const messages = [assistantMessage("msg_a")]
    const res = await resolveActorContext(
      request("ses_current", { messageID: "msg_a", callID: "call_x" }),
      messages,
      buildClient(),
      "/repo",
      cfg,
    )
    expect(res.actor.agentName.value).toBeUndefined()
    expect(res.actor.identityCompleteness).toBe("unknown")
  })

  test("missing tool messageID falls back to unknown", async () => {
    const res = await resolveActorContext(request("ses_current"), [], buildClient(), "/repo", cfg)
    expect(res.actor.agentName.value).toBeUndefined()
    expect(res.actor.identityCompleteness).toBe("unknown")
  })
})

describe("actor resolver — lineage walk", () => {
  test("single parent: depth 1", async () => {
    const client = buildClient({
      sessions: {
        ses_current: { meta: { id: "ses_current", parentID: "ses_parent" } },
        ses_parent: { meta: { id: "ses_parent" } },
      },
    })
    const res = await resolveActorContext(request("ses_current"), [], client, "/repo", cfg)
    expect(res.lineage.depth).toBe(1)
    expect(res.lineage.nodes.map((n) => n.sessionID)).toEqual(["ses_current", "ses_parent"])
    expect(res.actor.rootSessionID.value).toBe("ses_parent")
  })

  test("multi-level chain: depth 3", async () => {
    const client = buildClient({
      sessions: {
        a: { meta: { id: "a", parentID: "b" } },
        b: { meta: { id: "b", parentID: "c" } },
        c: { meta: { id: "c", parentID: "d" } },
        d: { meta: { id: "d" } },
      },
    })
    const res = await resolveActorContext(request("a"), [], client, "/repo", cfg)
    expect(res.lineage.depth).toBe(3)
    expect(res.actor.rootSessionID.value).toBe("d")
  })

  test("cycle detection stops the walk", async () => {
    const client = buildClient({
      sessions: {
        a: { meta: { id: "a", parentID: "b" } },
        b: { meta: { id: "b", parentID: "a" } },
      },
    })
    const res = await resolveActorContext(request("a"), [], client, "/repo", cfg)
    expect(res.lineage.cycleDetected).toBe(true)
    // a -> b is one real hop; the back-edge to a is detected, not traversed.
    expect(res.lineage.depth).toBe(1)
    expect(res.lineage.missingParents).toContain("a")
  })

  test("depth cap marks truncated", async () => {
    const client = buildClient({
      sessions: {
        a: { meta: { id: "a", parentID: "b" } },
        b: { meta: { id: "b", parentID: "c" } },
        c: { meta: { id: "c", parentID: "d" } },
        d: { meta: { id: "d", parentID: "e" } },
        e: { meta: { id: "e", parentID: "f" } },
        f: { meta: { id: "f" } },
      },
    })
    const res = await resolveActorContext(request("a"), [], client, "/repo", {
      ...cfg,
      maxSessionDepth: 2,
    })
    expect(res.lineage.truncated).toBe(true)
    expect(res.lineage.depth).toBe(2)
  })

  test("missing parent (404) is recorded, not fatal", async () => {
    const client = buildClient({
      sessions: { ses_current: { meta: { id: "ses_current", parentID: "ghost" } } },
    })
    const res = await resolveActorContext(request("ses_current"), [], client, "/repo", cfg)
    expect(res.lineage.missingParents).toContain("ghost")
    expect(res.lineage.depth).toBe(0)
    // No parent resolved beyond the current node → lineage evidence is incomplete.
    expect(res.completeness.lineage).toBe(false)
  })

  test("root session (no parentID): depth 0, root is self", async () => {
    const client = buildClient({ sessions: { ses_current: { meta: { id: "ses_current" } } } })
    const res = await resolveActorContext(request("ses_current"), [], client, "/repo", cfg)
    expect(res.lineage.depth).toBe(0)
    expect(res.actor.rootSessionID.value).toBe("ses_current")
  })

  test("session.get unavailable degrades to depth 0", async () => {
    const client = buildClient({ getUnavailable: true })
    const res = await resolveActorContext(request("ses_current"), [], client, "/repo", cfg)
    expect(res.lineage.depth).toBe(0)
    // No parent metadata at all → lineage evidence is incomplete.
    expect(res.completeness.lineage).toBe(false)
  })
})

describe("actor resolver — intent separation", () => {
  test("correlated V1 task in parent becomes delegatedTask", async () => {
    const client = buildClient({
      sessions: {
        ses_current: { meta: { id: "ses_current", parentID: "ses_parent" } },
        ses_parent: {
          meta: { id: "ses_parent" },
          messages: [
            {
              info: { id: "msg_p1", role: "assistant" },
              parts: [
                {
                  type: "tool",
                  tool: "task",
                  state: {
                    input: { prompt: "Refactor the parser module" },
                    metadata: { sessionId: "ses_current" },
                  },
                },
              ],
            },
          ],
        },
      },
    })
    const res = await resolveActorContext(request("ses_current"), [], client, "/repo", cfg)
    expect(res.intent.delegatedTask).toHaveLength(1)
    expect(res.intent.delegatedTask[0]!.text).toBe("Refactor the parser module")
  })

  test("no subtask in parent yields empty delegatedTask and partial completeness", async () => {
    const client = buildClient({
      sessions: {
        ses_current: { meta: { id: "ses_current", parentID: "ses_parent" } },
        ses_parent: { meta: { id: "ses_parent" }, messages: [] },
      },
    })
    const res = await resolveActorContext(request("ses_current"), [], client, "/repo", cfg)
    expect(res.intent.delegatedTask).toHaveLength(0)
    // No direct intent and no delegation recovered anywhere → insufficient.
    expect(res.intent.completeness).toBe("insufficient")
  })

  test("V2 subagent metadata sessionID correlates the child and excludes siblings", async () => {
    const messages: MessageWithParts[] = [
      {
        info: { id: "parent_msg", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "subagent",
            state: { input: { agent: "reviewer", prompt: "Uncorrelated brief" } },
          },
          {
            type: "tool",
            tool: "subagent",
            state: {
              input: { agent: "reviewer", prompt: "Sibling brief", sessionID: "ses_sibling" },
              metadata: { sessionID: "ses_sibling" },
            },
          },
          {
            type: "tool",
            tool: "subagent",
            state: {
              input: { agent: "reviewer", prompt: "Actual child task", sessionID: "ses_child" },
              metadata: { sessionID: "ses_child" },
            },
          },
        ],
      },
    ]
    const client = buildClient({
      sessions: {
        ses_child: { meta: { id: "ses_child", parentID: "ses_parent" } },
        ses_parent: { meta: { id: "ses_parent" }, messages },
      },
    })
    const res = await resolveActorContext(request("ses_child"), [], client, "/repo", cfg)
    expect(res.intent.delegatedTask.map((block) => block.text)).toEqual(["Actual child task"])
  })

  test("V2 resumed subagent calls correlate from input sessionID", async () => {
    const client = buildClient({
      sessions: {
        ses_child: { meta: { id: "ses_child", parentID: "ses_parent" } },
        ses_parent: {
          meta: { id: "ses_parent" },
          messages: [
            {
              info: { id: "resume", role: "assistant" },
              parts: [
                {
                  type: "tool",
                  tool: "subagent",
                  state: {
                    input: {
                      agent: "reviewer",
                      prompt: "Resumed child instruction",
                      sessionID: "ses_child",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    })
    const res = await resolveActorContext(request("ses_child"), [], client, "/repo", cfg)
    expect(res.intent.delegatedTask.map((block) => block.text)).toEqual([
      "Resumed child instruction",
    ])
  })

  test("uncorrelated V1 task and subtask briefs cannot authorize a different child", async () => {
    const client = buildClient({
      sessions: {
        ses_child: { meta: { id: "ses_child", parentID: "ses_parent" } },
        ses_parent: {
          meta: { id: "ses_parent" },
          messages: [
            {
              info: { id: "legacy_task", role: "assistant" },
              parts: [
                { type: "tool", tool: "task", state: { input: { prompt: "Inspect the parser" } } },
                { type: "subtask", prompt: "Deploy production" },
              ],
            },
          ],
        },
      },
    })
    const res = await resolveActorContext(
      request("ses_child"),
      [userMessage("brief", "Deploy production")],
      client,
      "/repo",
      cfg,
    )
    expect(res.intent.delegatedTask).toEqual([])
    expect(res.intent.directUserIntent).toEqual([])
    expect(res.intent.localSessionIntent[0]?.actor).toBe("assistant")
  })

  test("history window retrieves older human authorization beyond intent block count", async () => {
    const parentMessages = [userMessage("old_auth", "Human says inspect deployment configuration")]
    for (let i = 0; i < 20; i++)
      parentMessages.push({
        info: { id: `assistant_${i}`, role: "assistant" },
        parts: [{ type: "text", text: "work" }],
      })
    parentMessages.push(userMessage("latest_auth", "Human says only report findings"))
    const client = buildClient({
      sessions: {
        ses_child: { meta: { id: "ses_child", parentID: "ses_parent" } },
        ses_parent: { meta: { id: "ses_parent" }, messages: parentMessages },
      },
    })
    const res = await resolveActorContext(request("ses_child"), [], client, "/repo", cfg)
    expect(res.intent.directUserIntent.map((block) => block.text)).toContain(
      "Human says inspect deployment configuration",
    )
    expect(res.intent.latestExplicitAuthorization?.text).toBe("Human says only report findings")
  })

  test("direct user intent is separated from delegated task", async () => {
    const client = buildClient({
      sessions: {
        ses_current: { meta: { id: "ses_current", parentID: "ses_parent" } },
        ses_parent: {
          meta: { id: "ses_parent" },
          messages: [
            userMessage("msg_u1", "Please clean up the tmp directory"),
            {
              info: { id: "msg_p1", role: "assistant" },
              parts: [
                {
                  type: "tool",
                  tool: "task",
                  state: {
                    input: { prompt: "rm -rf /tmp/build" },
                    metadata: { sessionId: "ses_current" },
                  },
                },
              ],
            },
          ],
        },
      },
    })
    const res = await resolveActorContext(request("ses_current"), [], client, "/repo", cfg)
    expect(res.intent.directUserIntent.some((b) => b.text.includes("clean up"))).toBe(true)
    expect(res.intent.delegatedTask.some((b) => b.text.includes("rm -rf"))).toBe(true)
    expect(res.intent.directUserIntent.every((b) => b.actor === "user")).toBe(true)
    expect(res.intent.latestExplicitAuthorization?.actor).toBe("user")
  })

  test("synthetic control messages are not treated as authorization", async () => {
    const messages = [userMessage("msg_synth", "Magic Compact: history compressed")]
    const res = await resolveActorContext(
      request("ses_current"),
      messages,
      buildClient(),
      "/repo",
      cfg,
    )
    expect(res.intent.localSessionIntent).toHaveLength(0)
  })
})

describe("actor resolver — resilience", () => {
  test("resolver failure yields unknown actor and review still proceeds", async () => {
    const client: OpenCodeClientLike = {
      session: {
        create: async () => {
          throw new Error("boom")
        },
        messages: async () => {
          throw new Error("boom")
        },
        get: async () => {
          throw new Error("boom")
        },
        prompt: async () => ({ data: {} }),
      },
      tool: { ids: async () => ({ data: [] }) },
    }
    const res = await resolveActorContext(
      request("ses_current", { messageID: "m", callID: "c" }),
      [],
      client,
      "/repo",
      cfg,
    )
    expect(res.actor.identityCompleteness).toBe("unknown")
    expect(res.completeness.overall).toBe("insufficient")
  })

  test("unknownResolution helper produces a self-consistent fallback", () => {
    const res = unknownResolution(request("ses_x"), new Error("e"))
    expect(res.lineage.rootSessionID).toBe("ses_x")
    expect(res.actor.identityCompleteness).toBe("unknown")
    expect(res.completeness.permission).toBe(true)
  })

  test("configured actorProfiles mapping resolves profile", async () => {
    const messages = [assistantMessage("msg_a", { agent: "lint-bot" })]
    const res = await resolveActorContext(
      request("ses_current", { messageID: "msg_a", callID: "c" }),
      messages,
      buildClient(),
      "/repo",
      { ...cfg, actorProfiles: { "lint-bot": "read-only" } },
    )
    expect(res.actor.profile.value).toBe("read-only")
    expect(res.actor.profile.confidence).toBe("confirmed")
  })
})

// Locks the multi-hop happy path validated live against the real SDK: a 3-level
// chain resolves depth 2, the root is the top ancestor, the configured profile
// mapping is applied, and completeness reflects a fully-walked lineage.
describe("actor resolver — multi-hop lineage happy path", () => {
  test("three-level chain resolves root, depth, profile and completeness", async () => {
    const client = buildClient({
      sessions: {
        leaf: { meta: { id: "leaf", parentID: "mid" } },
        mid: { meta: { id: "mid", parentID: "root", agent: "mid-agent" } },
        root: { meta: { id: "root" } },
      },
    })
    const messages = [
      {
        info: { id: "msg_leaf", role: "assistant", agent: "generalist", mode: "default" },
        parts: [{ type: "tool", tool: "bash", callID: "call_leaf" }],
      },
    ] as MessageWithParts[]
    const res = await resolveActorContext(
      request("leaf", { messageID: "msg_leaf", callID: "call_leaf" }),
      messages,
      client,
      "/repo",
      { ...cfg, actorProfiles: { generalist: "workspace" } },
    )
    expect(res.actor.agentName.value).toBe("generalist")
    expect(res.actor.profile.value).toBe("workspace")
    expect(res.actor.profile.confidence).toBe("confirmed")
    expect(res.lineage.depth).toBe(2)
    expect(res.lineage.rootSessionID).toBe("root")
    expect(res.lineage.nodes.map((n) => n.sessionID)).toEqual(["leaf", "mid", "root"])
    expect(res.actor.delegationDepth.value).toBe(2)
    expect(res.completeness.lineage).toBe(true)
    expect(res.actor.identityCompleteness).toBe("complete")
  })
})
