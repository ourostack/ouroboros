/**
 * `npm run eval:stop -- --sandbox-ssh <host>:<folder>`: the eval's stop button for a Docker host. Over ssh it removes
 * every container, network and image labelled `ouro.eval=1` (both eval images carry the label from
 * deploy/eval/Dockerfile), frees the host lock when an eval or interview batch holds it (a holder starting with
 * "eval"; never a Butler's or a person's, see `free-eval` in deploy/unraid/ouro-host-lock.mjs, run from
 * `<folder>/harness`), then reads back that no labelled container, network or image remains and that no eval holds
 * the lock ("other" holders may). It prints counts only.
 *
 * It doesn't stop a batch on this machine; `~/.ouro-eval/STOP` does that (`kill-switch.ts`). A batch whose sandbox
 * disappears stops on its own with "the sandbox failed".
 */
import { emitNervesEvent } from "../nerves/runtime"
import { EVAL_LABEL } from "./sandbox/docker"

/** Runs one command on the host and answers its exit code and output. */
export type HostRun = (argv: string[]) => Promise<{ code: number; stdout: string }>

export type StopTarget = { host: string; root: string }

const USAGE = "usage: npm run eval:stop -- --sandbox-ssh <host>:<folder>"
const KINDS = [
  { name: "containers", list: ["docker", "ps", "-aq"], remove: ["docker", "rm", "-f"] },
  { name: "networks", list: ["docker", "network", "ls", "-q"], remove: ["docker", "network", "rm"] },
  { name: "images", list: ["docker", "images", "-q"], remove: ["docker", "rmi", "-f"] },
] as const

/** Reads `--sandbox-ssh <host>:<folder>`; both are sent over ssh, so only plain names and absolute paths pass. */
export function parseStopArgs(argv: readonly string[]): StopTarget {
  if (argv.length !== 2 || argv[0] !== "--sandbox-ssh") throw new Error(USAGE)
  const spec = argv[1]!
  const split = spec.indexOf(":")
  const host = spec.slice(0, Math.max(split, 0))
  const root = spec.slice(split + 1)
  if (!/^\w[\w.@-]*$/.test(host) || !/^\/[\w./-]*$/.test(root) || root.split("/").includes("..")) throw new Error(`${USAGE} (a plain host name and an absolute folder)`)
  return { host, root }
}

async function must(run: HostRun, argv: string[]): Promise<string> {
  const { code, stdout } = await run(argv)
  if (code !== 0) throw new Error(`${argv[0] === "node" ? `host lock ${argv[2]}` : argv.slice(0, 3).join(" ")} exited ${code}`)
  return stdout
}

const ids = (stdout: string): string[] => [...new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean))]

async function labelled(run: HostRun): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {}
  for (const kind of KINDS) found[kind.name] = ids(await must(run, [...kind.list, "--filter", `label=${EVAL_LABEL}`]))
  return found
}

export type StopResult = { exitCode: number; removed: Record<string, number>; lock: string; remaining: Record<string, number> }

export async function runStopCommand(target: StopTarget, run: HostRun, print: (text: string) => void): Promise<StopResult> {
  const lockScript = `${target.root}/harness/deploy/unraid/ouro-host-lock.mjs`
  const found = await labelled(run)
  const removed: Record<string, number> = {}
  for (const kind of KINDS) {
    const list = found[kind.name]!
    if (list.length > 0) await must(run, [...kind.remove, ...list])
    removed[kind.name] = list.length
  }
  const freed = (await must(run, ["node", lockScript, "free-eval"])).trim()
  const left = await labelled(run)
  const remaining = Object.fromEntries(KINDS.map((kind) => [kind.name, left[kind.name]!.length]))
  const status = (await must(run, ["node", lockScript, "status"])).trim()
  const lockState = /^@@LOCK (free|eval|other)\b/.exec(status)?.[1] ?? "unknown"
  const lock = freed.startsWith("@@LOCK freed") ? `freed, now ${lockState}` : lockState
  const clean = Object.values(remaining).every((n) => n === 0) && (lockState === "free" || lockState === "other")
  print(`removed ${removed.containers} containers, ${removed.networks} networks and ${removed.images} images labelled ${EVAL_LABEL} on ${target.host}`)
  print(`host lock: ${lock}`)
  print(clean ? "read back: none remain" : `read back: ${remaining.containers} containers, ${remaining.networks} networks and ${remaining.images} images remain; host lock ${lockState}`)
  emitNervesEvent({ component: "eval", level: clean ? "info" : "error", event: "eval.stop_command", message: "eval:stop ran on a Docker host", meta: { removed, remaining, lock: lockState } })
  return { exitCode: clean ? 0 : 1, removed, lock, remaining }
}
