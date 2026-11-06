import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { accessSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { imageValidationAvailable, isCompleteImageBuffer, MAX_VLM_IMAGE_EDGE } from "../../../heart/attachments/image-normalize"
import { minimalImages, pngBytes } from "../../fixtures/minimal-images"

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}))
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  accessSync: vi.fn(),
}))

function result(overrides: Partial<SpawnSyncReturns<Buffer>> = {}): SpawnSyncReturns<Buffer> {
  return { pid: 1, status: 0, signal: null, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ...overrides }
}

beforeEach(() => {
  vi.stubEnv("PATH", "/trusted/codecs")
  vi.mocked(accessSync).mockReset().mockImplementation(() => undefined)
  vi.mocked(spawnSync).mockReset().mockReturnValue(result())
})

afterEach(() => vi.unstubAllEnvs())

describe("complete image decoder adapter", () => {
  it("requires the installed full-image decoder for image capability", () => {
    expect(imageValidationAvailable()).toBe(true)
    expect(accessSync).toHaveBeenCalledWith("/trusted/codecs/magick", expect.any(Number))
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("not installed") })
    expect(imageValidationAvailable()).toBe(false)
  })

  it.each(Object.entries(minimalImages))("fully decodes %s in memory with disk caches disabled", (mimeType, bytes) => {
    expect(isCompleteImageBuffer(bytes, mimeType)).toBe(true)
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
      "/trusted/codecs/magick", [
        "-regard-warnings", "-limit", "thread", "1",
        "-limit", "width", "8000", "-limit", "height", "8000",
        "-limit", "memory", "256MiB", "-limit", "map", "0", "-limit", "disk", "0",
        "-define", "png:chunk-malloc-max=33554432",
        "inline:-", "null:",
      ],
      {
        input: `data:${mimeType};base64,${bytes.toString("base64")}`, stdio: ["pipe", "ignore", "pipe"],
        timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      },
    )
  })

  it("fails closed when no installed decoder is executable", () => {
    vi.stubEnv("PATH", ".:relative/bin")
    vi.mocked(accessSync).mockImplementation(() => { throw new Error("not executable") })
    expect(imageValidationAvailable()).toBe(false)
    expect(() => isCompleteImageBuffer(pngBytes(), "image/png")).toThrow(/requires.*ImageMagick/)
    expect(spawnSync).not.toHaveBeenCalled()
    expect(vi.mocked(accessSync).mock.calls.every(([candidate]) => String(candidate).startsWith("/"))).toBe(true)
  })

  it("finds an installed decoder without PATH", () => {
    vi.stubEnv("PATH", undefined)
    expect(imageValidationAvailable()).toBe(true)
    expect(accessSync).toHaveBeenCalledWith("/opt/homebrew/bin/magick", expect.any(Number))
  })

  it("uses the Windows executable name without shell interpretation", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      expect(isCompleteImageBuffer(pngBytes(), "image/png")).toBe(true)
      expect(vi.mocked(spawnSync).mock.calls[0]![0]).toBe("/trusted/codecs/magick.exe")
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  it.each([
    ["a rejected decode", result({ status: 1 })],
    ["a warning despite exit zero", result({ stderr: Buffer.from("corrupt data") })],
    ["an unknown exit status", result({ status: null })],
  ])("does not accept %s", (_label, decoded) => {
    vi.mocked(spawnSync).mockReturnValue(decoded)
    expect(isCompleteImageBuffer(pngBytes(), "image/png")).toBe(false)
  })

  it("preserves process failures, including timeout, instead of treating them as valid images", () => {
    const error = Object.assign(new Error("decoder timed out"), { code: "ETIMEDOUT" })
    vi.mocked(spawnSync).mockReturnValue(result({ error, status: null, signal: "SIGKILL" }))
    expect(() => isCompleteImageBuffer(pngBytes(), "image/png")).toThrow(error)
  })

  it("reports a decoder killed without an OS error", () => {
    vi.mocked(spawnSync).mockReturnValue(result({ status: null, signal: "SIGKILL" }))
    expect(() => isCompleteImageBuffer(pngBytes(), "image/png")).toThrow("image decoder interrupted: SIGKILL")
  })

  it.each(["width", "height"])("rejects an oversized %s before invoking a decoder", (dimension) => {
    const bytes = pngBytes()
    bytes.writeUInt32BE(MAX_VLM_IMAGE_EDGE + 1, dimension === "width" ? 16 : 20)
    expect(isCompleteImageBuffer(bytes, "image/png")).toBe(false)
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
