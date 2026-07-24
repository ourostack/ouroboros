import { createHash } from "crypto"

import { describe, expect, it, vi } from "vitest"

import { canonicalizeJson } from "../../../heart/runtime/canonical-json"
import {
  isMcpHealthReceiptFresh,
  runMcpHealthProfile,
  validateMcpHealthProfiles,
  type McpHealthProfileV1,
} from "../../../heart/mcp/mcp-health"
import type { McpToolInfo, McpToolCallResultV1 } from "../../../repertoire/mcp-client"

const inputSchema = { type: "object", additionalProperties: false, properties: {} }
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalizeJson(value), "utf8")).digest("hex")}`
}

function binding(ref: string, schema: unknown) {
  return { root: "bundle" as const, ref, sha256: hash(schema) }
}

function inventoryProfile(overrides: Partial<McpHealthProfileV1> = {}): McpHealthProfileV1 {
  return {
    schemaVersion: 1,
    profileId: "inventory-health",
    serverId: "inventory-server",
    registryRevision: `sha256:${"a".repeat(64)}`,
    expectedTools: [{
      name: "inventory_status",
      inputSchema: binding("schemas/status-input.json", inputSchema),
      outputSchema: binding("schemas/status-output.json", outputSchema),
    }],
    credentialBindingNames: ["service-token"],
    mode: "inventory-schema-credential-readiness",
    readOnlyProbe: null,
    timeoutMs: 5_000,
    freshnessMs: 300_000,
    ...overrides,
  }
}

const listedTools: McpToolInfo[] = [{
  name: "inventory_status",
  description: "Read neutral inventory status",
  inputSchema,
  outputSchema,
}]

function validationDeps() {
  return {
    serverIds: new Set(["inventory-server"]),
    executorTools: new Set(["inventory-server/refresh_inventory"]),
    reconciliationTools: new Set(["inventory-server/reconcile_inventory"]),
    resolveSchema: (schema: { ref: string }) => schema.ref.includes("input") ? inputSchema : outputSchema,
  }
}

describe("MCP health profile registry", () => {
  it("validates exact profile/server/schema/credential bounds", () => {
    const registry = validateMcpHealthProfiles([inventoryProfile()], validationDeps())

    expect(registry.keys()).toEqual(["inventory-health"])
    expect(registry.get("inventory-health")).toEqual(inventoryProfile())
  })

  it("rejects duplicates, unknown fields, unknown servers, and noncanonical revisions", () => {
    expect(() => validateMcpHealthProfiles([inventoryProfile(), inventoryProfile()], validationDeps())).toThrow(/duplicate/i)
    expect(() => validateMcpHealthProfiles([{ ...inventoryProfile(), text: "not allowed" }], validationDeps())).toThrow(/unknown.*text/i)
    expect(() => validateMcpHealthProfiles([inventoryProfile({ serverId: "missing" })], validationDeps())).toThrow(/server/i)
    expect(() => validateMcpHealthProfiles([inventoryProfile({ registryRevision: "latest" })], validationDeps())).toThrow(/revision/i)
  })

  it("enforces timeout and freshness limits", () => {
    for (const timeoutMs of [999, 60_001]) {
      expect(() => validateMcpHealthProfiles([inventoryProfile({ timeoutMs })], validationDeps())).toThrow(/timeout/i)
    }
    for (const freshnessMs of [59_999, 3_600_001]) {
      expect(() => validateMcpHealthProfiles([inventoryProfile({ freshnessMs })], validationDeps())).toThrow(/freshness/i)
    }
  })

  it("requires inventory mode to have no probe", () => {
    expect(() => validateMcpHealthProfiles([inventoryProfile({
      readOnlyProbe: {
        toolName: "inventory_status",
        input: {},
        resultSchema: binding("schemas/status-output.json", outputSchema),
        sideEffects: "none",
      },
    })], validationDeps())).toThrow(/inventory.*probe|probe.*inventory/i)
  })

  it("permits only a fixed listed side-effect-free read-only probe", () => {
    const readOnly = inventoryProfile({
      mode: "read-only-tool",
      readOnlyProbe: {
        toolName: "inventory_status",
        input: {},
        resultSchema: binding("schemas/status-output.json", outputSchema),
        sideEffects: "none",
      },
    })
    expect(() => validateMcpHealthProfiles([readOnly], validationDeps())).not.toThrow()
    expect(() => validateMcpHealthProfiles([{
      ...readOnly,
      readOnlyProbe: { ...readOnly.readOnlyProbe!, toolName: "refresh_inventory" },
    }], validationDeps())).toThrow(/executor|effectful/i)
    expect(() => validateMcpHealthProfiles([{
      ...readOnly,
      readOnlyProbe: { ...readOnly.readOnlyProbe!, toolName: "reconcile_inventory" },
    }], validationDeps())).toThrow(/reconciliation|effectful/i)
    expect(() => validateMcpHealthProfiles([{
      ...readOnly,
      readOnlyProbe: { ...readOnly.readOnlyProbe!, sideEffects: "write" as "none" },
    }], validationDeps())).toThrow(/sideEffects|none/i)
  })
})

describe("MCP health runner", () => {
  it("inventory mode lists schemas and checks names/states without resolving values or invoking tools", async () => {
    const callReadOnlyTool = vi.fn()
    const resolveCredentialValue = vi.fn(() => "secret-must-not-be-read")
    const receipt = await runMcpHealthProfile(inventoryProfile(), {
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      inventory: vi.fn(async () => ({
        negotiatedProtocolVersion: "2025-06-18",
        transportIdentitySha256: `sha256:${"b".repeat(64)}`,
        tools: listedTools,
      })),
      credentialState: vi.fn(() => "ready" as const),
      resolveCredentialValue,
      callReadOnlyTool,
      validateResult: vi.fn(),
      persistEvidence: vi.fn((kind, value) => ({ ref: `evidence:${kind}`, sha256: hash(value) })),
    })

    expect(receipt.disposition).toBe("healthy")
    expect(receipt.credentialReadiness).toEqual([{ bindingName: "service-token", state: "ready" }])
    expect(receipt.probe).toBeNull()
    expect(receipt.effectfulToolInvoked).toBe(false)
    expect(resolveCredentialValue).not.toHaveBeenCalled()
    expect(callReadOnlyTool).not.toHaveBeenCalled()
    expect(JSON.stringify(receipt)).not.toContain("secret-must-not-be-read")
  })

  it("marks missing, locked, inventory-mismatched, and schema-mismatched evidence unhealthy", async () => {
    for (const state of ["missing", "locked"] as const) {
      const receipt = await runMcpHealthProfile(inventoryProfile(), {
        now: () => new Date("2026-07-24T12:00:00.000Z"),
        inventory: async () => ({
          negotiatedProtocolVersion: "2025-06-18",
          transportIdentitySha256: `sha256:${"b".repeat(64)}`,
          tools: listedTools,
        }),
        credentialState: () => state,
        resolveCredentialValue: vi.fn(),
        callReadOnlyTool: vi.fn(),
        validateResult: vi.fn(),
        persistEvidence: (kind, value) => ({ ref: `evidence:${kind}`, sha256: hash(value) }),
      })
      expect(receipt.disposition).toBe("unhealthy")
      expect(receipt.credentialReadiness).toContainEqual({ bindingName: "service-token", state })
    }

    const mismatch = await runMcpHealthProfile(inventoryProfile(), {
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      inventory: async () => ({
        negotiatedProtocolVersion: "2025-06-18",
        transportIdentitySha256: `sha256:${"b".repeat(64)}`,
        tools: [{ ...listedTools[0], outputSchema: { type: "string" } }],
      }),
      credentialState: () => "ready",
      resolveCredentialValue: vi.fn(),
      callReadOnlyTool: vi.fn(),
      validateResult: vi.fn(),
      persistEvidence: (kind, value) => ({ ref: `evidence:${kind}`, sha256: hash(value) }),
    })
    expect(mismatch.disposition).toBe("unhealthy")
  })

  it("runs one schema-valid no-effect probe without persisting model-visible content", async () => {
    const profile = inventoryProfile({
      mode: "read-only-tool",
      readOnlyProbe: {
        toolName: "inventory_status",
        input: {},
        resultSchema: binding("schemas/status-output.json", outputSchema),
        sideEffects: "none",
      },
    })
    const callReadOnlyTool = vi.fn(async (): Promise<McpToolCallResultV1> => ({
      content: [{ type: "text", text: "free text must not enter health authority" }],
      structuredContent: { ok: true },
      isError: false,
    }))
    const receipt = await runMcpHealthProfile(profile, {
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      inventory: async () => ({
        negotiatedProtocolVersion: "2025-06-18",
        transportIdentitySha256: `sha256:${"b".repeat(64)}`,
        tools: listedTools,
      }),
      credentialState: () => "ready",
      resolveCredentialValue: vi.fn(),
      callReadOnlyTool,
      validateResult: vi.fn(),
      persistEvidence: (kind, value) => ({ ref: `evidence:${kind}`, sha256: hash(value) }),
    })

    expect(callReadOnlyTool).toHaveBeenCalledTimes(1)
    expect(callReadOnlyTool).toHaveBeenCalledWith("inventory-server", "inventory_status", {}, 5_000)
    expect(receipt.probe).toMatchObject({ toolName: "inventory_status", schemaValid: true, sideEffects: "none" })
    expect(receipt.effectfulToolInvoked).toBe(false)
    expect(JSON.stringify(receipt)).not.toContain("free text")
  })

  it("derives freshness strictly from the receipt expiry", async () => {
    const receipt = await runMcpHealthProfile(inventoryProfile(), {
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      inventory: async () => ({
        negotiatedProtocolVersion: "2025-06-18",
        transportIdentitySha256: `sha256:${"b".repeat(64)}`,
        tools: listedTools,
      }),
      credentialState: () => "ready",
      resolveCredentialValue: vi.fn(),
      callReadOnlyTool: vi.fn(),
      validateResult: vi.fn(),
      persistEvidence: (kind, value) => ({ ref: `evidence:${kind}`, sha256: hash(value) }),
    })

    expect(isMcpHealthReceiptFresh(receipt, new Date("2026-07-24T12:04:59.999Z"))).toBe(true)
    expect(isMcpHealthReceiptFresh(receipt, new Date("2026-07-24T12:05:00.000Z"))).toBe(false)
    expect(isMcpHealthReceiptFresh({ ...receipt, disposition: "unhealthy" }, new Date("2026-07-24T12:01:00.000Z"))).toBe(false)
  })
})
