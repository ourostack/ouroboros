import { emitNervesEvent } from "../nerves/runtime"
import { applyA003SessionRepair, inspectA003SessionRepair, rollbackA003SessionRepair } from "./session-redaction-repair"

// Deliberately a direct packaged entrypoint, never public CLI/model routing.
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  emitNervesEvent({ component: "heart", event: "heart.session_redaction_repair_cli", message: "private fixed repair entrypoint invoked", meta: { argumentCount: args.length } })
  try {
    let result
    if (args.length === 7 && args[0] === "inspect" && args[1] === "--agent" && args[3] === "--session" && args[5] === "--artifacts-dir") {
      result = await inspectA003SessionRepair({ agent: args[2]!, sessionPath: args[4]!, artifactsDir: args[6]! })
    } else if (args.length === 4 && args[0] === "apply" && args[1] === "--manifest-sha256") {
      result = await applyA003SessionRepair({ manifestSha256: args[2]!, manifestPath: args[3]! })
    } else if (args.length === 5 && args[0] === "rollback" && args[1] === "--manifest-sha256") {
      result = await rollbackA003SessionRepair({ manifestSha256: args[2]!, manifestPath: args[3]!, preimagePath: args[4]! })
    } else {
      throw new Error("expected fixed inspect, apply, or rollback arguments")
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.status === "indeterminate" || result.status === "not_applied" ? 1 : 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "refused", error: (error instanceof Error ? error.message : String(error)).slice(0, 512) })}\n`)
    process.exitCode = 2
  }
}

void main()
