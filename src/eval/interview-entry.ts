/**
 * `npm run interviews -- <flags>` (see `interviews/runner.ts` for the flags and refusals): runs blind-interview sessions
 * from the pre-registration's Appendix B on one model target, writes the private report and the private request log
 * (both opened `wx`, mode 0600, under a 0700 folder) and prints a counts-only summary. With `--sandbox-ssh
 * <host>:<folder>` the sandbox runs on that Docker host, whose harness checkout is synced to `<folder>/harness`;
 * `--bundle` and `--seed-bundle` are then paths on that host. `--host-lock <holder>` holds that host's lock
 * (deploy/unraid/ouro-host-lock.mjs) for the whole command, as `run-entry` does, so the Butler's upgrade and rollback
 * wait for it and the sandbox runs on the Butler's host only while it does. Model calls and credentials stay on this
 * machine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { loadCases } from "./self-test"
import { writePrivateReport } from "./report"
import { dockerCli, runSandboxed, type SandboxImages } from "./sandbox/docker"
import { holdHostLock, HOST_LOCK_TTL_S, HOST_LOCK_WAIT_S, type HeldHostLock } from "./sandbox/host-lock"
import { remoteRunCase, sshNode, sshStart, type RunCase } from "./sandbox/remote"
import { resolveTarget } from "./targets"
import { parseInterviewArgs, runInterviews, X_KIT } from "./interviews/runner"

const REPO = path.resolve(__dirname, "../..")

function take(argv: string[], flag: string): { value: string | undefined; rest: string[] } {
  const at = argv.indexOf(flag)
  if (at < 0) return { value: undefined, rest: argv }
  return { value: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] }
}

function sshTarget(spec: string): { host: string; root: string } {
  const split = spec.indexOf(":")
  if (split < 1) throw new Error("--sandbox-ssh must be <host>:<folder>")
  return { host: spec.slice(0, split), root: spec.slice(split + 1) }
}

function runCaseFor(sandboxSsh: string | undefined, bundle: string, seedBundle: string | undefined, images: SandboxImages | undefined, hostLockToken: string | undefined): RunCase {
  if (sandboxSsh) {
    const { host, root } = sshTarget(sandboxSsh)
    return remoteRunCase({
      start: sshStart(host, `${root}/harness/dist/eval/remote-entry.js`),
      paths: {
        bundleDir: bundle, seedBundleDir: seedBundle ?? `${root}/harness/deploy/unraid/sanctuary.ouro`, workRoot: `${root}/work`,
        ...(images ? { images } : {}),
        ...(hostLockToken ? { hostLockToken } : {}),
      },
    })
  }
  const docker = dockerCli()
  return ({ case: c, host, budget, guest }) => runSandboxed({
    case: c, bundleDir: bundle, seedBundleDir: seedBundle ?? path.join(REPO, "deploy/unraid/sanctuary.ouro"), host, budget, docker, ...(guest ? { guest } : {}), ...(images ? { images } : {}),
  })
}

function openPrivateLog(file: string): (line: string) => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(file), 0o700)
  const fd = fs.openSync(file, "wx", 0o600)
  return (line) => { fs.writeSync(fd, `${line}\n`) }
}

/** Every session ever started on this machine, one id per line, appended before the session reserves its budget. */
const STARTED = path.join(os.homedir(), ".ouro-eval", "reports", "interview-sessions-started.txt")

function startedSessions(): { has(id: string): boolean; add(id: string): void } {
  const ids = (): string[] => fs.existsSync(STARTED) ? fs.readFileSync(STARTED, "utf8").split("\n") : []
  return {
    has: (id) => ids().includes(id),
    add: (id) => {
      fs.mkdirSync(path.dirname(STARTED), { recursive: true, mode: 0o700 })
      const fd = fs.openSync(STARTED, "a", 0o600)
      fs.writeSync(fd, `${id}\n`)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
    },
  }
}

async function main(): Promise<number> {
  const ssh = take(process.argv.slice(2), "--sandbox-ssh")
  const bundle = take(ssh.rest, "--bundle")
  const seed = take(bundle.rest, "--seed-bundle")
  // `--images <agent>,<household>`: image tags of this run's own, so a run never uses images another checkout built.
  const tags = take(seed.rest, "--images")
  const hostLock = take(tags.rest, "--host-lock")
  if (!bundle.value) throw new Error("--bundle is required")
  if (hostLock.value && !ssh.value) throw new Error("--host-lock needs --sandbox-ssh")
  const [agent, household] = tags.value?.split(",") ?? []
  if (tags.value && !(agent && household)) throw new Error("--images must be <agent image>,<household image>")
  const images = agent && household ? { agent, household } : undefined
  const args = parseInterviewArgs(hostLock.rest)
  let lock: HeldHostLock | undefined
  if (hostLock.value && ssh.value) {
    const { host, root } = sshTarget(ssh.value)
    lock = await holdHostLock(sshNode(host, [`${root}/harness/deploy/unraid/ouro-host-lock.mjs`, "hold", "--holder", hostLock.value, "--ttl", String(HOST_LOCK_TTL_S), "--wait", String(HOST_LOCK_WAIT_S)]))
  }
  try {
    return await interviews(args, runCaseFor(ssh.value, bundle.value, seed.value, images, lock?.token))
  } finally {
    await lock?.release()
  }
}

async function interviews(args: ReturnType<typeof parseInterviewArgs>, runCase: RunCase): Promise<number> {
  const { exitCode } = await runInterviews(args, {
    readText: (file) => fs.readFileSync(file, "utf8"),
    loadCases,
    resolveTarget: (spec, creds) => resolveTarget(spec, creds),
    runCase,
    kits: { X: X_KIT },
    outputExists: (file) => fs.existsSync(file),
    writeReport: writePrivateReport,
    openLog: openPrivateLog,
    started: startedSessions(),
    print: (text) => { process.stdout.write(`${text}\n`) },
  })
  return exitCode
}

const STOPPED = "budget-stopped"
const FAILED = "eval-error"

main().then((code) => {
  if (code === 2) process.stderr.write(`code: ${STOPPED}\n`)
  process.exitCode = code
}).catch((error: unknown) => {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.interview_entry_error", message: "the interviews command failed", meta: { error: error instanceof Error ? error.message : String(error) } })
  process.stderr.write(`interviews: ${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write(`code: ${FAILED}\n`)
  process.exitCode = 1
})
