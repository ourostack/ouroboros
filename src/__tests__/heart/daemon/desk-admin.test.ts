/**
 * `ouro desk invite|access|delete-account` — Hosted Desk admin commands.
 *
 * The commands call Hosted Desk's admin routes with an Entra access token for
 * the `ouro.admin` app role, obtained through a loopback authorization-code +
 * PKCE sign-in. The gateway is faked; the loopback server is real.
 */

import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it, expect, vi, beforeEach } from "vitest"

const nervesEvents = vi.hoisted(() => [] as Array<{ event: string; level?: string; meta?: Record<string, unknown> }>)
vi.mock("../../../nerves/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nerves/runtime")>()),
  emitNervesEvent: (event: { event: string; level?: string; meta?: Record<string, unknown> }) => { nervesEvents.push(event) },
}))

import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import {
  ADMIN_CONFIG_PATH,
  DEFAULT_DESK_GATEWAY,
  PRODUCTION_TENANT_ID,
  executeDeskAdminCommand,
  gatewayOrigin,
  shown,
  signInForDeskAdmin,
} from "../../../heart/daemon/desk-admin"

const GATEWAY = "https://desk-staging.example.test"
const TENANT = "c12edfb6-0000-4000-8000-000000000001"
const ADMIN_CONFIG = { tenantId: TENANT, subdomain: "ourobottest", clientId: "cli-client-id", scope: "api://gateway-app/desk.admin" }
const DISCOVERY_URL = `https://ourobottest.ciamlogin.com/${TENANT}/v2.0/.well-known/openid-configuration`
const DISCOVERY = {
  issuer: `https://${TENANT}.ciamlogin.com/${TENANT}/v2.0`,
  authorization_endpoint: `https://ourobottest.ciamlogin.com/${TENANT}/oauth2/v2.0/authorize`,
  token_endpoint: `https://ourobottest.ciamlogin.com/${TENANT}/oauth2/v2.0/token`,
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function createDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps & { output: string[]; exitCodes: number[] } {
  const output: string[] = []
  const exitCodes: number[] = []
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(),
    writeStdout: (text: string) => { output.push(text) },
    setExitCode: (code: number) => { exitCodes.push(code) },
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    output,
    exitCodes,
    ...overrides,
  }
}

/** Follows the authorize URL's redirect with this sign-in's state, as the browser would after sign-in. */
async function completeSignIn(url: string, query = "code=the-code"): Promise<Response> {
  const params = new URL(url).searchParams
  return fetch(`${params.get("redirect_uri")}?${query}&state=${params.get("state")}`)
}

beforeEach(() => { nervesEvents.length = 0 })

// ── Parsing ──

describe("ouro desk admin parsing", () => {
  it("parses invite with a display name", () => {
    expect(parseOuroCommand(["desk", "invite", "--name", "Sam"])).toEqual({ kind: "desk.admin", action: "invite", displayName: "Sam" })
  })

  it("parses a re-invite by account, with gateway, trust and out file", () => {
    expect(parseOuroCommand(["desk", "invite", "--account", "acct-1", "--gateway", "https://g.test", "--trust-gateway", "--out", "/tmp/i.url"])).toEqual({
      kind: "desk.admin",
      action: "invite",
      accountId: "acct-1",
      gateway: "https://g.test",
      trustGateway: true,
      out: "/tmp/i.url",
    })
  })

  it("refuses invite without exactly one of --name and --account", () => {
    expect(() => parseOuroCommand(["desk", "invite"])).toThrow(/ouro desk invite --name/)
    expect(() => parseOuroCommand(["desk", "invite", "--name", "Sam", "--account", "acct-1"])).toThrow(/ouro desk invite --name <name> \| --account <id>/)
  })

  it("refuses invite with an unknown flag, a flag missing its value or a blank name", () => {
    expect(() => parseOuroCommand(["desk", "invite", "--name", "Sam", "--bogus", "x"])).toThrow(/ouro desk invite --name/)
    expect(() => parseOuroCommand(["desk", "invite", "--name"])).toThrow(/ouro desk invite --name/)
    expect(() => parseOuroCommand(["desk", "invite", "--name", "  "])).toThrow(/ouro desk invite --name/)
    expect(() => parseOuroCommand(["desk", "invite", "--name", "Sam", "extra"])).toThrow(/ouro desk invite --name/)
  })

  it("parses access on and off", () => {
    expect(parseOuroCommand(["desk", "access", "acct-1", "on"])).toEqual({ kind: "desk.admin", action: "access", accountId: "acct-1", on: true })
    expect(parseOuroCommand(["desk", "access", "acct-1", "off", "--gateway", "https://g.test", "--trust-gateway"])).toEqual({
      kind: "desk.admin",
      action: "access",
      accountId: "acct-1",
      on: false,
      gateway: "https://g.test",
      trustGateway: true,
    })
  })

  it("refuses access without an id or with a state other than on|off", () => {
    expect(() => parseOuroCommand(["desk", "access"])).toThrow(/ouro desk access <account> on\|off/)
    expect(() => parseOuroCommand(["desk", "access", "acct-1"])).toThrow(/ouro desk access <account> on\|off/)
    expect(() => parseOuroCommand(["desk", "access", "acct-1", "maybe"])).toThrow(/ouro desk access <account> on\|off/)
    expect(() => parseOuroCommand(["desk", "access", "acct-1", "on", "extra"])).toThrow(/ouro desk access <account> on\|off/)
  })

  it("refuses an account id that is not a plain identifier", () => {
    expect(() => parseOuroCommand(["desk", "access", "../x", "on"])).toThrow(/account id/)
    expect(() => parseOuroCommand(["desk", "delete-account", "a/b", "--yes"])).toThrow(/account id/)
    expect(() => parseOuroCommand(["desk", "invite", "--account", "a b"])).toThrow(/account id/)
  })

  it("parses delete-account only with --yes", () => {
    expect(parseOuroCommand(["desk", "delete-account", "acct-1", "--yes"])).toEqual({ kind: "desk.admin", action: "delete-account", accountId: "acct-1" })
    expect(parseOuroCommand(["desk", "delete-account", "acct-1", "--yes", "--gateway", "https://g.test", "--trust-gateway"]))
      .toEqual({ kind: "desk.admin", action: "delete-account", accountId: "acct-1", gateway: "https://g.test", trustGateway: true })
    expect(() => parseOuroCommand(["desk", "delete-account", "acct-1"])).toThrow(/--yes/)
    expect(() => parseOuroCommand(["desk", "delete-account", "--yes"])).toThrow(/ouro desk delete-account <account> --yes/)
    expect(() => parseOuroCommand(["desk", "delete-account", "acct-1", "--yes", "--gateway"])).toThrow(/ouro desk delete-account <account> --yes/)
  })

  it("lists the admin verbs in desk usage", () => {
    expect(() => parseOuroCommand(["desk"])).toThrow(/ouro desk invite --name <name>/)
  })
})

describe("gatewayOrigin and shown", () => {
  it("accepts only a bare https origin", () => {
    expect(gatewayOrigin("https://desk.ouro.bot")).toBe("https://desk.ouro.bot")
    expect(gatewayOrigin("https://desk.ouro.bot/")).toBe("https://desk.ouro.bot")
    expect(gatewayOrigin("http://desk.ouro.bot")).toBeNull()
    expect(gatewayOrigin("https://desk.ouro.bot?x")).toBeNull()
    expect(gatewayOrigin("https://desk.ouro.bot/#")).toBeNull()
    expect(gatewayOrigin("https://desk.ouro.bot/admin")).toBeNull()
    expect(gatewayOrigin("https://user:pw@desk.ouro.bot")).toBeNull()
    expect(gatewayOrigin("not a url")).toBeNull()
  })

  it("strips control characters and bounds length", () => {
    expect(shown("ok\u001b[31mred\u0007")).toBe("ok[31mred")
    expect(shown("x".repeat(500))).toHaveLength(200)
    expect(shown(undefined)).toBe("undefined")
  })
})

// ── Executing against a fake gateway ──

describe("ouro desk admin execution", () => {
  const signIn = vi.fn(async () => "admin-access-token")
  beforeEach(() => { signIn.mockClear() })

  const invited = () => vi.fn(async () => json(201, { accountId: "acct-new", inviteUrl: `${GATEWAY}/invite/secret-token`, expiresAt: "2026-10-28T00:00:00.000Z" }))
  const accessIs = (deskAccess: boolean) => json(200, { accountId: "acct-1", deskAccess })
  const deleted = (deskRemoved = true) => json(200, { accountId: "acct-1", deleted: true, deskRemoved })

  it("issues an invite and prints its link and expiry", async () => {
    const fetchImpl = invited()
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam", gateway: GATEWAY, trustGateway: true }, deps, signIn)

    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ gateway: GATEWAY }))
    expect((signIn.mock.calls[0] as unknown[])[0]).not.toHaveProperty("expectedTenantId")
    expect(fetchImpl).toHaveBeenCalledWith(`${GATEWAY}/admin/invites`, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer admin-access-token", "content-type": "application/json" }),
      body: JSON.stringify({ displayName: "Sam" }),
    }))
    expect(text).toBe(`Invite for Sam (account acct-new), single use, expires 2026-10-28T00:00:00.000Z.\n${GATEWAY}/invite/secret-token`)
    expect(deps.output).toEqual([text])
    expect(deps.exitCodes).toEqual([])
    expect(nervesEvents.map((e) => e.event)).toEqual(["daemon.desk_admin_start", "daemon.desk_admin_end"])
    expect(JSON.stringify(nervesEvents)).not.toMatch(/admin-access-token|secret-token/)
  })

  it("re-invites an existing account by id", async () => {
    const fetchImpl = invited()
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", accountId: "acct-new", gateway: GATEWAY, trustGateway: true }, deps, signIn)
    expect(fetchImpl).toHaveBeenCalledWith(`${GATEWAY}/admin/invites`, expect.objectContaining({ body: JSON.stringify({ accountId: "acct-new" }) }))
    expect(text).toBe(`Invite for account acct-new, single use, expires 2026-10-28T00:00:00.000Z.\n${GATEWAY}/invite/secret-token`)
  })

  it("uses the production gateway by default and pins Ouro's production tenant", async () => {
    const fetchImpl = vi.fn(async () => json(201, { accountId: "acct-new", inviteUrl: `${DEFAULT_DESK_GATEWAY}/invite/abc`, expiresAt: "2026-10-28T00:00:00.000Z" }))
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam" }, deps, signIn)
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ gateway: DEFAULT_DESK_GATEWAY, expectedTenantId: PRODUCTION_TENANT_ID }))
    expect(fetchImpl).toHaveBeenCalledWith(`${DEFAULT_DESK_GATEWAY}/admin/invites`, expect.objectContaining({ body: JSON.stringify({ displayName: "Sam" }) }))
  })

  it("refuses another gateway unless it is explicitly trusted, before signing in", async () => {
    const fetchImpl = vi.fn()
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "access", accountId: "acct-1", on: true, gateway: GATEWAY }, deps, signIn)
    expect(text).toMatch(/--trust-gateway/)
    expect(signIn).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(nervesEvents.map((e) => [e.event, e.level])).toEqual([["daemon.desk_admin_start", undefined], ["daemon.desk_admin_error", "error"]])
  })

  it("refuses a gateway that is not a bare https origin", async () => {
    const deps = createDeps({ fetchImpl: vi.fn() as unknown as typeof fetch })
    for (const gateway of ["http://desk.example.test", "https://desk.ouro.bot?x", "not a url"]) {
      expect(await executeDeskAdminCommand({ kind: "desk.admin", action: "access", accountId: "acct-1", on: true, gateway, trustGateway: true }, deps, signIn))
        .toMatch(/must be a bare https origin/)
    }
    expect(signIn).not.toHaveBeenCalled()
  })

  it("writes the invite link to --out with mode 0600 and does not print it", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "desk-admin-")), "invite.url")
    const deps = createDeps({ fetchImpl: invited() as unknown as typeof fetch })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam", gateway: GATEWAY, trustGateway: true, out }, deps, signIn)

    expect(readFileSync(out, "utf8")).toBe(`${GATEWAY}/invite/secret-token\n`)
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(text).toBe(`Invite for Sam (account acct-new), single use, expires 2026-10-28T00:00:00.000Z. The link is in ${out} (mode 0600).`)
  })

  it("refuses an existing --out file before signing in or minting an invite", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "desk-admin-")), "invite.url")
    writeFileSync(out, "old\n")
    const fetchImpl = invited()
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam", gateway: GATEWAY, trustGateway: true, out }, deps, signIn)

    expect(readFileSync(out, "utf8")).toBe("old\n")
    expect(text).toBe(`${out} already exists; choose a new file for the invite link`)
    expect(signIn).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(deps.exitCodes).toEqual([1])
  })

  it("refuses an --out file that cannot be created before signing in", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "desk-admin-")), "missing-dir", "invite.url")
    const deps = createDeps({ fetchImpl: invited() as unknown as typeof fetch })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam", gateway: GATEWAY, trustGateway: true, out }, deps, signIn)
    expect(text.startsWith(`Could not create ${out}: `)).toBe(true)
    expect(signIn).not.toHaveBeenCalled()
  })

  it("removes the claimed --out file when the invite is not issued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-admin-"))
    const cases: Array<{ name: string; fetchImpl: () => Promise<Response>; signIn?: () => Promise<string> }> = [
      { name: "signin", fetchImpl: async () => json(201, {}), signIn: async () => { throw new Error("cancelled") } },
      { name: "unreachable", fetchImpl: async () => { throw new TypeError("fetch failed") } },
      { name: "refused", fetchImpl: async () => json(403, {}) },
      { name: "malformed", fetchImpl: async () => json(201, { inviteUrl: 42 }) },
    ]
    for (const c of cases) {
      const out = join(dir, `${c.name}.url`)
      const deps = createDeps({ fetchImpl: vi.fn(c.fetchImpl) as unknown as typeof fetch })
      await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam", gateway: GATEWAY, trustGateway: true, out }, deps, c.signIn ?? signIn)
      expect(existsSync(out), c.name).toBe(false)
      expect(deps.exitCodes, c.name).toEqual([1])
    }
  })

  it("keeps the invite recoverable when --out cannot be written after the invite is issued", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "desk-admin-")), "invite.url")
    const deps = createDeps({ fetchImpl: invited() as unknown as typeof fetch })
    const lockingSignIn = vi.fn(async () => { chmodSync(out, 0o400); return "admin-access-token" })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam", gateway: GATEWAY, trustGateway: true, out }, deps, lockingSignIn)
    expect(text).toMatch(/^The invite for account acct-new was issued, but .* could not be written \(.*\)\. Issue a new link with: ouro desk invite --account acct-new$/)
    expect(text).not.toContain("secret-token")
    expect(existsSync(out)).toBe(false)
    expect(deps.exitCodes).toEqual([1])
  })

  it("refuses a re-invite whose response names another account", async () => {
    const deps = createDeps({ fetchImpl: invited() as unknown as typeof fetch })
    expect(await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", accountId: "acct-other", gateway: GATEWAY, trustGateway: true }, deps, signIn))
      .toBe("Hosted Desk sent an unexpected invite response")
  })

  it("refuses a malformed or non-JSON invite response", async () => {
    for (const response of [
      json(201, { accountId: "a", inviteUrl: 42, expiresAt: "x" }),
      json(201, { accountId: "a", inviteUrl: `${GATEWAY}/invite/x` }),
      json(201, { inviteUrl: `${GATEWAY}/invite/x`, expiresAt: "x" }),
      json(201, { accountId: "../a", inviteUrl: `${GATEWAY}/invite/x`, expiresAt: "x" }),
      new Response("created", { status: 201 }),
    ]) {
      const deps = createDeps({ fetchImpl: vi.fn(async () => response) as unknown as typeof fetch })
      expect(await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam", gateway: GATEWAY, trustGateway: true }, deps, signIn))
        .toBe("Hosted Desk sent an unexpected invite response")
    }
  })

  it("prints a normalized invite link and a sanitized expiry", async () => {
    const fetchImpl = vi.fn(async () => json(201, { accountId: "acct-new", inviteUrl: `${GATEWAY}/invite/abc`, expiresAt: "2026-10-28\u001b[2J" }))
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await executeDeskAdminCommand({ kind: "desk.admin", action: "invite", displayName: "Sam", gateway: GATEWAY, trustGateway: true }, deps, signIn))
      .toBe(`Invite for Sam (account acct-new), single use, expires 2026-10-28[2J.\n${GATEWAY}/invite/abc`)
  })

  it("turns access on and off and reports the state the gateway recorded", async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => accessIs(true))
      .mockImplementationOnce(async () => accessIs(false))
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const on = await executeDeskAdminCommand({ kind: "desk.admin", action: "access", accountId: "acct-1", on: true, gateway: GATEWAY, trustGateway: true }, deps, signIn)
    const off = await executeDeskAdminCommand({ kind: "desk.admin", action: "access", accountId: "acct-1", on: false, gateway: GATEWAY, trustGateway: true }, deps, signIn)

    expect(fetchImpl).toHaveBeenNthCalledWith(1, `${GATEWAY}/admin/accounts/acct-1/access`, expect.objectContaining({ method: "POST", body: JSON.stringify({ on: true }) }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, `${GATEWAY}/admin/accounts/acct-1/access`, expect.objectContaining({ method: "POST", body: JSON.stringify({ on: false }) }))
    expect(on).toBe("Desk access for acct-1 is now on.")
    expect(off).toBe("Desk access for acct-1 is now off.")
  })

  it("refuses an access or delete response it does not recognize", async () => {
    for (const [command, response, message] of [
      [{ kind: "desk.admin", action: "access", accountId: "acct-1", on: true }, json(200, { accountId: "acct-1" }), "Hosted Desk sent an unexpected access response"],
      [{ kind: "desk.admin", action: "access", accountId: "acct-1", on: true }, new Response(null, { status: 204 }), "Hosted Desk sent an unexpected access response"],
      [{ kind: "desk.admin", action: "delete-account", accountId: "acct-1" }, json(200, { accountId: "acct-1" }), "Hosted Desk sent an unexpected delete response"],
    ] as const) {
      const deps = createDeps({ fetchImpl: vi.fn(async () => response) as unknown as typeof fetch })
      expect(await executeDeskAdminCommand({ ...command, gateway: GATEWAY, trustGateway: true }, deps, signIn)).toBe(message)
      expect(deps.exitCodes).toEqual([1])
    }
  })

  it("says when a deleted account's desk could not be removed", async () => {
    const deps = createDeps({ fetchImpl: vi.fn(async () => deleted(false)) as unknown as typeof fetch })
    expect(await executeDeskAdminCommand({ kind: "desk.admin", action: "delete-account", accountId: "acct-1", gateway: GATEWAY, trustGateway: true }, deps, signIn))
      .toBe("Deleted account acct-1. Its desk could not be removed from the gateway; the gateway logged why.")
  })

  it("deletes an account with no body and no content-type", async () => {
    const fetchImpl = vi.fn(async () => deleted())
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "delete-account", accountId: "acct-1", gateway: GATEWAY, trustGateway: true }, deps, signIn)
    expect(fetchImpl).toHaveBeenCalledWith(`${GATEWAY}/admin/accounts/acct-1`, expect.objectContaining({ method: "DELETE" }))
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit
    expect(init).not.toHaveProperty("body")
    expect(init.headers).not.toHaveProperty("content-type")
    expect(text).toBe("Deleted account acct-1.")
  })

  it("explains a 401 as a refused sign-in and a 403 as a missing ouro.admin role, and records the status", async () => {
    for (const [status, pattern] of [[401, /did not accept the Ouro sign-in/], [403, /needs the ouro\.admin role/]] as const) {
      nervesEvents.length = 0
      const deps = createDeps({ fetchImpl: vi.fn(async () => json(status, { error: "unauthorized" })) as unknown as typeof fetch })
      const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "access", accountId: "acct-1", on: true, gateway: GATEWAY, trustGateway: true }, deps, signIn)
      expect(text).toMatch(pattern)
      expect(deps.exitCodes).toEqual([1])
      expect(nervesEvents.at(-1)).toMatchObject({ event: "daemon.desk_admin_error", meta: { status } })
    }
  })

  it("reports the gateway's own message for other refusals, sanitized", async () => {
    const run = async (response: Response) => executeDeskAdminCommand(
      { kind: "desk.admin", action: "delete-account", accountId: "acct-9", gateway: GATEWAY, trustGateway: true },
      createDeps({ fetchImpl: vi.fn(async () => response) as unknown as typeof fetch }),
      signIn,
    )
    expect(await run(json(404, { error: "not_found", message: "there is no account acct-9\u001b[0m" }))).toBe("Hosted Desk refused the request (404): there is no account acct-9[0m")
    expect(await run(json(409, { error: "conflict", message: "An admin can't delete their own account." }))).toBe("Hosted Desk refused the request (409): An admin can't delete their own account.")
    expect(await run(json(503, { error: "unavailable", message: "Ouro sign-in is starting up. Try again shortly." }))).toBe("Hosted Desk refused the request (503): Ouro sign-in is starting up. Try again shortly.")
    expect(await run(json(409, { error: "conflict" }))).toBe("Hosted Desk refused the request (409): conflict")
    expect(await run(new Response("<html>bad gateway</html>", { status: 502 }))).toBe("Hosted Desk refused the request (502).")
  })

  it("reports an unreachable gateway without a stack trace", async () => {
    const deps = createDeps({ fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed") }) as unknown as typeof fetch })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "access", accountId: "acct-1", on: true, gateway: GATEWAY, trustGateway: true }, deps, signIn)
    expect(text).toBe(`Could not reach Hosted Desk at ${GATEWAY}: fetch failed`)
    expect(deps.exitCodes).toEqual([1])
  })

  it("reports a failed sign-in and makes no admin call", async () => {
    const fetchImpl = vi.fn()
    const deps = createDeps({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const failing = vi.fn(async () => { throw new Error("Ouro sign-in was cancelled: access_denied") })
    const text = await executeDeskAdminCommand({ kind: "desk.admin", action: "access", accountId: "acct-1", on: true, gateway: GATEWAY, trustGateway: true }, deps, failing)
    expect(text).toBe("Ouro sign-in was cancelled: access_denied")
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(deps.exitCodes).toEqual([1])
  })

  it("routes through runOuroCli without touching the daemon", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href === `${GATEWAY}${ADMIN_CONFIG_PATH}`) return json(200, ADMIN_CONFIG)
      if (href === DISCOVERY_URL) return json(200, DISCOVERY)
      if (href === DISCOVERY.token_endpoint) return json(200, { access_token: "admin-access-token" })
      if (href === `${GATEWAY}/admin/accounts/acct-1/access`) return json(200, { accountId: "acct-1", deskAccess: false })
      throw new Error(`unexpected ${href}`)
    })
    const deps = createDeps({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      openUrl: async (url: string) => { await completeSignIn(url) },
    })
    const text = await runOuroCli(["desk", "access", "acct-1", "off", "--gateway", GATEWAY, "--trust-gateway"], deps)
    expect(text).toBe("Desk access for acct-1 is now off.")
    expect(deps.sendCommand).not.toHaveBeenCalled()
    expect(JSON.stringify(nervesEvents)).not.toContain("admin-access-token")
  })
})

// ── Loopback sign-in ──

describe("signInForDeskAdmin", () => {
  function fakeIdentity(overrides: { config?: unknown; discovery?: unknown; token?: () => Response } = {}) {
    const tokenRequests: URLSearchParams[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      if (href === `${GATEWAY}${ADMIN_CONFIG_PATH}`) return json(200, overrides.config ?? ADMIN_CONFIG)
      if (href === DISCOVERY_URL) return json(200, overrides.discovery ?? DISCOVERY)
      if (href === DISCOVERY.token_endpoint) {
        tokenRequests.push(new URLSearchParams(String(init?.body)))
        return overrides.token ? overrides.token() : json(200, { access_token: "admin-access-token", token_type: "Bearer" })
      }
      throw new Error(`unexpected ${href}`)
    })
    return { fetchImpl: fetchImpl as unknown as typeof fetch, tokenRequests }
  }

  it("signs in with PKCE on a loopback redirect and returns the access token", async () => {
    const { fetchImpl, tokenRequests } = fakeIdentity()
    const printed: string[] = []
    let callbackPage: Promise<string> | undefined
    let authorizeUrl: URL | undefined
    const token = await signInForDeskAdmin({
      gateway: GATEWAY,
      fetchImpl,
      writeStdout: (text) => { printed.push(text) },
      openUrl: async (url) => {
        authorizeUrl = new URL(url)
        callbackPage = completeSignIn(url).then((response) => response.text())
      },
    })

    expect(token).toBe("admin-access-token")
    expect(`${authorizeUrl!.origin}${authorizeUrl!.pathname}`).toBe(DISCOVERY.authorization_endpoint)
    const params = authorizeUrl!.searchParams
    expect(params.get("client_id")).toBe("cli-client-id")
    expect(params.get("response_type")).toBe("code")
    expect(params.get("scope")).toBe("api://gateway-app/desk.admin")
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(await callbackPage).toMatch(/Signed in/)
    expect(printed.join("\n")).toContain("manage desk-staging.example.test")
    expect(printed.join("\n")).toContain(DISCOVERY.authorization_endpoint)

    const exchange = tokenRequests[0]!
    expect(exchange.get("grant_type")).toBe("authorization_code")
    expect(exchange.get("code")).toBe("the-code")
    expect(exchange.get("client_id")).toBe("cli-client-id")
    expect(exchange.get("redirect_uri")).toBe(params.get("redirect_uri"))
    const challenge = createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")
    expect(challenge).toBe(params.get("code_challenge"))
  })

  it("accepts the expected tenant in any letter case, from either side", async () => {
    const { fetchImpl } = fakeIdentity()
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: async (url) => { await completeSignIn(url) }, expectedTenantId: TENANT.toUpperCase() }))
      .resolves.toBe("admin-access-token")
    const upper = fakeIdentity({ config: { ...ADMIN_CONFIG, tenantId: TENANT.toUpperCase() } })
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl: upper.fetchImpl, writeStdout: () => {}, openUrl: async (url) => { await completeSignIn(url) }, expectedTenantId: TENANT }))
      .resolves.toBe("admin-access-token")
  })

  it("refuses a gateway that names a tenant other than the expected one", async () => {
    const { fetchImpl } = fakeIdentity()
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: () => {}, expectedTenantId: PRODUCTION_TENANT_ID }))
      .rejects.toThrow(`names Ouro identity tenant ${TENANT}, not Ouro's production tenant ${PRODUCTION_TENANT_ID}`)
  })

  it("ignores other paths and stray requests with the wrong state, then accepts the real redirect", async () => {
    const { fetchImpl } = fakeIdentity()
    const token = await signInForDeskAdmin({
      gateway: GATEWAY,
      fetchImpl,
      writeStdout: () => {},
      openUrl: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!)
        expect((await fetch(`${redirect.origin}/favicon.ico`)).status).toBe(404)
        expect((await fetch(`${redirect.href}?code=forged&state=forged`)).status).toBe(400)
        expect((await fetch(`${redirect.href}?code=forged`)).status).toBe(400)
        await completeSignIn(url)
      },
    })
    expect(token).toBe("admin-access-token")
  })

  it("reports an error the identity provider returned", async () => {
    const { fetchImpl } = fakeIdentity()
    let page: Promise<string> | undefined
    await expect(signInForDeskAdmin({
      gateway: GATEWAY,
      fetchImpl,
      writeStdout: () => {},
      openUrl: (url) => { page = completeSignIn(url, "error=access_denied").then((response) => response.text()) },
    })).rejects.toThrow("Ouro sign-in was cancelled: access_denied")
    expect(await page).toMatch(/did not finish/)
  })

  it("refuses a callback with no code", async () => {
    const { fetchImpl } = fakeIdentity()
    await expect(signInForDeskAdmin({
      gateway: GATEWAY,
      fetchImpl,
      writeStdout: () => {},
      openUrl: async (url) => { await completeSignIn(url, "x=1") },
    })).rejects.toThrow(/returned no code/)
  })

  it("times out when the browser never returns", async () => {
    const { fetchImpl } = fakeIdentity()
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: () => {}, timeoutMs: 50 }))
      .rejects.toThrow(/timed out/)
  })

  it("times out cleanly while the browser opener is still running", async () => {
    const { fetchImpl } = fakeIdentity()
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: () => new Promise<void>(() => {}), timeoutMs: 50 }))
      .rejects.toThrow(/timed out/)
  })

  it("still waits for the callback when the browser cannot be opened", async () => {
    const { fetchImpl } = fakeIdentity()
    let authorize = ""
    const pending = signInForDeskAdmin({
      gateway: GATEWAY,
      fetchImpl,
      writeStdout: (text) => {
        const match = /(https:\/\/\S+authorize\S*)/.exec(text)
        if (match) authorize = match[1]!
      },
      openUrl: () => { throw new Error("no browser") },
    })
    await vi.waitFor(() => expect(authorize).not.toBe(""))
    await completeSignIn(authorize)
    await expect(pending).resolves.toBe("admin-access-token")
  })

  it("refuses a malformed admin sign-in configuration", async () => {
    for (const config of [
      null,
      { ...ADMIN_CONFIG, tenantId: "not-a-guid" },
      { ...ADMIN_CONFIG, subdomain: "evil.test/x" },
      { ...ADMIN_CONFIG, clientId: "" },
      { ...ADMIN_CONFIG, scope: 7 },
    ]) {
      const fetchImpl = vi.fn(async () => json(200, config)) as unknown as typeof fetch
      await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: () => {} }))
        .rejects.toThrow(/admin sign-in configuration/)
    }
  })

  it("refuses a discovery document that names another issuer, sanitized", async () => {
    const { fetchImpl } = fakeIdentity({ discovery: { ...DISCOVERY, issuer: "https://evil.test/v2.0\u001b[2J" } })
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: () => {} }))
      .rejects.toThrow(`names issuer https://evil.test/v2.0[2J, but Hosted Desk expects ${DISCOVERY.issuer}`)
  })

  it("refuses a discovery document without https endpoints", async () => {
    const { fetchImpl } = fakeIdentity({ discovery: { ...DISCOVERY, token_endpoint: "http://tenant.test/token" } })
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: () => {} }))
      .rejects.toThrow(/discovery document has no https/)
    const missing = fakeIdentity({ discovery: { ...DISCOVERY, authorization_endpoint: undefined } })
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl: missing.fetchImpl, writeStdout: () => {}, openUrl: () => {} }))
      .rejects.toThrow(/discovery document has no https/)
  })

  it("reports a gateway that does not serve the admin configuration", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    await expect(signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: () => {} }))
      .rejects.toThrow(`${GATEWAY}${ADMIN_CONFIG_PATH} answered 404`)
  })

  it("reports a refused token exchange", async () => {
    const run = (token: () => Response) => {
      const { fetchImpl } = fakeIdentity({ token })
      return signInForDeskAdmin({ gateway: GATEWAY, fetchImpl, writeStdout: () => {}, openUrl: async (url) => { await completeSignIn(url) } })
    }
    await expect(run(() => json(400, { error: "invalid_grant", error_description: "AADSTS70008: expired" }))).rejects.toThrow("Ouro sign-in could not finish: invalid_grant")
    await expect(run(() => new Response("upstream down", { status: 503 }))).rejects.toThrow("Ouro sign-in could not finish: token endpoint answered 503")
    await expect(run(() => json(200, { token_type: "Bearer" }))).rejects.toThrow("Ouro sign-in could not finish: no access token")
  })
})
