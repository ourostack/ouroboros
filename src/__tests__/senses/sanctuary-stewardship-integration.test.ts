import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ExternalEventInput } from "../../heart/external-events/router"
import type { DaemonProcessManagerLike } from "../../heart/daemon/daemon"
import type { LogEvent } from "../../nerves"
import type { TelegramUpdate } from "../../senses/telegram-client"

const mocks = vi.hoisted(() => ({ home: "", create: vi.fn() }))
let capturedEvents: LogEvent[] = []
let modelCallSequence = 0

vi.mock("os", async (original) => ({
  ...await original<typeof import("os")>(),
  homedir: () => {
    if (!mocks.home) throw new Error("Sanctuary fixture home is not initialized")
    return mocks.home
  },
}))
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => {
    if (!mocks.home) throw new Error("Sanctuary fixture home is not initialized")
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

interface ToolStep {
  name: string
  args: Record<string, unknown>
  advertised?: false
}

function lastToolText(request: ModelRequest): string {
  const message = request.messages.filter((item) => item.role === "tool").at(-1)
  if (!message || typeof message.content !== "string") throw new Error("The model did not receive the preceding real tool result")
  return message.content
}

function leaseArguments(request: ModelRequest): Record<string, unknown> {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user" || typeof message.content !== "string") continue
    const recordPath = message.content.match(/recordPath: ("(?:\\.|[^"\\])*")/u)?.[1]
    const generation = message.content.match(/expectedGeneration: ([0-9]+)/u)?.[1]
    const revision = message.content.match(/classifiedRevision: ("(?:\\.|[^"\\])*")/u)?.[1]
    if (recordPath && generation && revision) return {
      recordPath: JSON.parse(recordPath),
      expectedGeneration: Number(generation),
      classifiedRevision: JSON.parse(revision),
    }
  }
  throw new Error("The real private turn did not render its exact event lease")
}

function modelScript(steps: Array<(request: ModelRequest) => ToolStep>) {
  const calls: ToolStep[] = []
  let retriedFreshWorkRest = false
  mocks.create.mockImplementation((request: ModelRequest) => {
    if (!request.stream) return Promise.resolve({ choices: [{ message: { role: "assistant", content: "ok" } }] })
    const step = steps[calls.length]
    let call: ToolStep
    if (step) call = step(request)
    else if (!retriedFreshWorkRest && calls.at(-1)?.name === "rest" && lastToolText(request).startsWith("fresh work arrived for me this turn")) {
      retriedFreshWorkRest = true
      call = { name: "rest", args: {} }
    } else throw new Error(`Unexpected model continuation after ${calls.length} scripted calls: ${lastToolText(request)}`)
    const advertised = request.tools?.map((tool) => tool.function.name)
    if (call.advertised === false) expect(advertised).not.toContain(call.name)
    else expect(advertised).toContain(call.name)
    calls.push(call)
    const callId = `fixture-call-${++modelCallSequence}`
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { tool_calls: [{
          index: 0, id: callId, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }] } }] }
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }
      },
    }
  })
  return calls
}

beforeAll(() => {
  mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), "a006-stewardship-"))
})

beforeEach(() => {
  mocks.create.mockReset()
  capturedEvents = []
  modelCallSequence = 0
})

afterEach(async ({ task }) => {
  if (task.result?.state === "fail") process.stderr.write(`${JSON.stringify({
    modelCalls: mocks.create.mock.calls.length,
    lastModelInput: mocks.create.mock.calls.at(-1)?.[0]?.messages?.slice(-2),
    deliveryEvents: capturedEvents.filter((event) => /settle|delivery|engine\.loop_/u.test(event.event) || event.level === "error" || event.level === "warn"),
    events: capturedEvents.slice(-15),
  }, null, 2)}\n`)
  const { resetIdentity } = await import("../../heart/identity")
  const { resetProviderCredentialCache } = await import("../../heart/provider-credentials")
  const { resetRuntimeCredentialConfigCache } = await import("../../heart/runtime-credentials")
  const { setRuntimeLogger } = await import("../../nerves/runtime")
  resetIdentity()
  resetProviderCredentialCache()
  resetRuntimeCredentialConfigCache()
  setRuntimeLogger(null)
  vi.unstubAllGlobals()
  for (const name of ["AgentBundles", ".ouro-cli"]) {
    fs.rmSync(path.join(mocks.home, name), { recursive: true, force: true })
  }
})

afterAll(() => {
  fs.rmSync(mocks.home, { recursive: true, force: true })
})

async function fixture(desired = "intentionally_off", grant = true) {
  const { FileFriendStore } = await import("@ouro.bot/friends")
  const { setAgentName, getAgentRoot, getRepoRoot, getAgentBundlesRoot } = await import("../../heart/identity")
  const { cacheProviderCredentialRecords, createProviderCredentialRecord, readCachedProviderCredentialRecord } = await import("../../heart/provider-credentials")
  const { readAgentConfigForAgent } = await import("../../heart/auth/auth-flow")
  const { cacheRuntimeCredentialConfig, cacheMachineRuntimeCredentialConfig } = await import("../../heart/runtime-credentials")
  const { createLogger, createNdjsonFileSink } = await import("../../nerves")
  const { setRuntimeLogger } = await import("../../nerves/runtime")
  const { createRelationshipAuthorizationEvaluator, loadRelationshipCapabilityRegistry } = await import("../../repertoire/relationship-authorization")
  const { readStewardPolicy, readRoutineActionReceipts, updateStewardPolicy } = await import("../../heart/steward-policy")
  const { readCares } = await import("../../arc/cares")
  const { createSanctuaryToolContext } = await import("../../senses/sanctuary-runtime")
  const { createSanctuaryHealthSweep } = await import("../../senses/sanctuary-health")
  const { runSanctuaryHealthHabit } = await import("../../senses/sanctuary-health-runner")
  const { createPrivateRuntimeWorker } = await import("../../senses/private-runtime-worker")
  const { OuroDaemon } = await import("../../heart/daemon/daemon")
  const { externalEventRecordPath, getExternalEventRoot, readExternalEventRecord } = await import("../../heart/external-events/router")

  setAgentName("sanctuary")
  const agentRoot = getAgentRoot()
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.cpSync(path.join(getRepoRoot(), "deploy/unraid/sanctuary.ouro/psyche"), path.join(agentRoot, "psyche"), { recursive: true })
  for (const name of ["agent.json", "tool-profiles.json"]) {
    fs.copyFileSync(path.join(getRepoRoot(), "deploy/unraid/sanctuary.ouro", name), path.join(agentRoot, name))
  }
  readAgentConfigForAgent("sanctuary", getAgentBundlesRoot())
  setRuntimeLogger(createLogger({ sinks: [(event) => capturedEvents.push(event), createNdjsonFileSink(path.join(agentRoot, "fixture-audit.ndjson"))] }))
  cacheProviderCredentialRecords("sanctuary", [createProviderCredentialRecord({
    provider: "minimax", credentials: { apiKey: "fixture-only-key" }, config: {}, provenance: { source: "manual" },
  })])
  cacheRuntimeCredentialConfig("sanctuary", {
    telegramBotToken: "123:fixture-only-token", telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "42",
  })
  cacheMachineRuntimeCredentialConfig("sanctuary", {
    unraidGraphqlUrl: "https://unraid.fixture/graphql", unraidReadApiKey: "fixture-read", unraidWriteApiKey: "fixture-write",
  })
  const provider = readCachedProviderCredentialRecord("sanctuary", "minimax")
  if (!provider.ok) throw new Error(provider.error)
  const store = new FileFriendStore(path.join(agentRoot, "friends"))
  const createdAt = new Date().toISOString()
  await store.put("owner", {
    id: "owner", name: "Ari", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive",
    capabilityProfileId: "sanctuary-owner", externalIds: [{ provider: "telegram-user", externalId: "42", tenantId: "123" }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt, updatedAt: createdAt, schemaVersion: 1,
  })
  const owner = await store.get("owner")
  if (!owner) throw new Error("Fixture owner was not persisted")
  const authorization = createRelationshipAuthorizationEvaluator({
    friend: owner, registry: loadRelationshipCapabilityRegistry(agentRoot), requestId: "fixture-policy-request",
    requestPhase: "inbound", sessionEventId: "fixture-policy-owner-event",
  }).authorizeTool("steward_policy_manage")
  if (!authorization.allowed || authorization.profileId !== "sanctuary-owner" || authorization.profileVersion === undefined) {
    throw new Error("The real profile did not authorize fixture policy setup")
  }
  const actor = {
    friendId: owner.id, trustLevel: "family" as const, sessionEventId: "fixture-policy-owner-event",
    authorization: {
      profileId: authorization.profileId, requestId: "fixture-policy-request", sessionKey: "fixture-owner-session",
      receiptId: authorization.receiptId, profileVersion: authorization.profileVersion,
    },
  }
  updateStewardPolicy(agentRoot, {
    expectedVersion: 0, actor,
    mutation: { kind: "set_desired_state", key: "container:jellyfin", value: desired, provenance: "stated", source: "fixture owner request" },
  })
  if (grant) updateStewardPolicy(agentRoot, {
    expectedVersion: 1, actor,
    mutation: {
      kind: "grant_routine_action", key: "unraid.restart:jellyfin", action: "unraid.container.restart",
      targets: ["jellyfin"], maxCount: 2, windowMs: 1_800_000, verificationRequired: true, exclusions: [],
      provenance: "stated", expiresAt: "2030-01-01T00:00:00.000Z",
    },
  })

  const state = { running: false, mutations: 0, logReads: 0, recoverBeforeTurn: false }
  const sent: Array<Record<string, unknown>> = []
  const telegramUpdates: TelegramUpdate[] = []
  const visibleMessages = new Map<number, { message_id: number; chat: { id: number; type: string }; text: string; date: number }>()
  const graphContainer = () => ({
    id: "Docker:jellyfin", names: ["/jellyfin"], state: state.running ? "RUNNING" : "EXITED",
    status: state.running ? "Up 5 minutes" : "Exited (1) 5 minutes ago", autoStart: true,
  })
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (typeof init?.body !== "string") throw new Error(`Unexpected non-JSON fixture request: ${url}`)
    const body = JSON.parse(init.body)
    if (url === "https://unraid.fixture/graphql") {
      if (body.query.includes("mutation SanctuaryRestart")) {
        expect(body.variables).toEqual({ id: "Docker:jellyfin" })
        state.mutations++
        state.running = true
        return Response.json({ data: { docker: { restart: graphContainer() } } })
      }
      if (body.query.includes("query SanctuaryContainers")) return Response.json({ data: { docker: { containers: [graphContainer()] } } })
      if (body.query.includes("query SanctuaryContainerLogs")) {
        state.logReads++
        return Response.json({ data: { docker: { logs: {
          containerId: "Docker:jellyfin", lines: [{ timestamp: new Date().toISOString(), message: "Fixture process exited." }], cursor: "fixture-cursor",
        } } } })
      }
      throw new Error(`Unexpected fixture Unraid query: ${body.query}`)
    }
    if (url.startsWith("https://api.telegram.org/bot123:fixture-only-token/")) {
      if (url.endsWith("/getUpdates")) return Response.json({ ok: true, result: telegramUpdates.splice(0) })
      if (url.endsWith("/sendMessage")) {
        sent.push(body)
        const message = { message_id: 100 + sent.length, chat: { id: Number(body.chat_id), type: "private" }, text: String(body.text), date: Math.floor(Date.now() / 1_000) }
        visibleMessages.set(message.message_id, message)
        return Response.json({ ok: true, result: message })
      }
      if (url.endsWith("/sendChatAction")) return Response.json({ ok: true, result: true })
      throw new Error(`Unexpected fixture Telegram method: ${url}`)
    }
    throw new Error(`Unexpected external fixture request: ${url}`)
  }))

  const context = createSanctuaryToolContext("sanctuary")
  if (!context.sanctuary) throw new Error("The real Sanctuary runtime was not constructed")
  const sweep = createSanctuaryHealthSweep({
    toolContext: { sanctuary: {
      ...context.sanctuary,
      getStorage: async () => ({ ok: true, data: { array: { state: "STARTED", usedPercent: 40, degraded: false }, shares: [], truncated: false } }),
      getDisks: async () => ({ ok: true, data: { disks: [], parity: { result: "success", ageHours: 1, degraded: false }, truncated: false } }),
      getNotifications: async () => ({ ok: true, data: { unacknowledged: [], truncated: false } }),
    } },
    statePath: path.join(agentRoot, "state/health/sanctuary-health.json"),
    fetch: async () => new Response(null, { status: 204 }),
  })
  const worker = createPrivateRuntimeWorker()
  let dispatchIndex = 0
  const dispatch = vi.fn(async (_agent: string, message: Record<string, unknown>) => {
    if (state.recoverBeforeTurn) {
      state.running = true
      state.recoverBeforeTurn = false
    }
    await worker.handleMessage({ ...message, dispatchId: `fixture-dispatch-${++dispatchIndex}` })
  })
  const processManager: DaemonProcessManagerLike = {
    startAutoStartAgents: async () => undefined, stopAll: async () => undefined,
    startAgent: async () => undefined, resetAgentFailureState: () => undefined, dispatchToAgent: dispatch,
    listAgentSnapshots: () => [{
      name: "sanctuary", channel: "private-runtime", status: "running", pid: null, restartCount: 0,
      startedAt: createdAt, lastCrashAt: null, backoffMs: 0,
    }],
  }
  const daemon = new OuroDaemon({
    socketPath: path.join(mocks.home, "fixture-daemon.sock"), processManager,
    scheduler: { listJobs: () => [], triggerJob: async () => ({ ok: false, message: "No fixture cron jobs" }) },
    healthMonitor: { runChecks: async () => [] },
    router: { send: async () => { throw new Error("Unexpected fixture message routing") }, pollInbox: () => [] },
    bundlesRoot: getAgentBundlesRoot(), externalEventRoot: getExternalEventRoot(),
    privilegedEventSpoolRoot: path.join(mocks.home, "no-privileged-events"),
  })
  const submitEvidence = async (input: ExternalEventInput) => {
    const response = await daemon.handleCommand({ kind: "external.event.submit", ...input })
    expect(response, response.error).toMatchObject({ ok: true })
    const data = response.data
    if (!data || typeof data !== "object" || !("event" in data) || !data.event || typeof data.event !== "object"
      || !("shouldWake" in data.event) || typeof data.event.shouldWake !== "boolean") throw new Error("Daemon did not return a real event receipt")
    return { shouldWake: data.event.shouldWake }
  }
  const eventPath = externalEventRecordPath(getExternalEventRoot(), {
    agent: "sanctuary", source: "sanctuary-health", eventId: "container:Docker:jellyfin:availability",
  })
  const requestHousehold = async (restricted = false) => {
    const { createTelegramSenseApp, createProductionTelegramRelationshipComposition } = await import("../../senses/telegram")
    const { createTelegramLongPoll } = await import("../../senses/telegram-client")
    await store.put("member", {
      ...owner, id: "member", name: "Sam", trustLevel: "friend", initiativePolicy: "request_follow_up_only",
      capabilityProfileId: "sanctuary-household", externalIds: [{ provider: "telegram-user", externalId: "43", tenantId: "123" }],
    })
    if (restricted) {
      const registry = loadRelationshipCapabilityRegistry(agentRoot)
      const profile = registry.profiles["sanctuary-household"]
      if (!profile) throw new Error("The package is missing its household profile")
      fs.writeFileSync(path.join(agentRoot, "tool-profiles.json"), JSON.stringify({
        ...registry, profiles: {
          ...registry.profiles,
          "sanctuary-household": { ...profile, version: profile.version + 1, toolNames: profile.toolNames.filter((name) => name !== "unraid_restart_container") },
        },
      }))
    }
    const credentials = { botToken: "123:fixture-only-token", botId: "123", authorizedUserId: "42", authorizedChatId: "42" }
    telegramUpdates.push({
      update_id: 1,
      message: { message_id: 1, from: { id: 43, first_name: "Sam" }, chat: { id: 43, type: "private" }, text: "Please restart Jellyfin." },
    })
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials,
      ...await createProductionTelegramRelationshipComposition("sanctuary", credentials),
      createLongPoll: (options) => {
        const poll = createTelegramLongPoll(options)
        return { ...poll, run: async (signal) => { await poll.pollOnce(signal) } }
      },
      _createInteractiveControl: () => ({
        socketPath: path.join(mocks.home, "fixture-control.sock"),
        start: async () => undefined, stop: async () => undefined,
      }),
    })
    try { await app.run() } finally { await app.stop() }
  }
  return {
    agentRoot, state, sent, dispatch, requestHousehold,
    visibleMessages: () => [...visibleMessages.values()],
    runHealth: async () => {
      const eventStart = capturedEvents.length
      const dispatchStart = dispatch.mock.calls.length
      const result = await runSanctuaryHealthHabit("sanctuary", { createSweep: () => sweep, submitEvidence })
      const events = capturedEvents.slice(eventStart)
      const lifecycles = events.filter((event) => event.event === "heart.run_ledger_recorded" && event.meta?.senseOrHabit === "external-event")
        .map((event) => event.meta?.lifecycle)
      expect(lifecycles).toEqual(Array.from({ length: dispatch.mock.calls.length - dispatchStart }, () => ["started", "completed"]).flat())
      expect(events.filter((event) => event.event === "engine.error")).toEqual([])
      return result
    },
    event: () => readExternalEventRecord(eventPath),
    receipts: () => readRoutineActionReceipts(agentRoot),
    policy: () => readStewardPolicy(agentRoot),
    cares: () => readCares(agentRoot),
  }
}

describe("A-006 real Sanctuary stewardship composition", () => {
  it("keeps intentional downtime silent and does not dispatch another turn for unchanged facts", async () => {
    const f = await fixture()
    let policyVersion = 0
    const calls = modelScript([
      () => ({ name: "steward_policy_manage", args: { action: "read" } }),
      (request) => {
        const policy = JSON.parse(lastToolText(request))
        expect(policy.desiredStates["container:jellyfin"].value).toBe("intentionally_off")
        policyVersion = policy.version
        return { name: "unraid_restart_container", args: { container: "jellyfin" } }
      },
      (request) => ({
        name: "external_event_disposition", args: {
          ...leaseArguments(request), classification: "expected", decision: "silent",
          stewardPolicyKind: "current", stewardPolicyKey: "container:jellyfin", stewardPolicyVersion: policyVersion,
          reason: "Jellyfin is intentionally off.", nextWake: "on_change",
        },
      }),
      () => ({ name: "rest", args: {} }),
    ])
    await f.runHealth()
    expect(calls.filter((call) => call.name !== "rest").map((call) => call.name)).toEqual([
      "steward_policy_manage", "unraid_restart_container", "external_event_disposition",
    ])
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.state.mutations).toBe(0)
    expect(f.receipts()).toEqual([])
    expect(f.sent).toEqual([])
    expect(f.event()).toMatchObject({
      executionState: "handled", shouldWake: false,
      disposition: {
        classification: "expected", decision: "silent", nextWake: { kind: "on_change" },
        stewardPolicy: { kind: "current", key: "container:jellyfin", version: f.policy().version },
      },
    })
    const completedModelCalls = mocks.create.mock.calls.length
    await f.runHealth()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.create).toHaveBeenCalledTimes(completedModelCalls)
    expect(f.state.mutations).toBe(0)
    expect(f.sent).toEqual([])
  }, 30_000)

  it("gives a valid outage's private turn real action and verification references for its disposition", async () => {
    const f = await fixture("expected_on")
    let policyVersion = 0
    let restartText = ""
    modelScript([
      () => ({ name: "steward_policy_manage", args: { action: "read" } }),
      (request) => {
        policyVersion = JSON.parse(lastToolText(request)).version
        return { name: "unraid_restart_container", args: { container: "jellyfin" } }
      },
      (request) => {
        restartText = lastToolText(request)
        const result = restartText.startsWith("{") ? JSON.parse(restartText) : null
        const data = result?.ok === true ? result.data : undefined
        return {
          name: "external_event_disposition", args: {
            ...leaseArguments(request), classification: data ? "resolved" : "needs_attention", decision: data ? "act" : "silent",
            stewardPolicyKind: "current", stewardPolicyKey: "unraid.restart:jellyfin", stewardPolicyVersion: policyVersion,
            reason: data ? "Jellyfin is back up; I restarted it and confirmed it is running." : "The restart did not complete.",
            nextWake: "on_change", actionRefs: data?.actionRefs, verificationRefs: data?.verificationRefs,
          },
        }
      },
      () => ({ name: "rest", args: {} }),
    ])
    await f.runHealth()
    expect(f.state.mutations, restartText).toBe(1)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.sent).toEqual([])
    expect(f.receipts()).toHaveLength(1)
    const [receipt] = f.receipts()
    expect(receipt).toMatchObject({ state: "verified", verifiedAfterState: "running", effectReceipt: expect.any(String) })
    expect(JSON.parse(restartText)).toMatchObject({
      ok: true, data: { actionRefs: [receipt.id], verificationRefs: [receipt.id] },
    })
    expect(f.event()).toMatchObject({
      executionState: "handled", shouldWake: false,
      disposition: { classification: "resolved", decision: "act", actionRefs: [receipt.id], verificationRefs: [receipt.id] },
    })
  }, 30_000)

  it("does not let an on-demand health event act or ask for approval", async () => {
    const f = await fixture("on_demand")
    let policyVersion = 0
    modelScript([
      () => ({ name: "steward_policy_manage", args: { action: "read" } }),
      (request) => {
        const policy = JSON.parse(lastToolText(request))
        expect(policy.desiredStates["container:jellyfin"].value).toBe("on_demand")
        policyVersion = policy.version
        return { name: "unraid_restart_container", args: { container: "jellyfin" } }
      },
      (request) => ({
        name: "external_event_disposition", args: {
          ...leaseArguments(request), classification: "expected", decision: "silent",
          stewardPolicyKind: "current", stewardPolicyKey: "container:jellyfin", stewardPolicyVersion: policyVersion,
          reason: "Jellyfin is only needed when someone asks for it.", nextWake: "on_change",
        },
      }),
      () => ({ name: "rest", args: {} }),
    ])
    await f.runHealth()
    expect(f.state.mutations).toBe(0)
    expect(f.receipts()).toEqual([])
    expect(f.sent).toEqual([])
    expect(f.event()).toMatchObject({ executionState: "handled", disposition: { classification: "expected", decision: "silent" } })
    await f.runHealth()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.sent).toEqual([])
  }, 30_000)

  it("quietly closes a stopped observation that recovered before its private turn", async () => {
    const f = await fixture("expected_on")
    f.state.recoverBeforeTurn = true
    let policyVersion = 0
    modelScript([
      () => ({ name: "steward_policy_manage", args: { action: "read" } }),
      (request) => {
        policyVersion = JSON.parse(lastToolText(request)).version
        return { name: "unraid_restart_container", args: { container: "jellyfin" } }
      },
      (request) => ({
        name: "external_event_disposition", args: {
          ...leaseArguments(request), classification: "resolved", decision: "silent",
          stewardPolicyKind: "current", stewardPolicyKey: "container:jellyfin", stewardPolicyVersion: policyVersion,
          reason: "Jellyfin already recovered, so I left it alone.", nextWake: "on_change",
        },
      }),
      () => ({ name: "rest", args: {} }),
    ])
    await f.runHealth()
    expect(f.state.running).toBe(true)
    expect(f.state.mutations).toBe(0)
    expect(f.sent).toEqual([])
    expect(f.receipts()).toEqual([])
    expect(f.event()).toMatchObject({ executionState: "handled", disposition: { classification: "resolved", decision: "silent" } })
  }, 30_000)

  it("keeps a missing grant non-approvable and sends one useful owner question through the real effect path", async () => {
    const f = await fixture("expected_on", false)
    const question = "Jellyfin is down. I checked its recent logs but do not have permission to restart it automatically. Would you like me to keep it running?"
    let policyVersion = 0
    const calls = modelScript([
      () => ({ name: "steward_policy_manage", args: { action: "read" } }),
      (request) => {
        policyVersion = JSON.parse(lastToolText(request)).version
        return { name: "unraid_restart_container", args: { container: "jellyfin" } }
      },
      () => ({ name: "unraid_get_container_logs", args: { container: "jellyfin", tailLines: 20 } }),
      (request) => ({
        name: "external_event_disposition", args: {
          ...leaseArguments(request), classification: "needs_attention", decision: "ask",
          stewardPolicyKind: "current", stewardPolicyKey: "container:jellyfin", stewardPolicyVersion: policyVersion,
          reason: question, nextWake: "on_change",
        },
      }),
      () => ({ name: "rest", args: {} }),
    ])
    await f.runHealth()
    expect(f.state.mutations).toBe(0)
    expect(f.state.logReads).toBe(1)
    expect(f.receipts()).toEqual([])
    expect(f.sent).toEqual([expect.objectContaining({ chat_id: "42", text: question })])
    expect(f.sent[0]).not.toHaveProperty("reply_markup")
    expect(f.event()).toMatchObject({
      executionState: "handled", disposition: { classification: "needs_attention", decision: "ask", reason: question },
    })
    expect(calls.filter((call) => call.name !== "rest")).toHaveLength(4)
    await f.runHealth()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.sent).toHaveLength(1)
  }, 30_000)

  it.each([
    { label: "on-demand standing grant", desired: "on_demand", grant: true, restricted: false, allowed: true },
    { label: "missing grant", desired: "expected_on", grant: false, restricted: false, allowed: false },
    { label: "current profile exclusion", desired: "expected_on", grant: true, restricted: true, allowed: false },
  ])("returns the household $label outcome to that exact requester without an approval card", async ({ desired, grant, restricted, allowed }) => {
    const f = await fixture(desired, grant)
    const success = "Jellyfin is back up. I restarted it and confirmed it is running."
    const denied = "I need permission before I can restart Jellyfin for you."
    const calls = modelScript([
      () => ({ name: "unraid_list_containers", args: {} }),
      () => ({ name: "unraid_restart_container", args: { container: "jellyfin" }, advertised: restricted ? false : undefined }),
      (request) => {
        const text = lastToolText(request)
        const succeeded = text.startsWith("{") && JSON.parse(text).ok === true
        return { name: "settle", args: { answer: succeeded ? success : denied, intent: succeeded ? "complete" : "blocked" } }
      },
    ])
    await f.requestHousehold(restricted)
    expect(calls.map((call) => call.name)).toEqual(["unraid_list_containers", "unraid_restart_container", "settle"])
    expect(f.state.mutations).toBe(allowed ? 1 : 0)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).not.toHaveProperty("reply_markup")
    expect(f.visibleMessages()).toEqual([expect.objectContaining({ chat: { id: 43, type: "private" }, text: allowed ? success : denied })])
    if (allowed) {
      expect(f.receipts()).toEqual([expect.objectContaining({
        state: "verified", verifiedAfterState: "running",
        requester: expect.objectContaining({ kind: "household_request", friendId: "member", origin: { friendId: "member", channel: "telegram", key: "telegram:123:43" } }),
      })])
    } else {
      expect(f.receipts()).toEqual([])
    }
  }, 30_000)

  it("diagnoses the third outage in the same turn, adopts one Care, and reports once after two real recoveries", async () => {
    const f = await fixture("expected_on")
    for (const attempt of [1, 2]) {
      f.state.running = false
      let policyVersion = 0
      const recovery = modelScript([
        () => ({ name: "steward_policy_manage", args: { action: "read" } }),
        (request) => {
          policyVersion = JSON.parse(lastToolText(request)).version
          return { name: "unraid_restart_container", args: { container: "jellyfin" } }
        },
        (request) => {
          const result = JSON.parse(lastToolText(request))
          expect(result).toMatchObject({ ok: true, data: { observedRestart: true, afterState: "running" } })
          return { name: "external_event_disposition", args: {
            ...leaseArguments(request), classification: "resolved", decision: "act",
            stewardPolicyKind: "current", stewardPolicyKey: "unraid.restart:jellyfin", stewardPolicyVersion: policyVersion,
            reason: "Jellyfin is back up after a verified restart.", nextWake: "on_change",
            actionRefs: result.data.actionRefs, verificationRefs: result.data.verificationRefs,
          } }
        },
        () => ({ name: "rest", args: {} }),
      ])
      await f.runHealth()
      expect(recovery.filter((call) => call.name !== "rest")).toHaveLength(3)
      expect(f.state.mutations).toBe(attempt)
      expect(f.receipts()).toHaveLength(attempt)
      expect(f.event()).toMatchObject({ executionState: "handled", disposition: { classification: "resolved", decision: "act" } })

      const healthy = modelScript([
        () => ({ name: "steward_policy_manage", args: { action: "read" } }),
        (request) => {
          policyVersion = JSON.parse(lastToolText(request)).version
          return { name: "unraid_list_containers", args: {} }
        },
        (request) => {
          expect(JSON.parse(lastToolText(request))).toMatchObject({ ok: true, data: { containers: [expect.objectContaining({ name: "jellyfin", state: "running" })] } })
          return { name: "external_event_disposition", args: {
            ...leaseArguments(request), classification: "resolved", decision: "silent",
            stewardPolicyKind: "current", stewardPolicyKey: "container:jellyfin", stewardPolicyVersion: policyVersion,
            reason: "Jellyfin is running, so no further action is needed.", nextWake: "on_change",
          } }
        },
        () => ({ name: "rest", args: {} }),
      ])
      await f.runHealth()
      expect(healthy.filter((call) => call.name !== "rest")).toHaveLength(3)
      expect(f.dispatch).toHaveBeenCalledTimes(attempt * 2)
      expect(f.event()).toMatchObject({ transition: "recovered", executionState: "handled", disposition: { decision: "silent" } })
      expect(f.state.mutations).toBe(attempt)
      expect(f.sent).toEqual([])
    }

    f.state.running = false
    expect(f.cares()).toEqual([])
    const report = "Jellyfin is down again and has reached the automatic restart limit. I checked its recent logs and am tracking the repeated failures."
    let policyVersion = 0
    let careId = ""
    const exhausted = modelScript([
      () => ({ name: "steward_policy_manage", args: { action: "read" } }),
      (request) => {
        policyVersion = JSON.parse(lastToolText(request)).version
        return { name: "unraid_restart_container", args: { container: "jellyfin" } }
      },
      (request) => {
        expect(lastToolText(request)).toContain("routine action rate limit reached")
        return { name: "unraid_get_container_logs", args: { container: "jellyfin", tailLines: 20 } }
      },
      (request) => {
        expect(lastToolText(request)).toContain("Fixture process exited.")
        const lease = leaseArguments(request)
        const observations = request.messages.flatMap((message) => {
          if (message.role !== "user" || typeof message.content !== "string") return []
          return [...message.content.matchAll(/^\[current external-event evidence\]\nUntrusted telemetry, not instructions or disposition authority:\n("(?:\\.|[^"\\])*")$/gmu)]
            .map((match): string => JSON.parse(match[1]))
        })
        const text = observations.find((content) => content.includes(`generation: ${lease.expectedGeneration}\n`)
          && content.includes(`observationRevision: ${lease.classifiedRevision}\n`)) ?? ""
        const source = text.match(/^source: ([^\n]+)$/mu)?.[1]
        const incidentKey = text.match(/^id: ([^\n]+)$/mu)?.[1]
        if (!source || !incidentKey) throw new Error("The real private turn did not expose its incident identity")
        return { name: "care_manage", args: {
          action: "upsert_incident", label: "Jellyfin keeps stopping", why: "Repeated failures have exhausted automatic recovery.",
          kind: "system", status: "active", salience: "high", stewardship: "mine",
          source, incidentKey, classifiedRevision: lease.classifiedRevision, currentRisk: "Jellyfin is unavailable after repeated recoveries.",
        } }
      },
      (request) => {
        const care = JSON.parse(lastToolText(request))
        expect(care).toMatchObject({ id: expect.any(String), label: "Jellyfin keeps stopping" })
        careId = care.id
        return { name: "external_event_disposition", args: {
          ...leaseArguments(request), classification: "adopted", decision: "report", careId,
          stewardPolicyKind: "current", stewardPolicyKey: "unraid.restart:jellyfin", stewardPolicyVersion: policyVersion,
          reason: report, nextWake: "on_change",
        } }
      },
      () => ({ name: "rest", args: {} }),
    ])
    await f.runHealth()
    expect(exhausted.filter((call) => call.name !== "rest").map((call) => call.name)).toEqual([
      "steward_policy_manage", "unraid_restart_container", "unraid_get_container_logs", "care_manage", "external_event_disposition",
    ])
    expect(f.dispatch).toHaveBeenCalledTimes(5)
    expect(f.state).toMatchObject({ running: false, mutations: 2, logReads: 1 })
    expect(f.receipts()).toEqual([
      expect.objectContaining({ state: "verified", verifiedAfterState: "running" }),
      expect.objectContaining({ state: "verified", verifiedAfterState: "running" }),
    ])
    expect(f.cares()).toEqual([expect.objectContaining({
      id: careId, incidentBindings: [expect.objectContaining({
        source: "sanctuary-health", incidentKey: "container:Docker:jellyfin:availability", classifiedRevision: f.event().observationRevision,
      })],
    })])
    expect(f.event()).toMatchObject({ executionState: "handled", disposition: { classification: "adopted", decision: "report", careId } })
    expect(f.sent).toEqual([expect.objectContaining({ chat_id: "42", text: report })])
    expect(f.sent[0]).not.toHaveProperty("reply_markup")
    const completedCalls = exhausted.length
    await f.runHealth()
    expect(f.dispatch).toHaveBeenCalledTimes(5)
    expect(exhausted).toHaveLength(completedCalls)
    expect(f.state.mutations).toBe(2)
    expect(f.receipts()).toHaveLength(2)
    expect(f.cares()).toHaveLength(1)
    expect(f.sent).toHaveLength(1)
  }, 90_000)
})
