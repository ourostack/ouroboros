import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentBundlesRoot, getRepoRoot } from "../identity"
import { getPackageVersion } from "../../mind/bundle-manifest"
import { hasManagedAgentProcess, hasManagedSupercronicProcess, hasManagedTelegramProcess } from "./container-runtime"
import { inspectSanctuaryPackageManagedBundle } from "./sanctuary-bundle-migration"
import { resolveSanctuaryPackageManagementActivation } from "./sanctuary-package-management"
import { failureCodeLine } from "./cli-commands/failure-code"
import { butlerOnDisk, isButlerAgent } from "../butler-agent"

function fail(reason: string): never {
  emitNervesEvent({ level: "error", component: "daemon", event: "daemon.container_healthcheck_error", message: "container healthcheck failed", meta: { reason } })
  process.exitCode = 1
  throw Object.assign(new Error(reason), { code: reason === "missing agent" ? "missing-agent" : "unhealthy" })
}

export function runContainerHealthcheck(options: { argv?: string[]; now?: () => number } = {}): void {
  const argv = options.argv ?? process.argv
  const now = options.now ?? Date.now
  const index = argv.indexOf("--agent")
  const given = index >= 0 ? argv[index + 1] : undefined
  const agent = isButlerAgent(given) ? butlerOnDisk(getAgentBundlesRoot(), fs.existsSync) ?? undefined : given
  if (!agent) fail("missing agent")
  const packageManagement = resolveSanctuaryPackageManagementActivation({ mode: "production", argv, managedAgents: [agent], repoRoot: getRepoRoot(), bundlesRoot: getAgentBundlesRoot(), runtimePackageVersion: getPackageVersion() })
  if (packageManagement.kind !== "active") fail("invalid package-managed Sanctuary activation")
  let installState
  try {
    installState = inspectSanctuaryPackageManagedBundle(packageManagement)
  } catch {
    fail("package-managed Sanctuary inspection unavailable")
  }
  if (!installState.ok || !installState.data.ready) fail("package-managed Sanctuary bundle is not ready")
  const healthPath = path.join(os.homedir(), ".ouro-cli", "daemon-health.json")
  let stat: fs.Stats
  let health: Record<string, unknown>
  try {
    stat = fs.statSync(healthPath)
    health = JSON.parse(fs.readFileSync(healthPath, "utf8")) as Record<string, unknown>
  } catch { fail("health state unavailable") }
  const checkedAt = now()
  if (checkedAt - stat.mtimeMs > 90_000 || stat.mtimeMs > checkedAt + 1_000) fail("health state stale")
  if (health.pid !== 1 || !fs.existsSync("/proc/1")) fail("daemon is not PID 1")
  if (health.status !== "healthy" && health.status !== "partial") fail("daemon status is not ready")
  const degraded = Array.isArray(health.degraded) ? health.degraded as Array<{ component?: unknown }> : []
  if (degraded.some((entry) => typeof entry.component === "string" && entry.component.startsWith("provider:"))) fail("provider failed its live check")
  const agents = health.agents as Record<string, { status?: unknown; pid?: unknown }> | undefined
  const managed = agents?.[agent]
  if (!managed || managed.status !== "running" || typeof managed.pid !== "number" || managed.pid <= 0) fail("managed agent is not running")
  let processArguments = ""
  try { processArguments = execFileSync("ps", ["-eo", "args="], { encoding: "utf8", timeout: 2_000 }) }
  catch { fail("managed process inventory is unavailable") }
  if (!hasManagedAgentProcess(processArguments, agent)) fail("managed agent is not running exactly once")
  if (!hasManagedTelegramProcess(processArguments, agent)) fail("managed Telegram sense is not running exactly once")
  if (!hasManagedSupercronicProcess(processArguments, agent)) fail("managed Supercronic scheduler is not running exactly once")
  emitNervesEvent({ component: "daemon", event: "daemon.container_healthcheck_end", message: "container healthcheck passed", meta: { agent } })
}

/** The codes this program's card names; only these end its stderr (see failure-code.ts). */
const CARD_CODES = ["missing-agent", "unhealthy"]

/** Run the healthcheck as the container's entrypoint: a failure ends stderr with its code, and exits 1. */
export function runContainerHealthcheckMain(isMain: boolean, runner: () => void, writeError: (text: string) => void = (text) => { process.stderr.write(text) }): void {
  if (!isMain) return
  try {
    runner()
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n${failureCodeLine(error, CARD_CODES)}`)
    process.exitCode = 1
  }
}

runContainerHealthcheckMain(require.main === module, runContainerHealthcheck)
