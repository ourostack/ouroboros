import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { inspectTrustedDirectory, inspectTrustedJson, isTrustedDirectory, overrideOwnerForTests, overrideTrustChainRootForTests, overrideTrustedUidForTests, readTrustedJson, TRUSTED_UID } from "../../a2a/trusted-files"

let dir = ""
const me = process.getuid!()
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-files-")) })
afterEach(() => { overrideTrustedUidForTests(me); fs.rmSync(dir, { recursive: true, force: true }) })

describe("the test-only trusted uid", () => {
  it("cannot be set, and is not honoured, outside a test runner", () => {
    overrideTrustedUidForTests(me)
    vi.stubEnv("VITEST", undefined as unknown as string)
    try {
      expect(() => overrideTrustedUidForTests(me)).toThrow("tests only")
      // the override set earlier no longer counts: only root is trusted again
      expect(isTrustedDirectory(dir)).toBe(me === 0)
    } finally { vi.unstubAllEnvs() }
    expect(isTrustedDirectory(dir)).toBe(true)
  })
})

describe("trusted files", () => {
  it("trusts root by default and nobody else, so a file the agent's own user wrote never counts", () => {
    overrideTrustedUidForTests(undefined)
    const file = path.join(dir, "x.json")
    fs.writeFileSync(file, "{\"a\":1}", { mode: 0o644 })
    expect(TRUSTED_UID).toBe(0)
    expect(isTrustedDirectory(dir)).toBe(me === 0)
    expect(readTrustedJson(file)).toEqual(me === 0 ? { a: 1 } : undefined)
  })

  it("accepts the declared uid when nothing else can write the directory or file", () => {
    const file = path.join(dir, "x.json")
    fs.writeFileSync(file, "{\"a\":1}", { mode: 0o644 })
    expect(isTrustedDirectory(dir, me)).toBe(true)
    expect(readTrustedJson(file, me)).toEqual({ a: 1 })
  })

  it("refuses a missing path, a plain file as a directory, a directory as a file, group- or other-writable modes and bad JSON", () => {
    const file = path.join(dir, "x.json")
    fs.writeFileSync(file, "{\"a\":1}", { mode: 0o644 })
    expect(isTrustedDirectory(path.join(dir, "nope"), me)).toBe(false)
    expect(isTrustedDirectory(file, me)).toBe(false)
    expect(readTrustedJson(dir, me)).toBeUndefined()
    expect(readTrustedJson(path.join(dir, "nope"), me)).toBeUndefined()
    fs.chmodSync(file, 0o620)
    expect(readTrustedJson(file, me)).toBeUndefined()
    fs.chmodSync(file, 0o644)
    fs.writeFileSync(file, "not json")
    expect(readTrustedJson(file, me)).toBeUndefined()
    fs.chmodSync(dir, 0o775)
    expect(isTrustedDirectory(dir, me)).toBe(false)
  })

  it("refuses a symlinked directory", () => {
    const link = path.join(os.tmpdir(), `trusted-link-${Date.now()}`)
    fs.symlinkSync(dir, link)
    try {
      expect(isTrustedDirectory(link, me)).toBe(false)
    } finally {
      fs.rmSync(link, { force: true })
    }
  })
})

describe("the ancestor chain", () => {
  const AGENT_UID = me + 4242
  const nested = () => {
    const a = path.join(dir, "a")
    const b = path.join(a, "b")
    fs.mkdirSync(b, { recursive: true, mode: 0o755 })
    const file = path.join(b, "x.json")
    fs.writeFileSync(file, "{\"a\":1}", { mode: 0o644 })
    return { a, b, file }
  }
  afterEach(() => { vi.restoreAllMocks(); overrideOwnerForTests(undefined) })

  it("refuses a directory when any ancestor is owned by someone else, however trusted the directory itself is", () => {
    const { a, b, file } = nested()
    overrideOwnerForTests((target) => (target === a ? AGENT_UID : undefined))
    expect(isTrustedDirectory(b, me)).toBe(false)
    expect(readTrustedJson(file, me)).toBeUndefined()
    expect(inspectTrustedJson(file, me)).toMatchObject({ state: "untrusted" })
  })

  it("refuses a directory when any ancestor is group- or other-writable", () => {
    const { a, b, file } = nested()
    fs.chmodSync(a, 0o775)
    expect(isTrustedDirectory(b, me)).toBe(false)
    expect(inspectTrustedJson(file, me)).toMatchObject({ state: "untrusted" })
  })

  it("refuses a path that runs through a symlinked ancestor", () => {
    const { a, file } = nested()
    const link = path.join(dir, "link")
    fs.symlinkSync(a, link)
    expect(isTrustedDirectory(path.join(link, "b"), me)).toBe(false)
    expect(inspectTrustedJson(path.join(link, "b", "x.json"), me)).toMatchObject({ state: "untrusted" })
    expect(inspectTrustedJson(file, me)).toMatchObject({ state: "trusted", value: { a: 1 } })
  })

  it("walks all the way to / unless a test names a chain root, and then fails closed", () => {
    const { b } = nested()
    overrideTrustChainRootForTests(undefined)
    expect(isTrustedDirectory(b, me)).toBe(false)
    overrideTrustChainRootForTests(process.env.OURO_TEST_ISOLATED_ROOT)
    expect(isTrustedDirectory(b, me)).toBe(true)
  })

  it("reaches / when every directory on the way is trusted, and reads a path through a plain file as missing", () => {
    overrideTrustChainRootForTests(undefined)
    expect(inspectTrustedDirectory("/", fs.lstatSync("/").uid)).toEqual({ state: "trusted" })
    overrideTrustChainRootForTests(process.env.OURO_TEST_ISOLATED_ROOT)
    const file = path.join(dir, "plain")
    fs.writeFileSync(file, "x")
    expect(inspectTrustedDirectory(path.join(file, "below"), me)).toEqual({ state: "missing" })
  })

  it("refuses to set the chain root or an owner outside a test runner", () => {
    vi.stubEnv("VITEST", undefined as unknown as string)
    try {
      expect(() => overrideTrustChainRootForTests(dir)).toThrow("tests only")
      expect(() => overrideOwnerForTests(() => 0)).toThrow("tests only")
    } finally { vi.unstubAllEnvs() }
  })
})

describe("inspecting a trusted file", () => {
  const put = (name: string, body: string, mode = 0o644) => { const file = path.join(dir, name); fs.writeFileSync(file, body); fs.chmodSync(file, mode); return file }

  it("tells a missing file from an untrusted one and from a trusted one", () => {
    expect(inspectTrustedJson(path.join(dir, "nope.json"), me)).toEqual({ state: "missing" })
    expect(inspectTrustedJson(path.join(dir, "nodir", "nope.json"), me)).toEqual({ state: "missing" })
    expect(inspectTrustedJson(put("ok.json", "{\"a\":1}"), me)).toEqual({ state: "trusted", value: { a: 1 } })
    expect(inspectTrustedJson(put("loose.json", "{}", 0o666), me)).toMatchObject({ state: "untrusted" })
    expect(inspectTrustedJson(put("bad.json", "not json"), me)).toMatchObject({ state: "untrusted", reason: expect.stringContaining("JSON") })
    expect(inspectTrustedJson(dir, me)).toMatchObject({ state: "untrusted" })
  })

  it("treats a path it cannot inspect for any other reason as untrusted", () => {
    expect(inspectTrustedDirectory(path.join(dir, "x".repeat(300)), me)).toEqual({ state: "untrusted", reason: expect.stringContaining("cannot inspect") })
  })

  it("refuses a file that is itself a symlink", () => {
    const real = put("real.json", "{}")
    const link = path.join(dir, "link.json")
    fs.symlinkSync(real, link)
    expect(inspectTrustedJson(link, me)).toMatchObject({ state: "untrusted" })
  })

  it("warns once per target and reason inside the rate-limit window", async () => {
    const { __resetRejectionRateLimitForTests } = await import("../../a2a/trusted-files")
    __resetRejectionRateLimitForTests()
    const file = put("loose2.json", "{}", 0o666)
    const warn = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    inspectTrustedJson(file, me)
    inspectTrustedJson(file, me)
    const rejections = warn.mock.calls.filter(([event]) => event.event === "senses.a2a_trusted_file_rejected")
    expect(rejections).toHaveLength(1)
  })
})
