import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * A Shepherd escalation reaches a working private-runtime turn for an agent with no tool-profiles.json
 * (the `ouroboros` bundle's shape). Real code from the sense's delivery through the daemon's private
 * turn policy, the pending queue, the shared pipeline, tool selection and guardrails; only the model,
 * and the daemon socket are stand-ins.
 */
const hoisted = vi.hoisted(() => ({
  agentRoot: "",
  home: "",
  wakes: [] as Array<Record<string, unknown>>,
  runAgent: vi.fn(),
}))

// The bundle lives under a temporary home, so every path the real code derives stays inside it.
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>()
  return { ...actual, homedir: () => hoisted.home }
})
vi.mock("../../../heart/daemon/socket-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../heart/daemon/socket-client")>()
  return {
    ...actual,
    requestPrivateWake: async (agent: string, _socket: string | undefined, options: Record<string, unknown>) => {
      hoisted.wakes.push({ agent, ...options })
      return { ok: true }
    },
  }
})
vi.mock("../../../heart/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../heart/core")>()
  return { ...actual, runAgent: (...args: unknown[]) => hoisted.runAgent(...args) }
})

import { resetIdentity, setAgentName } from "../../../heart/identity"
import { requestPrivateTurnDecision } from "../../../heart/private-runtime"
import { cacheProviderCredentialRecords, createProviderCredentialRecord, resetProviderCredentialCache } from "../../../heart/provider-credentials"
import { getChannelCapabilities } from "@ouro.bot/friends"
import { guardInvocation } from "../../../repertoire/guardrails"
import { getToolsForChannel } from "../../../repertoire/tools"
import type { ReturnRecord } from "../../../senses/shepherd/returns"
import { escalationContent, queueEscalation, wakeForEscalations } from "../../../senses/shepherd/sense"
import { runPrivateRuntimeTurn } from "../../../senses/private-runtime"

const NOW = Date.parse("2026-10-10T12:00:00.000Z")

describe("Shepherd escalation private turn", () => {
  let tmp: string

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-escalation-turn-"))
    hoisted.home = tmp
    hoisted.agentRoot = path.join(tmp, "AgentBundles", "ouroboros.ouro")
    setAgentName("ouroboros")
    hoisted.wakes = []
    fs.mkdirSync(path.join(hoisted.agentRoot, "psyche"), { recursive: true })
    fs.mkdirSync(path.join(hoisted.agentRoot, "state", "private-runtime"), { recursive: true })
    fs.writeFileSync(path.join(hoisted.agentRoot, "agent.json"), JSON.stringify({
      version: 2,
      enabled: true,
      humanFacing: { provider: "minimax", model: "minimax-test" },
      agentFacing: { provider: "minimax", model: "minimax-test" },
      senses: { shepherd: { enabled: true } },
    }))
    resetProviderCredentialCache()
    cacheProviderCredentialRecords("ouroboros", [createProviderCredentialRecord({
      provider: "minimax", credentials: { apiKey: "test-key" }, config: {}, provenance: { source: "manual" }, now: new Date(NOW - 60_000),
    })], new Date(NOW - 30_000))
    hoisted.runAgent.mockReset().mockResolvedValue({ usage: undefined, outcome: "settled" })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetIdentity()
    resetProviderCredentialCache()
  })

  it("queues the receipt, passes the daemon's default policy, and runs a turn that offers the Shepherd tools under family trust", async () => {
    expect(fs.existsSync(path.join(hoisted.agentRoot, "tool-profiles.json"))).toBe(false)
    const record: ReturnRecord = { at: new Date(NOW).toISOString(), host: "cmux", session: "SF-1", transition: "cmux:boot:7", agent: "codex", cwd: "/repo/app", task: "desk/app-fix", kind: "gate", action: "let_through", reason: "It needs Ari to sign in to Azure.", reply: null, latencyMs: 900, inputTokens: 800 }
    queueEscalation("ouroboros", escalationContent(record, "Ari"), NOW)
    await wakeForEscalations("ouroboros", [record.transition])

    // The wake the sense sends, mapped the way the daemon maps a private.wake command.
    expect(hoisted.wakes).toHaveLength(1)
    const wake = hoisted.wakes[0] as { reason: string; triggerSource: string; budgetClass: string; idempotencyKey: string; originRefs: Array<{ kind: string; id: string }> }
    const decision = await requestPrivateTurnDecision({
      agent: "ouroboros",
      origin: "daemon.private.wake",
      reason: wake.reason,
      providerLane: "inner",
      triggerSource: wake.triggerSource,
      budgetClass: wake.budgetClass,
      idempotencyKey: wake.idempotencyKey,
      originRefs: wake.originRefs,
    }, { ledgerPath: path.join(hoisted.agentRoot, "state", "private-runtime", "decisions.jsonl") })
    expect(decision).toMatchObject({ result: "allow", executable: true, reason: "Shepherd escalation" })

    const result = await runPrivateRuntimeTurn({ privateTurnDecision: decision })
    expect(result.turnOutcome).not.toBe("errored")
    expect(hoisted.runAgent).toHaveBeenCalledTimes(1)
    const [messages, , channel, , options] = hoisted.runAgent.mock.calls[0] as [Array<{ role: string; content: unknown }>, unknown, string, unknown, { tools?: Array<{ function: { name: string } }>; pendingMessages?: Array<{ from: string; content: string }>; toolContext: Record<string, any> }]
    expect(messages[0]!.role).toBe("system")
    // runAgent renders drained pending messages into the system prompt, as it does for mail.
    expect(options.pendingMessages).toEqual([expect.objectContaining({ from: "shepherd", content: expect.stringContaining("[Shepherd return]") })])
    expect(options.pendingMessages![0]!.content).toContain("It needs Ari to sign in to Azure.")

    const toolContext = options.toolContext
    expect(toolContext.currentExternalEvent).toBeUndefined()
    expect(toolContext.autonomousTurnKind).toBeDefined()
    expect(toolContext.context.friend.trustLevel).toBe("family")
    // The turn passes no tool override, so runAgent offers what tool selection gives this channel and context.
    expect(options.tools).toBeUndefined()
    const offered = getToolsForChannel(getChannelCapabilities(channel as never), undefined, undefined, undefined, undefined, undefined, options.toolContext as never).map((tool) => tool.function.name)
    expect(offered).toEqual(expect.arrayContaining(["shepherd_overview", "shepherd_read", "shepherd_signal"]))
    for (const name of ["shepherd_overview", "shepherd_read", "shepherd_signal"]) {
      expect(guardInvocation(name, {}, { readPaths: new Set(), trustLevel: toolContext.context.friend.trustLevel, agentRoot: hoisted.agentRoot })).toEqual({ allowed: true })
    }
  })
})
