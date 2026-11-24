/**
 * `npm run eval -- <flags>` (see `run-command.ts` for the flags and the refusals): runs eval cases on one model target
 * and writes the private report. With `--sandbox-ssh <host>:<folder>` the sandbox runs on that Docker host, whose
 * harness checkout is synced to `<folder>/harness`; `--bundle`, `--seed-bundle` and `--oracle-books` are then paths
 * on that host. `--sandbox-images <agent>,<household>` names the image tags to run (on that host, when remote), built
 * beforehand with `docker build --file deploy/eval/Dockerfile --target agent|household --tag <tag> .`; the remote
 * checkout must be synced and built from this version for the books oracle to use them too. `--host-lock <holder>`
 * holds that host's lock (deploy/unraid/ouro-host-lock.mjs) for the whole command, so the Butler's upgrade and
 * rollback wait for it, and the sandbox runs on the Butler's host only while it does. Model calls and credentials
 * stay on this machine.
 */
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { billingRefusal } from "./billing-guard"
import { monthLedger } from "./month-ledger"
import { parseEvalArgs, runEvalCommand, type EvalArgs } from "./run-command"
import { writePrivateReport } from "./report"
import { dockerCli, HOUSEHOLD_IMAGE, runSandboxed } from "./sandbox/docker"
import { dockerOracle } from "./sandbox/oracle"
import { holdHostLock, HOST_LOCK_TTL_S, HOST_LOCK_WAIT_S, type HeldHostLock } from "./sandbox/host-lock"
import { remoteRunCase, sshNode, sshStart, type RunCase } from "./sandbox/remote"
import { resolveTarget } from "./targets"

const REPO = path.resolve(__dirname, "../..")

function sshTarget(spec: string): { host: string; root: string } {
  const split = spec.indexOf(":")
  if (split < 1) throw new Error("--sandbox-ssh must be <host>:<folder>")
  return { host: spec.slice(0, split), root: spec.slice(split + 1) }
}

function runCaseFor(args: EvalArgs, hostLockToken?: string): RunCase {
  if (args.sandboxSsh) {
    const { host, root } = sshTarget(args.sandboxSsh)
    return remoteRunCase({
      start: sshStart(host, `${root}/harness/dist/eval/remote-entry.js`),
      paths: {
        bundleDir: args.bundle, seedBundleDir: args.seedBundle ?? `${root}/harness/deploy/unraid/sanctuary.ouro`, workRoot: `${root}/work`,
        ...(args.oracleBooks ? { oracleBooks: args.oracleBooks } : {}),
        ...(args.sandboxImages ? { images: args.sandboxImages } : {}),
        ...(hostLockToken ? { hostLockToken } : {}),
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
  let lock: HeldHostLock | undefined
  if (args.hostLock && args.sandboxSsh) {
    const { host, root } = sshTarget(args.sandboxSsh)
    lock = await holdHostLock(sshNode(host, [`${root}/harness/deploy/unraid/ouro-host-lock.mjs`, "hold", "--holder", args.hostLock, "--ttl", String(HOST_LOCK_TTL_S), "--wait", String(HOST_LOCK_WAIT_S)]))
  }
  try {
    const { exitCode } = await runEvalCommand(args, {
      resolveTarget: (spec, creds) => resolveTarget(spec, creds),
      runCase: (parsed) => runCaseFor(parsed, lock?.token),
      outputExists: (file) => fs.existsSync(file),
      writeReport: writePrivateReport,
      print: (text) => { process.stdout.write(`${text}\n`) },
      monthLedger: monthLedger(),
      billingGuard: billingRefusal,
    })
    return exitCode
  } finally {
    await lock?.release()
  }
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
