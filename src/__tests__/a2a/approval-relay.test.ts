import { createHmac } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { operatorTrustDir } from "../../a2a/operator-trust"
import { overrideOwnerForTests } from "../../a2a/trusted-files"
import {
  APPROVAL_RELAY_FILE, approvalRelayToken, checkRelayedDecision, readApprovalRelaySwitch, relayTokensEqual,
} from "../../a2a/approval-relay"

let tmp: TmpBundleHandle | null = null
afterEach(() => { tmp?.cleanup(); tmp = null; overrideOwnerForTests(undefined) })
const root = () => { tmp = createTmpBundle({ agentName: `relay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }); return tmp.agentRoot }

const NOW = new Date("2026-11-23T02:00:00.000Z")
const ROUTE = "did:key:z6MkSyntheticSluggerRoute"
const APPROVAL = "11111111-1111-4111-8111-111111111111"
const KEY = "k".repeat(43)

describe("approvalRelayToken", () => {
  it("is an HMAC keyed by the decision token over a domain-separated approval id and route DID", () => {
    const token = approvalRelayToken({ decisionToken: KEY, approvalId: APPROVAL, routeDid: ROUTE })
    const expected = createHmac("sha256", KEY).update(`ouro.approval-relay.v1\0${APPROVAL}\0${ROUTE}`).digest("base64url")
    expect(token).toBe(expected)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("takes a key of 32 characters or more", () => {
    expect(approvalRelayToken({ decisionToken: "k".repeat(32), approvalId: APPROVAL, routeDid: ROUTE })).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("changes with the route DID, so a rotated route can't use an outstanding token", () => {
    const a = approvalRelayToken({ decisionToken: KEY, approvalId: APPROVAL, routeDid: ROUTE })
    const b = approvalRelayToken({ decisionToken: KEY, approvalId: APPROVAL, routeDid: `${ROUTE}2` })
    expect(a).not.toBe(b)
  })

  it.each([
    [{ decisionToken: "", approvalId: APPROVAL, routeDid: ROUTE }],
    [{ decisionToken: undefined, approvalId: APPROVAL, routeDid: ROUTE }],
    [{ decisionToken: "k", approvalId: APPROVAL, routeDid: ROUTE }],
    [{ decisionToken: "k".repeat(31), approvalId: APPROVAL, routeDid: ROUTE }],
    [{ decisionToken: KEY, approvalId: "", routeDid: ROUTE }],
    [{ decisionToken: KEY, approvalId: `${APPROVAL}\0x`, routeDid: ROUTE }],
    [{ decisionToken: KEY, approvalId: APPROVAL, routeDid: "" }],
    [{ decisionToken: KEY, approvalId: APPROVAL, routeDid: `${ROUTE}\0` }],
  ])("refuses to compute one from %j, never with an empty key", (input) => {
    expect(() => approvalRelayToken(input as never)).toThrow(/approval relay token/)
  })
})

describe("relayTokensEqual", () => {
  it("matches only an identical token", () => {
    const token = approvalRelayToken({ decisionToken: KEY, approvalId: APPROVAL, routeDid: ROUTE })
    expect(relayTokensEqual(token, token)).toBe(true)
    expect(relayTokensEqual(token, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBe(false)
    expect(relayTokensEqual(token, token.slice(1))).toBe(false)
    expect(relayTokensEqual("", "")).toBe(false)
    expect(relayTokensEqual(token, 7 as never)).toBe(false)
  })
})

describe("checkRelayedDecision", () => {
  it("lets deny through and refuses approve in v1, and anything else as unknown", () => {
    expect(checkRelayedDecision("deny")).toEqual({ ok: true, decision: "deny" })
    expect(checkRelayedDecision("approve")).toEqual({ ok: false, reason: "approve_not_in_v1" })
    for (const other of ["allow", "", null, undefined, 1]) expect(checkRelayedDecision(other)).toEqual({ ok: false, reason: "unknown_decision" })
  })
})

describe("readApprovalRelaySwitch", () => {
  const write = (agentRoot: string, body: unknown) => {
    const dir = operatorTrustDir(agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const file = path.join(dir, APPROVAL_RELAY_FILE)
    fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o644 })
    return file
  }
  const good = { schemaVersion: 1, did: ROUTE, expiresAt: "2026-12-01T00:00:00.000Z", approveTools: [], source: "Ari, 2026-11-23: deny-only relay" }

  it("is off when the file is missing", () => {
    expect(readApprovalRelaySwitch(root(), NOW)).toEqual({ on: false, reason: "missing" })
  })

  it("is on for a valid, unexpired file in the trust folder", () => {
    const agentRoot = root()
    write(agentRoot, good)
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toEqual({ on: true, did: ROUTE, expiresAt: good.expiresAt, source: good.source })
  })

  it("is off once it expires", () => {
    const agentRoot = root()
    write(agentRoot, good)
    expect(readApprovalRelaySwitch(agentRoot, new Date(good.expiresAt))).toEqual({ on: false, reason: "expired" })
  })

  it("is off for a file it can't trust, including one that isn't JSON", () => {
    const agentRoot = root()
    const file = write(agentRoot, good)
    fs.chmodSync(file, 0o666)
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toMatchObject({ on: false, reason: "untrusted" })
    fs.chmodSync(file, 0o644)
    fs.writeFileSync(file, "not json")
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toEqual({ on: false, reason: "untrusted", detail: "file is not valid JSON" })
  })

  it.each([
    [null], [[]],
    [{ ...good, schemaVersion: 2 }], [{ ...good, did: "z6Mk" }], [{ ...good, did: `did:key:${"x".repeat(600)}` }],
    [{ ...good, expiresAt: "2026-12-01" }], [{ ...good, approveTools: "none" }], [{ ...good, approveTools: [5] }],
    [{ ...good, source: " " }], [{ ...good, extra: true }],
  ])("is off for a malformed file %j", (body) => {
    const agentRoot = root()
    write(agentRoot, body)
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toEqual({ on: false, reason: "malformed" })
  })

  it("never hands out the approve list, so a listed tool can't widen v1 past deny", () => {
    const agentRoot = root()
    write(agentRoot, { ...good, approveTools: ["unraid_restart_container"] })
    const view = readApprovalRelaySwitch(agentRoot, NOW)
    expect(view).toEqual({ on: true, did: ROUTE, expiresAt: good.expiresAt, source: good.source })
    expect(Object.hasOwn(view, "approveTools")).toBe(false)
  })

  it("is off when the trust folder or file has the wrong owner, the folder is group-writable, or the file is a link", () => {
    const agentRoot = root()
    const file = write(agentRoot, good)
    const dir = path.dirname(file)
    expect(readApprovalRelaySwitch(agentRoot, NOW).on).toBe(true)
    overrideOwnerForTests((target) => (target === dir ? 12345 : undefined))
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toMatchObject({ on: false, reason: "untrusted" })
    overrideOwnerForTests((target) => (target === file ? 12345 : undefined))
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toMatchObject({ on: false, reason: "untrusted" })
    overrideOwnerForTests(undefined)
    fs.chmodSync(dir, 0o775)
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toMatchObject({ on: false, reason: "untrusted" })
    fs.chmodSync(dir, 0o755)
    const real = path.join(dir, "real.json")
    fs.renameSync(file, real)
    fs.symlinkSync(real, file)
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toMatchObject({ on: false, reason: "untrusted" })
    fs.rmSync(file)
    fs.writeFileSync(file, JSON.stringify({ ...good, expiresAt: "2026-12-01T00:00:00.000+00:00" }), { mode: 0o644 })
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toEqual({ on: false, reason: "malformed" })
  })

  it("ignores a copy under the bundle's state folder", () => {
    const agentRoot = root()
    fs.mkdirSync(path.join(agentRoot, "state", "a2a"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "state", "a2a", APPROVAL_RELAY_FILE), JSON.stringify(good))
    fs.writeFileSync(path.join(agentRoot, "state", APPROVAL_RELAY_FILE), JSON.stringify(good))
    expect(readApprovalRelaySwitch(agentRoot, NOW)).toEqual({ on: false, reason: "missing" })
  })
})
