import { pathToFileURL } from "node:url"
import * as fs from "node:fs"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

interface BrokerDependencies { readBootId(): string; containerSnapshot(): unknown }

interface BrokerModule {
  dispatch(request: unknown, dependencies?: BrokerDependencies): Promise<unknown>
  parseVaultStatus(output: string, succeeded: boolean): { vaultUnlocked: boolean; manualAuthRequired: boolean }
  queryGraphqlAutostart(records: unknown[], fetchImpl: typeof fetch): Promise<boolean>
}

async function broker(): Promise<BrokerModule> {
  return import(pathToFileURL(path.resolve("deploy/unraid/sanctuary-unit16-host-broker.mjs")).href) as Promise<{
    dispatch(request: unknown, dependencies?: BrokerDependencies): Promise<unknown>
    parseVaultStatus(output: string, succeeded: boolean): { vaultUnlocked: boolean; manualAuthRequired: boolean }
    queryGraphqlAutostart(records: unknown[], fetchImpl: typeof fetch): Promise<boolean>
  }>
}

describe("Sanctuary Unit 16 host broker", () => {
  it("stages a bounded host reboot attestation without executing reboot", async () => {
    const { dispatch } = await broker()
    const result = await dispatch({
      operation: "request_reboot",
      targetId: "sanctuary",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
    }, {
      readBootId: () => "11111111-2222-3333-4444-555555555555\n",
      containerSnapshot: () => { throw new Error("unexpected container snapshot") },
    }) as Record<string, unknown>

    expect(result).toMatchObject({ accepted: true, targetId: "sanctuary", staged: true })
    expect(result.requestId).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.prebootId).toMatch(/^[A-Za-z0-9-]{4,128}$/u)
  })

  it("refreshes only the exact production container snapshot operation", async () => {
    const { dispatch } = await broker()
    const snapshot = {
      schemaVersion: 1, containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`,
      running: true, health: "healthy", user: "10001:10001", readOnlyRoot: true,
      mountCount: 2, mountsDigest: "c".repeat(64), publishedPortCount: 0,
      networkMode: "host", restartPolicy: "no", restartCount: 3,
      autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false,
    }
    await expect(dispatch({ operation: "container_snapshot", targetId: "sanctuary" }, {
      readBootId: () => { throw new Error("unexpected boot read") },
      containerSnapshot: () => snapshot,
    })).resolves.toEqual(snapshot)
    await expect(dispatch({ operation: "container_snapshot", targetId: "sanctuary", name: "another" }, {
      readBootId: () => "unused",
      containerSnapshot: () => snapshot,
    })).rejects.toThrow(/shape is invalid/u)
  })

  it("reads GraphQL autostart through the exact canonical RO credential and query", async () => {
    const { queryGraphqlAutostart } = await broker()
    const calls: Array<{ input: string; init?: RequestInit }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      return new Response(JSON.stringify({ data: { docker: { containers: [{ id: "Docker:one", names: ["/ouro-butler"], autoStart: true }] } } }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const permissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    await expect(queryGraphqlAutostart([{ id: "ro-id", name: "Butler RO", permissions, roles: [], key: "private-descriptor" }], fetchImpl)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe("http://127.0.0.1/graphql")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json", "x-api-key": "private-descriptor" })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: "query AcceptanceContainerTopology { docker { containers(skipCache: true) { id names autoStart } } }",
      variables: {},
    })
  })

  it("requires successful live runtime and both provider vault reads", async () => {
    const { parseVaultStatus } = await broker()
    expect(parseVaultStatus("local unlock: available\nruntime credentials: missing\nprovider credentials: unavailable (network)\n", true))
      .toEqual({ vaultUnlocked: false, manualAuthRequired: true })
    expect(parseVaultStatus("local unlock: available\nruntime credentials: telegramAuthorizedChatId, telegramAuthorizedUserId, telegramBotToken (runtime_revision)\nprovider credentials: \n  openai-compatible: credential fields apiKey, config fields baseUrl\n  openai-compatible-gemini: credential fields apiKey, config fields baseUrl\n", true))
      .toEqual({ vaultUnlocked: true, manualAuthRequired: false })
    expect(parseVaultStatus("local unlock: available\nruntime credentials: telegramAuthorizedChatId, telegramAuthorizedUserId, telegramBotToken (runtime_revision)\nprovider credentials: \n  openai-compatible: credential fields apiKey, config fields baseUrl\n", true))
      .toEqual({ vaultUnlocked: false, manualAuthRequired: true })
    expect(parseVaultStatus("local unlock: missing\n", true))
      .toEqual({ vaultUnlocked: false, manualAuthRequired: true })
    expect(parseVaultStatus("local unlock: available\n", false))
      .toEqual({ vaultUnlocked: false, manualAuthRequired: true })
  })

  it("rejects unknown operations, extra authority, and invalid target coordinates", async () => {
    const { dispatch } = await broker()
    await expect(dispatch({ operation: "run_command", executable: "/bin/sh" })).rejects.toThrow(/not whitelisted/u)
    await expect(dispatch({
      operation: "request_reboot",
      targetId: "sanctuary",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
      executable: "/sbin/reboot",
    })).rejects.toThrow(/shape is invalid/u)
    await expect(dispatch({
      operation: "request_reboot",
      targetId: "another-host",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
    })).rejects.toThrow(/target host is invalid/u)
  })

  it("keeps host authority fixed and emits only redacted broker failures", () => {
    const source = fs.readFileSync("deploy/unraid/sanctuary-unit16-host-broker.mjs", "utf8")
    expect(source).toContain('const KEY_ROOT = "/boot/config/plugins/dynamix.my.servers/keys"')
    expect(source).toContain('const UNRAID_API = "/usr/local/sbin/unraid-api"')
    expect(source).toContain('const DOCKER = "/usr/bin/docker"')
    expect(source).toContain('const PRODUCTION_CONTAINER = "ouro-butler"')
    expect(source).toContain('const AUTOSTART_FILE = "/var/lib/docker/unraid-autostart"')
    expect(source).toContain('const RUNTIME_POLICY_FILE = "/opt/ouro/container-runtime.json"')
    expect(source).toContain('"vault", "status", "--agent", "sanctuary"')
    expect(source.match(/spawnSync\(DOCKER, \["inspect"/gu)).toHaveLength(1)
    expect(source).toContain('const GRAPHQL_ENDPOINT = "http://127.0.0.1/graphql"')
    expect(source).toContain('chownSync(socket, 0, 10001)')
    expect(source).toContain('chmodSync(socket, 0o660)')
    expect(source).toContain('{ ok: false, error: "host operation failed" }')
    expect(source).not.toMatch(/console\.(?:log|error|warn)/u)
    expect(source).not.toContain("/var/run/docker.sock")
  })
})
