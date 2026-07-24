import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockReadRuntimeCredentialConfig, mockReadMachineRuntimeCredentialConfig } = vi.hoisted(() => ({
  mockReadRuntimeCredentialConfig: vi.fn(),
  mockReadMachineRuntimeCredentialConfig: vi.fn(),
}))

vi.mock("../../../heart/runtime-credentials", () => ({
  readRuntimeCredentialConfig: (...args: unknown[]) => mockReadRuntimeCredentialConfig(...args),
  readMachineRuntimeCredentialConfig: (...args: unknown[]) => mockReadMachineRuntimeCredentialConfig(...args),
}))

import type { AgentConfig } from "../../../heart/identity"
import { AdapterDiagnosticsRegistry } from "../../../heart/habits/adapter-diagnostics"
import { composeMcpHabitAdapter } from "../../../heart/habits/mcp-habit-composition"
import type { HabitMcpToolExecutorV1 } from "../../../heart/habits/mcp-executors"
import type { HabitInvocationV1 } from "../../../heart/habits/habit-execution"
import { canonicalizeJson, sha256CanonicalJson } from "../../../heart/runtime/canonical-json"
import type { McpServerCompositionInventory } from "../../../repertoire/mcp-manager"

const habitInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["filter"],
  properties: { filter: { type: "string" } },
}
const toolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ouroOccurrence", "input", "credentials"],
  properties: {
    ouroOccurrence: { type: "object" },
    input: { type: "object" },
    credentials: { type: "object" },
  },
}
const resultSchema = {
  type: "object",
  required: ["version", "disposition"],
  properties: {
    version: { const: 1 },
    disposition: { enum: ["settled", "outcome_unknown"] },
  },
}
const reconcileInputSchema = {
  type: "object",
  required: ["ouroOccurrence", "priorEvidence", "credentials"],
  properties: {
    ouroOccurrence: { type: "object" },
    priorEvidence: { type: "array" },
    credentials: { type: "object" },
  },
}
const healthResultSchema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
}

function schemaHash(schema: unknown): string {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalizeJson(schema), "utf8")).digest("hex")}`
}

function executor(
  id = "inventory-refresh",
  serverId = "inventory-internal",
  credentialBindings: HabitMcpToolExecutorV1["credentialBindings"] = [],
): HabitMcpToolExecutorV1 {
  return {
    version: 1,
    id,
    serverId,
    toolName: "refresh_inventory",
    habitInputSchema: { root: "bundle", ref: "schemas/habit-input.json", sha256: schemaHash(habitInputSchema) },
    toolInputSchema: { root: "package", ref: "mcp/tool-input.json", sha256: schemaHash(toolInputSchema) },
    resultSchema: { root: "bundle", ref: "schemas/result.json", sha256: schemaHash(resultSchema) },
    timeoutMs: 30_000,
    idempotencyField: "ouroOccurrence",
    credentialBindings,
    reconciliation: null,
  }
}

function executorWithReconciliation(): HabitMcpToolExecutorV1 {
  return {
    ...executor(),
    reconciliation: {
      toolName: "reconcile_inventory",
      toolInputSchema: { root: "bundle", ref: "schemas/reconcile-input.json", sha256: schemaHash(reconcileInputSchema) },
      resultSchema: { root: "bundle", ref: "schemas/result.json", sha256: schemaHash(resultSchema) },
    },
  }
}

function inventory(serverId = "inventory-internal"): McpServerCompositionInventory {
  return {
    serverId,
    negotiatedProtocolVersion: "2025-06-18",
    transportIdentitySha256: `sha256:${"9".repeat(64)}`,
    tools: [{
      name: "refresh_inventory",
      description: "Refresh neutral inventory",
      inputSchema: toolInputSchema,
      outputSchema: resultSchema,
    }],
  }
}

function inventoryWithReconciliation(): McpServerCompositionInventory {
  return {
    ...inventory(),
    tools: [
      ...inventory().tools,
      {
        name: "reconcile_inventory",
        description: "Reconcile neutral inventory",
        inputSchema: reconcileInputSchema,
        outputSchema: resultSchema,
      },
    ],
  }
}

function configFor(
  executors: HabitMcpToolExecutorV1[],
  credentialNames: string[] = [],
  profileServerIds = [...new Set(executors.map((entry) => entry.serverId))],
): AgentConfig {
  const registryRevision = `sha256:${sha256CanonicalJson(executors)}`
  return {
    version: 2,
    enabled: true,
    humanFacing: { provider: "anthropic", model: "model" },
    agentFacing: { provider: "anthropic", model: "model" },
    mcpServers: Object.fromEntries([...new Set(executors.map((entry) => entry.serverId))].map((serverId) => [
      serverId,
      { command: "neutral-server", visibility: "internal" as const },
    ])),
    habitExecutors: executors,
    mcpHealthProfiles: profileServerIds.map((serverId, index) => ({
      schemaVersion: 1 as const,
      profileId: `inventory-health-${index + 1}`,
      serverId,
      registryRevision,
      expectedTools: [{
        name: "refresh_inventory",
        inputSchema: { root: "package" as const, ref: "mcp/tool-input.json", sha256: schemaHash(toolInputSchema) },
        outputSchema: { root: "bundle" as const, ref: "schemas/result.json", sha256: schemaHash(resultSchema) },
      }],
      credentialBindingNames: credentialNames,
      mode: "inventory-schema-credential-readiness" as const,
      readOnlyProbe: null,
      timeoutMs: 5_000,
      freshnessMs: 60_000,
    })),
  }
}

function invocation(config: { executorId: string; input: Record<string, unknown> }): HabitInvocationV1<typeof config> {
  return {
    schemaVersion: 1,
    agent: "agent-a",
    bundleRoot: "/bundles/agent-a.ouro",
    habit: {
      id: "daily-inventory-check",
      title: "Daily inventory check",
      body: "Refresh inventory.",
      tools: [],
      continuity: { mode: "fresh" },
    },
    config,
    occurrenceId: "occurrence-a",
    attemptId: "attempt-a",
    trigger: { kind: "manual", observedAt: "2026-07-24T12:00:00.000Z", scheduleProofRef: null },
    owner: {
      pid: 100,
      uid: 501,
      startIdentity: "darwin-proc:1:1",
      bootId: "boot-a",
      daemonInstanceId: "daemon-a",
    },
    deadlineAt: "2026-07-24T12:01:00.000Z",
    signal: new AbortController().signal,
  }
}

function harness(config: AgentConfig, now = () => new Date("2026-07-24T12:00:00.000Z")) {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-habit-composition-"))
  const files: Record<string, string> = {
    [path.join(bundleRoot, "schemas/habit-input.json")]: JSON.stringify(habitInputSchema),
    [path.join(bundleRoot, "schemas/result.json")]: JSON.stringify(resultSchema),
    [path.join("/package/schemas", "mcp/tool-input.json")]: JSON.stringify(toolInputSchema),
    [path.join(bundleRoot, "schemas/reconcile-input.json")]: JSON.stringify(reconcileInputSchema),
    [path.join(bundleRoot, "schemas/health-result.json")]: JSON.stringify(healthResultSchema),
  }
  const inventories = new Map(Object.keys(config.mcpServers ?? {}).map((serverId) => [serverId, inventory(serverId)]))
  const manager = {
    refreshServerInventoryForComposition: vi.fn(async (serverId: string) => structuredClone(inventories.get(serverId)!)),
    registerInternalExecutorAuthority: vi.fn(),
    replaceInternalExecutorAuthorities: vi.fn(),
    callInternalTool: vi.fn(async () => ({
      content: [{ type: "text", text: "non-authoritative text" }],
      structuredContent: {
        version: 1,
        disposition: "settled",
        result: { version: 1, status: "completed", resultRef: "result:inventory-a" },
      },
      isError: false,
    })),
    callReadOnlyHealthTool: vi.fn(),
  }
  const diagnostics = new AdapterDiagnosticsRegistry()
  return {
    bundleRoot,
    files,
    inventories,
    manager,
    diagnostics,
    compose: () => composeMcpHabitAdapter({
      agent: "agent-a",
      bundleRoot,
      packageSchemaRoot: "/package/schemas",
      config,
      manager: manager as never,
      diagnostics,
      readFile: (filePath) => {
        const value = files[filePath]
        if (value === undefined) throw new Error(`ENOENT: ${filePath}`)
        return value
      },
      now,
    }),
  }
}

describe("MCP habit adapter composition", () => {
  beforeEach(() => {
    mockReadRuntimeCredentialConfig.mockReset().mockReturnValue({
      ok: false,
      reason: "missing",
      itemPath: "vault:agent-a:runtime/config",
      error: "missing",
    })
    mockReadMachineRuntimeCredentialConfig.mockReset().mockReturnValue({
      ok: false,
      reason: "missing",
      itemPath: "vault:agent-a:runtime/machines/test/config",
      error: "missing",
    })
  })

  it("does not compose or touch MCP when no executors are configured", async () => {
    const setup = harness(configFor([]))

    await expect(setup.compose()).resolves.toBeNull()
    expect(setup.manager.refreshServerInventoryForComposition).not.toHaveBeenCalled()
    expect(setup.manager.replaceInternalExecutorAuthorities).not.toHaveBeenCalled()
  })

  it("composes, health-gates, caches freshness, and invokes fixed internal coordinates", async () => {
    const setup = harness(configFor([executor()]))
    const composition = await setup.compose()
    expect(composition).not.toBeNull()

    await expect(composition!.ensureHealthy()).resolves.toBe(true)
    await expect(composition!.ensureHealthy()).resolves.toBe(true)
    expect(setup.manager.refreshServerInventoryForComposition).toHaveBeenCalledTimes(2)

    const validated = composition!.adapter.validateConfig({ executorId: "inventory-refresh", input: { filter: "ready" } })
    await expect(composition!.adapter.invoke(invocation(validated))).resolves.toMatchObject({
      disposition: "settled",
      result: { status: "completed", resultRef: "result:inventory-a" },
    })
    expect(setup.manager.refreshServerInventoryForComposition).toHaveBeenCalledTimes(3)
    expect(setup.manager.callInternalTool).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "inventory-internal",
      toolName: "refresh_inventory",
      timeoutMs: 30_000,
      arguments: expect.objectContaining({
        input: { filter: "ready" },
        credentials: {},
      }),
    }))
    expect(fs.readdirSync(path.join(setup.bundleRoot, "state", "habits", "mcp-health", "evidence")).length).toBeGreaterThan(0)
  })

  it("injects configured cached credentials only into the internal call and never persisted evidence", async () => {
    const credential = {
      name: "service-token",
      source: { scope: "agent-runtime-config" as const, jsonPointer: "/inventory/token" },
    }
    mockReadRuntimeCredentialConfig.mockReturnValue({
      ok: true,
      itemPath: "vault:agent-a:runtime/config",
      revision: "runtime-a",
      updatedAt: "2026-07-24T11:00:00.000Z",
      config: { inventory: { token: "secret-value" } },
    })
    const setup = harness(configFor([executor("inventory-refresh", "inventory-internal", [credential])], ["service-token"]))
    const composition = await setup.compose()

    await expect(composition!.ensureHealthy()).resolves.toBe(true)
    const validated = composition!.adapter.validateConfig({ executorId: "inventory-refresh", input: { filter: "ready" } })
    await composition!.adapter.invoke(invocation(validated))

    expect(setup.manager.callInternalTool).toHaveBeenCalledWith(expect.objectContaining({
      arguments: expect.objectContaining({ credentials: { "service-token": "secret-value" } }),
    }))
    const persisted = fs.readdirSync(setup.bundleRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith(".json"))
      .map((entry) => fs.readFileSync(path.join(setup.bundleRoot, String(entry)), "utf8"))
      .join("\n")
    expect(persisted).not.toContain("secret-value")
  })

  it("rejects incomplete health coverage before registering internal capabilities", async () => {
    const first = executor()
    const second = executor("secondary-refresh", "secondary-internal")
    const setup = harness(configFor([first, second], [], ["inventory-internal"]))

    await expect(setup.compose()).rejects.toThrow(/health profile.*secondary-internal|secondary-internal.*health profile/i)
    expect(setup.manager.replaceInternalExecutorAuthorities).not.toHaveBeenCalled()
  })

  it("rejects health profiles that omit an executor credential before capability registration", async () => {
    const credential = {
      name: "service-token",
      source: { scope: "agent-runtime-config" as const, jsonPointer: "/inventory/token" },
    }
    const setup = harness(configFor([executor("inventory-refresh", "inventory-internal", [credential])], []))

    await expect(setup.compose()).rejects.toThrow(/health profile.*service-token|service-token.*health profile/i)
    expect(setup.manager.replaceInternalExecutorAuthorities).not.toHaveBeenCalled()
  })

  it("publishes a blocked generic diagnostic when fresh health evidence is mismatched", async () => {
    const setup = harness(configFor([executor()]))
    setup.manager.refreshServerInventoryForComposition
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce({ ...inventory(), tools: [] })
    const diagnostics = new AdapterDiagnosticsRegistry()
    const composition = await composeMcpHabitAdapter({
      agent: "agent-a",
      bundleRoot: setup.bundleRoot,
      packageSchemaRoot: "/package/schemas",
      config: configFor([executor()]),
      manager: setup.manager as never,
      diagnostics,
      readFile: (filePath) => setup.files[filePath],
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    })

    await expect(composition!.ensureHealthy()).resolves.toBe(false)
    expect(diagnostics.get("mcp-tool", 1)).toMatchObject({
      status: "blocked",
      blockers: [{ code: "mcp_health_unhealthy", actor: "agent-runnable" }],
    })
    expect(setup.manager.callInternalTool).not.toHaveBeenCalled()
  })

  it("fails closed when existing content-addressed health evidence was tampered", async () => {
    const config = configFor([executor()])
    const setup = harness(config)
    const first = await setup.compose()
    await expect(first!.ensureHealthy()).resolves.toBe(true)
    const evidenceDir = path.join(setup.bundleRoot, "state", "habits", "mcp-health", "evidence")
    const inventoryEvidence = fs.readdirSync(evidenceDir).find((name) => name.startsWith("inventory-"))!
    fs.writeFileSync(path.join(evidenceDir, inventoryEvidence), "{\"tampered\":true}\n", "utf8")

    const second = await setup.compose()
    await expect(second!.ensureHealthy()).resolves.toBe(false)
  })

  it("reuses byte-valid content-addressed evidence and rejects unreadable or non-file evidence", async () => {
    const valid = harness(configFor([executor()]))
    await (await valid.compose())!.ensureHealthy()
    await expect((await valid.compose())!.ensureHealthy()).resolves.toBe(true)

    const unreadable = harness(configFor([executor()]))
    await (await unreadable.compose())!.ensureHealthy()
    const unreadableDir = path.join(unreadable.bundleRoot, "state", "habits", "mcp-health", "evidence")
    const unreadableFile = fs.readdirSync(unreadableDir).find((name) => name.startsWith("inventory-"))!
    fs.writeFileSync(path.join(unreadableDir, unreadableFile), "not-json\n", "utf8")
    await expect((await unreadable.compose())!.ensureHealthy()).resolves.toBe(false)

    const nonFile = harness(configFor([executor()]))
    await (await nonFile.compose())!.ensureHealthy()
    const nonFileDir = path.join(nonFile.bundleRoot, "state", "habits", "mcp-health", "evidence")
    const nonFileName = fs.readdirSync(nonFileDir).find((name) => name.startsWith("inventory-"))!
    fs.unlinkSync(path.join(nonFileDir, nonFileName))
    fs.mkdirSync(path.join(nonFileDir, nonFileName))
    await expect((await nonFile.compose())!.ensureHealthy()).resolves.toBe(false)
  })

  it("covers agent and machine credential cache states without persisting values", async () => {
    const agentCredential = {
      name: "service-token",
      source: { scope: "agent-runtime-config" as const, jsonPointer: "/inventory/token" },
    }
    const missing = harness(configFor([executor("inventory-refresh", "inventory-internal", [agentCredential])], ["service-token"]))
    await expect((await missing.compose())!.ensureHealthy()).resolves.toBe(false)

    mockReadRuntimeCredentialConfig.mockReturnValue({
      ok: false,
      reason: "locked",
      itemPath: "vault:agent-a:runtime/config",
      error: "locked",
    })
    const locked = harness(configFor([executor("inventory-refresh", "inventory-internal", [agentCredential])], ["service-token"]))
    await expect((await locked.compose())!.ensureHealthy()).resolves.toBe(false)

    mockReadRuntimeCredentialConfig.mockReturnValue({
      ok: true,
      itemPath: "vault:agent-a:runtime/config",
      revision: "runtime-a",
      updatedAt: "2026-07-24T11:00:00.000Z",
      config: { inventory: {} },
    })
    const absent = harness(configFor([executor("inventory-refresh", "inventory-internal", [agentCredential])], ["service-token"]))
    await expect((await absent.compose())!.ensureHealthy()).resolves.toBe(false)

    mockReadRuntimeCredentialConfig.mockReturnValue({
      ok: true,
      itemPath: "vault:agent-a:runtime/config",
      revision: "runtime-a",
      updatedAt: "2026-07-24T11:00:00.000Z",
      config: { inventory: { token: null } },
    })
    const nullValue = harness(configFor([executor("inventory-refresh", "inventory-internal", [agentCredential])], ["service-token"]))
    await expect((await nullValue.compose())!.ensureHealthy()).resolves.toBe(false)

    const machineCredential = {
      name: "machine-token",
      source: { scope: "machine-runtime-config" as const, jsonPointer: "/service~1name/~0token" },
    }
    mockReadMachineRuntimeCredentialConfig.mockReturnValue({
      ok: true,
      itemPath: "vault:agent-a:runtime/machines/test/config",
      revision: "machine-a",
      updatedAt: "2026-07-24T11:00:00.000Z",
      config: { "service/name": { "~token": "machine-secret" } },
    })
    const machine = harness(configFor([executor("inventory-refresh", "inventory-internal", [machineCredential])], ["machine-token"]))
    const composition = await machine.compose()
    await expect(composition!.ensureHealthy()).resolves.toBe(true)
    const validated = composition!.adapter.validateConfig({ executorId: "inventory-refresh", input: { filter: "ready" } })
    await composition!.adapter.invoke(invocation(validated))
    expect(machine.manager.callInternalTool).toHaveBeenCalledWith(expect.objectContaining({
      arguments: expect.objectContaining({ credentials: { "machine-token": "machine-secret" } }),
    }))
  })

  it("rejects missing health declarations, unknown credential names, and ambiguous bindings before authority registration", async () => {
    const noProfilesConfig = configFor([executor()])
    delete noProfilesConfig.mcpHealthProfiles
    const noProfiles = harness(noProfilesConfig)
    await expect(noProfiles.compose()).rejects.toThrow(/health profile/i)
    expect(noProfiles.manager.replaceInternalExecutorAuthorities).not.toHaveBeenCalled()

    const unknownCredential = harness(configFor([executor()], ["ghost-token"]))
    await expect(unknownCredential.compose()).rejects.toThrow(/unknown credential binding.*ghost-token/i)
    expect(unknownCredential.manager.replaceInternalExecutorAuthorities).not.toHaveBeenCalled()

    const first = executor("inventory-refresh", "inventory-internal", [{
      name: "service-token",
      source: { scope: "agent-runtime-config", jsonPointer: "/inventory/token" },
    }])
    const second = executor("secondary-refresh", "inventory-internal", [{
      name: "service-token",
      source: { scope: "machine-runtime-config", jsonPointer: "/inventory/token" },
    }])
    const ambiguous = harness(configFor([first, second], ["service-token"]))
    await expect(ambiguous.compose()).rejects.toThrow(/ambiguous.*service-token/i)
    expect(ambiguous.manager.replaceInternalExecutorAuthorities).not.toHaveBeenCalled()
  })

  it("uses default empty config collections only to fail closed", async () => {
    const noExecutors = configFor([])
    delete noExecutors.habitExecutors
    await expect(harness(noExecutors).compose()).resolves.toBeNull()

    const noServers = configFor([executor()])
    delete noServers.mcpServers
    const noServersSetup = harness(noServers)
    noServersSetup.inventories.set("inventory-internal", inventory())
    await expect(noServersSetup.compose()).rejects.toThrow(/server/i)
  })

  it.each([
    ["missing invocation", { ...inventory(), tools: [] }],
    ["invocation input mismatch", { ...inventory(), tools: [{ ...inventory().tools[0], inputSchema: { type: "string" } }] }],
    ["invocation output absent", { ...inventory(), tools: [{ ...inventory().tools[0], outputSchema: undefined }] }],
    ["invocation output mismatch", { ...inventory(), tools: [{ ...inventory().tools[0], outputSchema: { type: "string" } }] }],
  ])("fails invocation preflight on %s", async (_label, mismatch) => {
    const setup = harness(configFor([executor()]))
    const composition = await setup.compose()
    setup.manager.refreshServerInventoryForComposition.mockResolvedValueOnce(mismatch)
    const validated = composition!.adapter.validateConfig({ executorId: "inventory-refresh", input: { filter: "ready" } })
    await expect(composition!.adapter.invoke(invocation(validated))).rejects.toThrow(/fresh.*inventory/i)
    expect(setup.manager.callInternalTool).not.toHaveBeenCalled()
  })

  it("registers and uses fixed reconciliation coordinates", async () => {
    const definition = executorWithReconciliation()
    const setup = harness(configFor([definition]))
    setup.inventories.set("inventory-internal", inventoryWithReconciliation())
    setup.manager.callInternalTool.mockResolvedValueOnce({
      content: [],
      structuredContent: { version: 1, disposition: "unresolved" },
      isError: false,
    })
    const composition = await setup.compose()

    await expect(composition!.adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot: setup.bundleRoot,
      habitId: "daily-inventory-check",
      config: { executorId: "inventory-refresh", input: { filter: "ready" } },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    })).resolves.toEqual({ version: 1, disposition: "unresolved" })
    expect(setup.manager.replaceInternalExecutorAuthorities).toHaveBeenCalledWith(
      "habit-executors:agent-a",
      expect.arrayContaining([
        expect.objectContaining({ toolName: "refresh_inventory" }),
        expect.objectContaining({ toolName: "reconcile_inventory" }),
      ]),
    )
    expect(setup.manager.callInternalTool).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "inventory-internal",
      toolName: "reconcile_inventory",
    }))
  })

  it.each([
    ["missing reconciliation", { ...inventoryWithReconciliation(), tools: [inventory().tools[0]] }],
    ["reconciliation input mismatch", {
      ...inventoryWithReconciliation(),
      tools: [inventory().tools[0], { ...inventoryWithReconciliation().tools[1], inputSchema: { type: "string" } }],
    }],
    ["reconciliation output absent", {
      ...inventoryWithReconciliation(),
      tools: [inventory().tools[0], { ...inventoryWithReconciliation().tools[1], outputSchema: undefined }],
    }],
    ["reconciliation output mismatch", {
      ...inventoryWithReconciliation(),
      tools: [inventory().tools[0], { ...inventoryWithReconciliation().tools[1], outputSchema: { type: "string" } }],
    }],
  ])("fails reconciliation preflight on %s", async (_label, mismatch) => {
    const definition = executorWithReconciliation()
    const setup = harness(configFor([definition]))
    setup.inventories.set("inventory-internal", inventoryWithReconciliation())
    const composition = await setup.compose()
    setup.manager.refreshServerInventoryForComposition.mockResolvedValueOnce(mismatch)

    await expect(composition!.adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot: setup.bundleRoot,
      habitId: "daily-inventory-check",
      config: { executorId: "inventory-refresh", input: { filter: "ready" } },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    })).rejects.toThrow(/fresh.*reconciliation/i)
    expect(setup.manager.callInternalTool).not.toHaveBeenCalled()
  })

  it("runs a fixed read-only health probe and validates its structured result", async () => {
    const config = configFor([executor()])
    config.mcpHealthProfiles![0] = {
      ...config.mcpHealthProfiles![0],
      expectedTools: [
        ...config.mcpHealthProfiles![0].expectedTools,
        {
          name: "health_status",
          inputSchema: { root: "bundle", ref: "schemas/habit-input.json", sha256: schemaHash(habitInputSchema) },
          outputSchema: { root: "bundle", ref: "schemas/health-result.json", sha256: schemaHash(healthResultSchema) },
        },
      ],
      mode: "read-only-tool",
      readOnlyProbe: {
        toolName: "health_status",
        input: { filter: "ready" },
        resultSchema: { root: "bundle", ref: "schemas/health-result.json", sha256: schemaHash(healthResultSchema) },
        sideEffects: "none",
      },
    }
    const setup = harness(config)
    setup.inventories.set("inventory-internal", {
      ...inventory(),
      tools: [
        ...inventory().tools,
        { name: "health_status", inputSchema: habitInputSchema, outputSchema: healthResultSchema },
      ],
    })
    setup.manager.callReadOnlyHealthTool.mockResolvedValue({
      content: [{ type: "text", text: "not authority" }],
      structuredContent: { ok: true },
      isError: false,
    })
    const composition = await setup.compose()

    await expect(composition!.ensureHealthy()).resolves.toBe(true)
    expect(setup.manager.callReadOnlyHealthTool).toHaveBeenCalledWith({
      serverId: "inventory-internal",
      toolName: "health_status",
      arguments: { filter: "ready" },
      timeoutMs: 5_000,
    })
  })

  it("normalizes non-Error health failures into blocked diagnostics", async () => {
    const setup = harness(configFor([executor()]))
    const composition = await setup.compose()
    setup.manager.refreshServerInventoryForComposition.mockRejectedValueOnce("transport unavailable")

    await expect(composition!.ensureHealthy()).resolves.toBe(false)
    expect(setup.diagnostics.get("mcp-tool", 1)).toMatchObject({
      status: "blocked",
      blockers: [{ message: "transport unavailable" }],
    })
  })

  it("cleans an uncommitted evidence temporary when the atomic rename fails", async () => {
    const setup = harness(configFor([executor()]))
    const composition = await composeMcpHabitAdapter({
      agent: "agent-a",
      bundleRoot: setup.bundleRoot,
      packageSchemaRoot: "/package/schemas",
      config: configFor([executor()]),
      manager: setup.manager as never,
      diagnostics: setup.diagnostics,
      readFile: (filePath) => setup.files[filePath],
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      evidenceFileSystem: {
        mkdirSync: fs.mkdirSync,
        existsSync: fs.existsSync,
        lstatSync: fs.lstatSync,
        readFileSync: fs.readFileSync,
        openSync: fs.openSync,
        writeFileSync: fs.writeFileSync,
        fsyncSync: fs.fsyncSync,
        closeSync: fs.closeSync,
        renameSync: () => { throw new Error("rename unavailable") },
        unlinkSync: fs.unlinkSync,
      },
    })

    await expect(composition!.ensureHealthy()).resolves.toBe(false)
    const evidenceDir = path.join(setup.bundleRoot, "state", "habits", "mcp-health", "evidence")
    expect(fs.readdirSync(evidenceDir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("uses filesystem schema reads and the system clock when injections are omitted", async () => {
    const config = configFor([executor()])
    const setup = harness(config)
    const packageSchemaRoot = path.join(setup.bundleRoot, "package-schemas")
    fs.mkdirSync(path.join(setup.bundleRoot, "schemas"), { recursive: true })
    fs.mkdirSync(path.join(packageSchemaRoot, "mcp"), { recursive: true })
    fs.writeFileSync(path.join(setup.bundleRoot, "schemas", "habit-input.json"), JSON.stringify(habitInputSchema), "utf8")
    fs.writeFileSync(path.join(setup.bundleRoot, "schemas", "result.json"), JSON.stringify(resultSchema), "utf8")
    fs.writeFileSync(path.join(packageSchemaRoot, "mcp", "tool-input.json"), JSON.stringify(toolInputSchema), "utf8")

    const composition = await composeMcpHabitAdapter({
      agent: "agent-a",
      bundleRoot: setup.bundleRoot,
      packageSchemaRoot,
      config,
      manager: setup.manager as never,
      diagnostics: setup.diagnostics,
    })

    await expect(composition!.ensureHealthy()).resolves.toBe(true)
  })
})
