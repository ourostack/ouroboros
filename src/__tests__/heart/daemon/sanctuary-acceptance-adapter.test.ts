import * as fs from "node:fs"

import { describe, expect, it, vi } from "vitest"

import {
  createSanctuaryAcceptanceVaultProbeDependencies,
  executeSanctuaryAcceptanceRevokedProbe,
  executeSanctuaryAcceptanceVaultProbe,
} from "../../../heart/daemon/sanctuary-acceptance-adapter"

const READ_QUERY = "query AcceptanceAuthProbe { info { os { hostname } } }"
const WRITE_QUERY = "mutation AcceptanceWriteProbe($id: PrefixedID!) { docker { restart(id: $id) { id } } }"
const MISSING_CONTAINER_ID = "Docker:ouro-acceptance-guaranteed-missing"
const READ_PERMISSIONS = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => ({ resource, actions: ["READ_ANY"] }))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function refreshed(config: Record<string, unknown>) {
  return {
    ok: true as const,
    itemPath: "vault:opaque",
    revision: "opaque",
    updatedAt: "2026-08-20T00:00:00.000Z",
    config,
  }
}

describe("Sanctuary acceptance adapter semantic proofs", () => {
  it("loads only the selected mounted key record for vault proof", () => {
    const root = fs.mkdtempSync("/tmp/ouro-selected-unraid-key-")
    const selected = `${root}/selected.json`
    fs.writeFileSync(selected, JSON.stringify({
      id: "read-id",
      name: "Butler RO",
      permissions: READ_PERMISSIONS,
      roles: [],
      key: "read-descriptor",
    }))
    try {
      const deps = createSanctuaryAcceptanceVaultProbeDependencies({ keyRecordPath: selected })
      expect(deps.readKeyRecords()).toEqual([expect.objectContaining({ id: "read-id", key: "read-descriptor" })])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("binds the read-only vault descriptor to the exact key ID and proves write denial", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { info: { os: { hostname: "opaque" } } } }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] })) as typeof fetch
    const deps = {
      refresh: async () => refreshed({
        unraidGraphqlUrl: "http://127.0.0.1:2378/graphql",
        unraidReadApiKey: "read-descriptor",
        unraidWriteApiKey: "write-descriptor",
      }),
      readKeyRecords: () => [
        { id: "read-id", name: "Butler RO", permissions: READ_PERMISSIONS, roles: [], key: "read-descriptor" },
        { id: "write-id", name: "Butler RW", permissions: READ_PERMISSIONS.map((permission) => permission.resource === "DOCKER"
          ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
          : permission), roles: [], key: "write-descriptor" },
      ],
      fetch: fetchImpl,
    }

    await expect(executeSanctuaryAcceptanceVaultProbe("read-id", "read-only", deps)).resolves.toEqual({
      valid: true,
      keyId: "read-id",
      capability: "read-only",
      proof: "read-authorized-write-denied",
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:2378/graphql", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: READ_QUERY, variables: {} }),
      headers: { "content-type": "application/json", "x-api-key": "read-descriptor" },
      signal: expect.any(AbortSignal),
    }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "http://127.0.0.1:2378/graphql", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: WRITE_QUERY, variables: { id: MISSING_CONTAINER_ID } }),
      headers: { "content-type": "application/json", "x-api-key": "read-descriptor" },
      signal: expect.any(AbortSignal),
    }))
  })

  it("binds the bounded-write descriptor to exact metadata and proves harmless mutation authorization", async () => {
    const writeKey = {
      id: "write-id",
      name: "Butler RW",
      permissions: READ_PERMISSIONS.map((permission) => permission.resource === "DOCKER"
        ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
        : permission),
      roles: [],
      key: "write-descriptor",
    }
    const base = {
      refresh: async () => refreshed({
        unraidGraphqlUrl: "http://127.0.0.1:2378/graphql",
        unraidReadApiKey: "read-descriptor",
        unraidWriteApiKey: "write-descriptor",
      }),
      readKeyRecords: () => [writeKey],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { info: { os: { hostname: "opaque" } } } }))
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Container not found", extensions: { code: "NOT_FOUND" } }] })) as typeof fetch

    await expect(executeSanctuaryAcceptanceVaultProbe("write-id", "bounded-write", { ...base, fetch: fetchImpl })).resolves.toEqual({
      valid: true,
      keyId: "write-id",
      capability: "bounded-write",
      proof: "read-authorized-write-reached-not-found",
    })
    expect(JSON.parse(String((fetchImpl.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      query: WRITE_QUERY,
      variables: { id: MISSING_CONTAINER_ID },
    })

    await expect(executeSanctuaryAcceptanceVaultProbe("other-id", "bounded-write", {
      ...base,
      fetch: vi.fn() as typeof fetch,
    })).rejects.toThrow(/descriptor.*exact key ID/iu)
    await expect(executeSanctuaryAcceptanceVaultProbe("write-id", "bounded-write", {
      ...base,
      readKeyRecords: () => [{ ...writeKey, permissions: READ_PERMISSIONS }],
      fetch: vi.fn() as typeof fetch,
    })).rejects.toThrow(/scope/iu)
  })

  it("packages explicit vault and revoked probe modes without putting descriptors in argv", () => {
    const wrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-adapter.sh", "utf8")

    expect(wrapper).toContain("vault-probe")
    expect(wrapper).toContain("revoked-probe")
    expect(wrapper).toContain("3<&0")
    expect(wrapper).not.toMatch(/descriptor.*\$[234]/u)
  })

  it("binds a revoked raw key file from fd3 to argv ID without returning its descriptor", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ extensions: { code: "UNAUTHENTICATED" } }] }, 401)) as typeof fetch
    const rawKeyFile = JSON.stringify({ id: "revoked-id", name: "Legacy", key: "revoked-descriptor" })

    await expect(executeSanctuaryAcceptanceRevokedProbe(
      "revoked-id",
      "http://127.0.0.1:2378/graphql",
      rawKeyFile,
      { fetch: fetchImpl },
    )).resolves.toEqual({ rejected: true, id: "revoked-id", status: 401 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:2378/graphql")
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "revoked-descriptor",
    })
    await expect(executeSanctuaryAcceptanceRevokedProbe(
      "other-id",
      "http://127.0.0.1:2378/graphql",
      rawKeyFile,
      { fetch: fetchImpl },
    )).rejects.toThrow(/ID mismatch/u)
  })
})
