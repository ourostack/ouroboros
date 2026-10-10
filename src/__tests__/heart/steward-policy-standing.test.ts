import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { inspectStandingActionGrant, readStewardPolicy, updateStewardPolicy, type StewardPolicyMutation } from "../../heart/steward-policy"

const roots: string[] = []
const ari = {
  friendId: "ari", trustLevel: "family" as const, sessionEventId: "evt-ari-1",
  authorization: { profileId: "sanctuary-owner", profileVersion: 7, requestId: "request-ari-1", sessionKey: "cli_owner", receiptId: "auth-ari-1" },
}
const NOW = "2026-10-10T20:00:00.000Z"

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "standing-grant-"))
  roots.push(value)
  return value
}

function grant(agentRoot: string, overrides: Partial<Extract<StewardPolicyMutation, { kind: "grant_routine_action" }>> = {}, sessionEventId = "evt-grant"): void {
  updateStewardPolicy(agentRoot, {
    expectedVersion: readStewardPolicy(agentRoot).version,
    actor: { ...ari, sessionEventId },
    now: "2026-10-10T10:00:00.000Z",
    mutation: { kind: "grant_routine_action", key: "cmux-feed-once", action: "cmux.feed.once", targets: ["/repo"], maxCount: 3, windowMs: 3_600_000, verificationRequired: true, exclusions: ["/repo/excluded"], provenance: "stated", ...overrides },
  })
}

const inspect = (agentRoot: string, overrides: Partial<Parameters<typeof inspectStandingActionGrant>[1]> = {}) => inspectStandingActionGrant(agentRoot, {
  key: "cmux-feed-once", action: "cmux.feed.once", target: "/repo", usesInWindow: () => 0, now: NOW, ...overrides,
})

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("standing action grants", () => {
  it("allows only an applied, owner-stated, unexpired grant for the exact action and target under its count cap", () => {
    const agentRoot = root()
    expect(inspect(agentRoot)).toEqual({ allowed: false, reason: "standing grant is missing" })
    grant(agentRoot)
    expect(inspect(agentRoot)).toEqual({ allowed: true, grantVersion: 1, maxCount: 3, windowMs: 3_600_000 })
    let asked = 0
    expect(inspect(agentRoot, { usesInWindow: (windowMs) => { asked = windowMs; return 3 } })).toEqual({ allowed: false, reason: "standing grant count cap reached" })
    expect(asked).toBe(3_600_000)
    expect(inspect(agentRoot, { action: "cmux.feed.always" })).toEqual({ allowed: false, reason: "action does not match the standing grant" })
    expect(inspect(agentRoot, { target: "/other" })).toEqual({ allowed: false, reason: "target is not covered by the standing grant" })
    expect(inspect(agentRoot, { target: "/repo/excluded" })).toEqual({ allowed: false, reason: "target is not covered by the standing grant" })
    expect(inspectStandingActionGrant(agentRoot, { key: "cmux-feed-once", action: "cmux.feed.once", target: "/repo", usesInWindow: () => 0 }).allowed).toBe(true)
  })

  it("refuses expired and installed-policy grants", () => {
    const expired = root()
    grant(expired, { expiresAt: "2026-10-10T12:00:00.000Z" })
    expect(inspect(expired)).toEqual({ allowed: false, reason: "standing grant expired" })
    const installed = root()
    grant(installed, { provenance: "installed_explicit_policy" })
    expect(inspect(installed)).toEqual({ allowed: false, reason: "standing grant must be owner-stated" })
  })

  it("refuses a grant whose policy record no longer matches its audited authorization", () => {
    const agentRoot = root()
    grant(agentRoot)
    const policyFile = fs.readdirSync(agentRoot, { recursive: true }).map(String).find((entry) => entry.endsWith("steward.json"))!
    const full = path.join(agentRoot, policyFile)
    const policy = JSON.parse(fs.readFileSync(full, "utf-8"))
    policy.routineActionGrants["cmux-feed-once"].targets.push("/elsewhere")
    fs.writeFileSync(full, JSON.stringify(policy, null, 2))
    expect(inspect(agentRoot, { target: "/elsewhere" }).allowed).toBe(false)
  })
})
