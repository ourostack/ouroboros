import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  inspectRoutineActionGrant,
  readRoutineActionReceipts,
  recoverRoutineActionReceipts,
  transitionRoutineActionReceipt,
  consumeRoutineActionGrant,
  readStewardPolicy,
  updateStewardPolicy,
  type StewardPolicyMutation,
  type StewardPolicyRecord,
} from "../../heart/steward-policy"
import { acquireSessionTurnLease } from "../../mind/session-transaction"
import { resolveToolDefinition } from "../../repertoire/tools"
import { stewardPolicyToolDefinition } from "../../repertoire/tools-steward-policy"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual, openSync: vi.fn(actual.openSync), renameSync: vi.fn(actual.renameSync),
    readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync), fsyncSync: vi.fn(actual.fsyncSync),
  }
})

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "steward-policy-"))
  roots.push(value)
  return value
}

const ari = {
  friendId: "ari", trustLevel: "family" as const, sessionEventId: "evt-ari-1",
  authorization: { profileId: "sanctuary-owner", profileVersion: 7, requestId: "request-ari-1", sessionKey: "telegram_owner", receiptId: "auth-ari-1" },
}

afterEach(async () => {
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  vi.mocked(fs.openSync).mockImplementation(actual.openSync)
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
  vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync)
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync)
  vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync)
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("steward policy", () => {
  it("covers the direct tool contract, validation boundaries, and risk profiles", async () => {
    const agentRoot = root()
    const relationshipAuthorization = { profileId: "sanctuary-owner", requestId: "request-ari-1", authorizedContextScopes: [], advertisedToolNames: [], authorizeTool: () => ({ allowed: true as const, receiptId: "auth", profileVersion: 7 }), actor: ari }
    const context = { signin: async () => undefined, agentRoot, currentSession: { friendId: "ari", channel: "telegram", key: "telegram_owner" }, relationshipAuthorization }
    expect(() => stewardPolicyToolDefinition.handler({ action: "read" }, undefined)).toThrow("runtime")
    expect(() => stewardPolicyToolDefinition.handler({ action: "read" }, { signin: async () => undefined, agentRoot } as any)).toThrow("relationship")
    expect(stewardPolicyToolDefinition.handler({ action: "read" }, context as any)).toContain('"version":0')
    expect(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 0 }, { ...context, relationshipAuthorization: { ...relationshipAuthorization, actor: undefined } } as any)).toThrow("mutation requires")
    expect(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: "bad" }, context as any)).toThrow("nonnegative")
    expect(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 0, provenance: "bogus" }, context as any)).toThrow("provenance")
    await expect(stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 0, provenance: "stated" }, context as any)).rejects.toThrow("key must be nonempty")
    expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "observed" }, context as any)).toThrow("provenance")
    expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "stated" }, context as any)).toThrow("targetsJson is required")
    expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "stated", targetsJson: "{}" }, context as any)).toThrow("JSON string array")
    expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "stated", targetsJson: '["books",1]' }, context as any)).toThrow("JSON string array")
    expect(() => stewardPolicyToolDefinition.handler({ action: "unknown", expectedVersion: 0 }, context as any)).toThrow("action is invalid")
    expect(stewardPolicyToolDefinition.riskProfile!({ action: "read" } as any)).toMatchObject({ risk: "low" })
    expect(stewardPolicyToolDefinition.riskProfile!({ action: "set_desired_state" } as any)).toMatchObject({ risk: "high" })
    const granted = await stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 0, provenance: "stated", key: "restart", routineAction: "unraid.container.restart", targetsJson: '["books"]', exclusionsJson: "[]", maxCount: 1, windowMs: 1000, verificationRequired: true, expiresAt: "2099-01-01T00:00:00.000Z" }, context as any)
    expect(granted).toContain('"restart"')
    const desired = await stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 1, provenance: "default", key: "container:music", value: "on", source: "default" }, context as any)
    expect(desired).toContain("container:music")
    const inferredCurrentVersion = await stewardPolicyToolDefinition.handler({ action: "set_desired_state", provenance: "stated", key: "container:books", value: "intentionally_off", source: "direct family request" }, context as any)
    expect(inferredCurrentVersion).toContain('"version":3')
    const expiring = await stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 3, provenance: "stated", key: "container:video", value: "on", source: "request", expiresAt: "2099-01-02T00:00:00.000Z" }, context as any)
    expect(expiring).toContain("2099-01-02")
    const secondGrant = await stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 4, provenance: "installed_explicit_policy", key: "restart-video", routineAction: "restart", targetsJson: '["video"]', exclusionsJson: "[]", maxCount: 1, windowMs: 1000, verificationRequired: true }, context as any)
    expect(secondGrant).toContain("restart-video")
    for (const verificationRequired of [false, undefined, "true", 1] as const) {
      expect(() => stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 5, provenance: "stated", key: "bad", routineAction: "restart", targetsJson: '["video"]', exclusionsJson: "[]", maxCount: 1, windowMs: 1000, verificationRequired } as any, context as any)).toThrow("verificationRequired must be true")
    }
    await expect(stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 5, provenance: "stated", routineAction: "restart", targetsJson: '["video"]', exclusionsJson: "[]", maxCount: 1, windowMs: 1000, verificationRequired: true }, context as any)).rejects.toThrow("key must be nonempty")
    await expect(stewardPolicyToolDefinition.handler({ action: "grant_routine_action", expectedVersion: 5, provenance: "stated", key: "bad", targetsJson: '["video"]', exclusionsJson: "[]", maxCount: 1, windowMs: 1000, verificationRequired: true }, context as any)).rejects.toThrow("action must be nonempty")
    await expect(stewardPolicyToolDefinition.handler({ action: "set_desired_state", expectedVersion: 4, provenance: "stated", key: "container:books", value: "on", source: "stale write" }, { ...context, relationshipAuthorization: { ...relationshipAuthorization, actor: { ...ari, sessionEventId: "evt-stale" } } } as any)).rejects.toThrow("version changed")
    expect(readStewardPolicy(agentRoot).version).toBe(5)
  })

  describe("A-006 applied policy audit", () => {
    const now = "2026-09-08T00:00:00.000Z"
    const owner = {
      ...ari,
      authorization: {
        profileId: "sanctuary-owner",
        profileVersion: 3,
        requestId: "request-ari-1",
        sessionKey: "telegram_owner",
        receiptId: "relationship-ari-1",
      },
    }
    const desired: StewardPolicyMutation = { kind: "set_desired_state", key: "container:jellyfin", value: "on", provenance: "stated", source: "current owner request" }
    const grant: StewardPolicyMutation = { kind: "grant_routine_action", key: "unraid.restart:jellyfin", action: "unraid.container.restart", targets: ["jellyfin"], maxCount: 2, windowMs: 1_800_000, verificationRequired: true, exclusions: [], provenance: "stated", expiresAt: "2027-09-08T00:00:00.000Z" }
    const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex")
    const paths = (agentRoot: string) => ({
      policy: path.join(agentRoot, "state", "policy", "steward.json"),
      audit: path.join(agentRoot, "state", "policy", "policy-audit.ndjson"),
    })
    const apply = (agentRoot: string, mutation: StewardPolicyMutation, expectedVersion = readStewardPolicy(agentRoot).version, actor = owner) =>
      updateStewardPolicy(agentRoot, { expectedVersion, actor, mutation, now })
    type AuditRow = {
      schemaVersion: number
      transactionId: string
      precedingBytesSha256: string
      mutationKind: StewardPolicyMutation["kind"]
      key: string
      mutationFingerprint: string
      affectedKeyResult: unknown
      affectedKeyResultSha256: string
      issuer: string
      authorizingSessionEvent: string
      authorization: typeof owner.authorization
      preimage: string
      preimageVersion: number
      preimageSha256: string
      postimage: string
      postimageVersion: number
      postimageSha256: string
      at: string
    }
    const auditRows = (agentRoot: string): AuditRow[] => fs.readFileSync(paths(agentRoot).audit, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))
    const saveRows = (agentRoot: string, rows: AuditRow[]) => fs.writeFileSync(paths(agentRoot).audit, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
    const sealIdentity = (row: AuditRow) => {
      const identity = JSON.stringify([row.issuer, row.authorizingSessionEvent, row.authorization.requestId, row.mutationKind, row.key])
      row.transactionId = digest(JSON.stringify([identity, row.mutationFingerprint]))
    }

    it("does not publish a grant when opening the write-ahead audit fails", () => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const original = vi.mocked(fs.openSync).getMockImplementation()!
      const open = vi.mocked(fs.openSync).mockImplementation((file, flags, mode) => {
        if (String(file) === files.audit) throw new Error("audit unavailable")
        return original(file, flags, mode)
      })
      expect(() => apply(agentRoot, grant, 0)).toThrow("audit unavailable")
      expect(open).toHaveBeenCalledWith(files.audit, "a", 0o600)
      expect(fs.existsSync(files.policy)).toBe(false)
    })

    it("durably records the exact authorization and byte pre/post images before policy publication", () => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const original = vi.mocked(fs.renameSync).getMockImplementation()!
      let observed = false
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) === files.policy) {
          expect(fs.existsSync(files.audit)).toBe(true)
          expect(fs.readFileSync(files.audit, "utf8").endsWith("\n")).toBe(true)
          expect(auditRows(agentRoot)[0]).toMatchObject({ schemaVersion: 2, preimage: "", preimageVersion: 0, postimageVersion: 1 })
          observed = true
        }
        return original(from, to)
      })
      const result = apply(agentRoot, desired, 0)
      const row = auditRows(agentRoot)[0]!
      expect(observed).toBe(true)
      expect(row).toEqual({
        schemaVersion: 2,
        transactionId: expect.stringMatching(/^[a-f0-9]{64}$/u),
        precedingBytesSha256: digest(""),
        mutationKind: "set_desired_state",
        key: desired.key,
        mutationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        affectedKeyResult: result.desiredStates[desired.key],
        affectedKeyResultSha256: digest(JSON.stringify(result.desiredStates[desired.key])),
        issuer: "ari",
        authorizingSessionEvent: owner.sessionEventId,
        authorization: owner.authorization,
        preimage: "",
        preimageVersion: 0,
        preimageSha256: digest(""),
        postimage: fs.readFileSync(files.policy, "utf8"),
        postimageVersion: 1,
        postimageSha256: digest(fs.readFileSync(files.policy, "utf8")),
        at: now,
      })
      expect(fs.statSync(files.audit).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(files.audit)).mode & 0o777).toBe(0o700)
    })

    it.each(["before-rename", "after-rename"])("recovers exact %s interruption without a second authorization row", (fault) => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const original = vi.mocked(fs.renameSync).getMockImplementation()!
      const rename = vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) !== files.policy) return original(from, to)
        if (fault === "after-rename") original(from, to)
        throw new Error(fault)
      })
      expect(() => apply(agentRoot, desired, 0)).toThrow(fault)
      rename.mockImplementation(original)
      expect(fs.existsSync(files.audit)).toBe(true)
      const before = fs.readFileSync(files.audit, "utf8")
      expect(auditRows(agentRoot)).toHaveLength(1)
      expect(auditRows(agentRoot)[0]!.schemaVersion).toBe(2)
      const recovered = readStewardPolicy(agentRoot)
      expect(recovered).toMatchObject({ version: 1, desiredStates: { "container:jellyfin": { value: "on", version: 1 } } })
      expect(apply(agentRoot, desired, 0)).toEqual(recovered)
      expect(fs.readFileSync(files.audit, "utf8")).toBe(before)
      expect(fs.readFileSync(files.policy, "utf8")).toBe(auditRows(agentRoot)[0]!.postimage)
    })

    it("rejects nominally successful publication when actual policy bytes differ", () => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const original = vi.mocked(fs.renameSync).getMockImplementation()!
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        original(from, to)
        if (String(to) === files.policy) fs.appendFileSync(files.policy, "\n")
      })
      expect(() => apply(agentRoot, desired, 0)).toThrow(/readback/u)
      expect(auditRows(agentRoot)).toHaveLength(1)
      expect(fs.readFileSync(files.policy, "utf8")).toBe(auditRows(agentRoot)[0]!.postimage + "\n")
      expect(() => readStewardPolicy(agentRoot)).toThrow(/audit.*head/u)
    })

    it("resyncs the pending audit's parent directory before recovery publishes policy", () => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const directory = path.dirname(files.audit)
      const opened = new Map<number, string>()
      const open = vi.mocked(fs.openSync).getMockImplementation()!
      const sync = vi.mocked(fs.fsyncSync).getMockImplementation()!
      const rename = vi.mocked(fs.renameSync).getMockImplementation()!
      let firstDirectorySync = true
      let directorySynced = false
      let auditSynced = false
      vi.mocked(fs.openSync).mockImplementation((file, flags, mode) => {
        const fd = open(file, flags, mode)
        opened.set(fd, String(file))
        return fd
      })
      vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
        if (opened.get(fd) === directory && firstDirectorySync) {
          firstDirectorySync = false
          throw new Error("audit directory sync interrupted")
        }
        sync(fd)
        if (opened.get(fd) === directory) directorySynced = true
        if (opened.get(fd) === files.audit) auditSynced = true
      })
      expect(() => apply(agentRoot, desired, 0)).toThrow("audit directory sync interrupted")
      expect(fs.existsSync(files.policy)).toBe(false)
      const auditBefore = fs.readFileSync(files.audit, "utf8")
      auditSynced = false
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) === files.policy) {
          expect(auditSynced).toBe(true)
          expect(directorySynced).toBe(true)
        }
        rename(from, to)
      })
      expect(readStewardPolicy(agentRoot)).toMatchObject({ version: 1 })
      expect(fs.readFileSync(files.audit, "utf8")).toBe(auditBefore)
    })

    it.each(["fsync", "partial-write"])("fails closed on audit %s without publishing a new policy", (fault) => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const open = vi.mocked(fs.openSync).getMockImplementation()!
      const write = vi.mocked(fs.writeFileSync).getMockImplementation()!
      const sync = vi.mocked(fs.fsyncSync).getMockImplementation()!
      const failure = new Error(`audit ${fault} failed`)
      let auditFd = -1
      vi.mocked(fs.openSync).mockImplementation((file, flags, mode) => {
        const fd = open(file, flags, mode)
        if (String(file) === files.audit && flags === "a") auditFd = fd
        return fd
      })
      vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
        if (file === auditFd && fault === "partial-write") {
          write(file, String(data).slice(0, 32), options)
          throw failure
        }
        write(file, data, options)
      })
      vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
        if (fd === auditFd && fault === "fsync") throw failure
        sync(fd)
      })
      expect(() => apply(agentRoot, desired, 0)).toThrow(failure)
      expect(fs.existsSync(files.policy)).toBe(false)
      const auditBefore = fs.readFileSync(files.audit, "utf8")
      vi.mocked(fs.writeFileSync).mockImplementation(write)
      vi.mocked(fs.fsyncSync).mockImplementation(sync)
      if (fault === "partial-write") {
        expect(() => readStewardPolicy(agentRoot)).toThrow(/partial final row/u)
        expect(() => apply(agentRoot, desired, 0)).toThrow(/partial final row/u)
        expect(fs.existsSync(files.policy)).toBe(false)
      } else {
        expect(readStewardPolicy(agentRoot)).toMatchObject({ version: 1 })
      }
      expect(fs.readFileSync(files.audit, "utf8")).toBe(auditBefore)
    })

    it("rejects changed recovery readback instead of reporting a recovered grant", () => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const rename = vi.mocked(fs.renameSync).getMockImplementation()!
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) === files.policy) throw new Error("before publication")
        rename(from, to)
      })
      expect(() => apply(agentRoot, grant, 0)).toThrow("before publication")
      const auditBefore = fs.readFileSync(files.audit, "utf8")
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        rename(from, to)
        if (String(to) === files.policy) fs.appendFileSync(files.policy, "\n")
      })
      expect(() => readStewardPolicy(agentRoot)).toThrow(/recovery readback/u)
      expect(fs.readFileSync(files.audit, "utf8")).toBe(auditBefore)
      expect(inspectRoutineActionGrant(agentRoot, { key: grant.key, action: grant.action, target: "jellyfin", now }).allowed).toBe(false)
    })

    it("propagates an audit read dependency failure without replacing policy", () => {
      const agentRoot = root()
      apply(agentRoot, desired, 0)
      const files = paths(agentRoot)
      const before = fs.readFileSync(files.policy, "utf8")
      const read = vi.mocked(fs.readFileSync).getMockImplementation()!
      const failure = new Error("audit read unavailable")
      vi.mocked(fs.readFileSync).mockImplementation((file, options) => {
        if (String(file) === files.audit) throw failure
        return read(file, options)
      })
      expect(() => readStewardPolicy(agentRoot)).toThrow(failure)
      expect(() => apply(agentRoot, grant, 1)).toThrow(failure)
      expect(fs.readFileSync(files.policy, "utf8")).toBe(before)
    })

    it.each(["bad-json", "null-image", "large-image", "large-policy", "large-row", "invalid-utf8"])("rejects %s before authority can escape its byte bounds", (fault) => {
      const agentRoot = root()
      const files = paths(agentRoot)
      apply(agentRoot, desired, 0)
      const rows = auditRows(agentRoot)
      if (fault === "bad-json") rows[0]!.postimage = "{"
      if (fault === "null-image") rows[0]!.postimage = "null"
      if (fault === "large-image") rows[0]!.postimage = " ".repeat(1024 * 1024 + 1)
      saveRows(agentRoot, rows)
      if (fault === "large-policy") fs.appendFileSync(files.policy, " ".repeat(1024 * 1024))
      if (fault === "large-row") fs.writeFileSync(files.audit, " ".repeat(16 * 1024 * 1024 + 1) + "\n")
      if (fault === "invalid-utf8") fs.writeFileSync(files.audit, Buffer.from([0xff, 0x0a]))
      const before = fs.readFileSync(files.policy, "utf8")
      expect(() => readStewardPolicy(agentRoot)).toThrow(/invalid|bound/u)
      expect(() => apply(agentRoot, grant, 1)).toThrow(/invalid|bound/u)
      expect(fs.readFileSync(files.policy, "utf8")).toBe(before)
    })

    it.each(["stored-v2", "legacy-prefix", "publication", "recovery"])("rejects invalid policy UTF-8 at %s even when decoded JSON matches the authorized image", (stage) => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const utf8Grant = { ...grant, exclusions: ["other-\ufffd"] }
      const rename = vi.mocked(fs.renameSync).getMockImplementation()!
      const corruptPolicyBytes = () => {
        const bytes = fs.readFileSync(files.policy)
        const replacement = Buffer.from("\ufffd")
        const offset = bytes.indexOf(replacement)
        expect(offset).toBeGreaterThanOrEqual(0)
        fs.writeFileSync(files.policy, Buffer.concat([bytes.subarray(0, offset), Buffer.from([0xff]), bytes.subarray(offset + replacement.length)]))
      }
      if (stage === "stored-v2" || stage === "legacy-prefix") {
        apply(agentRoot, utf8Grant, 0)
        if (stage === "legacy-prefix") fs.writeFileSync(files.audit, JSON.stringify({ schemaVersion: 1, policyVersion: 1 }) + "\n")
        corruptPolicyBytes()
      } else {
        if (stage === "recovery") {
          vi.mocked(fs.renameSync).mockImplementation((from, to) => {
            if (String(to) === files.policy) throw new Error("before publication")
            rename(from, to)
          })
          expect(() => apply(agentRoot, utf8Grant, 0)).toThrow("before publication")
        }
        vi.mocked(fs.renameSync).mockImplementation((from, to) => {
          rename(from, to)
          if (String(to) === files.policy) corruptPolicyBytes()
        })
        if (stage === "publication") expect(() => apply(agentRoot, utf8Grant, 0)).toThrow(/encoding/u)
      }
      expect(() => readStewardPolicy(agentRoot)).toThrow(/encoding/u)
      const before = fs.readFileSync(files.policy)
      const auditBefore = fs.readFileSync(files.audit)
      expect(inspectRoutineActionGrant(agentRoot, { key: grant.key, action: grant.action, target: "jellyfin", now }).allowed).toBe(false)
      expect(() => apply(agentRoot, desired, 1)).toThrow(/encoding/u)
      expect(fs.readFileSync(files.policy)).toEqual(before)
      expect(fs.readFileSync(files.audit)).toEqual(auditBefore)
    })

    it.each(["issuer", "event", "time"])("rejects a fully resealed grant row whose %s differs from its entry", (fault) => {
      const agentRoot = root()
      const files = paths(agentRoot)
      apply(agentRoot, grant, 0)
      const rows = auditRows(agentRoot)
      const row = rows[0]!
      if (fault === "issuer") row.issuer = "another-owner"
      if (fault === "event") row.authorizingSessionEvent = "another-event"
      if (fault === "time") {
        row.at = "2026-09-08T00:00:01.000Z"
        const after: StewardPolicyRecord = JSON.parse(row.postimage)
        after.updatedAt = row.at
        row.postimage = JSON.stringify(after, null, 2)
        row.postimageSha256 = digest(row.postimage)
        fs.writeFileSync(files.policy, row.postimage)
      }
      sealIdentity(row)
      saveRows(agentRoot, rows)
      expect(() => readStewardPolicy(agentRoot)).toThrow(/audit row is invalid/u)
      expect(inspectRoutineActionGrant(agentRoot, { key: grant.key, action: grant.action, target: "jellyfin", now }).allowed).toBe(false)
    })

    it("rejects an internally valid fork even when its cumulative digest and materialized head match", () => {
      const agentRoot = root()
      const forkRoot = root()
      apply(agentRoot, desired, 0)
      apply(forkRoot, { ...desired, value: "off" }, 0)
      apply(forkRoot, grant, 1)
      const files = paths(agentRoot)
      const prefix = fs.readFileSync(files.audit, "utf8")
      const fork = auditRows(forkRoot)[1]!
      fork.precedingBytesSha256 = digest(prefix)
      fs.appendFileSync(files.audit, JSON.stringify(fork) + "\n")
      fs.writeFileSync(files.policy, fork.postimage)
      expect(() => readStewardPolicy(agentRoot)).toThrow(/audit chain is invalid/u)
      expect(fs.readFileSync(files.policy, "utf8")).toBe(fork.postimage)
    })

    it("rejects a duplicate request identity in an otherwise valid contiguous chain", () => {
      const agentRoot = root()
      apply(agentRoot, desired, 0)
      apply(agentRoot, { ...desired, value: "off" }, 1, { ...owner, sessionEventId: "evt-ari-2" })
      const rows = auditRows(agentRoot)
      rows[1]!.authorizingSessionEvent = owner.sessionEventId
      sealIdentity(rows[1]!)
      saveRows(agentRoot, rows)
      const before = fs.readFileSync(paths(agentRoot).policy, "utf8")
      expect(() => readStewardPolicy(agentRoot)).toThrow(/duplicate transaction/u)
      expect(fs.readFileSync(paths(agentRoot).policy, "utf8")).toBe(before)
    })

    it.each(["after-v2", "zero", "duplicate"])("rejects the %s legacy prefix", (fault) => {
      const agentRoot = root()
      apply(agentRoot, desired, 0)
      const files = paths(agentRoot)
      const legacy = JSON.stringify({ schemaVersion: 1, policyVersion: fault === "zero" ? 0 : 1 }) + "\n"
      if (fault === "after-v2") fs.appendFileSync(files.audit, legacy)
      else fs.writeFileSync(files.audit, fault === "duplicate" ? legacy + legacy : legacy)
      expect(() => readStewardPolicy(agentRoot)).toThrow(/legacy prefix/u)
    })

    it("keeps a legacy grant readable but never grants it applied owner authority", () => {
      const agentRoot = root()
      apply(agentRoot, grant, 0)
      const files = paths(agentRoot)
      const prefix = JSON.stringify({ schemaVersion: 1, policyVersion: 1, mutationKind: "grant_routine_action" }) + "\n"
      fs.writeFileSync(files.audit, prefix)
      expect(readStewardPolicy(agentRoot).routineActionGrants[grant.key]).toMatchObject({ version: 1 })
      expect(inspectRoutineActionGrant(agentRoot, { key: grant.key, action: grant.action, target: "jellyfin", now })).toEqual({ allowed: false, reason: "routine action grant has no applied owner authorization" })
      expect(() => consumeRoutineActionGrant(agentRoot, { key: grant.key, action: grant.action, target: "jellyfin", expectedPolicyVersion: 1, now })).toThrow(/no applied owner/u)
      apply(agentRoot, desired, 1)
      expect(fs.readFileSync(files.audit, "utf8").startsWith(prefix)).toBe(true)
      expect(inspectRoutineActionGrant(agentRoot, { key: grant.key, action: grant.action, target: "jellyfin", now }).allowed).toBe(false)
    })

    it("accepts the exact UTF-8 policy bound and rejects an additional key without another row", () => {
      const seed = apply(root(), desired, 0)
      const sourceBytes = 1024 * 1024 - Buffer.byteLength(JSON.stringify(seed, null, 2)) + Buffer.byteLength(seed.desiredStates[desired.key]!.source)
      const source = "\u00e9".repeat(Math.floor(sourceBytes / 2)) + "x".repeat(sourceBytes % 2)
      const agentRoot = root()
      apply(agentRoot, { ...desired, source }, 0)
      const files = paths(agentRoot)
      expect(fs.statSync(files.policy).size).toBe(1024 * 1024)
      expect(readStewardPolicy(agentRoot).desiredStates[desired.key]!.source).toBe(source)
      const auditBefore = fs.readFileSync(files.audit, "utf8")
      expect(() => apply(agentRoot, { ...desired, key: "container:books" }, 1)).toThrow(/policy exceeds its bound/u)
      expect(readStewardPolicy(agentRoot).version).toBe(1)
      expect(fs.readFileSync(files.audit, "utf8")).toBe(auditBefore)
    })

    it("bounds new audit metadata before appending or publishing", () => {
      const agentRoot = root()
      const actor = structuredClone(owner)
      actor.authorization.receiptId = "r".repeat(16 * 1024 * 1024)
      expect(() => apply(agentRoot, desired, 0, actor)).toThrow(/audit row exceeds its bound/u)
      expect(fs.existsSync(paths(agentRoot).policy)).toBe(false)
      expect(fs.existsSync(paths(agentRoot).audit)).toBe(false)
    })

    it("refuses version exhaustion without changing the legacy policy or prefix", () => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const policy: StewardPolicyRecord = { schemaVersion: 1, version: Number.MAX_SAFE_INTEGER, desiredStates: {}, routineActionGrants: {}, updatedAt: now }
      const policyBytes = JSON.stringify(policy)
      const auditBytes = JSON.stringify({ schemaVersion: 1, policyVersion: policy.version }) + "\n"
      fs.mkdirSync(path.dirname(files.policy), { recursive: true })
      fs.writeFileSync(files.policy, policyBytes)
      fs.writeFileSync(files.audit, auditBytes)
      expect(() => apply(agentRoot, desired, policy.version)).toThrow(/version is exhausted/u)
      expect(fs.readFileSync(files.policy, "utf8")).toBe(policyBytes)
      expect(fs.readFileSync(files.audit, "utf8")).toBe(auditBytes)
    })

    it.each(["time", "provenance", "source"])("rejects invalid direct mutation %s without an audit row", (fault) => {
      const agentRoot = root()
      const mutation = structuredClone(desired)
      if (fault === "provenance") Object.assign(mutation, { provenance: "legacy" })
      if (fault === "source") Object.assign(mutation, { source: 42 })
      expect(() => updateStewardPolicy(agentRoot, { actor: owner, mutation, expectedVersion: 0, now: fault === "time" ? "yesterday" : now })).toThrow(/canonical|provenance|source/u)
      expect(fs.existsSync(paths(agentRoot).policy)).toBe(false)
      expect(fs.existsSync(paths(agentRoot).audit)).toBe(false)
    })

    it.each(["targets-null", "targets-string", "exclusions-null", "exclusions-object"])("reports a bounded domain error for %s", (fault) => {
      const agentRoot = root()
      const mutation = structuredClone(grant)
      if (fault === "targets-null") Object.assign(mutation, { targets: null })
      if (fault === "targets-string") Object.assign(mutation, { targets: "jellyfin" })
      if (fault === "exclusions-null") Object.assign(mutation, { exclusions: null })
      if (fault === "exclusions-object") Object.assign(mutation, { exclusions: {} })
      expect(() => apply(agentRoot, mutation, 0)).toThrow(/targets and exclusions must be arrays/u)
      expect(fs.existsSync(paths(agentRoot).policy)).toBe(false)
      expect(fs.existsSync(paths(agentRoot).audit)).toBe(false)
    })

    it.each(["owner-proof", "mutation-input"])("does not create new authority for invalid %s when an older WAL is pending", (fault) => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const rename = vi.mocked(fs.renameSync).getMockImplementation()!
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) === files.policy) throw new Error("before publication")
        rename(from, to)
      })
      expect(() => apply(agentRoot, desired, 0)).toThrow("before publication")
      vi.mocked(fs.renameSync).mockImplementation(rename)
      const auditBefore = fs.readFileSync(files.audit, "utf8")
      const actor = structuredClone(owner)
      if (fault === "owner-proof") actor.authorization.profileId = "sanctuary-household"
      expect(() => apply(agentRoot, { ...grant, verificationRequired: false }, 1, actor)).toThrow(fault === "owner-proof" ? /owner authorization/u : /verification/u)
      expect(fs.existsSync(files.policy)).toBe(fault === "mutation-input")
      expect(fs.readFileSync(files.audit, "utf8")).toBe(auditBefore)
      expect(readStewardPolicy(agentRoot)).toMatchObject({ version: 1, desiredStates: { [desired.key]: { value: "on" } }, routineActionGrants: {} })
    })

    it("links sequential setup and preserves exact earlier replay after unrelated changes", () => {
      const agentRoot = root()
      const files = paths(agentRoot)
      apply(agentRoot, desired, 0)
      const firstBytes = fs.readFileSync(files.audit, "utf8")
      const firstPolicy = fs.readFileSync(files.policy, "utf8")
      expect(inspectRoutineActionGrant(agentRoot, { key: grant.key, action: "unraid.container.restart", target: "jellyfin", now }).allowed).toBe(false)
      apply(agentRoot, grant, 1)
      const secondBytes = fs.readFileSync(files.audit, "utf8")
      const secondPolicy = fs.readFileSync(files.policy, "utf8")
      const latest = apply(agentRoot, { ...desired, key: "container:books", value: "off" }, 2)
      const rows = auditRows(agentRoot)
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.schemaVersion)).toEqual([2, 2, 2])
      expect(rows[1]).toMatchObject({ precedingBytesSha256: digest(firstBytes), preimage: firstPolicy, preimageVersion: 1, postimageVersion: 2 })
      expect(rows[2]).toMatchObject({ precedingBytesSha256: digest(secondBytes), preimage: secondPolicy, preimageVersion: 2, postimageVersion: 3 })
      const frozenAudit = fs.readFileSync(files.audit, "utf8")
      const frozenPolicy = fs.readFileSync(files.policy, "utf8")
      expect(apply(agentRoot, desired, 0)).toEqual(latest)
      expect(apply(agentRoot, grant, 1)).toEqual(latest)
      expect(fs.readFileSync(files.audit, "utf8")).toBe(frozenAudit)
      expect(fs.readFileSync(files.policy, "utf8")).toBe(frozenPolicy)
    })

    it("rejects changed arguments and later same-key replay even when the old result is restored", () => {
      const agentRoot = root()
      apply(agentRoot, desired, 0)
      expect(() => apply(agentRoot, { ...desired, value: "off" }, 1)).toThrow(/replay|fingerprint|transaction/u)
      apply(agentRoot, { ...desired, value: "off" }, 1, { ...owner, sessionEventId: "evt-ari-2" })
      apply(agentRoot, desired, 2, { ...owner, sessionEventId: "evt-ari-3" })
      const before = fs.readFileSync(paths(agentRoot).policy, "utf8")
      expect(() => apply(agentRoot, desired, 0)).toThrow(/replay|changed/u)
      expect(fs.readFileSync(paths(agentRoot).policy, "utf8")).toBe(before)
    })

    it("anchors the exact legacy prefix without treating legacy rows as applied v2 authority", () => {
      const agentRoot = root()
      const files = paths(agentRoot)
      const legacy: StewardPolicyRecord = {
        schemaVersion: 1, version: 1, desiredStates: { "container:books": { value: "off", provenance: "stated", version: 1, source: "legacy" } }, routineActionGrants: {}, updatedAt: now,
      }
      const prefix = JSON.stringify({ schemaVersion: 1, policyVersion: 1, issuer: "ari", authorizingSessionEvent: "evt-legacy", mutationKind: "set_desired_state", at: now }) + "\n"
      fs.mkdirSync(path.dirname(files.policy), { recursive: true })
      fs.writeFileSync(files.policy, JSON.stringify(legacy))
      fs.writeFileSync(files.audit, prefix)
      apply(agentRoot, desired, 1)
      const bytes = fs.readFileSync(files.audit, "utf8")
      expect(bytes.startsWith(prefix)).toBe(true)
      expect(auditRows(agentRoot)[1]).toMatchObject({ schemaVersion: 2, precedingBytesSha256: digest(prefix), preimage: JSON.stringify(legacy), preimageVersion: 1, postimageVersion: 2 })
      fs.writeFileSync(files.audit, bytes.slice(prefix.length))
      expect(() => readStewardPolicy(agentRoot)).toThrow(/audit/u)
    })

    it.each([
      "prior-digest", "preimage-digest", "postimage-digest", "result-digest", "fingerprint", "transaction-id",
      "version-gap", "adjacent-image", "unknown-field", "wrong-owner-profile", "missing-request", "missing-receipt",
      "duplicate-row", "reordered-rows", "removed-tail", "partial-tail", "malformed-tail", "missing-audit", "changed-head",
    ])("refuses %s before authority reads or another mutation", (fault) => {
      const agentRoot = root()
      const files = paths(agentRoot)
      apply(agentRoot, desired, 0)
      apply(agentRoot, grant, 1)
      apply(agentRoot, { ...desired, key: "container:books", value: "off" }, 2)
      const rows = auditRows(agentRoot)
      expect(rows.map((row) => row.schemaVersion)).toEqual([2, 2, 2])
      const second = rows[1]!
      if (fault === "prior-digest") second.precedingBytesSha256 = "0".repeat(64)
      if (fault === "preimage-digest") second.preimageSha256 = "0".repeat(64)
      if (fault === "postimage-digest") second.postimageSha256 = "0".repeat(64)
      if (fault === "result-digest") second.affectedKeyResultSha256 = "0".repeat(64)
      if (fault === "fingerprint") second.mutationFingerprint = "0".repeat(64)
      if (fault === "transaction-id") second.transactionId = "0".repeat(64)
      if (fault === "version-gap") second.postimageVersion += 1
      if (fault === "adjacent-image") second.preimage = ""
      if (fault === "unknown-field") Object.assign(second, { authorizedByNote: true })
      if (fault === "wrong-owner-profile") second.authorization.profileId = "sanctuary-household"
      if (fault === "missing-request") second.authorization.requestId = ""
      if (fault === "missing-receipt") second.authorization.receiptId = ""
      if (fault === "duplicate-row") rows.splice(1, 0, second)
      if (fault === "reordered-rows") [rows[0], rows[1]] = [rows[1]!, rows[0]!]
      if (fault === "removed-tail") rows.pop()
      saveRows(agentRoot, rows)
      if (fault === "partial-tail") fs.writeFileSync(files.audit, fs.readFileSync(files.audit, "utf8").slice(0, -8))
      if (fault === "malformed-tail") fs.appendFileSync(files.audit, "not-json\n")
      if (fault === "missing-audit") fs.unlinkSync(files.audit)
      if (fault === "changed-head") fs.appendFileSync(files.policy, "\n")
      const before = fs.readFileSync(files.policy, "utf8")
      expect(() => readStewardPolicy(agentRoot)).toThrow(/audit/u)
      expect(inspectRoutineActionGrant(agentRoot, { key: grant.key, action: "unraid.container.restart", target: "jellyfin", now }).allowed).toBe(false)
      expect(() => apply(agentRoot, { ...desired, key: "container:music" }, 3)).toThrow(/audit/u)
      expect(fs.readFileSync(files.policy, "utf8")).toBe(before)
    })

    it.each(["missing", "wrong-profile", "missing-request", "missing-session", "missing-receipt", "invalid-version"])("requires current resolved owner proof for %s authority", (fault) => {
      const agentRoot = root()
      const actor = structuredClone(owner)
      if (fault === "wrong-profile") actor.authorization.profileId = "sanctuary-household"
      if (fault === "missing-request") actor.authorization.requestId = ""
      if (fault === "missing-session") actor.authorization.sessionKey = ""
      if (fault === "missing-receipt") actor.authorization.receiptId = ""
      if (fault === "invalid-version") actor.authorization.profileVersion = 0
      if (fault === "missing") Object.assign(actor, { authorization: undefined })
      expect(() => apply(agentRoot, desired, 0, actor)).toThrow(/owner|authorization/u)
      expect(fs.existsSync(paths(agentRoot).policy)).toBe(false)
      expect(fs.existsSync(paths(agentRoot).audit)).toBe(false)
    })

    function currentOwnerContext(agentRoot: string) {
      return {
        signin: async () => undefined,
        agentRoot,
        currentSession: { friendId: "ari", channel: "telegram", key: "telegram_owner" },
        relationshipAuthorization: {
          profileId: "sanctuary-owner",
          requestId: "request-current",
          authorizedContextScopes: ["household.private"],
          advertisedToolNames: ["steward_policy_manage"],
          actor: structuredClone(owner),
          authorizeTool: vi.fn(async (): Promise<{ allowed: true; receiptId: string; profileVersion: number } | { allowed: false; reason: string }> => ({ allowed: true, receiptId: "relationship-current", profileVersion: 7 })),
        },
      }
    }

    it("records fresh tool-bound proof instead of a stale actor authorization", async () => {
      const agentRoot = root()
      const context = currentOwnerContext(agentRoot)
      const args = { action: "set_desired_state", key: desired.key, value: "on", provenance: "stated", source: "current owner request" }
      const result = await stewardPolicyToolDefinition.handler(args, context)
      expect(JSON.parse(result)).toMatchObject({ version: 1 })
      expect(context.relationshipAuthorization.authorizeTool).toHaveBeenCalledWith("steward_policy_manage", args)
      expect(auditRows(agentRoot)[0]!.authorization).toEqual({
        profileId: "sanctuary-owner", profileVersion: 7, requestId: "request-current", sessionKey: "telegram_owner", receiptId: "relationship-current",
      })
    })

    it.each(["wrong-profile", "missing-request", "wrong-friend", "inner-turn", "missing-session", "event-turn", "revoked", "dependency-failure", "unversioned", "missing-receipt"])(
      "refuses %s at the real policy tool even with a previously valid actor proof",
      async (fault) => {
        const agentRoot = root()
        const context = currentOwnerContext(agentRoot)
        if (fault === "wrong-profile") context.relationshipAuthorization.profileId = "sanctuary-household"
        if (fault === "missing-request") context.relationshipAuthorization.requestId = ""
        if (fault === "wrong-friend") context.currentSession.friendId = "someone-else"
        if (fault === "inner-turn") context.currentSession.channel = "inner"
        if (fault === "missing-session") context.currentSession.key = ""
        if (fault === "event-turn") Object.assign(context, { currentExternalEvent: {} })
        if (fault === "revoked") context.relationshipAuthorization.authorizeTool.mockResolvedValue({ allowed: false, reason: "owner revoked" })
        if (fault === "dependency-failure") context.relationshipAuthorization.authorizeTool.mockRejectedValue(new Error("authorization dependency unavailable"))
        if (fault === "unversioned") context.relationshipAuthorization.authorizeTool.mockResolvedValue({ allowed: true, receiptId: "new", profileVersion: 0 })
        if (fault === "missing-receipt") context.relationshipAuthorization.authorizeTool.mockResolvedValue({ allowed: true, receiptId: "", profileVersion: 7 })
        await expect(Promise.resolve().then(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", key: desired.key, value: "on", provenance: "stated", source: "current request" }, context))).rejects.toThrow(/owner|authorization|session/u)
        expect(fs.existsSync(paths(agentRoot).policy)).toBe(false)
        expect(fs.existsSync(paths(agentRoot).audit)).toBe(false)
      },
    )

    it.each(["kind", "verification", "target-type", "empty-exclusion"])("rejects malformed %s before writing an invalid audit row", (fault) => {
      const agentRoot = root()
      const mutation = structuredClone(grant)
      if (fault === "kind") Object.assign(mutation, { kind: "unknown" })
      if (fault === "verification") Object.assign(mutation, { verificationRequired: "true" })
      if (fault === "target-type") Object.assign(mutation, { targets: "jellyfin" })
      if (fault === "empty-exclusion") Object.assign(mutation, { exclusions: [""] })
      expect(() => apply(agentRoot, mutation, 0)).toThrow()
      expect(fs.existsSync(paths(agentRoot).policy)).toBe(false)
      expect(fs.existsSync(paths(agentRoot).audit)).toBe(false)
    })

    it.each(["request", "profile", "friend", "event", "session", "channel"])("rejects %s changes during live authorization", async (field) => {
      const agentRoot = root()
      const context = currentOwnerContext(agentRoot)
      context.relationshipAuthorization.authorizeTool.mockImplementation(async () => {
        if (field === "request") context.relationshipAuthorization.requestId = "another-request"
        if (field === "profile") context.relationshipAuthorization.profileId = "sanctuary-household"
        if (field === "friend") context.relationshipAuthorization.actor.friendId = "someone-else"
        if (field === "event") context.relationshipAuthorization.actor.sessionEventId = "another-event"
        if (field === "session") context.currentSession.key = "another-session"
        if (field === "channel") context.currentSession.channel = "inner"
        return { allowed: true, receiptId: "relationship-current", profileVersion: 7 }
      })
      await expect(Promise.resolve().then(() => stewardPolicyToolDefinition.handler({ action: "set_desired_state", key: desired.key, value: "on", provenance: "stated", source: "current request" }, context))).rejects.toThrow(/owner|authorization|session/u)
      expect(fs.existsSync(paths(agentRoot).policy)).toBe(false)
      expect(fs.existsSync(paths(agentRoot).audit)).toBe(false)
    })
  })

  it("covers malformed policy, empty targets, expiry, and missing receipt boundaries", () => {
    const agentRoot = root()
    const policyDir = path.join(agentRoot, "state", "policy")
    fs.mkdirSync(policyDir, { recursive: true })
    for (const malformed of [null, [], { schemaVersion: 1, version: -1, desiredStates: {}, routineActionGrants: {} }]) {
      fs.writeFileSync(path.join(policyDir, "steward.json"), JSON.stringify(malformed))
      expect(() => readStewardPolicy(agentRoot)).toThrow("invalid")
    }
    fs.rmSync(path.join(policyDir, "steward.json"))
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: { kind: "grant_routine_action", key: "restart", action: "restart", targets: [], maxCount: 1, windowMs: 1, verificationRequired: true, exclusions: [], provenance: "stated" } })).toThrow("requires a target")
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-01-01T00:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "test", expiresAt: "2026-01-02T00:00:00.000Z" } })
    expect(readStewardPolicy(agentRoot).desiredStates["container:books"]?.expiresAt).toBe("2026-01-02T00:00:00.000Z")
    expect(() => transitionRoutineActionReceipt(agentRoot, { id: "missing", expectedState: "reserved", state: "attempting" })).toThrow("missing")
  })

  it("exposes one narrow relationship-bound management tool", async () => {
    const agentRoot = root()
    const definition = resolveToolDefinition("steward_policy_manage")!
    const relationshipAuthorization = { profileId: "sanctuary-owner", requestId: "request-ari-1", authorizedContextScopes: ["household.private"], advertisedToolNames: ["steward_policy_manage"], authorizeTool: () => ({ allowed: true as const, receiptId: "auth-1", profileVersion: 7 }), actor: ari }
    expect(definition.riskProfile).toBeTypeOf("function")
    expect(() => definition.handler({ action: "read" }, { signin: async () => undefined, agentRoot })).toThrow("relationship authority")
    expect(await definition.handler({ action: "read" }, { signin: async () => undefined, agentRoot, relationshipAuthorization })).toContain('"version":0')
    expect(() => definition.handler({ action: "set_desired_state", expectedVersion: "0", key: "container:books", value: "off", provenance: "stated", source: "direct instruction" }, { signin: async () => undefined, agentRoot })).toThrow("relationship authority")
    const result = await definition.handler({ action: "set_desired_state", expectedVersion: "0", key: "container:books", value: "off", provenance: "stated", source: "direct instruction" }, {
      signin: async () => undefined,
      agentRoot,
      currentSession: { friendId: "ari", channel: "telegram", key: "telegram_owner" },
      relationshipAuthorization,
    })
    expect(JSON.parse(String(result))).toMatchObject({ version: 1, desiredStates: { "container:books": { value: "off", provenance: "stated" } } })
  })

  it("starts fail-closed with no desired states or routine action grants", () => {
    expect(readStewardPolicy(root())).toMatchObject({ schemaVersion: 1, version: 0, desiredStates: {}, routineActionGrants: {} })
  })

  it("records an observed desired state without turning it into mutation authority", () => {
    const agentRoot = root()
    const updated = updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "set_desired_state", key: "container:books", value: "intentionally_paused", provenance: "observed", source: "ari said he is not using it" },
    })
    expect(updated.desiredStates["container:books"]).toMatchObject({ value: "intentionally_paused", provenance: "observed", version: 1 })
    expect(updated.routineActionGrants).toEqual({})
  })

  it.each(["observed", "default"] as const)("rejects %s provenance for a routine mutation grant", (provenance) => {
    expect(() => updateStewardPolicy(root(), {
      expectedVersion: 0,
      actor: ari,
      mutation: {
        kind: "grant_routine_action",
        key: "unraid.restart:books",
        action: "unraid.restart",
        targets: ["books"],
        maxCount: 1,
        windowMs: 3_600_000,
        verificationRequired: true,
        exclusions: ["ouro-butler"],
        provenance,
      },
    })).toThrow("explicit authority")
  })

  it("requires verification and canonical future expiry for policy changes", () => {
    const agentRoot = root()
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-08-29T16:00:00.000Z", mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.restart", targets: ["books"], maxCount: 1, windowMs: 1_000, verificationRequired: false, exclusions: [], provenance: "stated" } })).toThrow("verification")
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-08-29T16:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "request", expiresAt: "not-a-time" } })).toThrow("canonical")
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-08-29T16:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "request", expiresAt: "2026-08-29T15:00:00.000Z" } })).toThrow("future")
  })

  it("requires family identity, a current authorizing session event, and fresh CAS", () => {
    const agentRoot = root()
    const mutation = { kind: "set_desired_state" as const, key: "container:books", value: "on_demand", provenance: "stated" as const, source: "direct instruction" }
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: { friendId: "relative", trustLevel: "friend", sessionEventId: "evt-1" }, mutation })).toThrow("family")
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: { friendId: "ari", trustLevel: "family", sessionEventId: "" }, mutation })).toThrow("session event")
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation })
    expect(() => updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: { ...ari, sessionEventId: "evt-ari-2" }, mutation })).toThrow("version")
  })

  it("atomically consumes a bounded action grant and preserves the rate window across reload", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: {
        kind: "grant_routine_action",
        key: "unraid.restart:books",
        action: "unraid.restart",
        targets: ["books"],
        maxCount: 1,
        windowMs: 3_600_000,
        verificationRequired: true,
        exclusions: ["ouro-butler"],
        provenance: "stated",
      },
    })
    const first = consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T17:00:00.000Z" })
    expect(first).toMatchObject({ state: "reserved", target: "books", policyVersion: 1, expectedBeforeState: null, effectReceipt: null, verifiedAfterState: null, recoveryState: { state: "not_needed", compensation: "none" } })
    transitionRoutineActionReceipt(agentRoot, { id: first.id, expectedState: "reserved", state: "attempting" })
    transitionRoutineActionReceipt(agentRoot, { id: first.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: "ack" })
    transitionRoutineActionReceipt(agentRoot, { id: first.id, expectedState: "effect_acknowledged", state: "verified", verifiedAfterState: "running" })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T17:30:00.000Z" })).toThrow("rate limit")
    expect(readStewardPolicy(agentRoot).version).toBe(1)
  })

  it("serializes policy updates and action reservation under the same steward-authority lease", async () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const authorityPath = path.join(agentRoot, "state", "policy", "steward.json")
    const lease = await acquireSessionTurnLease(authorityPath, { timeoutMs: 10 })
    try {
      expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1 })).toThrow("busy")
    } finally {
      await lease.release()
    }
  })

  it.each(["reserved", "attempting", "effect_acknowledged", "recovery_pending", "indeterminate"] as const)("fences a later standing mutation while the same action and target has an unresolved %s receipt", (state) => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["books", "music"], maxCount: 20, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const receipt = consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1, authorizationReceiptId: "relationship-1", authorizationVersion: 7 })
    if (state !== "reserved") transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "reserved", state: "attempting" })
    if (["effect_acknowledged", "recovery_pending", "indeterminate"].includes(state)) transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "attempting", state: state === "effect_acknowledged" ? "effect_acknowledged" : state, ...(state === "effect_acknowledged" || state === "recovery_pending" ? { effectReceipt: "ack" } : {}), ...(state === "indeterminate" ? { recoveryState: { state: "manual_inspection_required" as const, compensation: "none" as const } } : {}) })

    expect(inspectRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1 })).toMatchObject({ allowed: false, reason: expect.stringContaining("unresolved") })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1 })).toThrow("unresolved")
    expect(inspectRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "music", expectedPolicyVersion: 1 })).toMatchObject({ allowed: true })
  })

  it("fsyncs the steward directory when creating the first action receipt", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" } })
    consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1 })
    expect(fs.readFileSync(path.join(agentRoot, "state", "policy", "action-receipts.ndjson"), "utf8")).toContain('"state":"reserved"')
    const source = fs.readFileSync(path.join(process.cwd(), "src", "heart", "steward-policy.ts"), "utf8")
    expect(source).toContain("if (creating)")
    expect(source).toContain("fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW")
    expect(source).toContain("fs.fsyncSync(directory)")
  })

  it("authorizes only the exact action, target, policy version, and non-off desired state", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      now: "2026-08-29T16:00:00.000Z",
      mutation: { kind: "grant_routine_action", key: "unraid.restart:books", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: ["ouro-butler"], provenance: "stated" },
    })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T16:30:00.000Z" })).toMatchObject({ allowed: true, policyVersion: 1, grantVersion: 1 })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "wrong", target: "books", expectedPolicyVersion: 1 })).toMatchObject({ allowed: false, reason: expect.stringContaining("action") })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "unraid.container.restart", target: "ouro-butler", expectedPolicyVersion: 1 })).toMatchObject({ allowed: false, reason: expect.stringContaining("target") })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 0 })).toMatchObject({ allowed: false, reason: expect.stringContaining("version") })

    updateStewardPolicy(agentRoot, {
      expectedVersion: 1,
      actor: { ...ari, sessionEventId: "evt-ari-2" },
      mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "Ari asked for it to remain off" },
    })
    expect(inspectRoutineActionGrant(agentRoot, { key: "unraid.restart:books", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 2 })).toMatchObject({ allowed: false, reason: expect.stringContaining("expected off") })
  })

  it("keeps an explicitly-on desired state eligible and treats expired off state as inactive", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, now: "2026-01-01T00:00:00.000Z", mutation: { kind: "grant_routine_action", key: "restart", action: "restart", targets: ["books"], maxCount: 2, windowMs: 1000, verificationRequired: true, exclusions: [], provenance: "stated" } })
    updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: { ...ari, sessionEventId: "evt-2" }, now: "2026-01-01T00:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "on", provenance: "stated", source: "test" } })
    expect(inspectRoutineActionGrant(agentRoot, { key: "restart", action: "restart", target: "books", expectedPolicyVersion: 2, now: "2026-01-01T00:00:00.500Z" })).toMatchObject({ allowed: true })
    updateStewardPolicy(agentRoot, { expectedVersion: 2, actor: { ...ari, sessionEventId: "evt-3" }, now: "2026-01-01T00:00:00.000Z", mutation: { kind: "set_desired_state", key: "container:books", value: "off", provenance: "stated", source: "test", expiresAt: "2026-01-01T00:00:01.000Z" } })
    expect(inspectRoutineActionGrant(agentRoot, { key: "restart", action: "restart", target: "books", expectedPolicyVersion: 3, now: "2026-01-01T00:00:02.000Z" })).toMatchObject({ allowed: true })
  })

  it("persists complete append-only mutation snapshots and rejects stale transitions", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "unraid.restart:books", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const reserved = consumeRoutineActionGrant(agentRoot, {
      key: "unraid.restart:books",
      action: "unraid.container.restart",
      target: "books",
      expectedPolicyVersion: 1,
      authorizationReceiptId: "relationship-abc",
      authorizationVersion: 7,
      attemptId: "attempt-1",
      expectedBeforeState: "running",
      resolvedTarget: { id: "Docker:abc", name: "books" },
      effect: { operation: "restart", targetId: "Docker:abc" },
      now: "2026-08-29T17:00:00.000Z",
    })
    expect(reserved).toMatchObject({ state: "reserved", attemptId: "attempt-1", expectedBeforeState: "running", resolvedTarget: { id: "Docker:abc", name: "books" }, authorizationReceiptId: "relationship-abc", authorizationVersion: 7, effectReceipt: null, verifiedAfterState: null, recoveryState: { state: "not_needed", compensation: "none" } })
    const attempting = transitionRoutineActionReceipt(agentRoot, { id: reserved.id, expectedState: "reserved", state: "attempting", at: "2026-08-29T17:00:01.000Z" })
    const indeterminate = transitionRoutineActionReceipt(agentRoot, { id: reserved.id, expectedState: "attempting", state: "indeterminate", effectReceipt: "transport-outcome-unknown", recoveryState: { state: "manual_inspection_required", compensation: "none" }, at: "2026-08-29T17:00:02.000Z" })
    expect(attempting.attempt).toBe(1)
    expect(indeterminate).toMatchObject({ state: "indeterminate", effectReceipt: "transport-outcome-unknown", recoveryState: { state: "manual_inspection_required" } })
    expect(() => transitionRoutineActionReceipt(agentRoot, { id: reserved.id, expectedState: "attempting", state: "verified", verifiedAfterState: "running" })).toThrow("state changed")
    expect(readRoutineActionReceipts(agentRoot)).toEqual([indeterminate])
    expect(fs.readFileSync(path.join(agentRoot, "state", "policy", "action-receipts.ndjson"), "utf8").trim().split("\n")).toHaveLength(3)
  })

  it("recovers every crash boundary by inspection and never replays the mutation", async () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["before", "during", "after", "recovery"], maxCount: 8, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const reserve = (target: string, attemptId: string) => consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target, expectedPolicyVersion: 1, authorizationReceiptId: "relationship-1", authorizationVersion: 7, attemptId, expectedBeforeState: "running", resolvedTarget: { id: `Docker:${target}`, name: target }, effect: { operation: "restart", targetId: `Docker:${target}` } })
    const before = reserve("before", "attempt-before")
    const during = reserve("during", "attempt-during")
    transitionRoutineActionReceipt(agentRoot, { id: during.id, expectedState: "reserved", state: "attempting" })
    const after = reserve("after", "attempt-after")
    transitionRoutineActionReceipt(agentRoot, { id: after.id, expectedState: "reserved", state: "attempting" })
    transitionRoutineActionReceipt(agentRoot, { id: after.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: "unraid-ack" })
    const interrupted = reserve("recovery", "attempt-recovery")
    transitionRoutineActionReceipt(agentRoot, { id: interrupted.id, expectedState: "reserved", state: "attempting" })
    transitionRoutineActionReceipt(agentRoot, { id: interrupted.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: "unraid-ack" })

    const observeTarget = vi.fn(async ({ name }: { id: string; name: string }) => ({ id: `Docker:${name}`, name, state: "running" }))
    await expect(recoverRoutineActionReceipts(agentRoot, { observeTarget, afterRecoveryClaim: (receipt) => { if (receipt.id === interrupted.id) throw new Error("crash during recovery") } })).rejects.toThrow("crash during recovery")
    const interim = new Map(readRoutineActionReceipts(agentRoot).map((receipt) => [receipt.id, receipt]))
    expect(interim.get(before.id)?.state).toBe("recovered_no_effect")
    expect(interim.get(during.id)?.state).toBe("indeterminate")
    expect(interim.get(after.id)?.state).toBe("verified")
    expect(interim.get(interrupted.id)?.state).toBe("recovery_pending")

    await recoverRoutineActionReceipts(agentRoot, { observeTarget })
    expect(new Map(readRoutineActionReceipts(agentRoot).map((receipt) => [receipt.id, receipt])).get(interrupted.id)).toMatchObject({ state: "verified", verifiedAfterState: "running", recoveryState: { state: "completed", compensation: "none" } })
    expect(observeTarget).toHaveBeenCalledTimes(2)
  })

  it("rejects excluded targets, target drift, and stale policy versions before reservation", () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "unraid.restart:books", action: "unraid.restart", targets: ["books"], maxCount: 1, windowMs: 1_000, verificationRequired: true, exclusions: ["ouro-butler"], provenance: "stated" },
    })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "ouro-butler", expectedPolicyVersion: 1 })).toThrow("target")
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "photos", expectedPolicyVersion: 1 })).toThrow("target")
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "unraid.restart:books", target: "books", expectedPolicyVersion: 0 })).toThrow("version")
  })

  it("rejects malformed policy, missing/expired grants, invalid bounds, and concurrent ledger claims", async () => {
    const malformedRoot = root()
    fs.mkdirSync(path.join(malformedRoot, "state", "policy"), { recursive: true })
    fs.writeFileSync(path.join(malformedRoot, "state", "policy", "steward.json"), "{}\n")
    expect(() => readStewardPolicy(malformedRoot)).toThrow("invalid")
    expect(inspectRoutineActionGrant(malformedRoot, { key: "restart", action: "unraid.container.restart", target: "books" })).toMatchObject({ allowed: false, reason: expect.stringContaining("invalid") })
    vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw "unavailable" })
    expect(inspectRoutineActionGrant(malformedRoot, { key: "restart", action: "unraid.container.restart", target: "books" })).toEqual({ allowed: false, reason: "routine action policy is unavailable" })

    const agentRoot = root()
    expect(() => updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      mutation: { kind: "grant_routine_action", key: "bad", action: "unraid.restart", targets: [], maxCount: 0, windowMs: 0, verificationRequired: true, exclusions: [], provenance: "stated" },
    })).toThrow("bounds")
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "missing", target: "books", expectedPolicyVersion: 0 })).toThrow("missing")

    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: ari,
      now: "2026-08-29T16:00:00.000Z",
      mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.restart", targets: ["books"], maxCount: 1, windowMs: 1_000, verificationRequired: true, exclusions: [], provenance: "stated", expiresAt: "2026-08-29T17:00:00.000Z" },
    })
    expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T17:00:00.000Z" })).toThrow("expired")
    const lease = await acquireSessionTurnLease(path.join(agentRoot, "state", "policy", "steward.json"), { timeoutMs: 10 })
    try {
      expect(() => consumeRoutineActionGrant(agentRoot, { key: "restart", target: "books", expectedPolicyVersion: 1, now: "2026-08-29T16:30:00.000Z" })).toThrow("busy")
    } finally {
      await lease.release()
    }
  })

  it("keeps a mismatched recovery observation indeterminate", async () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, { expectedVersion: 0, actor: ari, mutation: { kind: "grant_routine_action", key: "restart", action: "unraid.container.restart", targets: ["books"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" } })
    const receipt = consumeRoutineActionGrant(agentRoot, { key: "restart", action: "unraid.container.restart", target: "books", expectedPolicyVersion: 1, authorizationReceiptId: "relationship-1", authorizationVersion: 7, attemptId: "attempt", expectedBeforeState: "running", resolvedTarget: { id: "Docker:books", name: "books" }, effect: { operation: "restart", targetId: "Docker:books" } })
    transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "reserved", state: "attempting" })
    transitionRoutineActionReceipt(agentRoot, { id: receipt.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: "ack" })
    await recoverRoutineActionReceipts(agentRoot, { observeTarget: async () => ({ id: "Docker:other", name: "books", state: "running" }) })
    expect(readRoutineActionReceipts(agentRoot)[0]).toMatchObject({ state: "indeterminate", recoveryState: { state: "manual_inspection_required" } })
  })
})
