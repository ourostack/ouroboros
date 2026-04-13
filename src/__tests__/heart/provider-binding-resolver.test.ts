import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  normalizeProviderLane,
  resolveEffectiveProviderBinding,
} from "../../heart/provider-binding-resolver"
import {
  writeProviderCredentialPool,
  type ProviderCredentialPool,
} from "../../heart/provider-credential-pool"
import {
  writeProviderState,
  type ProviderState,
} from "../../heart/provider-state"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

describe("provider binding resolver", () => {
  let tempRoot: string
  let homeDir: string
  let agentRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-resolver-"))
    homeDir = path.join(tempRoot, "home")
    agentRoot = path.join(tempRoot, "bundles", "slugger.ouro")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.mkdirSync(homeDir, { recursive: true })
    mockEmitNervesEvent.mockClear()
  })

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  function providerState(overrides: Partial<ProviderState> = {}): ProviderState {
    return {
      schemaVersion: 1,
      machineId: "machine_random_abc123",
      updatedAt: "2026-04-12T18:30:00.000Z",
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: "2026-04-12T18:30:00.000Z",
        },
        inner: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "local",
          updatedAt: "2026-04-12T18:31:00.000Z",
        },
      },
      readiness: {
        inner: {
          status: "ready",
          provider: "minimax",
          model: "MiniMax-M2.5",
          checkedAt: "2026-04-12T18:32:00.000Z",
          credentialRevision: "cred_minimax_1",
          attempts: 2,
        },
      },
      ...overrides,
    }
  }

  function providerPool(overrides: Partial<ProviderCredentialPool> = {}): ProviderCredentialPool {
    return {
      schemaVersion: 1,
      updatedAt: "2026-04-12T18:32:00.000Z",
      providers: {
        minimax: {
          provider: "minimax",
          revision: "cred_minimax_1",
          updatedAt: "2026-04-12T18:32:00.000Z",
          credentials: { apiKey: "minimax-secret-key" },
          config: {},
          provenance: {
            source: "legacy-agent-secrets",
            contributedByAgent: "slugger",
            updatedAt: "2026-04-12T18:32:00.000Z",
          },
        },
      },
      ...overrides,
    }
  }

  function writeAgentConfigWithDifferentProviders(): void {
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
      name: "slugger",
      provider: "anthropic",
      humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
      agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
      configPath: path.join(homeDir, ".agentsecrets", "slugger", "secrets.json"),
    }, null, 2), "utf-8")
  }

  it("resolves the effective lane binding from local provider state with credential provenance and readiness", () => {
    emitTestEvent("provider resolver effective binding")
    writeAgentConfigWithDifferentProviders()
    writeProviderState(agentRoot, providerState())
    writeProviderCredentialPool(homeDir, providerPool())

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        lane: "inner",
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "local",
        machineId: "machine_random_abc123",
        statePath: path.join(agentRoot, "state", "providers.json"),
        credential: {
          status: "present",
          provider: "minimax",
          revision: "cred_minimax_1",
          source: "legacy-agent-secrets",
          contributedByAgent: "slugger",
          updatedAt: "2026-04-12T18:32:00.000Z",
          credentialFields: ["apiKey"],
          configFields: [],
        },
        readiness: {
          status: "ready",
          checkedAt: "2026-04-12T18:32:00.000Z",
          credentialRevision: "cred_minimax_1",
          attempts: 2,
        },
        warnings: [],
      },
    })
    expect(JSON.stringify(result)).not.toContain("minimax-secret-key")
    expect(JSON.stringify(result)).not.toContain("openai-codex")
    expect(JSON.stringify(result)).not.toContain("gpt-5.4")
  })

  it("maps legacy facing names to lane names with structured warnings", () => {
    emitTestEvent("provider resolver legacy lane names")
    writeProviderState(agentRoot, providerState())
    writeProviderCredentialPool(homeDir, providerPool())

    expect(normalizeProviderLane("outward")).toEqual({ lane: "outward", warnings: [] })
    expect(normalizeProviderLane("inner")).toEqual({ lane: "inner", warnings: [] })
    expect(normalizeProviderLane("human")).toEqual({
      lane: "outward",
      warnings: [{
        code: "legacy-lane-selector",
        message: "human is legacy provider wording; using outward lane",
      }],
    })
    expect(normalizeProviderLane("humanFacing")).toEqual({
      lane: "outward",
      warnings: [{
        code: "legacy-lane-selector",
        message: "humanFacing is legacy provider wording; using outward lane",
      }],
    })
    expect(normalizeProviderLane("agent")).toEqual({
      lane: "inner",
      warnings: [{
        code: "legacy-lane-selector",
        message: "agent is legacy provider wording; using inner lane",
      }],
    })

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "agentFacing",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        lane: "inner",
        provider: "minimax",
        warnings: [{
          code: "legacy-lane-selector",
          message: "agentFacing is legacy provider wording; using inner lane",
        }],
      },
    })
  })

  it("reports unknown readiness when credentials exist but no check has run", () => {
    emitTestEvent("provider resolver unknown readiness with credential")
    writeProviderState(agentRoot, providerState({
      readiness: {},
    }))
    writeProviderCredentialPool(homeDir, providerPool())

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        credential: {
          status: "present",
          revision: "cred_minimax_1",
        },
        readiness: {
          status: "unknown",
        },
        warnings: [],
      },
    })
  })

  it("does not fall back to agent.json provider fields when local provider state is missing", () => {
    emitTestEvent("provider resolver missing state no fallback")
    writeAgentConfigWithDifferentProviders()

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toEqual({
      ok: false,
      lane: "inner",
      reason: "provider-state-missing",
      statePath: path.join(agentRoot, "state", "providers.json"),
      warnings: [{
        code: "provider-state-missing",
        message: "No local provider binding exists for slugger on this machine.",
      }],
      repair: {
        command: "ouro use --agent slugger --lane inner --provider <provider> --model <model>",
        message: "Choose the provider/model this machine should use for slugger's inner lane.",
      },
    })
    expect(JSON.stringify(result)).not.toContain("openai-codex")
    expect(JSON.stringify(result)).not.toContain("gpt-5.4")
  })

  it("keeps the binding resolved but reports direct auth guidance when credentials are missing", () => {
    emitTestEvent("provider resolver missing credential without pool")
    writeProviderState(agentRoot, providerState({
      readiness: {},
    }))

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        lane: "inner",
        provider: "minimax",
        model: "MiniMax-M2.5",
        credential: {
          status: "missing",
          provider: "minimax",
          poolPath: path.join(homeDir, ".agentsecrets", "providers.json"),
          repair: {
            command: "ouro auth --agent slugger --provider minimax",
            message: "Authenticate minimax once for this machine's shared credential pool.",
          },
        },
        readiness: {
          status: "unknown",
          reason: "credential-missing",
        },
        warnings: [{
          code: "credential-missing",
          message: "minimax has no credential record in the machine credential pool.",
        }],
      },
    })
  })

  it("reports missing credentials when the pool exists without the selected provider", () => {
    emitTestEvent("provider resolver missing credential in pool")
    writeProviderState(agentRoot, providerState({
      readiness: {},
    }))
    writeProviderCredentialPool(homeDir, providerPool({
      providers: {
        anthropic: {
          provider: "anthropic",
          revision: "cred_anthropic_1",
          updatedAt: "2026-04-12T18:32:00.000Z",
          credentials: { setupToken: "sk-ant-oat01-secret-token" },
          config: {},
          provenance: {
            source: "auth-flow",
            contributedByAgent: "ouroboros",
            updatedAt: "2026-04-12T18:32:00.000Z",
          },
        },
      },
    }))

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        credential: {
          status: "missing",
          provider: "minimax",
        },
        warnings: [{
          code: "credential-missing",
          message: "minimax has no credential record in the machine credential pool.",
        }],
      },
    })
    expect(JSON.stringify(result)).not.toContain("sk-ant-oat01-secret-token")
  })

  it("marks existing readiness stale when credentials are missing", () => {
    emitTestEvent("provider resolver stale missing credential")
    writeProviderState(agentRoot, providerState())

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        credential: {
          status: "missing",
          provider: "minimax",
        },
        readiness: {
          status: "stale",
          previousStatus: "ready",
          reason: "credential-missing",
          credentialRevision: "cred_minimax_1",
        },
        warnings: [{
          code: "credential-missing",
          message: "minimax has no credential record in the machine credential pool.",
        }],
      },
    })
  })

  it("reports an invalid credential pool with unknown readiness when no check has run", () => {
    emitTestEvent("provider resolver invalid pool unknown readiness")
    writeProviderState(agentRoot, providerState({
      readiness: {},
    }))
    const poolPath = path.join(homeDir, ".agentsecrets", "providers.json")
    fs.mkdirSync(path.dirname(poolPath), { recursive: true })
    fs.writeFileSync(poolPath, "{ broken", "utf-8")

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        credential: {
          status: "invalid-pool",
          provider: "minimax",
          poolPath,
          repair: {
            command: "ouro auth --agent slugger --provider minimax",
          },
        },
        readiness: {
          status: "unknown",
          reason: "credential-pool-invalid",
        },
        warnings: [{
          code: "credential-pool-invalid",
          message: "minimax cannot read credentials because the machine credential pool is invalid.",
        }],
      },
    })
  })

  it("marks existing readiness stale when the credential pool is invalid", () => {
    emitTestEvent("provider resolver invalid pool stale readiness")
    writeProviderState(agentRoot, providerState())
    const poolPath = path.join(homeDir, ".agentsecrets", "providers.json")
    fs.mkdirSync(path.dirname(poolPath), { recursive: true })
    fs.writeFileSync(poolPath, "{ broken", "utf-8")

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        credential: {
          status: "invalid-pool",
          provider: "minimax",
        },
        readiness: {
          status: "stale",
          previousStatus: "ready",
          reason: "credential-pool-invalid",
          credentialRevision: "cred_minimax_1",
        },
        warnings: [{
          code: "credential-pool-invalid",
          message: "minimax cannot read credentials because the machine credential pool is invalid.",
        }],
      },
    })
  })

  it("marks readiness stale when the binding has a newer credential revision than the last check", () => {
    emitTestEvent("provider resolver credential revision stale")
    writeProviderState(agentRoot, providerState({
      readiness: {
        inner: {
          status: "ready",
          provider: "minimax",
          model: "MiniMax-M2.5",
          checkedAt: "2026-04-12T18:32:00.000Z",
          credentialRevision: "cred_minimax_old",
          attempts: 1,
        },
      },
    }))
    writeProviderCredentialPool(homeDir, providerPool({
      providers: {
        minimax: {
          provider: "minimax",
          revision: "cred_minimax_new",
          updatedAt: "2026-04-12T18:35:00.000Z",
          credentials: { apiKey: "minimax-new-secret" },
          config: {},
          provenance: {
            source: "auth-flow",
            contributedByAgent: "ouroboros",
            updatedAt: "2026-04-12T18:35:00.000Z",
          },
        },
      },
    }))

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        credential: {
          status: "present",
          revision: "cred_minimax_new",
          source: "auth-flow",
          contributedByAgent: "ouroboros",
        },
        readiness: {
          status: "stale",
          previousStatus: "ready",
          reason: "credential-revision-changed",
          checkedAt: "2026-04-12T18:32:00.000Z",
          credentialRevision: "cred_minimax_old",
        },
        warnings: [{
          code: "readiness-stale",
          message: "minimax/MiniMax-M2.5 readiness is stale because credential revision changed from cred_minimax_old to cred_minimax_new.",
        }],
      },
    })
    expect(JSON.stringify(result)).not.toContain("minimax-new-secret")
  })

  it("marks readiness stale when provider state changed after the last readiness check", () => {
    emitTestEvent("provider resolver provider model stale")
    writeProviderState(agentRoot, providerState({
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: "2026-04-12T18:30:00.000Z",
        },
        inner: {
          provider: "openai-codex",
          model: "gpt-5.4",
          source: "local",
          updatedAt: "2026-04-12T18:36:00.000Z",
        },
      },
      readiness: {
        inner: {
          status: "failed",
          provider: "minimax",
          model: "MiniMax-M2.5",
          checkedAt: "2026-04-12T18:33:00.000Z",
          credentialRevision: "cred_minimax_1",
          error: "400 status code",
          attempts: 3,
        },
      },
    }))
    writeProviderCredentialPool(homeDir, providerPool({
      providers: {
        "openai-codex": {
          provider: "openai-codex",
          revision: "cred_codex_1",
          updatedAt: "2026-04-12T18:35:00.000Z",
          credentials: { oauthAccessToken: "codex-secret" },
          config: {},
          provenance: {
            source: "auth-flow",
            contributedByAgent: "slugger",
            updatedAt: "2026-04-12T18:35:00.000Z",
          },
        },
      },
    }))

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "inner",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        provider: "openai-codex",
        model: "gpt-5.4",
        readiness: {
          status: "stale",
          previousStatus: "failed",
          reason: "provider-model-changed",
          checkedAt: "2026-04-12T18:33:00.000Z",
          error: "400 status code",
          attempts: 3,
        },
        warnings: [{
          code: "readiness-stale",
          message: "openai-codex/gpt-5.4 readiness is stale because the last check was for minimax/MiniMax-M2.5.",
        }],
      },
    })
    expect(JSON.stringify(result)).not.toContain("codex-secret")
  })

  it("fails with structured repair guidance when provider state is invalid", () => {
    emitTestEvent("provider resolver invalid state")
    const statePath = path.join(agentRoot, "state", "providers.json")
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "{ nope", "utf-8")

    const result = resolveEffectiveProviderBinding({
      agentName: "slugger",
      agentRoot,
      homeDir,
      lane: "outward",
    })

    expect(result).toMatchObject({
      ok: false,
      lane: "outward",
      reason: "provider-state-invalid",
      statePath,
      warnings: [{
        code: "provider-state-invalid",
        message: "Local provider binding state for slugger is invalid.",
      }],
      repair: {
        command: "ouro use --agent slugger --lane outward --provider <provider> --model <model> --force",
        message: "Rewrite this machine's outward provider binding for slugger.",
      },
    })
  })
})
