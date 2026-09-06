import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  prepareSanctuaryPackageManagedBundle,
  resolveSanctuaryPackageManagementActivation,
  resolveSanctuaryPackageManagedRoots,
} from "../../../heart/daemon/sanctuary-package-management"

const roots: string[] = []
const VERSION = "0.1.0-alpha.798"

function makeLayout(): { repoRoot: string; bundlesRoot: string; packageRoot: string; agentRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-package-activation-"))
  roots.push(root)
  const repoRoot = path.join(root, "repo")
  const bundlesRoot = path.join(root, "AgentBundles")
  const packageRoot = path.join(repoRoot, "deploy", "unraid", "sanctuary.ouro")
  const agentRoot = path.join(bundlesRoot, "sanctuary.ouro")
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.mkdirSync(agentRoot, { recursive: true })
  return { repoRoot, bundlesRoot, packageRoot, agentRoot }
}

function resolve(overrides: Partial<Parameters<typeof resolveSanctuaryPackageManagementActivation>[0]> = {}) {
  const layout = makeLayout()
  return {
    layout,
    decision: resolveSanctuaryPackageManagementActivation({
      mode: "production",
      argv: ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"],
      managedAgents: ["sanctuary"],
      repoRoot: layout.repoRoot,
      bundlesRoot: layout.bundlesRoot,
      runtimePackageVersion: VERSION,
      ...overrides,
    }),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Sanctuary package-management activation", () => {
  it("derives the one fixed root pair for non-argv consumers", () => {
    const layout = makeLayout()
    expect(resolveSanctuaryPackageManagedRoots({ repoRoot: layout.repoRoot, bundlesRoot: layout.bundlesRoot })).toEqual({
      packageRoot: layout.packageRoot,
      agentRoot: layout.agentRoot,
    })
  })

  it("resolves only the exact production singleton contract and preserves unrelated arguments", () => {
    const { layout, decision } = resolve({
      argv: ["node", "daemon-entry.js", "--socket", "/tmp/ouro.sock", "--package-managed-agent", "sanctuary"],
    })

    expect(decision).toEqual({
      kind: "active",
      packageRoot: layout.packageRoot,
      agentRoot: layout.agentRoot,
      runtimePackageVersion: VERSION,
    })
  })

  it.each([
    ["no package flag", ["node", "daemon-entry.js"]],
    ["an unrelated socket flag", ["node", "daemon-entry.js", "--socket", "/tmp/custom.sock"]],
  ])("leaves generic production startup inactive with %s", (_label, argv) => {
    const { decision } = resolve({ argv, managedAgents: ["slugger"] })
    expect(decision).toEqual({ kind: "inactive" })
  })

  it.each([
    [[], ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"]],
    [["slugger"], ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"]],
    [["sanctuary", "slugger"], ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"]],
    [["sanctuary"], ["node", "daemon-entry.js", "--package-managed-agent"]],
    [["sanctuary"], ["node", "daemon-entry.js", "--package-managed-agent", "--socket", "/tmp/ouro.sock"]],
    [["sanctuary"], ["node", "daemon-entry.js", "--package-managed-agent", "slugger"]],
    [["sanctuary"], ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary", "--package-managed-agent", "sanctuary"]],
  ])("fails closed for agents %j and argv %j", (managedAgents, argv) => {
    const { decision } = resolve({ managedAgents, argv })
    expect(decision.kind).toBe("invalid")
    if (decision.kind !== "invalid") throw new Error("expected invalid decision")
    expect(decision.failure.message).toBe("Sanctuary installation needs attention\n  human-required: roll_back_or_install_verified_release")
  })

  it("does not inspect roots or activate package behavior in development", () => {
    const decision = resolveSanctuaryPackageManagementActivation({
      mode: "dev",
      argv: ["node", "daemon-entry.js", "--package-managed-agent"],
      managedAgents: ["sanctuary", "slugger"],
      repoRoot: "relative-and-missing",
      bundlesRoot: "also-relative-and-missing",
      runtimePackageVersion: "",
    })
    expect(decision).toEqual({ kind: "inactive" })
  })

  it.each([
    ["relative repo root", ({ bundlesRoot }: ReturnType<typeof makeLayout>) => ({ repoRoot: "relative", bundlesRoot })],
    ["relative bundles root", ({ repoRoot }: ReturnType<typeof makeLayout>) => ({ repoRoot, bundlesRoot: "relative" })],
    ["empty runtime version", ({ repoRoot, bundlesRoot }: ReturnType<typeof makeLayout>) => ({ repoRoot, bundlesRoot, runtimePackageVersion: "" })],
  ])("rejects an unsafe %s without exposing a path", (_label, mutate) => {
    const layout = makeLayout()
    const decision = resolveSanctuaryPackageManagementActivation({
      mode: "production",
      argv: ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"],
      managedAgents: ["sanctuary"],
      runtimePackageVersion: VERSION,
      ...mutate(layout),
    })
    expect(decision.kind).toBe("invalid")
    if (decision.kind !== "invalid") throw new Error("expected invalid decision")
    expect(decision.failure.message).not.toContain(layout.repoRoot)
    expect(decision.failure.message).not.toContain(layout.bundlesRoot)
  })

  it("rejects missing, symlinked, or equal fixed roots", () => {
    const missing = makeLayout()
    fs.rmSync(missing.packageRoot, { recursive: true })
    expect(resolveSanctuaryPackageManagementActivation({
      mode: "production",
      argv: ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"],
      managedAgents: ["sanctuary"],
      repoRoot: missing.repoRoot,
      bundlesRoot: missing.bundlesRoot,
      runtimePackageVersion: VERSION,
    }).kind).toBe("invalid")

    const linkedPackage = makeLayout()
    const realPackage = path.join(path.dirname(linkedPackage.packageRoot), "real-sanctuary.ouro")
    fs.renameSync(linkedPackage.packageRoot, realPackage)
    fs.symlinkSync(realPackage, linkedPackage.packageRoot)
    expect(resolveSanctuaryPackageManagementActivation({
      mode: "production",
      argv: ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"],
      managedAgents: ["sanctuary"],
      repoRoot: linkedPackage.repoRoot,
      bundlesRoot: linkedPackage.bundlesRoot,
      runtimePackageVersion: VERSION,
    }).kind).toBe("invalid")

    const linkedAgent = makeLayout()
    const realAgent = path.join(path.dirname(linkedAgent.agentRoot), "real-sanctuary.ouro")
    fs.renameSync(linkedAgent.agentRoot, realAgent)
    fs.symlinkSync(realAgent, linkedAgent.agentRoot)
    expect(resolveSanctuaryPackageManagementActivation({
      mode: "production",
      argv: ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"],
      managedAgents: ["sanctuary"],
      repoRoot: linkedAgent.repoRoot,
      bundlesRoot: linkedAgent.bundlesRoot,
      runtimePackageVersion: VERSION,
    }).kind).toBe("invalid")

    const equal = makeLayout()
    const equalBundlesRoot = path.join(equal.repoRoot, "deploy", "unraid")
    expect(resolveSanctuaryPackageManagementActivation({
      mode: "production",
      argv: ["node", "daemon-entry.js", "--package-managed-agent", "sanctuary"],
      managedAgents: ["sanctuary"],
      repoRoot: equal.repoRoot,
      bundlesRoot: equalBundlesRoot,
      runtimePackageVersion: VERSION,
    }).kind).toBe("invalid")
  })

  it("invokes the shared ensure once only for an active decision", () => {
    const { decision } = resolve()
    const ensure = vi.fn(() => ({
      ok: true as const,
      data: {
        runtimePackageVersion: VERSION,
        packagedBundleVersion: VERSION,
        liveBundleVersion: VERSION,
        parity: "exact" as const,
        mismatchCodes: [],
        journalState: "absent" as const,
        ready: true,
        repair: { actor: "none" as const, action: "none" as const },
      },
    }))

    expect(prepareSanctuaryPackageManagedBundle(decision, { ensure })).toEqual(ensure.mock.results[0]?.value)
    expect(ensure).toHaveBeenCalledOnce()
    expect(ensure).toHaveBeenCalledWith({
      packageRoot: decision.kind === "active" ? decision.packageRoot : "",
      agentRoot: decision.kind === "active" ? decision.agentRoot : "",
      runtimePackageVersion: VERSION,
    })

    const inactiveEnsure = vi.fn()
    expect(prepareSanctuaryPackageManagedBundle({ kind: "inactive" }, { ensure: inactiveEnsure })).toBeUndefined()
    expect(inactiveEnsure).not.toHaveBeenCalled()
  })

  it("translates invalid activation, stale inspection, and dependency errors into controlled guidance", () => {
    const invalid = resolve({ managedAgents: [] }).decision
    const ensure = vi.fn()
    expect(() => prepareSanctuaryPackageManagedBundle(invalid, { ensure })).toThrow("human-required: roll_back_or_install_verified_release")
    expect(ensure).not.toHaveBeenCalled()

    const { decision } = resolve()
    const stale = vi.fn(() => ({
      ok: true as const,
      data: {
        runtimePackageVersion: VERSION,
        packagedBundleVersion: VERSION,
        liveBundleVersion: "old",
        parity: "mismatch" as const,
        mismatchCodes: ["managed_file_content" as const],
        journalState: "rollback" as const,
        ready: false,
        repair: { actor: "human-required" as const, action: "run_verified_update_recovery" as const },
      },
    }))
    expect(() => prepareSanctuaryPackageManagedBundle(decision, { ensure: stale })).toThrow("human-required: run_verified_update_recovery")

    const broken = vi.fn(() => { throw new Error("secret path and raw filesystem failure") })
    expect(() => prepareSanctuaryPackageManagedBundle(decision, { ensure: broken })).toThrow("human-required: run_verified_update_recovery")
    expect(() => prepareSanctuaryPackageManagedBundle(decision, { ensure: broken })).not.toThrow("secret path")

    const invalidInspection = vi.fn(() => ({ ok: false as const, error: { code: "invalid_package_source" as const, message: "verified release contents are invalid" as const, degraded: true as const, repair: { actor: "human-required" as const, action: "roll_back_or_install_verified_release" as const } } }))
    expect(() => prepareSanctuaryPackageManagedBundle(decision, { ensure: invalidInspection })).toThrow("human-required: roll_back_or_install_verified_release")

    const inconsistent = vi.fn(() => ({ ok: true as const, data: { runtimePackageVersion: VERSION, packagedBundleVersion: VERSION, liveBundleVersion: VERSION, parity: "exact" as const, mismatchCodes: [], journalState: "committing" as const, ready: false, repair: { actor: "none" as const, action: "none" as const } } }))
    expect(() => prepareSanctuaryPackageManagedBundle(decision, { ensure: inconsistent })).toThrow("human-required: run_verified_update_recovery")

    expect(() => prepareSanctuaryPackageManagedBundle(decision)).toThrow("human-required: roll_back_or_install_verified_release")
  })
})
