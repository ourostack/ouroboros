import * as fs from "node:fs"
import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const bootstrapMocks = vi.hoisted(() => ({
  homeDir: "/tmp/container-bootstrap-default-home",
  persist: vi.fn(async () => true),
  apply: vi.fn(() => true),
  validate: vi.fn(() => true),
  machineIdentity: vi.fn(() => ({ machineId: "machine_default" })),
}))

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => bootstrapMocks.homeDir,
}))
vi.mock("../../../heart/runtime-credentials", () => ({
  persistRuntimeCredentialBootstrapMessage: (...args: unknown[]) => bootstrapMocks.persist(...args),
  applyRuntimeCredentialBootstrapMessage: (...args: unknown[]) => bootstrapMocks.apply(...args),
  isRuntimeCredentialBootstrapMessage: (...args: unknown[]) => bootstrapMocks.validate(...args),
}))
vi.mock("../../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: () => bootstrapMocks.machineIdentity(),
}))

import {
  getDefaultContainerCredentialBootstrapPath,
  loadContainerCredentialBootstrap,
} from "../../../heart/daemon/container-credential-bootstrap"

describe("container credential bootstrap", () => {
  let directory = ""

  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  function fixture(message: Record<string, unknown>): string {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "container-bootstrap-"))
    const file = path.join(directory, "credentials.json")
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: [message] }), { mode: 0o600 })
    return file
  }

  function envelopeFixture(messages: Array<Record<string, unknown>>): string {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "container-bootstrap-"))
    const file = path.join(directory, "credentials.json")
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: messages }), { mode: 0o600 })
    return file
  }

  type MachineIdMigration = {
    sourceMachineId: string
    targetMachineId: string
    discardProviderCredentialRecords?: { providers: string[] }
  }

  async function loadWithMigration(
    enabledAgents: string[],
    options: {
      path: string
      machineIdMigration: MachineIdMigration
      persist?: (message: unknown) => Promise<boolean>
      apply?: (message: unknown) => boolean
    },
  ): Promise<string[]> {
    return (loadContainerCredentialBootstrap as unknown as (
      agents: string[],
      migrationOptions: typeof options,
    ) => Promise<string[]>)(enabledAgents, options)
  }

  function digest(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex")
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

  it("imports the exact SAB machine-vault envelope through the real loader and deletes both transport files", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const runtimeCredentials = await vi.importActual<typeof import("../../../heart/runtime-credentials")>("../../../heart/runtime-credentials")
    bootstrapMocks.validate.mockImplementation(runtimeCredentials.isRuntimeCredentialBootstrapMessage)
    const file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary",
      machineRuntimeConfig: { sabnzbdApiKey: "test-only-sab-secret" },
    })
    let vaultReadback: Record<string, unknown> | undefined
    const persist = vi.fn(async (message: unknown) => {
      vaultReadback = structuredClone((message as { machineRuntimeConfig: Record<string, unknown> }).machineRuntimeConfig)
      return true
    })

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply: () => true })).resolves.toEqual(["sanctuary"])
    expect(vaultReadback).toEqual({ sabnzbdApiKey: "test-only-sab-secret" })
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.consuming`)).toBe(false)
    bootstrapMocks.validate.mockImplementation(() => true)
    bootstrapMocks.machineIdentity.mockImplementation(() => ({ machineId: "machine_default" }))
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

  it("treats a rejected durable message as a persistence failure and preserves the claim", async () => {
    const file = fixture({ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} })

    await expect(loadContainerCredentialBootstrap(["sanctuary"], {
      path: file,
      persist: async () => false,
      apply: () => true,
    })).rejects.toThrow("container credential bootstrap persistence failed")
    expect(fs.existsSync(`${file}.consuming`)).toBe(true)
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

  it("rejects an empty credential envelope without deleting its recoverable claim", async () => {
    const file = envelopeFixture([])
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    let failure: unknown
    try {
      await loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("container credential bootstrap must contain at least one credential")
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.consuming`)).toBe(true)
    expect(persist).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it("rejects unsafe, oversized, duplicate, and unknown-agent bootstrap files without applying them", async () => {
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

  it("uses the default claim path, machine identity, durable writer, and cache writer", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "container-bootstrap-default-"))
    bootstrapMocks.homeDir = directory
    const file = getDefaultContainerCredentialBootstrapPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      credentials: [{ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} }],
    }), { mode: 0o600 })

    await expect(loadContainerCredentialBootstrap(["sanctuary"])).resolves.toEqual(["sanctuary"])
    expect(bootstrapMocks.machineIdentity).toHaveBeenCalledTimes(1)
    expect(bootstrapMocks.persist).toHaveBeenCalledWith(expect.anything(), { machineId: "machine_default" })
    expect(bootstrapMocks.apply).not.toHaveBeenCalled()
  })

  it("validates every message and machine binding before the first vault write", async () => {
    const file = envelopeFixture([
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: { first: "secret" } },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "other", runtimeConfg: { typo: "secret" } },
    ])
    bootstrapMocks.validate.mockImplementation((message: unknown) => !(message as Record<string, unknown>).runtimeConfg)
    const persist = vi.fn(async () => true)

    await expect(loadContainerCredentialBootstrap(["sanctuary", "other"], { path: file, persist }))
      .rejects.toThrow("message is invalid")
    expect(persist).not.toHaveBeenCalled()
    expect(fs.existsSync(`${file}.consuming`)).toBe(true)

    bootstrapMocks.validate.mockReturnValue(true)
    fs.rmSync(`${file}.consuming`)
    const mismatch = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "machine_other",
      machineRuntimeConfig: { unraidReadApiKey: "secret" },
    })
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: mismatch, persist }))
      .rejects.toThrow("machineId does not match this machine")
    expect(bootstrapMocks.machineIdentity).toHaveBeenCalledTimes(1)
    expect(persist).not.toHaveBeenCalled()
  })

  it("migrates only exact sanctuary-unraid messages to in-memory sanctuary clones", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const first = {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary-unraid",
      runtimeConfig: { telegramBotToken: "secret" },
    }
    const second = {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "other",
      machineId: "sanctuary-unraid",
      providerCredentialRecords: [{ provider: "openai-compatible", credential: "secret" }],
    }
    const file = envelopeFixture([first, second])
    const original = fs.readFileSync(file)
    const originalDigest = digest(original)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadWithMigration(["sanctuary", "other"], {
      path: file,
      machineIdMigration: { sourceMachineId: "sanctuary-unraid", targetMachineId: "sanctuary" },
      persist,
      apply,
    })).resolves.toEqual(["other", "sanctuary"])

    expect(persist).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(2)
    for (const callback of [persist, apply]) {
      expect(callback).toHaveBeenNthCalledWith(1, { ...first, machineId: "sanctuary" })
      expect(callback).toHaveBeenNthCalledWith(2, { ...second, machineId: "sanctuary" })
      expect(callback.mock.calls[0]?.[0]).not.toBe(first)
      expect(callback.mock.calls[1]?.[0]).not.toBe(second)
    }
    expect(first.machineId).toBe("sanctuary-unraid")
    expect(second.machineId).toBe("sanctuary-unraid")
    expect(digest(original)).toBe(originalDigest)
  })

  it("discards only the exact allowlisted legacy provider set from in-memory migration clones", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const runtimeCredentials = await vi.importActual<typeof import("../../../heart/runtime-credentials")>(
      "../../../heart/runtime-credentials",
    )
    bootstrapMocks.validate.mockImplementationOnce(runtimeCredentials.isRuntimeCredentialBootstrapMessage)
    const legacy = {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary-unraid",
      runtimeConfig: { telegramBotToken: "secret" },
      machineRuntimeConfig: { unraidReadApiKey: "read-secret" },
      providerCredentialRecords: [{
        provider: "minimax",
        revision: "legacy-revision-that-current-validation-rejects",
        credentials: { apiKey: "obsolete-secret" },
      }],
    }
    const file = fixture(legacy)
    const original = fs.readFileSync(file)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadWithMigration(["sanctuary"], {
      path: file,
      machineIdMigration: {
        sourceMachineId: "sanctuary-unraid",
        targetMachineId: "sanctuary",
        discardProviderCredentialRecords: { providers: ["minimax"] },
      },
      persist,
      apply,
    })).resolves.toEqual(["sanctuary"])

    const projected = {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary",
      runtimeConfig: { telegramBotToken: "secret" },
      machineRuntimeConfig: { unraidReadApiKey: "read-secret" },
    }
    expect(bootstrapMocks.validate).toHaveBeenCalledWith(projected)
    expect(persist).toHaveBeenCalledWith(projected)
    expect(apply).toHaveBeenCalledWith(projected)
    expect(legacy.machineId).toBe("sanctuary-unraid")
    expect(legacy.providerCredentialRecords).toHaveLength(1)
    expect(digest(original)).toBe(digest(Buffer.from(JSON.stringify({ schemaVersion: 1, credentials: [legacy] }))))
  })

  it("validates every discard projection before the first persist", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const runtimeCredentials = await vi.importActual<typeof import("../../../heart/runtime-credentials")>(
      "../../../heart/runtime-credentials",
    )
    bootstrapMocks.validate
      .mockImplementationOnce(runtimeCredentials.isRuntimeCredentialBootstrapMessage)
      .mockImplementationOnce(runtimeCredentials.isRuntimeCredentialBootstrapMessage)
    const file = envelopeFixture([
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "sanctuary",
        machineId: "sanctuary-unraid",
        runtimeConfig: { telegramBotToken: "secret" },
        providerCredentialRecords: [{ provider: "minimax", revision: "legacy-revision" }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "other",
        machineId: "sanctuary-unraid",
        runtimeConfig: {},
      },
    ])
    const original = fs.readFileSync(file)
    const persist = vi.fn(async () => true)

    await expect(loadWithMigration(["sanctuary", "other"], {
      path: file,
      machineIdMigration: {
        sourceMachineId: "sanctuary-unraid",
        targetMachineId: "sanctuary",
        discardProviderCredentialRecords: { providers: ["minimax"] },
      },
      persist,
    })).rejects.toThrow("message is invalid")

    expect(persist).not.toHaveBeenCalled()
    expect(fs.readFileSync(`${file}.consuming`)).toEqual(original)
  })

  it("retains the original discard claim across a failed persist and resumes idempotently", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const runtimeCredentials = await vi.importActual<typeof import("../../../heart/runtime-credentials")>(
      "../../../heart/runtime-credentials",
    )
    bootstrapMocks.validate
      .mockImplementationOnce(runtimeCredentials.isRuntimeCredentialBootstrapMessage)
      .mockImplementationOnce(runtimeCredentials.isRuntimeCredentialBootstrapMessage)
    const file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary-unraid",
      runtimeConfig: { telegramBotToken: "secret" },
      machineRuntimeConfig: { unraidReadApiKey: "read-secret" },
      providerCredentialRecords: [{ provider: "minimax", revision: "legacy-revision" }],
    })
    const original = fs.readFileSync(file)
    const migration = {
      sourceMachineId: "sanctuary-unraid",
      targetMachineId: "sanctuary",
      discardProviderCredentialRecords: { providers: ["minimax"] },
    }
    const failedPersist = vi.fn(async () => false)

    await expect(loadWithMigration(["sanctuary"], {
      path: file,
      machineIdMigration: migration,
      persist: failedPersist,
    })).rejects.toThrow("persistence failed")
    expect(fs.readFileSync(`${file}.consuming`)).toEqual(original)

    const successfulPersist = vi.fn(async () => true)
    await expect(loadWithMigration(["sanctuary"], {
      path: file,
      machineIdMigration: migration,
      persist: successfulPersist,
    })).resolves.toEqual(["sanctuary"])
    expect(successfulPersist).toHaveBeenCalledWith(expect.not.objectContaining({ providerCredentialRecords: expect.anything() }))
    expect(fs.existsSync(`${file}.consuming`)).toBe(false)
  })

  it("keeps the default path strict for the same obsolete provider bytes", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    bootstrapMocks.validate.mockReturnValueOnce(false)
    const file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary-unraid",
      runtimeConfig: { telegramBotToken: "secret" },
      providerCredentialRecords: [{ provider: "minimax", revision: "legacy-revision" }],
    })
    const original = fs.readFileSync(file)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply }))
      .rejects.toThrow("message is invalid")

    expect(persist).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(fs.readFileSync(`${file}.consuming`)).toEqual(original)
  })

  it.each([
    ["malformed policy", [], [{ provider: "minimax" }]],
    ["empty allowlist", { providers: [] }, [{ provider: "minimax" }]],
    ["duplicate allowlist", { providers: ["minimax", "minimax"] }, [{ provider: "minimax" }]],
    ["wrong allowlist", { providers: ["openai-compatible"] }, [{ provider: "minimax" }]],
    ["extra legacy provider", { providers: ["minimax"] }, [{ provider: "minimax" }, { provider: "gemini" }]],
    ["duplicate legacy provider", { providers: ["minimax"] }, [{ provider: "minimax" }, { provider: "minimax" }]],
    ["missing provider name", { providers: ["minimax"] }, [{}]],
    ["empty provider records", { providers: ["minimax"] }, []],
    ["non-object provider", { providers: ["minimax"] }, ["minimax"]],
  ])("rejects %s discard authority before the first persist/apply", async (_name, discard, providerCredentialRecords) => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    bootstrapMocks.validate.mockReturnValue(true)
    const file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary-unraid",
      runtimeConfig: { telegramBotToken: "secret" },
      providerCredentialRecords,
    })
    const original = fs.readFileSync(file)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadWithMigration(["sanctuary"], {
      path: file,
      machineIdMigration: {
        sourceMachineId: "sanctuary-unraid",
        targetMachineId: "sanctuary",
        discardProviderCredentialRecords: discard as { providers: string[] },
      },
      persist,
      apply,
    })).rejects.toThrow(/discard|provider/i)

    expect(persist).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(fs.readFileSync(`${file}.consuming`)).toEqual(original)
  })

  it("rejects a provider-only message whose discard projection would contain no credential fields", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    bootstrapMocks.validate.mockReturnValueOnce(false)
    const file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary-unraid",
      providerCredentialRecords: [{ provider: "minimax", revision: "legacy-revision" }],
    })
    const persist = vi.fn(async () => true)

    await expect(loadWithMigration(["sanctuary"], {
      path: file,
      machineIdMigration: {
        sourceMachineId: "sanctuary-unraid",
        targetMachineId: "sanctuary",
        discardProviderCredentialRecords: { providers: ["minimax"] },
      },
      persist,
    })).rejects.toThrow("message is invalid")
    expect(persist).not.toHaveBeenCalled()
  })

  it.each([
    ["blank source", { sourceMachineId: "", targetMachineId: "sanctuary" }],
    ["whitespace source", { sourceMachineId: " sanctuary-unraid", targetMachineId: "sanctuary" }],
    ["blank target", { sourceMachineId: "sanctuary-unraid", targetMachineId: "" }],
    ["whitespace target", { sourceMachineId: "sanctuary-unraid", targetMachineId: "sanctuary " }],
    ["equal identities", { sourceMachineId: "sanctuary", targetMachineId: "sanctuary" }],
    ["wrong current target", { sourceMachineId: "sanctuary-unraid", targetMachineId: "other-machine" }],
  ])("rejects %s migration authority before persist/apply and preserves the claimed bytes", async (_name, migration) => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary",
      runtimeConfig: { telegramBotToken: "secret" },
    })
    const original = fs.readFileSync(file)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadWithMigration(["sanctuary"], {
      path: file,
      machineIdMigration: migration,
      persist,
      apply,
    })).rejects.toThrow(/machine|migration|source|target/i)

    expect(persist).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(`${file}.consuming`)).toEqual(original)
    expect(digest(fs.readFileSync(`${file}.consuming`))).toBe(digest(original))
  })

  it.each([
    ["absent source id", undefined],
    ["wrong source id", "sanctuary"],
    ["trimmed-only source id", "sanctuary-unraid "],
  ])("rejects a mixed envelope with %s before the first persist/apply", async (_name, secondMachineId) => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const file = envelopeFixture([
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "sanctuary",
        machineId: "sanctuary",
        runtimeConfig: { telegramBotToken: "secret" },
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "other",
        ...(secondMachineId === undefined ? {} : { machineId: secondMachineId }),
        runtimeConfig: { anotherSecret: "secret" },
      },
    ])
    const original = fs.readFileSync(file)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadWithMigration(["sanctuary", "other"], {
      path: file,
      machineIdMigration: { sourceMachineId: "sanctuary-unraid", targetMachineId: "sanctuary" },
      persist,
      apply,
    })).rejects.toThrow(/machineId|source/i)

    expect(persist).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(fs.readFileSync(`${file}.consuming`)).toEqual(original)
  })

  it("keeps the default importer strict when an alias is not explicitly authorized", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "sanctuary-unraid",
      runtimeConfig: { telegramBotToken: "secret" },
    })
    const original = fs.readFileSync(file)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply }))
      .rejects.toThrow("machineId does not match this machine")
    expect(persist).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(fs.readFileSync(`${file}.consuming`)).toEqual(original)
  })

  it("rejects whitespace-padded machine identity on the default importer path", async () => {
    bootstrapMocks.machineIdentity.mockReturnValue({ machineId: "sanctuary" })
    const file = fixture({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: " sanctuary ",
      runtimeConfig: { telegramBotToken: "secret" },
    })
    const original = fs.readFileSync(file)
    const persist = vi.fn(async () => true)
    const apply = vi.fn(() => true)

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist, apply }))
      .rejects.toThrow("machineId does not match this machine")
    expect(persist).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(fs.readFileSync(`${file}.consuming`)).toEqual(original)
  })

  it("durably discards only an identical redundant source and resumes the claimed envelope", async () => {
    const file = fixture({ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: { token: "secret" } })
    fs.copyFileSync(file, `${file}.consuming`)
    fs.chmodSync(`${file}.consuming`, 0o600)
    const persist = vi.fn(async () => true)

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist })).resolves.toEqual(["sanctuary"])
    expect(persist).toHaveBeenCalledOnce()
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.consuming`)).toBe(false)
  })

  it("fails closed with human-required quarantine guidance when source and claim differ", async () => {
    const file = fixture({ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: { token: "source-secret" } })
    fs.writeFileSync(`${file}.consuming`, JSON.stringify({
      schemaVersion: 1,
      credentials: [{ type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: { token: "claim-secret" } }],
    }), { mode: 0o600 })
    const persist = vi.fn(async () => true)

    let failure: unknown
    try {
      await loadContainerCredentialBootstrap(["sanctuary"], { path: file, persist })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("human-required")
    expect((failure as Error).message).toContain("securely compare")
    expect((failure as Error).message).toContain("quarantine")
    expect((failure as Error).message).not.toContain("source-secret")
    expect((failure as Error).message).not.toContain("claim-secret")
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(`${file}.consuming`)).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it("rejects invalid envelope shapes, unsupported fields, unsafe claimed files, and owner mismatch", async () => {
    const message = { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} }
    const file = fixture(message)
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, credentials: [] }), { mode: 0o600 })
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file })).rejects.toThrow("envelope is invalid")
    fs.rmSync(`${file}.consuming`)

    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: [], extra: true }), { mode: 0o600 })
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file })).rejects.toThrow("unsupported fields")
    fs.rmSync(`${file}.consuming`)

    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, credentials: [message] }), { mode: 0o600 })
    fs.renameSync(file, `${file}.target`)
    fs.symlinkSync(`${file}.target`, `${file}.consuming`)
    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file })).rejects.toThrow("consuming state must be a regular file")
    fs.rmSync(`${file}.consuming`)

    fs.renameSync(`${file}.target`, `${file}.consuming`)
    const getuid = process.getuid
    if (getuid) {
      vi.spyOn(process, "getuid").mockReturnValue(getuid() + 1)
      await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: file })).rejects.toThrow("owned by the runtime user")
    }
  })

  it("rethrows non-absence filesystem errors while probing the source", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "container-bootstrap-stat-error-"))
    const blocker = path.join(directory, "not-a-directory")
    fs.writeFileSync(blocker, "x", { mode: 0o600 })

    await expect(loadContainerCredentialBootstrap(["sanctuary"], { path: path.join(blocker, "credentials.json") }))
      .rejects.toMatchObject({ code: "ENOTDIR" })
  })
})
