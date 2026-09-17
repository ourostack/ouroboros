import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createSanctuaryTelegramAuthorityServer,
  SanctuaryTelegramAuthorityService,
  SocketSanctuaryTelegramAuthorityClient,
} from "../../../heart/daemon/sanctuary-telegram-authority-service"
import {
  FileSanctuaryTelegramAuthorityGateway,
  sanctuaryAuthorityPublicKeyDigest,
  sanctuaryTelegramAuthorityStatePath,
} from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import { authorityArtifactDigest, signAuthorityPayload, verifyAuthorityPayload } from "../../../heart/daemon/sanctuary-authority-codec"
import { FileSanctuaryHostAuthority, type HostProposalRequestV1 } from "../../../heart/daemon/sanctuary-host-authority"
import { FIXED_ADMISSION_ACKNOWLEDGEMENT } from "../../../senses/telegram-effect-adapter"
import type { TelegramBotApi, TelegramUpdate } from "../../../senses/telegram-client"

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "s-"))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

function message(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      text: `update ${updateId}`,
    },
  }
}

function rawRequest(socketPath: string, contents: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let response = ""
    socket.setEncoding("utf8")
    socket.once("error", reject)
    socket.on("data", (chunk) => { response += chunk })
    socket.once("close", () => resolve(response))
    socket.once("connect", () => socket.end(contents))
  })
}

function fixture() {
  const keys = generateKeyPairSync("ed25519")
  let nonce = 0
  const agentRoot = root()
  const publicKeyDigest = sanctuaryAuthorityPublicKeyDigest(keys.privateKey)
  const gateway = new FileSanctuaryTelegramAuthorityGateway(agentRoot, {
    targetHost: "sanctuary",
    botId: "123456",
    ownerUserId: "42",
    ownerChatId: "42",
    keyId: "issuer-1",
    publicKeyDigest,
    privateKey: keys.privateKey,
    now: () => "2026-09-16T22:30:00.000Z",
    nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
  })
  const updates = [message(10)]
  const api: TelegramBotApi = {
    request: vi.fn(async (method) => method === "getUpdates" ? updates : { method }),
    stop: vi.fn(),
  }
  const hostAuthority = new FileSanctuaryHostAuthority(agentRoot, {
    targetHost: "sanctuary",
    botId: "123456",
    ownerUserId: "42",
    ownerChatId: "42",
    keyId: "issuer-1",
    publicKeyDigest,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    now: () => "2026-09-16T22:30:00.000Z",
    nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
    resolveOwnerObservation: (input) => gateway.ownerObservation(input),
  })
  const hostExecutor = { execute: vi.fn(async (permit) => signAuthorityPayload({
    domain: "ouro.sanctuary.host-receipt.v1",
    keyId: "issuer-1",
    privateKey: keys.privateKey,
    payload: {
      targetHost: "sanctuary",
      registrationId: permit.payload.registrationId,
      permitId: permit.payload.permitId,
      permitDigest: authorityArtifactDigest(permit.domain, permit.payload),
      state: "verified",
      startedAt: "2026-09-16T22:30:00.000Z",
      completedAt: "2026-09-16T22:30:01.000Z",
      publicKeyDigest,
    },
  })), acknowledge: vi.fn() }
  return {
    api,
    gateway,
    hostAuthority,
    hostExecutor,
    updates,
    service: new SanctuaryTelegramAuthorityService({ api, gateway, hostAuthority, hostExecutor }),
  }
}

function hostProposal(observationDigest: string, updateId = 10, messageId = 110): HostProposalRequestV1 {
  return {
    targetHost: "sanctuary",
    targetResource: "host",
    command: { kind: "executable", executable: "/usr/bin/id", arguments: ["-u"] },
    workingDirectoryProfile: "host.root.v1",
    environmentProfile: "host.clean.v1",
    timeoutMs: 60_000,
    verification: null,
    ownerObservation: {
      digest: observationDigest,
      updateId,
      userId: "42",
      chatId: "42",
      messageId: String(messageId),
    },
  }
}

describe("Sanctuary Telegram authority service", () => {
  it("bounds root API requests without timing out an idle 50-second Telegram poll early", async () => {
    const f = fixture()
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
    vi.mocked(f.api.request).mockImplementation(async (_method, _body, signal) => {
      if (!signal) throw new Error("root request has no deadline")
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    })
    try {
      const polled = f.service.dispatch("telegram.poll", {})
      void polled.catch(() => undefined)
      expect(timeout).toHaveBeenCalledWith(60_000)
      controller.abort(new Error("bounded root request"))
      await expect(polled).rejects.toThrow("bounded root request")
    } finally { timeout.mockRestore() }
  })
  it("signs bounded host capability health and the complete registration status using root identity", async () => {
    const f = fixture()
    f.gateway.initializeCursor(0)
    vi.mocked(f.api.request).mockResolvedValueOnce({ id: 123456 })
    const health = await f.service.dispatch("host.status", { registrationId: null }) as any
    expect(health.health).toMatchObject({
      domain: "ouro.sanctuary.host-health.v1",
      payload: { healthy: true, targetHost: "sanctuary", botId: "123456", ownerUserId: "42", ownerChatId: "42" },
    })
    const withoutExecutor = new SanctuaryTelegramAuthorityService({ api: f.api, gateway: f.gateway, hostAuthority: f.hostAuthority })
    vi.mocked(f.api.request).mockResolvedValueOnce({ id: 123456 })
    expect(await withoutExecutor.dispatch("host.status", { registrationId: null })).toMatchObject({
      health: { payload: { healthy: false } },
    })
    const polled = await f.service.dispatch("telegram.poll", {}) as any
    vi.mocked(f.api.request).mockResolvedValueOnce({ message_id: 501 } as never)
    const registered = await f.service.dispatch("host.approval", {
      proposal: hostProposal(authorityArtifactDigest(polled.observation.domain, polled.observation.payload)),
    }) as any
    const status = await f.service.dispatch("host.status", { registrationId: registered.registrationId }) as any
    const { authority, ...legacy } = status
    expect(authority).toMatchObject({
      domain: "ouro.sanctuary.host-status.v1",
      payload: { status: legacy, observedAt: "2026-09-16T22:30:00.000Z" },
    })
    expect(() => verifyAuthorityPayload({ artifact: authority, expectedDomain: authority.domain, expectedKeyId: "issuer-1", publicKey: generateKeyPairSync("ed25519").publicKey })).toThrow()
  })

  it.each(["missing-state", "invalid-state", "token", "identity", "null-identity"])("does not issue healthy root status with %s", async (fault) => {
    const f = fixture()
    f.gateway.initializeCursor(0)
    vi.mocked(f.api.request).mockResolvedValueOnce({ id: 123456 })
    await expect(f.service.dispatch("host.status", { registrationId: null })).resolves.toMatchObject({ health: { payload: { healthy: true } } })
    if (fault === "missing-state" || fault === "invalid-state") {
      const stateFile = sanctuaryTelegramAuthorityStatePath(roots[roots.length - 1]!)
      if (fault === "missing-state") fs.unlinkSync(stateFile)
      else fs.writeFileSync(stateFile, "{}")
    }
    if (fault === "token") vi.mocked(f.api.request).mockRejectedValueOnce(new Error("revoked token"))
    if (fault === "identity") vi.mocked(f.api.request).mockResolvedValueOnce({ id: 999 })
    if (fault === "null-identity") vi.mocked(f.api.request).mockResolvedValueOnce(null)
    await expect(f.service.dispatch("host.status", { registrationId: null })).rejects.toThrow()
  })

  it("claims another owner's host callback without deciding or rejecting transport delivery", async () => {
    const f = fixture()
    const polled = await f.service.dispatch("telegram.poll", {}) as any
    vi.mocked(f.api.request).mockResolvedValueOnce({ message_id: 501 } as never)
    await f.service.dispatch("host.approval", { proposal: hostProposal(authorityArtifactDigest(polled.observation.domain, polled.observation.payload)) })
    const sent = vi.mocked(f.api.request).mock.calls.find(([method]) => method === "sendMessage")!
    const handle = (sent[1] as any).reply_markup.inline_keyboard[0][0].callback_data
    await f.service.dispatch("telegram.settle", { updateId: 10, observationDigest: authorityArtifactDigest(polled.observation.domain, polled.observation.payload), outcome: "completed" })
    f.updates.splice(0, 1, { update_id: 11, callback_query: { id: "other-owner", from: { id: 84 }, message: { message_id: 501, chat: { id: 42, type: "private" } }, data: handle } })
    const result = await f.service.dispatch("telegram.poll", {}) as any
    expect(result).toMatchObject({ hostClaimed: true, hostCallback: { domain: "ouro.sanctuary.host-callback.v1", payload: { handled: true, observationDigest: authorityArtifactDigest(result.observation.domain, result.observation.payload), decision: null } } })
    expect(result).not.toHaveProperty("hostDecision")
    expect(f.hostExecutor.execute).not.toHaveBeenCalled()
    expect(await f.service.dispatch("telegram.poll", {})).toEqual(result)
  })

  it("polls Telegram from the root cursor and returns the exact signed observation with raw update", async () => {
    const f = fixture()
    const result = await f.service.dispatch("telegram.poll", {})
    expect(f.api.request).toHaveBeenCalledWith("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    }, expect.any(AbortSignal))
    expect(result).toMatchObject({
      update: message(10),
      observation: { domain: "ouro.sanctuary.telegram-observation.v1", payload: { updateId: 10 } },
    })
    expect(await f.service.dispatch("telegram.poll", {})).toEqual(result)
  })

  it("settles the exact observation and exposes the advanced logical cursor", async () => {
    const f = fixture()
    const polled = await f.service.dispatch("telegram.poll", {}) as any
    await expect(f.service.dispatch("telegram.settle", {
      updateId: 10,
      observationDigest: authorityArtifactDigest(polled.observation.domain, polled.observation.payload),
      outcome: "completed",
    })).resolves.toEqual({ settled: true, cursor: 11 })
    expect(await f.service.dispatch("telegram.cursor", {})).toEqual({ cursor: 11 })
  })

  it("owns host approval send, registration, status, prompt prefix, handles, and card mutation", async () => {
    const f = fixture()
    const polled = await f.service.dispatch("telegram.poll", {}) as any
    vi.mocked(f.api.request).mockResolvedValueOnce({ message_id: 501 } as never)
    const result = await f.service.dispatch("host.approval", {
      proposal: hostProposal(authorityArtifactDigest(polled.observation.domain, polled.observation.payload)),
    }) as any
    expect(result).toMatchObject({
      registrationId: expect.stringMatching(/^hostreg-/u),
      telegramMessageId: 501,
      expiresAt: "2026-09-16T22:35:00.000Z",
      registration: { domain: "ouro.sanctuary.host-registration.v1" },
    })
    const sent = vi.mocked(f.api.request).mock.calls.find(([method]) => method === "sendMessage")
    expect(sent?.[1]).toMatchObject({
      chat_id: "42",
      parse_mode: "HTML",
      text: expect.stringContaining("OURO ROOT HOST APPROVAL"),
      reply_markup: expect.any(Object),
    })
    await expect(f.service.dispatch("host.status", { registrationId: result.registrationId })).resolves.toMatchObject({
      state: "committed",
      telegramMessageId: 501,
    })
    const handle = (sent?.[1] as any).reply_markup.inline_keyboard[0][0].callback_data
    await expect(f.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "<b>OURO ROOT HOST APPROVAL</b>\nforged" },
    })).rejects.toThrow(/root-owned/u)
    await expect(f.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "ordinary", reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: handle }]] } },
    })).rejects.toThrow(/root-owned/u)
    await expect(f.service.dispatch("telegram.request", {
      method: "editMessageText",
      body: { chat_id: "42", message_id: 501, text: "changed" },
    })).rejects.toThrow(/root-owned/u)
  })

  it("translates an exact root-observed host callback into one byte-stable signed decision", async () => {
    const f = fixture()
    const polled = await f.service.dispatch("telegram.poll", {}) as any
    vi.mocked(f.api.request).mockResolvedValueOnce({ message_id: 501 } as never)
    const registered = await f.service.dispatch("host.approval", {
      proposal: hostProposal(authorityArtifactDigest(polled.observation.domain, polled.observation.payload)),
    }) as any
    const send = vi.mocked(f.api.request).mock.calls.find(([method]) => method === "sendMessage")
    const approveHandle = (send?.[1] as any).reply_markup.inline_keyboard[0][0].callback_data
    await f.service.dispatch("telegram.settle", {
      updateId: 10,
      observationDigest: authorityArtifactDigest(polled.observation.domain, polled.observation.payload),
      outcome: "completed",
    })
    f.updates.splice(0, 1, {
      update_id: 11,
      callback_query: {
        id: "host-callback-11",
        from: { id: 42 },
        message: { message_id: 501, chat: { id: 42, type: "private" } },
        data: approveHandle,
      },
    })
    const decision = await f.service.dispatch("telegram.poll", {}) as any
    expect(JSON.stringify(decision)).not.toContain(approveHandle)
    expect(decision.update.callback_query.data).toBe("root-host-callback")
    expect(f.gateway.record(11)!.rawUpdate.callback_query!.data).toBe(approveHandle)
    expect(decision.hostDecision).toMatchObject({
      domain: "ouro.sanctuary.host-decision.v1",
      payload: { registrationId: registered.registrationId, decision: "approve" },
    })
    expect(vi.mocked(f.api.request).mock.calls.map(([method, body]) => [method, body])).toContainEqual([
      "editMessageText",
      expect.objectContaining({
        chat_id: "42",
        message_id: 501,
        text: expect.stringContaining("Approved. Root execution is pending."),
        reply_markup: { inline_keyboard: [] },
      }),
    ])
    expect(await f.service.dispatch("telegram.poll", {})).toEqual(decision)

    const executeNow = f.hostExecutor.execute.getMockImplementation()!
    let releaseExecution!: () => void
    f.hostExecutor.execute.mockImplementationOnce(async (permit) => new Promise((resolve) => {
      releaseExecution = () => { void executeNow(permit).then(resolve) }
    }))
    const execution = await f.service.dispatch("host.execute", {
      correlation: {
        registrationId: registered.registrationId,
        residentFriendId: "friend-owner",
        relationshipProfileId: "sanctuary-owner",
        relationshipProfileVersion: 7,
        requestId: "request-1",
        sessionKey: "telegram:123456:42",
        sessionEventId: "evt_1234567890",
        residentApprovalId: "approval-1",
        stewardPolicy: null,
      },
    }) as any
    expect(execution).toMatchObject({
      registrationId: registered.registrationId,
      permitId: expect.stringMatching(/^permit-/u),
      state: "executing",
    })
    expect(f.hostExecutor.execute).toHaveBeenCalledOnce()
    const residentStatus = await f.service.dispatch("host.status", { registrationId: registered.registrationId }) as any
    expect(residentStatus.permit.domain).toBe("ouro.sanctuary.host-attempt.v1")
    expect(JSON.stringify(residentStatus)).not.toContain(f.hostExecutor.execute.mock.calls[0]![0].signature)
    expect(JSON.stringify(residentStatus)).not.toContain("ouro.sanctuary.host-permit.v1")
    await expect(f.service.dispatch("host.status", { registrationId: registered.registrationId })).resolves.toMatchObject({
      state: "permitted",
      execution: "running",
      cardPending: false,
    })
    const restartedService = new SanctuaryTelegramAuthorityService({
      api: f.api,
      gateway: f.gateway,
      hostAuthority: f.hostAuthority,
      hostExecutor: f.hostExecutor,
    })
    await expect(restartedService.dispatch("host.status", { registrationId: registered.registrationId })).resolves.toMatchObject({
      state: "permitted",
      execution: "reconciliation_required",
    })
    await expect(f.service.dispatch("telegram.request", {
      method: "getMe",
      body: {},
    })).resolves.toEqual({ method: "getMe" })
    f.hostExecutor.acknowledge.mockImplementationOnce(() => { throw new Error("cleanup interrupted") })
    releaseExecution()
    await vi.waitFor(() => expect(f.hostExecutor.acknowledge).toHaveBeenCalledWith(execution.permitId))
    await vi.waitFor(async () => {
      await expect(f.service.dispatch("host.status", { registrationId: registered.registrationId })).resolves.toMatchObject({
        state: "executed",
        execution: "terminal",
      })
    })
    expect(f.hostExecutor.execute.mock.calls[0]![0]).toMatchObject({
      domain: "ouro.sanctuary.host-permit.v1",
      payload: {
        registrationId: registered.registrationId,
        callbackObservationDigest: authorityArtifactDigest(decision.observation.domain, decision.observation.payload),
      },
    })
    await expect(f.service.dispatch("host.status", { registrationId: registered.registrationId })).resolves.toMatchObject({
      state: "executed",
      execution: "terminal",
      cardPending: false,
      receipt: { payload: { state: "verified" } },
    })
    expect(f.hostExecutor.acknowledge).toHaveBeenCalledTimes(3)
    expect(vi.mocked(f.api.request).mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "editMessageText",
      expect.objectContaining({ text: expect.stringContaining("Execution completed and verification succeeded.") }),
    ])
    f.hostExecutor.acknowledge.mockImplementationOnce(() => { throw new Error("cleanup interrupted") })
    await expect(f.service.dispatch("host.status", { registrationId: registered.registrationId })).resolves.toMatchObject({
      state: "executed",
      execution: "terminal",
      maintenanceError: "Sanctuary host terminal cleanup is pending",
    })
    await expect(f.service.dispatch("host.execute", {
      correlation: {
        registrationId: registered.registrationId,
        residentFriendId: "friend-owner",
        relationshipProfileId: "sanctuary-owner",
        relationshipProfileVersion: 7,
        requestId: "request-1",
        sessionKey: "telegram:123456:42",
        sessionEventId: "evt_1234567890",
        residentApprovalId: "approval-1",
        stewardPolicy: null,
      },
    })).rejects.toThrow(/state|permit/u)

    await f.service.dispatch("telegram.settle", {
      updateId: 11,
      observationDigest: authorityArtifactDigest(decision.observation.domain, decision.observation.payload),
      outcome: "completed",
    })
    f.updates.splice(0, 1, message(12))
    const secondObservation = await f.service.dispatch("telegram.poll", {}) as any
    vi.mocked(f.api.request).mockResolvedValueOnce({ message_id: 502 } as never)
    const secondRegistration = await f.service.dispatch("host.approval", {
      proposal: hostProposal(
        authorityArtifactDigest(secondObservation.observation.domain, secondObservation.observation.payload),
        12,
        112,
      ),
    }) as any
    const secondSend = vi.mocked(f.api.request).mock.calls.filter(([method]) => method === "sendMessage").at(-1)
    const secondApproveHandle = (secondSend?.[1] as any).reply_markup.inline_keyboard[0][0].callback_data
    await f.service.dispatch("telegram.settle", {
      updateId: 12,
      observationDigest: authorityArtifactDigest(secondObservation.observation.domain, secondObservation.observation.payload),
      outcome: "completed",
    })
    f.updates.splice(0, 1, {
      update_id: 13,
      callback_query: {
        id: "host-callback-13",
        from: { id: 42 },
        message: { message_id: 502, chat: { id: 42, type: "private" } },
        data: secondApproveHandle,
      },
    })
    await f.service.dispatch("telegram.poll", {})
    f.hostExecutor.execute.mockRejectedValueOnce("supervisor disappeared")
    await expect(f.service.dispatch("host.execute", {
      correlation: {
        registrationId: secondRegistration.registrationId,
        residentFriendId: "friend-owner",
        relationshipProfileId: "sanctuary-owner",
        relationshipProfileVersion: 7,
        requestId: "request-2",
        sessionKey: "telegram:123456:43",
        sessionEventId: "evt_1234567891",
        residentApprovalId: "approval-2",
        stewardPolicy: null,
      },
    })).resolves.toMatchObject({ state: "executing" })
    await vi.waitFor(async () => {
      await expect(f.service.dispatch("host.status", { registrationId: secondRegistration.registrationId })).resolves.toMatchObject({
        state: "permitted",
        execution: "reconciliation_required",
        executionError: "Sanctuary host execution failed",
      })
    })
    await expect(f.service.dispatch("host.status", {
      registrationId: `hostreg-${"z".repeat(43)}`,
    })).resolves.toBeNull()
  })

  it("returns a decided callback despite card-edit failure and retries maintenance through status", async () => {
    const f = fixture()
    const polled = await f.service.dispatch("telegram.poll", {}) as any
    vi.mocked(f.api.request).mockResolvedValueOnce({ message_id: 501 } as never)
    await f.service.dispatch("host.approval", {
      proposal: hostProposal(authorityArtifactDigest(polled.observation.domain, polled.observation.payload)),
    })
    const send = vi.mocked(f.api.request).mock.calls.find(([method]) => method === "sendMessage")
    const denyHandle = (send?.[1] as any).reply_markup.inline_keyboard[0][1].callback_data
    await f.service.dispatch("telegram.settle", {
      updateId: 10,
      observationDigest: authorityArtifactDigest(polled.observation.domain, polled.observation.payload),
      outcome: "completed",
    })
    f.updates.splice(0, 1, {
      update_id: 11,
      callback_query: {
        id: "host-callback-deny",
        from: { id: 42 },
        message: { message_id: 501, chat: { id: 42, type: "private" } },
        data: denyHandle,
      },
    })
    vi.mocked(f.api.request).mockImplementationOnce(async (method) => method === "getUpdates" ? f.updates : { method })
    vi.mocked(f.api.request).mockRejectedValueOnce(new Error("lost edit response"))
    vi.mocked(f.api.request).mockRejectedValueOnce(new Error("message was deleted"))
    const decided = await f.service.dispatch("telegram.poll", {}) as any
    expect(decided.hostDecision.payload).toMatchObject({ decision: "deny" })
    await expect(f.service.dispatch("host.status", { registrationId: decided.hostDecision.payload.registrationId })).resolves.toMatchObject({
      state: "denied",
      cardPending: true,
      maintenanceError: "Sanctuary host terminal cleanup is pending",
    })
    await expect(f.service.dispatch("host.status", { registrationId: decided.hostDecision.payload.registrationId })).resolves.toMatchObject({
      state: "denied",
      cardPending: false,
    })
  })

  it("settles a distinct callback redelivery after its host registration is terminal", async () => {
    const f = fixture()
    const observed = await f.service.dispatch("telegram.poll", {}) as any
    vi.mocked(f.api.request).mockResolvedValueOnce({ message_id: 501 } as never)
    await f.service.dispatch("host.approval", {
      proposal: hostProposal(authorityArtifactDigest(observed.observation.domain, observed.observation.payload)),
    })
    const send = vi.mocked(f.api.request).mock.calls.find(([method]) => method === "sendMessage")
    const approveHandle = (send?.[1] as any).reply_markup.inline_keyboard[0][0].callback_data
    await f.service.dispatch("telegram.settle", {
      updateId: 10,
      observationDigest: authorityArtifactDigest(observed.observation.domain, observed.observation.payload),
      outcome: "completed",
    })
    f.updates.splice(0, 1, {
      update_id: 11,
      callback_query: {
        id: "host-callback-first",
        from: { id: 42 },
        message: { message_id: 501, chat: { id: 42, type: "private" } },
        data: approveHandle,
      },
    })
    const first = await f.service.dispatch("telegram.poll", {}) as any
    expect(first.hostDecision.payload.decision).toBe("approve")
    await f.service.dispatch("telegram.settle", {
      updateId: 11,
      observationDigest: authorityArtifactDigest(first.observation.domain, first.observation.payload),
      outcome: "completed",
    })
    f.updates.splice(0, 1, {
      update_id: 12,
      callback_query: {
        id: "host-callback-second",
        from: { id: 42 },
        message: { message_id: 501, chat: { id: 42, type: "private" } },
        data: approveHandle,
      },
    })
    const redelivery = await f.service.dispatch("telegram.poll", {}) as any
    expect(redelivery).toMatchObject({ update: { update_id: 12 } })
    expect(redelivery).not.toHaveProperty("hostDecision")
    await expect(f.service.dispatch("telegram.settle", {
      updateId: 12,
      observationDigest: authorityArtifactDigest(redelivery.observation.domain, redelivery.observation.payload),
      outcome: "completed",
    })).resolves.toEqual({ settled: true, cursor: 13 })
  })

  it("clears background maintenance failure state after successful terminal maintenance", async () => {
    const f = fixture()
    const permitId = `permit-${"a".repeat(43)}`
    const registrationId = `hostreg-${"b".repeat(43)}`
    const receipt = { payload: { permitId } }
    const acknowledge = vi.fn()
    const service = new SanctuaryTelegramAuthorityService({
      api: f.api,
      gateway: f.gateway,
      hostAuthority: {
        expireRegistrations: () => [],
        issuePermit: () => ({ payload: { permitId } }),
        completeExecution: vi.fn(),
        pendingCardEdit: () => null,
      } as never,
      hostExecutor: {
        execute: vi.fn(async () => receipt),
        acknowledge,
      },
    })

    await expect(service.dispatch("host.execute", {
      correlation: { registrationId },
    })).resolves.toEqual({ registrationId, permitId, state: "executing" })
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith(permitId))
  })

  it("refuses malformed methods, params, and Telegram poll responses", async () => {
    const f = fixture()
    await expect(f.service.dispatch("telegram.poll", { extra: true })).rejects.toThrow(/params/u)
    await expect(f.service.dispatch("telegram.settle", {})).rejects.toThrow(/settlement/u)
    await expect(f.service.dispatch("host.execute", {})).rejects.toThrow(/params/u)
    const status = vi.spyOn(f.hostAuthority, "status").mockReturnValueOnce({
      state: "executed",
      receipt: null,
    } as never)
    await expect(f.service.dispatch("host.status", {
      registrationId: `hostreg-${"z".repeat(43)}`,
    })).resolves.toMatchObject({
      maintenanceError: "Sanctuary host terminal cleanup is pending",
    })
    status.mockRestore()
    vi.mocked(f.api.request).mockResolvedValueOnce({ not: "updates" } as never)
    await expect(f.service.dispatch("telegram.poll", {})).rejects.toThrow(/array/u)
    vi.mocked(f.api.request).mockResolvedValueOnce([])
    await expect(f.service.dispatch("telegram.poll", {})).resolves.toBeNull()
    await expect(f.service.dispatch("telegram.cursor", { extra: true })).rejects.toThrow(/params/u)

    const unavailable = new SanctuaryTelegramAuthorityService({
      api: f.api,
      gateway: {
        cursor: () => 0,
        capture: () => undefined,
        poll: () => ({ payload: { updateId: 10 } }),
        record: () => null,
      } as never,
    })
    vi.mocked(f.api.request).mockResolvedValueOnce([])
    await expect(unavailable.dispatch("telegram.poll", {})).rejects.toThrow(/unavailable/u)
    await expect(unavailable.dispatch("host.approval", { proposal: {} })).rejects.toThrow(/unavailable/u)
    await expect(unavailable.dispatch("host.status", { registrationId: "bad" })).rejects.toThrow(/unavailable/u)
    await expect(unavailable.dispatch("host.execute", { correlation: {} })).rejects.toThrow(/unavailable/u)
    await expect(unavailable.dispatch("unknown", {})).rejects.toThrow(/not available/u)

    await expect(f.service.dispatch("host.approval", {})).rejects.toThrow(/params/u)
    await expect(f.service.dispatch("host.status", {})).rejects.toThrow(/params/u)
    const approval = fixture()
    const observed = await approval.service.dispatch("telegram.poll", {}) as any
    vi.mocked(approval.api.request).mockRejectedValueOnce(new Error("send failed ambiguously"))
    await expect(approval.service.dispatch("host.approval", {
      proposal: hostProposal(authorityArtifactDigest(observed.observation.domain, observed.observation.payload)),
    })).rejects.toThrow("send failed ambiguously")
    expect(approval.hostAuthority.ownerMutationFrozen()).toBe(false)
    vi.mocked(approval.api.request).mockResolvedValueOnce({})
    await expect(approval.service.dispatch("host.approval", {
      proposal: hostProposal(authorityArtifactDigest(observed.observation.domain, observed.observation.payload)),
    })).rejects.toThrow(/message result/u)
    expect(approval.hostAuthority.ownerMutationFrozen()).toBe(false)
  })

  it("flushes expired cards and rejects host handles at every recursive markup position", async () => {
    const api = { request: vi.fn(async () => ({ ok: true })), stop: vi.fn() }
    const hostAuthority = {
      expireRegistrations: vi.fn(() => ["hostreg-expired"]),
      pendingCardEdit: vi.fn(() => ({
        telegramMessageId: 12,
        text: "expired",
        revision: "expired",
      })),
      markCardEdited: vi.fn(),
      ownsPrompt: vi.fn(() => false),
      ownerMutationFrozen: vi.fn(() => false),
      ownsHandle: vi.fn((value: string) => value === "private-handle"),
    }
    const gateway = {
      identity: () => ({ ownerChatId: "42" }),
      isAuthorizedChat: () => false,
    }
    const service = new SanctuaryTelegramAuthorityService({
      api,
      gateway: gateway as never,
      hostAuthority: hostAuthority as never,
    })
    await expect(service.dispatch("telegram.request", {
      method: "sendMessage",
      body: {
        chat_id: "42",
        text: "forged",
        reply_markup: { inline_keyboard: [[{ callback_data: "private-handle" }]] },
      },
    })).rejects.toThrow(/root-owned/u)
    expect(hostAuthority.markCardEdited).toHaveBeenCalledWith("hostreg-expired", "expired")
    expect(api.request).toHaveBeenCalledWith("editMessageText", expect.objectContaining({ message_id: 12 }), expect.any(AbortSignal))

    const harmless = fixture()
    await expect(harmless.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: {
        chat_id: "42",
        text: "safe",
        reply_markup: { inline_keyboard: [[{ text: "no callback" }]] },
      },
    })).resolves.toEqual({ method: "sendMessage" })
    await expect(harmless.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "safe", reply_markup: { marker: 42 } },
    })).resolves.toEqual({ method: "sendMessage" })

    const noAuthority = new SanctuaryTelegramAuthorityService({
      api: harmless.api,
      gateway: harmless.gateway,
    })
    await expect(noAuthority.dispatch("telegram.request", {
      method: "sendMessage",
      body: {
        chat_id: "42",
        text: "safe",
        reply_markup: { marker: "ordinary" },
      },
    })).resolves.toEqual({ method: "sendMessage" })

    const missingData = fixture()
    missingData.updates.splice(0, 1, {
      update_id: 10,
      callback_query: {
        id: "callback-no-data",
        from: { id: 42 },
        message: { message_id: 110, chat: { id: 42 } },
      },
    })
    await expect(missingData.service.dispatch("telegram.poll", {})).resolves.toMatchObject({
      update: { callback_query: { id: "callback-no-data" } },
    })
  })

  it("proxies only exact owner, observed callback, and observed file requests", async () => {
    const f = fixture()
    await f.service.dispatch("telegram.poll", {})
    await expect(f.service.dispatch("telegram.request", { method: "getMe", body: {} })).resolves.toEqual({ method: "getMe" })
    await expect(f.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "hello", parse_mode: "HTML" },
    })).resolves.toEqual({ method: "sendMessage" })
    await expect(f.service.dispatch("telegram.request", {
      method: "editMessageText",
      body: { chat_id: "42", message_id: 71, text: "updated" },
    })).resolves.toEqual({ method: "editMessageText" })
    await expect(f.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "84", text: "wrong target" },
    })).rejects.toThrow(/target/u)
    await expect(f.service.dispatch("telegram.request", {
      method: "getUpdates",
      body: {},
    })).rejects.toThrow(/method/u)
    await expect(f.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "" },
    })).rejects.toThrow(/body/u)
    for (const body of [
      null,
      { chat_id: "42" },
      { chat_id: "42", text: "hello", parse_mode: "Markdown" },
      { chat_id: "42", text: "hello", reply_markup: "bad" },
      { chat_id: "42", text: "hello", extra: true },
    ]) {
      await expect(f.service.dispatch("telegram.request", { method: "sendMessage", body })).rejects.toThrow(/body|target/u)
    }
    for (const body of [
      { chat_id: "84", message_id: 71, text: "updated" },
      { chat_id: "42", message_id: 0, text: "updated" },
      { chat_id: "42", message_id: 71, text: "" },
      { chat_id: "42", message_id: 71, text: "updated", parse_mode: "Markdown" },
      { chat_id: "42", message_id: 71, text: "updated", reply_markup: "bad" },
    ]) {
      await expect(f.service.dispatch("telegram.request", { method: "editMessageText", body })).rejects.toThrow(/body|target/u)
    }
    await expect(f.service.dispatch("telegram.request", { method: "getMe", body: { extra: true } })).rejects.toThrow(/body/u)
    await expect(f.service.dispatch("telegram.request", { body: {} } as never)).rejects.toThrow(/params/u)
  })

  it("allows callback acknowledgement and file lookup only after root observation", async () => {
    const keys = generateKeyPairSync("ed25519")
    let nonce = 0
    const gateway = new FileSanctuaryTelegramAuthorityGateway(root(), {
      targetHost: "sanctuary", botId: "123456", ownerUserId: "42", ownerChatId: "42", keyId: "issuer-1",
      publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey), privateKey: keys.privateKey,
      now: () => "2026-09-16T22:30:00.000Z", nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
    })
    gateway.capture([
      { update_id: 20, callback_query: { id: "callback-20", from: { id: 42 }, message: { message_id: 120, chat: { id: 42 } } } },
      { update_id: 21, message: { message_id: 121, from: { id: 42 }, chat: { id: 42, type: "private" }, document: { file_id: "file-21" } } },
      { update_id: 22, message: { message_id: 122, from: { id: 84 }, chat: { id: 84, type: "private" }, text: "hello" } },
    ])
    const api = { request: vi.fn(async (method: string) => method === "getFile" ? { file_path: "documents/file-21.bin", file_size: 4 } : { method }), stop: vi.fn() }
    const downloadFile = vi.fn(async () => ({ body: Buffer.from("data"), contentType: "application/octet-stream" }))
    const service = new SanctuaryTelegramAuthorityService({ api, gateway, downloadFile })
    await expect(service.dispatch("telegram.request", {
      method: "answerCallbackQuery",
      body: { callback_query_id: "callback-20" },
    })).resolves.toEqual({ method: "answerCallbackQuery" })
    await expect(service.dispatch("telegram.request", {
      method: "getFile",
      body: { file_id: "file-21" },
    })).resolves.toEqual({ file_path: "documents/file-21.bin", file_size: 4 })
    await expect(service.dispatch("telegram.file", {
      filePath: "documents/file-21.bin",
    })).resolves.toEqual({
      bodyBase64: Buffer.from("data").toString("base64"),
      contentType: "application/octet-stream",
    })
    expect(downloadFile).toHaveBeenCalledWith("documents/file-21.bin")
    const strangerObservation = gateway.record(22)!
    if (strangerObservation.disposition !== "dispatch") throw new Error("expected dispatch")
    const observationDigest = authorityArtifactDigest(strangerObservation.observation.domain, strangerObservation.observation.payload)
    await expect(service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "84", text: FIXED_ADMISSION_ACKNOWLEDGEMENT },
      observation: { updateId: 22, observationDigest },
    })).resolves.toEqual({ method: "sendMessage" })
    await expect(service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "84", text: "changed" },
      observation: { updateId: 22, observationDigest },
    })).rejects.toThrow(/target/u)
    await service.dispatch("telegram.chat.admit", {
      admissionId: "a".repeat(20), updateId: 22, userId: "84", chatId: "84",
    })
    await expect(service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "84", text: "welcome" },
    })).resolves.toEqual({ method: "sendMessage" })
    await service.dispatch("telegram.chat.revoke", { userId: "84", chatId: "84" })
    await expect(service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "84", text: "after revoke" },
    })).rejects.toThrow(/target/u)
    await expect(service.dispatch("telegram.request", {
      method: "answerCallbackQuery",
      body: { callback_query_id: "callback-missing" },
    })).rejects.toThrow(/callback/u)
    await expect(service.dispatch("telegram.request", {
      method: "getFile",
      body: { file_id: "file-missing" },
    })).rejects.toThrow(/file/u)
    await expect(service.dispatch("telegram.file", { filePath: "documents/unobserved.bin" })).rejects.toThrow(/file/u)
    for (const invalid of [
      null,
      {},
      { file_path: "../secret" },
      { file_path: "documents/file-21.bin", file_size: 1.5 },
      { file_path: "documents/file-21.bin", file_size: -1 },
      { file_path: "documents/file-21.bin", file_size: 20_000_001 },
    ]) {
      api.request.mockResolvedValueOnce(invalid as never)
      await expect(service.dispatch("telegram.request", {
        method: "getFile",
        body: { file_id: "file-21" },
      })).rejects.toThrow(/metadata/u)
    }
    for (const invalid of [
      { body: "not-a-buffer" },
      { body: Buffer.alloc(20_000_001) },
      { body: Buffer.from("data"), contentType: "" },
    ]) {
      downloadFile.mockResolvedValueOnce(invalid as never)
      await expect(service.dispatch("telegram.file", {
        filePath: "documents/file-21.bin",
      })).rejects.toThrow(/response/u)
    }
    downloadFile.mockResolvedValueOnce({ body: Buffer.from("data") })
    await expect(service.dispatch("telegram.file", {
      filePath: "documents/file-21.bin",
    })).resolves.toEqual({ bodyBase64: Buffer.from("data").toString("base64") })
    const serviceWithoutFileTransport = new SanctuaryTelegramAuthorityService({ api, gateway })
    api.request.mockResolvedValueOnce({ file_path: "documents/file-21.bin", file_size: 4 })
    await serviceWithoutFileTransport.dispatch("telegram.request", { method: "getFile", body: { file_id: "file-21" } })
    await expect(serviceWithoutFileTransport.dispatch("telegram.file", {
      filePath: "documents/file-21.bin",
    })).rejects.toThrow(/unavailable/u)
    for (const body of [
      {},
      { callback_query_id: "" },
      { callback_query_id: "callback-20", text: "" },
      { callback_query_id: "callback-20", show_alert: false },
      { callback_query_id: "callback-20", extra: true },
    ]) {
      await expect(service.dispatch("telegram.request", { method: "answerCallbackQuery", body })).rejects.toThrow(/callback/u)
    }
    for (const body of [{}, { file_id: "" }, { file_id: "file-21", extra: true }]) {
      await expect(service.dispatch("telegram.request", { method: "getFile", body })).rejects.toThrow(/file/u)
    }
  })

  it("round-trips bounded requests over the Unix socket and closes cleanly", async () => {
    const f = fixture()
    const socketPath = path.join(root(), "authority.sock")
    const server = createSanctuaryTelegramAuthorityServer({
      socketPath,
      dispatch: (method, params) => f.service.dispatch(method, params),
    })
    await server.listen()
    const client = new SocketSanctuaryTelegramAuthorityClient(socketPath)
    const result = await client.request("telegram.poll", {})
    expect(result).toMatchObject({ observation: { payload: { updateId: 10 } }, update: message(10) })
    client.close()
    await server.close()
  })

  it("returns closed errors for invalid protocol frames, dispatch failures, and oversized requests", async () => {
    const socketPath = path.join(root(), "authority.sock")
    const server = createSanctuaryTelegramAuthorityServer({
      socketPath,
      maxRequestBytes: 128,
      dispatch: async (method) => {
        if (method === "fail") throw new Error("private root failure")
        return true
      },
    })
    await server.listen()
    const client = new SocketSanctuaryTelegramAuthorityClient(socketPath)
    await expect(client.request("fail", {})).rejects.toThrow("Sanctuary authority request failed")
    await expect(client.request("", {})).rejects.toThrow(/method/u)
    await expect(client.request("bad", null as never)).rejects.toThrow(/params/u)
    await expect(client.request("large", { value: "x".repeat(256) })).rejects.toThrow(/closed|large/u)
    client.close()
    await server.close()
    await expect(server.close()).rejects.toThrow()
  })

  it("refuses invalid server/client configuration and malformed raw protocol frames", async () => {
    expect(() => createSanctuaryTelegramAuthorityServer({ socketPath: "relative.sock", dispatch: vi.fn() })).toThrow(/absolute/u)
    expect(() => createSanctuaryTelegramAuthorityServer({ socketPath: path.join(root(), "small.sock"), maxRequestBytes: 1, dispatch: vi.fn() })).toThrow(/limit/u)
    expect(() => createSanctuaryTelegramAuthorityServer({ socketPath: path.join(root(), "float.sock"), maxRequestBytes: 128.5, dispatch: vi.fn() })).toThrow(/limit/u)
    expect(() => createSanctuaryTelegramAuthorityServer({ socketPath: path.join(root(), "timeout.sock"), connectionTimeoutMs: 0, dispatch: vi.fn() })).toThrow(/timeout/u)
    expect(() => new SocketSanctuaryTelegramAuthorityClient("relative.sock")).toThrow(/absolute/u)

    const regularSocketPath = path.join(root(), "regular.sock")
    fs.writeFileSync(regularSocketPath, "do not delete")
    await expect(createSanctuaryTelegramAuthorityServer({
      socketPath: regularSocketPath,
      dispatch: vi.fn(),
    }).listen()).rejects.toThrow(/socket path/u)
    expect(fs.readFileSync(regularSocketPath, "utf8")).toBe("do not delete")

    const linkedRoot = root()
    const actualDirectory = path.join(linkedRoot, "actual")
    const linkedDirectory = path.join(linkedRoot, "linked")
    fs.mkdirSync(actualDirectory)
    fs.symlinkSync(actualDirectory, linkedDirectory)
    await expect(createSanctuaryTelegramAuthorityServer({
      socketPath: path.join(linkedDirectory, "authority.sock"),
      dispatch: vi.fn(),
    }).listen()).rejects.toThrow(/directory/u)

    const missingDirectory = path.join(os.tmpdir(), `s-${process.pid}`)
    roots.push(missingDirectory)
    const nestedSocketPath = path.join(missingDirectory, "authority.sock")
    const nestedServer = createSanctuaryTelegramAuthorityServer({
      socketPath: nestedSocketPath,
      dispatch: vi.fn(async () => true),
    })
    await nestedServer.listen()
    expect(fs.statSync(path.dirname(nestedSocketPath)).isDirectory()).toBe(true)
    await nestedServer.close()

    const socketPath = path.join(root(), "authority.sock")
    const server = createSanctuaryTelegramAuthorityServer({ socketPath, dispatch: vi.fn(async () => true) })
    await server.listen()
    expect(await rawRequest(socketPath, "\n{not-json}\n")).toContain("Sanctuary authority request failed")
    for (const frame of [
      null,
      {},
      { protocolVersion: 2, id: "1", method: "ok", params: {} },
      { protocolVersion: 1, id: "", method: "ok", params: {} },
      { protocolVersion: 1, id: "1", method: "", params: {} },
      { protocolVersion: 1, id: "1", method: "ok", params: [] },
      { protocolVersion: 1, id: "1", method: "ok", params: {}, extra: true },
    ]) {
      expect(await rawRequest(socketPath, `${JSON.stringify(frame)}\n`)).toContain("Sanctuary authority request failed")
    }
    await server.close()

    const idleSocketPath = path.join(root(), "idle.sock")
    const idleServer = createSanctuaryTelegramAuthorityServer({
      socketPath: idleSocketPath,
      connectionTimeoutMs: 5,
      dispatch: vi.fn(),
    })
    await idleServer.listen()
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(idleSocketPath)
      socket.once("error", reject)
      socket.once("close", () => resolve())
    })
    await idleServer.close()
  })
})
