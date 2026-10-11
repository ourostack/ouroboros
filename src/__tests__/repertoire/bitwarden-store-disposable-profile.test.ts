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

type ProfileState = "empty" | "healthy-locked" | "null-kdf" | "missing-unlock-data" | "not-logged-in"

interface FakeBw {
  calls: string[][]
  /** Profile directory each call ran against (BITWARDENCLI_APPDATA_DIR). */
  dirs: string[]
  /** Password the vault server accepts on a fresh login. */
  serverPassword: string
}

const KDF_NULL_ERROR = "KdfConfig for user 3d5e76cf-3eec-457b-8066-11fd5b6ff31a is null"
const MISSING_UNLOCK_DATA_ERROR = "Master password unlock data is required is null or undefined."

function writeProfile(profileDir: string, state: ProfileState): void {
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, "data.json"), JSON.stringify({ state }))
}

function readProfile(profileDir: string): ProfileState | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(profileDir, "data.json"), "utf8")) as { state: ProfileState }).state
  } catch {
    return null
  }
}

type FakeBwOptions = {
  onUnlock?: (profileDir: string) => void
  unlockError?: string
  loginError?: string
}

/**
 * A stateful stand-in for the bw CLI. Like the real bw, any command creates
 * data.json in an empty profile directory, so a data file alone never proves
 * the profile is authenticated.
 */
function installFakeBw(options: FakeBwOptions = {}): FakeBw {
  const fake: FakeBw = { calls: [], dirs: [], serverPassword: "masterpass123" }
  mockExecFile.mockImplementation((_cmd: string, args: string[], opts: { env: Record<string, string> }, cb: Function) => {
    fake.calls.push(args)
    const profileDir = opts.env.BITWARDENCLI_APPDATA_DIR
    fake.dirs.push(profileDir)
    if (!readProfile(profileDir)) writeProfile(profileDir, "empty")
    const profile = readProfile(profileDir)
    const password = opts.env.OURO_BW_MASTER_PASSWORD
    const fail = (message: string) => cb(Object.assign(new Error(message), { code: 1 }), "", message)
    switch (args[0]) {
      case "status": {
        if (profile === "empty") {
          cb(null, JSON.stringify({ status: "unauthenticated", serverUrl: null }), "")
          return
        }
        const status = profile === "not-logged-in" ? "unlocked" : "locked"
        cb(null, JSON.stringify({ status, serverUrl: profile === "healthy-locked" ? "https://vault.ouro.bot" : null, userEmail: "ouroboros@ouro.bot" }), "")
        return
      }
      case "config":
        if (profile !== "empty") {
          fail("Logout required before server config update.")
          return
        }
        cb(null, "Saved setting `config`.", "")
        return
      case "unlock":
        options.onUnlock?.(profileDir)
        if (options.unlockError) return fail(options.unlockError)
        if (profile === "null-kdf") return fail(KDF_NULL_ERROR)
        if (profile === "missing-unlock-data") return fail(MISSING_UNLOCK_DATA_ERROR)
        if (profile === "not-logged-in") return fail("You are not logged in.")
        if (password !== fake.serverPassword) return fail("Invalid master password.")
        cb(null, "unlocked-session", "")
        return
      case "logout":
        writeProfile(profileDir, "empty")
        cb(null, "You have logged out.", "")
        return
      case "login":
        if (options.loginError) return fail(options.loginError)
        if (password !== fake.serverPassword) return fail("Username or password is incorrect. Try again")
        writeProfile(profileDir, "healthy-locked")
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

function discardEvents(): Array<Record<string, unknown>> {
  return nervesEvents.filter((event) => event.event === "repertoire.bw_local_profile_discarded")
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
    vi.useRealTimers()
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
    bwBinaryPath = path.join(fakeBinDir, version, "bin", "bw")
    if (fs.existsSync(bwBinaryPath)) return
    const pkgDir = path.join(fakeBinDir, version, "node_modules", "@bitwarden", "cli")
    fs.mkdirSync(path.join(pkgDir, "build"), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@bitwarden/cli", version }))
    fs.writeFileSync(path.join(pkgDir, "build", "bw.js"), "#!/usr/bin/env node\n")
    fs.mkdirSync(path.join(fakeBinDir, version, "bin"), { recursive: true })
    fs.symlinkSync(path.join(pkgDir, "build", "bw.js"), bwBinaryPath)
  }

  async function loginWithFakeTimers(store: BitwardenCredentialStore): Promise<unknown> {
    vi.useFakeTimers()
    const outcome = store.login().then(() => null, (error: unknown) => error)
    await vi.runAllTimersAsync()
    return outcome
  }

  const corruptions: Array<[string, ProfileState]> = [
    ["a null KdfConfig (profile half-migrated by a newer bw)", "null-kdf"],
    ["missing master password unlock data", "missing-unlock-data"],
    ["a missing or expired login session", "not-logged-in"],
  ]

  for (const [label, state] of corruptions) {
    it(`recovers silently from ${label}`, async () => {
      writeProfile(appDataDir, state)
      const fake = installFakeBw()
      const { store, onInvalidUnlockSecret } = newStore()

      const items = await store.list()

      expect(items.map((item) => item.domain)).toEqual(["github.com"])
      expect(onInvalidUnlockSecret).not.toHaveBeenCalled()
      expect(readProfile(appDataDir)).toBe("healthy-locked")
      expect(JSON.parse(fs.readFileSync(path.join(appDataDir, "data.json.discarded"), "utf8"))).toEqual({ state })
      // The broken profile reports no server URL, so bw refuses `config server`
      // ("logout required") before the failed local unlock; then one fresh login.
      expect(fake.calls.map((call) => call[0])).toEqual(["status", "config", "unlock", "status", "config", "login", "sync", "list"])
      expect(discardEvents()).toEqual([expect.objectContaining({ level: "warn" })])
    })
  }

  it("keeps one profile per bw version, so several bw installs never share or migrate one", async () => {
    installFakeBwPackage("2026.6.0")
    const fake = installFakeBw()
    await newStore().store.login()
    installFakeBwPackage("2026.9.1")
    await newStore().store.login()
    installFakeBwPackage("2026.6.0")
    await newStore().store.login()

    expect(new Set(fake.dirs)).toEqual(new Set([path.join(appDataDir, "bw-2026.6.0"), path.join(appDataDir, "bw-2026.9.1")]))
    // Each version logs in to the server once; returning to 2026.6.0 reuses its profile.
    expect(fake.calls.filter((call) => call[0] === "login")).toHaveLength(2)
    expect(readProfile(path.join(appDataDir, "bw-2026.6.0"))).toBe("healthy-locked")
    expect(readProfile(path.join(appDataDir, "bw-2026.9.1"))).toBe("healthy-locked")
    expect(discardEvents()).toHaveLength(0)
  })

  it("logs in once on a fresh profile and reports a wrong secret without discarding", async () => {
    const fake = installFakeBw()
    const { store, onInvalidUnlockSecret } = newStore(vi.fn(), "WrongSecret1!")

    await expect(store.login()).rejects.toThrow("rejected the saved vault unlock secret")

    // Real bw creates data.json on `bw status`; that must not count as a profile.
    expect(fake.calls.map((call) => call[0])).toEqual(["status", "config", "login"])
    expect(onInvalidUnlockSecret).toHaveBeenCalledTimes(1)
    expect(discardEvents()).toHaveLength(0)
  })

  it("rebuilds an authenticated profile once when local unlock says Invalid master password", async () => {
    writeProfile(appDataDir, "healthy-locked")
    const fake = installFakeBw()
    const { store, onInvalidUnlockSecret } = newStore(vi.fn(), "WrongSecret1!")

    await expect(store.login()).rejects.toThrow("rejected the saved vault unlock secret")

    expect(fake.calls.map((call) => call[0])).toEqual(["status", "unlock", "logout", "config", "login"])
    expect(onInvalidUnlockSecret).toHaveBeenCalledTimes(1)
    expect(discardEvents()).toHaveLength(0)
  })

  it("discards once and asks the server once when bw reports a wrong secret as a decryption failure", async () => {
    writeProfile(appDataDir, "healthy-locked")
    const fake = installFakeBw({ unlockError: "Cryptography error, The decryption operation failed" })
    const { store, onInvalidUnlockSecret } = newStore(vi.fn(), "WrongSecret1!")

    await expect(store.login()).rejects.toThrow("rejected the saved vault unlock secret")

    expect(fake.calls.map((call) => call[0])).toEqual(["status", "unlock", "status", "config", "login"])
    expect(onInvalidUnlockSecret).toHaveBeenCalledTimes(1)
    expect(discardEvents()).toHaveLength(1)
  })

  it("propagates a second local failure after the rebuild instead of looping", async () => {
    writeProfile(appDataDir, "null-kdf")
    let unlocks = 0
    const fake = installFakeBw()
    const original = mockExecFile.getMockImplementation()!
    mockExecFile.mockImplementation((cmd: string, args: string[], opts: { env: Record<string, string> }, cb: Function) => {
      if (args[0] === "login") {
        fake.calls.push(args)
        unlocks += 1
        // A bw that keeps producing a broken profile: the fresh login half-succeeds.
        writeProfile(opts.env.BITWARDENCLI_APPDATA_DIR, "null-kdf")
        cb(Object.assign(new Error("already logged in"), { code: 1 }), "", "You are already logged in as ouroboros@ouro.bot.")
        return
      }
      original(cmd, args, opts, cb)
    })

    const error = await newStore().store.login().catch((caught: Error) => caught)

    expect(String(error)).toContain("KdfConfig")
    expect(unlocks).toBe(1)
    expect(discardEvents()).toHaveLength(1)
  })

  const serverFailures: Array<[string, string]> = [
    ["a rate limit", "Request failed with status code 429"],
    ["a bad gateway", "502 Bad Gateway"],
    ["a gateway timeout", "504 Gateway Timeout"],
    ["a reset connection", "read ECONNRESET"],
    ["a DNS failure", "getaddrinfo EAI_AGAIN vault.ouro.bot"],
    ["an unreachable network", "connect ENETUNREACH 10.0.0.1:443"],
    ["an unreachable host", "connect EHOSTUNREACH 10.0.0.1:443"],
    ["a failed fetch", "fetch failed"],
  ]

  for (const [label, message] of serverFailures) {
    it(`treats ${label} during login as transient and never discards or reports the secret`, async () => {
      const fake = installFakeBw({ loginError: message })
      const { store, onInvalidUnlockSecret } = newStore()

      const error = await loginWithFakeTimers(store)

      expect(String(error)).toContain("bw CLI error")
      expect(fake.calls.filter((call) => call[0] === "login")).toHaveLength(3)
      expect(onInvalidUnlockSecret).not.toHaveBeenCalled()
      expect(discardEvents()).toHaveLength(0)
    })
  }

  it("does not discard a usable profile for a transient network failure during unlock", async () => {
    writeProfile(appDataDir, "healthy-locked")
    installFakeBw({ unlockError: "connect ETIMEDOUT 104.16.5.34:443" })
    const { store } = newStore()

    const error = await loginWithFakeTimers(store)

    expect(String(error)).toContain("ETIMEDOUT")
    expect(readProfile(appDataDir)).toBe("healthy-locked")
    expect(discardEvents()).toHaveLength(0)
  })

  it("does not discard a profile another process is holding", async () => {
    writeProfile(appDataDir, "healthy-locked")
    installFakeBw({ unlockError: "bw CLI lock timeout: could not acquire /x/.ouro-bw.lock within 75000ms" })

    await expect(newStore().store.login()).rejects.toThrow("bw CLI lock timeout")
    expect(readProfile(appDataDir)).toBe("healthy-locked")
    expect(discardEvents()).toHaveLength(0)
  })

  it("treats a profile that vanished mid-recovery as already discarded", async () => {
    writeProfile(appDataDir, "null-kdf")
    installFakeBw({
      onUnlock: (profileDir) => fs.rmSync(path.join(profileDir, "data.json"), { force: true }),
    })

    await newStore().store.login()

    expect(fs.existsSync(path.join(appDataDir, "data.json.discarded"))).toBe(false)
    expect(readProfile(appDataDir)).toBe("healthy-locked")
  })

  it("retries a terminal login failure after the retry window instead of holding it until restart", async () => {
    vi.useFakeTimers()
    const fake = installFakeBw({ loginError: "Your account is disabled." })
    const { store } = newStore()

    await expect(store.login()).rejects.toThrow("disabled")
    await expect(store.login()).rejects.toThrow("disabled")
    expect(fake.calls.filter((call) => call[0] === "login")).toHaveLength(1)

    vi.setSystemTime(Date.now() + 16 * 60_000)
    await expect(store.login()).rejects.toThrow("disabled")
    expect(fake.calls.filter((call) => call[0] === "login")).toHaveLength(2)
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
