import { createHash } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const identityState = vi.hoisted(() => ({ agentRoot: "" }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), unlinkSync: vi.fn(actual.unlinkSync) }
})

vi.mock("../../../heart/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../heart/identity")>()
  return { ...actual, getAgentRoot: () => identityState.agentRoot }
})

import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_COUNT,
  MAX_PROMPT_TOTAL_IMAGE_BYTES,
  getInlinePromptImagePath,
  ingestInlinePromptImages,
  prepareInlinePromptImages,
} from "../../../heart/attachments/inline-image"
import { getAttachment, readRecentAttachments } from "../../../heart/attachments/store"
import { minimalImages, pngBytes } from "../../fixtures/minimal-images"

const realWriteFileSync = vi.mocked(fs.writeFileSync).getMockImplementation()!
const realUnlinkSync = vi.mocked(fs.unlinkSync).getMockImplementation()!
const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-image-"))
  tempDirs.push(dir)
  identityState.agentRoot = dir
  return dir
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64")
}

function digestOf(value: string | Buffer): string {
  return createHash("sha256").update(Buffer.from(value)).digest("hex")
}

function inlineWrites(): string[] {
  return vi.mocked(fs.writeFileSync).mock.calls
    .map((call) => String(call[0]))
    .filter((target) => target.includes(`${path.sep}inline${path.sep}`))
}

afterEach(() => {
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(realWriteFileSync)
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(realUnlinkSync)
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("inline prompt image ingestion", () => {
  it.each([
    ["arbitrary bytes", "image/png", Buffer.from("not an image")],
    ["header-only PNG", "image/png", pngBytes().subarray(0, 24)],
    ["missing PNG end", "image/png", pngBytes().subarray(0, -12)],
    ["truncated JPEG", "image/jpeg", minimalImages["image/jpeg"].subarray(0, -8)],
    ["truncated JPEG entropy with restored end marker", "image/jpeg", Buffer.concat([
      minimalImages["image/jpeg"].subarray(0, -8), Buffer.from([0xff, 0xd9]),
    ])],
    ["truncated GIF", "image/gif", minimalImages["image/gif"].subarray(0, -2)],
    ["truncated GIF pixels with restored trailer", "image/gif", Buffer.concat([
      minimalImages["image/gif"].subarray(0, -4), Buffer.from([0x3b]),
    ])],
    ["GIF without any frame", "image/gif", Buffer.concat([
      minimalImages["image/gif"].subarray(0, 25), Buffer.from([0x3b]),
    ])],
    ["truncated WebP", "image/webp", minimalImages["image/webp"].subarray(0, -8)],
    ["MIME mismatch", "image/jpeg", pngBytes()],
    ["corrupt pixels with valid framing", "image/png", (() => {
      const bytes = pngBytes()
      bytes[44] = bytes[44]! ^ 0xff
      return bytes
    })()],
    ["bad PNG checksum with complete pixels", "image/png", (() => {
      const bytes = pngBytes()
      bytes[bytes.length - 16] = bytes[bytes.length - 16]! ^ 0xff
      return bytes
    })()],
  ] as const)("rejects complete-image integrity failure before storage: %s", (_label, mimeType, bytes) => {
    const agentRoot = makeAgentRoot()
    expect(() => ingestInlinePromptImages("boss", [{ data: encode(bytes), mimeType }], { agentRoot })).toThrow(/invalid|incomplete/)
    expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)
  })

  it("validates every image before creating any attachment state", () => {
    const agentRoot = makeAgentRoot()
    expect(() => ingestInlinePromptImages("boss", [
      { data: encode(pngBytes()), mimeType: "image/png" },
      { data: "not base64!", mimeType: "image/png" },
    ], { agentRoot })).toThrow("strict base64")
    expect(inlineWrites()).toEqual([])
    expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)
  })

  it("enforces one aggregate decoded-byte budget before storage", () => {
    const agentRoot = makeAgentRoot()
    const images = ["a", "b", "c"].map((label) => ({ mimeType: "image/png", data: encode(pngBytes(label, 4 * 1024 * 1024 - 100)) }))
    expect(() => ingestInlinePromptImages("boss", images, { agentRoot })).toThrow(/prompt.*bytes/)
    expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)
  })

  it.each([0, 1])("checks the exact aggregate byte boundary with %i bytes of overflow", (overflow) => {
    const agentRoot = makeAgentRoot()
    const images = ["first", "second"].map((label, index) => {
      const size = MAX_PROMPT_TOTAL_IMAGE_BYTES / 2 + (index === 1 ? overflow : 0)
      const bytes = pngBytes(label, size - pngBytes(label, 1).length + 1)
      expect(bytes.length).toBe(size)
      return { mimeType: "image/png", data: encode(bytes) }
    })
    if (overflow) {
      expect(() => ingestInlinePromptImages("boss", images, { agentRoot })).toThrow(/prompt.*bytes/)
      expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)
    } else {
      const attachments = ingestInlinePromptImages("boss", images, { agentRoot })
      expect(attachments.reduce((total, record) => total + record.byteCount!, 0)).toBe(MAX_PROMPT_TOTAL_IMAGE_BYTES)
    }
  })

  it("checks complete integrity of every image before publishing a valid prefix", async () => {
    const agentRoot = makeAgentRoot()
    await expect(prepareInlinePromptImages("boss", [
      { data: encode(pngBytes()), mimeType: "image/png" },
      { data: encode(pngBytes().subarray(0, 24)), mimeType: "image/png" },
    ], { agentRoot })).rejects.toThrow(/invalid|incomplete/)
    expect(inlineWrites()).toEqual([])
    expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)
  })

  it("accepts one complete image exactly at the per-image byte boundary", () => {
    const agentRoot = makeAgentRoot()
    const bytes = pngBytes("byte-boundary", MAX_PROMPT_IMAGE_BYTES - pngBytes("byte-boundary", 1).length + 1)
    expect(bytes.length).toBe(MAX_PROMPT_IMAGE_BYTES)
    const [attachment] = ingestInlinePromptImages("boss", [{ data: encode(bytes), mimeType: "image/png" }], { agentRoot })
    expect(attachment!.byteCount).toBe(MAX_PROMPT_IMAGE_BYTES)
    expect(fs.readFileSync(attachment!.sourceData.path).equals(bytes)).toBe(true)
  })

  it("creates no state for empty or already cancelled preparation", async () => {
    const agentRoot = makeAgentRoot()
    expect(ingestInlinePromptImages("boss", [], { agentRoot })).toEqual([])
    const transaction = await prepareInlinePromptImages("boss", [], { agentRoot })
    expect(transaction.attachments).toEqual([])
    await transaction.commit()
    await transaction.rollback()
    await expect(prepareInlinePromptImages("boss", [], { agentRoot, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)
  })

  it.each(Object.entries(minimalImages))("accepts complete generated %s images", (mimeType, bytes) => {
    const agentRoot = makeAgentRoot()
    const [record] = ingestInlinePromptImages("boss", [{ data: encode(bytes), mimeType }], { agentRoot })
    expect(fs.readFileSync(record!.sourceData.path)).toEqual(bytes)
  })

  it("decodes every GIF frame rather than accepting a complete first frame", () => {
    const gif = minimalImages["image/gif"]
    // The complete image descriptor and pixels follow the 25-byte header and global color table.
    const twoFrames = Buffer.concat([gif.subarray(0, -1), gif.subarray(25)])
    const acceptedRoot = makeAgentRoot()
    const [accepted] = ingestInlinePromptImages("boss", [{ data: encode(twoFrames), mimeType: "image/gif" }], { agentRoot: acceptedRoot })
    expect(fs.readFileSync(accepted!.sourceData.path)).toEqual(twoFrames)
    const rejectedRoot = makeAgentRoot()
    const corrupt = Buffer.concat([twoFrames.subarray(0, -4), Buffer.from([0x3b])])
    expect(() => ingestInlinePromptImages("boss", [{ data: encode(corrupt), mimeType: "image/gif" }], { agentRoot: rejectedRoot })).toThrow(/invalid|incomplete/)
    expect(fs.existsSync(path.join(rejectedRoot, "state", "attachments"))).toBe(false)
  })

  it("does not roll back restored bytes for an already accepted catalog object", () => {
    const agentRoot = makeAgentRoot()
    const image = { data: pngBytes("accepted").toString("base64"), mimeType: "image/png" }
    const [accepted] = ingestInlinePromptImages("boss", [image], { agentRoot })
    fs.unlinkSync(accepted!.sourceData.path)
    const failing = pngBytes("late-failure")
    const failingPath = getInlinePromptImagePath("boss", digestOf(failing), ".png", agentRoot)
    vi.mocked(fs.writeFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target).startsWith(failingPath)) throw new Error("late write failed")
      return (realWriteFileSync as (...args: unknown[]) => void)(target, ...rest)
    }) as typeof fs.writeFileSync)
    expect(() => ingestInlinePromptImages("boss", [image, { data: encode(failing), mimeType: "image/png" }], { agentRoot })).toThrow("late write failed")
    expect(fs.existsSync(accepted!.sourceData.path)).toBe(true)
  })

  it("holds publication ownership through admission and protects accepted reuse from rollback", async () => {
    const agentRoot = makeAgentRoot()
    const image = { data: pngBytes().toString("base64"), mimeType: "image/png" }
    const first = await prepareInlinePromptImages("boss", [image], { agentRoot })
    const waiting = prepareInlinePromptImages("boss", [image], { agentRoot })
    expect(() => ingestInlinePromptImages("boss", [image], { agentRoot })).toThrow("session turn busy")
    await first.rollback()
    const second = await waiting
    await second.commit()
    await second.rollback()
    const reused = await prepareInlinePromptImages("boss", [image], { agentRoot })
    await reused.rollback()
    expect(fs.readFileSync(second.attachments[0]!.sourceData.path)).toEqual(pngBytes())
    expect(getAttachment("boss", second.attachments[0]!.id, agentRoot)).not.toBeNull()
  })

  it("releases a cancelled waiting ingress without publishing its images", async () => {
    const agentRoot = makeAgentRoot()
    const first = await prepareInlinePromptImages("boss", [{ data: pngBytes("first").toString("base64"), mimeType: "image/png" }], { agentRoot })
    const controller = new AbortController()
    const waiting = prepareInlinePromptImages("boss", [{ data: pngBytes("cancelled").toString("base64"), mimeType: "image/png" }], { agentRoot, signal: controller.signal })
    const rejected = expect(waiting).rejects.toThrow()
    controller.abort()
    await first.commit()
    await rejected
    expect(readRecentAttachments("boss", agentRoot).map((record) => record.id)).toEqual(first.attachments.map((record) => record.id))
  })

  it("never removes bytes adopted by an independent ingress during creator rollback", () => {
    const agentRoot = makeAgentRoot()
    const bytes = pngBytes("shared")
    const failing = pngBytes("late-failure")
    const failingPath = getInlinePromptImagePath("boss", digestOf(failing), ".png", agentRoot)
    const independent = new AsyncResource("independent-ingress")
    let adopted: ReturnType<typeof ingestInlinePromptImages> | undefined
    let refusal: unknown
    vi.mocked(fs.writeFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target).startsWith(failingPath)) {
        independent.runInAsyncScope(() => {
          try { adopted = ingestInlinePromptImages("boss", [{ data: encode(bytes), mimeType: "image/png" }], { agentRoot }) }
          catch (error) { refusal = error }
        })
        throw new Error("late write failed")
      }
      return (realWriteFileSync as (...args: unknown[]) => void)(target, ...rest)
    }) as typeof fs.writeFileSync)

    expect(() => ingestInlinePromptImages("boss", [
      { data: encode(bytes), mimeType: "image/png" },
      { data: encode(failing), mimeType: "image/png" },
    ], { agentRoot })).toThrow("late write failed")

    if (adopted) expect(fs.existsSync(adopted[0]!.sourceData.path)).toBe(true)
    else expect(refusal).toMatchObject({ name: "SessionTurnBusyError" })
    const accepted = ingestInlinePromptImages("boss", [{ data: encode(bytes), mimeType: "image/png" }], { agentRoot })
    expect(fs.readFileSync(accepted[0]!.sourceData.path)).toEqual(bytes)
    independent.emitDestroy()
  })

  it("writes content-addressed bytes under the existing attachment tree as cli-local-file records", () => {
    const agentRoot = makeAgentRoot()
    const bytes = pngBytes("first-image-bytes")

    const records = ingestInlinePromptImages(
      "boss",
      [{ data: encode(bytes), mimeType: "IMAGE/PNG", name: "shot.png" }],
      { agentRoot, now: 1_700 },
    )

    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.source).toBe("cli-local-file")
    expect(record.kind).toBe("image")
    expect(record.mimeType).toBe("image/png")
    expect(record.byteCount).toBe(bytes.byteLength)
    expect(record.displayName).toBe("shot.png")
    expect(record.createdAt).toBe(1_700)

    const expectedPath = getInlinePromptImagePath("boss", digestOf(bytes), ".png", agentRoot)
    expect(record.sourceData.path).toBe(expectedPath)
    expect(expectedPath.startsWith(path.join(agentRoot, "state", "attachments"))).toBe(true)
    expect(fs.readFileSync(expectedPath)).toEqual(bytes)
    expect(JSON.stringify(record)).not.toContain(encode(bytes))

    expect(getAttachment("boss", record.id, agentRoot)).toEqual(record)
    expect(readRecentAttachments("boss", agentRoot).map((entry) => entry.id)).toEqual([record.id])
  })

  it("defaults to the agent's own bundle root when no root is supplied", () => {
    const agentRoot = makeAgentRoot()
    const bytes = pngBytes("default-root-bytes")

    const [record] = ingestInlinePromptImages("boss", [{ data: encode(bytes), mimeType: "image/png" }])

    expect(record!.sourceData.path).toBe(getInlinePromptImagePath("boss", digestOf(bytes), ".png"))
    expect(record!.sourceData.path.startsWith(agentRoot)).toBe(true)
    expect(getAttachment("boss", record!.id)).toEqual(record)
  })

  it("derives a safe display name when the client omits or forges one", () => {
    const agentRoot = makeAgentRoot()
    const anonymous = minimalImages["image/webp"]
    const traversal = minimalImages["image/jpeg"]

    const records = ingestInlinePromptImages(
      "boss",
      [
        { data: encode(anonymous), mimeType: "image/webp" },
        { data: encode(traversal), mimeType: "image/jpeg", name: "  ../../etc/passwd  " },
      ],
      { agentRoot },
    )

    expect(records[0]!.displayName).toBe(`image-${digestOf(anonymous).slice(0, 8)}.webp`)
    expect(records[1]!.displayName).toBe("passwd")
    expect(records[1]!.sourceData.path).toBe(getInlinePromptImagePath("boss", digestOf(traversal), ".jpg", agentRoot))
  })

  it("collapses duplicate images inside one prompt into a single attachment written once", () => {
    const agentRoot = makeAgentRoot()
    const data = encode(pngBytes("dupe-bytes"))

    const records = ingestInlinePromptImages(
      "boss",
      [
        { data, mimeType: "image/png", name: "first.png" },
        { data, mimeType: "image/png", name: "second.png" },
      ],
      { agentRoot },
    )

    expect(records).toHaveLength(1)
    expect(records[0]!.displayName).toBe("first.png")
    expect(inlineWrites()).toHaveLength(1)
  })

  it("reuses already-stored bytes instead of rewriting the content-addressed file", () => {
    const agentRoot = makeAgentRoot()
    const data = encode(minimalImages["image/gif"])

    ingestInlinePromptImages("boss", [{ data, mimeType: "image/gif" }], { agentRoot })
    vi.mocked(fs.writeFileSync).mockClear()
    const second = ingestInlinePromptImages("boss", [{ data, mimeType: "image/gif" }], { agentRoot })

    expect(inlineWrites()).toEqual([])
    expect(fs.existsSync(second[0]!.sourceData.path)).toBe(true)
  })

  it("rejects unsupported and missing image mime types", () => {
    const agentRoot = makeAgentRoot()

    expect(() => ingestInlinePromptImages("boss", [{ data: encode("x"), mimeType: "image/tiff" }], { agentRoot }))
      .toThrow("unsupported image mime type: image/tiff")
    expect(() => ingestInlinePromptImages("boss", [{ data: encode("x"), mimeType: "  " }], { agentRoot }))
      .toThrow("unsupported image mime type: (missing)")
    expect(fs.existsSync(path.join(agentRoot, "state", "attachments", "inline"))).toBe(false)
  })

  it("rejects malformed, non-canonical, and empty base64 payloads", () => {
    const agentRoot = makeAgentRoot()

    expect(() => ingestInlinePromptImages("boss", [{ data: "not base64!!", mimeType: "image/png" }], { agentRoot }))
      .toThrow("image data must be strict base64")
    expect(() => ingestInlinePromptImages("boss", [{ data: "QQ=", mimeType: "image/png" }], { agentRoot }))
      .toThrow("image data must be strict base64")
    expect(() => ingestInlinePromptImages("boss", [{ data: "QR==", mimeType: "image/png" }], { agentRoot }))
      .toThrow("image data must be strict base64")
    expect(() => ingestInlinePromptImages("boss", [{ data: "", mimeType: "image/png" }], { agentRoot }))
      .toThrow("image data must not be empty")
  })

  it("rejects images past the decoded byte limit", () => {
    const agentRoot = makeAgentRoot()
    const oversize = "A".repeat(Math.ceil((MAX_PROMPT_IMAGE_BYTES + 1) / 3) * 4)

    expect(() => ingestInlinePromptImages("boss", [{ data: oversize, mimeType: "image/png" }], { agentRoot }))
      .toThrow(`image exceeds ${MAX_PROMPT_IMAGE_BYTES} bytes`)
  })

  it("accepts the count boundary and rejects one image past it", () => {
    const agentRoot = makeAgentRoot()
    const images = Array.from({ length: MAX_PROMPT_IMAGE_COUNT }, (_unused, index) => ({
      data: encode(pngBytes(`image-${index}`)),
      mimeType: "image/png",
    }))

    expect(ingestInlinePromptImages("boss", images, { agentRoot })).toHaveLength(MAX_PROMPT_IMAGE_COUNT)
    expect(() => ingestInlinePromptImages(
      "boss",
      [...images, { data: encode(pngBytes("image-overflow")), mimeType: "image/png" }],
      { agentRoot },
    )).toThrow(`prompt supports at most ${MAX_PROMPT_IMAGE_COUNT} images`)
  })

  it("never leaves a half-written image at its content-addressed path", () => {
    const agentRoot = makeAgentRoot()
    const truncated = pngBytes("truncated-image-bytes")
    const finalPath = getInlinePromptImagePath("boss", digestOf(truncated), ".png", agentRoot)

    vi.mocked(fs.writeFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, data: unknown, ...rest: unknown[]) => {
      if (String(target).startsWith(finalPath)) {
        ;(realWriteFileSync as (...args: unknown[]) => void)(target, Buffer.from("trunc"), ...rest)
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
      }
      return (realWriteFileSync as (...args: unknown[]) => void)(target, data, ...rest)
    }) as typeof fs.writeFileSync)

    expect(() => ingestInlinePromptImages(
      "boss",
      [{ data: encode(truncated), mimeType: "image/png" }],
      { agentRoot },
    )).toThrow("disk full")

    expect(fs.existsSync(finalPath)).toBe(false)
    expect(fs.readdirSync(path.dirname(finalPath))).toEqual([])
  })

  it("removes bytes it wrote in this prompt when a later write fails", () => {
    const agentRoot = makeAgentRoot()
    const good = pngBytes("survives-until-rollback")
    const failing = pngBytes("write-explodes")
    const failingPath = getInlinePromptImagePath("boss", digestOf(failing), ".png", agentRoot)

    vi.mocked(fs.writeFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target).startsWith(failingPath)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
      return (realWriteFileSync as (...args: unknown[]) => void)(target, ...rest)
    }) as typeof fs.writeFileSync)

    expect(() => ingestInlinePromptImages(
      "boss",
      [
        { data: encode(good), mimeType: "image/png" },
        { data: encode(failing), mimeType: "image/png" },
      ],
      { agentRoot },
    )).toThrow("disk full")

    expect(fs.existsSync(getInlinePromptImagePath("boss", digestOf(good), ".png", agentRoot))).toBe(false)
    expect(fs.existsSync(failingPath)).toBe(false)
    expect(readRecentAttachments("boss", agentRoot)).toEqual([])
  })

  it("keeps pre-existing bytes when a later image in the same prompt fails", () => {
    const agentRoot = makeAgentRoot()
    const existing = pngBytes("pre-existing-bytes")
    const failing = pngBytes("second-write-explodes")
    const existingPath = getInlinePromptImagePath("boss", digestOf(existing), ".png", agentRoot)
    const failingPath = getInlinePromptImagePath("boss", digestOf(failing), ".png", agentRoot)

    ingestInlinePromptImages("boss", [{ data: encode(existing), mimeType: "image/png" }], { agentRoot })
    vi.mocked(fs.writeFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target).startsWith(failingPath)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
      return (realWriteFileSync as (...args: unknown[]) => void)(target, ...rest)
    }) as typeof fs.writeFileSync)

    expect(() => ingestInlinePromptImages(
      "boss",
      [
        { data: encode(existing), mimeType: "image/png" },
        { data: encode(failing), mimeType: "image/png" },
      ],
      { agentRoot },
    )).toThrow("disk full")

    expect(fs.existsSync(existingPath)).toBe(true)
  })

  it("surfaces the original write failure even when rollback cleanup also fails", () => {
    const agentRoot = makeAgentRoot()
    const good = pngBytes("cleanup-denied-bytes")
    const failing = pngBytes("cleanup-denied-explodes")
    const failingPath = getInlinePromptImagePath("boss", digestOf(failing), ".png", agentRoot)

    vi.mocked(fs.writeFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(target).startsWith(failingPath)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" })
      return (realWriteFileSync as (...args: unknown[]) => void)(target, ...rest)
    }) as typeof fs.writeFileSync)
    vi.mocked(fs.unlinkSync).mockImplementation(((target: fs.PathLike) => {
      if (String(target).includes(`${path.sep}inline${path.sep}`)) {
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" })
      }
      return (realUnlinkSync as (value: fs.PathLike) => void)(target)
    }) as typeof fs.unlinkSync)

    expect(() => ingestInlinePromptImages(
      "boss",
      [
        { data: encode(good), mimeType: "image/png" },
        { data: encode(failing), mimeType: "image/png" },
      ],
      { agentRoot },
    )).toThrow("disk full")
  })
})
