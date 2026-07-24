import { createHash, randomUUID } from "crypto"
import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import { CrontabCronManager, LaunchdCronManager } from "../../../heart/daemon/os-cron"
import { createRealCrontabDeps, createRealOsCronDeps } from "../../../heart/daemon/os-cron-deps"
import type { ScheduledTaskJob } from "../../../heart/daemon/task-scheduler"

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url")
}

function makeProbeJob(agent: string): ScheduledTaskJob {
  return {
    id: `${agent}:launchd-proof:cadence`,
    agent,
    taskId: "launchd-proof",
    schedule: "*/5 * * * *",
    lastRun: null,
    command: "/usr/bin/true --ouro-scheduler-proof",
    taskPath: `/tmp/${agent}.ouro/habits/launchd-proof.md`,
  }
}

function exactOwner(consumer: string, agent: string) {
  const agentKey = digest(agent)
  return (candidate: { consumer: string; agentKey: string; jobKey: string }) =>
    candidate.consumer === consumer
    && candidate.agentKey === agentKey
    && /^[A-Za-z0-9_-]{43}$/.test(candidate.jobKey)
}

describe("OS cron disposable live-state integration", () => {
  it.runIf(process.platform === "darwin")("detects and repairs a plist-present but unloaded launchd job", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-launchd-proof-"))
    const agent = `test-${randomUUID()}`
    const job = makeProbeJob(agent)
    const label = `bot.ouro.habit.${digest(agent)}.${digest(job.id)}`
    const legacyLabel = `bot.ouro.${agent}.${job.taskId}`
    const uid = process.getuid!()
    const options = { consumer: "habit", ownsRegistration: exactOwner("habit", agent), uid }
    const deps = (createRealOsCronDeps as unknown as (options: { homeDir: string; uid: number }) => ReturnType<typeof createRealOsCronDeps>)({ homeDir: root, uid })
    const manager = new LaunchdCronManager(deps, options as never)

    try {
      const first = manager.sync([job]) as any
      expect(first.jobs[job.id].outcome).toBe("repaired_verified")

      const bootout = spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" })
      expect(bootout.status).toBe(0)
      expect(fs.existsSync(path.join(root, "Library", "LaunchAgents", `${label}.plist`))).toBe(true)

      const repaired = manager.sync([job]) as any
      expect(repaired.jobs[job.id]).toMatchObject({ outcome: "repaired_verified", error: null })
      const loaded = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" })
      expect(loaded.status).toBe(0)
      expect(loaded.stdout).toContain(`gui/${uid}/${label} = {`)
      expect(loaded.stdout).toContain("\n\targuments = {\n\t\t/usr/bin/true\n\t\t--ouro-scheduler-proof\n\t}")
    } finally {
      spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`])
      spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${legacyLabel}`])
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("uses the real structured runner against a hermetic crontab executable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-crontab-proof-"))
    const statePath = path.join(root, "crontab.txt")
    const executable = path.join(root, "crontab-fixture")
    const script = [
      `#!${process.execPath}`,
      'const fs = require("fs")',
      `const state = ${JSON.stringify(statePath)}`,
      'if (process.argv[2] === "-l") {',
      '  if (fs.existsSync(state)) process.stdout.write(fs.readFileSync(state))',
      '  process.exit(0)',
      '}',
      'if (process.argv[2] === "-") {',
      '  const chunks = []',
      '  process.stdin.on("data", (chunk) => chunks.push(chunk))',
      '  process.stdin.on("end", () => fs.writeFileSync(state, Buffer.concat(chunks)))',
      '  return',
      '}',
      'process.exit(64)',
      '',
    ].join("\n")
    fs.writeFileSync(executable, script, { encoding: "utf8", mode: 0o700 })
    fs.writeFileSync(statePath, "# untouched\n7 3 * * * /bin/backup\n", "utf8")

    try {
      const deps = (createRealCrontabDeps as unknown as (options: { executable: string }) => ReturnType<typeof createRealCrontabDeps>)({ executable })
      expect((deps as any).crontabPath).toBe(executable)
      const job = makeProbeJob("hermetic")
      const manager = new CrontabCronManager(deps, {
        consumer: "habit",
        ownsRegistration: exactOwner("habit", "hermetic"),
      } as never)

      const result = manager.sync([job]) as any

      expect(result.jobs[job.id]).toMatchObject({ outcome: "repaired_verified", error: null })
      const bytes = fs.readFileSync(statePath, "utf8")
      expect(bytes).toContain("# untouched\n7 3 * * * /bin/backup\n")
      expect(bytes).toContain(`# ouro:v1:habit:${digest(job.agent)}:${digest(job.id)}\n`)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
