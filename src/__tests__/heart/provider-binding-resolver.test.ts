import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentProvider } from "../../heart/identity"
import type { ProviderCredentialPoolReadResult, ProviderCredentialRecord } from "../../heart/provider-credentials"

const mockProviderCredentials = vi.hoisted(() => ({
  readProviderCredentialPool: vi.fn(),
}))

vi.mock("../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../heart/provider-credentials")>("../../heart/provider-credentials")
  return {
    ...actual,
    readProviderCredentialPool: mockProviderCredentials.readProviderCredentialPool,
  }
})

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

import {
  normalizeProviderLane,
  resolveEffectiveProviderBinding,
} from "../../heart/provider-binding-resolver"
import {
  clearProviderReadinessCache,
  readProviderLaneReadiness,
  recordProviderLaneReadiness,
} from "../../heart/provider-readiness-cache"

const timestamp = "2026-04-13T12:00:00.000Z"
const agentName = "slugger"
const createdDirs: string[] = []

function tempBundlesRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-binding-"))
  createdDirs.push(dir)
  return dir
}

function agentRootFor(bundlesRoot: string): string {
  return path.join(bundlesRoot, `${agentName}.ouro`)
}

function writeAgentConfig(bundlesRoot: string, config: Record<string, unknown> = {}): string {
  const agentRoot = agentRootFor(bundlesRoot)
  fs.mkdirSync(agentRoot, { recursive: true })
  const agentJson = {
    version: 2,
    enabled: true,
    humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    agentFacing: { provider: "openai-codex", model: "gpt-5.5" },
    phrases: { thinking: ["thinking"], tool: ["tool"], followup: ["followup"] },
    ...config,
  }
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify(agentJson, null, 2)}\n`, "utf8")
  return agentRoot
}

function record(provider: AgentProvider, revision = `vault_${provider}`): ProviderCredentialRecord {
  return {
    provider,
    revision,
    updatedAt: timestamp,
    credentials: provider === "openai-codex" ? { oauthAccessToken: "codex-token" } : { apiKey: `${provider}-key` },
    config: {},
    provenance: { source: "manual", updatedAt: timestamp },
  }
}

function okPool(providers: Partial<Record<AgentProvider, ProviderCredentialRecord>>): ProviderCredentialPoolReadResult {
  return {
    ok: true,
    poolPath: "vault:slugger:providers/*",
    pool: {
      schemaVersion: 1,
      updatedAt: timestamp,
      providers,
    },
  }
}

function failedPool(reason: "invalid" | "unavailable" | "missing" = "invalid"): ProviderCredentialPoolReadResult {
  return {
    ok: false,
    reason,
    poolPath: "vault:slugger:providers/*",
    error: `${reason} pool`,
  }
}

function runChildVitest(testPath: string, env: Record<string, string>): Promise<void> {
  const repoRoot = process.cwd()
  const vitestBin = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs")
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      vitestBin,
      "run",
      testPath,
      "--config",
      path.join(repoRoot, "vitest.config.ts"),
      "--pool",
      "forks",
    ], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`child Vitest exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
    })
  })
}

describe("effective provider binding resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearProviderReadinessCache()
  })

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("normalizes current and legacy lane selectors", () => {
    expect(normalizeProviderLane("outward")).toEqual({ lane: "outward", warnings: [] })
    expect(normalizeProviderLane("inner")).toEqual({ lane: "inner", warnings: [] })
    expect(normalizeProviderLane("human")).toMatchObject({ lane: "outward", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("humanFacing")).toMatchObject({ lane: "outward", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("agent")).toMatchObject({ lane: "inner", warnings: [{ code: "legacy-lane-selector" }] })
    expect(normalizeProviderLane("agentFacing")).toMatchObject({ lane: "inner", warnings: [{ code: "legacy-lane-selector" }] })
  })

  it("resolves provider/model from agent.json and redacts credentials", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))

    const result = resolveEffectiveProviderBinding({
      agentName,
      agentRoot,
      lane: "human",
    })

    expect(result).toMatchObject({
      ok: true,
      binding: {
        lane: "outward",
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "agent.json",
        credential: {
          status: "present",
          revision: "vault_minimax",
          credentialFields: ["apiKey"],
          configFields: [],
        },
        readiness: { status: "unknown" },
        warnings: [{ code: "legacy-lane-selector" }],
      },
    })
    expect(JSON.stringify(result)).not.toContain("minimax-key")
  })

  it("surfaces missing and unreadable agent.json as invalid config", () => {
    const bundlesRoot = tempBundlesRoot()
    const missingRoot = agentRootFor(bundlesRoot)

    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: missingRoot,
      lane: "outward",
    })).toMatchObject({
      ok: false,
      lane: "outward",
      reason: "agent-config-invalid",
      warnings: [{ code: "agent-config-invalid" }],
      repair: {
        command: "ouro use --agent slugger --lane outward --provider <provider> --model <model>",
      },
    })

    const invalidRoot = writeAgentConfig(bundlesRoot, {
      humanFacing: { provider: "minimax", model: "" },
    })
    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: invalidRoot,
      lane: "outward",
    })).toMatchObject({
      ok: false,
      reason: "agent-config-invalid",
      error: "humanFacing.model must be a non-empty string",
    })

    writeAgentConfig(bundlesRoot, {
      humanFacing: { provider: "minimax", model: 42 },
    })
    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: invalidRoot,
      lane: "outward",
    })).toMatchObject({
      ok: false,
      reason: "agent-config-invalid",
      error: "humanFacing.model must be a non-empty string",
    })

    writeAgentConfig(bundlesRoot, {
      humanFacing: { provider: "fake-provider", model: "MiniMax-M2.5" },
    })
    expect(resolveEffectiveProviderBinding({
      agentName,
      agentRoot: invalidRoot,
      lane: "outward",
    })).toMatchObject({
      ok: false,
      reason: "agent-config-invalid",
      error: expect.stringContaining("unsupported provider 'fake-provider'"),
    })
  })

  it("surfaces clearly incompatible provider/model pairings as invalid config", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot, {
      humanFacing: { provider: "minimax", model: "gpt-5.5" },
    })

    const result = resolveEffectiveProviderBinding({
      agentName,
      agentRoot,
      lane: "outward",
    })

    expect(result).toMatchObject({
      ok: false,
      reason: "agent-config-invalid",
      error: expect.stringContaining("MiniMax is currently paired with gpt-5.5"),
      warnings: [{ code: "agent-config-invalid" }],
    })
  })

  it("marks readiness unknown when credentials are missing or unavailable", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(okPool({}))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "missing" },
        readiness: { status: "unknown", reason: "credential-missing" },
        warnings: [{ code: "credential-missing" }],
      },
    })

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(failedPool("unavailable"))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "invalid-pool", error: "unavailable pool" },
        readiness: { status: "unknown", reason: "credential-pool-invalid" },
        warnings: [{ code: "credential-pool-invalid" }],
      },
    })

    mockProviderCredentials.readProviderCredentialPool.mockReturnValueOnce(failedPool("missing"))
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        credential: { status: "missing" },
        readiness: { status: "unknown", reason: "credential-missing" },
      },
    })
  })

  it("uses matching in-memory live-check readiness", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))
    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "ready",
      checkedAt: timestamp,
      attempts: 1,
    })

    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "ready", checkedAt: timestamp, attempts: 1 },
      },
    })

    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "other-model",
      credentialRevision: "vault_minimax",
      status: "failed",
      checkedAt: timestamp,
      error: "wrong model",
    })
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "unknown" },
      },
    })

    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "failed",
      checkedAt: timestamp,
      error: "expired",
    })
    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "failed", checkedAt: timestamp, error: "expired" },
      },
    })
  })

  it("uses durable live-check readiness after the in-memory cache is gone", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))
    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "ready",
      checkedAt: timestamp,
      attempts: 1,
      agentRoot,
    })
    clearProviderReadinessCache()

    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "ready", checkedAt: timestamp, attempts: 1 },
      },
    })
  })

  it("prefers newer durable readiness over stale in-memory readiness", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))
    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "ready",
      checkedAt: timestamp,
      attempts: 1,
      agentRoot,
    })
    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "failed",
      checkedAt: "2026-04-13T11:59:00.000Z",
      error: "stale daemon failure",
      attempts: 2,
    })

    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "ready", checkedAt: timestamp, attempts: 1 },
      },
    })
    expect(readProviderLaneReadiness({
      agentRoot,
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
    })).toMatchObject({ status: "ready", checkedAt: timestamp })
  })

  it("keeps newer in-memory readiness over older durable readiness", () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)
    mockProviderCredentials.readProviderCredentialPool.mockReturnValue(okPool({
      minimax: record("minimax", "vault_minimax"),
    }))
    recordProviderLaneReadiness({
      agentRoot,
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "failed",
      checkedAt: "2026-04-13T11:59:00.000Z",
      error: "older durable failure",
      attempts: 2,
    })
    recordProviderLaneReadiness({
      agentName,
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "vault_minimax",
      status: "ready",
      checkedAt: timestamp,
      attempts: 1,
    })

    expect(resolveEffectiveProviderBinding({ agentName, agentRoot, lane: "outward" })).toMatchObject({
      ok: true,
      binding: {
        readiness: { status: "ready", checkedAt: timestamp, attempts: 1 },
      },
    })
  })

  it("reads durable provider readiness from a fresh process", async () => {
    const bundlesRoot = tempBundlesRoot()
    const agentRoot = writeAgentConfig(bundlesRoot)
    recordProviderLaneReadiness({
      agentName,
      lane: "inner",
      provider: "openai-codex",
      model: "gpt-5.5",
      credentialRevision: "vault_codex",
      status: "failed",
      checkedAt: timestamp,
      error: "expired",
      attempts: 3,
      agentRoot,
    })

    await runChildVitest(
      path.join(process.cwd(), "src", "__tests__", "heart", "provider-readiness-cache-child-process.test.ts"),
      {
        PROVIDER_READINESS_AGENT_ROOT: agentRoot,
        PROVIDER_READINESS_AGENT_NAME: agentName,
        PROVIDER_READINESS_LANE: "inner",
        PROVIDER_READINESS_PROVIDER: "openai-codex",
        PROVIDER_READINESS_MODEL: "gpt-5.5",
        PROVIDER_READINESS_CREDENTIAL_REVISION: "vault_codex",
        PROVIDER_READINESS_STATUS: "failed",
        PROVIDER_READINESS_ATTEMPTS: "3",
        PROVIDER_READINESS_ERROR: "expired",
      },
    )
  })

  it("keeps provider readiness exact-match", () => {
    const entry = {
      agentName,
      lane: "inner" as const,
      provider: "openai-codex" as const,
      model: "gpt-5.5",
      credentialRevision: "vault_codex",
      status: "failed" as const,
      checkedAt: timestamp,
      error: "expired",
    }

    expect(readProviderLaneReadiness(entry)).toBeNull()
    recordProviderLaneReadiness(entry)

    expect(readProviderLaneReadiness(entry)).toEqual(entry)
    expect(readProviderLaneReadiness({ ...entry, provider: "minimax" })).toBeNull()
    expect(readProviderLaneReadiness({ ...entry, model: "gpt-5.4" })).toBeNull()
    expect(readProviderLaneReadiness({ ...entry, credentialRevision: "vault_new" })).toBeNull()
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "config/identity",
      event: "config.provider_readiness_recorded",
    }))
  })
})
