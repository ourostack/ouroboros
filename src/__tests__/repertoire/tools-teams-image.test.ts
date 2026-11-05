import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { getChannelCapabilities } from "@ouro.bot/friends"
import type { ToolContext } from "../../repertoire/tools-base"
import { teamsToolDefinitions } from "../../repertoire/tools-teams"
import { selectToolsForChannel, executeTool } from "../../repertoire/tools"
import { normalizeImageForVision } from "../../heart/attachments/image-normalize"
import { createTeamsImageSender, prepareTeamsImage } from "../../senses/teams-image"
import * as nerves from "../../nerves/runtime"

vi.mock("../../heart/attachments/image-normalize", () => ({
  MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE: 32 * 1024 * 1024,
  normalizeImageForVision: vi.fn(),
}))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open) }
})

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+1sAAAAASUVORK5CYII=", "base64")
const roots: string[] = []

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-teams-image-"))
  roots.push(root)
  const source = path.join(root, "private-screenshot.png")
  await fs.writeFile(source, png)
  vi.mocked(normalizeImageForVision).mockResolvedValue({ path: source, mimeType: "image/png", byteCount: png.length })
  const send = vi.fn().mockResolvedValue({ id: "teams-activity-123" })
  const context: ToolContext = {
    signin: async () => undefined,
    agentName: "image-test",
    agentRoot: root,
    context: {
      friend: { id: "owner", name: "Owner", trustLevel: "family", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "", updatedAt: "", schemaVersion: 1 },
      channel: getChannelCapabilities("teams"),
    },
    teamsSendImage: createTeamsImageSender(send, "inbound-message"),
  }
  return { root, source, send, context }
}

afterEach(() => {
  vi.clearAllMocks()
})
afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("teams_send_image", () => {
  it("is available in Teams without OAuth, but not on other channels or no-send turns", () => {
    const names = (channel: string, noSend?: true) => selectToolsForChannel(
      { ...getChannelCapabilities(channel), availableIntegrations: [] },
      undefined, undefined, undefined, undefined, undefined, { noSend },
    ).ordinary.map(({ tool }) => tool.function.name)
    expect(names("teams")).toContain("teams_send_image")
    expect(names("teams")).not.toContain("teams_send_message")
    expect(names("cli")).not.toContain("teams_send_image")
    expect(names("teams", true)).not.toContain("teams_send_image")
  })

  it("sends actual local bytes only to the bound conversation and returns an honest receipt", async () => {
    const { source, send, context } = await fixture()
    const outcome = await executeTool("teams_send_image", { path: source, caption: "requested screenshot" }, context)
    expect(outcome).toMatchObject({ kind: "handler_succeeded", text: expect.stringContaining("teams-activity-123") })
    expect(outcome.text).toContain("rendering is not verified")
    expect(normalizeImageForVision).toHaveBeenCalledWith(expect.objectContaining({ maxEdge: 1024, maxVlmBytes: 56 * 1024 }))
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "message", text: "requested screenshot", replyToId: "inbound-message",
      attachments: [{ contentType: "image/png", contentUrl: `data:image/png;base64,${png.toString("base64")}`, name: "private-screenshot.png" }],
    }))
    expect(JSON.stringify(send.mock.calls)).not.toContain(path.dirname(source))
    const tool = teamsToolDefinitions.find(({ tool }) => tool.function.name === "teams_send_image")!
    expect(tool.tool.function.parameters?.properties).not.toHaveProperty("user_id")
    expect(tool.riskProfile).toMatchObject({ mutates: "external_side_effect", risk: "high" })
  })

  it.each(["stranger", "acquaintance", "friend", undefined] as const)("blocks local image disclosure without family trust (%s)", async (trustLevel) => {
    const { source, send, context } = await fixture()
    context.context!.friend.trustLevel = trustLevel
    const outcome = await executeTool("teams_send_image", { path: source }, context)
    expect(outcome.kind).toBe("rejected_before_handler")
    expect(send).not.toHaveBeenCalled()
    expect(normalizeImageForVision).not.toHaveBeenCalled()
  })

  it("honors no-send even if called outside selection", async () => {
    const { source, send, context } = await fixture()
    const outcome = await executeTool("teams_send_image", { path: source }, { ...context, noSend: true })
    expect(outcome.kind).not.toBe("handler_succeeded")
    expect(send).not.toHaveBeenCalled()
  })

  it.each(["habit", "await"] as const)("blocks autonomous %s turns before reading image bytes", async (kind) => {
    const { source, send, context } = await fixture()
    if (kind === "habit") context.habitSession = {
      permissionEnvelope: { schemaVersion: 1, canMessageOutward: false, returnRoutes: [], deniedTools: [], warnings: [] },
      toolPolicy: { requestedTools: null, grantedTools: [], deniedTools: [], outwardMessagingAllowed: false },
    }
    else context.autonomousTurnKind = "await"
    expect(selectToolsForChannel(getChannelCapabilities("teams"), undefined, undefined, undefined, undefined, undefined, context)
      .ordinary.map(({ tool }) => tool.function.name)).not.toContain("teams_send_image")
    expect((await executeTool("teams_send_image", { path: source }, context)).kind).not.toBe("handler_succeeded")
    expect(send).not.toHaveBeenCalled()
    expect(normalizeImageForVision).not.toHaveBeenCalled()
  })

  it("fails without an authenticated current-conversation sender", async () => {
    const { source, context } = await fixture()
    delete context.teamsSendImage
    expect((await executeTool("teams_send_image", { path: source }, context)).kind).not.toBe("handler_succeeded")
    expect(normalizeImageForVision).not.toHaveBeenCalled()
  })

  it("rejects disguised non-image files before normalization or sending", async () => {
    const { source, send, context } = await fixture()
    await fs.writeFile(source, "private non-image content")
    const outcome = await executeTool("teams_send_image", { path: source }, context)
    expect(outcome.kind).not.toBe("handler_succeeded")
    expect(normalizeImageForVision).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("checks normalized actual bytes rather than trusting reported byte count", async () => {
    const { source, send, context } = await fixture()
    const normalized = `${source}.normalized.png`
    await fs.writeFile(normalized, Buffer.concat([png, Buffer.alloc(56 * 1024)]))
    vi.mocked(normalizeImageForVision).mockResolvedValue({ path: normalized, mimeType: "image/png", byteCount: 1 })
    expect((await executeTool("teams_send_image", { path: source }, context)).kind).not.toBe("handler_succeeded")
    expect(send).not.toHaveBeenCalled()
  })

  it("does not report success or retry when Teams rejects the attachment", async () => {
    const { source, send, context } = await fixture()
    send.mockRejectedValue(new Error("MessageSizeTooBig"))
    const outcome = await executeTool("teams_send_image", { path: source }, context)
    expect(outcome.kind).not.toBe("handler_succeeded")
    expect(outcome.text).toContain("MessageSizeTooBig")
    expect(send).toHaveBeenCalledOnce()
  })

  it("reports unknown delivery when the sender gives no activity receipt", async () => {
    const { source, send, context } = await fixture()
    send.mockResolvedValue(undefined)
    const outcome = await executeTool("teams_send_image", { path: source }, context)
    expect(outcome.kind).not.toBe("handler_succeeded")
    expect(outcome.text).toContain("delivery is unknown")
    expect(send).toHaveBeenCalledOnce()
  })

  it("binds relationship authorization before touching private image bytes", async () => {
    const { source, send, context } = await fixture()
    context.relationshipAuthorization = {
      profileId: "image-owner", authorizedContextScopes: [], advertisedToolNames: ["teams_send_image"],
      authorizeTool: async () => ({ allowed: false, reason: "relationship revoked" }),
    }
    const outcome = await executeTool("teams_send_image", { path: source }, context)
    expect(outcome.kind).toBe("rejected_before_handler")
    expect(send).not.toHaveBeenCalled()
    expect(normalizeImageForVision).not.toHaveBeenCalled()
  })

  it.each(["agentName", "agentRoot"] as const)("requires explicit %s even with a sender", async (field) => {
    const { source, context, send } = await fixture()
    delete context[field]
    expect((await executeTool("teams_send_image", { path: source }, context)).kind).not.toBe("handler_succeeded")
    expect(send).not.toHaveBeenCalled()
  })

  it("guards channel and trust even when the handler is called directly", async () => {
    const { source, context, send } = await fixture()
    const handler = teamsToolDefinitions.find(({ tool }) => tool.function.name === "teams_send_image")!.handler
    await expect(handler({ path: source })).rejects.toThrow("family-trusted")
    context.context!.channel = getChannelCapabilities("cli")
    await expect(handler({ path: source }, context)).rejects.toThrow("family-trusted")
    expect(send).not.toHaveBeenCalled()
  })

  it("rejects overlong captions both through schema and the direct handler", async () => {
    const { source, context, send } = await fixture()
    const args = { path: source, caption: "x".repeat(1025) }
    expect((await executeTool("teams_send_image", args, context)).kind).not.toBe("handler_succeeded")
    const handler = teamsToolDefinitions.find(({ tool }) => tool.function.name === "teams_send_image")!.handler
    await expect(handler(args, context)).rejects.toThrow("caption exceeds")
    expect(send).not.toHaveBeenCalled()
  })
})

describe("Teams inline-image preparation and transport bounds", () => {
  it("records preparation and acceptance without logging image bytes, paths or captions", async () => {
    const { root, source, send } = await fixture()
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    try {
      const attachment = await prepareTeamsImage({ path: source, agentName: "test", agentRoot: root })
      await createTeamsImageSender(send)(attachment, "private caption")
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        event: "channel.teams_image_prepared", meta: { mimeType: "image/png", byteCount: png.length, maxEdge: 1024 },
      }))
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        event: "channel.teams_image_accepted", meta: { activityId: "teams-activity-123", mimeType: "image/png" },
      }))
      const telemetry = JSON.stringify(emit.mock.calls)
      expect(telemetry).not.toContain("base64")
      expect(telemetry).not.toContain(source)
      expect(telemetry).not.toContain("private caption")
    } finally {
      emit.mockRestore()
    }
  })

  it.each(["relative.png", "", "~/capture.png"])("rejects non-absolute path %s", async (source) => {
    await expect(prepareTeamsImage({ path: source, agentName: "test", agentRoot: "/tmp/test" })).rejects.toThrow("absolute")
  })

  it.each(["empty", "directory", "large"] as const)("rejects %s sources before normalization", async (kind) => {
    const { root, source } = await fixture()
    const target = kind === "directory" ? root : source
    if (kind === "empty") await fs.writeFile(source, "")
    if (kind === "large") await fs.truncate(source, 32 * 1024 * 1024 + 1)
    await expect(prepareTeamsImage({ path: target, agentName: "test", agentRoot: root })).rejects.toThrow("regular file")
    expect(normalizeImageForVision).not.toHaveBeenCalled()
  })

  it("surfaces missing files rather than returning a success-shaped fallback", async () => {
    const { root } = await fixture()
    await expect(prepareTeamsImage({ path: path.join(root, "absent.png"), agentName: "test", agentRoot: root })).rejects.toThrow("ENOENT")
  })

  it("handles JPEG magic independently of the source suffix and uses a matching data URI", async () => {
    const { root, source } = await fixture()
    const jpeg = Buffer.from([255, 216, 255, 224, 0, 16])
    await fs.writeFile(source, jpeg)
    vi.mocked(normalizeImageForVision).mockResolvedValue({ path: source, mimeType: "image/jpeg" })
    const attachment = await prepareTeamsImage({ path: source, agentName: "test", agentRoot: root })
    expect(attachment).toEqual({ contentType: "image/jpeg", contentUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`, name: "private-screenshot.jpg" })
  })

  it("rejects normalized bytes with mismatched MIME metadata", async () => {
    const { root, source } = await fixture()
    vi.mocked(normalizeImageForVision).mockResolvedValue({ path: source, mimeType: "image/jpeg" })
    await expect(prepareTeamsImage({ path: source, agentName: "test", agentRoot: root })).rejects.toThrow("MIME")
  })

  it.each([[255, 216], [255, 0, 255], [255, 216, 0]].map(bytes => ({ bytes })))("rejects invalid JPEG header $bytes", async ({ bytes }) => {
    const { root, source } = await fixture()
    await fs.writeFile(source, Buffer.from(bytes))
    await expect(prepareTeamsImage({ path: source, agentName: "test", agentRoot: root })).rejects.toThrow("PNG or JPEG")
    expect(normalizeImageForVision).not.toHaveBeenCalled()
  })

  it("fails closed if the file changes size between stat and read", async () => {
    const { root, source } = await fixture()
    const file = await fs.open(source, "r")
    const read = vi.spyOn(file, "read").mockResolvedValue({ bytesRead: 1, buffer: Buffer.alloc(1) })
    vi.mocked(fs.open).mockResolvedValueOnce(file)
    try {
      await expect(prepareTeamsImage({ path: source, agentName: "test", agentRoot: root })).rejects.toThrow("changed while reading")
    } finally {
      read.mockRestore()
    }
  })

  it.each([{}, { id: null }, { id: "" }, { id: " " }, "receipt"])("reports unknown delivery for malformed receipt %j", async (receipt) => {
    const send = vi.fn().mockResolvedValue(receipt)
    await expect(createTeamsImageSender(send)({ contentType: "image/png", contentUrl: "data:image/png;base64,aA==", name: "test.png" }, "")).rejects.toThrow("delivery is unknown")
    expect(send).toHaveBeenCalledOnce()
  })

  it("refuses oversized captions and serialized payloads before invoking the SDK", async () => {
    const send = vi.fn()
    const sender = createTeamsImageSender(send)
    const attachment = { contentType: "image/png" as const, contentUrl: "data:image/png;base64,aA==", name: "test.png" }
    await expect(sender(attachment, "x".repeat(1025))).rejects.toThrow("caption")
    await expect(sender({ ...attachment, contentUrl: "x".repeat(80 * 1024) }, "")).rejects.toThrow("payload budget")
    expect(send).not.toHaveBeenCalled()
  })
})
