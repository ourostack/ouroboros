/**
 * The eval's side of the host lock (deploy/unraid/ouro-host-lock.mjs, #1760). With `--host-lock`, the command holds the
 * remote host's lock for its whole run over one ssh session (`hold`), so a dropped session frees it, and sends the
 * token with every job. On the host, `runSandboxed` checks that the token still holds a live lock before it creates
 * anything; the Butler's upgrade and rollback wait while anyone else holds it.
 */
import { execFile } from "node:child_process"
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { HostLock } from "./docker"
import type { RemoteProcess } from "./remote"

/** The lock script, beside this file's package root, in a checkout and in the synced harness on the host alike. */
export const HOST_LOCK_SCRIPT = path.resolve(__dirname, "../../../deploy/unraid/ouro-host-lock.mjs")
/** How long the lock lasts if the holder hangs without its session dropping: a whole replay fits well inside. */
export const HOST_LOCK_TTL_S = 6 * 60 * 60
/** How long to wait for a Butler ship that holds the lock before giving up. */
export const HOST_LOCK_WAIT_S = 30 * 60

export type HeldHostLock = { token: string; release(): Promise<void> }

/** Starts the remote `hold`, waits for its token, and returns it with a release that ends the session. */
export async function holdHostLock(start: () => RemoteProcess): Promise<HeldHostLock> {
  const proc = start()
  let out = ""
  const token = await new Promise<string | undefined>((resolve) => {
    proc.stdout.setEncoding("utf8")
    proc.stdout.on("data", (chunk: string) => {
      out += chunk
      const acquired = /^@@LOCK acquired ([0-9a-f]{32})$/m.exec(out)
      if (acquired) resolve(acquired[1])
    })
    void proc.exited.then(() => resolve(undefined))
  })
  if (!token) {
    const held = /^@@LOCK held (.+)$/m.exec(out)
    const code = await proc.exited
    const error = held ? `the host lock is held by ${held[1]}` : `could not take the host lock: ${proc.stderr().trim().split("\n").at(-1) || `exit ${code}`}`
    emitNervesEvent({ component: "eval", level: "error", event: "eval.host_lock_refused", message: "the eval could not take the host lock", meta: { error } })
    throw new Error(error)
  }
  emitNervesEvent({ component: "eval", event: "eval.host_lock_held", message: "the eval holds the host lock", meta: {} })
  return {
    token,
    release: async () => {
      proc.stdin.end()
      await proc.exited
      emitNervesEvent({ component: "eval", event: "eval.host_lock_released", message: "the eval released the host lock", meta: {} })
    },
  }
}

/** On the host: held while this token holds a live lock there. */
export function localHostLock(token: string, env: NodeJS.ProcessEnv = process.env): HostLock {
  return {
    held: () => new Promise<boolean>((resolve) => {
      execFile(process.execPath, [HOST_LOCK_SCRIPT, "check", "--token", token], { env }, (error) => resolve(!error))
    }),
  }
}
