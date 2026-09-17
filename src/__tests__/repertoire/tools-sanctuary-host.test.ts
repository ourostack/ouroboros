import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getChannelCapabilities, type FriendRecord } from "@ouro.bot/friends"
import { signAuthorityPayload } from "../../heart/daemon/sanctuary-authority-codec"
import { buildCanonicalSessionEnvelope, type SessionEnvelope } from "../../heart/session-events"
import { createRootHostApprovalPort } from "../../senses/root-host-approval-port"
import type { TelegramAuthorityTransportMetadata } from "../../senses/telegram-client"
import { getSenseSessionPath } from "../../senses/shared-turn"
import { createRelationshipAuthorizationEvaluator, loadRelationshipCapabilityRegistry } from "../../repertoire/relationship-authorization"
import { validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"
import { approvalPolicyForInvocation, executeTool, preflightToolCall, reduceToolSelection, selectToolsForChannel, toolSelectionSchemas } from "../../repertoire/tools"
import type { ToolContext } from "../../repertoire/tools-base"
import { authorizeRootHostContext, rootHostToolDefinition, selectRootHostTool, validateRootHostToolArguments } from "../../repertoire/tools-sanctuary-host"

const name = "sanctuary_host_execute"
const keys = generateKeyPairSync("ed25519")
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const publicKeyDigest = digest("root-key")
const pins = { expectedTargetHost: "sanctuary", expectedBotId: "123456", expectedOwnerUserId: "42", expectedOwnerChatId: "42", expectedKeyId: "issuer-1", expectedPublicKeyDigest: publicKeyDigest, publicKey: keys.publicKey }
const rootBase = path.resolve(".s5-host-tool-tests")
let serial = 0
const roots: string[] = []

function argumentsValue(): Record<string, unknown> {
  return {
    targetHost: "sanctuary", targetResource: "host",
    command: { kind: "executable", executable: "/usr/bin/id", arguments: ["-u"] },
    workingDirectoryProfile: "host.root.v1", environmentProfile: "host.clean.v1", timeoutMs: 1000,
  }
}

async function fixture() {
  const directory = path.join(rootBase, String(++serial))
  roots.push(directory)
  const agentRoot = path.join(directory, "sanctuary.ouro")
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.copyFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", path.join(agentRoot, "tool-profiles.json"))
  const friend: FriendRecord = {
    id: "owner", name: "Owner", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive", capabilityProfileId: "sanctuary-owner",
    externalIds: [{ provider: "telegram-user", tenantId: "123456", externalId: "42", linkedAt: new Date().toISOString() }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "", updatedAt: "", schemaVersion: 1,
  }
  const sessionKey = "telegram:123456:42"
  const requestId = "telegram:123456:42:110"
  const sessionPath = getSenseSessionPath("sanctuary", friend.id, "telegram", sessionKey, agentRoot)
  const message = { role: "user" as const, content: "run id" }
  const envelope = buildCanonicalSessionEnvelope({
    existing: null, previousMessages: [], currentMessages: [message], trimmedMessages: [message],
    currentIngressRelations: [{ replyToEventId: null, threadRootEventId: null, references: [requestId] }],
    recordedAt: new Date().toISOString(), projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
  }).envelope
  const save = (value: SessionEnvelope = envelope) => {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
    fs.writeFileSync(sessionPath, JSON.stringify(value))
  }
  save()
  const observation: TelegramAuthorityTransportMetadata = Object.freeze({
    schemaVersion: 1, observationDigest: digest("observation"), targetHost: "sanctuary", botId: "123456", updateId: 10,
    updateClass: "message", userId: "42", chatId: "42", ownerEligible: true, messageId: "110", callbackQueryId: null,
    rawUpdateDigest: digest("raw"), observedAt: new Date().toISOString(), keyId: "issuer-1", publicKeyDigest,
  })
  let currentObservation: TelegramAuthorityTransportMetadata | null = observation
  let stopped = false
  const client = { request: vi.fn(async () => ({ health: signAuthorityPayload({
    domain: "ouro.sanctuary.host-health.v1", keyId: pins.expectedKeyId, privateKey: keys.privateKey,
    payload: { targetHost: "sanctuary", botId: "123456", ownerUserId: "42", ownerChatId: "42", publicKeyDigest, observedAt: new Date().toISOString(), healthy: true },
  }) })), close: vi.fn() }
  const port = createRootHostApprovalPort(client, pins, { current: () => currentObservation, lookup: () => null, stopped: () => stopped })
  await port.refresh()
  const actor = { friendId: friend.id, trustLevel: "family" as const, sessionEventId: envelope.events[0]!.id }
  const decision = () => createRelationshipAuthorizationEvaluator({
    friend, registry: loadRelationshipCapabilityRegistry(agentRoot), requestId, sessionEventId: actor.sessionEventId,
  })
  const authorizeTool = vi.fn(async (tool: string) => decision().authorizeTool(tool))
  const ctx: ToolContext = {
    signin: async () => undefined, agentName: "sanctuary", agentRoot,
    context: { friend, channel: getChannelCapabilities("telegram") },
    friendStore: { get: vi.fn(async () => friend) } as any,
    currentSession: { friendId: friend.id, channel: "telegram", key: sessionKey, sessionPath },
    relationshipAuthorization: { ...decision(), requestId, actor, authorizeTool },
    rootHost: { port, observation },
  }
  const capabilities = new Set<any>(["reasoning-effort", "approval-continuation"])
  const select = () => selectToolsForChannel(getChannelCapabilities("telegram"), undefined, undefined, capabilities, undefined, undefined, ctx)
  const activate = async () => {
    const binding = await authorizeRootHostContext(ctx)
    Object.assign(ctx, { toolSelection: select(), selectCurrentTools: select })
    return binding
  }
  return {
    ctx, friend, port, observation, capabilities, select, activate, authorizeTool, envelope, save,
    stop: () => { stopped = true },
    replaceObservation: (value: TelegramAuthorityTransportMetadata | null) => { currentObservation = value },
  }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-09-17T02:30:00.000Z") })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe("S5 host command contract", () => {
  it("refreshes expired health before dispatch without extending observation freshness", async () => {
    const f = await fixture()
    await f.activate()
    const now = Date.now()
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now + 30_001)
    expect(f.port.isHealthy()).toBe(false)
    expect((await preflightToolCall(name, argumentsValue() as any, f.ctx)).kind).toBe("ready")
    vi.setSystemTime(now + 300_001)
    expect((await preflightToolCall(name, argumentsValue() as any, f.ctx)).kind).toBe("rejected_before_handler")
  })
  it("rejects a selected call when expired transport health cannot be refreshed", async () => {
    const f = await fixture()
    await f.activate()
    f.stop()
    expect((await preflightToolCall(name, argumentsValue() as any, f.ctx)).kind).toBe("rejected_before_handler")
  })
  it("advertises one strict proposal tool, with sole-call approval and no resident executor", async () => {
    const f = await fixture()
    await f.activate()
    const definitions = f.ctx.toolSelection!.ordinary.filter((definition) => definition.tool.function.name === name)
    expect(definitions).toHaveLength(1)
    expect(rootHostToolDefinition.requiredCapability).toBe("approval-continuation")
    expect(await approvalPolicyForInvocation(name, argumentsValue(), f.ctx)).toEqual({
      kind: "required", policyId: "sanctuary.host.owner-approved.v1", actionClass: "owner_approved_arbitrary_host", requiresSoleCall: true,
    })
    const schema = definitions[0].tool.function.parameters as any
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(argumentsValue()).concat("verification").sort())
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).not.toContain("verification")
    for (const verification of [undefined, null, { profile: "file.digest.v1", expectedStateDigest: digest("file") }]) {
      const args = { ...argumentsValue(), targetResource: "/boot/test", ...(verification === undefined ? {} : { verification }) }
      expect(validateAdvertisedToolArguments(JSON.stringify(args), schema).ok).toBe(true)
      expect(validateRootHostToolArguments(args, "sanctuary")).toEqual({ ...args, verification: verification ?? null })
    }
    expect(() => rootHostToolDefinition.handler(argumentsValue() as any, f.ctx)).toThrow(/root.*approval|approval.*root/i)
    expect(await preflightToolCall(name, argumentsValue() as any, f.ctx)).toMatchObject({ kind: "ready", definition: definitions[0] })
    expect((await executeTool(name, argumentsValue() as any, f.ctx)).kind).toBe("handler_indeterminate")
  })

  it("accepts LF scripts with interpreter arguments and validates without modifying caller arguments", () => {
    const args = { ...argumentsValue(), command: { kind: "script", interpreter: "/bin/sh", arguments: ["-eu"], script: "printf '%s\\n' hello\n" } }
    const before = structuredClone(args)
    expect(validateRootHostToolArguments(args, "sanctuary")).toEqual({ ...args, verification: null })
    expect(args).toEqual(before)
    expect(validateAdvertisedToolArguments(JSON.stringify(args), rootHostToolDefinition.tool.function.parameters!).ok).toBe(true)
  })

  it.each([
    { command: { kind: "executable", executable: "id", arguments: [] } },
    { command: { kind: "executable", executable: "/usr/../bin/id", arguments: [] } },
    { command: { kind: "executable", executable: "/bin/sh", arguments: ["-c", "id"] } },
    { command: { kind: "executable", executable: "/bin/sh", arguments: ["--eval=id"] } },
    { command: { kind: "executable", executable: "/bin/id", arguments: [4] } },
    { command: { kind: "executable", executable: "/bin/id", arguments: [null] } },
    { command: { kind: "executable", executable: "/bin/id", arguments: [""] } },
    { command: { kind: "executable", executable: "/bin/id", arguments: [], script: "id\n" } },
    { command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "id\r\n" } },
    { command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "id \n" } },
    { command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "é" } },
    { command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "\tcat\n" } },
    { command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "" } },
    { command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "x".repeat(2049) } },
    { targetHost: "elsewhere" }, { targetResource: "" }, { workingDirectoryProfile: "/root" }, { environmentProfile: "inherit" },
    { timeoutMs: 999 }, { timeoutMs: 900001 }, { timeoutMs: 1000.5 }, { timeoutMs: "1000" },
    { ownerObservation: {} }, { expiresAt: "tomorrow" }, { verification: {} },
    { verification: { profile: "file.digest.v1", expectedStateDigest: digest("file") } },
  ])("denies malformed S4 proposal before handler: %j", async (patch) => {
    const f = await fixture()
    await f.activate()
    const args = { ...argumentsValue(), ...patch }
    const executor = vi.fn(async () => "must not run")
    expect(() => validateRootHostToolArguments(args, "sanctuary")).toThrow()
    expect(await executeTool(name, args as any, f.ctx, executor)).toMatchObject({ kind: "rejected_before_handler" })
    expect(executor).not.toHaveBeenCalled()
  })
})

describe("S5 exact current owner advertisement", () => {
  it("preserves the exact pre-S5 owner set until real authorization, then adds only the host tool", async () => {
    const f = await fixture()
    const inactive = toolSelectionSchemas(f.select()).map((tool) => tool.function.name).sort()
    expect(inactive).not.toContain(name)
    const binding = await f.activate()
    expect(f.ctx.rootHost!.binding).toBe(binding)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(toolSelectionSchemas(f.select()).map((tool) => tool.function.name).sort()).toEqual([...inactive, name].sort())
    expect(selectRootHostTool(f.ctx, f.capabilities)?.tool.function.name).toBe(name)
    expect(f.authorizeTool).toHaveBeenCalledWith(name, {})
  })

  it.each(["sanctuary-household", "sanctuary-event", "sanctuary-unknown"])("never expands poisoned %s profiles", async (profileId) => {
    const f = await fixture()
    const binding = await f.activate()
    f.ctx.relationshipAuthorization!.profileId = profileId
    f.ctx.rootHost!.binding = binding
    const poisoned = toolSelectionSchemas(f.select()).map((tool) => tool.function.name)
    delete f.ctx.rootHost
    expect(poisoned).toEqual(toolSelectionSchemas(f.select()).map((tool) => tool.function.name))
    expect(poisoned).not.toContain(name)
  })

  it.each(["inner", "cli", undefined] as const)("does not export a Telegram host authorization to the %s selection channel", async (channel) => {
    const f = await fixture()
    await f.activate()
    const selection = selectToolsForChannel(channel && getChannelCapabilities(channel), undefined, undefined, f.capabilities, undefined, undefined, f.ctx)
    expect(toolSelectionSchemas(selection).map((tool) => tool.function.name)).not.toContain(name)
  })

  it("uses the core's freshly resolved Friend rather than an older ToolContext Friend for advertisement", async () => {
    const f = await fixture()
    await f.activate()
    const current = { ...f.ctx.context!, friend: { ...f.friend, admissionState: "revoked" as const } }
    expect(toolSelectionSchemas(selectToolsForChannel(getChannelCapabilities("telegram"), undefined, current, f.capabilities, undefined, undefined, f.ctx))
      .map((tool) => tool.function.name)).not.toContain(name)
  })

  it.each(["absent", "copy", "stopped", "stale-health", "stale-observation", "replaced"])("denies unavailable or forged initial observation: %s", async (change) => {
    const f = await fixture()
    if (change === "absent") delete f.ctx.rootHost!.observation
    if (change === "copy") f.ctx.rootHost!.observation = { ...f.observation }
    if (change === "stopped") f.stop()
    if (change === "stale-health") vi.advanceTimersByTime(30000)
    if (change === "stale-observation") { vi.advanceTimersByTime(300000); await f.port.refresh() }
    if (change === "replaced") f.replaceObservation({ ...f.observation, updateId: 11 })
    await expect(authorizeRootHostContext(f.ctx)).rejects.toThrow()
    expect(toolSelectionSchemas(f.select()).some((tool) => tool.function.name === name)).toBe(false)
  })

  it("requires runtime reauthorization for recovery; copying a binding cannot forge advertisement", async () => {
    const f = await fixture()
    const expected = structuredClone(await f.activate())
    delete f.ctx.rootHost!.observation
    f.ctx.rootHost!.binding = expected
    expect(selectRootHostTool(f.ctx, f.capabilities)).toBeUndefined()
    const recovered = await authorizeRootHostContext(f.ctx, expected)
    expect(recovered).toEqual(expected)
    expect(recovered).not.toBe(expected)
    expect(selectRootHostTool(f.ctx, f.capabilities)).toBeDefined()
    Object.assign(f.ctx, { toolSelection: f.select() })
    expect(await preflightToolCall(name, argumentsValue() as any, f.ctx)).toMatchObject({ kind: "ready" })
    f.ctx.rootHost!.binding = { ...recovered }
    expect(selectRootHostTool(f.ctx, f.capabilities)).toBeUndefined()
    await expect(authorizeRootHostContext(f.ctx)).rejects.toThrow()
  })

  it.each([
    ["agentName", (f: any) => { f.ctx.agentName = "other" }],
    ["agentRoot", (f: any) => { f.ctx.agentRoot = path.join(rootBase, "other.ouro") }],
    ["relative root", (f: any) => { f.ctx.agentRoot = "sanctuary.ouro" }],
    ["friend", (f: any) => { f.ctx.context.friend.id = "other" }],
    ["revoked", (f: any) => { f.friend.admissionState = "revoked" }],
    ["reactive", (f: any) => { f.friend.initiativePolicy = "reactive_only" }],
    ["household friend", (f: any) => { f.friend.capabilityProfileId = "sanctuary-household" }],
    ["trust", (f: any) => { f.friend.trustLevel = "friend" }],
    ["request", (f: any) => { f.ctx.relationshipAuthorization.requestId = "next-request" }],
    ["session", (f: any) => { f.ctx.currentSession.key = "other" }],
    ["session friend", (f: any) => { f.ctx.currentSession.friendId = "other" }],
    ["session path", (f: any) => { f.ctx.currentSession.sessionPath += ".other" }],
    ["channel", (f: any) => { f.ctx.currentSession.channel = "inner" }],
    ["event", (f: any) => { f.ctx.relationshipAuthorization.actor.sessionEventId = "next-event" }],
    ["external event", (f: any) => { f.ctx.currentExternalEvent = {} }],
    ["profile removed", (f: any) => { f.ctx.relationshipAuthorization.advertisedToolNames = [] }],
    ["friend store absent", (f: any) => { delete f.ctx.friendStore }],
    ["friend absent", (f: any) => { f.ctx.friendStore.get.mockResolvedValue(null) }],
    ["actor absent", (f: any) => { delete f.ctx.relationshipAuthorization.actor }],
    ["port absent", (f: any) => { delete f.ctx.rootHost }],
    ["authority denied", (f: any) => { f.authorizeTool.mockResolvedValue({ allowed: false, reason: "revoked" }) }],
    ["authority error", (f: any) => { f.authorizeTool.mockRejectedValue(new Error("offline")) }],
    ["receipt empty", (f: any) => { f.authorizeTool.mockResolvedValue({ allowed: true, receiptId: "" }) }],
  ])("rejects stale or missing %s before dispatch and recovery", async (_label, mutate) => {
    const f = await fixture()
    const expected = structuredClone(await f.activate())
    mutate(f)
    const executor = vi.fn(async () => "must not run")
    expect(await executeTool(name, argumentsValue() as any, f.ctx, executor)).toMatchObject({ kind: "rejected_before_handler" })
    await expect(authorizeRootHostContext(f.ctx, expected)).rejects.toThrow()
    expect(executor).not.toHaveBeenCalled()
  })

  it.each(["friendId", "profileId", "profileVersion", "requestId"])("requires exact %s from live relationship decision", async (field) => {
    const f = await fixture()
    const expected = await f.activate()
    const current = await f.authorizeTool(name)
    for (const value of [undefined, field === "profileVersion" ? 10 : "other"]) {
      f.authorizeTool.mockResolvedValue({ ...current, [field]: value } as any)
      await expect(authorizeRootHostContext(f.ctx, expected)).rejects.toThrow()
    }
  })

  it.each(["keyId", "publicKeyDigest", "targetHost", "profileVersion", "sessionPath", "requestId"])("rejects a mismatched persisted %s", async (field) => {
    const f = await fixture()
    const binding = await f.activate()
    await expect(authorizeRootHostContext(f.ctx, { ...binding, [field]: field === "profileVersion" ? 8 : "changed" })).rejects.toThrow()
  })

  it.each(["retired", "unsafe-version", "removed-tool", "missing-profile"])("rejects poisoned current profile data: %s", async (change) => {
    const f = await fixture()
    await f.activate()
    const file = path.join(f.ctx.agentRoot!, "tool-profiles.json")
    const registry = JSON.parse(fs.readFileSync(file, "utf8"))
    const profile = registry.profiles["sanctuary-owner"]
    if (change === "retired") profile.version = 8
    if (change === "unsafe-version") profile.version = Number.MAX_SAFE_INTEGER + 1
    if (change === "removed-tool") profile.toolNames = profile.toolNames.filter((tool: string) => tool !== name)
    if (change === "missing-profile") delete registry.profiles["sanctuary-owner"]
    fs.writeFileSync(file, JSON.stringify(registry))
    expect(selectRootHostTool(f.ctx, f.capabilities)).toBeUndefined()
    await expect(authorizeRootHostContext(f.ctx)).rejects.toThrow()
  })

  it.each(["missing", "newer-user", "reference", "superseded"])("revalidates the latest effective durable session event: %s", async (change) => {
    const f = await fixture()
    const expected = await f.activate()
    if (change === "missing") fs.rmSync(f.ctx.currentSession!.sessionPath)
    if (change === "reference") { f.envelope.events[0].relations.references = ["different"]; f.save() }
    if (change === "newer-user" || change === "superseded") {
      const old = f.envelope.events[0]
      f.envelope.events.push({ ...structuredClone(old), id: "new-user", sequence: 2, relations: { ...old.relations, ...(change === "superseded" ? { supersedesEventId: old.id } : {}) } })
      f.save()
    }
    await expect(authorizeRootHostContext(f.ctx, expected)).rejects.toThrow()
    expect(selectRootHostTool(f.ctx, f.capabilities)).toBeUndefined()
  })

  it("rejects coordinate mutation during asynchronous authorization", async () => {
    const f = await fixture()
    const original = f.authorizeTool.getMockImplementation()!
    f.authorizeTool.mockImplementation(async (tool) => { const result = await original(tool); f.ctx.relationshipAuthorization!.requestId = "raced"; return result })
    await expect(authorizeRootHostContext(f.ctx)).rejects.toThrow()
    expect(selectRootHostTool(f.ctx, f.capabilities)).toBeUndefined()
  })

  it.each(["user", "bot", "duplicate", "missing"])("rejects a non-owner durable Telegram identity: %s", async (change) => {
    const f = await fixture()
    if (change === "user") f.friend.externalIds[0].externalId = "43"
    if (change === "bot") f.friend.externalIds[0].tenantId = "654321"
    if (change === "duplicate") f.friend.externalIds.push({ ...f.friend.externalIds[0] })
    if (change === "missing") f.friend.externalIds = []
    await expect(authorizeRootHostContext(f.ctx)).rejects.toThrow()
    expect(selectRootHostTool(f.ctx, f.capabilities)).toBeUndefined()
  })

  it("rejects changing the live port object during relationship authorization even with identical pins", async () => {
    const f = await fixture()
    const original = f.authorizeTool.getMockImplementation()!
    f.authorizeTool.mockImplementation(async (tool) => {
      const result = await original(tool)
      f.ctx.rootHost!.port = { ...f.port }
      return result
    })
    await expect(authorizeRootHostContext(f.ctx)).rejects.toThrow()
  })

  it.each(["denied", "friend-store-unavailable"])("revokes an earlier advertisement when reauthorization is %s", async (failure) => {
    const f = await fixture()
    await f.activate()
    if (failure === "denied") f.authorizeTool.mockResolvedValue({ allowed: false, reason: "revoked" })
    else delete f.ctx.friendStore
    await expect(authorizeRootHostContext(f.ctx)).rejects.toThrow()
    expect(selectRootHostTool(f.ctx, f.capabilities)).toBeUndefined()
  })
})

describe("S5 canonical dispatch", () => {
  it.each(["none", "singleton", "copy", "handler-copy", "unselected", "capability", "current-removed"])("rejects noncanonical selected definition: %s", async (change) => {
    const f = await fixture()
    await f.activate()
    const selected = f.ctx.toolSelection!.ordinary.find((definition) => definition.tool.function.name === name)!
    const executor = vi.fn(async () => "must not run")
    if (change === "none") delete (f.ctx as any).toolSelection
    if (change === "singleton") Object.assign(f.ctx, { toolSelection: { ordinary: [rootHostToolDefinition], engine: [] } })
    if (change === "copy") Object.assign(f.ctx, { toolSelection: { ordinary: [{ ...selected }], engine: [] } })
    if (change === "handler-copy") Object.assign(f.ctx, { toolSelection: { ordinary: [{ ...selected, handler: executor }], engine: [] } })
    if (change === "unselected") Object.assign(f.ctx, { toolSelection: { ordinary: [], engine: [] } })
    if (change === "capability") f.capabilities.delete("approval-continuation")
    if (change === "current-removed") Object.assign(f.ctx, { selectCurrentTools: () => ({ ordinary: [], engine: [] }) })
    expect(await executeTool(name, argumentsValue() as any, f.ctx, executor)).toMatchObject({ kind: "rejected_before_handler" })
    expect(executor).not.toHaveBeenCalled()
  })

  it("preserves exact canonical reductions and denies cross-turn retained definitions", async () => {
    const f = await fixture()
    await f.activate()
    const g = await fixture()
    await g.activate()
    const selected = f.ctx.toolSelection!.ordinary.find((definition) => definition.tool.function.name === name)!
    Object.assign(f.ctx, { toolSelection: reduceToolSelection(f.ctx.toolSelection!, [selected.tool]) })
    expect(await preflightToolCall(name, argumentsValue() as any, f.ctx)).toMatchObject({ kind: "ready" })
    Object.assign(g.ctx, { toolSelection: f.ctx.toolSelection })
    expect(await preflightToolCall(name, argumentsValue() as any, g.ctx)).toMatchObject({ kind: "rejected_before_handler" })
    expect(await executeTool(name, argumentsValue() as any)).toMatchObject({ kind: "rejected_before_handler" })
  })

  it("revalidates a canonical selection when no live selection callback was installed", async () => {
    const f = await fixture()
    await f.activate()
    delete (f.ctx as any).selectCurrentTools
    expect(await preflightToolCall(name, argumentsValue() as any, f.ctx)).toMatchObject({ kind: "ready" })
  })
})
