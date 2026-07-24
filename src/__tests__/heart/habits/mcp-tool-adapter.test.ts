import { createHash } from "crypto"
import * as path from "path"

import { describe, expect, it, vi } from "vitest"

import type { McpServerConfig } from "../../../heart/identity"
import type { HabitInvocationV1 } from "../../../heart/habits/habit-execution"
import { canonicalizeJson } from "../../../heart/runtime/canonical-json"
import {
  resolveSchemaBinding,
  resolveHabitMcpToolExecutors,
  validateJsonSchemaValue,
  type HabitMcpToolExecutorV1,
  type ResolvedHabitMcpToolExecutorRegistry,
} from "../../../heart/habits/mcp-executors"
import { createMcpToolHabitAdapter } from "../../../heart/habits/mcp-tool-adapter"
import { createMcpInternalExecutorAuthority } from "../../../repertoire/mcp-manager"
import type { McpToolInfo } from "../../../repertoire/mcp-client"

const bundleRoot = "/bundles/agent-a.ouro"
const packageSchemaRoot = "/package/schemas"

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
    disposition: { enum: ["settled", "outcome_unknown", "completed", "safe_retry", "failed_terminal", "unresolved"] },
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

function schemaHash(schema: unknown): string {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalizeJson(schema), "utf8")).digest("hex")}`
}

function binding(root: "bundle" | "package", ref: string, schema: unknown) {
  return { root, ref, sha256: schemaHash(schema) }
}

function executor(overrides: Partial<HabitMcpToolExecutorV1> = {}): HabitMcpToolExecutorV1 {
  return {
    version: 1,
    id: "inventory-refresh",
    serverId: "inventory-internal",
    toolName: "refresh_inventory",
    habitInputSchema: binding("bundle", "schemas/habit-input.json", habitInputSchema),
    toolInputSchema: binding("package", "mcp/tool-input.json", toolInputSchema),
    resultSchema: binding("bundle", "schemas/result.json", resultSchema),
    timeoutMs: 30_000,
    idempotencyField: "ouroOccurrence",
    credentialBindings: [{
      name: "service-token",
      source: { scope: "agent-runtime-config", jsonPointer: "/inventory/token" },
    }],
    reconciliation: {
      toolName: "reconcile_inventory",
      toolInputSchema: binding("bundle", "schemas/reconcile-input.json", reconcileInputSchema),
      resultSchema: binding("bundle", "schemas/result.json", resultSchema),
    },
    ...overrides,
  }
}

const inventory: McpToolInfo[] = [
  {
    name: "refresh_inventory",
    description: "Refresh neutral inventory",
    inputSchema: toolInputSchema,
    outputSchema: resultSchema,
  },
  {
    name: "reconcile_inventory",
    description: "Reconcile a neutral inventory refresh",
    inputSchema: reconcileInputSchema,
    outputSchema: resultSchema,
  },
]

function files(extra: Record<string, unknown> = {}): Record<string, string> {
  const values: Record<string, unknown> = {
    [path.join(bundleRoot, "schemas/habit-input.json")]: habitInputSchema,
    [path.join(packageSchemaRoot, "mcp/tool-input.json")]: toolInputSchema,
    [path.join(bundleRoot, "schemas/result.json")]: resultSchema,
    [path.join(bundleRoot, "schemas/reconcile-input.json")]: reconcileInputSchema,
    ...extra,
  }
  return Object.fromEntries(Object.entries(values).map(([file, value]) => [file, JSON.stringify(value)]))
}

function resolve(
  entries: unknown = [executor()],
  options: {
    servers?: Record<string, McpServerConfig>
    inventory?: Record<string, McpToolInfo[]>
    files?: Record<string, string>
  } = {},
): ResolvedHabitMcpToolExecutorRegistry {
  const source = options.files ?? files()
  return resolveHabitMcpToolExecutors(entries, {
    bundleRoot,
    packageSchemaRoot,
    mcpServers: options.servers ?? {
      "inventory-internal": { command: "neutral-server", visibility: "internal" },
    },
    inventoryByServer: options.inventory ?? { "inventory-internal": inventory },
    readFile: (filePath) => {
      const value = source[filePath]
      if (value === undefined) throw new Error(`ENOENT: ${filePath}`)
      return value
    },
  })
}

function invocation(config: { executorId: string; input: Record<string, unknown> }): HabitInvocationV1<typeof config> {
  return {
    schemaVersion: 1,
    agent: "agent-a",
    bundleRoot,
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

function resolvedAuthority(registry: ResolvedHabitMcpToolExecutorRegistry, toolName = "refresh_inventory") {
  return createMcpInternalExecutorAuthority({
    executorId: "inventory-refresh",
    serverId: "inventory-internal",
    toolName,
    registryRevision: registry.revision,
    randomBytes: () => Buffer.alloc(32, 1),
  })
}

function adapterForResult(result: unknown, registry = resolve()) {
  return createMcpToolHabitAdapter({
    registry,
    authorityFor: () => resolvedAuthority(registry),
    callInternalTool: vi.fn(async () => result as never),
    readCredential: () => ({ state: "ready", value: "secret" }),
  })
}

function resolveWithPermissiveResultSchema(): ResolvedHabitMcpToolExecutorRegistry {
  const permissive = { type: "object" }
  return resolve([executor({
    resultSchema: binding("bundle", "schemas/permissive-result.json", permissive),
    reconciliation: {
      ...executor().reconciliation!,
      resultSchema: binding("bundle", "schemas/permissive-result.json", permissive),
    },
  })], {
    files: files({ [path.join(bundleRoot, "schemas/permissive-result.json")]: permissive }),
    inventory: {
      "inventory-internal": [
        { ...inventory[0], outputSchema: permissive },
        { ...inventory[1], outputSchema: permissive },
      ],
    },
  })
}

describe("habit MCP executor registry", () => {
  it("resolves exact bundle/package schemas and listed tool schemas", () => {
    const registry = resolve()
    const resolved = registry.get("inventory-refresh")

    expect(resolved.definition).toEqual(executor())
    expect(resolved.habitInputSchema.value).toEqual(habitInputSchema)
    expect(resolved.toolInputSchema.value).toEqual(toolInputSchema)
    expect(resolved.resultSchema.value).toEqual(resultSchema)
    expect(registry.revision).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(registry.keys()).toEqual(["inventory-refresh"])
  })

  it("rejects duplicate IDs, invalid IDs, unknown fields, and entry-key ambiguity", () => {
    expect(() => resolve([executor(), executor()])).toThrow(/duplicate.*inventory-refresh/i)
    expect(() => resolve([executor({ id: "Bad_ID" })])).toThrow(/identifier|id/i)
    expect(() => resolve([{ ...executor(), command: "/bin/echo" }])).toThrow(/unknown.*command/i)
    expect(() => resolve({ "inventory-refresh": executor() })).toThrow(/array|entries/i)
  })

  it("rejects malformed entry records and every fixed executor coordinate", () => {
    expect(() => resolve([null])).toThrow(/object/i)
    expect(() => resolve([[]])).toThrow(/object/i)
    expect(() => resolve([executor({ version: 2 as 1 })])).toThrow(/version/i)
    expect(() => resolve([executor({ toolName: "" })])).toThrow(/toolName/i)
    expect(() => resolve([executor({ timeoutMs: 1.5 })])).toThrow(/timeout/i)
    expect(() => resolve([executor({
      credentialBindings: null as unknown as HabitMcpToolExecutorV1["credentialBindings"],
    })])).toThrow(/array/i)
  })

  it("rejects habit-controlled execution coordinates and malformed bounds", () => {
    for (const invalid of [
      executor({ timeoutMs: 999 }),
      executor({ timeoutMs: 900_001 }),
      executor({ idempotencyField: "custom" as "ouroOccurrence" }),
      executor({ credentialBindings: [{ name: "Bad Name", source: { scope: "agent-runtime-config", jsonPointer: "/x" } }] }),
      executor({ credentialBindings: [{ name: "token", source: { scope: "agent-runtime-config", jsonPointer: "not-absolute" } }] }),
    ]) {
      expect(() => resolve([invalid])).toThrow()
    }
  })

  it("requires an existing internal server and exact fresh inventory", () => {
    expect(() => resolve(undefined, { servers: {} })).toThrow(/server/i)
    expect(() => resolve(undefined, {
      servers: { "inventory-internal": { command: "neutral-server", visibility: "agent" } },
    })).toThrow(/internal/i)
    expect(() => resolve(undefined, { inventory: { "inventory-internal": [] } })).toThrow(/tool|inventory/i)
    expect(() => resolve(undefined, {
      inventory: {
        "inventory-internal": [{ ...inventory[0], outputSchema: undefined }, inventory[1]],
      },
    })).toThrow(/output.*schema/i)
    expect(() => resolve(undefined, {
      inventory: {
        "inventory-internal": [{ ...inventory[0], inputSchema: { type: "string" } }, inventory[1]],
      },
    })).toThrow(/input.*schema|mismatch/i)
    expect(() => resolve(undefined, {
      servers: { "inventory-internal": { command: "neutral-server" } },
    })).toThrow(/internal/i)
    expect(() => resolve(undefined, { inventory: {} })).toThrow(/fresh.*inventory/i)
    expect(() => resolve(undefined, {
      inventory: {
        "inventory-internal": [{ ...inventory[0], outputSchema: { type: "string" } }, inventory[1]],
      },
    })).toThrow(/output.*schema|mismatch/i)
    expect(() => resolve(undefined, {
      inventory: { "inventory-internal": [inventory[0], inventory[0], inventory[1]] },
    })).toThrow(/absent|duplicated/i)
  })

  it("rejects every malformed credential binding boundary", () => {
    const invalidBindings: unknown[] = [
      [null],
      [{ name: "token", source: {}, extra: true }],
      [{ name: "token", source: null }],
      [{ name: "token", source: { scope: "elsewhere", jsonPointer: "/token" } }],
      [{ name: "token", source: { scope: "agent-runtime-config", jsonPointer: 3 } }],
      [{ name: "token", source: { scope: "agent-runtime-config", jsonPointer: "/bad~2escape" } }],
      [
        { name: "token", source: { scope: "agent-runtime-config", jsonPointer: "/token" } },
        { name: "token", source: { scope: "machine-runtime-config", jsonPointer: "/token" } },
      ],
    ]
    for (const credentialBindings of invalidBindings) {
      expect(() => resolve([executor({ credentialBindings: credentialBindings as never })])).toThrow()
    }
  })

  it("confines schema refs and rejects remote, unresolved, cyclic, and hash-mismatched schemas", () => {
    expect(() => resolve([executor({
      habitInputSchema: binding("bundle", "../outside.json", habitInputSchema),
    })])).toThrow(/confined|outside|traversal/i)
    expect(() => resolve([executor({
      habitInputSchema: binding("bundle", "https://example.test/schema.json", habitInputSchema),
    })])).toThrow(/remote|ref/i)
    expect(() => resolve([executor({
      habitInputSchema: { ...binding("bundle", "schemas/habit-input.json", habitInputSchema), sha256: `sha256:${"0".repeat(64)}` },
    })])).toThrow(/hash/i)

    const unresolved = { $ref: "#/definitions/missing" }
    expect(() => resolve([executor({
      habitInputSchema: binding("bundle", "schemas/unresolved.json", unresolved),
    })], { files: files({ [path.join(bundleRoot, "schemas/unresolved.json")]: unresolved }) })).toThrow(/unresolved/i)

    const cyclic = { definitions: { a: { $ref: "#/definitions/b" }, b: { $ref: "#/definitions/a" } }, $ref: "#/definitions/a" }
    expect(() => resolve([executor({
      habitInputSchema: binding("bundle", "schemas/cyclic.json", cyclic),
    })], { files: files({ [path.join(bundleRoot, "schemas/cyclic.json")]: cyclic }) })).toThrow(/cyclic/i)

    const remoteRef = { $ref: "https://example.test/schema.json" }
    expect(() => resolve([executor({
      habitInputSchema: binding("bundle", "schemas/remote-ref.json", remoteRef),
    })], { files: files({ [path.join(bundleRoot, "schemas/remote-ref.json")]: remoteRef }) })).toThrow(/remote|cross-root/i)

    const nonStringRef = { $ref: 3 }
    expect(() => resolve([executor({
      habitInputSchema: binding("bundle", "schemas/non-string-ref.json", nonStringRef),
    })], { files: files({ [path.join(bundleRoot, "schemas/non-string-ref.json")]: nonStringRef }) })).toThrow(/remote|cross-root/i)

    const validRefs = {
      definitions: { leaf: { type: "string" }, alias: { $ref: "#/definitions/leaf" } },
      properties: {
        direct: { $ref: "#/definitions/leaf" },
        indirect: { $ref: "#/definitions/alias" },
        scalar: { $ref: "#/const" },
        list: [{ $ref: "#/definitions/leaf" }],
      },
      const: 1,
    }
    expect(() => resolve([executor({
      habitInputSchema: binding("bundle", "schemas/valid-refs.json", validRefs),
    })], { files: files({ [path.join(bundleRoot, "schemas/valid-refs.json")]: validRefs }) })).not.toThrow()
  })

  it("rejects malformed schema bindings and non-Error reads", () => {
    const baseDeps = {
      bundleRoot,
      packageSchemaRoot,
      mcpServers: {},
      inventoryByServer: {},
      readFile: () => JSON.stringify(habitInputSchema),
    }
    expect(() => resolveSchemaBinding(null, "schema", baseDeps)).toThrow(/object/i)
    expect(() => resolveSchemaBinding({ ...binding("bundle", "schema.json", habitInputSchema), extra: true }, "schema", baseDeps)).toThrow(/unknown/i)
    expect(() => resolveSchemaBinding({ ...binding("bundle", "schema.json", habitInputSchema), root: "remote" }, "schema", baseDeps)).toThrow(/root/i)
    expect(() => resolveSchemaBinding({ ...binding("bundle", "schema.json", habitInputSchema), ref: "" }, "schema", baseDeps)).toThrow(/relative/i)
    expect(() => resolveSchemaBinding({ ...binding("bundle", "schema.json", habitInputSchema), sha256: "bad" }, "schema", baseDeps)).toThrow(/sha256/i)
    expect(() => resolveSchemaBinding(binding("bundle", "schema.json", habitInputSchema), "schema", {
      ...baseDeps,
      readFile: () => { throw "unreadable" },
    })).toThrow(/unreadable/i)
    expect(() => resolveSchemaBinding(binding("bundle", "schema.json", habitInputSchema), "schema", {
      ...baseDeps,
      readFile: () => { throw new Error("permission denied") },
    })).toThrow(/permission denied/i)
    expect(() => resolveSchemaBinding(binding("bundle", "schema.json", habitInputSchema), "schema", {
      ...baseDeps,
      readFile: () => "null",
    })).toThrow(/object/i)
  })

  it("requires exact reconciliation coordinates and schemas", () => {
    expect(() => resolve([executor({ reconciliation: {} as never })])).toThrow()
    expect(() => resolve([executor({ reconciliation: { ...executor().reconciliation!, toolName: "" } })])).toThrow(/toolName/i)
    expect(() => resolve([executor({ reconciliation: { ...executor().reconciliation!, toolName: "missing_tool" } })])).toThrow(/absent/i)
    expect(() => resolve(undefined, {
      inventory: {
        "inventory-internal": [inventory[0], { ...inventory[1], inputSchema: { type: "string" } }],
      },
    })).toThrow(/reconciliation input schema/i)
    expect(() => resolve(undefined, {
      inventory: {
        "inventory-internal": [inventory[0], { ...inventory[1], outputSchema: undefined }],
      },
    })).toThrow(/reconciliation output schema/i)
    expect(() => resolve(undefined, {
      inventory: {
        "inventory-internal": [inventory[0], { ...inventory[1], outputSchema: { type: "string" } }],
      },
    })).toThrow(/reconciliation output schema/i)
  })

  it("validates the supported JSON Schema value subset", () => {
    const schema = {
      definitions: { label: { type: "string" } },
      type: "object",
      additionalProperties: false,
      required: ["name", 4],
      properties: {
        name: { $ref: "#/definitions/label" },
        enabled: { type: "boolean" },
        score: { type: "number" },
        count: { type: "integer" },
        absent: { type: "null" },
        tags: { type: "array", items: { type: "string" } },
        anyList: { type: "array" },
        choice: { enum: ["a", "b"] },
        fixed: { const: 1 },
      },
    }
    expect(() => validateJsonSchemaValue({
      name: "ready",
      enabled: true,
      score: 1.5,
      count: 2,
      absent: null,
      tags: ["a"],
      anyList: [],
      choice: "a",
      fixed: 1,
    }, schema, "value")).not.toThrow()

    const invalidValues = [
      [{ name: "ready", extra: true }, /unknown field/i],
      [{}, /required/i],
      [{ name: 3 }, /string/i],
      [{ name: "ready", enabled: "yes" }, /boolean/i],
      [{ name: "ready", score: "high" }, /number/i],
      [{ name: "ready", count: 1.5 }, /integer/i],
      [{ name: "ready", absent: false }, /null/i],
      [{ name: "ready", tags: "a" }, /array/i],
      [{ name: "ready", tags: [3] }, /string/i],
      [{ name: "ready", choice: "c" }, /enum/i],
      [{ name: "ready", fixed: 2 }, /const/i],
    ] as const
    for (const [value, error] of invalidValues) {
      expect(() => validateJsonSchemaValue(value, schema, "value")).toThrow(error)
    }
  })
})

describe("mcp-tool habit adapter", () => {
  it("accepts only executorId plus opaque input and validates habit input", () => {
    const registry = resolve()
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: vi.fn(),
      callInternalTool: vi.fn(),
      readCredential: vi.fn(),
    })

    expect(adapter.validateConfig({ executorId: "inventory-refresh", input: { filter: "ready" } })).toEqual({
      executorId: "inventory-refresh",
      input: { filter: "ready" },
    })
    for (const invalid of [
      { executorId: "inventory-refresh", input: {} },
      { executorId: "missing", input: { filter: "ready" } },
      { executorId: "inventory-refresh", input: { filter: "ready" }, serverId: "override" },
      { executorId: "inventory-refresh", input: { filter: "ready" }, command: "/bin/echo" },
      { executorId: "inventory-refresh", input: { filter: "ready" }, credentials: { token: "no" } },
      { executorId: 3, input: { filter: "ready" } },
      { executorId: "inventory-refresh", input: null },
      { executorId: "inventory-refresh", input: [] },
      { executorId: "inventory-refresh", input: { filter: 3 } },
      { executorId: "inventory-refresh", input: { filter: "ready", extra: true } },
    ]) {
      expect(() => adapter.validateConfig(invalid)).toThrow()
    }
  })

  it("keeps habit identity independent while invoking fixed executor coordinates with ephemeral credentials", async () => {
    const registry = resolve()
    const authority = createMcpInternalExecutorAuthority({
      executorId: "inventory-refresh",
      serverId: "inventory-internal",
      toolName: "refresh_inventory",
      registryRevision: registry.revision,
      randomBytes: () => Buffer.alloc(32, 4),
    })
    const callInternalTool = vi.fn(async () => ({
      content: [{ type: "text", text: "human-facing data is not authority" }],
      structuredContent: {
        version: 1,
        disposition: "settled",
        result: { version: 1, status: "completed", resultRef: "result:inventory-a" },
      },
      isError: false,
    }))
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => authority,
      callInternalTool,
      readCredential: (binding) => binding.name === "service-token"
        ? { state: "ready", value: "secret-value" }
        : { state: "missing" },
    })

    await expect(adapter.invoke(invocation({
      executorId: "inventory-refresh",
      input: { filter: "ready" },
    }))).resolves.toMatchObject({
      disposition: "settled",
      result: { status: "completed", resultRef: "result:inventory-a" },
    })
    expect(callInternalTool).toHaveBeenCalledWith({
      authority,
      serverId: "inventory-internal",
      toolName: "refresh_inventory",
      timeoutMs: 30_000,
      arguments: {
        ouroOccurrence: {
          occurrenceId: "occurrence-a",
          attemptId: "attempt-a",
          idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
          deadlineAt: "2026-07-24T12:01:00.000Z",
        },
        input: { filter: "ready" },
        credentials: { "service-token": "secret-value" },
      },
    })
    expect(JSON.stringify(invocation({ executorId: "inventory-refresh", input: { filter: "ready" } }))).not.toContain("secret-value")
  })

  it("fails before MCP dispatch when a fixed credential is missing or locked", async () => {
    for (const state of ["missing", "locked"] as const) {
      const callInternalTool = vi.fn()
      const adapter = createMcpToolHabitAdapter({
        registry: resolve(),
        authorityFor: vi.fn(),
        callInternalTool,
        readCredential: () => ({ state }),
      })
      await expect(adapter.invoke(invocation({ executorId: "inventory-refresh", input: { filter: "ready" } })))
        .rejects.toThrow(new RegExp(`${state}.*human-required|human-required.*${state}`, "i"))
      expect(callInternalTool).not.toHaveBeenCalled()
    }
  })

  it("uses only structuredContent as settlement authority and preserves explicit unknown evidence", async () => {
    const registry = resolve()
    const authority = createMcpInternalExecutorAuthority({
      executorId: "inventory-refresh",
      serverId: "inventory-internal",
      toolName: "refresh_inventory",
      registryRevision: registry.revision,
      randomBytes: () => Buffer.alloc(32, 2),
    })
    const unknown = {
      version: 1,
      disposition: "outcome_unknown",
      reason: "adapter_reported_unknown",
      evidence: {
        kind: "adapter-owned",
        ref: "evidence:inventory-a",
        sha256: "a".repeat(64),
        observedAt: "2026-07-24T12:00:10.000Z",
      },
    }
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => authority,
      callInternalTool: vi.fn(async () => ({
        content: [{ type: "text", text: JSON.stringify({ disposition: "settled" }) }],
        structuredContent: unknown,
        isError: false,
      })),
      readCredential: () => ({ state: "ready", value: "secret" }),
    })

    await expect(adapter.invoke(invocation({ executorId: "inventory-refresh", input: { filter: "ready" } })))
      .resolves.toEqual(unknown)
  })

  it.each([
    ["isError", { content: [], structuredContent: { disposition: "settled" }, isError: true }],
    ["missing structured content", { content: [{ type: "text", text: "completed" }] }],
    ["invalid structured content", { content: [], structuredContent: { version: 2, disposition: "settled" } }],
  ])("classifies %s without accepting text as authority", async (_label, result) => {
    const registry = resolve()
    const authority = createMcpInternalExecutorAuthority({
      executorId: "inventory-refresh",
      serverId: "inventory-internal",
      toolName: "refresh_inventory",
      registryRevision: registry.revision,
      randomBytes: () => Buffer.alloc(32, 1),
    })
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => authority,
      callInternalTool: vi.fn(async () => result),
      readCredential: () => ({ state: "ready", value: "secret" }),
    })

    await expect(adapter.invoke(invocation({ executorId: "inventory-refresh", input: { filter: "ready" } })))
      .rejects.toMatchObject({ name: "HabitAdapterInvocationError" })
  })

  it.each([
    ["terminal failure", {
      version: 1,
      disposition: "settled",
      result: { version: 1, status: "failed_terminal", error: { code: "no_access", message: "denied", retryable: false } },
    }],
    ["retryable failure", {
      version: 1,
      disposition: "settled",
      result: {
        version: 1,
        status: "failed_retryable",
        error: { code: "busy", message: "later", retryable: true },
        safeRetryEvidence: {
          kind: "adapter-owned",
          ref: "evidence:retry",
          sha256: "b".repeat(64),
          observedAt: "2026-07-24T12:00:00.000Z",
        },
        notBefore: "2026-07-24T12:05:00.000Z",
      },
    }],
  ])("accepts a schema-valid %s outcome", async (_label, result) => {
    await expect(adapterForResult({ content: [], structuredContent: result, isError: false })
      .invoke(invocation({ executorId: "inventory-refresh", input: { filter: "ready" } })))
      .resolves.toEqual(result)
  })

  it.each([
    [null],
    [[]],
    [{ version: 2, disposition: "settled" }],
    [{ version: 1, disposition: "other" }],
    [{ version: 1, disposition: "outcome_unknown", reason: "wrong", evidence: null }],
    [{ version: 1, disposition: "outcome_unknown", reason: "adapter_reported_unknown", evidence: [] }],
    [{ version: 1, disposition: "outcome_unknown", reason: "adapter_reported_unknown", evidence: { kind: "wrong" } }],
    [{ version: 1, disposition: "outcome_unknown", reason: "adapter_reported_unknown", evidence: { kind: "adapter-owned", ref: 3, sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" } }],
    [{ version: 1, disposition: "outcome_unknown", reason: "adapter_reported_unknown", evidence: { kind: "adapter-owned", ref: "e", sha256: "bad", observedAt: "2026-07-24T12:00:00.000Z" } }],
    [{ version: 1, disposition: "outcome_unknown", reason: "adapter_reported_unknown", evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: 3 } }],
    [{ version: 1, disposition: "outcome_unknown", reason: "adapter_reported_unknown", evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "invalid" } }],
    [{ version: 1, disposition: "settled", result: null }],
    [{ version: 1, disposition: "settled", result: { version: 2 } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "completed" } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "failed_terminal", error: null } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "failed_terminal", error: [] } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "failed_terminal", error: { code: 3, message: "x", retryable: false } } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "failed_terminal", error: { code: "x", message: 3, retryable: false } } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "failed_terminal", error: { code: "x", message: "x", retryable: "no" } } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "failed_retryable", error: { code: "x", message: "x", retryable: true }, safeRetryEvidence: null, notBefore: "2026-07-24T12:05:00.000Z" } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "failed_retryable", error: { code: "x", message: "x", retryable: true }, safeRetryEvidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" }, notBefore: 3 } }],
    [{ version: 1, disposition: "settled", result: { version: 1, status: "failed_retryable", error: { code: "x", message: "x", retryable: true }, safeRetryEvidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" }, notBefore: "invalid" } }],
  ])("rejects malformed structured invocation outcome %#", async (structuredContent) => {
    await expect(adapterForResult({ content: [], structuredContent, isError: false })
      .invoke(invocation({ executorId: "inventory-refresh", input: { filter: "ready" } })))
      .rejects.toMatchObject({ name: "HabitAdapterInvocationError" })
  })

  it("classifies a post-dispatch transport failure as outcome unknown", async () => {
    const registry = resolve()
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => resolvedAuthority(registry),
      callInternalTool: vi.fn(async () => { throw new Error("transport lost") }),
      readCredential: () => ({ state: "ready", value: "secret" }),
    })

    await expect(adapter.invoke(invocation({ executorId: "inventory-refresh", input: { filter: "ready" } })))
      .rejects.toMatchObject({ unknownReason: "adapter_transport_unknown" })
  })

  it.each([
    [{ version: 2, disposition: "settled" }],
    [{ version: 1, disposition: "other" }],
  ])("rejects a schema-valid but semantically invalid invocation outcome %#", async (structuredContent) => {
    const registry = resolveWithPermissiveResultSchema()
    await expect(adapterForResult({ content: [], structuredContent, isError: false }, registry)
      .invoke(invocation({ executorId: "inventory-refresh", input: { filter: "ready" } })))
      .rejects.toMatchObject({ name: "HabitAdapterInvocationError" })
  })

  it("reconciles through only the fixed reconciliation tool and prior evidence", async () => {
    const registry = resolve()
    const authority = createMcpInternalExecutorAuthority({
      executorId: "inventory-refresh",
      serverId: "inventory-internal",
      toolName: "reconcile_inventory",
      registryRevision: registry.revision,
      randomBytes: () => Buffer.alloc(32, 3),
    })
    const callInternalTool = vi.fn(async () => ({
      content: [],
      structuredContent: { version: 1, disposition: "unresolved" },
      isError: false,
    }))
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => authority,
      callInternalTool,
      readCredential: () => ({ state: "ready", value: "secret" }),
    })

    await expect(adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot,
      habitId: "inventory-refresh",
      config: { executorId: "inventory-refresh", input: { filter: "ready" } },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [{
        kind: "adapter-owned",
        ref: "evidence:inventory-a",
        sha256: "a".repeat(64),
        observedAt: "2026-07-24T12:00:10.000Z",
      }],
    })).resolves.toEqual({ version: 1, disposition: "unresolved" })
    expect(callInternalTool).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "inventory-internal",
      toolName: "reconcile_inventory",
      arguments: expect.objectContaining({ priorEvidence: [expect.objectContaining({ ref: "evidence:inventory-a" })] }),
    }))
  })

  it("returns unresolved without a configured reconciliation tool", async () => {
    const registry = resolve([executor({ reconciliation: null })])
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: vi.fn(),
      callInternalTool: vi.fn(),
      readCredential: vi.fn(),
    })

    await expect(adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot,
      habitId: "inventory-refresh",
      config: { executorId: "inventory-refresh", input: { filter: "ready" } },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    })).resolves.toEqual({ version: 1, disposition: "unresolved" })
  })

  it.each([
    ["transport failure", "throw"],
    ["isError", { content: [], isError: true }],
    ["missing structured content", { content: [] }],
    ["invalid structured content", { content: [], structuredContent: { version: 2 }, isError: false }],
  ])("returns unresolved when reconciliation has %s", async (_label, result) => {
    const registry = resolve()
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => resolvedAuthority(registry, "reconcile_inventory"),
      callInternalTool: vi.fn(async () => {
        if (result === "throw") throw new Error("lost")
        return result as never
      }),
      readCredential: () => ({ state: "ready", value: "secret" }),
    })

    await expect(adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot,
      habitId: "inventory-refresh",
      config: { executorId: "inventory-refresh", input: { filter: "ready" } },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    })).resolves.toEqual({ version: 1, disposition: "unresolved" })
  })

  it.each([
    [{ version: 1, disposition: "completed", resultRef: "result:a", evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" } }],
    [{ version: 1, disposition: "safe_retry", error: { code: "busy", message: "later", retryable: true }, notBefore: "2026-07-24T12:05:00.000Z", evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" } }],
    [{ version: 1, disposition: "failed_terminal", error: { code: "denied", message: "no", retryable: false }, evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" } }],
  ])("accepts schema-valid reconciliation disposition %#", async (structuredContent) => {
    const registry = resolve()
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => resolvedAuthority(registry, "reconcile_inventory"),
      callInternalTool: vi.fn(async () => ({ content: [], structuredContent, isError: false })),
      readCredential: () => ({ state: "ready", value: "secret" }),
    })

    await expect(adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot,
      habitId: "inventory-refresh",
      config: { executorId: "inventory-refresh", input: { filter: "ready" } },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    })).resolves.toEqual(structuredContent)
  })

  it.each([
    [{ version: 2, disposition: "unresolved" }],
    [{ version: 1, disposition: "completed", resultRef: "result:a", evidence: null }],
    [{ version: 1, disposition: "completed", evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" } }],
    [{ version: 1, disposition: "safe_retry", error: null, notBefore: "later", evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" } }],
    [{ version: 1, disposition: "failed_terminal", error: null, evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" } }],
    [{ version: 1, disposition: "other", evidence: { kind: "adapter-owned", ref: "e", sha256: "a".repeat(64), observedAt: "2026-07-24T12:00:00.000Z" } }],
  ])("maps malformed reconciliation disposition %# to unresolved", async (structuredContent) => {
    const registry = resolve()
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => resolvedAuthority(registry, "reconcile_inventory"),
      callInternalTool: vi.fn(async () => ({ content: [], structuredContent, isError: false })),
      readCredential: () => ({ state: "ready", value: "secret" }),
    })

    await expect(adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot,
      habitId: "inventory-refresh",
      config: { executorId: "inventory-refresh", input: { filter: "ready" } },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    })).resolves.toEqual({ version: 1, disposition: "unresolved" })
  })

  it("maps a schema-valid reconciliation version mismatch to unresolved", async () => {
    const registry = resolveWithPermissiveResultSchema()
    const adapter = createMcpToolHabitAdapter({
      registry,
      authorityFor: () => resolvedAuthority(registry, "reconcile_inventory"),
      callInternalTool: vi.fn(async () => ({
        content: [],
        structuredContent: { version: 2, disposition: "unresolved" },
        isError: false,
      })),
      readCredential: () => ({ state: "ready", value: "secret" }),
    })

    await expect(adapter.reconcile?.({
      schemaVersion: 1,
      agent: "agent-a",
      bundleRoot,
      habitId: "inventory-refresh",
      config: { executorId: "inventory-refresh", input: { filter: "ready" } },
      occurrenceId: "occurrence-a",
      attemptId: "attempt-a",
      unknownReason: "adapter_transport_unknown",
      priorEvidence: [],
    })).resolves.toEqual({ version: 1, disposition: "unresolved" })
  })
})
