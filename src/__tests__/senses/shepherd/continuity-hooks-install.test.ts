import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installContinuityHook, planContinuityHookInstall } from "../../../senses/shepherd/continuity-hooks-install"

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuity-install-")))
  const ouroEntry = path.join(home, "ouro entry")
  fs.writeFileSync(ouroEntry, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  return { home, ouroEntry, settingsPath: path.join(home, "settings.json"), agent: "ouro" }
}
describe("explicit native hook installation", () => {
  afterEach(() => vi.restoreAllMocks())
  it("creates a separate Copilot user hooks file without touching unknown settings", () => {
    const f = fixture()
    const request = { ...f, runner: "copilot" as const, version: "1.0.97" }
    const plan = planContinuityHookInstall(request)
    expect(fs.existsSync(f.settingsPath)).toBe(false)
    expect(plan.document).toMatchObject({ version: 1, hooks: { agentStop: [{ type: "command", timeoutSec: 5 }] } })
    const receipt = installContinuityHook(plan)
    expect(receipt).toMatchObject({ installed: true, reload: "unverified" })
    expect(JSON.parse(fs.readFileSync(f.settingsPath, "utf8"))).toEqual(plan.document)
    expect(fs.statSync(f.settingsPath).mode & 0o777).toBe(0o600)
    expect(installContinuityHook(planContinuityHookInstall(request)).installed).toBe(false)
  })
  it.each(["claude", "codex"] as const)("appends only our %s Stop entry preserving Agency/no-forms settings", runner => {
    const f = fixture()
    const existing = { permissions: { deny: ["AskUserQuestion"] }, agency: { plugins: ["worker"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-hook", timeout: 8 }] }], PreToolUse: [{ matcher: "AskUserQuestion", hooks: [] }] } }
    fs.writeFileSync(f.settingsPath, JSON.stringify(existing), { mode: 0o600 })
    const request = { ...f, runner, version: runner === "claude" ? "2.1.299" : "0.162.1" }
    const plan = planContinuityHookInstall(request)
    expect(plan.document).toMatchObject({ permissions: existing.permissions, agency: existing.agency,
      hooks: { PreToolUse: existing.hooks.PreToolUse } })
    installContinuityHook(plan)
    const result = JSON.parse(fs.readFileSync(f.settingsPath, "utf8"))
    expect(result.hooks.Stop).toHaveLength(2)
    expect(result.hooks.Stop[1].hooks[0]).toMatchObject({ type: "command", timeout: 5 })
    expect(result.hooks.Stop[1].hooks[0].command).toContain("'shepherd' 'hook' '--agent' 'ouro'")
    expect(planContinuityHookInstall(request).changed).toBe(false)
  })
  it("refuses changed revisions, malformed native hook lists, unknown versions and symlinks", () => {
    const f = fixture()
    const request = { ...f, runner: "claude" as const, version: "2.1.299" }
    const plan = planContinuityHookInstall(request)
    fs.writeFileSync(f.settingsPath, "{}", { mode: 0o600 })
    expect(() => installContinuityHook(plan)).toThrow(/revision/)
    fs.writeFileSync(f.settingsPath, JSON.stringify({ hooks: { Stop: "not-array" } }))
    expect(() => planContinuityHookInstall(request)).toThrow()
    expect(() => planContinuityHookInstall({ ...request, version: "unknown" })).toThrow(/version/)
    fs.renameSync(f.settingsPath, `${f.settingsPath}-moved`)
    fs.symlinkSync(`${f.settingsPath}-moved`, f.settingsPath)
    expect(() => planContinuityHookInstall(request)).toThrow()
  })
  it("refuses unsafe entry paths, writable settings and implicit Codex hook locations", () => {
    const f = fixture()
    const request = { ...f, runner: "codex" as const, version: "0.162.1" }
    expect(() => planContinuityHookInstall({ ...request, settingsPath: "relative" })).toThrow()
    fs.writeFileSync(f.settingsPath, "{}", { mode: 0o666 })
    fs.chmodSync(f.settingsPath, 0o666)
    expect(() => planContinuityHookInstall(request)).toThrow()
    fs.chmodSync(f.settingsPath, 0o600)
    fs.chmodSync(f.ouroEntry, 0o666)
    expect(() => planContinuityHookInstall(request)).toThrow()
  })
  it("refuses corrupt or oversized JSON and malformed settings objects", () => {
    for (const content of ["not-json", "null", "[]", '{"hooks":[]}', '{"version":2}', " ".repeat(262145)]) {
      const f = fixture()
      fs.writeFileSync(f.settingsPath, content, { mode: 0o600 })
      expect(() => planContinuityHookInstall({ ...f, runner: "copilot", version: "1.0.97" })).toThrow()
    }
    const f = fixture()
    expect(() => planContinuityHookInstall({ ...f, agent: "../other", runner: "copilot", version: "1.0.97" })).toThrow()
    expect(() => planContinuityHookInstall({ ...f, ouroEntry: "/nonexistent/entry", runner: "copilot", version: "1.0.97" })).toThrow()
  })
  it("rejects tampered previews and differing or duplicate owned native contracts", () => {
    const f = fixture()
    const request = { ...f, runner: "copilot" as const, version: "1.0.97" }
    const original = planContinuityHookInstall(request)
    expect(() => installContinuityHook({ ...original, document: { evil: "substituted" } })).toThrow(/revision/)
    installContinuityHook(original)
    const document = JSON.parse(fs.readFileSync(f.settingsPath, "utf8"))
    document.hooks.agentStop.push(document.hooks.agentStop[0])
    fs.writeFileSync(f.settingsPath, JSON.stringify(document))
    expect(() => planContinuityHookInstall(request)).toThrow(/duplicate/)
    document.hooks.agentStop.pop()
    document.hooks.agentStop[0].timeoutSec = 1
    fs.writeFileSync(f.settingsPath, JSON.stringify(document))
    expect(() => planContinuityHookInstall(request)).toThrow(/contract/)
  })
  it("does not age-break a suspended installer's exclusive reservation", () => {
    const f = fixture()
    const plan = planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })
    const lock = `${f.settingsPath}.shepherd-install-lock`
    fs.writeFileSync(lock, "held", { mode: 0o600 })
    fs.utimesSync(lock, new Date(0), new Date(0))
    expect(() => installContinuityHook(plan)).toThrow()
    expect(fs.readFileSync(lock, "utf8")).toBe("held")
    expect(fs.existsSync(f.settingsPath)).toBe(false)
  })
  it("refuses a revision race after reservation and archives only its own interrupted lock", () => {
    const f = fixture()
    const plan = planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })
    const fsync = fs.fsyncSync
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      fs.writeFileSync(f.settingsPath, '{"other":"preserved"}', { mode: 0o600 })
      return fsync(fd)
    })
    expect(() => installContinuityHook(plan)).toThrow(/revision/)
    expect(JSON.parse(fs.readFileSync(f.settingsPath, "utf8"))).toEqual({ other: "preserved" })
    expect(fs.existsSync(`${f.settingsPath}.shepherd-install-lock`)).toBe(false)
    expect(fs.readdirSync(f.home).filter(name => name.endsWith(".interrupted"))).toHaveLength(1)
  })
  it("rejects named file substitution during settings descriptor reads", () => {
    const f = fixture()
    fs.writeFileSync(f.settingsPath, "{}", { mode: 0o600 })
    const read = fs.readSync
    let changed = false
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const result = Reflect.apply(read, fs, args)
      if (!changed) {
        changed = true
        fs.renameSync(f.settingsPath, `${f.settingsPath}-moved`)
        fs.writeFileSync(f.settingsPath, "{}", { mode: 0o600 })
      }
      return result
    })
    expect(() => planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })).toThrow(/descriptor changed/)
  })
  it("rejects duplicate owned commands within one native Stop group", () => {
    const f = fixture()
    const request = { ...f, runner: "claude" as const, version: "2.1.299" }
    installContinuityHook(planContinuityHookInstall(request))
    const document = JSON.parse(fs.readFileSync(f.settingsPath, "utf8"))
    document.hooks.Stop[0].hooks.push(document.hooks.Stop[0].hooks[0])
    fs.writeFileSync(f.settingsPath, JSON.stringify(document))
    expect(() => planContinuityHookInstall(request)).toThrow(/duplicate/)
  })
  it("checks formatted-byte bounds before replacing any settings", () => {
    const f = fixture()
    const content = JSON.stringify({ untouched: Array.from({ length: 20000 }, () => ({ x: 0 })) })
    fs.writeFileSync(f.settingsPath, content, { mode: 0o600 })
    const plan = planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })
    expect(() => installContinuityHook(plan)).toThrow(/byte limit/)
    expect(fs.readFileSync(f.settingsPath, "utf8")).toBe(content)
  })
  it("refuses nonexecutable trusted entries and precise inode ambiguity", () => {
    const f = fixture()
    const request = { ...f, runner: "copilot" as const, version: "1.0.97" }
    fs.chmodSync(f.ouroEntry, 0o600)
    expect(() => planContinuityHookInstall(request)).toThrow(/regular file/)
    fs.chmodSync(f.ouroEntry, 0o700)
    const lstat = fs.lstatSync
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = Reflect.apply(lstat, fs, args)
      if (String(args[0]) === f.ouroEntry) stat.ino = Number.MAX_SAFE_INTEGER + 1
      return stat
    })
    expect(() => planContinuityHookInstall(request)).toThrow(/regular file/)
  })
  it("preserves nonowned hook entries and refuses compact planned overflow", () => {
    const f = fixture()
    fs.writeFileSync(f.settingsPath, JSON.stringify({ version: 1, hooks: { agentStop: [null, { bash: "other-hook" }] } }), { mode: 0o600 })
    const plan = planContinuityHookInstall({ ...f, runner: "copilot", version: "1.0.97" })
    expect(plan.document.hooks).toMatchObject({ agentStop: [null, { bash: "other-hook" }, expect.any(Object)] })
    fs.writeFileSync(f.settingsPath, JSON.stringify({ hooks: { Stop: [{ preserve: true }, { hooks: [null, { command: "other" }] }] } }))
    expect(planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" }).changed).toBe(true)
    fs.writeFileSync(f.settingsPath, JSON.stringify({ keep: "x".repeat(262100) }))
    expect(() => planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })).toThrow(/byte limit/)
  })
  it("distinguishes an absent settings source from a denied open", () => {
    const f = fixture()
    fs.writeFileSync(f.settingsPath, "{}", { mode: 0o600 })
    const open = fs.openSync
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === f.settingsPath) throw Object.assign(new Error("denied"), { code: "EACCES" })
      return Reflect.apply(open, fs, args)
    })
    expect(() => planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })).toThrow("denied")
  })
  it("rejects a nonregular file substituted between path validation and descriptor open", () => {
    const f = fixture()
    fs.writeFileSync(f.settingsPath, "{}", { mode: 0o600 })
    const open = fs.openSync
    let changed = false
    vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!changed && String(args[0]) === f.settingsPath) {
        changed = true
        fs.renameSync(f.settingsPath, `${f.settingsPath}-moved`)
        fs.mkdirSync(f.settingsPath, { mode: 0o700 })
      }
      return Reflect.apply(open, fs, args)
    })
    expect(() => planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })).toThrow(/file type/)
  })
  it("does not overwrite or remove a different installer's substituted reservation", () => {
    const f = fixture()
    const plan = planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })
    const lock = `${f.settingsPath}.shepherd-install-lock`
    const fsync = fs.fsyncSync
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      fs.renameSync(lock, `${lock}-original`)
      fs.writeFileSync(lock, "other installer", { mode: 0o600 })
      return fsync(fd)
    })
    expect(() => installContinuityHook(plan)).toThrow(/reservation changed/)
    expect(fs.readFileSync(lock, "utf8")).toBe("other installer")
    expect(fs.existsSync(f.settingsPath)).toBe(false)
  })
  it("reports uncertain readback after a committed file changes without retrying", () => {
    const f = fixture()
    const plan = planContinuityHookInstall({ ...f, runner: "claude", version: "2.1.299" })
    const rename = fs.renameSync
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to)
      if (String(to) === f.settingsPath) fs.appendFileSync(f.settingsPath, " ")
    })
    expect(() => installContinuityHook(plan)).toThrow(/readback uncertain/)
    expect(fs.existsSync(f.settingsPath)).toBe(true)
    expect(fs.existsSync(`${f.settingsPath}.shepherd-install-lock`)).toBe(false)
  })
  it("allows trusted system-owned entries but rejects another user's entry", () => {
    const f = fixture()
    const lstat = fs.lstatSync
    let uid = process.getuid!() + 100
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = Reflect.apply(lstat, fs, args)
      if (String(args[0]) === f.ouroEntry) stat.uid = uid
      return stat
    })
    const request = { ...f, runner: "claude" as const, version: "2.1.299" }
    expect(() => planContinuityHookInstall(request)).toThrow(/ownership/)
    uid = 0
    expect(planContinuityHookInstall(request).changed).toBe(true)
  })
})
