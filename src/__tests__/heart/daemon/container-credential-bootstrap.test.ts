import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { loadContainerCredentialBootstrap } from "../../../heart/daemon/container-credential-bootstrap"

describe("container credential bootstrap", () => {
  let directory = ""

  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  })

  function fixture(message: Record<string, unknown>): string {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "container-bootstrap-"))
    const file = path.join(directory, "credentials.json")
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: [message] }), { mode: 0o600 })
    return file
  }

  it("loads a private bootstrap only for an enabled agent", () => {
    let file = ""
    const apply = vi.fn(() => {
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.existsSync(`${file}.consuming`)).toBe(false)
      return true
    })
    file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramBotToken: "secret" },
      machineRuntimeConfig: { unraidReadApiKey: "read-secret" },
      providerCredentialRecords: [],
    })

    expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, apply })).toEqual(["sanctuary"])
    expect(apply).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(file)).toBe(false)
  })

  it("deletes the claimed single-use import before surfacing an apply failure", () => {
    const file = fixture({ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} })

    expect(() => loadContainerCredentialBootstrap(["sanctuary"], { path: file, apply: () => false })).toThrow("message is invalid")
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.consuming`)).toBe(false)
  })

  it("rejects group-readable, symlinked, oversized, duplicate, or unknown-agent bootstrap files", () => {
    const message = { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} }
    const file = fixture(message)
    fs.chmodSync(file, 0o640)
    expect(() => loadContainerCredentialBootstrap(["sanctuary"], { path: file, apply: () => true })).toThrow("0600")

    fs.chmodSync(file, 0o600)
    const link = path.join(directory, "link.json")
    fs.symlinkSync(file, link)
    expect(() => loadContainerCredentialBootstrap(["sanctuary"], { path: link, apply: () => true })).toThrow("regular file")

    expect(() => loadContainerCredentialBootstrap(["other"], { path: file, apply: () => true })).toThrow("not enabled")

    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: [message, message] }), { mode: 0o600 })
    expect(() => loadContainerCredentialBootstrap(["sanctuary"], { path: file, apply: () => true })).toThrow("duplicate")

    fs.writeFileSync(file, "x".repeat(131_073), { mode: 0o600 })
    expect(() => loadContainerCredentialBootstrap(["sanctuary"], { path: file, apply: () => true })).toThrow("too large")
  })

  it("treats an absent bootstrap as no credentials", () => {
    expect(loadContainerCredentialBootstrap(["sanctuary"], { path: "/tmp/definitely-absent-sanctuary-bootstrap", apply: () => true })).toEqual([])
  })

  it("durably discards an interrupted consuming file without replaying it", () => {
    const file = fixture({ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} })
    const consuming = `${file}.consuming`
    fs.renameSync(file, consuming)
    const apply = vi.fn(() => true)

    expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, apply })).toEqual([])
    expect(fs.existsSync(consuming)).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })
})
