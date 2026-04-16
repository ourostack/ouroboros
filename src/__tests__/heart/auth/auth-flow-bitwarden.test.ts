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
    reset(): void {
      items.clear()
      this.commands = []
      this.validSession = ""
      this.sessionsIssued = 0
      this.listAllCalls = 0
      this.failListAllAtCall = 0
      this.failNextListAllWith = null
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

    const finishWrite = (stdin: string | undefined): void => {
      commandRecord.stdin = stdin
      if (session !== bwHarness.validSession) {
        cb(new Error(`Command failed: bw ${args.join(" ")}`), "", "Session key is invalid or expired")
        return
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
      "minimax credentials collected; storing in VaultSaveBot's vault...",
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

    const progress: string[] = []

    await expect(runRuntimeAuthFlow({
      agentName: "VaultRefreshBot",
      provider: "minimax",
      promptInput: async () => "minimax-secret",
      onProgress: (message) => progress.push(message),
    })).rejects.toThrow(
      "credential stored in vault, but the local provider snapshot could not be refreshed: bw CLI error: server unavailable. Run 'ouro provider refresh --agent VaultRefreshBot' after fixing vault access, then run 'ouro auth verify --agent VaultRefreshBot'.",
    )

    expect(progress).toEqual([
      "checking VaultRefreshBot's vault access...",
      "minimax credentials collected; storing in VaultRefreshBot's vault...",
    ])
    expect(bwHarness.items.has("providers/minimax")).toBe(true)
  })
})
