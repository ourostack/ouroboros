import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  ensureSanctuaryPackageManagedBundle,
  inspectSanctuaryDirectoryFromBase,
  sanctuaryDirectoriesShareIdentity,
  type SanctuaryPackageManagedBundleInspection,
} from "./sanctuary-bundle-migration"
import { createSanctuaryBundlePreparationFailure } from "./daemon-bootstrap-startup"

export type SanctuaryPackageManagementDecision =
  | { kind: "inactive" }
  | { kind: "active"; packageRoot: string; agentRoot: string; runtimePackageVersion: string }
  | { kind: "invalid"; failure: Error }

export function resolveSanctuaryPackageManagedRoots(input: { repoRoot: string; bundlesRoot: string }): { packageRoot: string; agentRoot: string } {
  return {
    packageRoot: path.join(input.repoRoot, "deploy", "unraid", "sanctuary.ouro"),
    agentRoot: path.join(input.bundlesRoot, "sanctuary.ouro"),
  }
}

function invalidDecision(): SanctuaryPackageManagementDecision {
  return { kind: "invalid", failure: createSanctuaryBundlePreparationFailure("roll_back_or_install_verified_release") }
}

export function resolveSanctuaryPackageManagementActivation(input: {
  mode: "dev" | "production"
  argv: string[]
  managedAgents: readonly string[]
  repoRoot: string
  bundlesRoot: string
  runtimePackageVersion: string
}): SanctuaryPackageManagementDecision {
  if (input.mode !== "production") return { kind: "inactive" }
  const indices = input.argv.flatMap((value, index) => value === "--package-managed-agent" ? [index] : [])
  if (indices.length === 0) return { kind: "inactive" }
  if (indices.length !== 1) return invalidDecision()
  const value = input.argv[indices[0]! + 1]
  if (value !== "sanctuary" || input.managedAgents.length !== 1 || input.managedAgents[0] !== "sanctuary") return invalidDecision()
  if (!path.isAbsolute(input.repoRoot) || !path.isAbsolute(input.bundlesRoot) || input.runtimePackageVersion.trim() !== input.runtimePackageVersion || input.runtimePackageVersion.length === 0) return invalidDecision()
  const roots = resolveSanctuaryPackageManagedRoots(input)
  try {
    const packageIdentity = inspectSanctuaryDirectoryFromBase(input.repoRoot, ["deploy", "unraid", "sanctuary.ouro"])
    const agentIdentity = inspectSanctuaryDirectoryFromBase(input.bundlesRoot, ["sanctuary.ouro"])
    if (!packageIdentity || !agentIdentity || sanctuaryDirectoriesShareIdentity(packageIdentity, agentIdentity)) return invalidDecision()
  } catch {
    return invalidDecision()
  }
  return { kind: "active", ...roots, runtimePackageVersion: input.runtimePackageVersion }
}

export function requireSanctuaryPackageManagementDecision(decision: SanctuaryPackageManagementDecision): asserts decision is Exclude<SanctuaryPackageManagementDecision, { kind: "invalid" }> {
  if (decision.kind === "invalid") throw decision.failure
}

export function prepareSanctuaryPackageManagedBundle(
  decision: SanctuaryPackageManagementDecision,
  deps: { ensure?: typeof ensureSanctuaryPackageManagedBundle } = {},
): SanctuaryPackageManagedBundleInspection | undefined {
  requireSanctuaryPackageManagementDecision(decision)
  if (decision.kind === "inactive") return undefined
  let inspection: SanctuaryPackageManagedBundleInspection
  try {
    inspection = (deps.ensure ?? ensureSanctuaryPackageManagedBundle)({
      packageRoot: decision.packageRoot,
      agentRoot: decision.agentRoot,
      runtimePackageVersion: decision.runtimePackageVersion,
    })
  } catch {
    throw createSanctuaryBundlePreparationFailure("run_verified_update_recovery")
  }
  if (!inspection.ok || !inspection.data.ready) {
    const action = inspection.ok ? inspection.data.repair.action : inspection.error.repair.action
    throw createSanctuaryBundlePreparationFailure(action === "none" ? "run_verified_update_recovery" : action)
  }
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_package_management_prepared", message: "prepared Sanctuary package-managed bundle", meta: { runtimePackageVersion: inspection.data.runtimePackageVersion, journalState: inspection.data.journalState } })
  return inspection
}
