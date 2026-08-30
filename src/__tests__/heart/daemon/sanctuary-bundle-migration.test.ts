import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readStewardPolicy } from "../../../heart/steward-policy"
import { SANCTUARY_PACKAGE_MANAGED_FILES, migrateSanctuaryPackageManagedBundle } from "../../../heart/daemon/sanctuary-bundle-migration"

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
  it("updates only package-managed files and bundle versions while CAS-merging installed grants", () => {
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

    const first = migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })
    const firstPolicyText = fs.readFileSync(path.join(agentRoot, "state/policy/steward.json"), "utf8")
    const firstAuditText = fs.readFileSync(path.join(agentRoot, "state/policy/policy-audit.ndjson"), "utf8")
    const second = migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })

    expect(first).toEqual({ managedFilesUpdated: SANCTUARY_PACKAGE_MANAGED_FILES.length, grantsAdded: 0, grantsUpdated: 1, grantsPreserved: 2, policyVersion: 8 })
    expect(second).toEqual({ managedFilesUpdated: 0, grantsAdded: 0, grantsUpdated: 0, grantsPreserved: 3, policyVersion: 8 })
    expect(fs.readFileSync(path.join(agentRoot, "state/policy/steward.json"), "utf8")).toBe(firstPolicyText)
    expect(fs.readFileSync(path.join(agentRoot, "state/policy/policy-audit.ndjson"), "utf8")).toBe(firstAuditText)
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
    const livePolicy = readStewardPolicy(agentRoot)
    expect(livePolicy.desiredStates["container:jellyfin"]).toMatchObject({ value: "off", provenance: "stated" })
    expect(livePolicy.routineActionGrants["unraid.restart:jellyfin"]).toMatchObject({ provenance: "stated", maxCount: 9 })
    expect(livePolicy.routineActionGrants["unraid.restart:sabnzbd"]).toMatchObject({ provenance: "installed_explicit_policy", maxCount: 2, version: 8 })
    expect(livePolicy.routineActionGrants["unraid.restart:custom"]).toMatchObject({ provenance: "stated" })
  })

  it("adds missing packaged grants without copying packaged desired states", () => {
    const packageRoot = makePackageRoot()
    const agentRoot = makeRoot("sanctuary-live-empty")
    const result = migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })

    expect(result).toMatchObject({ grantsAdded: 2, grantsUpdated: 0, policyVersion: 2 })
    const livePolicy = readStewardPolicy(agentRoot)
    expect(livePolicy.desiredStates).toEqual({})
    expect(Object.keys(livePolicy.routineActionGrants).sort()).toEqual(["unraid.restart:jellyfin", "unraid.restart:sabnzbd"])
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

  it("restores exact files, modes, policy audit, and newly created parents when a CAS-path mutation fails", () => {
    const packageRoot = makePackageRoot()
    const packagedPolicy = policy(1, {
      "unraid.restart:jellyfin": grant("jellyfin", "installed_explicit_policy", 1),
      "unraid.restart:sabnzbd": { ...grant("sabnzbd", "installed_explicit_policy", 1), expiresAt: "2026-08-28T00:00:00.000Z" },
    })
    write(packageRoot, "state/policy/steward.json", packagedPolicy)
    const agentRoot = makeRoot("sanctuary-live-rollback")
    write(agentRoot, "agent.json", { preserve: true })
    write(agentRoot, "bundle-meta.json", { runtimeVersion: "old", bundleSchemaVersion: 2, lastUpdated: "old" })
    write(agentRoot, "psyche/operator-note.md", "preserve\n")
    fs.chmodSync(path.join(agentRoot, "psyche"), 0o750)
    fs.chmodSync(path.join(agentRoot, "bundle-meta.json"), 0o640)
    const before = treeSnapshot(agentRoot)

    expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot })).toThrow(/expiry/u)

    expect(treeSnapshot(agentRoot)).toEqual(before)
    expect(treeSnapshot(agentRoot).some((entry) => /(?:journal|wal|shm|turn\.lock|package-migration)/u.test(entry))).toBe(false)
  })

  it("rejects malformed roots, files, metadata, destinations, and installed grants before mutation", () => {
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

    const invalidGrants: Array<Record<string, unknown>> = [
      { provenance: "stated" }, { issuer: "" }, { authorizingSessionEvent: "" }, { authorizedAt: "" },
      { version: 0 }, { version: 1.5 }, { maxCount: 0 }, { maxCount: 1.5 }, { windowMs: 0 }, { windowMs: Number.POSITIVE_INFINITY },
      { verificationRequired: false }, { targets: [] }, { targets: "bad" }, { exclusions: "bad" },
    ]
    for (const mutation of invalidGrants) {
      const packageRoot = makePackageRoot()
      const packaged = policy(1, { broken: { ...grant("broken", "installed_explicit_policy", 1), ...mutation } as ReturnType<typeof grant> })
      write(packageRoot, "state/policy/steward.json", packaged)
      expect(() => migrateSanctuaryPackageManagedBundle({ packageRoot, agentRoot: makeRoot("sanctuary-invalid-grant") })).toThrow(/invalid/u)
    }
  })

})
