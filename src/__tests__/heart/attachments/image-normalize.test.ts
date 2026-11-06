import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  MAX_VLM_IMAGE_BYTES,
  normalizeImageForVision,
} from "../../../heart/attachments/image-normalize"
import { buildCliLocalFileAttachmentRecord } from "../../../heart/attachments/sources/cli-local-file"
import { pngBytes } from "../../fixtures/minimal-images"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-normalize-"))
  tempDirs.push(dir)
  return dir
}

function makeFile(dir: string, name: string, content = "file"): string {
  const target = path.join(dir, name)
  fs.writeFileSync(target, content, "utf-8")
  return target
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("normalizeImageForVision", () => {
  it("uses the built-in sips helpers when no overrides are supplied", async () => {
    vi.resetModules()
    const execFile = vi.fn((_: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (args[0] === "-g") {
        const format = args.at(-1) === "/tmp/capture.heic" ? "heic" : "jpeg"
        callback(null, `hasAlpha: no\nformat: ${format}\npixelWidth: 100\npixelHeight: 100\n`, "")
        return
      }
      callback(null, "", "")
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from("not-image")),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ size: 1024 }),
    }))

    const { normalizeImageForVision: normalizeWithDefaults } = await import("../../../heart/attachments/image-normalize")
    const result = await normalizeWithDefaults({
      attachment: {
        id: "attachment:cli-local-file:default",
        source: "cli-local-file",
        sourceId: "default",
        kind: "image",
        displayName: "capture.heic",
        mimeType: "image/heic",
        byteCount: MAX_VLM_IMAGE_BYTES + 1,
        createdAt: 1,
        lastSeenAt: 1,
        sourceData: { path: "/tmp/capture.heic" },
      },
      sourcePath: "/tmp/capture.heic",
      agentName: "slugger",
      agentRoot: "/tmp/agent-root",
    } as any)

    expect(result.mimeType).toBe("image/jpeg")
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/sips",
      ["-g", "hasAlpha", "-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", "/tmp/capture.heic"],
      { timeout: 30_000, killSignal: "SIGKILL" },
      expect.any(Function),
    )
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/sips",
      expect.arrayContaining(["-s", "format", "jpeg", "-s", "formatOptions", "best", "-Z", "3072", "/tmp/capture.heic", "--out"]),
      { timeout: 30_000, killSignal: "SIGKILL" },
      expect.any(Function),
    )
  })

  it("uses the built-in Quick Look fallback and can emit a png result", async () => {
    vi.resetModules()
    const execFile = vi.fn((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (file === "/usr/bin/sips" && args[0] === "-g" && args.at(-1) === "/tmp/capture.bmp") {
        callback(new Error("probe failed"), "", "probe failed")
        return
      }
      if (file === "/usr/bin/qlmanage") {
        callback(null, "", "")
        return
      }
      if (file === "/usr/bin/sips" && args[0] === "-g") {
        callback(null, "hasAlpha: yes\nformat: png\npixelWidth: 100\npixelHeight: 100\n", "")
        return
      }
      callback(null, "", "")
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from("not-image")),
      readdir: vi.fn().mockResolvedValue(["capture.bmp", "capture.png"]),
      stat: vi.fn().mockResolvedValue({ size: 512 }),
    }))

    const { normalizeImageForVision: normalizeWithDefaults } = await import("../../../heart/attachments/image-normalize")
    const result = await normalizeWithDefaults({
      attachment: {
        id: "attachment:cli-local-file:ql",
        source: "cli-local-file",
        sourceId: "ql",
        kind: "image",
        displayName: "capture.bmp",
        mimeType: "image/bmp",
        byteCount: MAX_VLM_IMAGE_BYTES + 1,
        createdAt: 1,
        lastSeenAt: 1,
        sourceData: { path: "/tmp/capture.bmp" },
      },
      sourcePath: "/tmp/capture.bmp",
      agentName: "slugger",
      agentRoot: "/tmp/agent-root",
    } as any)

    expect(result.mimeType).toBe("image/png")
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/qlmanage",
      ["-t", "-s", "4096", "-o", expect.stringContaining("attachment_cli-local-file_ql"), "/tmp/capture.bmp"],
      { timeout: 30_000, killSignal: "SIGKILL" },
      expect.any(Function),
    )
  })

  it("surfaces a narrow Quick Look error when no rasterized candidate is produced", async () => {
    vi.resetModules()
    const execFile = vi.fn((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (file === "/usr/bin/sips" && args[0] === "-g") {
        callback(new Error("probe failed"), "", "probe failed")
        return
      }
      callback(null, "", "")
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from("not-image")),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn(),
    }))

    const { normalizeImageForVision: normalizeWithDefaults } = await import("../../../heart/attachments/image-normalize")
    await expect(
      normalizeWithDefaults({
        attachment: {
          id: "attachment:cli-local-file:ql-missing",
          source: "cli-local-file",
          sourceId: "ql-missing",
          kind: "image",
          displayName: "capture.bmp",
          mimeType: "image/bmp",
          byteCount: MAX_VLM_IMAGE_BYTES + 1,
          createdAt: 1,
          lastSeenAt: 1,
          sourceData: { path: "/tmp/capture.bmp" },
        },
        sourcePath: "/tmp/capture.bmp",
        agentName: "slugger",
        agentRoot: "/tmp/agent-root",
      } as any),
    ).rejects.toThrow("Quick Look did not produce a rasterized image")
  })

  it("falls back to the child-process error message when sips or Quick Look provide no stderr or stdout", async () => {
    vi.resetModules()
    const execFile = vi.fn((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (file === "/usr/bin/sips" && args[0] === "-g") {
        callback(new Error("probe failed"))
        return
      }
      callback(new Error("quick look failed"))
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from("not-image")),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn(),
    }))

    const { normalizeImageForVision: normalizeWithDefaults } = await import("../../../heart/attachments/image-normalize")
    await expect(
      normalizeWithDefaults({
        attachment: {
          id: "attachment:cli-local-file:ql-error",
          source: "cli-local-file",
          sourceId: "ql-error",
          kind: "image",
          displayName: "capture.bmp",
          mimeType: "image/bmp",
          byteCount: MAX_VLM_IMAGE_BYTES + 1,
          createdAt: 1,
          lastSeenAt: 1,
          sourceData: { path: "/tmp/capture.bmp" },
        },
        sourcePath: "/tmp/capture.bmp",
        agentName: "slugger",
        agentRoot: "/tmp/agent-root",
      } as any),
    ).rejects.toThrow("quick look failed")
  })

  it.each([
    "hasAlpha: no\nformat: jpeg\npixelHeight: 100\n",
    "hasAlpha: no\nformat: jpeg\npixelWidth: 100\n",
  ])("rejects incomplete built-in image dimensions before Quick Look fallback: %s", async (probeOutput) => {
    vi.resetModules()
    const execFile = vi.fn((
      file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      if (file === "/usr/bin/sips") {
        callback(null, probeOutput, "")
        return
      }
      callback(new Error("quick look stopped"))
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(Buffer.from("not-image")),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn(),
    }))

    const { normalizeImageForVision: normalizeWithDefaults } = await import("../../../heart/attachments/image-normalize")
    await expect(normalizeWithDefaults({
      attachment: {
        id: "attachment:cli-local-file:missing-dimension",
        source: "cli-local-file",
        sourceId: "missing-dimension",
        kind: "image",
        displayName: "capture.bmp",
        mimeType: "image/bmp",
        byteCount: 9,
        createdAt: 1,
        lastSeenAt: 1,
        sourceData: { path: "/tmp/capture.bmp" },
      },
      sourcePath: "/tmp/capture.bmp",
      agentName: "slugger",
      agentRoot: "/tmp/agent-root",
    } as any)).rejects.toThrow("quick look stopped")
  })

  it("passes through already-safe supported images without transcoding", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "already-safe.png")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: MAX_VLM_IMAGE_BYTES - 1,
    })
    const probeImage = vi.fn().mockResolvedValue({
      hasAlpha: false,
      pixelWidth: 100,
      pixelHeight: 100,
      mimeType: "image/png",
    })
    const encodeVariant = vi.fn()

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage,
      encodeVariant,
    })

    expect(result.path).toBe(sourcePath)
    expect(result.mimeType).toBe("image/png")
    expect(result.byteCount).toBe(Buffer.byteLength("file"))
    expect(probeImage).toHaveBeenCalledOnce()
    expect(encodeVariant).not.toHaveBeenCalled()
  })

  it("uses a portable image header probe before macOS-only helpers", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = path.join(agentRoot, "portable.png")
    const bytes = pngBytes()
    fs.writeFileSync(sourcePath, bytes)
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "application/octet-stream",
      byteCount: bytes.length,
    })
    const probeImage = vi.fn(async () => { throw new Error("sips unavailable") })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage,
    })

    expect(result).toMatchObject({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: bytes.length,
    })
    expect(probeImage).not.toHaveBeenCalled()
  })

  it("uses the actual file size instead of stale attachment metadata", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "grown.png")
    fs.truncateSync(sourcePath, MAX_VLM_IMAGE_BYTES + 1)
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: 10,
    })
    const encodeVariant = vi.fn(async (input: { outputDir: string }) => {
      const outputPath = path.join(input.outputDir, "normalized.jpg")
      fs.mkdirSync(input.outputDir, { recursive: true })
      fs.writeFileSync(outputPath, "jpeg")
      return { path: outputPath, mimeType: "image/jpeg", byteCount: 4 }
    })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage: vi.fn().mockResolvedValue({
        hasAlpha: false,
        pixelWidth: 100,
        pixelHeight: 100,
      }),
      encodeVariant,
    })

    expect(encodeVariant).toHaveBeenCalled()
    expect(result.path).toContain("normalized.jpg")
  })

  it("normalizes small but over-dimension images before provider projection", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "wide.png")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: 4,
    })
    const probeImage = vi.fn(async ({ sourcePath: candidate }: { sourcePath: string }) => (
      candidate === sourcePath
        ? { hasAlpha: false, pixelWidth: 9_000, pixelHeight: 100 }
        : { hasAlpha: false, pixelWidth: 3_072, pixelHeight: 100 }
    ))
    const encodeVariant = vi.fn(async (input: { outputDir: string }) => {
      const outputPath = path.join(input.outputDir, "resized.jpg")
      fs.mkdirSync(input.outputDir, { recursive: true })
      fs.writeFileSync(outputPath, "jpeg")
      return { path: outputPath, mimeType: "image/jpeg", byteCount: 4 }
    })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage,
      encodeVariant,
    })

    expect(encodeVariant).toHaveBeenCalled()
    expect(result.path).toContain("resized.jpg")
  })

  it("iterates deterministic jpeg attempts until one fits the transport budget", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "oversize.tiff")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/tiff",
      byteCount: MAX_VLM_IMAGE_BYTES + 1_000,
    })
    const attempts: Array<{ format: string; maxEdge: number; quality?: string }> = []
    const encodeVariant = vi.fn(async (input: { targetFormat: string; maxEdge: number; quality?: string; outputDir: string }) => {
      attempts.push({
        format: input.targetFormat,
        maxEdge: input.maxEdge,
        quality: input.quality,
      })
      const filename = `${input.targetFormat}-${input.maxEdge}-${input.quality ?? "na"}.jpg`
      const outputPath = path.join(input.outputDir, filename)
      fs.mkdirSync(input.outputDir, { recursive: true })
      fs.writeFileSync(outputPath, "jpeg")
      return {
        path: outputPath,
        mimeType: "image/jpeg",
        byteCount: input.quality === "80" ? MAX_VLM_IMAGE_BYTES - 500 : MAX_VLM_IMAGE_BYTES + 2_000,
      }
    })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: false, pixelWidth: 100, pixelHeight: 100 }),
      encodeVariant,
    })

    expect(attempts.slice(0, 3)).toEqual([
      { format: "jpeg", maxEdge: 3072, quality: "best" },
      { format: "jpeg", maxEdge: 3072, quality: "90" },
      { format: "jpeg", maxEdge: 3072, quality: "80" },
    ])
    expect(result.mimeType).toBe("image/jpeg")
    expect(result.byteCount).toBe(Buffer.byteLength("jpeg"))
  })

  it("tries png first for alpha images, then falls back to jpeg when png stays too large", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "alpha.heic")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/heic",
      byteCount: MAX_VLM_IMAGE_BYTES + 1_000,
    })
    const attempts: string[] = []
    const encodeVariant = vi.fn(async (input: { targetFormat: string; outputDir: string }) => {
      attempts.push(input.targetFormat)
      const outputPath = path.join(input.outputDir, `${attempts.length}.${input.targetFormat}`)
      fs.mkdirSync(input.outputDir, { recursive: true })
      fs.writeFileSync(outputPath, input.targetFormat)
      return {
        path: outputPath,
        mimeType: `image/${input.targetFormat}`,
        byteCount: input.targetFormat === "png" ? MAX_VLM_IMAGE_BYTES + 10 : MAX_VLM_IMAGE_BYTES - 10,
      }
    })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: true, pixelWidth: 100, pixelHeight: 100 }),
      encodeVariant,
    })

    expect(attempts[0]).toBe("png")
    expect(attempts).toContain("jpeg")
    expect(result.mimeType).toBe("image/jpeg")
  })

  it("falls back to Quick Look rasterization when the source probe fails", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "mystery.bmp")
    const rasterizedPath = makeFile(agentRoot, "rasterized.png")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/bmp",
      byteCount: MAX_VLM_IMAGE_BYTES + 2_000,
    })
    const probeImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("sips could not read image"))
      .mockResolvedValue({ hasAlpha: false, pixelWidth: 100, pixelHeight: 100 })
    const rasterizeWithQuickLook = vi.fn().mockResolvedValue(rasterizedPath)
    const encodeVariant = vi.fn(async (input: { outputDir: string }) => {
      const outputPath = path.join(input.outputDir, "normalized.jpg")
      fs.mkdirSync(input.outputDir, { recursive: true })
      fs.writeFileSync(outputPath, "jpeg")
      return {
        path: outputPath,
        mimeType: "image/jpeg",
        byteCount: MAX_VLM_IMAGE_BYTES - 10,
      }
    })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage,
      rasterizeWithQuickLook,
      encodeVariant,
    })

    expect(rasterizeWithQuickLook).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath,
        outputDir: expect.stringContaining(path.join("state", "attachments", "materialized")),
      }),
    )
    expect(result.path).toContain("normalized.jpg")
  })

  it("uses fallback output mime metadata when a successful variant omits mimeType", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "alpha-source")
    const attachment = {
      id: "attachment:cli-local-file:fallback-success",
      source: "cli-local-file",
      sourceId: "fallback-success",
      kind: "image",
      displayName: "mystery-image",
      createdAt: 1,
      lastSeenAt: 1,
      sourceData: { path: sourcePath },
    } as const

    const result = await normalizeImageForVision({
      attachment: attachment as any,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: true, pixelWidth: 100, pixelHeight: 100 }),
      encodeVariant: vi.fn(async (input: { outputDir: string; targetFormat: string }) => {
        const outputPath = path.join(input.outputDir, `${input.targetFormat}.bin`)
        fs.mkdirSync(input.outputDir, { recursive: true })
        fs.writeFileSync(outputPath, "png-ish")
        return {
          path: outputPath,
          byteCount: MAX_VLM_IMAGE_BYTES - 10,
        }
      }),
    })

    expect(result.path).toContain(".bin")
    expect(result.mimeType).toBe("image/png")
  })

  it("treats undefined byte counts as non-fitting and keeps trying later variants", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "retry-after-unknown-size")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/tiff",
      byteCount: MAX_VLM_IMAGE_BYTES + 1,
    })
    let attempt = 0

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: false, pixelWidth: 100, pixelHeight: 100 }),
      encodeVariant: vi.fn(async (input: { outputDir: string }) => {
        attempt += 1
        const outputPath = path.join(input.outputDir, `attempt-${attempt}.jpg`)
        fs.mkdirSync(input.outputDir, { recursive: true })
        fs.writeFileSync(outputPath, "jpeg")
        if (attempt === 1) {
          return { path: outputPath, mimeType: "image/jpeg" }
        }
        return { path: outputPath, mimeType: "image/jpeg", byteCount: MAX_VLM_IMAGE_BYTES - 1 }
      }),
    })

    expect(attempt).toBe(2)
    expect(result.byteCount).toBe(Buffer.byteLength("jpeg"))
  })

  it("rejects variants whose generated bytes cannot be probed", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "bad-variant-source")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/tiff",
      byteCount: MAX_VLM_IMAGE_BYTES + 1,
    })
    let probeAttempt = 0
    let encodeAttempt = 0

    await expect(normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage: vi.fn(async () => {
        probeAttempt += 1
        if (probeAttempt === 1) {
          return { hasAlpha: false, pixelWidth: 100, pixelHeight: 100 }
        }
        throw new Error("invalid generated image")
      }),
      encodeVariant: vi.fn(async (input: { outputDir: string }) => {
        encodeAttempt += 1
        if (encodeAttempt > 1) throw new Error("stop after rejected variant")
        const outputPath = path.join(input.outputDir, "invalid.jpg")
        fs.mkdirSync(input.outputDir, { recursive: true })
        fs.writeFileSync(outputPath, "invalid")
        return {
          path: outputPath,
          mimeType: "image/jpeg",
          byteCount: 7,
        }
      }),
    })).rejects.toThrow("stop after rejected variant")
  })

  it("throws a narrow error when no normalized variant can fit the budget", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "still-too-big.gif")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/gif",
      byteCount: MAX_VLM_IMAGE_BYTES + 5_000,
    })

    await expect(
      normalizeImageForVision({
        attachment,
        sourcePath,
        agentName: "slugger",
        agentRoot,
        probeImage: vi.fn().mockResolvedValue({ hasAlpha: false, pixelWidth: 100, pixelHeight: 100 }),
        encodeVariant: vi.fn(async (input: { outputDir: string }) => {
          const outputPath = path.join(input.outputDir, "too-big.jpg")
          fs.mkdirSync(input.outputDir, { recursive: true })
          fs.writeFileSync(outputPath, "jpeg")
          return {
            path: outputPath,
            mimeType: "image/jpeg",
            byteCount: MAX_VLM_IMAGE_BYTES + 1,
          }
        }),
      }),
    ).rejects.toThrow("could not be normalized under the VLM byte budget")
  })

  it("uses unknown source metadata when normalization fails without original mime or byte size", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "mystery-source")

    await expect(
      normalizeImageForVision({
        attachment: {
          id: "attachment:cli-local-file:fallback-failure",
          source: "cli-local-file",
          sourceId: "fallback-failure",
          kind: "image",
          displayName: "mystery-image",
          createdAt: 1,
          lastSeenAt: 1,
          sourceData: { path: sourcePath },
        } as any,
        sourcePath,
        agentName: "slugger",
        agentRoot,
        probeImage: vi.fn().mockResolvedValue({ hasAlpha: false, pixelWidth: 100, pixelHeight: 100 }),
        encodeVariant: vi.fn(async (input: { outputDir: string }) => {
          const outputPath = path.join(input.outputDir, "too-big.jpg")
          fs.mkdirSync(input.outputDir, { recursive: true })
          fs.writeFileSync(outputPath, "jpeg")
          return {
            path: outputPath,
            mimeType: undefined,
            byteCount: MAX_VLM_IMAGE_BYTES + 5,
          }
        }),
      }),
    ).rejects.toThrow("could not be normalized under the VLM byte budget")
  })
})
