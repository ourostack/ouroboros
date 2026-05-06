import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

import {
  clearVaultUnlockSecret,
  credentialVaultNotConfiguredError,
  getVaultUnlockStatus,
  isCredentialVaultNotConfiguredError,
  noteVaultUnlockSelfHeal,
  promptConfirmedVaultUnlockSecret,
  readVaultUnlockSecret,
  resolveVaultUnlockStore,
  storeVaultUnlockSecret,
  vaultCreateRecoverFix,
  vaultUnlockReplaceRecoverFix,
  type VaultUnlockConfig,
  type VaultUnlockDeps,
} from "../../repertoire/vault-unlock"

const config: VaultUnlockConfig = {
  agentName: "slugger",
  email: "operator@example.com",
  serverUrl: "https://vault.example.com",
}

const createdDirs: string[] = []
let originalLocalAppData: string | undefined

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function tempHome(prefix = "ouro-vault-unlock-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

function vaultDigest(serverUrl: string, email: string): string {
  return crypto.createHash("sha256").update(`${serverUrl}:${email}`).digest("hex").slice(0, 24)
}

function legacyPlaintextPath(homeDir: string, serverUrl: string, email: string): string {
  return path.join(homeDir, ".ouro-cli", "vault-unlock", `${vaultDigest(serverUrl, email)}.secret`)
}

function legacyWindowsDpapiPath(homeDir: string, serverUrl: string, email: string): string {
  return path.join(homeDir, ".ouro-cli", "vault-unlock-dpapi", "vault-unlock", `${vaultDigest(serverUrl, email)}.dpapi`)
}

function ok(stdout = ""): ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>> {
  return { status: 0, stdout, stderr: "" } as ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>>
}

function fail(stderr = "nope", message?: string): ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>> {
  return {
    status: 1,
    stdout: "",
    stderr,
    ...(message ? { error: new Error(message) } : {}),
  } as ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>>
}

function failWithNonStringStderr(): ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>> {
  return {
    status: 1,
    stdout: "",
    stderr: Buffer.from(""),
  } as ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>>
}

function missingCommand(): ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>> {
  const error = Object.assign(new Error("missing command"), { code: "ENOENT" })
  return { status: null, stdout: "", stderr: "", error } as ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>>
}

describe("vault unlock local stores", () => {
  beforeEach(() => {
    originalLocalAppData = process.env.LOCALAPPDATA
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData
    }
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("confirms new vault unlock secrets before returning them", async () => {
    emitTestEvent("vault unlock confirmed prompt")
    const prompts: string[] = []
    const secret = await promptConfirmedVaultUnlockSecret({
      promptSecret: async (question) => {
        prompts.push(question)
        return "Strong-secret1!"
      },
      question: "Choose secret: ",
      confirmQuestion: "Confirm secret: ",
      emptyError: "empty secret",
    })

    expect(secret).toBe("Strong-secret1!")
    expect(prompts).toEqual(["Choose secret: ", "Confirm secret: "])
  })

  it("rejects weak or mismatched new vault unlock secrets with actionable errors", async () => {
    emitTestEvent("vault unlock confirmed prompt guards")
    const weakPrompt = vi.fn(async () => "weak")
    await expect(promptConfirmedVaultUnlockSecret({
      promptSecret: weakPrompt,
      question: "Choose secret: ",
      confirmQuestion: "Confirm secret: ",
      emptyError: "empty secret",
    })).rejects.toThrow("add at least 8 characters, an uppercase letter, a number, a special character")
    expect(weakPrompt).toHaveBeenCalledTimes(1)

    await expect(promptConfirmedVaultUnlockSecret({
      promptSecret: async () => "PASSWORD1!",
      question: "Choose secret: ",
      confirmQuestion: "Confirm secret: ",
      emptyError: "empty secret",
    })).rejects.toThrow("add a lowercase letter")

    const mismatchAnswers = ["Strong-secret1!", "Other-secret1!"]
    await expect(promptConfirmedVaultUnlockSecret({
      promptSecret: async () => mismatchAnswers.shift() ?? "",
      question: "Choose secret: ",
      confirmQuestion: "Confirm secret: ",
      emptyError: "empty secret",
    })).rejects.toThrow("vault unlock secrets did not match")

    await expect(promptConfirmedVaultUnlockSecret({
      promptSecret: async () => "   ",
      question: "Choose secret: ",
      confirmQuestion: "Confirm secret: ",
      emptyError: "empty secret",
    })).rejects.toThrow("empty secret")
  })

  it("selects platform secure stores and explicit plaintext fallback", () => {
    emitTestEvent("vault unlock store selection")

    expect(resolveVaultUnlockStore(config, { platform: "darwin" })).toMatchObject({
      kind: "macos-keychain",
      secure: true,
      location: "macOS Keychain",
    })
    expect(resolveVaultUnlockStore(config, { platform: "darwin", store: "macos-keychain" })).toMatchObject({
      kind: "macos-keychain",
      secure: true,
      location: "macOS Keychain",
    })

    process.env.LOCALAPPDATA = tempHome("ouro-localappdata-")
    const windowsStore = resolveVaultUnlockStore(config, { platform: "win32", homeDir: "/unused" })
    expect(windowsStore.kind).toBe("windows-dpapi")
    expect(windowsStore.location).toContain(path.join(process.env.LOCALAPPDATA, "Ouro", "vault-unlock"))
    expect(resolveVaultUnlockStore(config, { platform: "win32", homeDir: "/unused", store: "windows-dpapi" })).toMatchObject({
      kind: "windows-dpapi",
      secure: true,
    })

    delete process.env.LOCALAPPDATA
    const windowsHomeStore = resolveVaultUnlockStore(config, { platform: "win32", homeDir: "/home/tester" })
    expect(windowsHomeStore.location).toContain(path.join("/home/tester", ".ouro-cli", "vault-unlock-dpapi"))

    const linuxSpawn = vi.fn(() => ok("secret-tool 1.0\n"))
    expect(resolveVaultUnlockStore(config, { platform: "linux", spawnSync: linuxSpawn })).toMatchObject({
      kind: "linux-secret-service",
      secure: true,
    })
    expect(resolveVaultUnlockStore(config, { platform: "linux", store: "linux-secret-service", spawnSync: linuxSpawn })).toMatchObject({
      kind: "linux-secret-service",
      secure: true,
    })

    const plaintext = resolveVaultUnlockStore(config, { store: "plaintext-file", homeDir: "/tmp/ouro-test-home" })
    expect(plaintext.kind).toBe("plaintext-file")
    expect(plaintext.secure).toBe(false)
  })

  it("rejects unavailable or unknown store requests with repair text", () => {
    emitTestEvent("vault unlock store rejection")

    expect(() => resolveVaultUnlockStore(config, { platform: "linux", store: "macos-keychain" })).toThrow("only available on macOS")
    expect(() => resolveVaultUnlockStore(config, { platform: "darwin", store: "linux-secret-service" })).toThrow("only available on Linux")
    expect(() => resolveVaultUnlockStore(config, { platform: "darwin", store: "windows-dpapi" })).toThrow("only available on Windows")
    expect(() => resolveVaultUnlockStore(config, { store: "mystery-store" as never })).toThrow("unknown vault unlock store")

    const noSecretTool = vi.fn(() => missingCommand())
    expect(() => resolveVaultUnlockStore(config, { platform: "linux", store: "linux-secret-service", spawnSync: noSecretTool })).toThrow("requires the `secret-tool` command")

    const status = getVaultUnlockStatus(config, { platform: "linux", spawnSync: noSecretTool })
    expect(status).toMatchObject({
      configured: false,
      stored: false,
    })
    expect(status.fix).toContain("No supported secure local secret store was found")
  })

  it("renders explicit create-first guidance for agents without a configured vault locator", () => {
    emitTestEvent("vault unlock missing locator guidance")

    const error = credentialVaultNotConfiguredError("slugger", "/bundles/slugger.ouro/agent.json")
    expect(error).toContain("credential vault is not configured in /bundles/slugger.ouro/agent.json")
    expect(error).toContain("ouro vault create --agent slugger")
    expect(isCredentialVaultNotConfiguredError(error)).toBe(true)
    expect(isCredentialVaultNotConfiguredError("vault locked")).toBe(false)

    const fix = vaultCreateRecoverFix("slugger")
    expect(fix).toBe("Run 'ouro vault create --agent slugger' to set up this agent's vault.")
    // nextStep parameter is accepted for backward compat but ignored in concise mode
    const fixWithNext = vaultCreateRecoverFix("slugger", "ignored step")
    expect(fixWithNext).toBe("Run 'ouro vault create --agent slugger' to set up this agent's vault.")

    const unlockFix = vaultUnlockReplaceRecoverFix("slugger")
    expect(unlockFix).toBe("Run 'ouro vault unlock --agent slugger' or 'ouro vault replace --agent slugger' if the secret is lost.")
    // nextStep parameter is accepted for backward compat but ignored in concise mode
    const unlockFixWithNext = vaultUnlockReplaceRecoverFix("slugger", "ignored step")
    expect(unlockFixWithNext).toBe("Run 'ouro vault unlock --agent slugger' or 'ouro vault replace --agent slugger' if the secret is lost.")
  })

  it("records canonical unlock self-heal only after validation callers invoke it", () => {
    emitTestEvent("vault unlock self-heal event")

    noteVaultUnlockSelfHeal(config, "macos-keychain", "https://vault.ouro.bot")

    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.vault_unlock_self_healed",
      meta: expect.objectContaining({
        store: "macos-keychain",
        sourceServerUrl: "https://vault.ouro.bot",
        targetServerUrl: "https://vault.example.com",
      }),
    }))
  })

  it("falls back to the module spawnSync when linux store probing has no injected runner", async () => {
    emitTestEvent("vault unlock default spawnSync fallback")
    vi.resetModules()

    const defaultSpawnSync = vi.fn(() => ok("secret-tool 1.0\n"))
    vi.doMock("node:child_process", () => ({
      spawnSync: (...args: unknown[]) => defaultSpawnSync(...args),
    }))
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
    }))

    const { resolveVaultUnlockStore: resolveVaultUnlockStoreWithDefaultSpawn } = await import("../../repertoire/vault-unlock")
    const store = resolveVaultUnlockStoreWithDefaultSpawn(config, { platform: "linux" })

    expect(store).toMatchObject({
      kind: "linux-secret-service",
      secure: true,
    })
    expect(defaultSpawnSync).toHaveBeenCalledWith("secret-tool", ["--version"], { encoding: "utf8" })
  })

  it("writes and reads explicit plaintext unlock material with private file mode", () => {
    emitTestEvent("vault unlock plaintext roundtrip")
    const homeDir = tempHome()
    const deps: VaultUnlockDeps = { store: "plaintext-file", homeDir, platform: "linux" }

    const store = storeVaultUnlockSecret(config, "  local-unlock-material  ", deps)
    expect(store.kind).toBe("plaintext-file")
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(store.location)).mode & 0o777).toBe(0o700)

    expect(readVaultUnlockSecret(config, deps)).toMatchObject({
      secret: "local-unlock-material",
      store,
    })
    expect(getVaultUnlockStatus(config, deps)).toMatchObject({
      configured: true,
      stored: true,
      store,
      fix: "Vault unlock secret is available on this machine.",
    })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.vault_unlock_loaded",
      message: "loaded vault unlock material from local store",
      meta: expect.objectContaining({ store: "plaintext-file", secure: false, hasAgentName: true }),
    }))
  })

  it("reports missing plaintext material, empty input, and broad local file permissions", () => {
    emitTestEvent("vault unlock plaintext guards")
    const homeDir = tempHome()
    const deps: VaultUnlockDeps = { store: "plaintext-file", homeDir, platform: "linux" }

    expect(getVaultUnlockStatus(config, deps)).toMatchObject({
      configured: true,
      stored: false,
    })
    expect(() => readVaultUnlockSecret(config, deps)).toThrow("Ouro credential vault is locked")
    expect(() => storeVaultUnlockSecret(config, "   ", deps)).toThrow("vault unlock secret is required")

    const store = storeVaultUnlockSecret(config, "local-unlock-material", deps)
    fs.chmodSync(store.location, 0o644)
    expect(() => readVaultUnlockSecret(config, deps)).toThrow("permissions are too broad")
    expect(getVaultUnlockStatus(config, deps)).toMatchObject({
      configured: false,
      stored: false,
    })
  })

  it("explains locked vaults as missing local unlock material, not missing provider credentials", () => {
    emitTestEvent("vault unlock locked message local machine")
    const missingMacos = vi.fn(() => fail(""))
    let message = ""

    try {
      readVaultUnlockSecret(config, {
        platform: "darwin",
        spawnSync: missingMacos as VaultUnlockDeps["spawnSync"],
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain("Provider credentials are still stored in the agent vault.")
    expect(message).toContain("This computer does not currently have usable local unlock material")
    expect(message).toContain("new computer")
	    expect(message).toContain("local profile or hostname migration")
	    expect(message).toContain("enter the saved agent vault unlock secret")
	    expect(message).toContain("ouro vault replace --agent slugger")
	    expect(message).toContain("ouro vault recover --agent slugger --from <json>")
	    expect(message).not.toContain("operator password manager")
	  })

  it("renders no-agent repair guidance for missing secure stores and locked stores", () => {
    emitTestEvent("vault unlock no agent repair guidance")
    const namelessConfig = { email: config.email, serverUrl: config.serverUrl }
    const noSecretTool = vi.fn(() => missingCommand())

    expect(() => resolveVaultUnlockStore(namelessConfig, { platform: "linux", spawnSync: noSecretTool }))
      .toThrow("Run `ouro vault unlock --store plaintext-file`")

    const missingMacos = vi.fn(() => fail(""))
    expect(() => readVaultUnlockSecret(namelessConfig, { platform: "darwin", spawnSync: missingMacos as VaultUnlockDeps["spawnSync"] }))
      .toThrow("Run `ouro vault unlock`")

    const homeDir = tempHome()
    expect(() => readVaultUnlockSecret(namelessConfig, { store: "plaintext-file", homeDir, platform: "linux" }))
      .toThrow("Run `ouro vault unlock --store plaintext-file`")
  })

  it("uses the real home directory only for path resolution when no homeDir override is supplied", () => {
    emitTestEvent("vault unlock default home path")

    const store = resolveVaultUnlockStore(config, { store: "plaintext-file" })

    expect(store.location).toContain(path.join(os.homedir(), [".ouro", "-cli"].join(""), "vault-unlock"))
  })

  it("uses macOS Keychain commands for read and write", () => {
    emitTestEvent("vault unlock macos commands")
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security")
      if (args[0] === "find-generic-password") return ok("local-unlock-material\n")
      if (args[0] === "add-generic-password") return ok()
      return fail("unexpected command")
    })

    expect(readVaultUnlockSecret(config, { platform: "darwin", spawnSync: spawn as VaultUnlockDeps["spawnSync"] }).secret)
      .toBe("local-unlock-material")
    expect(storeVaultUnlockSecret(config, "new-material", { platform: "darwin", spawnSync: spawn as VaultUnlockDeps["spawnSync"] }))
      .toMatchObject({ kind: "macos-keychain" })
    expect(spawn).toHaveBeenCalledWith("security", expect.arrayContaining(["add-generic-password", "-w", "new-material"]), expect.anything())

    const failedWrite = vi.fn(() => fail("access denied"))
    expect(() => storeVaultUnlockSecret(config, "new-material", { platform: "darwin", spawnSync: failedWrite as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to store vault unlock secret in macOS Keychain: access denied")

    const failedWriteNoStderr = vi.fn(() => fail(""))
    expect(() => storeVaultUnlockSecret(config, "new-material", { platform: "darwin", spawnSync: failedWriteNoStderr as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to store vault unlock secret in macOS Keychain")

    const nonStringRead = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security")
      if (args[0] === "find-generic-password") return { status: 0, stdout: Buffer.from("local-unlock-material\n"), stderr: "" } as never
      return ok()
    })
    expect(() => readVaultUnlockSecret(config, { platform: "darwin", spawnSync: nonStringRead as VaultUnlockDeps["spawnSync"] }))
      .toThrow("Ouro credential vault is locked")

    const failedWriteNonStringStderr = vi.fn(() => failWithNonStringStderr())
    expect(() => storeVaultUnlockSecret(config, "new-material", { platform: "darwin", spawnSync: failedWriteNonStringStderr as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to store vault unlock secret in macOS Keychain")
  })

  it("reuses legacy macOS keychain accounts without rewriting before validation", () => {
    emitTestEvent("vault unlock macos alias fallback")
    const canonicalConfig = {
      ...config,
      serverUrl: "https://vault.ouroboros.bot",
    }
    const primaryAccount = "https://vault.ouroboros.bot:operator@example.com"
    const legacyAccount = "https://vault.ouro.bot:operator@example.com"
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security")
      if (args[0] === "find-generic-password") {
        const account = String(args[4])
        if (account === primaryAccount) return fail("The specified item could not be found in the keychain.")
        if (account === legacyAccount) return ok("legacy-unlock-material\n")
      }
      return fail("unexpected command")
    })

    const loaded = readVaultUnlockSecret(canonicalConfig, { platform: "darwin", spawnSync: spawn as VaultUnlockDeps["spawnSync"] })
    expect(loaded.secret).toBe("legacy-unlock-material")
    expect(loaded.source).toMatchObject({ serverUrl: "https://vault.ouro.bot" })

    const lookupAccounts = spawn.mock.calls
      .filter((call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[])[0] === "find-generic-password")
      .map((call: unknown[]) => String((call[1] as string[])[4]))
    expect(lookupAccounts).toEqual([primaryAccount, legacyAccount])
    expect(spawn).not.toHaveBeenCalledWith("security", expect.arrayContaining(["add-generic-password"]), expect.anything())
  })

  it("clears rejected macOS keychain unlock material", () => {
    emitTestEvent("vault unlock macos clear rejected")
    const canonicalConfig = {
      ...config,
      serverUrl: "https://vault.ouroboros.bot",
    }
    const primaryAccount = "https://vault.ouroboros.bot:operator@example.com"
    const legacyAccount = "https://vault.ouro.bot:operator@example.com"
    const deleted: string[] = []
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security")
      if (args[0] === "delete-generic-password") {
        const account = String(args[4])
        if (account === primaryAccount || account === legacyAccount) {
          deleted.push(account)
          return ok()
        }
        return fail("The specified item could not be found in the keychain.")
      }
      return fail("unexpected command")
    })

    expect(clearVaultUnlockSecret(canonicalConfig, { platform: "darwin", spawnSync: spawn as VaultUnlockDeps["spawnSync"] }))
      .toMatchObject({ kind: "macos-keychain" })
    expect(deleted).toEqual(expect.arrayContaining([primaryAccount, legacyAccount]))
  })

  it("surfaces macOS keychain clear failures", () => {
    emitTestEvent("vault unlock macos clear failure")
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security")
      if (args[0] === "delete-generic-password") return fail("User interaction is not allowed.")
      return fail("unexpected command")
    })

    expect(() => clearVaultUnlockSecret(config, { platform: "darwin", spawnSync: spawn as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to clear vault unlock secret from macOS Keychain: User interaction is not allowed.")

    const spawnWithErrorObject = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security")
      if (args[0] === "delete-generic-password") return fail("", "keychain daemon unavailable")
      return fail("unexpected command")
    })
    expect(() => clearVaultUnlockSecret(config, { platform: "darwin", spawnSync: spawnWithErrorObject as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to clear vault unlock secret from macOS Keychain: keychain daemon unavailable")

    const spawnWithNonStringStderr = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security")
      if (args[0] === "delete-generic-password") {
        return { status: 1, stdout: "", stderr: Buffer.from(""), error: new Error("keychain daemon unavailable") } as ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>>
      }
      return fail("unexpected command")
    })
    expect(() => clearVaultUnlockSecret(config, { platform: "darwin", spawnSync: spawnWithNonStringStderr as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to clear vault unlock secret from macOS Keychain: keychain daemon unavailable")
  })

  it("surfaces macOS keychain read failures instead of relabeling them as a locked vault", () => {
    emitTestEvent("vault unlock macos read failure")
    const deniedRead = vi.fn(() => fail("User interaction is not allowed."))

    expect(() => readVaultUnlockSecret(config, {
      platform: "darwin",
      spawnSync: deniedRead as VaultUnlockDeps["spawnSync"],
    })).toThrow("failed to read vault unlock secret from macOS Keychain: User interaction is not allowed.")

    expect(getVaultUnlockStatus(config, {
      platform: "darwin",
      spawnSync: deniedRead as VaultUnlockDeps["spawnSync"],
    })).toMatchObject({
      configured: false,
      stored: false,
      error: "failed to read vault unlock secret from macOS Keychain: User interaction is not allowed.",
    })
  })

  it("uses macOS keychain command error text when stderr is empty", () => {
    emitTestEvent("vault unlock macos read error object")
    const deniedRead = vi.fn(() => fail("", "keychain daemon unavailable"))

    expect(() => readVaultUnlockSecret(config, {
      platform: "darwin",
      spawnSync: deniedRead as VaultUnlockDeps["spawnSync"],
    })).toThrow("failed to read vault unlock secret from macOS Keychain: keychain daemon unavailable")
  })

  it("treats macOS keychain failures with non-string stderr and no error detail as missing local unlock material", () => {
    emitTestEvent("vault unlock macos read non-string stderr")
    const deniedRead = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: Buffer.from(""),
    }) as ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>>)

    expect(() => readVaultUnlockSecret(config, {
      platform: "darwin",
      spawnSync: deniedRead as VaultUnlockDeps["spawnSync"],
    })).toThrow("Ouro credential vault is locked")
  })

  it("keeps legacy macOS keychain reads side-effect free", () => {
    emitTestEvent("vault unlock macos alias side-effect free")
    const canonicalConfig = {
      ...config,
      serverUrl: "https://vault.ouroboros.bot",
    }
    const primaryAccount = "https://vault.ouroboros.bot:operator@example.com"
    const legacyAccount = "https://vault.ouro.bot:operator@example.com"
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("security")
      if (args[0] === "find-generic-password") {
        const account = String(args[4])
        if (account === primaryAccount) return fail("The specified item could not be found in the keychain.")
        if (account === legacyAccount) return ok("legacy-unlock-material\n")
      }
      return fail("unexpected command")
    })

    const loaded = readVaultUnlockSecret(canonicalConfig, { platform: "darwin", spawnSync: spawn as VaultUnlockDeps["spawnSync"] })
    expect(loaded.secret).toBe("legacy-unlock-material")
    expect(spawn).not.toHaveBeenCalledWith("security", expect.arrayContaining(["add-generic-password"]), expect.anything())
  })

  it("uses Linux Secret Service commands for read and write", () => {
    emitTestEvent("vault unlock linux commands")
    const spawn = vi.fn((command: string, args: readonly string[], options: { input?: string } = {}) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      if (args[0] === "lookup") return ok("local-unlock-material\n")
      if (args[0] === "store") {
        expect(options.input).toBe("new-material")
        return ok()
      }
      return fail("unexpected command")
    })

    expect(readVaultUnlockSecret(config, { platform: "linux", spawnSync: spawn as VaultUnlockDeps["spawnSync"] }).secret)
      .toBe("local-unlock-material")
    expect(storeVaultUnlockSecret(config, "new-material", { platform: "linux", spawnSync: spawn as VaultUnlockDeps["spawnSync"] }))
      .toMatchObject({ kind: "linux-secret-service" })

    const failedWrite = vi.fn((command: string, args: readonly string[]) => args[0] === "--version" ? ok() : fail("collection locked"))
    expect(() => storeVaultUnlockSecret(config, "new-material", { platform: "linux", spawnSync: failedWrite as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to store vault unlock secret in Linux Secret Service: collection locked")

    const missingLookup = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      if (args[0] === "lookup") return ok("")
      return fail("unexpected command")
    })
    expect(() => readVaultUnlockSecret(config, { platform: "linux", spawnSync: missingLookup as VaultUnlockDeps["spawnSync"] }))
      .toThrow("Ouro credential vault is locked")

    const failedWriteNoStderr = vi.fn((command: string, args: readonly string[]) => args[0] === "--version" ? ok() : fail(""))
    expect(() => storeVaultUnlockSecret(config, "new-material", { platform: "linux", spawnSync: failedWriteNoStderr as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to store vault unlock secret in Linux Secret Service")

    const nonStringLookup = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      if (args[0] === "lookup") return { status: 0, stdout: Buffer.from("local-unlock-material\n"), stderr: "" } as never
      return fail("unexpected command")
    })
    expect(() => readVaultUnlockSecret(config, { platform: "linux", spawnSync: nonStringLookup as VaultUnlockDeps["spawnSync"] }))
      .toThrow("Ouro credential vault is locked")

    const failedWriteNonStringStderr = vi.fn((command: string, args: readonly string[]) => args[0] === "--version" ? ok() : failWithNonStringStderr())
    expect(() => storeVaultUnlockSecret(config, "new-material", { platform: "linux", spawnSync: failedWriteNonStringStderr as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to store vault unlock secret in Linux Secret Service")
  })

  it("reuses legacy Linux Secret Service accounts without rewriting before validation", () => {
    emitTestEvent("vault unlock linux alias fallback")
    const canonicalConfig = {
      ...config,
      serverUrl: "https://vault.ouroboros.bot",
    }
    const primaryAccount = "https://vault.ouroboros.bot:operator@example.com"
    const legacyAccount = "https://vault.ouro.bot:operator@example.com"
    const spawn = vi.fn((command: string, args: readonly string[], options: { input?: string } = {}) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      if (args[0] === "lookup") {
        const account = String(args[4])
        if (account === primaryAccount) return fail("not found")
        if (account === legacyAccount) return ok("legacy-unlock-material\n")
      }
      return fail("unexpected command")
    })

    const loaded = readVaultUnlockSecret(canonicalConfig, { platform: "linux", spawnSync: spawn as VaultUnlockDeps["spawnSync"] })
    expect(loaded.secret).toBe("legacy-unlock-material")
    expect(loaded.source).toMatchObject({ serverUrl: "https://vault.ouro.bot" })
    expect(spawn).not.toHaveBeenCalledWith("secret-tool", expect.arrayContaining(["store"]), expect.anything())
  })

  it("clears rejected Linux Secret Service unlock material", () => {
    emitTestEvent("vault unlock linux clear rejected")
    const canonicalConfig = {
      ...config,
      serverUrl: "https://vault.ouroboros.bot",
    }
    const primaryAccount = "https://vault.ouroboros.bot:operator@example.com"
    const legacyAccount = "https://vault.ouro.bot:operator@example.com"
    const cleared: string[] = []
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      if (args[0] === "clear") {
        const account = String(args[4])
        if (account === primaryAccount || account === legacyAccount) {
          cleared.push(account)
          return ok()
        }
        return fail("not found")
      }
      return fail("unexpected command")
    })

    expect(clearVaultUnlockSecret(canonicalConfig, { platform: "linux", spawnSync: spawn as VaultUnlockDeps["spawnSync"] }))
      .toMatchObject({ kind: "linux-secret-service" })
    expect(cleared).toEqual(expect.arrayContaining([primaryAccount, legacyAccount]))
  })

  it("surfaces Linux Secret Service clear failures", () => {
    emitTestEvent("vault unlock linux clear failure")
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      if (args[0] === "clear") return fail("collection locked")
      return fail("unexpected command")
    })

    expect(() => clearVaultUnlockSecret(config, { platform: "linux", spawnSync: spawn as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to clear vault unlock secret from Linux Secret Service: collection locked")

    const spawnWithErrorObject = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      if (args[0] === "clear") return fail("", "secret service bus unavailable")
      return fail("unexpected command")
    })
    expect(() => clearVaultUnlockSecret(config, { platform: "linux", spawnSync: spawnWithErrorObject as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to clear vault unlock secret from Linux Secret Service: secret service bus unavailable")

    const spawnWithNonStringStderr = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      if (args[0] === "clear") {
        return { status: 1, stdout: "", stderr: Buffer.from(""), error: new Error("secret service bus unavailable") } as ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>>
      }
      return fail("unexpected command")
    })
    expect(() => clearVaultUnlockSecret(config, { platform: "linux", spawnSync: spawnWithNonStringStderr as VaultUnlockDeps["spawnSync"] }))
      .toThrow("failed to clear vault unlock secret from Linux Secret Service: secret service bus unavailable")
  })

  it("surfaces Linux Secret Service read failures instead of relabeling them as a locked vault", () => {
    emitTestEvent("vault unlock linux read failure")
    const deniedLookup = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      return fail("collection locked")
    })

    expect(() => readVaultUnlockSecret(config, {
      platform: "linux",
      spawnSync: deniedLookup as VaultUnlockDeps["spawnSync"],
    })).toThrow("failed to read vault unlock secret from Linux Secret Service: collection locked")
  })

  it("uses Linux Secret Service command error text when stderr is empty", () => {
    emitTestEvent("vault unlock linux read error object")
    const deniedLookup = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      return fail("", "secret service bus unavailable")
    })

    expect(() => readVaultUnlockSecret(config, {
      platform: "linux",
      spawnSync: deniedLookup as VaultUnlockDeps["spawnSync"],
    })).toThrow("failed to read vault unlock secret from Linux Secret Service: secret service bus unavailable")
  })

  it("treats Linux Secret Service failures with non-string stderr and no error detail as missing local unlock material", () => {
    emitTestEvent("vault unlock linux read non-string stderr")
    const deniedLookup = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("secret-tool")
      if (args[0] === "--version") return ok("secret-tool 1.0\n")
      return {
        status: 1,
        stdout: "",
        stderr: Buffer.from(""),
      } as ReturnType<NonNullable<VaultUnlockDeps["spawnSync"]>>
    })

    expect(() => readVaultUnlockSecret(config, {
      platform: "linux",
      spawnSync: deniedLookup as VaultUnlockDeps["spawnSync"],
    })).toThrow("Ouro credential vault is locked")
  })

  it("uses Windows DPAPI files without exposing local unlock material", () => {
    emitTestEvent("vault unlock windows dpapi")
    const homeDir = tempHome()
    const spawn = vi.fn((_command: string, _args: readonly string[], options: { input?: string } = {}) => {
      const payload = JSON.parse(options.input ?? "{}") as { mode: string }
      if (payload.mode === "protect") return ok("ciphertext\n")
      if (payload.mode === "unprotect") return ok("local-unlock-material\n")
      return fail("bad mode")
    })
    const deps: VaultUnlockDeps = { platform: "win32", homeDir, spawnSync: spawn as VaultUnlockDeps["spawnSync"] }

    const store = storeVaultUnlockSecret(config, "local-unlock-material", deps)
    expect(store.kind).toBe("windows-dpapi")
    expect(fs.readFileSync(store.location, "utf8")).toBe("ciphertext\n")
    expect(readVaultUnlockSecret(config, deps).secret).toBe("local-unlock-material")

    const emptyProtect = vi.fn((_command: string, _args: readonly string[], options: { input?: string } = {}) => {
      const payload = JSON.parse(options.input ?? "{}") as { mode: string }
      if (payload.mode === "protect") return { status: 0, stdout: Buffer.from(""), stderr: "" } as never
      return fail("unexpected mode")
    })
    const emptyStore = storeVaultUnlockSecret(config, "local-unlock-material", {
      platform: "win32",
      homeDir,
      spawnSync: emptyProtect as VaultUnlockDeps["spawnSync"],
    })
    expect(fs.readFileSync(emptyStore.location, "utf8")).toBe("\n")
  })

  it("reuses legacy Windows DPAPI files without rewriting before validation", () => {
    emitTestEvent("vault unlock windows dpapi alias fallback")
    const homeDir = tempHome()
    const legacyServerUrl = "https://vault.ouro.bot"
    const legacyPath = legacyWindowsDpapiPath(homeDir, legacyServerUrl, config.email)
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, "legacy-ciphertext\n", "utf8")

    const spawn = vi.fn((_command: string, _args: readonly string[], options: { input?: string } = {}) => {
      const payload = JSON.parse(options.input ?? "{}") as { mode: string }
      if (payload.mode === "unprotect") return ok("legacy-unlock-material\n")
      if (payload.mode === "protect") return fail("unexpected rewrite")
      return fail("bad mode")
    })
    const deps: VaultUnlockDeps = { platform: "win32", homeDir, spawnSync: spawn as VaultUnlockDeps["spawnSync"] }

    expect(readVaultUnlockSecret({ ...config, serverUrl: "https://vault.ouroboros.bot" }, deps).secret).toBe("legacy-unlock-material")

    const canonicalStore = resolveVaultUnlockStore({ ...config, serverUrl: "https://vault.ouroboros.bot" }, deps)
    expect(fs.existsSync(canonicalStore.location)).toBe(false)
  })

  it("clears rejected Windows DPAPI unlock files", () => {
    emitTestEvent("vault unlock windows dpapi clear rejected")
    const homeDir = tempHome()
    const legacyServerUrl = "https://vault.ouro.bot"
    const legacyPath = legacyWindowsDpapiPath(homeDir, legacyServerUrl, config.email)
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, "legacy-ciphertext\n", "utf8")

    const deps: VaultUnlockDeps = { platform: "win32", homeDir }

    clearVaultUnlockSecret({ ...config, serverUrl: "https://vault.ouroboros.bot" }, deps)

    const canonicalStore = resolveVaultUnlockStore({ ...config, serverUrl: "https://vault.ouroboros.bot" }, deps)
    expect(fs.existsSync(canonicalStore.location)).toBe(false)
    expect(fs.existsSync(legacyPath)).toBe(false)
  })

  it("reports Windows DPAPI protect and unprotect failures", () => {
    emitTestEvent("vault unlock windows dpapi failures")
    const homeDir = tempHome()
    const protectFail = vi.fn(() => fail("", "boom"))
    expect(() => storeVaultUnlockSecret(config, "local-unlock-material", {
      platform: "win32",
      homeDir,
      spawnSync: protectFail as VaultUnlockDeps["spawnSync"],
    })).toThrow("Windows DPAPI protect failed: boom")

    const store = resolveVaultUnlockStore(config, { platform: "win32", homeDir })
    fs.mkdirSync(path.dirname(store.location), { recursive: true })
    fs.writeFileSync(store.location, "ciphertext\n", "utf8")
    const unprotectFail = vi.fn(() => fail("bad cipher"))
    expect(() => readVaultUnlockSecret(config, {
      platform: "win32",
      homeDir,
      spawnSync: unprotectFail as VaultUnlockDeps["spawnSync"],
    })).toThrow("Windows DPAPI unprotect failed: bad cipher")

    const unprotectFailNoDetail = vi.fn(() => fail(""))
    expect(() => readVaultUnlockSecret(config, {
      platform: "win32",
      homeDir,
      spawnSync: unprotectFailNoDetail as VaultUnlockDeps["spawnSync"],
    })).toThrow("Windows DPAPI unprotect failed")

    const unprotectFailNonStringStderr = vi.fn(() => failWithNonStringStderr())
    expect(() => readVaultUnlockSecret(config, {
      platform: "win32",
      homeDir,
      spawnSync: unprotectFailNonStringStderr as VaultUnlockDeps["spawnSync"],
    })).toThrow("Windows DPAPI unprotect failed")
  })

  it("reports missing and empty Windows DPAPI files as locked", () => {
    emitTestEvent("vault unlock windows dpapi missing and empty")
    const homeDir = tempHome()
    const deps: VaultUnlockDeps = { platform: "win32", homeDir, spawnSync: vi.fn(() => ok()) as VaultUnlockDeps["spawnSync"] }

    expect(() => readVaultUnlockSecret(config, deps)).toThrow("Ouro credential vault is locked")

    const store = resolveVaultUnlockStore(config, deps)
    fs.mkdirSync(path.dirname(store.location), { recursive: true })
    fs.writeFileSync(store.location, "\n", "utf8")
    expect(() => readVaultUnlockSecret(config, deps)).toThrow("Ouro credential vault is locked")

    fs.writeFileSync(store.location, "ciphertext\n", "utf8")
    const blankSecret = vi.fn((_command: string, _args: readonly string[], options: { input?: string } = {}) => {
      const payload = JSON.parse(options.input ?? "{}") as { mode: string }
      if (payload.mode === "unprotect") return ok("\n")
      return fail("bad mode")
    })
    expect(() => readVaultUnlockSecret(config, { platform: "win32", homeDir, spawnSync: blankSecret as VaultUnlockDeps["spawnSync"] }))
      .toThrow("Ouro credential vault is locked")
  })

  it("allows plaintext unlock files on Windows without POSIX chmod checks", () => {
    emitTestEvent("vault unlock plaintext windows")
    const homeDir = tempHome()
    const deps: VaultUnlockDeps = { store: "plaintext-file", homeDir, platform: "win32" }
    const store = storeVaultUnlockSecret(config, "local-unlock-material", deps)
    fs.chmodSync(store.location, 0o666)

    expect(readVaultUnlockSecret(config, deps).secret).toBe("local-unlock-material")
  })

  it("reuses legacy plaintext unlock files without rewriting before validation", () => {
    emitTestEvent("vault unlock plaintext alias fallback")
    const homeDir = tempHome()
    const deps: VaultUnlockDeps = { store: "plaintext-file", homeDir, platform: "linux" }
    const legacyPath = legacyPlaintextPath(homeDir, "https://vault.ouro.bot", config.email)
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(legacyPath, "legacy-unlock-material", { encoding: "utf8", mode: 0o600 })
    fs.chmodSync(path.dirname(legacyPath), 0o700)
    fs.chmodSync(legacyPath, 0o600)

    expect(readVaultUnlockSecret({ ...config, serverUrl: "https://vault.ouroboros.bot" }, deps).secret).toBe("legacy-unlock-material")

    const canonicalStore = resolveVaultUnlockStore({ ...config, serverUrl: "https://vault.ouroboros.bot" }, deps)
    expect(fs.existsSync(canonicalStore.location)).toBe(false)
  })

  it("clears rejected plaintext unlock files", () => {
    emitTestEvent("vault unlock plaintext clear rejected")
    const homeDir = tempHome()
    const deps: VaultUnlockDeps = { store: "plaintext-file", homeDir, platform: "linux" }
    const legacyPath = legacyPlaintextPath(homeDir, "https://vault.ouro.bot", config.email)
    const legacyDir = path.dirname(legacyPath)
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(legacyPath, "legacy-unlock-material", { encoding: "utf8", mode: 0o600 })
    fs.chmodSync(legacyDir, 0o700)
    fs.chmodSync(legacyPath, 0o600)

    clearVaultUnlockSecret({ ...config, serverUrl: "https://vault.ouroboros.bot" }, deps)

    const canonicalStore = resolveVaultUnlockStore({ ...config, serverUrl: "https://vault.ouroboros.bot" }, deps)
    expect(fs.existsSync(canonicalStore.location)).toBe(false)
    expect(fs.existsSync(legacyPath)).toBe(false)
  })

  it("deduplicates equivalent vault coordinates when clearing plaintext unlock files", () => {
    emitTestEvent("vault unlock plaintext clear dedupe")
    const homeDir = tempHome()
    const deps: VaultUnlockDeps = { store: "plaintext-file", homeDir, platform: "linux" }
    const canonicalConfig = { ...config, serverUrl: "https://vault.example.com" }
    const stored = storeVaultUnlockSecret(canonicalConfig, "local-unlock-material", deps)

    clearVaultUnlockSecret({ ...canonicalConfig, serverUrl: "https://vault.example.com/" }, deps)

    expect(fs.existsSync(stored.location)).toBe(false)
  })

  it("treats empty plaintext unlock files as locked", () => {
    emitTestEvent("vault unlock plaintext empty")
    const homeDir = tempHome()
    const deps: VaultUnlockDeps = { store: "plaintext-file", homeDir, platform: "linux" }
    const store = resolveVaultUnlockStore(config, deps)
    fs.mkdirSync(path.dirname(store.location), { recursive: true, mode: 0o700 })
    fs.writeFileSync(store.location, "\n", { encoding: "utf8", mode: 0o600 })
    fs.chmodSync(store.location, 0o600)

    expect(() => readVaultUnlockSecret(config, deps)).toThrow("Ouro credential vault is locked")
  })

  it("reports non-Error local store failures without exposing vault coordinates", () => {
    emitTestEvent("vault unlock status non-error failure")
    const deps = Object.defineProperty({}, "platform", {
      get() {
        throw "local platform unavailable"
      },
    }) as VaultUnlockDeps

    expect(getVaultUnlockStatus(config, deps)).toMatchObject({
      configured: false,
      stored: false,
      error: "local platform unavailable",
      fix: "local platform unavailable",
    })
  })
})
