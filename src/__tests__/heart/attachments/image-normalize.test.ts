import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  MAX_VLM_IMAGE_BYTES,
  normalizeImageForVision,
} from "../../../heart/attachments/image-normalize"
import { buildCliLocalFileAttachmentRecord } from "../../../heart/attachments/sources/cli-local-file"

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
    const execFile = vi.fn((_: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (args[0] === "-g") {
        callback(null, "hasAlpha: no\n", "")
        return
      }
      callback(null, "", "")
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
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
    expect(execFile).toHaveBeenCalledWith("/usr/bin/sips", ["-g", "hasAlpha", "/tmp/capture.heic"], expect.any(Function))
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/sips",
      expect.arrayContaining(["-s", "format", "jpeg", "-s", "formatOptions", "best", "-Z", "3072", "/tmp/capture.heic", "--out"]),
      expect.any(Function),
    )
  })

  it("uses the built-in Quick Look fallback and can emit a png result", async () => {
    vi.resetModules()
    const execFile = vi.fn((file: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (file === "/usr/bin/sips" && args[0] === "-g" && args[2] === "/tmp/capture.bmp") {
        callback(new Error("probe failed"), "", "probe failed")
        return
      }
      if (file === "/usr/bin/qlmanage") {
        callback(null, "", "")
        return
      }
      if (file === "/usr/bin/sips" && args[0] === "-g") {
        callback(null, "hasAlpha: yes\n", "")
        return
      }
      callback(null, "", "")
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue(["capture.png"]),
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
      expect.any(Function),
    )
  })

  it("surfaces a narrow Quick Look error when no rasterized candidate is produced", async () => {
    vi.resetModules()
    const execFile = vi.fn((file: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (file === "/usr/bin/sips" && args[0] === "-g") {
        callback(new Error("probe failed"), "", "probe failed")
        return
      }
      callback(null, "", "")
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
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
    const execFile = vi.fn((file: string, args: string[], callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      if (file === "/usr/bin/sips" && args[0] === "-g") {
        callback(new Error("probe failed"))
        return
      }
      callback(new Error("quick look failed"))
    })
    vi.doMock("node:child_process", () => ({ execFile }))
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockResolvedValue(undefined),
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

  it("passes through already-safe supported images without transcoding", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "already-safe.png")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: MAX_VLM_IMAGE_BYTES - 1,
    })
    const probeImage = vi.fn()
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
    expect(result.byteCount).toBe(MAX_VLM_IMAGE_BYTES - 1)
    expect(probeImage).not.toHaveBeenCalled()
    expect(encodeVariant).not.toHaveBeenCalled()
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
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: false }),
      encodeVariant,
    })

    expect(attempts.slice(0, 3)).toEqual([
      { format: "jpeg", maxEdge: 3072, quality: "best" },
      { format: "jpeg", maxEdge: 3072, quality: "90" },
      { format: "jpeg", maxEdge: 3072, quality: "80" },
    ])
    expect(result.mimeType).toBe("image/jpeg")
    expect(result.byteCount).toBe(MAX_VLM_IMAGE_BYTES - 500)
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
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: true }),
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
      .mockResolvedValueOnce({ hasAlpha: false })
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
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: true }),
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
    expect(result.mimeType).toBeUndefined()
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
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: false }),
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
    expect(result.byteCount).toBe(MAX_VLM_IMAGE_BYTES - 1)
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
        probeImage: vi.fn().mockResolvedValue({ hasAlpha: false }),
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
        probeImage: vi.fn().mockResolvedValue({ hasAlpha: false }),
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
