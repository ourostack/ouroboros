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

  it("persists a claimed bootstrap before caching it or deleting the recoverable envelope", async () => {
    let file = ""
    const persist = vi.fn(async () => {
      expect(fs.existsSync(file)).toBe(false)
      expect(fs.existsSync(`${file}.consuming`)).toBe(true)
      return true
    })
    const apply = vi.fn(() => {
      expect(persist).toHaveBeenCalledTimes(1)
      expect(fs.existsSync(`${file}.consuming`)).toBe(true)
      return true
    })
    file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramBotToken: "secret" },
      machineRuntimeConfig: { unraidReadApiKey: "read-secret" },
      providerCredentialRecords: [],
    })

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply }))
      .resolves.toEqual(["sanctuary"])
    expect(persist).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.consuming`)).toBe(false)
  })

  it("fails closed and preserves the claimed envelope when a durable vault write fails", async () => {
    const file = fixture({ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} })
    const apply = vi.fn(() => true)

    await expect(loadContainerCredentialBootstrap(["sanctuary"], {
      path: file,
      persist: async () => { throw new Error("vault write unavailable") },
      apply,
    })).rejects.toThrow("container credential bootstrap persistence failed")
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.consuming`)).toBe(true)
    expect(apply).not.toHaveBeenCalled()
  })

  it("reconciles a recoverable claimed envelope left by an interrupted import", async () => {
    const file = fixture({ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} })
    const consuming = `${file}.consuming`
    fs.renameSync(file, consuming)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply }))
      .resolves.toEqual(["sanctuary"])
    expect(persist).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(consuming)).toBe(false)
  })

  it("preserves a claimed envelope when cache application unexpectedly rejects it", async () => {
    const file = fixture({ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} })

    await expect(loadContainerCredentialBootstrap(["sanctuary"], {
      path: file,
      persist: async () => true,
      apply: () => false,
    })).rejects.toThrow("message is invalid")
    expect(fs.existsSync(`${file}.consuming`)).toBe(true)
  })

  it("preserves malformed claimed imports for explicit reconciliation", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "container-bootstrap-malformed-"))
    const file = path.join(directory, "credentials.json")
    fs.writeFileSync(file, "not-json", { mode: 0o600 })

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist: async () => true, apply: () => true }))
      .rejects.toThrow()
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.consuming`)).toBe(true)
  })

  it("rejects unsafe, oversized, duplicate, unknown-agent, and ambiguous bootstrap files without applying them", async () => {
    const message = { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} }
    const file = fixture(message)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)
    fs.chmodSync(file, 0o640)
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply })).rejects.toThrow("0600")

    fs.rmSync(`${file}.consuming`)
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: [message] }), { mode: 0o600 })
    const link = path.join(directory, "link.json")
    fs.symlinkSync(file, link)
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: link, persist, apply })).rejects.toThrow("regular file")

    await expect(loadContainerCredentialBootstrap(["other"], { path: file, persist, apply })).rejects.toThrow("not enabled")
    fs.rmSync(`${file}.consuming`)

    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: [message, message] }), { mode: 0o600 })
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply })).rejects.toThrow("duplicate")
    fs.rmSync(`${file}.consuming`)

    fs.writeFileSync(file, "x".repeat(131_073), { mode: 0o600 })
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply })).rejects.toThrow("too large")
    fs.rmSync(`${file}.consuming`)

    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: [message] }), { mode: 0o600 })
    fs.writeFileSync(`${file}.consuming`, JSON.stringify({ schemaVersion: 1, credentials: [message] }), { mode: 0o600 })
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply })).rejects.toThrow("both source and claimed")

    expect(persist).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it("treats an absent bootstrap as no credentials", async () => {
    await expect(loadContainerCredentialBootstrap(["sanctuary"], {
      path: "/tmp/definitely-absent-sanctuary-bootstrap",
      persist: async () => true,
      apply: () => true,
    })).resolves.toEqual([])
  })
})
