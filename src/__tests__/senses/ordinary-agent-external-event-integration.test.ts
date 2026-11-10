import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { DaemonProcessManagerLike } from "../../heart/daemon/daemon"

// An ordinary agent (no tool-profiles.json, no Sanctuary relationship) takes an external event end to end through the
// real daemon, private-runtime worker, turn pipeline and external_event_disposition tool; only the model is scripted.

const mocks = vi.hoisted(() => ({ home: "", create: vi.fn() }))

vi.mock("os", async (original) => ({
  ...await original<typeof import("os")>(),
  homedir: () => {
    if (!mocks.home) throw new Error("fixture home is not initialized")
    return mocks.home
  },
}))
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => {
    if (!mocks.home) throw new Error("fixture home is not initialized")
    return mocks.home
  },
}))
vi.mock("openai", () => {
  class Client {
    chat = { completions: { create: mocks.create } }
  }
  return { default: Client, AzureOpenAI: Client }
})
vi.mock("../../repertoire/mcp-manager", () => ({
  getSharedMcpManager: vi.fn().mockResolvedValue(null),
}))
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/not-a-live-daemon.sock",
  requestPrivateWake: vi.fn().mockResolvedValue(null),
  requestInnerWake: vi.fn().mockResolvedValue(null),
  sendDaemonCommand: vi.fn().mockRejectedValue(new Error("Unexpected external daemon request")),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
}))

interface ModelRequest {
  stream?: boolean
  messages: ChatCompletionMessageParam[]
  tools?: Array<{ function: { name: string } }>
}
interface ToolStep { name: string; args: Record<string, unknown> }

let modelCallSequence = 0

function lastToolText(request: ModelRequest): string {
  const message = request.messages.filter((item) => item.role === "tool").at(-1)
  return typeof message?.content === "string" ? message.content : ""
}

function leaseArguments(request: ModelRequest): Record<string, unknown> {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user" || typeof message.content !== "string") continue
    const recordPath = message.content.match(/recordPath: ("(?:\\.|[^"\\])*")/u)?.[1]
    const generation = message.content.match(/expectedGeneration: ([0-9]+)/u)?.[1]
    const revision = message.content.match(/classifiedRevision: ("(?:\\.|[^"\\])*")/u)?.[1]
    if (recordPath && generation && revision) return { recordPath: JSON.parse(recordPath), expectedGeneration: Number(generation), classifiedRevision: JSON.parse(revision) }
  }
  throw new Error("The real private turn did not render its exact event lease")
}

function modelScript(steps: Array<(request: ModelRequest) => ToolStep>) {
  const requests: ModelRequest[] = []
  mocks.create.mockImplementation((request: ModelRequest) => {
    if (!request.stream) return Promise.resolve({ choices: [{ message: { role: "assistant", content: "ok" } }] })
    requests.push(request)
    const step = steps[requests.length - 1]
    const call = step ? step(request) : { name: "rest", args: {} }
    const callId = `fixture-call-${++modelCallSequence}`
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }
      },
    }
  })
  return requests
}

beforeAll(() => {
  mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-external-event-"))
})

beforeEach(() => {
  mocks.create.mockReset()
  modelCallSequence = 0
})

afterEach(async () => {
  const { resetIdentity } = await import("../../heart/identity")
  const { resetProviderCredentialCache } = await import("../../heart/provider-credentials")
  resetIdentity()
  resetProviderCredentialCache()
  for (const name of ["AgentBundles", ".ouro-cli"]) fs.rmSync(path.join(mocks.home, name), { recursive: true, force: true })
})

afterAll(() => {
  fs.rmSync(mocks.home, { recursive: true, force: true })
})

async function fixture() {
  const { setAgentName, getAgentRoot, getRepoRoot, getAgentBundlesRoot } = await import("../../heart/identity")
  const { cacheProviderCredentialRecords, createProviderCredentialRecord } = await import("../../heart/provider-credentials")
  const { readAgentConfigForAgent } = await import("../../heart/auth/auth-flow")
  const { createPrivateRuntimeWorker } = await import("../../senses/private-runtime-worker")
  const { OuroDaemon } = await import("../../heart/daemon/daemon")
  const { externalEventRecordPath, getExternalEventRoot, readExternalEventRecord } = await import("../../heart/external-events/router")

  setAgentName("plainagent")
  const agentRoot = getAgentRoot()
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.cpSync(path.join(getRepoRoot(), "deploy/unraid/sanctuary.ouro/psyche"), path.join(agentRoot, "psyche"), { recursive: true })
  const agentJson = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), "deploy/unraid/sanctuary.ouro/agent.json"), "utf8"))
  agentJson.humanFacing = { provider: "minimax", model: "MiniMax-M3" }
  agentJson.agentFacing = { provider: "minimax", model: "MiniMax-M3" }
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify(agentJson, null, 2)}\n`)
  expect(fs.existsSync(path.join(agentRoot, "tool-profiles.json"))).toBe(false)
  readAgentConfigForAgent("plainagent", getAgentBundlesRoot())
  cacheProviderCredentialRecords("plainagent", [createProviderCredentialRecord({
    provider: "minimax", credentials: { apiKey: "fixture-only-key" }, config: {}, provenance: { source: "manual" },
  })])

  const worker = createPrivateRuntimeWorker()
  let dispatchIndex = 0
  const dispatch = vi.fn(async (_agent: string, message: Record<string, unknown>) => {
    await worker.handleMessage({ ...message, dispatchId: `fixture-dispatch-${++dispatchIndex}` })
  })
  const startedAt = new Date().toISOString()
  const processManager: DaemonProcessManagerLike = {
    startAutoStartAgents: async () => undefined, stopAll: async () => undefined,
    startAgent: async () => undefined, resetAgentFailureState: () => undefined, dispatchToAgent: dispatch,
    listAgentSnapshots: () => [{ name: "plainagent", channel: "private-runtime", status: "running", pid: null, restartCount: 0, startedAt, lastCrashAt: null, backoffMs: 0 }],
  }
  const daemon = new OuroDaemon({
    socketPath: path.join(mocks.home, "fixture-daemon.sock"), processManager,
    scheduler: { listJobs: () => [], triggerJob: async () => ({ ok: false, message: "No fixture cron jobs" }) },
    healthMonitor: { runChecks: async () => [] },
    router: { send: async () => { throw new Error("Unexpected fixture message routing") }, pollInbox: () => [] },
    bundlesRoot: getAgentBundlesRoot(), externalEventRoot: getExternalEventRoot(),
    privilegedEventSpoolRoot: path.join(mocks.home, "no-privileged-events"),
  })
  const eventPath = externalEventRecordPath(getExternalEventRoot(), { agent: "plainagent", source: "housesitter", eventId: "peer-1" })
  return {
    dispatch,
    submit: () => daemon.handleCommand({
      kind: "external.event.submit", agent: "plainagent", source: "housesitter", eventType: "peer.message", eventId: "peer-1",
      observationRevision: "rev-1", summary: "Housesitter finished the nightly check", evidence: ["all services up"],
    }),
    event: () => readExternalEventRecord(eventPath),
  }
}

describe("an ordinary agent takes external events", () => {
  it("runs the turn with its own tools and records its disposition; owner messages are refused with a way forward", async () => {
    const f = await fixture()
    const requests = modelScript([
      (request) => ({ name: "external_event_disposition", args: { ...leaseArguments(request), classification: "needs_attention", decision: "report", stewardPolicyKind: "none", reason: "Tell Ari.", nextWake: "on_change", owner_message: "Housesitter finished its check." } }),
      (request) => {
        expect(lastToolText(request)).toContain("no owner-decision channel")
        return { name: "external_event_disposition", args: { ...leaseArguments(request), classification: "expected", decision: "silent", stewardPolicyKind: "none", reason: "Routine nightly check; nothing to do.", nextWake: "on_change" } }
      },
      () => ({ name: "rest", args: {} }),
    ])

    const response = await f.submit()

    expect(response, response.error).toMatchObject({ ok: true })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    const advertised = requests[0]!.tools!.map((tool) => tool.function.name)
    expect(advertised).toContain("external_event_disposition")
    expect(advertised).toContain("surface")
    expect(advertised).toContain("a2a_send_message")
    expect(advertised).not.toContain("speak")
    const firstUser = requests[0]!.messages.filter((message) => message.role === "user").map((message) => String(message.content)).join("\n")
    expect(firstUser).toContain("[external events for this agent]")
    expect(f.event()).toMatchObject({
      executionState: "handled", shouldWake: false, attemptCount: 1,
      disposition: { classification: "expected", decision: "silent", nextWake: { kind: "on_change" }, stewardPolicy: { kind: "none" } },
    })
  }, 30_000)
})
