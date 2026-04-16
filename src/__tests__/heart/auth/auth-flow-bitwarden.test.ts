import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const bwHarness = vi.hoisted(() => {
  const items = new Map<string, {
    id: string
    name: string
    login?: {
      username?: string
      password?: string
      uris?: Array<{ uri: string }>
    }
    notes?: string | null
    revisionDate?: string
  }>()
  return {
    items,
    commands: [] as Array<{ args: string[]; session?: string; stdin?: string }>,
    validSession: "",
    sessionsIssued: 0,
    listAllCalls: 0,
    failListAllAtCall: 0,
    failNextListAllWith: null as string | null,
    createCalls: 0,
    failCreateAtCall: 0,
    failNextCreateWith: null as string | null,
    failEveryCreateWith: null as string | null,
    failEveryCreateErrorMessage: null as string | null,
    failEveryCreateStderr: null as string | null,
    reset(): void {
      items.clear()
      this.commands = []
      this.validSession = ""
      this.sessionsIssued = 0
      this.listAllCalls = 0
      this.failListAllAtCall = 0
      this.failNextListAllWith = null
      this.createCalls = 0
      this.failCreateAtCall = 0
      this.failNextCreateWith = null
      this.failEveryCreateWith = null
      this.failEveryCreateErrorMessage = null
      this.failEveryCreateStderr = null
    },
  }
})

const mockExecFile = vi.hoisted(() => vi.fn())

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  }
})

vi.mock("../../../repertoire/bw-installer", () => ({
  ensureBwCli: vi.fn().mockResolvedValue("/usr/local/bin/bw"),
}))

vi.mock("../../../repertoire/vault-unlock", async () => {
  const actual = await vi.importActual<typeof import("../../../repertoire/vault-unlock")>("../../../repertoire/vault-unlock")
  return {
    ...actual,
    readVaultUnlockSecret: vi.fn(() => ({
      secret: "vault-unlock-secret",
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
    })),
  }
})

import { runRuntimeAuthFlow } from "../../../heart/auth/auth-flow"
import { readProviderCredentialRecord, resetProviderCredentialCache } from "../../../heart/provider-credentials"
import { resetCredentialStore } from "../../../repertoire/credential-access"

function writeAgentConfig(homeDir: string, agentName: string): void {
  const agentRoot = path.join(homeDir, "AgentBundles", `${agentName}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify({
    version: 2,
    enabled: true,
    humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
    context: {
      maxTokens: 80000,
      contextMargin: 20,
    },
    vault: {
      email: `${agentName.toLowerCase()}@ouro.bot`,
      serverUrl: "https://vault.ouroboros.bot",
    },
  }, null, 2)}\n`, "utf8")
}

function installBwExecHarness(): void {
  mockExecFile.mockImplementation((_cmd: string, args: string[], opts: { env?: Record<string, string | undefined> } | undefined, cb: Function) => {
    const session = opts?.env?.BW_SESSION
    const commandRecord = { args: [...args], session } as { args: string[]; session?: string; stdin?: string }
    bwHarness.commands.push(commandRecord)

    if (args[0] === "status") {
      cb(null, JSON.stringify({ status: "unlocked", serverUrl: "https://vault.ouroboros.bot" }), "")
      return
    }

    if (args[0] === "config") {
      cb(null, "", "")
      return
    }

    if (args[0] === "unlock" || args[0] === "login") {
      bwHarness.sessionsIssued += 1
      bwHarness.validSession = `session-${bwHarness.sessionsIssued}`
      cb(null, bwHarness.validSession, "")
      return
    }

    if (args[0] === "list") {
      if (session !== bwHarness.validSession) {
        cb(new Error("Command failed: bw list items"), "", "Session key is invalid or expired")
        return
      }
      if (args.includes("--search")) {
        const domain = args[args.length - 1]!
        const item = bwHarness.items.get(domain)
        cb(null, JSON.stringify(item ? [item] : []), "")
        return
      }
      bwHarness.listAllCalls += 1
      if (bwHarness.failNextListAllWith && bwHarness.listAllCalls === bwHarness.failListAllAtCall) {
        const failure = bwHarness.failNextListAllWith
        bwHarness.failNextListAllWith = null
        cb(new Error("Command failed: bw list items"), "", failure)
        return
      }
      cb(null, JSON.stringify([...bwHarness.items.values()]), "")
      return
    }

    if (args[0] === "get" && args[1] === "item") {
      if (session !== bwHarness.validSession) {
        cb(new Error("Command failed: bw get item"), "", "Session key is invalid or expired")
        return
      }
      const id = args[2]
      const item = [...bwHarness.items.values()].find((entry) => entry.id === id)
      if (!item) {
        cb(new Error("Command failed: bw get item"), "", "Not found.")
        return
      }
      cb(null, JSON.stringify(item), "")
      return
    }

    const finishWrite = (stdin: string | undefined): void => {
      commandRecord.stdin = stdin
      if (session !== bwHarness.validSession) {
        cb(new Error(`Command failed: bw ${args.join(" ")}`), "", "Session key is invalid or expired")
        return
      }
      if (args[0] === "create") {
        bwHarness.createCalls += 1
        if (bwHarness.failEveryCreateErrorMessage) {
          cb(new Error(bwHarness.failEveryCreateErrorMessage), "", bwHarness.failEveryCreateStderr ?? "")
          return
        }
        if (bwHarness.failEveryCreateWith) {
          cb(new Error(`Command failed: bw ${args.join(" ")}`), "", bwHarness.failEveryCreateWith)
          return
        }
        if (bwHarness.failNextCreateWith && bwHarness.createCalls === bwHarness.failCreateAtCall) {
          const failure = bwHarness.failNextCreateWith
          bwHarness.failNextCreateWith = null
          cb(new Error(`Command failed: bw ${args.join(" ")}`), "", failure)
          return
        }
      }
      const raw = Buffer.from(stdin ?? "", "base64").toString("utf8")
      const parsed = JSON.parse(raw) as {
        id?: string
        name: string
        login?: { username?: string; password?: string; uris?: Array<{ uri: string }> }
        notes?: string | null
      }
      const existing = parsed.id ? bwHarness.items.get(parsed.name) : undefined
      const id = existing?.id ?? parsed.id ?? `item-${bwHarness.items.size + 1}`
      bwHarness.items.set(parsed.name, {
        ...parsed,
        id,
        revisionDate: "2026-04-15T22:00:00.000Z",
      })
      cb(null, JSON.stringify({ id }), "")
    }

    if (args[0] === "create" || args[0] === "edit") {
      return {
        stdin: {
          end: vi.fn((value: string) => finishWrite(value)),
        },
      }
    }

    cb(null, "", "")
  })
}

describe("runtime auth flow with the Bitwarden-backed provider vault", () => {
  const originalHome = process.env.HOME
  const tempHomes: string[] = []

  afterEach(() => {
    process.env.HOME = originalHome
    for (const dir of tempHomes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    bwHarness.reset()
    mockExecFile.mockReset()
    resetProviderCredentialCache()
    resetCredentialStore()
    vi.clearAllMocks()
  })

  it("stores provider credentials through the real vault path and refreshes the local snapshot", async () => {
    installBwExecHarness()
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth-flow-bw-home-"))
    tempHomes.push(tempHome)
    process.env.HOME = tempHome
    writeAgentConfig(tempHome, "VaultSaveBot")

    const progress: string[] = []
    const result = await runRuntimeAuthFlow({
      agentName: "VaultSaveBot",
      provider: "minimax",
      promptInput: async () => "minimax-secret",
      onProgress: (message) => progress.push(message),
    })

    expect(result.message).toBe("authenticated VaultSaveBot with minimax")
    expect(progress).toEqual([
      "checking VaultSaveBot's vault access...",
      "opening VaultSaveBot's vault session...",
      "storing minimax credentials in VaultSaveBot's vault...",
      "refreshing local provider snapshot from VaultSaveBot's vault...",
      "credentials stored at providers/minimax; local provider snapshot refreshed.",
    ])

    const record = await readProviderCredentialRecord("VaultSaveBot", "minimax")
    expect(record).toMatchObject({
      ok: true,
      record: {
        provider: "minimax",
        credentials: { apiKey: "minimax-secret" },
      },
    })

    const createCommand = bwHarness.commands.find((entry) => entry.args[0] === "create")
    expect(createCommand).toBeDefined()
    expect(createCommand!.args).toEqual(["create", "item"])
    expect(createCommand!.args.join(" ")).not.toContain("minimax-secret")
    expect(createCommand!.stdin).toBeDefined()
    expect(Buffer.from(createCommand!.stdin!, "base64").toString("utf8")).toContain("minimax-secret")
  })

  it("surfaces a clear post-save refresh failure when the vault write succeeded but the snapshot reload did not", async () => {
    installBwExecHarness()
    bwHarness.failNextListAllWith = "server unavailable"
    bwHarness.failListAllAtCall = 2
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth-flow-bw-home-"))
    tempHomes.push(tempHome)
    process.env.HOME = tempHome
    writeAgentConfig(tempHome, "VaultRefreshBot")

    const progress: string[] = []

    await expect(runRuntimeAuthFlow({
      agentName: "VaultRefreshBot",
      provider: "minimax",
      promptInput: async () => "minimax-secret",
      onProgress: (message) => progress.push(message),
    })).rejects.toThrow(
      "provider authentication succeeded and minimax credentials were stored in VaultRefreshBot's vault, but the local provider snapshot refresh failed: bw CLI error: server unavailable. Run 'ouro provider refresh --agent VaultRefreshBot' after fixing vault access, then run 'ouro auth verify --agent VaultRefreshBot'.",
    )

    expect(progress).toEqual([
      "checking VaultRefreshBot's vault access...",
      "opening VaultRefreshBot's vault session...",
      "storing minimax credentials in VaultRefreshBot's vault...",
      "refreshing local provider snapshot from VaultRefreshBot's vault...",
    ])
    expect(bwHarness.items.has("providers/minimax")).toBe(true)
  })

  it("wraps save-time vault failures with agent-scoped repair guidance", async () => {
    installBwExecHarness()
    bwHarness.failEveryCreateWith = "Session key is invalid or expired"
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth-flow-bw-home-"))
    tempHomes.push(tempHome)
    process.env.HOME = tempHome
    writeAgentConfig(tempHome, "VaultLockedBot")

    const progress: string[] = []

    const promise = runRuntimeAuthFlow({
      agentName: "VaultLockedBot",
      provider: "minimax",
      promptInput: async () => "minimax-secret",
      onProgress: (message) => progress.push(message),
    })

    await expect(promise).rejects.toThrow(
      "provider authentication succeeded, but storing minimax credentials in VaultLockedBot's vault failed: bw CLI error: bw CLI could not use the local Bitwarden session because it is locked, missing, or expired",
    )
    await expect(promise).rejects.toThrow("Run 'ouro vault unlock --agent VaultLockedBot' or 'ouro vault replace --agent VaultLockedBot' if the secret is lost.")
    expect(progress).toEqual([
      "checking VaultLockedBot's vault access...",
      "opening VaultLockedBot's vault session...",
      "storing minimax credentials in VaultLockedBot's vault...",
    ])
    expect(bwHarness.createCalls).toBe(2)
  })

  it("wraps non-unlock vault save failures without pretending provider auth failed", async () => {
    installBwExecHarness()
    bwHarness.failEveryCreateWith = "server unavailable"
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth-flow-bw-home-"))
    tempHomes.push(tempHome)
    process.env.HOME = tempHome
    writeAgentConfig(tempHome, "VaultServerBot")

    const progress: string[] = []

    await expect(runRuntimeAuthFlow({
      agentName: "VaultServerBot",
      provider: "minimax",
      promptInput: async () => "minimax-secret",
      onProgress: (message) => progress.push(message),
    })).rejects.toThrow(
      "provider authentication succeeded, but storing minimax credentials in VaultServerBot's vault failed: bw CLI error: server unavailable",
    )

    expect(progress).toEqual([
      "checking VaultServerBot's vault access...",
      "opening VaultServerBot's vault session...",
      "storing minimax credentials in VaultServerBot's vault...",
    ])
  })

  it("redacts raw create-command failures from auth save errors and keeps progress visible", async () => {
    installBwExecHarness()
    bwHarness.failEveryCreateErrorMessage = "Command failed: bw create item eyJsb2dpbiI6eyJwYXNzd29yZCI6InNlY3JldC12YWx1ZSJ9fQ==\n? Master password: [input is hidden]"
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "auth-flow-bw-home-"))
    tempHomes.push(tempHome)
    process.env.HOME = tempHome
    writeAgentConfig(tempHome, "VaultPromptBot")

    const progress: string[] = []

    let thrown: Error | null = null
    try {
      await runRuntimeAuthFlow({
        agentName: "VaultPromptBot",
        provider: "minimax",
        promptInput: async () => "secret-value",
        onProgress: (message) => progress.push(message),
      })
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).not.toBeNull()
    expect(thrown!.message).toContain(
      "provider authentication succeeded, but storing minimax credentials in VaultPromptBot's vault failed: bw CLI error: bw CLI could not use the local Bitwarden session because it is locked, missing, or expired",
    )
    expect(thrown!.message).not.toContain("bw create item")
    expect(thrown!.message).not.toContain("eyJsb2dpbiI6eyJwYXNzd29yZCI6InNlY3JldC12YWx1ZSJ9fQ==")
    expect(thrown!.message).not.toContain("secret-value")
    expect(progress).toEqual([
      "checking VaultPromptBot's vault access...",
      "opening VaultPromptBot's vault session...",
      "storing minimax credentials in VaultPromptBot's vault...",
    ])
  })
})
