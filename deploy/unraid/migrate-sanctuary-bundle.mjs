#!/usr/bin/env node
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const USAGE = "Usage: migrate-sanctuary-bundle.mjs --package-root <path> --agent-root <path> --operation <migrate|seed|rollback|finalize-rollback|commit|status|inspect> [--rollback-image-id <sha256:id> --target-image-id <sha256:id> [--butler-name <butler|sanctuary>]]"
const BASE_KEYS = ["--package-root", "--agent-root", "--operation"]
const MIGRATE_KEYS = [...BASE_KEYS, "--rollback-image-id", "--target-image-id"]
// The Butler the image being installed runs. The host's bundle folder keeps its name, so the migrate is told which
// container path the bundle's own files should name; without it, the agent root's folder name says.
const BUTLER_NAME_KEY = "--butler-name"
const BUTLER_NAMES = ["butler", "sanctuary"]

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
  if (!["migrate", "seed", "rollback", "finalize-rollback", "commit", "status", "inspect"].includes(operation)) throw new Error(USAGE)
  const expectedKeys = operation === "migrate" ? (values.has(BUTLER_NAME_KEY) ? [...MIGRATE_KEYS, BUTLER_NAME_KEY] : MIGRATE_KEYS) : BASE_KEYS
  if (values.has(BUTLER_NAME_KEY) && !BUTLER_NAMES.includes(values.get(BUTLER_NAME_KEY))) throw new Error(USAGE)
  if (values.size !== expectedKeys.length || expectedKeys.some((key) => !values.has(key)) || [...values.keys()].some((key) => !expectedKeys.includes(key))) throw new Error(USAGE)
  return values
}

export function runSanctuaryBundleOperation(args, dependencies) {
  const values = parseArguments(args)
  const packageRoot = values.get("--package-root")
  const agentRoot = values.get("--agent-root")
  const operation = values.get("--operation")
  const result = operation === "migrate"
    ? dependencies.migrate({ packageRoot, agentRoot, retainRollback: true, rollbackImageId: values.get("--rollback-image-id"), targetImageId: values.get("--target-image-id"), ...(values.has(BUTLER_NAME_KEY) ? { butlerName: values.get(BUTLER_NAME_KEY) } : {}) })
    // A fresh install has no earlier image to roll back to, so it writes the packaged files without a rollback record.
    : operation === "seed"
      ? dependencies.migrate({ packageRoot, agentRoot, retainRollback: false })
    : operation === "rollback"
      ? { rolledBack: dependencies.rollback(agentRoot, { retainRecord: true }) }
      // `rollback` keeps crash-retry evidence; the host uses `finalize-rollback` only after old production is audited, ready, and restored to autostart.
      : operation === "finalize-rollback"
        ? { rolledBack: dependencies.rollback(agentRoot, { retainRecord: false }) }
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
