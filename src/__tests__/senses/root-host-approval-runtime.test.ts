import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getChannelCapabilities, type FriendRecord } from "@ouro.bot/friends"
import { buildCanonicalSessionEnvelope } from "../../heart/session-events"
import { readSessionTransaction, withSessionTurnLease } from "../../mind/session-transaction"
import { getSenseSessionPath } from "../../senses/shared-turn"
import { createRelationshipAuthorizationEvaluator, loadRelationshipCapabilityRegistry } from "../../repertoire/relationship-authorization"
import { authorizeRootHostContext } from "../../repertoire/tools-sanctuary-host"
import { selectToolsForChannel, preflightToolCall } from "../../repertoire/tools"
import type { ToolContext } from "../../repertoire/tools-base"
import type { RootHostApprovalPort } from "../../senses/root-host-approval-port"
import { createRootHostApprovalRuntime, FileRootHostPendingApprovalStore, classifyRootHostPendingApproval } from "../../senses/root-host-approval-runtime"
import { digestApprovalSuspensionCheckpointPayload, digestApprovalToolDefinition } from "../../heart/tool-approval"
import { digestJson } from "../../repertoire/tool-arguments"
import { resolveToolDefinition } from "../../repertoire/tools"
import * as core from "../../heart/core"
import * as mcpManager from "../../repertoire/mcp-manager"
import * as tools from "../../repertoire/tools"
import { RootHostAuthorizationError } from "../../repertoire/tools-sanctuary-host"

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof fs>() }))

const roots: string[] = []
const hash = "a".repeat(64)
function rehash(record: any) {
  record.checkpoint.approvalId = record.approvalId
  record.checkpoint.preCallDigest = digestJson(record.checkpoint.preCallMessages)
  record.checkpoint.checkpointDigest = digestApprovalSuspensionCheckpointPayload(record.checkpoint)
  return record
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

async function fixture() {
  const root = path.resolve(".s5-runtime-tests", randomUUID())
  roots.push(root)
  const agentRoot = path.join(root, "sanctuary.ouro")
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.copyFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", path.join(agentRoot, "tool-profiles.json"))
  const friend: FriendRecord = {
    id: "owner", name: "Owner", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive", capabilityProfileId: "sanctuary-owner",
    externalIds: [{ provider: "telegram-user", tenantId: "123456", externalId: "42", linkedAt: new Date().toISOString() }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "", updatedAt: "", schemaVersion: 1,
  }
  const sessionKey = "telegram:123456:42"
  const requestId = "telegram-inbound:request"
  const sessionPath = getSenseSessionPath("sanctuary", friend.id, "telegram", sessionKey, agentRoot)
  const messages = [{ role: "user" as const, content: "run id" }]
  const envelope = buildCanonicalSessionEnvelope({
    existing: null, previousMessages: [], currentMessages: messages, trimmedMessages: messages,
    currentIngressRelations: [{ replyToEventId: null, threadRootEventId: null, references: [requestId] }],
    recordedAt: new Date().toISOString(), projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
  }).envelope
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.writeFileSync(sessionPath, JSON.stringify(envelope))
  const args = { targetHost: "sanctuary", targetResource: "host", command: { kind: "executable", executable: "/usr/bin/id", arguments: ["-u"] }, workingDirectoryProfile: "host.root.v1", environmentProfile: "host.clean.v1", timeoutMs: 1000 }
  const registration = {
    registrationId: `hostreg-${"a".repeat(43)}`, telegramMessageId: 501, expiresAt: new Date(Date.now() + 300_000).toISOString(),
    registration: { schemaVersion: 1, domain: "ouro.sanctuary.host-registration.v1", keyId: "issuer", signature: "signed-by-root", payload: { ...args, verification: null } },
  }
  let status: any = { state: "committed", execution: "terminal", statusDigest: `sha256:${hash}` }
  const port = {
    pins: { expectedTargetHost: "sanctuary", expectedBotId: "123456", expectedOwnerUserId: "42", expectedOwnerChatId: "42", expectedKeyId: "issuer", expectedPublicKeyDigest: `sha256:${hash}` },
    refresh: vi.fn(async () => true), isHealthy: vi.fn(() => true), acceptsObservation: vi.fn(() => true),
    register: vi.fn(async () => registration), status: vi.fn(async () => status),
    execute: vi.fn(async () => { status = terminal() }),
    callbackForUpdate: vi.fn(() => ({ handled: true, registrationId: registration.registrationId })),
  } as unknown as RootHostApprovalPort
  const observation = { observationDigest: `sha256:${hash}`, updateId: 10, userId: "42", chatId: "42", messageId: "110", keyId: "issuer", publicKeyDigest: `sha256:${hash}`, targetHost: "sanctuary" } as any
  const relationship = () => createRelationshipAuthorizationEvaluator({ friend, registry: loadRelationshipCapabilityRegistry(agentRoot), requestId, sessionEventId: envelope.events[0]!.id })
  const ctx: ToolContext = {
    signin: async () => undefined, agentName: "sanctuary", agentRoot, context: { friend, channel: getChannelCapabilities("telegram") },
    friendStore: { get: vi.fn(async () => friend) } as any,
    currentSession: { friendId: friend.id, channel: "telegram", key: sessionKey, sessionPath },
    relationshipAuthorization: { ...relationship(), requestId, authorizeTool: (name) => relationship().authorizeTool(name) },
    rootHost: { port, observation },
  }
  const capabilities = new Set<any>(["approval-continuation"])
  const select = () => selectToolsForChannel(getChannelCapabilities("telegram"), undefined, undefined, capabilities, undefined, undefined, ctx)
  await authorizeRootHostContext(ctx)
  Object.assign(ctx, { toolSelection: select(), selectCurrentTools: select })
  const provider = vi.fn(async (input: any[], callbacks: any) => { input.push({ role: "assistant", content: "root says 0" }); callbacks.onTextChunk("root says 0"); return { outcome: "settled" as const } })
  const deliver = vi.fn(async () => undefined)
  const resolveContext = vi.fn(async () => ({ ...ctx, rootHost: { port } }))
  const dependencies = { runProvider: provider as any, getProviderRuntime: vi.fn(async () => ({ capabilities, model: "fixture" } as any)), getMcp: vi.fn(async () => null as any) }
  const runtime = (effectBarrier?: () => void) => createRootHostApprovalRuntime({ agentRoot, port, resolveContext, deliver, effectBarrier, dependencies })
  const value = runtime()
  const frozen = { role: "assistant" as const, content: null, tool_calls: [{ id: "call-host", type: "function" as const, function: { name: "sanctuary_host_execute", arguments: JSON.stringify(args) } }] }
  const definition = resolveToolDefinition("sanctuary_host_execute", ctx.toolSelection)!
  const schemaDigest = digestJson(definition.tool.function.parameters as any)
  const policyId = "sanctuary.host.owner-approved.v1"
  const actionClass = "owner_approved_arbitrary_host"
  const request: any = { toolCall: structuredClone(frozen.tool_calls[0]), arguments: args, preCallMessages: messages, frozenAssistantMessage: frozen, schemaDigest, toolDigest: digestApprovalToolDefinition(definition, schemaDigest, policyId), policyDigest: digestJson({ policyId, actionClass, classification: "required" }), policyId, actionClass, liveToolContext: ctx }
  const propose = () => withSessionTurnLease(sessionPath, (lease) => value.coordinator({ sessionPath, baseSessionRevision: readSessionTransaction(sessionPath, lease).revision }).propose(request))
  const store = new FileRootHostPendingApprovalStore(agentRoot)
  function terminal(state = "verified") {
    const pending = store.list()[0]!
    const b = pending.binding
    return {
      state: "executed", execution: "terminal", statusDigest: `sha256:${hash}`,
      permit: { payload: { registrationId: pending.registration.registrationId, residentFriendId: b.friendId, relationshipProfileId: b.profileId, relationshipProfileVersion: b.profileVersion, requestId: b.requestId, sessionKey: b.sessionKey, sessionEventId: b.sessionEventId, residentApprovalId: pending.approvalId, stewardPolicy: null } },
      receipt: { schemaVersion: 1, domain: "ouro.sanctuary.host-receipt.v1", keyId: "issuer", signature: "root-receipt", payload: { state, stdoutExcerpt: "0\n", cleanup: "cgroup_empty" } },
    }
  }
  return { root, agentRoot, ctx, friend, args, value, runtime, port, provider, deliver, resolveContext, registration, store, request, propose, terminal, dependencies, capabilities, setStatus: (next: any) => { status = next }, sessionPath }
}

describe("separate root host approval continuation", () => {
  it.each([false, true])("refreshes health after slow dependency initialization and preserves transient failure: %s", async (unavailable) => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    let clock = Date.now()
    let healthyAt = clock
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    vi.mocked(f.port.isHealthy).mockImplementation(() => clock - healthyAt < 30_000)
    vi.mocked(f.port.refresh).mockImplementation(async () => { healthyAt = clock; return true })
    f.dependencies.getMcp.mockImplementation(async () => { clock += 31_000; return null })
    if (unavailable) vi.mocked(f.port.refresh).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await f.value.recover()
    if (unavailable) {
      expect(f.store.list()[0]!.continuationState).toBe("pending")
      expect(f.provider).not.toHaveBeenCalled()
      await f.value.recover()
    }
    expect(f.provider).toHaveBeenCalledOnce()
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })
  it("recovers an approved but never-attempted request after transient callback-time health failure", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
    vi.mocked(f.port.refresh).mockResolvedValueOnce(false)
    expect(await f.value.handleUpdate({ update_id: 11 } as any)).toBe(true)
    expect(f.port.execute).not.toHaveBeenCalled()
    await f.runtime().recover()
    expect(f.port.execute).toHaveBeenCalledOnce()
    expect(f.provider).toHaveBeenCalledOnce()
    await f.runtime().recover()
    expect(f.port.execute).toHaveBeenCalledOnce()
  })
  it.each([false, true])("distinguishes preflight dependency failure from a verified denial: %s", async (denied) => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    vi.spyOn(tools, "preflightToolCall").mockResolvedValueOnce({ kind: "rejected_before_handler", text: "unavailable", error: denied ? new RootHostAuthorizationError("denied") : new Error("transport unavailable") })
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe(denied ? "complete" : "pending")
  })
  it("keeps the default coordinator host-only when no ordinary coordinator is supplied", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    f.provider.mockImplementation(async (_messages, _callbacks, _channel?: any, _signal?: any, options?: any) => {
      await expect(options.approvalCoordinator.propose({ toolCall: { type: "function", function: { name: "ordinary" } } })).rejects.toThrow()
      return { outcome: "settled" } as any
    })
    await f.value.recover()
    expect(f.provider).toHaveBeenCalledOnce()
  })
  it.each(["health", "provider", "mcp"])("retains an unattempted terminal continuation after transient %s failure", async (dependency) => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    if (dependency === "health") vi.mocked(f.port.refresh).mockResolvedValueOnce(false)
    if (dependency === "provider") f.dependencies.getProviderRuntime.mockRejectedValueOnce(new Error("provider unavailable"))
    if (dependency === "mcp") f.dependencies.getMcp.mockRejectedValueOnce(new Error("MCP unavailable"))
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe("pending")
    await f.value.recover()
    expect(f.provider).toHaveBeenCalledOnce()
    expect(f.port.execute).not.toHaveBeenCalled()
  })

  it("retains materialization when the final provider revalidation is temporarily unavailable", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    f.dependencies.getProviderRuntime.mockResolvedValueOnce({ capabilities: f.capabilities, model: "fixture" }).mockRejectedValueOnce(new Error("provider unavailable"))
    await f.value.recover()
    expect(f.store.list()[0]!.continuationState).toBe("materialized")
    expect(f.provider).not.toHaveBeenCalled()
    await f.value.recover()
    expect(f.provider).toHaveBeenCalledOnce()
  })

  it("routes a resumed ordinary approval through the shared factory at the materialized session revision", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    const ordinary = { toolCall: { type: "function", function: { name: "unraid_restart_container" } } }
    const propose = vi.fn(async () => ({ approvalId: "ordinary-next", checkpointDigest: hash, suspendedSessionRevision: hash }))
    const factory = vi.fn(() => ({ propose }))
    const runtime = createRootHostApprovalRuntime({ agentRoot: f.agentRoot, port: f.port, resolveContext: f.resolveContext, deliver: f.deliver, dependencies: f.dependencies, approvalCoordinatorFactory: factory })
    f.provider.mockImplementation(async (_messages, _callbacks, _channel?: any, _signal?: any, options?: any) => {
      await options.approvalCoordinator.propose(ordinary)
      return { outcome: "suspended" } as any
    })
    await runtime.recover()
    expect(propose).toHaveBeenCalledWith(ordinary)
    expect(factory.mock.calls[0]![0].baseSessionRevision).toBe(f.store.list()[0]!.materializedSessionRevision)
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })
  it("strictly validates every persisted record and rejects duplicate IDs on read", async () => {
    const f = await fixture()
    await f.propose()
    const original = f.store.list()[0]!
    const malformed = [
      null, [], { ...original, extra: "unknown" }, { ...original, schemaVersion: 2 },
      { ...original, executionRequested: "true" }, { ...original, reconciliationRequired: 1 },
      { ...original, continuationState: "unknown" }, { ...original, rootStatusDigest: 0 },
      { ...original, materializedSessionRevision: "invalid" },
      { ...original, continuationState: "materialized" },
      { ...original, registration: { ...original.registration, decisionToken: "forbidden" } },
      { ...original, registration: { ...original.registration, registrationId: "unknown" } },
      { ...original, registration: { ...original.registration, telegramMessageId: -1 } },
      { ...original, registration: { ...original.registration, expiresAt: "not-a-date" } },
      { ...original, registration: { ...original.registration, registration: [] } },
      { ...original, binding: { ...original.binding, extra: "unknown" } },
      { ...original, binding: { ...original.binding, profileId: "household" } },
      { ...original, binding: { ...original.binding, profileVersion: 8 } },
      { ...original, binding: { ...original.binding, friendId: "" } },
      { ...original, binding: { ...original.binding, friendId: "a".repeat(4097) } },
      { ...original, checkpoint: { ...original.checkpoint, unknown: true } },
      { ...original, checkpoint: { ...original.checkpoint, approvalId: "other" } },
      { ...original, checkpoint: { ...original.checkpoint, preCallMessages: null } },
      { ...original, checkpoint: { ...original.checkpoint, schemaDigest: 7 } },
      { ...original, checkpoint: { ...original.checkpoint, preCallDigest: "b".repeat(64) } },
      { ...original, checkpoint: { ...original.checkpoint, checkpointDigest: "b".repeat(64) } },
    ]
    for (const record of malformed) {
      expect(() => classifyRootHostPendingApproval(record)).toThrow()
      fs.writeFileSync(f.store.filePath, JSON.stringify({ schemaVersion: 1, records: [record] }))
      expect(() => f.store.list()).toThrow()
    }
    for (const envelope of [null, [], {}, { schemaVersion: 2, records: [] }, { schemaVersion: 1, records: {} },
      { schemaVersion: 1, records: [], unknown: true },
      { schemaVersion: 1, records: [original, original] },
      { schemaVersion: 1, records: [original, rehash({ ...structuredClone(original), approvalId: `root-host-${randomUUID()}` })] }]) {
      fs.writeFileSync(f.store.filePath, JSON.stringify(envelope))
      expect(() => f.store.list()).toThrow()
    }
    fs.writeFileSync(f.store.filePath, JSON.stringify({ schemaVersion: 1, records: [] }))
    expect(f.store.list()).toEqual([])
  })

  it("rejects malformed frozen calls even when their checkpoint digest is recomputed", async () => {
    const f = await fixture()
    await f.propose()
    const original = f.store.list()[0]!
    const call = (original.checkpoint.frozenAssistantMessage.tool_calls as any[])[0]
    const assistants = [null, [], { role: "assistant" }, { role: "assistant", tool_calls: [] },
      { role: "user", tool_calls: [call] },
      { role: "assistant", tool_calls: [{ ...call, extra: "field" }] },
      { role: "assistant", tool_calls: [{ ...call, type: "custom" }] },
      { role: "assistant", tool_calls: [{ ...call, function: { ...call.function, extra: "field" } }] },
      { role: "assistant", tool_calls: [{ ...call, function: { ...call.function, name: "shell" } }] },
      { role: "assistant", tool_calls: [{ ...call, function: { ...call.function, arguments: 1 } }] },
      { role: "assistant", tool_calls: [{ ...call, function: { ...call.function, arguments: "{" } }] }]
    for (const frozen of assistants) {
      const record = structuredClone(original)
      record.checkpoint.frozenAssistantMessage = frozen as any
      rehash(record)
      expect(() => classifyRootHostPendingApproval(record)).toThrow()
    }
  })

  it("preserves immutable identity/checkpoint evidence and clone isolation across updates", async () => {
    const f = await fixture()
    await f.propose()
    const original = f.store.list()[0]!
    for (const field of ["registration", "binding", "checkpoint"]) {
      const record = structuredClone(original)
      if (field === "registration") record.registration.telegramMessageId += 1
      if (field === "binding") (record.binding as any).requestId = "other"
      if (field === "checkpoint") { record.checkpoint.preCallMessages[0]!.content = "other"; rehash(record) }
      expect(() => f.store.put(record)).toThrow()
    }
    const second = structuredClone(original)
    second.approvalId = `root-host-${randomUUID()}`
    second.registration.registrationId = `hostreg-${"b".repeat(43)}`
    second.registration.telegramMessageId += 1
    rehash(second)
    f.store.put(second)
    second.registration.telegramMessageId += 1
    expect(f.store.list()[1]!.registration.telegramMessageId).toBe(502)
    const selected = f.store.list()
    selected[0]!.continuationState = "complete"
    expect(f.store.list()[0]!.continuationState).toBe("pending")
    const materialized = f.store.list()[0]!
    materialized.continuationState = "materialized"
    materialized.materializedSessionRevision = hash
    f.store.put(materialized)
    materialized.materializedSessionRevision = "b".repeat(64)
    expect(() => f.store.put(materialized)).toThrow()
  })

  it("refuses invalid initialization and never creates a store file just by initializing", async () => {
    expect(() => new FileRootHostPendingApprovalStore(null as any)).toThrow()
    expect(() => createRootHostApprovalRuntime(null as any)).toThrow()
    const f = await fixture()
    expect(f.store.filePath).toBe(path.join(f.agentRoot, "state", "root-host-approvals", "v1", "pending.json"))
    expect(fs.existsSync(f.store.filePath)).toBe(false)
    expect(f.store.list()).toEqual([])
    expect(fs.existsSync(f.store.filePath)).toBe(false)
  })

  it("rejects a truncated zero-byte pending store rather than treating it as never initialized", async () => {
    const f = await fixture()
    await f.propose()
    fs.writeFileSync(f.store.filePath, "")
    expect(() => f.store.list()).toThrow()
    expect(await f.value.handleUpdate({ update_id: 11 } as any)).toBe(true)
    expect(f.port.execute).not.toHaveBeenCalled()
  })

  it.each([{ materializedSessionRevision: hash }, { continuationState: new String("complete") }])("rejects impossible or nonprimitive phase state %j", async (change) => {
    const f = await fixture()
    await f.propose()
    const record = f.store.list()[0]!
    expect(() => classifyRootHostPendingApproval({ ...record, ...change })).toThrow()
  })

  it.each(["registration", "execute", "materialize", "attempt", "complete"])("fences effects when durable %s writes fail", async (phase) => {
    const f = await fixture()
    if (phase !== "registration") await f.propose()
    if (phase === "execute") f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
    else if (phase !== "registration") f.setStatus(f.terminal())
    const rename = fs.renameSync
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(target) === f.store.filePath) {
        const next = JSON.parse(fs.readFileSync(source, "utf8")).records[0]
        if ((phase === "registration" && next.rootStatusDigest === null)
          || (phase === "execute" && next.executionRequested)
          || (phase === "attempt" && next.continuationState === "attempted")
          || (phase === "complete" && next.continuationState === "complete")) throw new Error("durable state unavailable")
      }
      if (phase === "materialize" && String(target) === f.sessionPath) throw new Error("session write failed")
      rename(source, target)
    })
    if (phase === "registration") {
      await expect(f.propose()).rejects.toThrow("durable state unavailable")
      expect(f.store.list()).toEqual([])
    } else {
      expect(await f.value.handleUpdate({ update_id: 11 } as any)).toBe(true)
      expect(f.provider).toHaveBeenCalledTimes(phase === "complete" ? 1 : 0)
      expect(f.port.execute).not.toHaveBeenCalled()
      vi.restoreAllMocks()
      if (phase === "complete") {
        await f.runtime().recover()
        expect(f.provider).toHaveBeenCalledOnce()
        expect(f.store.list()[0]!.continuationState).toBe("complete")
      }
      if (phase === "attempt") {
        expect(f.store.list()[0]!.continuationState).toBe("materialized")
        await f.runtime().recover()
        expect(f.provider).toHaveBeenCalledOnce()
      }
    }
    expect(fs.existsSync(path.join(f.agentRoot, "state", "approvals"))).toBe(false)
  })

  it("does not start the provider if fsync fails after its attempted marker is renamed", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    const fsync = fs.fsyncSync
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory() && f.store.list()[0]!.continuationState === "attempted") throw new Error("directory fsync failed")
      fsync(fd)
    })
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(f.store.list()[0]!.continuationState).toBe("attempted")
    await f.runtime().recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })

  it("never retries provider work when outward delivery fails", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    f.deliver.mockRejectedValueOnce(new Error("delivery lost"))
    await f.value.recover()
    expect(f.store.list()[0]!.continuationState).toBe("attempted")
    await f.runtime().recover()
    await f.runtime().recover()
    expect(f.provider).toHaveBeenCalledOnce()
    expect(f.deliver).toHaveBeenCalledOnce()
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })

  it.each([
    ["owner", (f: any) => { f.friend.trustLevel = "friend" }],
    ["admission", (f: any) => { f.friend.admissionState = "revoked" }],
    ["live Friend", (f: any) => { f.ctx.friendStore.get.mockResolvedValue(null) }],
    ["request", (f: any) => { f.ctx.relationshipAuthorization.requestId = "another-request" }],
    ["session key", (f: any) => { f.ctx.currentSession.key = "another-session" }],
    ["session path", (f: any) => { f.ctx.currentSession.sessionPath = "another-path" }],
    ["session event", (f: any) => { f.ctx.relationshipAuthorization.actor.sessionEventId = "another-event" }],
    ["external event", (f: any) => { f.ctx.currentExternalEvent = { id: "event" } }],
    ["profile", (f: any) => { f.friend.capabilityProfileId = "sanctuary-household" }],
    ["profile version", (f: any) => {
      const file = path.join(f.agentRoot, "tool-profiles.json")
      const profiles = JSON.parse(fs.readFileSync(file, "utf8"))
      profiles.profiles["sanctuary-owner"].version += 1
      fs.writeFileSync(file, JSON.stringify(profiles))
    }],
    ["issuer", (f: any) => { f.port.pins.expectedKeyId = "another-issuer" }],
    ["issuer key digest", (f: any) => { f.port.pins.expectedPublicKeyDigest = `sha256:${"b".repeat(64)}` }],
    ["provider capability", (f: any) => { f.capabilities.clear() }],
    ["health refresh", (f: any) => { f.port.refresh.mockResolvedValue(false) }],
    ["root port", (f: any) => { f.resolveContext.mockResolvedValue({ ...f.ctx, rootHost: { port: {} } }) }],
    ["missing root context", (f: any) => { f.resolveContext.mockResolvedValue({ ...f.ctx, rootHost: undefined }) }],
    ["provider configuration", (f: any) => { f.dependencies.getProviderRuntime.mockRejectedValue(new Error("runtime missing")) }],
    ["MCP configuration", (f: any) => { f.dependencies.getMcp.mockRejectedValue(new Error("MCP unavailable")) }],
  ])("checks current %s before both execution and continuation", async (name, mutate) => {
    const f = await fixture()
    await f.propose()
    mutate(f)
    f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
    await f.value.handleUpdate({ update_id: 11 } as any)
    expect(f.port.execute).not.toHaveBeenCalled()
    f.setStatus(f.terminal())
    await f.runtime().recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe(["health refresh", "provider configuration", "MCP configuration"].includes(name as string) ? "pending" : "complete")
  })

  it.each([
    ["missing live context", (f: any) => { delete f.request.liveToolContext }],
    ["wrong live port", (f: any) => { f.ctx.rootHost.port = {} }],
    ["missing session", (f: any) => { delete f.ctx.currentSession }],
    ["wrong agent root", (f: any) => { f.ctx.agentRoot = "other" }],
    ["wrong tool", (f: any) => { f.request.toolCall.function.name = "shell" }],
    ["wrong call type", (f: any) => { f.request.toolCall.type = "custom" }],
    ["missing selection", (f: any) => { f.ctx.toolSelection = { ordinary: [], engine: [] } }],
    ["invalid arguments", (f: any) => { f.request.arguments.timeoutMs = 0 }],
    ["absent observation", (f: any) => { delete f.ctx.rootHost.observation }],
  ])("refuses %s at the coordinator boundary without registration", async (_name, mutate) => {
    const f = await fixture()
    mutate(f)
    await expect(f.propose()).rejects.toThrow()
    expect(f.port.register).not.toHaveBeenCalled()
    expect(f.store.list()).toEqual([])
  })

  it("refuses a stale coordinator revision before registration", async () => {
    const f = await fixture()
    await expect(withSessionTurnLease(f.sessionPath, () => f.value.coordinator({ sessionPath: f.sessionPath, baseSessionRevision: hash }).propose(f.request))).rejects.toThrow()
    expect(f.port.register).not.toHaveBeenCalled()
  })

  it.each(["agentRoot", "sessionPath"])("does not follow a persisted foreign %s path", async (field) => {
    const f = await fixture()
    await f.propose()
    const record = f.store.list()[0]!
    const foreign = path.join(f.root, "foreign.json")
    ;(record.binding as any)[field] = foreign
    fs.writeFileSync(f.store.filePath, JSON.stringify({ schemaVersion: 1, records: [record] }))
    await f.value.recover()
    expect(f.port.status).not.toHaveBeenCalled()
    expect(fs.existsSync(foreign)).toBe(false)
  })

  it("rejects mismatched registered command fields before execution or continuation", async () => {
    const f = await fixture()
    await f.propose()
    const record = f.store.list()[0]!
    record.registration.registration.payload.targetResource = "other"
    fs.writeFileSync(f.store.filePath, JSON.stringify({ schemaVersion: 1, records: [record] }))
    f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
    await f.value.handleUpdate({ update_id: 11 } as any)
    expect(f.port.execute).not.toHaveBeenCalled()
    f.setStatus(f.terminal())
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
  })

  it("uses production dependency defaults through the existing provider and MCP owners", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    vi.spyOn(core, "getProviderRuntime").mockImplementation(f.dependencies.getProviderRuntime)
    vi.spyOn(core, "runAgent").mockImplementation(f.provider as any)
    vi.spyOn(mcpManager, "getSharedMcpManager").mockImplementation(f.dependencies.getMcp)
    const runtime = createRootHostApprovalRuntime({ agentRoot: f.agentRoot, port: f.port, deliver: f.deliver, resolveContext: f.resolveContext })
    await runtime.recover()
    expect(f.dependencies.getProviderRuntime).toHaveBeenCalledWith("human", { agentName: "sanctuary", agentRoot: f.agentRoot })
    expect(f.dependencies.getMcp).toHaveBeenCalledWith({ agentName: "sanctuary", agentRoot: f.agentRoot })
    expect(f.provider).toHaveBeenCalledOnce()
  })

  it("deduplicates simultaneous callbacks and recovery under the session lease", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
    expect(await Promise.all([f.value.handleUpdate({ update_id: 11 } as any), f.runtime().handleUpdate({ update_id: 11 } as any)])).toEqual([true, true])
    expect(f.port.execute).toHaveBeenCalledOnce()
    expect(f.provider).toHaveBeenCalledOnce()
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })

  it("recovers a materialized checkpoint exactly once after a crash before provider attempt", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    await f.runtime(() => { if (f.store.list()[0]!.continuationState === "materialized") throw new Error("crash before attempt") }).recover()
    expect(classifyRootHostPendingApproval(f.store.list()[0])).toBe("materialized")
    const frozen = f.store.list()[0]!.checkpoint.frozenAssistantMessage
    const messages = JSON.parse(fs.readFileSync(f.sessionPath, "utf8")).events
    expect(messages.filter((message: any) => message.role === "tool")).toHaveLength(1)
    await f.runtime().recover()
    expect(f.provider).toHaveBeenCalledOnce()
    const input = f.provider.mock.calls[0]![0]
    expect(input.filter((message: any) => message.role === "tool")).toHaveLength(1)
    expect(input.find((message: any) => message.tool_calls)).toEqual(frozen)
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })

  it("records attempted durably before calling the provider", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    f.provider.mockImplementation(async () => {
      expect(classifyRootHostPendingApproval(f.store.list()[0])).toBe("attempted")
      expect(fs.existsSync(path.join(f.agentRoot, "state", "approvals"))).toBe(false)
      return { outcome: "settled" }
    })
    await f.value.recover()
    expect(f.provider).toHaveBeenCalledOnce()
    expect(f.deliver).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })

  it("polls running execution to a terminal receipt without re-executing", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
    vi.mocked(f.port.execute).mockImplementation(async () => {
      expect(classifyRootHostPendingApproval(f.store.list()[0])).toBe("executing")
      f.setStatus({ ...f.terminal(), state: "permitted", receipt: undefined, execution: "running" })
    })
    await f.value.handleUpdate({ update_id: 11 } as any)
    expect(classifyRootHostPendingApproval(f.store.list()[0])).toBe("executing")
    await f.runtime().recover()
    expect(f.provider).not.toHaveBeenCalled()
    f.setStatus(f.terminal())
    await f.runtime().recover()
    expect(f.port.execute).toHaveBeenCalledOnce()
    expect(f.provider).toHaveBeenCalledOnce()
  })

  it("leaves committed restart records pending until a signed root decision exists", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus({ state: "committed", execution: "terminal", statusDigest: `sha256:${hash}` })
    await f.runtime().recover()
    expect(classifyRootHostPendingApproval(f.store.list()[0])).toBe("pending")
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.provider).not.toHaveBeenCalled()
    vi.mocked(f.port.callbackForUpdate).mockReturnValue({ handled: true, registrationId: `hostreg-${"b".repeat(43)}` })
    await f.value.handleUpdate({ update_id: 11 } as any)
    expect(f.port.status).toHaveBeenCalledOnce()
  })

  it("retains non-Error dependency failures for reconciliation and handles the claimed callback", async () => {
    const f = await fixture()
    await f.propose()
    vi.mocked(f.port.status).mockRejectedValue("disconnected")
    expect(await f.value.handleUpdate({ update_id: 11 } as any)).toBe(true)
    expect(f.store.list()[0]!.rootStatusDigest).toBeNull()
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.provider).not.toHaveBeenCalled()
  })

  it.each(["register", "revocation", "session", "shape"])("preserves failure of root registration at %s without ordinary approval state", async (failure) => {
    const f = await fixture()
    vi.mocked(f.port.register).mockImplementation(async () => {
      if (failure === "register") throw new Error("registration unavailable")
      if (failure === "revocation") f.friend.trustLevel = "friend"
      if (failure === "session") fs.appendFileSync(f.sessionPath, "\n")
      if (failure === "shape") return { ...f.registration, telegramMessageId: 0 }
      return f.registration
    })
    await expect(f.propose()).rejects.toThrow()
    expect(f.store.list()).toEqual([])
    expect(fs.existsSync(path.join(f.agentRoot, "state", "approvals"))).toBe(false)
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.provider).not.toHaveBeenCalled()
  })

  it.each(["residentFriendId", "relationshipProfileId", "relationshipProfileVersion", "requestId", "sessionKey", "sessionEventId", "residentApprovalId", "stewardPolicy", "registrationId"])("refuses mismatched signed terminal permit %s", async (field) => {
    const f = await fixture()
    await f.propose()
    const terminal = f.terminal()
    ;(terminal.permit.payload as any)[field] = field === "relationshipProfileVersion" ? 10 : "other"
    f.setStatus(terminal)
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe("pending")
  })

  it.each([
    ["receipt", (status: any) => { delete status.receipt }],
    ["permit", (status: any) => { delete status.permit }],
    ["state", (status: any) => { status.receipt.payload.state = "unknown" }],
    ["cleanup", (status: any) => { status.receipt.payload.cleanup = "cleanup_unproven" }],
    ["digest", (status: any) => { status.statusDigest = "invalid" }],
  ])("refuses an unusable terminal %s without provider effects", async (_name, mutate) => {
    const f = await fixture()
    await f.propose()
    const terminal = f.terminal()
    mutate(terminal)
    f.setStatus(terminal)
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.deliver).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe("pending")
  })

  it.each([
    ["registration schema", (r: any) => { r.registration.registration.schemaVersion = 0 }],
    ["registration domain", (r: any) => { r.registration.registration.domain = "not-host-registration" }],
    ["registration key", (r: any) => { r.registration.registration.keyId = "" }],
    ["registration signature", (r: any) => { r.registration.registration.signature = null }],
    ["registration payload", (r: any) => { r.registration.registration.payload = null }],
    ["approval UUID", (r: any) => { r.approvalId = `root-host-${"-".repeat(36)}` }],
    ["checkpoint suspended revision", (r: any) => { r.checkpoint.suspendedSessionRevision = hash }],
    ["pre-call member", (r: any) => { r.checkpoint.preCallMessages = [null] }],
    ["pre-call role", (r: any) => { r.checkpoint.preCallMessages = [{ role: "root", content: "not a message" }] }],
    ["empty tool call ID", (r: any) => { r.checkpoint.frozenAssistantMessage.tool_calls[0].id = "" }],
    ["issuer digest", (r: any) => { r.binding.publicKeyDigest = "not-a-digest" }],
  ])("rejects malformed durable %s instead of classifying it as pending", async (_name, mutate) => {
    const f = await fixture()
    await f.propose()
    const record = f.store.list()[0]!
    mutate(record)
    rehash(record)
    expect(() => classifyRootHostPendingApproval(record)).toThrow()
    expect(() => f.store.put(record)).toThrow()
  })

  it("rejects a duplicate registered root-card message across distinct approval IDs", async () => {
    const f = await fixture()
    await f.propose()
    const record = structuredClone(f.store.list()[0]!)
    record.approvalId = `root-host-${randomUUID()}`
    record.registration.registrationId = `hostreg-${"b".repeat(43)}`
    rehash(record)
    expect(() => f.store.put(record)).toThrow()
    fs.writeFileSync(f.store.filePath, JSON.stringify({ schemaVersion: 1, records: [f.store.list()[0], record] }))
    expect(() => f.store.list()).toThrow()
  })

  it("does not accept a mismatched resident permit during nonterminal reconciliation", async () => {
    const f = await fixture()
    await f.propose()
    const terminal = f.terminal()
    terminal.permit.payload.requestId = "another-request"
    f.setStatus({ ...terminal, state: "permitted", execution: "reconciliation_required", receipt: undefined })
    await f.value.recover()
    expect(f.store.list()[0]!.rootStatusDigest).toBeNull()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.port.execute).not.toHaveBeenCalled()
  })

  it("blocks provider continuation when the session changes during final authority refresh", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    f.resolveContext.mockImplementation(async () => {
      if (f.store.list()[0]!.continuationState === "materialized") fs.appendFileSync(f.sessionPath, "\n")
      return { ...f.ctx, rootHost: { port: f.port } }
    })
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })

  it("does not overwrite a session changed during initial continuation authorization", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    const changed = JSON.parse(fs.readFileSync(f.sessionPath, "utf8"))
    changed.events[0].content = "new owner request"
    const bytes = JSON.stringify(changed)
    f.resolveContext.mockImplementation(async () => {
      fs.writeFileSync(f.sessionPath, bytes)
      return { ...f.ctx, rootHost: { port: f.port } }
    })
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(fs.readFileSync(f.sessionPath, "utf8")).toBe(bytes)
  })

  it("blocks materialized restart after a same-request session head change", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal())
    const barrier = () => { if (f.store.list()[0]!.continuationState === "materialized") throw new Error("crash before attempt") }
    await f.runtime(barrier).recover()
    expect(f.store.list()[0]!.continuationState).toBe("materialized")
    const changed = `${fs.readFileSync(f.sessionPath, "utf8")}\n`
    fs.writeFileSync(f.sessionPath, changed)
    await f.runtime().recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe("complete")
    expect(fs.readFileSync(f.sessionPath, "utf8")).toBe(changed)
  })

  it("checks the effect barrier again immediately before the root registration send", async () => {
    const f = await fixture()
    const original = f.ctx.relationshipAuthorization!.authorizeTool
    let effectsAllowed = true
    f.ctx.relationshipAuthorization!.authorizeTool = async (...args) => {
      const result = await original(...args)
      effectsAllowed = false
      return result
    }
    const value = f.runtime(() => { if (!effectsAllowed) throw new Error("turn cancelled") })
    await expect(withSessionTurnLease(f.sessionPath, (lease) => value.coordinator({
      sessionPath: f.sessionPath, baseSessionRevision: readSessionTransaction(f.sessionPath, lease).revision,
    }).propose(f.request))).rejects.toThrow("turn cancelled")
    expect(f.port.register).not.toHaveBeenCalled()
  })

  it("suspends without ordinary approval state, executes once, and resumes the provider once from the root receipt", async () => {
    const f = await fixture()
    expect((await preflightToolCall("sanctuary_host_execute", f.args as any, f.ctx)).kind).toBe("ready")
    const suspended = await f.propose()
    expect(f.port.register).toHaveBeenCalledWith({ ...f.args, verification: null, ownerObservation: { digest: `sha256:${hash}`, updateId: 10, userId: "42", chatId: "42", messageId: "110" } })
    expect(f.store.list()[0]).toMatchObject({ schemaVersion: 1, approvalId: suspended.approvalId, continuationState: "pending" })
    expect(fs.existsSync(path.join(f.agentRoot, "state", "approvals"))).toBe(false)
    const bytes = fs.readFileSync(f.store.filePath, "utf8")
    for (const forbidden of ["decisionToken", "callback_data", "approveHandle", "botToken", "issuerSeed"]) expect(bytes).not.toContain(forbidden)
    f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
    expect(await f.value.handleUpdate({ update_id: 11 } as any)).toBe(true)
    expect(f.port.execute).toHaveBeenCalledOnce()
    expect(f.provider).toHaveBeenCalledOnce()
    expect(f.provider.mock.calls[0]![0].find((m: any) => m.role === "tool").content).toContain("root-receipt")
    await f.value.handleUpdate({ update_id: 11 } as any)
    await f.runtime().recover()
    expect(f.port.execute).toHaveBeenCalledOnce()
    expect(f.provider).toHaveBeenCalledOnce()
  })

  describe("root host runtime boundary regressions", () => {
    it.each([
      ["schema", (r: any) => { r.schemaDigest = hash }],
      ["tool", (r: any) => { r.toolDigest = hash }],
      ["policy", (r: any) => { r.policyDigest = hash }],
      ["policy ID", (r: any) => { r.policyId = "other" }],
      ["action", (r: any) => { r.actionClass = "other" }],
      ["frozen call ID", (r: any) => { r.frozenAssistantMessage.tool_calls[0].id = "other" }],
      ["frozen arguments", (r: any) => { r.frozenAssistantMessage.tool_calls[0].function.arguments = JSON.stringify({ ...r.arguments, targetResource: "other" }) }],
      ["mixed batch", (r: any) => { r.frozenAssistantMessage.tool_calls.push(structuredClone(r.toolCall)) }],
      ["missing pre-call messages", (r: any) => { r.preCallMessages = null }],
    ])("rejects invalid %s evidence before root registration", async (_name, mutate) => {
      const f = await fixture()
      mutate(f.request)
      await expect(f.propose()).rejects.toThrow()
      expect(f.port.register).not.toHaveBeenCalled()
      expect(f.store.list()).toEqual([])
    })

    it("freezes caller data before awaiting root registration", async () => {
      const f = await fixture()
      const original = structuredClone(f.request.frozenAssistantMessage)
      vi.mocked(f.port.register).mockImplementation(async () => {
        f.request.frozenAssistantMessage.phase = "changed-after-registration"
        f.request.preCallMessages[0].content = "changed-after-registration"
        return f.registration
      })
      await f.propose()
      const checkpoint = f.store.list()[0]!.checkpoint
      expect(checkpoint.frozenAssistantMessage).toEqual(original)
      expect(checkpoint.preCallMessages[0]!.content).toBe("run id")
    })

    it.each(["schemaDigest", "toolDigest", "policyDigest"])("blocks drifted persisted %s before execution and continuation", async (key) => {
      const f = await fixture()
      await f.propose()
      const record = f.store.list()[0]!
      ;(record.checkpoint as any)[key] = hash
      record.checkpoint.checkpointDigest = digestApprovalSuspensionCheckpointPayload(record.checkpoint)
      fs.writeFileSync(f.store.filePath, JSON.stringify({ schemaVersion: 1, records: [record] }))
      f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
      await f.value.handleUpdate({ update_id: 11 } as any)
      expect(f.port.execute).not.toHaveBeenCalled()
      f.setStatus(f.terminal())
      await f.value.recover()
      expect(f.provider).not.toHaveBeenCalled()
    })

    it("preserves a changed session instead of overwriting it with the frozen checkpoint", async () => {
      const f = await fixture()
      await f.propose()
      const bytes = `${fs.readFileSync(f.sessionPath, "utf8")}\n`
      fs.writeFileSync(f.sessionPath, bytes)
      f.setStatus(f.terminal())
      await f.value.recover()
      expect(f.provider).not.toHaveBeenCalled()
      expect(fs.readFileSync(f.sessionPath, "utf8")).toBe(bytes)
      expect(f.store.list()[0]!.continuationState).toBe("complete")
    })

    it("terminally consumes an interrupted provider attempt without retry", async () => {
      const f = await fixture()
      await f.propose()
      f.setStatus(f.terminal())
      f.provider.mockRejectedValueOnce(new Error("provider connection lost"))
      await f.value.recover()
      await f.runtime().recover()
      await f.runtime().recover()
      expect(f.provider).toHaveBeenCalledOnce()
      expect(f.store.list()[0]!.continuationState).toBe("complete")
    })

    it("keeps claimed root callbacks handled when local state is corrupt", async () => {
      const f = await fixture()
      fs.mkdirSync(path.dirname(f.store.filePath), { recursive: true })
      fs.writeFileSync(f.store.filePath, "{")
      expect(await f.value.handleUpdate({ update_id: 11 } as any)).toBe(true)
      await expect(f.value.recover()).rejects.toThrow()
    })

    it.each(["continuation", "execution"])("rejects durable %s regressions that would allow replay", async (field) => {
      const f = await fixture()
      await f.propose()
      const record = f.store.list()[0]!
      if (field === "continuation") { record.continuationState = "attempted"; record.materializedSessionRevision = hash }
      else record.executionRequested = true
      f.store.put(record)
      if (field === "continuation") record.continuationState = "pending"
      else record.executionRequested = false
      expect(() => f.store.put(record)).toThrow()
    })
  })

  it.each(["denied", "expired"])("continues or controls a root %s without execution", async (state) => {
    const f = await fixture()
    await f.propose()
    f.setStatus({ state, execution: "terminal", statusDigest: `sha256:${hash}` })
    await f.value.recover()
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.provider).toHaveBeenCalledTimes(state === "denied" ? 1 : 0)
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })

  it.each(["failed", "ambiguous"])("maps terminal root %s receipts to existing continuation outcomes", async (state) => {
    const f = await fixture()
    await f.propose()
    f.setStatus(f.terminal(state))
    await f.runtime().recover()
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.provider).toHaveBeenCalledTimes(state === "failed" ? 1 : 0)
  })

  it("recovers permitted as reconciliation_required and never duplicates execution", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus({ ...f.terminal(), state: "permitted", receipt: undefined, execution: "reconciliation_required" })
    await f.runtime().recover()
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.provider).not.toHaveBeenCalled()
    expect(classifyRootHostPendingApproval(f.store.list()[0])).toBe("reconciliation_required")
    f.setStatus(f.terminal())
    await f.runtime().recover()
    expect(f.provider).toHaveBeenCalledOnce()
  })

  it("marks execution before dispatch and reconciles a lost response rather than retrying", async () => {
    const f = await fixture()
    await f.propose()
    f.setStatus({ state: "approved", execution: "terminal", statusDigest: `sha256:${hash}` })
    vi.mocked(f.port.execute).mockRejectedValue(new Error("lost execution reply"))
    await f.value.handleUpdate({ update_id: 11 } as any)
    await f.runtime().recover()
    expect(f.port.execute).toHaveBeenCalledOnce()
    expect(f.provider).not.toHaveBeenCalled()
  })

  it("refuses changed owner authority, session or signed permit correlation before continuation", async () => {
    const f = await fixture()
    await f.propose()
    f.friend.trustLevel = "friend"
    f.setStatus(f.terminal())
    await f.value.recover()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.port.status).toHaveBeenCalled()
    expect(f.store.list()[0]!.continuationState).toBe("complete")
  })

  it("retains provider assistant metadata in the frozen continuation", async () => {
    const f = await fixture()
    f.request.frozenAssistantMessage.phase = "commentary"
    await f.propose()
    expect(f.store.list()[0]!.checkpoint.frozenAssistantMessage.phase).toBe("commentary")
  })

  it("returns handled for a claimed root callback without a local pending record", async () => {
    const f = await fixture()
    expect(await f.value.handleUpdate({ update_id: 11 } as any)).toBe(true)
    vi.mocked(f.port.callbackForUpdate).mockReturnValue({ handled: false })
    expect(await f.value.handleUpdate({ update_id: 12 } as any)).toBe(false)
    vi.mocked(f.port.callbackForUpdate).mockReturnValue({ handled: true })
    expect(await f.value.handleUpdate({ update_id: 13 } as any)).toBe(true)
  })
})
