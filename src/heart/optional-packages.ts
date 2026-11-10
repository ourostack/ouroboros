import { emitNervesEvent } from "../nerves/runtime"

/**
 * Product SDKs listed in package.json optionalDependencies. npm installs them by default; a small
 * host can leave them out with `npm install --omit=optional` (about 97 MB and 138 packages), and
 * only the feature that needs one stops working.
 */
export const OPTIONAL_PACKAGES = [
  "@azure/identity",
  "@azure/storage-blob",
  "@microsoft/teams.api",
  "@microsoft/teams.apps",
  "@microsoft/teams.cards",
  "@microsoft/teams.common",
  "@microsoft/teams.dev",
  "@microsoft/teams.graph",
  "mailparser",
  "smtp-server",
  "stripe",
] as const

export type OptionalPackage = (typeof OPTIONAL_PACKAGES)[number]

export class OptionalPackageMissingError extends Error {
  constructor(readonly packageName: OptionalPackage, readonly feature: string) {
    super(
      `${feature} needs ${packageName}, an optional package this install left out (npm --omit=optional). ` +
      "Reinstall @ouro.bot/cli without --omit=optional to use it.",
    )
    this.name = "OptionalPackageMissingError"
  }
}

/** The optional package an error says is missing, or null for any other error (including a missing file inside a package). */
export function missingOptionalPackage(error: unknown): OptionalPackage | null {
  const message = error instanceof Error ? error.message : String(error)
  return OPTIONAL_PACKAGES.find((name) => message.includes(`Cannot find module '${name}'`)) ?? null
}

function reportMissing(packageName: OptionalPackage, feature: string): OptionalPackageMissingError {
  const missing = new OptionalPackageMissingError(packageName, feature)
  emitNervesEvent({
    level: "error",
    component: "engine",
    event: "engine.optional_package_missing",
    message: missing.message,
    meta: { package: packageName, feature },
  })
  return missing
}

/** Load an optional package, turning its absence into an error that names the feature and the fix. */
export async function importOptional<T>(packageName: OptionalPackage, feature: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (missingOptionalPackage(error) !== packageName) throw error
    throw reportMissing(packageName, feature)
  }
}

/** The message a sense entry point prints when it fails to start: the plain error, or what to do when an optional package is absent. */
export function describeStartupError(error: unknown, feature: string): string {
  const packageName = missingOptionalPackage(error)
  if (packageName) return reportMissing(packageName, feature).message
  return error instanceof Error ? error.message : String(error)
}
