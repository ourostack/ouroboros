/**
 * The command line of `npm run eval:watch -- --agent-root <path> [--out <folder>]`, kept apart from the entry file so
 * its tests can check exactly what it prints. It prints the report as JSON, or on failure one line naming the error
 * code only, so no path or log text reaches the terminal.
 */
import os from "node:os"
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { stopFile, stopRequested } from "../kill-switch"
import { createGuardedFs } from "./guarded-fs"
import { runWatch, type WatchOptions } from "./run-watch"

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  homedir: string
}

const USAGE = "usage: npm run eval:watch -- --agent-root <path> [--out <folder>]\n"

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

/**
 * Runs Watch once and returns the exit code: 0 on success, 2 for bad arguments, 3 when the kill switch
 * (`~/.ouro-eval/STOP`) is set, which it checks before reading anything, and 1 for any other failure.
 */
export function watchCli(args: readonly string[], io: CliIo, extra: Partial<WatchOptions> = {}): number {
  if (stopRequested(stopFile(io.homedir)) !== undefined) {
    io.stderr("Watch stopped: the eval kill switch ~/.ouro-eval/STOP is set, so nothing was read.\n")
    return 3
  }
  const agentRootArg = argument(args, "--agent-root")
  if (!agentRootArg) {
    io.stderr(USAGE)
    return 2
  }
  try {
    const agentRoot = path.resolve(agentRootArg)
    const agent = path.basename(agentRoot).replace(/\.ouro$/, "")
    const privateDir = path.resolve(argument(args, "--out") ?? path.join(io.homedir, ".ouro-eval", "watch", agent))
    const gfs = createGuardedFs({ protectedRoots: [path.join(io.homedir, "AgentBundles"), agentRoot], privateDir })
    const report = runWatch({ agentRoot, gfs, ...extra })
    io.stdout(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    const label = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : "refused or failed"
    emitNervesEvent({ level: "error", component: "eval", event: "eval.watch_failed", message: "Watch failed", meta: { code: label } })
    io.stderr(`Watch failed (${label}); nothing was written outside its private folder.\n`)
    return 1
  }
}

/** Lowers this process to the lowest CPU priority; Watch still runs if the system refuses. */
export function lowerPriority(setPriority: (priority: number) => void = os.setPriority): void {
  try {
    setPriority(19)
  } catch {
    // Lowering one's own priority doesn't fail on macOS or Linux; if it does, Watch still runs.
  }
}
