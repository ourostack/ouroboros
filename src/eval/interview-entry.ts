/**
 * `npm run interviews -- <flags>` (see `interviews/runner.ts` for the flags and refusals): runs blind-interview sessions
 * from the pre-registration's Appendix B on one model target, writes the private report and the private request log
 * (both opened `wx`, mode 0600, under a 0700 folder) and prints a counts-only summary. With `--sandbox-ssh
 * <host>:<folder>` the sandbox runs on that Docker host, whose harness checkout is synced to `<folder>/harness`;
 * `--bundle` and `--seed-bundle` are then paths on that host. Model calls and credentials stay on this machine.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { loadCases } from "./self-test"
import { writePrivateReport } from "./report"
import { dockerCli, runSandboxed, type SandboxImages } from "./sandbox/docker"
import { remoteRunCase, sshStart, type RunCase } from "./sandbox/remote"
import { resolveTarget } from "./targets"
import { parseInterviewArgs, runInterviews, X_KIT } from "./interviews/runner"

const REPO = path.resolve(__dirname, "../..")

function take(argv: string[], flag: string): { value: string | undefined; rest: string[] } {
  const at = argv.indexOf(flag)
  if (at < 0) return { value: undefined, rest: argv }
  return { value: argv[at + 1], rest: [...argv.slice(0, at), ...argv.slice(at + 2)] }
}

function runCaseFor(sandboxSsh: string | undefined, bundle: string, seedBundle: string | undefined, images: SandboxImages | undefined): RunCase {
  if (sandboxSsh) {
    const split = sandboxSsh.indexOf(":")
    if (split < 1) throw new Error("--sandbox-ssh must be <host>:<folder>")
    const host = sandboxSsh.slice(0, split)
    const root = sandboxSsh.slice(split + 1)
    return remoteRunCase({
      start: sshStart(host, `${root}/harness/dist/eval/remote-entry.js`),
      paths: { bundleDir: bundle, seedBundleDir: seedBundle ?? `${root}/harness/deploy/unraid/sanctuary.ouro`, workRoot: `${root}/work`, ...(images ? { images } : {}) },
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
  if (!bundle.value) throw new Error("--bundle is required")
  const [agent, household] = tags.value?.split(",") ?? []
  if (tags.value && !(agent && household)) throw new Error("--images must be <agent image>,<household image>")
  const images = agent && household ? { agent, household } : undefined
  const args = parseInterviewArgs(tags.rest)
  const { exitCode } = await runInterviews(args, {
    readText: (file) => fs.readFileSync(file, "utf8"),
    loadCases,
    resolveTarget: (spec, creds) => resolveTarget(spec, creds),
    runCase: runCaseFor(ssh.value, bundle.value, seed.value, images),
    kits: { X: X_KIT },
    outputExists: (file) => fs.existsSync(file),
    writeReport: writePrivateReport,
    openLog: openPrivateLog,
    started: startedSessions(),
    print: (text) => { process.stdout.write(`${text}\n`) },
  })
  return exitCode
}

main().then((code) => {
  if (code === 2) process.stderr.write("code: budget-stopped\n")
  process.exitCode = code
}).catch((error: unknown) => {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.interview_entry_error", message: "the interviews command failed", meta: { error: error instanceof Error ? error.message : String(error) } })
  process.stderr.write(`interviews: ${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write("code: eval-error\n")
  process.exitCode = 1
})
