import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authorityArtifactDigest, signAuthorityPayload, verifyAuthorityPayload } from "../../heart/daemon/sanctuary-authority-codec"
import { FileSanctuaryHostAuthority, type HostProposalRequestV1 } from "../../heart/daemon/sanctuary-host-authority"
import { FileSanctuaryTelegramAuthorityGateway, sanctuaryAuthorityPublicKeyDigest } from "../../heart/daemon/sanctuary-telegram-authority-gateway"
import { SanctuaryTelegramAuthorityService } from "../../heart/daemon/sanctuary-telegram-authority-service"
import { createSanctuaryTelegramAuthorityTransport } from "../../senses/telegram-authority-transport"
import type { TelegramAuthorityTransportMetadata, TelegramUpdate } from "../../senses/telegram-client"

const keys = generateKeyPairSync("ed25519")
const publicKeyDigest = sanctuaryAuthorityPublicKeyDigest(keys.privateKey)
const now = "2026-09-16T22:30:00.000Z"
const pins = { expectedTargetHost: "sanctuary", expectedBotId: "123456", expectedOwnerUserId: "42", expectedOwnerChatId: "42", expectedKeyId: "issuer-1", expectedPublicKeyDigest: publicKeyDigest, publicKey: keys.publicKey }
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const signed = (domain: string, payload: any) => signAuthorityPayload({ domain: `ouro.sanctuary.host-${domain}.v1`, keyId: "issuer-1", privateKey: keys.privateKey, payload })
const roots: string[] = []

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = path.resolve(".s5-root-validation", `port-${roots.length}`)
  fs.mkdirSync(root, { recursive: true })
  roots.push(root)
  let nonce = 0
  const options = {
    targetHost: "sanctuary", botId: "123456", ownerUserId: "42", ownerChatId: "42",
    keyId: "issuer-1", publicKeyDigest, ...keys,
    now: () => new Date().toISOString(), nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
  }
  const gateway = new FileSanctuaryTelegramAuthorityGateway(root, options)
  const authority = new FileSanctuaryHostAuthority(root, { ...options, resolveOwnerObservation: (input) => gateway.ownerObservation(input) })
  const updates: TelegramUpdate[] = [{ update_id: 10, message: { message_id: 110, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "run id" } }]
  const api = { request: vi.fn(async (method: string) => method === "getUpdates" ? updates : { message_id: 501 }), stop: vi.fn() }
  const executor = { execute: vi.fn(async (permit: any) => signed("receipt", {
    targetHost: "sanctuary", permitId: permit.payload.permitId, permitDigest: authorityArtifactDigest(permit.domain, permit.payload),
    registrationId: permit.payload.registrationId, state: "verified", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    exitCode: 0, signal: null, timedOut: false, cancelled: false, outputOverflow: false,
    stdoutDigest: digest("0\n"), stderrDigest: digest(""), stdoutBytes: 2, stderrBytes: 0, stdoutExcerpt: "0\n", stderrExcerpt: "",
    cleanup: "cgroup_empty", containment: "approved_root_may_escape", verificationBefore: null, verificationAfter: null, errorCategory: null, publicKeyDigest,
  })) }
  const service = new SanctuaryTelegramAuthorityService({ api: api as never, gateway, hostAuthority: authority, hostExecutor: executor })
  const request = vi.fn((method: string, params: Record<string, unknown>) => service.dispatch(method, params))
  const close = vi.fn()
  const transport = createSanctuaryTelegramAuthorityTransport({ request, close }, pins)
  const port = transport.hostApproval!
  const poll = async () => (await transport.api.request<TelegramUpdate[]>("getUpdates", { offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"] }))[0]!
  const proposal = (metadata: TelegramAuthorityTransportMetadata): HostProposalRequestV1 => ({
    targetHost: "sanctuary", targetResource: "host", command: { kind: "executable", executable: "/usr/bin/id", arguments: ["-u"] },
    workingDirectoryProfile: "host.root.v1", environmentProfile: "host.clean.v1", timeoutMs: 1_000, verification: null,
    ownerObservation: { digest: metadata.observationDigest, updateId: metadata.updateId, userId: metadata.userId, chatId: metadata.chatId, messageId: metadata.messageId! },
  })
  const register = async () => {
    await port.refresh()
    const update = await poll()
    const proposed = proposal(transport.metadataForUpdate(update)!)
    return { update, proposed, registered: await port.register(proposed) }
  }
  const callback = async (userId = 42, handleIndex = 0, messageId = 501) => {
    const sent = api.request.mock.calls.find(([method]) => method === "sendMessage") as any
    const handle = sent[1].reply_markup.inline_keyboard[0][handleIndex].callback_data
    updates.splice(0, 1, { update_id: 11, callback_query: { id: "callback-11", from: { id: userId }, message: { message_id: messageId, chat: { id: 42, type: "private" } }, data: handle } })
    return poll()
  }
  const correlation = (registrationId: string) => ({ registrationId, residentFriendId: "friend-owner", relationshipProfileId: "sanctuary-owner", relationshipProfileVersion: 7, requestId: "req-1", sessionKey: "telegram:123456:42", sessionEventId: "evt-1", residentApprovalId: "approval-1", stewardPolicy: null })
  return { authority, gateway, api, executor, request, close, transport, port, updates, poll, register, callback, proposal, correlation }
}

describe("root host approval port", () => {
  it("fails health closed for unavailable, malformed, stale, future and unpinned signed replies", async () => {
    const f = fixture()
    const good = await f.request("host.status", { registrationId: null }) as any
    const mutations = [
      null, [], {}, { ...good, extra: true }, { health: null },
      { health: { ...good.health, signature: "a".repeat(86) } },
      ...[
        { healthy: false }, { healthy: "true" }, { targetHost: "elsewhere" }, { publicKeyDigest: digest("other") },
        { botId: "other" }, { ownerUserId: "other" }, { ownerChatId: "other" }, { extra: true },
        { observedAt: 4 }, { observedAt: "invalid" }, { observedAt: "2026-09-16T22:30:00Z" },
        { observedAt: "2026-09-16T22:29:30.000Z" }, { observedAt: "2026-09-16T22:30:00.001Z" },
      ].map((patch) => ({ health: signed("health", { ...good.health.payload, ...patch }) })),
      { health: signAuthorityPayload({ ...good.health, privateKey: keys.privateKey, domain: "wrong" }) },
      { health: signAuthorityPayload({ ...good.health, privateKey: keys.privateKey, keyId: "wrong" }) },
    ]
    for (const bad of mutations) {
      expect(await f.port.refresh()).toBe(true)
      f.request.mockResolvedValueOnce(bad)
      expect(await f.port.refresh()).toBe(false)
      expect(f.port.isHealthy()).toBe(false)
    }
    f.request.mockRejectedValueOnce(new Error("unavailable"))
    expect(await f.port.refresh()).toBe(false)
    f.transport.api.stop!()
    expect(await f.port.refresh()).toBe(false)
  })

  it("does not accept foreign, callback, copied, replaced or settled observations as owner requests", async () => {
    const f = fixture()
    await expect(f.port.register(f.proposal({} as never))).rejects.toThrow()
    const { update, registered } = await f.register()
    const original = f.transport.metadataForUpdate(update)!
    f.updates.splice(0, 1, { update_id: 11, message: { message_id: 111, from: { id: 42 }, chat: { id: 42, type: "private" } } })
    // A redelivery replaces the metadata object without refreshing its root observation time.
    await f.poll()
    expect(f.port.acceptsObservation(original)).toBe(false)
    await f.transport.settleTransport(update, "completed")
    const next = await f.poll()
    expect(f.port.acceptsObservation(original)).toBe(false)
    await f.transport.settleTransport(next, "completed")
    f.updates.splice(0, 1, { update_id: 12, message: { message_id: 112, from: { id: 84 }, chat: { id: 84, type: "private" } } })
    const stranger = await f.poll()
    expect(f.port.acceptsObservation(f.transport.metadataForUpdate(stranger)!)).toBe(false)
    await f.transport.settleTransport(stranger, "completed")
    f.updates.splice(0, 1, { update_id: 13, callback_query: { id: "ordinary", from: { id: 42 }, message: { message_id: 700, chat: { id: 42, type: "private" } } } })
    const callback = await f.poll()
    expect(f.port.acceptsObservation(f.transport.metadataForUpdate(callback)!)).toBe(false)
    expect(f.port.callbackForUpdate(callback)).toEqual({ handled: false })
    await expect(f.port.register(f.proposal(original))).rejects.toThrow()
    expect((await f.port.status(registered)).state).toBe("committed")
  })

  it("refuses changed signed registration fields and wrapper coordinates before resident persistence", async () => {
    const f = fixture()
    const { proposed, registered } = await f.register()
    const mutations: any[] = [
      null, {}, { ...registered, extra: true }, { ...registered, telegramMessageId: 999 },
      ...[
        { extra: true }, { targetResource: "" }, { ownerMessageId: 110 }, { ownerMessageId: "bad" }, { ownerUpdateId: -1 },
        { telegramMessageId: 0 }, { registrationId: "bad" }, { nonce: "bad" }, { botId: "other" },
        { promptDigest: "bad" }, { proposalDigest: "bad" }, { prompt: 5 }, { prompt: "bad" },
        { marker: "wrong" }, { displayedProposalDigest: digest("changed") }, { timeoutMs: 999 }, { timeoutMs: 900_001 },
        { registeredAt: "2026-09-16T22:36:00.000Z" }, { registeredAt: "2026-09-16T22:29:59.000Z" },
        { workingDirectoryProfile: "wrong" }, { environmentProfile: "wrong" }, { command: null },
        { command: { kind: "other", executable: "/bin/id", arguments: [] } }, { command: { kind: "executable", executable: 4, arguments: [] } },
        { command: { kind: "executable", executable: "/bin/id", arguments: null } }, { command: { kind: "executable", executable: "/bin/id", arguments: [""] } },
        { command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: 4 } },
        { verification: {} }, { verification: { profile: "", expectedStateDigest: digest("") } }, { verification: { profile: "file.digest.v1", expectedStateDigest: "bad" } },
      ].map((patch) => ({ ...registered, registration: signed("registration", { ...registered.registration.payload, ...patch }) })),
    ]
    for (const value of mutations) {
      f.request.mockResolvedValueOnce(value)
      await expect(f.port.register(proposed), JSON.stringify(value)).rejects.toThrow()
    }
    f.request.mockRejectedValueOnce(new Error("root send failed"))
    await expect(f.port.register(proposed)).rejects.toThrow("root send failed")
    await expect(f.port.register({ ...proposed, ownerObservation: { ...proposed.ownerObservation, updateId: 500 } })).rejects.toThrow()
  })

  it("rejects changed pin configuration after constructing the transport", async () => {
    const f = fixture()
    const mutable = { ...pins }
    const transport = createSanctuaryTelegramAuthorityTransport({ request: f.request, close: f.close }, mutable)
    mutable.expectedOwnerUserId = "84"
    const update = await transport.api.request<TelegramUpdate[]>("getUpdates", { offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"] })
    await transport.hostApproval!.refresh()
    expect(transport.hostApproval!.acceptsObservation(transport.metadataForUpdate(update[0]!)!)).toBe(true)
  })

  it("requires fresh root health plus the exact current verified owner observation", async () => {
    const f = fixture()
    expect(f.port.isHealthy()).toBe(false)
    expect(await f.port.refresh()).toBe(true)
    expect(f.request).toHaveBeenCalledWith("host.status", { registrationId: null })
    expect(f.port.pins).toEqual(pins)
    expect(Object.isFrozen(f.port.pins)).toBe(true)
    const update = await f.poll()
    const metadata = f.transport.metadataForUpdate(update)!
    expect(f.port.acceptsObservation(metadata)).toBe(true)
    expect(f.port.acceptsObservation({ ...metadata })).toBe(false)
    vi.setSystemTime(Date.parse(now) + 30_000)
    expect(f.port.isHealthy()).toBe(false)
    expect(f.port.acceptsObservation(metadata)).toBe(false)
    await f.port.refresh()
    expect(f.port.acceptsObservation(metadata)).toBe(true)
    vi.setSystemTime(Date.parse(now) + 300_000)
    await f.port.refresh()
    expect(f.port.acceptsObservation(metadata)).toBe(false)
    f.transport.api.stop!()
    expect(f.port.isHealthy()).toBe(false)
  })

  it("registers exact proposals, reads signed status and executes only through the root protocol", async () => {
    const f = fixture()
    const { update, proposed, registered } = await f.register()
    expect(f.request).toHaveBeenCalledWith("host.approval", { proposal: proposed })
    expect(registered.registration.payload.targetResource).toBe("host")
    expect(JSON.stringify(registered)).not.toContain("ouh:")
    const status = await f.port.status(registered)
    expect(status).toMatchObject({ state: "committed", execution: "terminal", statusDigest: expect.stringMatching(/^sha256:/) })
    expect(f.port.callbackForUpdate(update)).toEqual({ handled: false })
    await f.transport.settleTransport(update, "completed")
    const callback = await f.callback()
    expect(f.port.callbackForUpdate(callback)).toEqual({ handled: true, registrationId: registered.registrationId })
    expect((await f.port.status(registered)).decision?.payload.decision).toBe("approve")
    const correlation = f.correlation(registered.registrationId)
    await f.port.execute(correlation)
    expect(f.request).toHaveBeenCalledWith("host.execute", { correlation })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const terminal = await f.port.status(registered)
    expect(terminal).toMatchObject({ state: "executed", receipt: { payload: { state: "verified", stdoutExcerpt: "0\n" } }, permit: { payload: correlation } })
    const statusResponse = await f.request("host.status", { registrationId: registered.registrationId }) as any
    expect(verifyAuthorityPayload({ artifact: statusResponse.authority, expectedDomain: "ouro.sanctuary.host-status.v1", expectedKeyId: pins.expectedKeyId, publicKey: keys.publicKey })).toMatchObject({ status: { receipt: terminal.receipt, permit: terminal.permit } })
  })

  it.each([42, 84])("claims stale/unauthorized callbacks without running root code (%s)", async (owner) => {
    const f = fixture()
    const { update, registered } = await f.register()
    await f.transport.settleTransport(update, "completed")
    if (owner === 42) vi.setSystemTime(Date.parse(now) + 300_001)
    const callback = await f.callback(owner)
    expect(f.port.callbackForUpdate(callback)).toEqual({ handled: true, registrationId: registered.registrationId })
    expect(f.executor.execute).not.toHaveBeenCalled()
    expect((await f.port.status(registered)).state).toBe(owner === 42 ? "expired" : "committed")
    await f.transport.settleTransport(callback, "completed")
    expect(f.port.callbackForUpdate(callback)).toEqual({ handled: false })
  })

  it("preserves signed denial and rejects unsigned or tampered registered status", async () => {
    const f = fixture()
    const { update, registered } = await f.register()
    await f.transport.settleTransport(update, "completed")
    const callback = await f.callback(42, 1)
    expect(f.port.callbackForUpdate(callback)).toEqual({ handled: true, registrationId: registered.registrationId })
    expect((await f.port.status(registered)).state).toBe("denied")
    const good = await f.request("host.status", { registrationId: registered.registrationId }) as any
    const { authority, ...legacy } = good
    const candidates: any[] = [
      null, [], legacy, { ...good, state: "expired" }, { ...good, extra: true },
      { ...good, authority: signed("status", { ...authority.payload, observedAt: "2026-09-16T22:29:30.000Z" }) },
      ...[
        { registrationId: "wrong" }, { state: "invented" }, { state: "committed" }, { state: "approved" },
        { cardPending: 1 }, { execution: "invented" }, { execution: "running" }, { proposalDigest: digest("changed") },
        { expiresAt: now }, { telegramMessageId: 1 }, { decision: null }, { receipt: {} }, { permit: {} },
        { executionError: "" }, { maintenanceError: 7 },
      ].map((patch) => {
        const status = { ...legacy, ...patch }
        return { ...status, authority: signed("status", { ...authority.payload, status }) }
      }),
    ]
    for (const value of candidates) {
      f.request.mockResolvedValueOnce(value)
      await expect(f.port.status(registered)).rejects.toThrow()
    }
    f.transport.api.stop!()
    await expect(f.port.status(registered)).rejects.toThrow()
  })

  it("rejects changed decisions, permits and receipts even when root-signed", async () => {
    const f = fixture()
    const { update, registered } = await f.register()
    await f.transport.settleTransport(update, "completed")
    await f.callback()
    await f.port.execute(f.correlation(registered.registrationId))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const good = await f.request("host.status", { registrationId: registered.registrationId }) as any
    const resign = (field: string, patch: any) => {
      const { authority, ...status } = good
      status[field] = signed(field, { ...status[field].payload, ...patch })
      return { ...status, authority: signed("status", { ...authority.payload, status }) }
    }
    const patches: Record<string, any[]> = {
      decision: [
        { registrationId: "wrong" }, { registrationDigest: digest("wrong") }, { decision: "no" }, { decision: "deny" },
        { callbackQueryId: "" }, { callbackObservationDigest: "bad" }, { nonce: "bad" },
        { decidedAt: "2026-09-16T22:29:59.000Z" }, { decidedAt: "2026-09-16T22:35:00.001Z" },
      ],
      permit: [
        { targetHost: "other" }, { publicKeyDigest: digest("other") }, { registrationId: "bad" }, { registrationDigest: digest("bad") },
        { targetResource: "other" }, { command: { kind: "executable", executable: "/bin/false", arguments: [] } },
        { callbackObservationDigest: digest("bad") }, { permitId: "bad" }, { nonce: "bad" }, { scriptDigest: digest("bad") },
        { environmentProfileDigest: digest("bad") }, { effectClass: "other" }, { executionProfile: "other" },
        { issuedAt: "2026-09-16T22:29:59.000Z" }, { issuedAt: "2026-09-16T22:32:00.001Z" },
        { expiresAt: now }, { expiresAt: "2026-09-16T22:32:00.001Z" },
      ],
      receipt: [
        { targetHost: "other" }, { publicKeyDigest: digest("other") }, { registrationId: "other" }, { permitId: "other" }, { permitDigest: digest("bad") },
        { state: "other" }, { startedAt: "2026-09-16T22:29:59.000Z" }, { completedAt: "2026-09-16T22:29:59.000Z" },
        { exitCode: -1 }, { signal: "" }, { timedOut: 1 }, { stdoutDigest: "bad" }, { stderrBytes: -1 },
        { stdoutExcerpt: 1 }, { stderrExcerpt: "x".repeat(4_097) }, { cleanup: "other" }, { containment: "other" },
        { errorCategory: "" }, { verificationBefore: {} }, { verificationBefore: { digest: "bad" } },
        { stdoutDigest: [digest("0\n")] },
        { verificationAfter: {} }, { verificationAfter: { matches: "yes", digest: digest("") } }, { verificationAfter: { matches: true, digest: "bad" } },
      ],
    }
    for (const [field, values] of Object.entries(patches)) for (const patch of values) {
      f.request.mockResolvedValueOnce(resign(field, patch))
      await expect(f.port.status(registered), `${field} ${JSON.stringify(patch)}`).rejects.toThrow()
    }
    for (const field of ["decision", "permit", "receipt"]) {
      const { authority, ...status } = good
      delete status[field]
      f.request.mockResolvedValueOnce({ ...status, authority: signed("status", { ...authority.payload, status }) })
      await expect(f.port.status(registered)).rejects.toThrow()
    }
    for (const matches of [null, true, false]) {
      const terminal = resign("receipt", { state: "ambiguous", exitCode: null, signal: "SIGKILL", errorCategory: "supervisor_failure", verificationBefore: { digest: digest("") }, verificationAfter: { matches, digest: digest("") } })
      f.request.mockResolvedValueOnce(terminal)
      expect((await f.port.status(registered)).receipt?.payload.state).toBe("ambiguous")
    }
  })

  it("checks exact correlation requests and execute acknowledgement shapes without trusting execution state", async () => {
    const f = fixture()
    await expect(f.port.execute(f.correlation("bad"))).rejects.toThrow()
    await f.port.refresh()
    const value = f.correlation(`hostreg-${"a".repeat(43)}`)
    for (const input of [null, {}, { ...value, extra: 1 }, ...[
      { registrationId: "bad" }, { residentFriendId: "" }, { relationshipProfileId: "x".repeat(257) },
      { relationshipProfileVersion: 0 }, { stewardPolicy: {} }, { stewardPolicy: { key: "", version: 1, digest: digest("") } },
      { stewardPolicy: { key: "policy", version: 0, digest: digest("") } }, { stewardPolicy: { key: "policy", version: 1, digest: "bad" } },
    ].map((patch) => ({ ...value, ...patch }))]) {
      await expect(f.port.execute(input as never)).rejects.toThrow()
    }
    for (const response of [null, {}, { registrationId: "wrong", permitId: `permit-${"a".repeat(43)}`, state: "executing" }, { registrationId: value.registrationId, permitId: "bad", state: "executing" }, { registrationId: value.registrationId, permitId: `permit-${"a".repeat(43)}`, state: "executed" }]) {
      f.request.mockResolvedValueOnce(response)
      await expect(f.port.execute(value)).rejects.toThrow()
    }
    const withPolicy = { ...value, stewardPolicy: { key: "policy", version: 1, digest: digest("") } }
    f.request.mockResolvedValueOnce({ registrationId: value.registrationId, permitId: `permit-${"a".repeat(43)}`, state: "executing" })
    await expect(f.port.execute(withPolicy)).resolves.toBeUndefined()
    expect(f.request).toHaveBeenLastCalledWith("host.execute", { correlation: withPolicy })
    f.request.mockRejectedValueOnce(new Error("unavailable"))
    await expect(f.port.execute(value)).rejects.toThrow("unavailable")
  })

  it("requires callback claims to be signed and bound to the exact verified observation", async () => {
    const f = fixture()
    const { update } = await f.register()
    await f.transport.settleTransport(update, "completed")
    const callback = await f.callback()
    const good = await f.request("telegram.poll", {}) as any
    const replacements = [
      null, {},
      ...[
        { targetHost: "wrong" }, { botId: "wrong" }, { ownerUserId: "wrong" }, { ownerChatId: "wrong" }, { publicKeyDigest: digest("wrong") },
        { handled: false }, { observationDigest: digest("wrong") }, { callbackQueryId: "wrong" }, { registrationId: "bad" },
        { registrationId: [good.hostCallback.payload.registrationId], decision: null },
        { decision: signed("decision", { ...good.hostDecision.payload, decision: "invented" }) },
        { decision: signed("decision", { ...good.hostDecision.payload, nonce: ["b".repeat(43)] }) },
        { decision: signed("decision", { ...good.hostDecision.payload, registrationId: `hostreg-${"z".repeat(43)}` }) },
        { decision: signed("decision", { ...good.hostDecision.payload, callbackQueryId: "wrong" }) },
        { decision: signed("decision", { ...good.hostDecision.payload, callbackObservationDigest: digest("wrong") }) },
      ].map((patch) => signed("callback", { ...good.hostCallback.payload, ...patch })),
    ]
    for (const claim of replacements) {
      f.request.mockResolvedValueOnce({ ...good, hostCallback: claim })
      await f.poll()
      expect(() => f.port.callbackForUpdate(callback)).toThrow()
    }
    expect(() => f.port.callbackForUpdate({ ...callback, callback_query: { ...callback.callback_query!, data: "modified" } })).toThrow(/changed/u)
  })

  it("validates signed script permits and verification receipts across running and restart recovery", async () => {
    const f = fixture()
    await f.port.refresh()
    const update = await f.poll()
    const proposed: HostProposalRequestV1 = {
      ...f.proposal(f.transport.metadataForUpdate(update)!),
      targetResource: "/root/result",
      command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "printf 'ok\\n'\n" },
      verification: { profile: "file.digest.v1", expectedStateDigest: digest("ok\n") },
    }
    const registered = await f.port.register(proposed)
    await f.transport.settleTransport(update, "completed")
    await f.callback()
    let release!: () => void
    const execute = f.executor.execute.getMockImplementation()!
    f.executor.execute.mockImplementationOnce(async (permit) => {
      await new Promise<void>((resolve) => { release = resolve })
      return execute(permit)
    })
    await f.port.execute({ ...f.correlation(registered.registrationId), stewardPolicy: { key: "policy", version: 1, digest: digest("") } })
    expect(await f.port.status(registered)).toMatchObject({ state: "permitted", execution: "running", permit: { payload: { scriptDigest: digest("printf 'ok\\n'\n") } } })
    const snapshot = await f.request("host.status", { registrationId: registered.registrationId }) as any
    const { authority, ...status } = snapshot
    status.execution = "reconciliation_required"
    status.executionError = "Sanctuary host execution failed"
    status.maintenanceError = "Sanctuary host terminal cleanup is pending"
    f.request.mockResolvedValueOnce({ ...status, authority: signed("status", { ...authority.payload, status }) })
    expect(await f.port.status(registered)).toMatchObject({ execution: "reconciliation_required", executionError: status.executionError, maintenanceError: status.maintenanceError })
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((await f.port.status(registered)).state).toBe("executed")
  })

  it("preserves executed/running while root-owned card cleanup is still in flight", async () => {
    const f = fixture()
    const { update, registered } = await f.register()
    await f.transport.settleTransport(update, "completed")
    await f.callback()
    let finishEdit!: () => void
    f.api.request.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishEdit = resolve })
      return { message_id: 501 }
    })
    await f.port.execute(f.correlation(registered.registrationId))
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(await f.port.status(registered)).toMatchObject({ state: "executed", execution: "running", receipt: { payload: { state: "verified" } } })
    } finally {
      finishEdit()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect((await f.port.status(registered)).execution).toBe("terminal")
  })

  it("claims callbacks with a wrong handle/message and reused query id without deriving another decision", async () => {
    const f = fixture()
    const { update, registered } = await f.register()
    await f.transport.settleTransport(update, "completed")
    const callback = await f.callback()
    await f.transport.settleTransport(callback, "completed")
    f.updates.splice(0, 1, { update_id: 12, callback_query: { ...callback.callback_query!, data: "not-a-root-handle" } })
    const repeated = await f.poll()
    expect(f.port.callbackForUpdate(repeated)).toEqual({ handled: true, registrationId: registered.registrationId })
    expect((await f.request("telegram.poll", {}) as any).hostCallback.payload.decision).toBeNull()
    await f.transport.settleTransport(repeated, "completed")
    f.updates.splice(0, 1, { update_id: 13, callback_query: { ...callback.callback_query!, id: "wrong-message", message: { ...callback.callback_query!.message!, message_id: 999 } } })
    expect(f.port.callbackForUpdate(await f.poll())).toEqual({ handled: true, registrationId: registered.registrationId })
  })

  it("validates the exact S4 proposal schema before outbound approval or recovered-registration lookup", async () => {
    const f = fixture()
    const { proposed, registered } = await f.register()
    const invalid = [
      { ...proposed, extra: true }, { ...proposed, timeoutMs: 900_001 },
      { ...proposed, ownerObservation: { ...proposed.ownerObservation, messageId: 110 } },
      { ...proposed, command: { kind: "executable", executable: "id", arguments: [] } },
      { ...proposed, command: { kind: "executable", executable: "/bin/sh", arguments: ["-c", "id"] } },
      { ...proposed, command: { kind: "executable", executable: "/bin/id", arguments: Array(65).fill("-u") } },
      { ...proposed, command: { kind: "script", interpreter: "/bin/sh", arguments: [], script: "id\r\n" } },
      { ...proposed, verification: { profile: "other", expectedStateDigest: digest("") } },
    ]
    for (const proposal of invalid) {
      f.request.mockClear()
      await expect(f.port.register(proposal as never)).rejects.toThrow()
      expect(f.request).not.toHaveBeenCalled()
    }
    for (const proposal of invalid.slice(2)) {
      const payload: any = {
        ...registered.registration.payload,
        command: proposal.command,
        verification: proposal.verification,
        ownerMessageId: proposal.ownerObservation.messageId,
      }
      const commitment = authorityArtifactDigest("ouro.sanctuary.host-proposal.v1", { ...proposal, expiresAt: registered.expiresAt })
      payload.prompt = payload.prompt.replaceAll(payload.proposalDigest, commitment)
      payload.promptDigest = digest(payload.prompt)
      payload.proposalDigest = commitment
      payload.displayedProposalDigest = commitment
      f.request.mockClear()
      await expect(f.port.status({ ...registered, registration: signed("registration", payload) })).rejects.toThrow()
      expect(f.request).not.toHaveBeenCalled()
    }
  })

  it("claims an orphaned approval's invalidated callback by its root-owned digest without authorizing it", async () => {
    const f = fixture()
    await f.port.refresh()
    const update = await f.poll()
    vi.spyOn(f.authority, "commit").mockImplementationOnce(() => { throw new Error("crash before commit") })
    await expect(f.port.register(f.proposal(f.transport.metadataForUpdate(update)!))).rejects.toThrow("crash before commit")
    await f.transport.settleTransport(update, "completed")
    const callback = await f.callback()
    expect(f.port.callbackForUpdate(callback)).toEqual({ handled: true, registrationId: expect.stringMatching(/^hostreg-/) })
    expect(f.executor.execute).not.toHaveBeenCalled()
    expect((await f.request("telegram.poll", {}) as any).hostCallback.payload.decision).toBeNull()
  })

  it("rejects coercible correlation identifiers before asking root to execute", async () => {
    const f = fixture()
    await f.port.refresh()
    const correlation = { ...f.correlation(`hostreg-${"a".repeat(43)}`), registrationId: [`hostreg-${"a".repeat(43)}`] }
    f.request.mockClear()
    await expect(f.port.execute(correlation as never)).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
  })
})
