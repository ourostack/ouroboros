import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The bw app data directory is a disposable cache. These tests model a real
// bw profile on disk (data.json) and corrupt it the ways we have seen in the
// field, then expect the store to recover with the saved unlock secret and
// no human prompt.

const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

let bwBinaryPath = "/nonexistent/bw"
vi.mock("../../repertoire/bw-installer", () => ({
  ensureBwCli: vi.fn(async () => bwBinaryPath),
}))

const mockExecFile = vi.fn()
vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))

import { BitwardenCredentialStore, readBwCliVersion } from "../../repertoire/bitwarden-store"

type ProfileState = "healthy-locked" | "null-kdf" | "missing-unlock-data" | "not-logged-in"

interface FakeBw {
  calls: string[][]
  /** Password the vault server accepts on a fresh login. */
  serverPassword: string
}

const KDF_NULL_ERROR = "KdfConfig for user 3d5e76cf-3eec-457b-8066-11fd5b6ff31a is null"
const MISSING_UNLOCK_DATA_ERROR = "Master password unlock data is required is null or undefined."

function writeProfile(appDataDir: string, state: ProfileState): void {
  fs.writeFileSync(path.join(appDataDir, "data.json"), JSON.stringify({ state }))
}

function readProfile(appDataDir: string): ProfileState | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(appDataDir, "data.json"), "utf8")) as { state: ProfileState }).state
  } catch {
    return null
  }
}

/** A stateful stand-in for the bw CLI that reads and writes data.json. */
function installFakeBw(appDataDir: string, options: { onUnlock?: () => void; transientUnlock?: boolean } = {}): FakeBw {
  const fake: FakeBw = { calls: [], serverPassword: "masterpass123" }
  mockExecFile.mockImplementation((_cmd: string, args: string[], opts: { env: Record<string, string> }, cb: Function) => {
    fake.calls.push(args)
    const profile = readProfile(appDataDir)
    const password = opts.env.OURO_BW_MASTER_PASSWORD
    const fail = (message: string) => cb(Object.assign(new Error(message), { code: 1 }), "", message)
    switch (args[0]) {
      case "status": {
        if (!profile) {
          cb(null, JSON.stringify({ status: "unauthenticated", serverUrl: null }), "")
          return
        }
        const status = profile === "not-logged-in" ? "unlocked" : "locked"
        cb(null, JSON.stringify({ status, serverUrl: profile === "healthy-locked" ? "https://vault.ouro.bot" : null, userEmail: "ouroboros@ouro.bot" }), "")
        return
      }
      case "config":
        if (profile) {
          fail("Logout required before server config update.")
          return
        }
        cb(null, "Saved setting `config`.", "")
        return
      case "unlock":
        options.onUnlock?.()
        if (options.transientUnlock) {
          fail("connect ETIMEDOUT 104.16.5.34:443")
          return
        }
        if (profile === "null-kdf") return fail(KDF_NULL_ERROR)
        if (profile === "missing-unlock-data") return fail(MISSING_UNLOCK_DATA_ERROR)
        if (profile === "not-logged-in") return fail("You are not logged in.")
        if (password !== fake.serverPassword) return fail("Cryptography error, The decryption operation failed")
        cb(null, "unlocked-session", "")
        return
      case "login":
        if (password !== fake.serverPassword) {
          fail("Username or password is incorrect. Try again")
          return
        }
        writeProfile(appDataDir, "healthy-locked")
        cb(null, "fresh-session", "")
        return
      case "sync":
        cb(null, "Syncing complete.", "")
        return
      case "list":
        cb(null, JSON.stringify([{ id: "item-1", name: "github.com", login: { username: "ouro", password: "pw" } }]), "")
        return
      default:
        cb(null, "", "")
    }
  })
  return fake
}

describe("BitwardenCredentialStore disposable local profile", () => {
  let appDataDir: string
  let fakeBinDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-disposable-"))
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-fake-cli-"))
    bwBinaryPath = "/nonexistent/bw"
  })

  afterEach(() => {
    fs.rmSync(appDataDir, { recursive: true, force: true })
    fs.rmSync(fakeBinDir, { recursive: true, force: true })
  })

  function newStore(onInvalidUnlockSecret = vi.fn(), password = "masterpass123") {
    return {
      onInvalidUnlockSecret,
      store: new BitwardenCredentialStore("https://vault.ouro.bot", "ouroboros@ouro.bot", password, {
        appDataDir,
        onInvalidUnlockSecret,
      }),
    }
  }

  function installFakeBwPackage(version: string): void {
    const pkgDir = path.join(fakeBinDir, "node_modules", "@bitwarden", "cli")
    fs.mkdirSync(path.join(pkgDir, "build"), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@bitwarden/cli", version }))
    fs.writeFileSync(path.join(pkgDir, "build", "bw.js"), "#!/usr/bin/env node\n")
    fs.mkdirSync(path.join(fakeBinDir, "bin"), { recursive: true })
    fs.symlinkSync(path.join(pkgDir, "build", "bw.js"), path.join(fakeBinDir, "bin", "bw"))
    bwBinaryPath = path.join(fakeBinDir, "bin", "bw")
  }

  const corruptions: Array<[string, ProfileState]> = [
    ["a null KdfConfig (profile half-migrated by a newer bw)", "null-kdf"],
    ["missing master password unlock data", "missing-unlock-data"],
    ["a missing or expired login session", "not-logged-in"],
  ]

  for (const [label, state] of corruptions) {
    it(`recovers silently from ${label}`, async () => {
      writeProfile(appDataDir, state)
      const fake = installFakeBw(appDataDir)
      const { store, onInvalidUnlockSecret } = newStore()

      const items = await store.list()

      expect(items.map((item) => item.domain)).toEqual(["github.com"])
      expect(onInvalidUnlockSecret).not.toHaveBeenCalled()
      expect(readProfile(appDataDir)).toBe("healthy-locked")
      expect(JSON.parse(fs.readFileSync(path.join(appDataDir, "data.json.discarded"), "utf8"))).toEqual({ state })
      // The broken profile reports no server URL, so bw refuses `config server`
      // ("logout required") before the failed unlock; then the fresh profile logs in.
      expect(fake.calls.map((call) => call[0])).toEqual(["status", "config", "unlock", "status", "config", "login", "sync", "list"])
      expect(nervesEvents).toContainEqual(expect.objectContaining({
        event: "repertoire.bw_local_profile_discarded",
        level: "warn",
        meta: expect.objectContaining({ reason: "existing local bw profile could not be used" }),
      }))
    })
  }

  it("discards a profile written by a different bw version before using it", async () => {
    installFakeBwPackage("2026.9.1")
    writeProfile(appDataDir, "null-kdf")
    fs.writeFileSync(path.join(appDataDir, ".ouro-bw-version"), "2026.6.0\n")
    fs.writeFileSync(path.join(appDataDir, ".ouro-last-sync"), `${Date.now()}\n`)
    const fake = installFakeBw(appDataDir)
    const { store } = newStore()

    await store.login()

    expect(fake.calls.map((call) => call[0])).toEqual(["status", "config", "login", "sync"])
    expect(fs.readFileSync(path.join(appDataDir, ".ouro-bw-version"), "utf8")).toBe("2026.9.1\n")
    expect(nervesEvents).toContainEqual(expect.objectContaining({
      event: "repertoire.bw_local_profile_discarded",
      meta: expect.objectContaining({
        reason: "local bw profile was written by bw 2026.6.0; running bw 2026.9.1",
        error: null,
      }),
    }))
  })

  it("keeps a profile written by the running bw version and records it after login", async () => {
    installFakeBwPackage("2026.9.1")
    writeProfile(appDataDir, "healthy-locked")
    fs.writeFileSync(path.join(appDataDir, ".ouro-bw-version"), "2026.9.1\n")
    const fake = installFakeBw(appDataDir)
    const { store } = newStore()

    await store.login()

    expect(fake.calls.map((call) => call[0])).toEqual(["status", "unlock"])
    expect(fs.existsSync(path.join(appDataDir, "data.json.discarded"))).toBe(false)
  })

  it("reports a rejected secret only after a fresh profile also fails, and discards once", async () => {
    writeProfile(appDataDir, "healthy-locked")
    const fake = installFakeBw(appDataDir)
    const { store, onInvalidUnlockSecret } = newStore(vi.fn(), "WrongSecret1!")

    await expect(store.login()).rejects.toThrow("bw CLI error: bw CLI rejected the saved vault unlock secret for this machine")

    expect(fake.calls.map((call) => call[0])).toEqual(["status", "unlock", "status", "config", "login"])
    expect(onInvalidUnlockSecret).toHaveBeenCalledTimes(1)
    expect(nervesEvents.filter((event) => event.event === "repertoire.bw_local_profile_discarded")).toHaveLength(1)
  })

  it("does not discard when there was no local profile to begin with", async () => {
    const fake = installFakeBw(appDataDir)
    const { store, onInvalidUnlockSecret } = newStore(vi.fn(), "WrongSecret1!")

    await expect(store.login()).rejects.toThrow("rejected the saved vault unlock secret")

    expect(fake.calls.map((call) => call[0])).toEqual(["status", "config", "login"])
    expect(onInvalidUnlockSecret).toHaveBeenCalledTimes(1)
    expect(nervesEvents.some((event) => event.event === "repertoire.bw_local_profile_discarded")).toBe(false)
  })

  it("does not discard a usable profile for a transient network failure", async () => {
    vi.useFakeTimers()
    try {
      writeProfile(appDataDir, "healthy-locked")
      installFakeBw(appDataDir, { transientUnlock: true })
      const { store } = newStore()

      const login = store.login()
      const assertion = expect(login).rejects.toThrow("ETIMEDOUT")
      await vi.runAllTimersAsync()
      await assertion

      expect(readProfile(appDataDir)).toBe("healthy-locked")
      expect(nervesEvents.some((event) => event.event === "repertoire.bw_local_profile_discarded")).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not discard a profile another process is holding", async () => {
    writeProfile(appDataDir, "healthy-locked")
    installFakeBw(appDataDir)
    const { store } = newStore()
    const lockedOut = new Error("bw CLI lock timeout: could not acquire /x/.ouro-bw.lock within 75000ms")
    const original = mockExecFile.getMockImplementation()!
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: unknown, cb: Function) => {
      if (args[0] === "unlock") {
        cb(lockedOut, "", "")
        return
      }
      original(cmd, args, opts, cb)
    })

    await expect(store.login()).rejects.toThrow("bw CLI lock timeout")
    expect(readProfile(appDataDir)).toBe("healthy-locked")
    expect(nervesEvents.some((event) => event.event === "repertoire.bw_local_profile_discarded")).toBe(false)
  })

  it("treats a profile that vanished mid-recovery as already discarded", async () => {
    writeProfile(appDataDir, "null-kdf")
    installFakeBw(appDataDir, {
      onUnlock: () => fs.rmSync(path.join(appDataDir, "data.json"), { force: true }),
    })
    const { store } = newStore()

    await store.login()

    expect(fs.existsSync(path.join(appDataDir, "data.json.discarded"))).toBe(false)
    expect(readProfile(appDataDir)).toBe("healthy-locked")
  })

  it("ignores an empty version marker and survives an unwritable one", async () => {
    installFakeBwPackage("2026.9.1")
    writeProfile(appDataDir, "healthy-locked")
    fs.writeFileSync(path.join(appDataDir, ".ouro-bw-version"), "\n")
    installFakeBw(appDataDir)
    await newStore().store.login()
    expect(fs.readFileSync(path.join(appDataDir, ".ouro-bw-version"), "utf8")).toBe("2026.9.1\n")

    fs.rmSync(path.join(appDataDir, ".ouro-bw-version"))
    fs.mkdirSync(path.join(appDataDir, ".ouro-bw-version"))
    await expect(newStore().store.login()).resolves.toBeUndefined()
  })
})

describe("readBwCliVersion", () => {
  it("returns null for a binary that does not exist", () => {
    expect(readBwCliVersion("/nonexistent/bw")).toBeNull()
  })

  it("returns null for a binary outside an @bitwarden/cli package", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-not-npm-"))
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }))
      fs.writeFileSync(path.join(dir, "bw"), "")
      expect(readBwCliVersion(path.join(dir, "bw"))).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
