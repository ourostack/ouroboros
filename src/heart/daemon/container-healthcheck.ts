import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { emitNervesEvent } from "../../nerves/runtime"
import { hasManagedAgentProcess, hasManagedSupercronicProcess, hasManagedTelegramProcess } from "./container-runtime"

function fail(reason: string): never {
  emitNervesEvent({ level: "error", component: "daemon", event: "daemon.container_healthcheck_error", message: "container healthcheck failed", meta: { reason } })
  process.exitCode = 1
  throw new Error(reason)
}

export function runContainerHealthcheck(options: { argv?: string[]; now?: () => number } = {}): void {
  const argv = options.argv ?? process.argv
  const now = options.now ?? Date.now
  const index = argv.indexOf("--agent")
  const agent = index >= 0 ? argv[index + 1] : undefined
  if (!agent) fail("missing agent")
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

export function runContainerHealthcheckMain(isMain: boolean, runner: () => void): void {
  if (isMain) runner()
}

runContainerHealthcheckMain(require.main === module, runContainerHealthcheck)
