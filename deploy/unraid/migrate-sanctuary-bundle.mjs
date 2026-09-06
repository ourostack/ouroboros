#!/usr/bin/env node
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const USAGE = "Usage: migrate-sanctuary-bundle.mjs --package-root <path> --agent-root <path> --operation <migrate|rollback|commit|status|inspect> [--rollback-image-id <sha256:id> --target-image-id <sha256:id>]"
const BASE_KEYS = ["--package-root", "--agent-root", "--operation"]
const MIGRATE_KEYS = [...BASE_KEYS, "--rollback-image-id", "--target-image-id"]

function parseArguments(args) {
  if (args.length % 2 !== 0) throw new Error(USAGE)
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (values.has(key) || typeof value !== "string" || value.length === 0) throw new Error(USAGE)
    values.set(key, value)
  }
  const operation = values.get("--operation")
  if (!["migrate", "rollback", "commit", "status", "inspect"].includes(operation)) throw new Error(USAGE)
  const expectedKeys = operation === "migrate" ? MIGRATE_KEYS : BASE_KEYS
  if (values.size !== expectedKeys.length || expectedKeys.some((key) => !values.has(key)) || [...values.keys()].some((key) => !expectedKeys.includes(key))) throw new Error(USAGE)
  return values
}

export function runSanctuaryBundleOperation(args, dependencies) {
  const values = parseArguments(args)
  const packageRoot = values.get("--package-root")
  const agentRoot = values.get("--agent-root")
  const operation = values.get("--operation")
  const result = operation === "migrate"
    ? dependencies.migrate({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: values.get("--rollback-image-id"), targetImageId: values.get("--target-image-id") })
    : operation === "rollback"
      ? { rolledBack: dependencies.rollback(agentRoot, { retainRecord: true }) }
      : operation === "commit"
        ? { committed: dependencies.commit(agentRoot) }
        : operation === "status"
          ? dependencies.status(agentRoot)
          : dependencies.inspect({ packageRoot, agentRoot, runtimePackageVersion: dependencies.getPackageVersion() })
  if (result === null || ("rolledBack" in result && !result.rolledBack) || ("committed" in result && !result.committed)) throw new Error(`${operation} found no pending Sanctuary bundle transaction`)
  return result
}

export async function runSanctuaryBundleCli(args = process.argv.slice(2), output = process.stdout) {
  const migration = await import("../../dist/heart/daemon/sanctuary-bundle-migration.js")
  const manifest = await import("../../dist/mind/bundle-manifest.js")
  const result = runSanctuaryBundleOperation(args, {
    commit: migration.commitSanctuaryPackageManagedBundle,
    getPackageVersion: manifest.getPackageVersion,
    inspect: migration.inspectSanctuaryPackageManagedBundle,
    migrate: migration.migrateSanctuaryPackageManagedBundle,
    rollback: migration.rollbackSanctuaryPackageManagedBundle,
    status: migration.inspectSanctuaryPackageManagedBundleRollback,
  })
  output.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runSanctuaryBundleCli()
