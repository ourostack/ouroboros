import * as nodeModule from "node:module"
import * as os from "node:os"
import * as path from "node:path"

type EnableCompileCache = (directory?: string) => { status: number; message?: string; directory?: string }

/* v8 ignore next -- only Node 22.0 lacks it; tests pass null for that case @preserve */
const nodeEnableCompileCache = (nodeModule as { enableCompileCache?: EnableCompileCache }).enableCompileCache ?? null

/**
 * Turns on Node's on-disk compile cache for a short-lived CLI process, so `ouro` commands do not recompile the
 * harness on every run. The cache lives under ~/.ouro-cli rather than Node's default in the OS temp directory, which
 * is RAM-backed (tmpfs) on small Linux devices. NODE_COMPILE_CACHE picks another directory and
 * NODE_DISABLE_COMPILE_CACHE turns it off, as with Node itself. Returns the directory in use, or null.
 *
 * Only the CLI entry points load this. The daemon and agent processes are long-lived, where a code cache costs more
 * resident memory (about 5 MiB idle, 9 MiB at a turn's peak in the edge benchmark) than its one-time startup saving
 * is worth on a 1 GB device; so the directory is deliberately not exported to child processes.
 *
 * Kept free of project imports: entry points import it first, before any other module is compiled.
 */
export function enableOuroCompileCache(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  enable: EnableCompileCache | null = nodeEnableCompileCache,
): string | null {
  if (env.NODE_DISABLE_COMPILE_CACHE || !enable) return null
  const directory = env.NODE_COMPILE_CACHE || path.join(homeDir, ".ouro-cli", "cache", "node-compile")
  let result: ReturnType<EnableCompileCache>
  try {
    result = enable(directory)
  } catch {
    return null
  }
  return result.directory ?? null
}

/** The compile cache directory this process uses, or null; the entry point reports it in its start event. */
export const ouroCompileCacheDirectory = enableOuroCompileCache()
