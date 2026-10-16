import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const children: ChildProcess[] = []
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    await exited
  }))
})

function fixture(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "teams-tunnel-"))
  const calls = join(dir, "calls")
  writeFileSync(calls, "")
  const executable = (name: string, body: string, interpreter = process.execPath) => {
    const path = join(dir, name)
    writeFileSync(path, `#!${interpreter}\n${body}`, { mode: 0o700 })
    return path
  }
  const cloudflared = executable("cloudflared", `
    require("node:fs").writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
    console.log("https://fixture.trycloudflare.com");
    ${mode === "permanent" ? 'console.log("Unauthorized: Tunnel not found");' : ""}
    setInterval(() => {}, 1000);
  `)
  const az = executable("az", `
    const fs = require("node:fs");
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
    ${mode === "register-failure" ? "process.exit(1);" : `
      if (process.argv[3] === "show") {
        const current = fs.readFileSync(${JSON.stringify(calls)}, "utf8").includes('"update"');
        console.log(current ? "https://fixture.trycloudflare.com/api/messages" : "https://old.invalid/api/messages");
      }
    `}
  `)
  const curl = executable("curl", `
    [ "$*" = '--fail --silent --max-time 5 http://127.0.0.1:20246/ready' ] || exit 22
    printf '%s\\n' '["http://127.0.0.1:20246/ready"]' >> '${calls}'
    ${mode === "not-ready" ? "exit 1" : ""}
    ${mode === "lost-ready" ? `
      [ "$(grep -c /ready '${calls}')" -le 2 ] || exit 1
    ` : ""}
    exit 0
  `, "/bin/sh")
  const child = spawn("/bin/bash", [resolve("scripts/teams-sense/local-tunnel.sh")], {
    env: {
      PATH: "/usr/bin:/bin", HOME: dir,
      OURO_TEAMS_BOT_RG: "fixture-group", OURO_TEAMS_BOT_NAME: "fixture-bot",
      OURO_TEAMS_SUBSCRIPTION: "fixture-subscription",
      OURO_TEAMS_TUNNEL_STATE: dir, OURO_TEAMS_CLOUDFLARED: cloudflared,
      OURO_TEAMS_AZ: az, OURO_TEAMS_CURL: curl, OURO_TEAMS_TUNNEL_POLL_SECONDS: "0.01",
    },
    stdio: "ignore",
  })
  children.push(child)
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  return { child, calls: () => readFileSync(calls, "utf8"), exited,
    events: () => readFileSync(join(dir, "events.log"), "utf8"),
    tunnelPid: () => Number(readFileSync(join(dir, "pid"), "utf8")) }
}

async function exitsForRecovery(f: ReturnType<typeof fixture>, timeout = 4000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    f.exited.then(code => ({ exited: true, code })),
    new Promise<{ exited: boolean; code: null }>(resolve => { timer = setTimeout(() => resolve({ exited: false, code: null }), timeout) }),
  ]).finally(() => { clearTimeout(timer) })
  expect(result.exited, "dead ingress must exit even while cloudflared remains alive").toBe(true)
  expect(result.code).not.toBe(0)
}

describe("managed local Teams tunnel", () => {
  it("keeps a ready registered tunnel alive and terminates its owned child on shutdown", async () => {
    const f = fixture("ready")
    await vi.waitFor(() => expect(f.events()).toContain("endpoint confirmed"))
    expect(f.child.exitCode).toBe(null)
    const pid = f.tunnelPid()
    expect(() => process.kill(pid, 0)).not.toThrow()
    f.child.kill("SIGTERM")
    expect(await f.exited).toBe(1)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it("exits on permanent tunnel rejection without registering its dead URL", async () => {
    const f = fixture("permanent")
    await exitsForRecovery(f)
    expect(f.calls()).not.toContain('"bot"')
  })

  it("does not register an unready tunnel", async () => {
    const f = fixture("not-ready")
    await exitsForRecovery(f, 12000)
    expect(f.calls()).not.toContain('"bot"')
  }, 15000)

  it("exits after registration failures instead of claiming readiness", async () => {
    const f = fixture("register-failure")
    await exitsForRecovery(f)
    expect(f.calls()).toContain('"fixture-subscription"')
  })

  it("confirms registration and recovers sustained readiness loss", async () => {
    const f = fixture("lost-ready")
    await exitsForRecovery(f)
    const calls = f.calls().trim().split("\n").map(row => JSON.parse(row) as string[])
    const update = calls.findIndex(args => args[1] === "update")
    expect(update).toBeGreaterThanOrEqual(0)
    expect(calls.slice(update + 1).some(args => args[1] === "show")).toBe(true)
    expect(calls.filter(args => args.some(arg => arg.endsWith("/ready"))).length).toBeGreaterThan(2)
  })
})
