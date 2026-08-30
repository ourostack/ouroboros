import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readStewardPolicy } from "../../../heart/steward-policy"
import {
  SANCTUARY_BUNDLE_ROLLBACK_FILE,
  SANCTUARY_PACKAGE_MANAGED_FILES,
  commitSanctuaryPackageManagedBundle,
  inspectSanctuaryPackageManagedBundleRollback,
  migrateSanctuaryPackageManagedBundle,
  rollbackSanctuaryPackageManagedBundle,
} from "../../../heart/daemon/sanctuary-bundle-migration"

const roots: string[] = []

function makeRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
  roots.push(root)
  return root
}

function write(root: string, relative: string, value: string | object): void {
  const destination = path.join(root, relative)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
}

function grant(target: string, provenance: "stated" | "installed_explicit_policy", version: number) {
  return {
    action: "unraid.container.restart",
    targets: [target],
    maxCount: 2,
    windowMs: 3_600_000,
    verificationRequired: true,
    exclusions: [],
    provenance,
    issuer: "ari",
    authorizedAt: "2026-08-29T00:00:00.000Z",
    authorizingSessionEvent: "owner-contract-2026-08-29",
    version,
  }
}

function policy(version: number, routineActionGrants: Record<string, ReturnType<typeof grant> & { expiresAt?: string }>) {
  return {
    schemaVersion: 1,
    version,
    desiredStates: {
      "container:jellyfin": { value: "off", provenance: "stated", version: 4, source: "ari" },
    },
    routineActionGrants,
    updatedAt: "2026-08-30T00:00:00.000Z",
  }
}

function makePackageRoot(): string {
  const root = makeRoot("sanctuary-package")
  for (const relative of SANCTUARY_PACKAGE_MANAGED_FILES) write(root, relative, `packaged:${relative}\n`)
  write(root, "bundle-meta.json", { runtimeVersion: "0.1.0-alpha.743", bundleSchemaVersion: 3, lastUpdated: "2026-08-30T00:00:00.000Z" })
  write(root, "state/policy/steward.json", policy(1, {
    "unraid.restart:jellyfin": grant("jellyfin", "installed_explicit_policy", 1),
    "unraid.restart:sabnzbd": grant("sabnzbd", "installed_explicit_policy", 1),
  }))
  return root
}

function treeSnapshot(root: string): string[] {
  const visit = (directory: string): string[] => fs.readdirSync(directory).sort().flatMap((name) => {
    const fullPath = path.join(directory, name)
    const stat = fs.lstatSync(fullPath)
    const relative = path.relative(root, fullPath)
    if (stat.isDirectory()) return [`d ${stat.mode & 0o777} ${relative}`, ...visit(fullPath)]
    return [`f ${stat.mode & 0o777} ${relative} ${fs.readFileSync(fullPath).toString("base64")}`]
  })
  return visit(root)
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Sanctuary package-managed bundle migration", () => {
  it("updates only package-managed files and bundle versions while preserving live policy bytes", () => {
    const packageRoot = makePackageRoot()
    const agentRoot = makeRoot("sanctuary-live")
    write(agentRoot, "agent.json", { humanFacing: { provider: "minimax", model: "custom" } })
    write(agentRoot, "friends/relationships.json", { private: "keep" })
    write(agentRoot, "state/sessions/owner.json", { transcript: "keep" })
    write(agentRoot, "psyche/operator-note.md", "keep\n")
    fs.chmodSync(path.join(agentRoot, "psyche"), 0o750)
    write(agentRoot, "bundle-meta.json", { runtimeVersion: "old", bundleSchemaVersion: 2, lastUpdated: "old", operatorNote: "keep" })
    write(agentRoot, "tool-profiles.json", "packaged:tool-profiles.json\n")
    fs.chmodSync(path.join(agentRoot, "tool-profiles.json"), 0o640)
    write(agentRoot, "state/policy/steward.json", policy(7, {
      "unraid.restart:jellyfin": { ...grant("jellyfin", "stated", 5), maxCount: 9 },
      "unraid.restart:sabnzbd": { ...grant("sabnzbd", "installed_explicit_policy", 6), maxCount: 1 },
      "unraid.restart:custom": grant("custom", "stated", 7),
    }))
    write(agentRoot, "state/policy/policy-audit.ndjson", "live audit\n")
    const originalPolicyText = fs.readFileSync(path.join(agentRoot, "state/policy/steward.json"), "utf8")
    const originalAuditText = fs.readFileSync(path.join(agentRoot, "state/policy/policy-audit.ndjson"), "utf8")

    const first = migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })
    const second = migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })

    expect(first).toEqual({ managedFilesUpdated: SANCTUARY_PACKAGE_MANAGED_FILES.length })
    expect(second).toEqual({ managedFilesUpdated: 0 })
    expect(fs.readFileSync(path.join(agentRoot, "state/policy/steward.json"), "utf8")).toBe(originalPolicyText)
    expect(fs.readFileSync(path.join(agentRoot, "state/policy/policy-audit.ndjson"), "utf8")).toBe(originalAuditText)
    for (const relative of SANCTUARY_PACKAGE_MANAGED_FILES) {
      expect(fs.readFileSync(path.join(agentRoot, relative), "utf8")).toBe(`packaged:${relative}\n`)
      expect(fs.statSync(path.join(agentRoot, relative)).mode & 0o777).toBe(0o600)
    }
    expect(JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf8"))).toEqual({ humanFacing: { provider: "minimax", model: "custom" } })
    expect(JSON.parse(fs.readFileSync(path.join(agentRoot, "friends/relationships.json"), "utf8"))).toEqual({ private: "keep" })
    expect(JSON.parse(fs.readFileSync(path.join(agentRoot, "state/sessions/owner.json"), "utf8"))).toEqual({ transcript: "keep" })
    expect(fs.statSync(path.join(agentRoot, "psyche")).mode & 0o777).toBe(0o750)
    expect(JSON.parse(fs.readFileSync(path.join(agentRoot, "bundle-meta.json"), "utf8"))).toEqual({
      runtimeVersion: "0.1.0-alpha.743", bundleSchemaVersion: 3, lastUpdated: "2026-08-30T00:00:00.000Z", operatorNote: "keep",
    })
  })

  it("does not install packaged policy authority", () => {
    const packageRoot = makePackageRoot()
    const agentRoot = makeRoot("sanctuary-live-empty")
    const result = migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })

    expect(result).toEqual({ managedFilesUpdated: SANCTUARY_PACKAGE_MANAGED_FILES.length })
    const livePolicy = readStewardPolicy(agentRoot)
    expect(livePolicy.desiredStates).toEqual({})
    expect(livePolicy.routineActionGrants).toEqual({})
  })

  it("durably restores the exact pre-migration managed bundle and policy after process restart", () => {
    const packageRoot = makePackageRoot()
    const agentRoot = makeRoot("sanctuary-live-durable-rollback")
    write(agentRoot, "agent.json", { preserve: "identity" })
    write(agentRoot, "friends/relationships.json", { preserve: "relationships" })
    write(agentRoot, "state/sessions/owner.json", { preserve: "session-before-migration" })
    write(agentRoot, "bundle-meta.json", { runtimeVersion: "old", bundleSchemaVersion: 2, lastUpdated: "old", preserve: true })
    write(agentRoot, "state/policy/steward.json", policy(7, {
      "unraid.restart:custom": grant("custom", "stated", 7),
    }))
    write(agentRoot, "state/policy/policy-audit.ndjson", "pre-migration-audit\n")
    fs.chmodSync(path.join(agentRoot, "bundle-meta.json"), 0o640)
    fs.chmodSync(path.join(agentRoot, "state", "policy", "policy-audit.ndjson"), 0o620)
    const before = treeSnapshot(agentRoot)

    migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"1".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })
    expect(inspectSanctuaryPackageManagedBundleRollback(agentRoot)).toEqual({ rollbackImageId: `sha256:${"1".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}`, state: "rollback" })
    expect(fs.statSync(path.join(agentRoot, SANCTUARY_BUNDLE_ROLLBACK_FILE)).mode & 0o777).toBe(0o600)
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"1".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })).toThrow(/rollback is pending/u)

    // Work outside the managed transaction remains live while a killed updater is restarted.
    write(agentRoot, "state/sessions/owner.json", { preserve: "session-after-migration" })
    write(agentRoot, "habits/operator-preference.md", "preserve new preference\n")
    const interruptedTarget = path.join(agentRoot, "bundle-meta.json")
    const abandonedStage = fs.mkdtempSync(`${interruptedTarget}.package-migration.`)
    fs.writeFileSync(path.join(abandonedStage, "value"), "partial restore")
    fs.writeFileSync(interruptedTarget, "{\"partiallyRestored\":true}\n")
    write(agentRoot, "state/policy/policy-audit.ndjson", "legitimate live policy change\n")
    expect(rollbackSanctuaryPackageManagedBundle(agentRoot)).toBe(true)
    const after = treeSnapshot(agentRoot)
    const unrelated = (entry: string) => entry.includes("state/sessions/owner.json") || entry.includes("habits") || entry.includes("state/policy")
    expect(after.filter((entry) => !unrelated(entry))).toEqual(before.filter((entry) => !unrelated(entry)))
    expect(JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "sessions", "owner.json"), "utf8"))).toEqual({ preserve: "session-after-migration" })
    expect(fs.readFileSync(path.join(agentRoot, "habits", "operator-preference.md"), "utf8")).toBe("preserve new preference\n")
    expect(fs.existsSync(path.join(agentRoot, SANCTUARY_BUNDLE_ROLLBACK_FILE))).toBe(false)
    expect(fs.existsSync(abandonedStage)).toBe(false)
    expect(fs.readFileSync(path.join(agentRoot, "state", "policy", "policy-audit.ndjson"), "utf8")).toBe("legitimate live policy change\n")
    expect(rollbackSanctuaryPackageManagedBundle(agentRoot)).toBe(false)
  })

  it("commits a proven migration and fails closed on a corrupt or symlinked rollback record", () => {
    const packageRoot = makePackageRoot()
    const agentRoot = makeRoot("sanctuary-live-durable-commit")
    migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"2".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })
    fs.copyFileSync(path.join(agentRoot, SANCTUARY_BUNDLE_ROLLBACK_FILE), path.join(agentRoot, `${SANCTUARY_BUNDLE_ROLLBACK_FILE}.committing`))
    expect(() => inspectSanctuaryPackageManagedBundleRollback(agentRoot)).toThrow(/ambiguous/u)
    fs.unlinkSync(path.join(agentRoot, `${SANCTUARY_BUNDLE_ROLLBACK_FILE}.committing`))
    fs.renameSync(path.join(agentRoot, SANCTUARY_BUNDLE_ROLLBACK_FILE), path.join(agentRoot, `${SANCTUARY_BUNDLE_ROLLBACK_FILE}.committing`))
    expect(inspectSanctuaryPackageManagedBundleRollback(agentRoot)).toMatchObject({ state: "committing" })
    expect(() => rollbackSanctuaryPackageManagedBundle(agentRoot)).toThrow(/commit is pending/u)
    expect(commitSanctuaryPackageManagedBundle(agentRoot)).toBe(true)
    expect(commitSanctuaryPackageManagedBundle(agentRoot)).toBe(false)
    expect(rollbackSanctuaryPackageManagedBundle(agentRoot)).toBe(false)
    expect(inspectSanctuaryPackageManagedBundleRollback(agentRoot)).toBeNull()

    const rollbackPath = path.join(agentRoot, SANCTUARY_BUNDLE_ROLLBACK_FILE)
    fs.writeFileSync(rollbackPath, "{\"schemaVersion\":999}\n")
    expect(() => rollbackSanctuaryPackageManagedBundle(agentRoot)).toThrow(/mode-0600/u)
    fs.chmodSync(rollbackPath, 0o600)
    expect(() => rollbackSanctuaryPackageManagedBundle(agentRoot)).toThrow(/rollback record/u)
    expect(fs.existsSync(rollbackPath)).toBe(true)
    fs.writeFileSync(rollbackPath, "{")
    fs.chmodSync(rollbackPath, 0o600)
    expect(() => rollbackSanctuaryPackageManagedBundle(agentRoot)).toThrow(/invalid JSON/u)

    fs.rmSync(rollbackPath)
    const outside = path.join(makeRoot("sanctuary-rollback-outside"), "record")
    fs.writeFileSync(outside, "outside")
    fs.symlinkSync(outside, rollbackPath)
    expect(() => rollbackSanctuaryPackageManagedBundle(agentRoot)).toThrow(/symlink/u)
    expect(fs.readFileSync(outside, "utf8")).toBe("outside")
  })

  it("keeps the durable record when rollback itself is interrupted, then converges on restart", () => {
    const packageRoot = makePackageRoot()
    const agentRoot = makeRoot("sanctuary-live-interrupted-rollback")
    write(agentRoot, "psyche/SOUL.md", "old soul\n")
    fs.chmodSync(path.join(agentRoot, "psyche"), 0o500)

    expect(() => migrateSanctuaryPackageManagedBundle({
      packageRoot,
      agentRoot,
      retainRollback: true,
      rollbackImageId: `sha256:${"3".repeat(64)}`,
      targetImageId: `sha256:${"9".repeat(64)}`,
    })).toThrow(/migration and rollback both failed/u)
    expect(inspectSanctuaryPackageManagedBundleRollback(agentRoot)).toEqual({ rollbackImageId: `sha256:${"3".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}`, state: "rollback" })

    fs.chmodSync(path.join(agentRoot, "psyche"), 0o700)
    expect(rollbackSanctuaryPackageManagedBundle(agentRoot, { retainRecord: true })).toBe(true)
    expect(fs.readFileSync(path.join(agentRoot, "psyche", "SOUL.md"), "utf8")).toBe("old soul\n")
    expect(inspectSanctuaryPackageManagedBundleRollback(agentRoot)).not.toBeNull()
    expect(commitSanctuaryPackageManagedBundle(agentRoot)).toBe(true)
    fs.chmodSync(path.join(agentRoot, "psyche"), 0o700)
  })

  it("removes the durable record after a caught managed-source fault restores cleanly", () => {
    const packageRoot = makePackageRoot()
    const agentRoot = makeRoot("sanctuary-caught-managed-fault")
    fs.chmodSync(path.join(packageRoot, SANCTUARY_PACKAGE_MANAGED_FILES[0]), 0o000)
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"7".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })).toThrow()
    expect(fs.readdirSync(agentRoot)).toEqual([])
    fs.chmodSync(path.join(packageRoot, SANCTUARY_PACKAGE_MANAGED_FILES[0]), 0o600)
  })

  it("validates every durable rollback field and root before restoring", () => {
    const invalidRecords: Array<(record: any) => unknown> = [
      () => null,
      (record) => ({ ...record, rollbackImageId: "latest" }),
      (record) => ({ ...record, files: {} }),
      (record) => ({ ...record, directories: {} }),
      (record) => ({ ...record, files: record.files.slice(1) }),
      (record) => ({ ...record, directories: record.directories.slice(1) }),
      (record) => ({ ...record, files: record.files.map((file: any, index: number) => index === 0 ? { ...file, mode: 0o1000 } : file) }),
      (record) => ({ ...record, files: record.files.map((file: any, index: number) => index === 0 ? { ...file, contentBase64: 7 } : file) }),
      (record) => ({ ...record, files: record.files.map((file: any, index: number) => index === 0 ? { ...file, contentBase64: "YQ==" } : file) }),
      (record) => ({ ...record, files: record.files.map((file: any) => file.relative === "bundle-meta.json" ? { ...file, contentBase64: "%%%" } : file) }),
      (record) => ({ ...record, files: record.files.map((file: any) => file.relative === "bundle-meta.json" ? { ...file, contentBase64: "YQ==" } : file) }),
      (record) => ({ ...record, directories: record.directories.map((directory: any, index: number) => index === 0 ? { ...directory, mode: -1 } : directory) }),
    ]
    for (const mutate of invalidRecords) {
      const packageRoot = makePackageRoot()
      const agentRoot = makeRoot("sanctuary-invalid-durable-record")
      write(agentRoot, "bundle-meta.json", { runtimeVersion: "old", bundleSchemaVersion: 1, lastUpdated: "old" })
      migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"4".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })
      const recordPath = path.join(agentRoot, SANCTUARY_BUNDLE_ROLLBACK_FILE)
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"))
      fs.writeFileSync(recordPath, `${JSON.stringify(mutate(record))}\n`)
      expect(() => rollbackSanctuaryPackageManagedBundle(agentRoot)).toThrow(/rollback record/u)
      expect(fs.existsSync(recordPath)).toBe(true)
    }

    const malformedRoot = makeRoot("sanctuary-invalid-durable-root")
    expect(() => inspectSanctuaryPackageManagedBundleRollback("relative")).toThrow(/absolute/u)
    fs.rmSync(malformedRoot, { recursive: true })
    fs.writeFileSync(malformedRoot, "file")
    expect(() => commitSanctuaryPackageManagedBundle(malformedRoot)).toThrow(/real directory/u)
    const linkedRootTarget = makeRoot("sanctuary-linked-durable-root-target")
    const linkedRoot = path.join(makeRoot("sanctuary-linked-durable-root-parent"), "root")
    fs.symlinkSync(linkedRootTarget, linkedRoot)
    expect(() => rollbackSanctuaryPackageManagedBundle(linkedRoot)).toThrow(/real directory/u)
  })

  it("rejects invalid interrupted journal stages and missing rollback identity", () => {
    const packageRoot = makePackageRoot()
    const agentRoot = makeRoot("sanctuary-interrupted-journal-write")
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true })).toThrow(/distinct exact/u)
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: "sha256:bad", targetImageId: `sha256:${"9".repeat(64)}` })).toThrow(/distinct exact/u)

    const invalidStage = path.join(agentRoot, `${SANCTUARY_BUNDLE_ROLLBACK_FILE}.package-migration.invalid`)
    fs.mkdirSync(invalidStage)
    fs.writeFileSync(path.join(invalidStage, "unexpected"), "bad")
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"6".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })).toThrow(/unexpected entries/u)
    expect(fs.existsSync(invalidStage)).toBe(true)
    fs.unlinkSync(path.join(invalidStage, "unexpected"))
    fs.rmdirSync(invalidStage)

    const emptyStage = path.join(agentRoot, `${SANCTUARY_BUNDLE_ROLLBACK_FILE}.package-migration.empty`)
    fs.mkdirSync(emptyStage)
    migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"6".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })
    expect(fs.existsSync(emptyStage)).toBe(false)
    expect(rollbackSanctuaryPackageManagedBundle(agentRoot)).toBe(true)

    const linkedStage = path.join(agentRoot, `${SANCTUARY_BUNDLE_ROLLBACK_FILE}.package-migration.linked`)
    fs.symlinkSync(makeRoot("sanctuary-linked-stage-target"), linkedStage)
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"6".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })).toThrow(/stage is invalid/u)
    fs.unlinkSync(linkedStage)

    const invalidValueStage = path.join(agentRoot, `${SANCTUARY_BUNDLE_ROLLBACK_FILE}.package-migration.value`)
    fs.mkdirSync(path.join(invalidValueStage, "value"), { recursive: true })
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: `sha256:${"6".repeat(64)}`, targetImageId: `sha256:${"9".repeat(64)}` })).toThrow(/value is invalid/u)
  })

  it("fails closed before writes for missing package files or symlinked destinations", () => {
    const packageRoot = makePackageRoot()
    const missingAgentRoot = makeRoot("sanctuary-live-missing")
    fs.rmSync(path.join(packageRoot, SANCTUARY_PACKAGE_MANAGED_FILES[0]))
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot: missingAgentRoot })).toThrow(/package-managed source/u)
    expect(fs.readdirSync(missingAgentRoot)).toEqual([])

    const completePackageRoot = makePackageRoot()
    const linkedAgentRoot = makeRoot("sanctuary-live-linked")
    const outside = makeRoot("sanctuary-outside")
    fs.mkdirSync(path.join(linkedAgentRoot, "psyche"), { recursive: true })
    fs.symlinkSync(path.join(outside, "soul"), path.join(linkedAgentRoot, "psyche", "SOUL.md"))
    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot: completePackageRoot, agentRoot: linkedAgentRoot })).toThrow(/symlink/u)
    expect(fs.existsSync(path.join(outside, "soul"))).toBe(false)
  })

  it("rejects malformed roots, files, metadata, and destinations before mutation", () => {
    const cases: Array<(packageRoot: string, agentRoot: string) => void> = [
      (packageRoot, agentRoot) => { expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot: "relative", agentRoot })).toThrow(/absolute/u) },
      (packageRoot) => { expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot: "relative" })).toThrow(/absolute/u) },
      (packageRoot) => { expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot: packageRoot })).toThrow(/distinct/u) },
      (packageRoot, agentRoot) => { fs.rmSync(packageRoot, { recursive: true }); fs.writeFileSync(packageRoot, "file"); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/package root/u) },
      (packageRoot, agentRoot) => { const target = makeRoot("package-link-target"); fs.rmSync(packageRoot, { recursive: true }); fs.symlinkSync(target, packageRoot); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/package root/u) },
      (packageRoot, agentRoot) => { fs.rmSync(agentRoot, { recursive: true }); fs.writeFileSync(agentRoot, "file"); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/agent root/u) },
      (packageRoot, agentRoot) => { const target = makeRoot("agent-link-target"); fs.rmSync(agentRoot, { recursive: true }); fs.symlinkSync(target, agentRoot); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/agent root/u) },
      (packageRoot, agentRoot) => { const source = path.join(packageRoot, SANCTUARY_PACKAGE_MANAGED_FILES[0]); fs.rmSync(source); fs.mkdirSync(source); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/regular file/u) },
      (packageRoot, agentRoot) => { const source = path.join(packageRoot, SANCTUARY_PACKAGE_MANAGED_FILES[0]); fs.rmSync(source); fs.symlinkSync(path.join(packageRoot, SANCTUARY_PACKAGE_MANAGED_FILES[1]), source); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/symlink/u) },
      (packageRoot, agentRoot) => { fs.writeFileSync(path.join(agentRoot, "psyche"), "not a directory"); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/parent must be a directory/u) },
      (packageRoot, agentRoot) => { fs.mkdirSync(path.join(agentRoot, "tool-profiles.json")); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/regular file/u) },
      (packageRoot, agentRoot) => { write(packageRoot, "bundle-meta.json", null as unknown as object); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/object/u) },
      (packageRoot, agentRoot) => { fs.writeFileSync(path.join(packageRoot, "bundle-meta.json"), "[]"); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/object/u) },
      (packageRoot, agentRoot) => { fs.writeFileSync(path.join(packageRoot, "bundle-meta.json"), "\"text\""); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/object/u) },
      (packageRoot, agentRoot) => { write(packageRoot, "bundle-meta.json", { runtimeVersion: "x" }); expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/missing/u) },
    ]
    for (const run of cases) run(makePackageRoot(), makeRoot("sanctuary-invalid"))

  })

})
