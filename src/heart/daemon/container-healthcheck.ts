import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

function fail(reason: string): never {
  emitNervesEvent({ level: "error", component: "daemon", event: "daemon.container_healthcheck_error", message: "container healthcheck failed", meta: { reason } })
  process.exitCode = 1
  throw new Error(reason)
}

const index = process.argv.indexOf("--agent")
const agent = index >= 0 ? process.argv[index + 1] : undefined
if (!agent) fail("missing agent")
const healthPath = path.join(os.homedir(), ".ouro-cli", "daemon-health.json")
let stat: fs.Stats
let health: Record<string, unknown>
try {
  stat = fs.statSync(healthPath)
  health = JSON.parse(fs.readFileSync(healthPath, "utf8")) as Record<string, unknown>
} catch { fail("health state unavailable") }
if (Date.now() - stat.mtimeMs > 90_000 || stat.mtimeMs > Date.now() + 1_000) fail("health state stale")
if (health.pid !== 1 || !fs.existsSync("/proc/1")) fail("daemon is not PID 1")
if (health.status !== "healthy" && health.status !== "partial") fail("daemon status is not ready")
const agents = health.agents as Record<string, { status?: unknown; pid?: unknown }> | undefined
const managed = agents?.[agent]
if (!managed || managed.status !== "running" || typeof managed.pid !== "number" || managed.pid <= 0 || !fs.existsSync(`/proc/${managed.pid}`)) fail("managed agent is not running")
emitNervesEvent({ component: "daemon", event: "daemon.container_healthcheck_end", message: "container healthcheck passed", meta: { agent } })
