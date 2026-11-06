import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

function defaultRuntimeRoot(): string {
  return path.resolve(__dirname, "../..")
}

interface RuntimeCwdDeps {
  cwd(): string
  chdir(target: string): void
  existsSync(target: string): boolean
}

const defaultDeps: RuntimeCwdDeps = {
  cwd: process.cwd.bind(process),
  chdir: process.chdir.bind(process),
  existsSync: fs.existsSync,
}

export function recoverRuntimeCwd(
  fallback: string = defaultRuntimeRoot(),
  deps: RuntimeCwdDeps = defaultDeps,
): string {
  try {
    return deps.cwd()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    let recovered = false
    let resolved = fallback
    let repairReason: string | undefined

    try {
      if (deps.existsSync(fallback)) {
        deps.chdir(fallback)
        resolved = deps.cwd()
        recovered = true
      } else {
        repairReason = "fallback cwd does not exist"
      }
    } catch (repairError) {
      repairReason = repairError instanceof Error ? repairError.message : String(repairError)
    }

    emitNervesEvent({
      level: recovered ? "warn" : "error",
      component: "heart",
      event: "heart.cwd_recovery",
      message: recovered
        ? "recovered process cwd after the previous working directory disappeared"
        : "process cwd disappeared and could not be repaired automatically",
      meta: {
        reason,
        fallback,
        resolved,
        recovered,
        ...(repairReason ? { repairReason } : {}),
      },
    })

    return resolved
  }
}
