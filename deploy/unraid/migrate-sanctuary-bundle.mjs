#!/usr/bin/env node
import { commitSanctuaryPackageManagedBundle, inspectSanctuaryPackageManagedBundleRollback, migrateSanctuaryPackageManagedBundle, rollbackSanctuaryPackageManagedBundle } from "../../dist/heart/daemon/sanctuary-bundle-migration.js"

const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], process.argv[index + 1])
if ((values.size !== 3 && values.size !== 5) || !values.get("--package-root") || !values.get("--agent-root") || !values.get("--operation")) {
  throw new Error("Usage: migrate-sanctuary-bundle.mjs --package-root <path> --agent-root <path> --operation <migrate|rollback|commit|status> [--rollback-image-id <sha256:id> --target-image-id <sha256:id>]")
}

const operation = values.get("--operation")
const result = operation === "migrate"
  ? migrateSanctuaryPackageManagedBundle({ packageRoot: values.get("--package-root"), agentRoot: values.get("--agent-root"), retainRollback: true, rollbackImageId: values.get("--rollback-image-id"), targetImageId: values.get("--target-image-id") })
  : operation === "rollback"
    ? { rolledBack: rollbackSanctuaryPackageManagedBundle(values.get("--agent-root"), { retainRecord: true }) }
    : operation === "commit"
      ? { committed: commitSanctuaryPackageManagedBundle(values.get("--agent-root")) }
      : operation === "status"
        ? inspectSanctuaryPackageManagedBundleRollback(values.get("--agent-root"))
        : (() => { throw new Error("operation must be migrate, rollback, commit, or status") })()
if (result === null || ("rolledBack" in result && !result.rolledBack) || ("committed" in result && !result.committed)) throw new Error(`${operation} found no pending Sanctuary bundle transaction`)
process.stdout.write(`${JSON.stringify(result)}\n`)
