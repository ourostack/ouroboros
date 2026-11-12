import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AttachmentRecord } from "../../../heart/attachments/types"

const mocks = vi.hoisted(() => ({
  readProviderCredentialRecord: vi.fn(),
  minimaxVlmDescribe: vi.fn(),
  materializeAttachment: vi.fn(),
  voiceNoteLine: vi.fn(),
}))

vi.mock("../../../heart/provider-credentials", () => ({ readProviderCredentialRecord: mocks.readProviderCredentialRecord }))
vi.mock("../../../heart/providers/minimax-vlm", () => ({ minimaxVlmDescribe: mocks.minimaxVlmDescribe }))
vi.mock("../../../heart/attachments/materialize", () => ({ materializeAttachment: mocks.materializeAttachment }))
vi.mock("../../../heart/attachments/transcribe-audio", () => ({ voiceNoteLine: mocks.voiceNoteLine }))

import {
  attachmentTurnLines,
  attachmentWords,
  describeImage,
  imageDescriptionPrompt,
  imageFileDataUrl,
} from "../../../heart/attachments/understand"

let dir = ""
const record = (kind: AttachmentRecord["kind"], name: string): AttachmentRecord => ({
  id: `attachment:telegram:${name}`,
  source: "telegram",
  sourceId: name,
  kind,
  displayName: name,
  mimeType: kind === "image" ? "image/png" : kind === "audio" ? "audio/ogg" : "application/pdf",
  byteCount: 3,
  createdAt: 1,
  lastSeenAt: 1,
  sourceData: {},
})
const context = () => ({ agentName: "butler", agentRoot: dir, userText: "what is this", timeoutMs: 1000 })
const withKey = () => mocks.readProviderCredentialRecord.mockResolvedValue({ ok: true, record: { credentials: { apiKey: "k" } } })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "understand-"))
  fs.writeFileSync(path.join(dir, "pic.png"), "png")
  mocks.materializeAttachment.mockResolvedValue({ path: path.join(dir, "pic.png"), mimeType: "image/png" })
})

afterEach(() => {
  vi.resetAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("image helpers", () => {
  it("builds the description prompt with or without the user's text", () => {
    expect(imageDescriptionPrompt("look")).toContain('User message: "look"')
    expect(imageDescriptionPrompt(undefined)).toContain('User message: ""')
  })

  it("encodes a file as a data URL, defaulting to jpeg", async () => {
    await expect(imageFileDataUrl(path.join(dir, "pic.png"), " IMAGE/PNG ")).resolves.toBe(`data:image/png;base64,${Buffer.from("png").toString("base64")}`)
    await expect(imageFileDataUrl(path.join(dir, "pic.png"))).resolves.toMatch(/^data:image\/jpeg;base64,/u)
  })

  it("describes with the MiniMax key, and names the fix when there is none", async () => {
    withKey()
    mocks.minimaxVlmDescribe.mockResolvedValue("a cat")
    await expect(describeImage("butler", { prompt: "p", imageDataUrl: "data:x" })).resolves.toBe("a cat")
    expect(mocks.minimaxVlmDescribe).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "k", prompt: "p" }))

    mocks.readProviderCredentialRecord.mockResolvedValue({ ok: false })
    await expect(describeImage("butler", { prompt: "p", imageDataUrl: "data:x" })).rejects.toThrow("needs a MiniMax API key in the agent vault")
  })
})

describe("attachmentWords", () => {
  it("describes images, transcribes voice notes and leaves other files to the tools", async () => {
    withKey()
    mocks.minimaxVlmDescribe.mockResolvedValue("a cat on a mat")
    mocks.voiceNoteLine.mockResolvedValueOnce({ line: "voice note transcript: hi" }).mockResolvedValueOnce({ notice: "silent.ogg: empty audio transcript" })
    const words = await attachmentWords([record("image", "pic.png"), record("audio", "hi.ogg"), record("audio", "silent.ogg"), record("document", "a.pdf")], context())
    expect(words).toEqual({
      lines: ["[image description: a cat on a mat]", "voice note transcript: hi"],
      notices: ["silent.ogg: empty audio transcript"],
    })
    expect(mocks.materializeAttachment).toHaveBeenCalledWith("butler", "attachment:telegram:pic.png", { agentRoot: dir, variant: "vision_safe" })
  })

  it("says why an image could not be described, and why an attachment could not be read", async () => {
    mocks.readProviderCredentialRecord.mockResolvedValue({ ok: false })
    const failedDescription = await attachmentWords([record("image", "pic.png")], context())
    expect(failedDescription.lines[0]).toMatch(/^\[image description failed: image understanding needs a MiniMax API key/u)

    withKey()
    mocks.minimaxVlmDescribe.mockRejectedValue("vlm down")
    expect((await attachmentWords([record("image", "pic.png")], context())).lines).toEqual(["[image description failed: vlm down]"])

    mocks.materializeAttachment.mockRejectedValueOnce(new Error("gone")).mockRejectedValueOnce("odd")
    const unreadable = await attachmentWords([record("audio", "a.ogg"), record("image", "b.png")], context())
    expect(unreadable.notices).toEqual(["attachment hydration failed for a.ogg: gone", "attachment hydration failed for b.png: odd"])
  })
})

describe("attachmentTurnLines", () => {
  it("lists the attachments, then their words; nothing for no attachments", async () => {
    await expect(attachmentTurnLines([], context())).resolves.toEqual([])
    mocks.voiceNoteLine.mockResolvedValue({ line: "voice note transcript: hi" })
    const lines = await attachmentTurnLines([record("audio", "hi.ogg")], context())
    expect(lines[0]).toMatch(/^\[attachments\]\n- attachment:telegram:hi\.ogg \| audio \| hi\.ogg/u)
    expect(lines.slice(1)).toEqual(["voice note transcript: hi"])
  })
})
