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
      throw Object.assign(new Error("expected fixed inspect, apply, or rollback arguments"), { code: "usage" })
    }
    // A step that didn't finish says so in its code: not-applied left the session as it was, indeterminate can't tell.
    const unfinished = result.status === "indeterminate" ? "indeterminate" : result.status === "not_applied" ? "not-applied" : undefined
    process.stdout.write(`${JSON.stringify(unfinished ? { ...result, code: unfinished } : result)}\n`)
    process.exitCode = unfinished ? 1 : 0
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code === "usage" ? "usage" : "repair-refused"
    process.stdout.write(`${JSON.stringify({ status: "refused", code, error: (error instanceof Error ? error.message : String(error)).slice(0, 512) })}\n`)
    process.exitCode = 2
  }
}

void main()
