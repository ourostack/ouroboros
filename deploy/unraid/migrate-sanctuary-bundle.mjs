#!/usr/bin/env node
import { migrateSanctuaryPackageManagedBundle } from "../../dist/heart/daemon/sanctuary-bundle-migration.js"

const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index], process.argv[index + 1])
if (values.size !== 2 || !values.get("--package-root") || !values.get("--agent-root")) {
  throw new Error("Usage: migrate-sanctuary-bundle.mjs --package-root <path> --agent-root <path>")
}

const result = migrateSanctuaryPackageManagedBundle({ packageRoot: values.get("--package-root"), agentRoot: values.get("--agent-root") })
process.stdout.write(`${JSON.stringify(result)}\n`)
