import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"

const traces: Array<{ scenario: unknown; status: number | null; trace: string; output: string }> = []
afterAll(() => {
  const source = fs.readFileSync("deploy/unraid/sanctuary-authority-service.sh", "utf8")
  const logical: Array<{ line: number; text: string }> = []
  let text = "", start = 1
  for (const [index, line] of source.split("\n").entries()) {
    if (!text) start = index + 1
    text += line
    if (text.endsWith("\\")) { text = text.slice(0, -1); continue }
    logical.push({ line: start, text: text.trim() })
    text = ""
  }
  const executable = logical.filter(({ text }) => text && !/^(?:#|--boot\)|done$|;;$|esac$)/u.test(text)).map(({ line }) => line)
  const observed = new Set<number>()
  const branches = new Map<string, Set<string>>()
  const record = (key: string, outcome: string) => {
    if (!branches.has(key)) branches.set(key, new Set())
    branches.get(key)!.add(outcome)
  }
  for (const run of traces) {
    const commands = run.trace.split("\n").flatMap((line) => {
      const match = line.match(/^\+([0-9]+): (.*)$/u)
      return match ? [{ line: Number(match[1]), command: match[2]! }] : []
    })
    for (const [index, current] of commands.entries()) {
      observed.add(current.line)
      const next = commands[index + 1]
      if ([4, 8, 13, 19, 22, 23, 24, 25, 26, 27].includes(current.line) && current.command.startsWith("test ")) record(`test:${current.line}`, next ? "true" : "false")
      if (current.line === 6) record("case:6", String(next!.line))
      if (current.line === 11) {
        const condition = current.command.includes("-f ") ? "array" : current.command.includes("-S ") ? "socket" : "docker"
        record(`wait:${condition}`, next?.line === 12 ? "true" : "false")
      }
    }
  }
  expect([...observed].sort((a, b) => a - b)).toEqual(executable)
  expect(branches.size).toBe(14)
  for (const [key, outcomes] of branches) expect(outcomes.size, key).toBe(key.startsWith("case:") ? 3 : 2)
  const counter = (total: number) => ({ total, covered: total, skipped: 0, pct: 100 })
  const summary = { statements: counter(executable.length), branches: counter([...branches.values()].reduce((sum, set) => sum + set.size, 0)), functions: counter(0), lines: counter(executable.length) }
  fs.mkdirSync("coverage", { recursive: true })
  fs.writeFileSync("coverage/s6-root-service-traces.json", JSON.stringify({
    sourcePath: "deploy/unraid/sanctuary-authority-service.sh", sourceSha256: createHash("sha256").update(source).digest("hex"),
    method: "POSIX shell -x native line traces; fixed path/command fixtures only, unchanged control flow",
    executableLines: executable, branchOutcomes: Object.fromEntries([...branches].map(([key, set]) => [key, [...set].sort()])), summary, traces,
  }, null, 2))
})

async function launchFixture(input: { args?: string[]; rootMode?: number; configMode?: number; owner?: string; delayed?: boolean; delayedConfig?: boolean; missingConfig?: boolean; unavailable?: boolean; malformedRoot?: boolean; linkedConfig?: boolean; linkedRoot?: boolean; programExit?: number } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sas-")))
  const authority = path.join(root, "authority")
  const bin = path.join(root, "bin")
  fs.mkdirSync(authority, { mode: input.rootMode ?? 0o700 })
  fs.mkdirSync(bin)
  const config = path.join(authority, "active.json")
  fs.writeFileSync(config, "{}", { mode: input.configMode ?? 0o600 })
  if (input.missingConfig) fs.unlinkSync(config)
  if (input.delayedConfig) fs.renameSync(config, `${config}.pending`)
  if (input.linkedConfig) { fs.renameSync(config, `${config}.original`); fs.symlinkSync(`${config}.original`, config) }
  if (input.linkedRoot) { fs.renameSync(authority, `${authority}.original`); fs.symlinkSync(`${authority}.original`, authority) }
  if (input.malformedRoot) { fs.rmSync(authority, { recursive: true }); fs.writeFileSync(authority, "not-directory") }
  const socket = path.join(root, "docker.sock")
  const parked = path.join(root, "parked.sock")
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.delayed ? parked : socket, resolve) })
  const writeProgram = (name: string, source: string) => fs.writeFileSync(path.join(bin, name), source, { mode: 0o755 })
  writeProgram("id", `#!/bin/sh\nprintf '%s\\n' '${input.owner ?? "0"}'\n`)
  writeProgram("stat", `#!${process.execPath}\nconst fs=require('node:fs'); const s=fs.lstatSync(process.argv[4]); process.stdout.write('0:0:'+((s.mode&0o777).toString(8))+'\\n');\n`)
  writeProgram("sleep", `#!/bin/sh\ncount=0\nif test -f "${root}/waits"; then read -r count <"${root}/waits"; fi\nprintf '%s\\n' "$((count + 1))" >"${root}/waits"\n${input.delayed ? `if test "$count" -eq 0; then /bin/mv "${parked}" "${socket}"; fi` : ""}\n${input.delayedConfig ? `if test "$count" -eq 0; then /bin/mv "${config}.pending" "${config}"; fi` : ""}\n`)
  writeProgram("docker", `#!/bin/sh\nprintf '%s\\n' "$*" >>"${root}/docker-calls"\n${input.unavailable ? "exit 1" : input.delayed ? `test -f "${root}/waits"` : "exit 0"}\n`)
  writeProgram("node", `#!/bin/sh\nprintf 'invocation:%s\\n' "$*"\nprintf 'secret:%s\\n' "\${FORBIDDEN_SECRET-unset}"\nexit ${input.programExit ?? 0}\n`)
  const script = fs.readFileSync("deploy/unraid/sanctuary-authority-service.sh", "utf8")
    .replaceAll("/mnt/user/appdata/ouro-authority", authority)
    .replaceAll("/var/run/docker.sock", socket)
    .replaceAll("/usr/local/bin/node", path.join(bin, "node"))
    .replaceAll("/usr/bin/docker", path.join(bin, "docker"))
  const scriptPath = path.join(root, "service.sh")
  fs.writeFileSync(scriptPath, script, { mode: 0o700 })
  try {
    const result = spawnSync("/bin/sh", ["-x", scriptPath, ...input.args ?? []], { encoding: "utf8", timeout: 30_000, env: { PATH: `${bin}:/usr/bin:/bin`, PS4: "+${LINENO}: ", FORBIDDEN_SECRET: "must-not-reach-child" } })
    if (result.error) throw result.error
    traces.push({ scenario: input, status: result.status, trace: result.stderr, output: result.stdout })
    return {
      ...result,
      waits: fs.existsSync(path.join(root, "waits")) ? Number(fs.readFileSync(path.join(root, "waits"))) : 0,
      dockerCalls: fs.existsSync(path.join(root, "docker-calls")) ? fs.readFileSync(path.join(root, "docker-calls"), "utf8") : "",
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("packaged root authority launch assets", () => {
  it("waits for responsive Docker, not merely its socket, then invokes the fenced boot owner with no inherited secret", async () => {
    const result = await launchFixture({ args: ["--boot"], delayed: true })
    expect(result.status).toBe(0)
    expect(result.waits).toBeGreaterThan(0)
    expect(result.dockerCalls).toContain("info")
    expect(result.stdout).toContain("sanctuary-authority-root-lifecycle.js boot")
    expect(result.stdout).toContain("secret:unset")
  })
  it("does not launch a gateway when Docker remains unavailable", async () => {
    const result = await launchFixture({ args: ["--boot"], unavailable: true })
    expect(result.status).not.toBe(0)
    expect(result.waits).toBe(300)
    expect(result.stdout).not.toContain("invocation:")
  })
  it.each([
    { args: [], rootMode: 0o700, configMode: 0o600 },
    { args: ["--boot"] },
    { args: ["--boot"], delayedConfig: true },
  ])("launches exactly one fixed foreground entry with valid state %j", async (input) => {
    const result = await launchFixture(input)
    expect(result.status).toBe(0)
    expect(result.stdout.match(/invocation:/gu)).toHaveLength(1)
    expect(result.stdout).toContain("secret:unset")
  })
  it.each([
    { owner: "10001" }, { args: ["unknown"] }, { args: ["--boot", "extra"] }, { args: ["", "extra"] },
    { rootMode: 0o777 }, { configMode: 0o644 }, { linkedRoot: true }, { linkedConfig: true }, { malformedRoot: true }, { missingConfig: true },
  ])("fails closed without executing a program for unsafe launch state %j", async (input) => {
    const result = await launchFixture(input)
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain("invocation:")
  })
  it("propagates the fixed program's nonzero status without starting another process", async () => {
    const result = await launchFixture({ programExit: 17 })
    expect(result.status).toBe(17)
    expect(result.stdout.match(/invocation:/gu)).toHaveLength(1)
  })
  it("ships a root-only foreground launcher with a closed environment and no secret arguments or resident mount", () => {
    const script = fs.readFileSync("deploy/unraid/sanctuary-authority-service.sh", "utf8")
    expect(script).toContain('test "$(id -u):$(id -g)" = 0:0')
    expect(script).toContain("umask 077")
    expect(script).toContain("exec /usr/bin/env -i")
    expect(script).toContain("/mnt/user/appdata/ouro-authority/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js")
    expect(script).toContain("--config /mnt/user/appdata/ouro-authority/active.json")
    expect(script).toContain('case "${1-}" in')
    expect(script).toContain("sanctuary-authority-root-lifecycle.js boot")
    expect(script).toContain("--boot")
    expect(script).not.toMatch(/--mount[^\n]*docker\.sock|telegramBotToken|PRIVATE KEY|--token|eval /u)
    execFileSync("/bin/sh", ["-n", "deploy/unraid/sanctuary-authority-service.sh"])
    expect(spawnSync("/bin/sh", ["deploy/unraid/sanctuary-authority-service.sh", "unexpected"], { encoding: "utf8" }).status).not.toBe(0)
  })
  it("requires the launcher and installation contract in the package payload", () => {
    const { REQUIRED_PACKAGE_ASSET_PATHS } = require("../../../scripts/package-assets.cjs")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary-authority-service.sh")
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-authority-installation.json", "utf8"))
    expect(contract).toEqual({
      schemaVersion: 1, rootUid: 0, rootGid: 0, residentUid: 10001, residentGid: 10001,
      stateRoot: "/mnt/user/appdata/ouro-authority", stateMode: 448, secretMode: 384,
      packageRoot: "/mnt/user/appdata/ouro-authority/package",
      activeConfigPath: "/mnt/user/appdata/ouro-authority/active.json",
      incomingPackagePath: "/mnt/user/appdata/ouro-authority/incoming-package",
      packageManifestPath: "/mnt/user/appdata/ouro-authority/package-manifest.json",
      socketRoot: "/run/ouro-authority", socketDirectoryMode: 488, socketMode: 432, residentPinsMode: 416,
      socketPath: "/run/ouro-authority/authority.sock", residentPinsPath: "/run/ouro-authority/resident.json",
      stagingRoot: "/var/lib/ouro-authority/staging", cgroupRoot: "/sys/fs/cgroup/ouro-authority",
      controllers: ["cpu", "memory", "pids"], sourceMountContract: "canonical-pre-gateway", targetMountContract: "canonical-gateway",
      bootPath: "/boot/config/custom/ouro-authority/start.sh",
      requestPath: "/mnt/user/appdata/ouro-authority/request.json",
      incomingTokenPath: "/mnt/user/appdata/ouro-authority/incoming-token",
      servicePath: "/mnt/user/appdata/ouro-authority/package/deploy/unraid/sanctuary-authority-service.sh", serviceMode: 448,
      nodePath: "/usr/local/bin/node", prlimitPath: "/usr/bin/prlimit", setsidPath: "/usr/bin/setsid", shellPath: "/bin/sh",
      transactionOwner: "docker-man-template-transaction.mjs", epochRetirementRequiredBeforeRollback: true,
    })
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary-authority-installation.json")
  })
})
