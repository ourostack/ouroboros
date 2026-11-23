/**
 * Runs on the remote Docker host for `npm run eval -- --sandbox-ssh`: `node dist/eval/remote-entry.js`, started over
 * ssh. It reads one job from stdin, runs that case in the sandbox here with the model served from the other end of
 * the same channel (see `sandbox/remote.ts`), answers with the observation and exits. It holds no credential and no
 * budget: the calling side enforces both.
 */
import { emitNervesEvent } from "../nerves/runtime"
import { validateCase } from "./domain/case"
import { dockerCli, HOUSEHOLD_IMAGE, runSandboxed } from "./sandbox/docker"
import { localHostLock } from "./sandbox/host-lock"
import { dockerOracle } from "./sandbox/oracle"
import { serveRemoteJob } from "./sandbox/remote"

void serveRemoteJob({
  stdin: process.stdin,
  stdout: process.stdout,
  run: (job, host) => {
    const docker = dockerCli()
    return runSandboxed({
      case: validateCase(job.case), bundleDir: job.bundleDir, seedBundleDir: job.seedBundleDir, host, budget: { take: () => true }, docker,
      ...(job.workRoot ? { workRoot: job.workRoot } : {}),
      ...(job.guest ? { guest: job.guest } : {}),
      ...(job.images ? { images: job.images } : {}),
      ...(job.hostLockToken ? { hostLock: localHostLock(job.hostLockToken) } : {}),
      ...(job.oracleBooks ? { oracle: dockerOracle({ docker, image: job.images?.household ?? HOUSEHOLD_IMAGE, booksLib: job.oracleBooks }) } : {}),
    })
  },
}).then((outcome) => process.exit(outcome.ok ? 0 : 1)).catch((error: unknown) => {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.remote_entry_error", message: "the remote sandbox entry failed", meta: { error: String(error) } })
  process.exit(1)
})
