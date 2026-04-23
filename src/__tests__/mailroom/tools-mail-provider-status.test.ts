import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { cacheRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import type { MailOutboundRecord } from "../../mailroom/core"
import type { ToolContext } from "../../repertoire/tools-base"

const confirmMailDraftSendMock = vi.hoisted(() => vi.fn())

vi.mock("../../mailroom/outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../mailroom/outbound")>()
  return {
    ...actual,
    confirmMailDraftSend: confirmMailDraftSendMock,
  }
})

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-tools-provider-"))
  tempRoots.push(dir)
  return dir
}

function trustedContext(): ToolContext {
  return {
    signin: async () => undefined,
    context: {
      friend: {
        id: "ari",
        name: "Ari",
        trustLevel: "family",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        schemaVersion: 1,
      },
      channel: {
        channel: "cli",
        senseType: "local",
        availableIntegrations: [],
        supportsMarkdown: false,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    },
  }
}

afterEach(() => {
  confirmMailDraftSendMock.mockReset()
  resetRuntimeCredentialConfigCache()
  resetIdentity()
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("mail_send provider status rendering", () => {
  it("renders provider-submitted sends distinctly from final sent mail", async () => {
    const { mailToolDefinitions } = await import("../../repertoire/tools-mail")
    const sendTool = mailToolDefinitions.find((definition) => definition.tool.function.name === "mail_send")
    if (!sendTool) throw new Error("missing mail_send tool")
    setAgentName("slugger")
    const root = tempDir()
    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath: path.join(root, "mailroom"),
        privateKeys: { "mail-key": "private-key" },
        outbound: {
          transport: "local-sink",
          sinkPath: path.join(root, "sink.jsonl"),
        },
      },
    })
    const submitted: MailOutboundRecord = {
      schemaVersion: 1,
      id: "draft_1",
      agentId: "slugger",
      status: "submitted",
      mailboxRole: "agent-native-mailbox",
      sendAuthority: "agent-native",
      ownerEmail: null,
      source: null,
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      cc: [],
      bcc: [],
      subject: "Provider status",
      text: "Show provider submission accurately.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "confirmed outbound provider send",
      createdAt: "2026-04-23T01:30:00.000Z",
      updatedAt: "2026-04-23T01:31:00.000Z",
      sendMode: "confirmed",
      policyDecision: {
        schemaVersion: 1,
        allowed: true,
        mode: "confirmed",
        code: "explicit-confirmation",
        reason: "Explicit confirmation authorized this native-agent send",
        evaluatedAt: "2026-04-23T01:31:00.000Z",
        recipients: ["ari@mendelow.me"],
        fallback: "none",
      },
      provider: "azure-communication-services",
      providerMessageId: "acs-operation-1",
      submittedAt: "2026-04-23T01:31:00.000Z",
      transport: "azure-communication-services",
      deliveryEvents: [],
    }
    confirmMailDraftSendMock.mockResolvedValueOnce(submitted)

    await expect(sendTool.handler({
      draft_id: "draft_1",
      confirmation: "CONFIRM_SEND",
      reason: "family confirmed provider submit",
    }, trustedContext())).resolves.toBe([
      "Mail submitted: draft_1",
      "status: submitted",
      "mode: confirmed",
      "send authority: native agent mailbox",
      "policy decision: explicit-confirmation",
      "policy fallback: none",
      "transport: azure-communication-services",
      "time: 2026-04-23T01:31:00.000Z",
      "to: ari@mendelow.me",
    ].join("\n"))
    expect(confirmMailDraftSendMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "slugger",
      draftId: "draft_1",
      confirmation: "CONFIRM_SEND",
      reason: "family confirmed provider submit",
    }))

    confirmMailDraftSendMock.mockResolvedValueOnce({
      ...submitted,
      id: "draft_2",
      transport: undefined,
    })
    await expect(sendTool.handler({
      draft_id: "draft_2",
      confirmation: "CONFIRM_SEND",
      reason: "provider-only status",
    }, trustedContext())).resolves.toContain("transport: azure-communication-services")

    confirmMailDraftSendMock.mockResolvedValueOnce({
      ...submitted,
      id: "draft_legacy_policyless",
      policyDecision: undefined,
    })
    await expect(sendTool.handler({
      draft_id: "draft_legacy_policyless",
      confirmation: "CONFIRM_SEND",
      reason: "legacy policyless status",
    }, trustedContext())).resolves.toContain([
      "Mail submitted: draft_legacy_policyless",
      "status: submitted",
      "mode: confirmed",
      "send authority: native agent mailbox",
      "policy decision: unknown",
      "policy fallback: unknown",
      "transport: azure-communication-services",
      "time: 2026-04-23T01:31:00.000Z",
      "to: ari@mendelow.me",
    ].join("\n"))

    confirmMailDraftSendMock.mockResolvedValueOnce({
      ...submitted,
      id: "draft_3",
      status: "delivered",
      sentAt: undefined,
      submittedAt: undefined,
      transport: undefined,
      provider: undefined,
      updatedAt: "2026-04-23T01:40:00.000Z",
    })
    await expect(sendTool.handler({
      draft_id: "draft_3",
      confirmation: "CONFIRM_SEND",
      reason: "fallback status",
    }, trustedContext())).resolves.toContain([
      "Mail sent: draft_3",
      "status: delivered",
      "mode: confirmed",
      "send authority: native agent mailbox",
      "policy decision: explicit-confirmation",
      "policy fallback: none",
      "transport: unknown",
      "time: 2026-04-23T01:40:00.000Z",
      "to: ari@mendelow.me",
    ].join("\n"))
  })
})
