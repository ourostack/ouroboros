import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isTrustedDirectory, overrideTrustedUidForTests, readTrustedJson, TRUSTED_UID } from "../../a2a/trusted-files"

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
