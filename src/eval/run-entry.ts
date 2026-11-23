/**
 * `npm run eval -- <flags>` (see `run-command.ts` for the flags and the refusals): runs eval cases on one model target
 * and writes the private report. With `--sandbox-ssh <host>:<folder>` the sandbox runs on that Docker host, whose
 * harness checkout is synced to `<folder>/harness`; `--bundle`, `--seed-bundle` and `--oracle-books` are then paths
 * on that host. Model calls and credentials stay on this machine.
 */
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { parseEvalArgs, runEvalCommand, type EvalArgs } from "./run-command"
import { writePrivateReport } from "./report"
import { dockerCli, HOUSEHOLD_IMAGE, runSandboxed } from "./sandbox/docker"
import { dockerOracle } from "./sandbox/oracle"
import { remoteRunCase, sshStart, type RunCase } from "./sandbox/remote"
import { resolveTarget } from "./targets"

const REPO = path.resolve(__dirname, "../..")

function runCaseFor(args: EvalArgs): RunCase {
  if (args.sandboxSsh) {
    const split = args.sandboxSsh.indexOf(":")
    if (split < 1) throw new Error("--sandbox-ssh must be <host>:<folder>")
    const host = args.sandboxSsh.slice(0, split)
    const root = args.sandboxSsh.slice(split + 1)
    return remoteRunCase({
      start: sshStart(host, `${root}/harness/dist/eval/remote-entry.js`),
      paths: {
        bundleDir: args.bundle, seedBundleDir: args.seedBundle ?? `${root}/harness/deploy/unraid/sanctuary.ouro`, workRoot: `${root}/work`,
        ...(args.oracleBooks ? { oracleBooks: args.oracleBooks } : {}),
        ...(args.sandboxImages ? { images: args.sandboxImages } : {}),
      },
    })
  }
  const docker = dockerCli()
  const oracle = args.oracleBooks ? dockerOracle({ docker, image: args.sandboxImages?.household ?? HOUSEHOLD_IMAGE, booksLib: args.oracleBooks }) : undefined
  return ({ case: c, host, budget }) => runSandboxed({
    case: c, bundleDir: args.bundle, seedBundleDir: args.seedBundle ?? path.join(REPO, "deploy/unraid/sanctuary.ouro"), host, budget, docker,
    ...(oracle ? { oracle } : {}),
    ...(args.sandboxImages ? { images: args.sandboxImages } : {}),
  })
}

async function main(): Promise<number> {
  const args = parseEvalArgs(process.argv.slice(2))
  const { exitCode } = await runEvalCommand(args, {
    resolveTarget: (spec, creds) => resolveTarget(spec, creds),
    runCase: runCaseFor,
    outputExists: (file) => fs.existsSync(file),
    writeReport: writePrivateReport,
    print: (text) => { process.stdout.write(`${text}\n`) },
  })
  return exitCode
}

// stderr's last line names the failure its Ouro AX card lists (cli-commands/entry-points.ts): 2 a run the budget or
// the provider stopped, 1 a refusal or a failure. process.exitCode, not process.exit, which can drop the line on a pipe.
const STOPPED = "budget-stopped"
const FAILED = "eval-error"
main().then((code) => {
  if (code === 2) process.stderr.write(`code: ${STOPPED}\n`)
  process.exitCode = code
}).catch((error: unknown) => {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.run_entry_error", message: "the eval command failed", meta: { error: error instanceof Error ? error.message : String(error) } })
  process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write(`code: ${FAILED}\n`)
  process.exitCode = 1
})
