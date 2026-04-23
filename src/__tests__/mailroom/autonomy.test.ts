import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildConfirmedMailSendDecision,
  buildNativeMailAutonomyPolicy,
  evaluateNativeMailSendPolicy,
  type BuildNativeMailAutonomyPolicyInput,
} from "../../mailroom/autonomy"
import { FileMailroomStore } from "../../mailroom/file-store"
import { confirmMailDraftSend, createMailDraft } from "../../mailroom/outbound"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-autonomy-"))
  tempRoots.push(dir)
  return dir
}

function sinkEntries(sinkPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(sinkPath)) return []
  return fs.readFileSync(sinkPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function nativePolicy(overrides: Partial<BuildNativeMailAutonomyPolicyInput> = {}) {
  return buildNativeMailAutonomyPolicy({
    agentId: "slugger",
    mailboxAddress: "slugger@ouro.bot",
    enabled: true,
    killSwitch: false,
    allowedRecipients: ["ari@mendelow.me"],
    allowedDomains: ["trusted.example"],
    maxRecipientsPerMessage: 3,
    rateLimit: { maxSends: 2, windowMs: 60_000 },
    actor: { kind: "human", friendId: "ari", trustLevel: "family" },
    reason: "family approved low-risk native autonomous mail",
    updatedAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  })
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("native mail autonomy", () => {
  it("sends autonomously only when the native-agent policy allows and writes audit state", async () => {
    const minimalPolicy = buildNativeMailAutonomyPolicy({
      agentId: "!!!",
      mailboxAddress: "Agent@OURO.bot",
      enabled: true,
      killSwitch: false,
      maxRecipientsPerMessage: 0,
      rateLimit: { maxSends: -1, windowMs: 0 },
    })
    expect(minimalPolicy).toEqual(expect.objectContaining({
      agentId: "agent",
      mailboxAddress: "agent@ouro.bot",
      allowedRecipients: [],
      allowedDomains: [],
      maxRecipientsPerMessage: 1,
      rateLimit: { maxSends: 0, windowMs: 1 },
    }))
    expect(minimalPolicy).not.toHaveProperty("actor")
    expect(minimalPolicy).not.toHaveProperty("reason")
    expect(minimalPolicy).not.toHaveProperty("updatedAt")

    const root = tempDir()
    const store = new FileMailroomStore({ rootDir: path.join(root, "mailroom") })
    const sinkPath = path.join(root, "outbound-sink.jsonl")
    const actor = { kind: "agent" as const, agentId: "slugger" }
    const policy = nativePolicy()
    const draft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["Ari <ARI@MENDELOW.ME>"],
      subject: "Low-risk check",
      text: "Can you confirm the plan?",
      actor,
      reason: "low-risk autonomous check",
      now: () => new Date("2026-04-23T00:01:00.000Z"),
    })

    const sent = await confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "",
      autonomous: true,
      autonomyPolicy: policy,
      actor,
      reason: "policy-approved autonomous send",
      now: () => new Date("2026-04-23T00:02:00.000Z"),
    })

    expect(sent).toEqual(expect.objectContaining({
      status: "sent",
      sendMode: "autonomous",
      mailboxRole: "agent-native-mailbox",
      sendAuthority: "agent-native",
      policyDecision: expect.objectContaining({
        allowed: true,
        mode: "autonomous",
        code: "allowed",
        policyId: policy.policyId,
      }),
    }))
    expect(sinkEntries(sinkPath)).toEqual([
      expect.objectContaining({
        draftId: draft.id,
        from: "slugger@ouro.bot",
        to: ["ari@mendelow.me"],
        sendMode: "autonomous",
        policyId: policy.policyId,
      }),
    ])
  })

  it("requires confirmation fallback for new recipients and keeps the draft unsent until confirmation", async () => {
    const root = tempDir()
    const store = new FileMailroomStore({ rootDir: path.join(root, "mailroom") })
    const sinkPath = path.join(root, "outbound-sink.jsonl")
    const actor = { kind: "agent" as const, agentId: "slugger" }
    const draft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["new.person@example.net"],
      subject: "Needs confirmation",
      text: "This recipient is not on the autonomous allowlist.",
      actor,
      reason: "prove confirmation fallback",
    })

    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "",
      autonomous: true,
      autonomyPolicy: nativePolicy(),
      actor,
      reason: "autonomous attempt to new recipient",
      now: () => new Date("2026-04-23T00:02:00.000Z"),
    })).rejects.toThrow("requires confirmation")
    expect(sinkEntries(sinkPath)).toEqual([])
    await expect(store.getMailOutbound(draft.id)).resolves.toEqual(expect.objectContaining({ status: "draft" }))

    const sent = await confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "CONFIRM_SEND",
      autonomyPolicy: nativePolicy(),
      actor: { kind: "human", friendId: "ari", trustLevel: "family" },
      reason: "family confirmed new recipient",
      now: () => new Date("2026-04-23T00:03:00.000Z"),
    })

    expect(sent).toEqual(expect.objectContaining({
      status: "sent",
      sendMode: "confirmed",
      policyDecision: expect.objectContaining({
        allowed: true,
        mode: "confirmed",
        code: "explicit-confirmation",
      }),
    }))
    expect(sinkEntries(sinkPath)).toHaveLength(1)
  })

  it("enforces kill switch, recipient limits, rate limits, and delegated send-as-human blocks before transport", async () => {
    const root = tempDir()
    const store = new FileMailroomStore({ rootDir: path.join(root, "mailroom") })
    const sinkPath = path.join(root, "outbound-sink.jsonl")
    const actor = { kind: "agent" as const, agentId: "slugger" }
    const first = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      subject: "First",
      text: "Allowed.",
      actor,
      reason: "seed autonomous rate counter",
    })
    await confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: first.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "",
      autonomous: true,
      autonomyPolicy: nativePolicy({ rateLimit: { maxSends: 1, windowMs: 60_000 } }),
      actor,
      reason: "first autonomous send",
      now: () => new Date("2026-04-23T00:01:00.000Z"),
    })

    const rateLimited = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      subject: "Second",
      text: "This should hit the rate limit.",
      actor,
      reason: "prove rate limit",
    })
    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: rateLimited.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "",
      autonomous: true,
      autonomyPolicy: nativePolicy({ rateLimit: { maxSends: 1, windowMs: 60_000 } }),
      actor,
      reason: "second autonomous send",
      now: () => new Date("2026-04-23T00:01:30.000Z"),
    })).rejects.toThrow("autonomous-rate-limit")

    const tooMany = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me", "ops@trusted.example"],
      subject: "Too many",
      text: "Recipient limit proof.",
      actor,
      reason: "prove recipient limit",
    })
    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: tooMany.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "",
      autonomous: true,
      autonomyPolicy: nativePolicy({ maxRecipientsPerMessage: 1 }),
      actor,
      reason: "recipient limit send",
      now: () => new Date("2026-04-23T00:02:00.000Z"),
    })).rejects.toThrow("recipient-limit-exceeded")

    const killed = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      subject: "Killed",
      text: "Kill switch proof.",
      actor,
      reason: "prove kill switch",
    })
    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: killed.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "",
      autonomous: true,
      autonomyPolicy: nativePolicy({ killSwitch: true }),
      actor,
      reason: "kill switch send",
      now: () => new Date("2026-04-23T00:02:00.000Z"),
    })).rejects.toThrow("autonomy-kill-switch")

    const delegated = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      subject: "Delegated",
      text: "Delegated send-as-human proof.",
      actor,
      reason: "prove delegated send block",
    })
    await store.upsertMailOutbound({
      ...delegated,
      mailboxRole: "delegated-human-mailbox",
      sendAuthority: "delegated-human" as never,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      from: "ari@mendelow.me",
    })
    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: delegated.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "",
      autonomous: true,
      autonomyPolicy: nativePolicy(),
      actor,
      reason: "delegated send-as-human attempt",
      now: () => new Date("2026-04-23T00:02:00.000Z"),
    })).rejects.toThrow("delegated-send-as-human-not-authorized")

    expect(sinkEntries(sinkPath)).toHaveLength(1)
  })

  it("blocks non-draft, wrong-agent, wrong-mailbox, and disabled-policy sends and records confirmed decisions", () => {
    const currentPolicy = nativePolicy()
    const baseDraft = {
      schemaVersion: 1 as const,
      id: "draft_1",
      agentId: "slugger",
      status: "draft" as const,
      mailboxRole: "agent-native-mailbox" as const,
      sendAuthority: "agent-native" as const,
      ownerEmail: null,
      source: null,
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      cc: [],
      bcc: [],
      subject: "Check in",
      text: "Hello.",
      actor: { kind: "agent" as const, agentId: "slugger" },
      reason: "test",
      createdAt: "2026-04-23T00:01:00.000Z",
      updatedAt: "2026-04-23T00:01:00.000Z",
    }

    expect(evaluateNativeMailSendPolicy({
      policy: currentPolicy,
      draft: { ...baseDraft, status: "sent", sentAt: "2026-04-23T00:02:00.000Z" },
      recentOutbound: [],
      now: new Date("2026-04-23T00:03:00.000Z"),
    })).toEqual(expect.objectContaining({ allowed: false, code: "draft-not-sendable" }))

    expect(evaluateNativeMailSendPolicy({
      policy: currentPolicy,
      draft: { ...baseDraft, agentId: "clio" },
      recentOutbound: [],
      now: new Date("2026-04-23T00:03:00.000Z"),
    })).toEqual(expect.objectContaining({ allowed: false, code: "agent-mismatch" }))

    expect(evaluateNativeMailSendPolicy({
      policy: currentPolicy,
      draft: { ...baseDraft, from: "other@ouro.bot" },
      recentOutbound: [],
      now: new Date("2026-04-23T00:03:00.000Z"),
    })).toEqual(expect.objectContaining({ allowed: false, code: "native-mailbox-mismatch" }))

    expect(evaluateNativeMailSendPolicy({
      policy: nativePolicy({ enabled: false }),
      draft: baseDraft,
      recentOutbound: [],
      now: new Date("2026-04-23T00:03:00.000Z"),
    })).toEqual(expect.objectContaining({
      allowed: false,
      mode: "confirmation-required",
      code: "autonomy-policy-disabled",
    }))

    expect(buildConfirmedMailSendDecision({
      draft: baseDraft,
      policy: currentPolicy,
      now: new Date("2026-04-23T00:03:30.000Z"),
    })).toEqual(expect.objectContaining({
      allowed: true,
      mode: "confirmed",
      code: "explicit-confirmation",
      policyId: currentPolicy.policyId,
    }))

    expect(evaluateNativeMailSendPolicy({
      policy: currentPolicy,
      draft: baseDraft,
      recentOutbound: [
        { ...baseDraft, id: "draft_not_sent" },
        { ...baseDraft, id: "draft_confirmed", status: "sent", sendMode: "confirmed", updatedAt: "2026-04-23T00:01:10.000Z" },
        { ...baseDraft, id: "draft_bad_date", status: "sent", sendMode: "autonomous", updatedAt: "not-a-date" },
        { ...baseDraft, id: "draft_autonomous_no_sent_at", status: "sent", sendMode: "autonomous", updatedAt: "2026-04-23T00:01:30.000Z" },
      ],
      now: new Date("2026-04-23T00:02:00.000Z"),
    })).toEqual(expect.objectContaining({
      allowed: true,
      remainingSendsInWindow: 0,
    }))

    expect(evaluateNativeMailSendPolicy({
      policy: currentPolicy,
      draft: baseDraft,
      recentOutbound: [],
    })).toEqual(expect.objectContaining({
      allowed: true,
      evaluatedAt: expect.any(String),
    }))

    const confirmedWithoutPolicy = buildConfirmedMailSendDecision({
      draft: baseDraft,
    })
    expect(confirmedWithoutPolicy).toEqual(expect.objectContaining({
      allowed: true,
      mode: "confirmed",
      code: "explicit-confirmation",
      evaluatedAt: expect.any(String),
    }))
    expect(confirmedWithoutPolicy).not.toHaveProperty("policyId")
  })

  it("counts submitted autonomous provider sends against the rate window before delivery events arrive", () => {
    const currentPolicy = nativePolicy({
      allowedRecipients: ["ari@mendelow.me", "slugger@ouro.bot"],
      rateLimit: { maxSends: 1, windowMs: 60_000 },
    })
    const baseDraft = {
      schemaVersion: 1 as const,
      id: "draft_current",
      agentId: "slugger",
      status: "draft" as const,
      mailboxRole: "agent-native-mailbox" as const,
      sendAuthority: "agent-native" as const,
      ownerEmail: null,
      source: null,
      from: "slugger@ouro.bot",
      to: ["slugger@ouro.bot"],
      cc: [],
      bcc: [],
      subject: "Check in",
      text: "Hello.",
      actor: { kind: "human" as const, friendId: "ari", trustLevel: "family" as const, channel: "mcp" },
      reason: "test",
      createdAt: "2026-04-23T16:11:01.604Z",
      updatedAt: "2026-04-23T16:11:21.410Z",
    }

    expect(evaluateNativeMailSendPolicy({
      policy: currentPolicy,
      draft: baseDraft,
      recentOutbound: [
        {
          ...baseDraft,
          id: "draft_submitted",
          status: "submitted",
          sendMode: "autonomous",
          provider: "azure-communication-services",
          providerMessageId: "acs-operation-1",
          sentAt: "2026-04-23T16:11:21.410Z",
          submittedAt: "2026-04-23T16:11:21.410Z",
          updatedAt: "2026-04-23T16:11:21.410Z",
        },
      ],
      now: new Date("2026-04-23T16:12:00.000Z"),
    })).toEqual(expect.objectContaining({
      allowed: false,
      code: "autonomous-rate-limit",
    }))
  })
})
