import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildFreshRunnerArgs,
  continuityConfigFingerprint,
  parseContinuityConfig,
  readContinuityConfig,
} from "../../../senses/shepherd/continuity-config"

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuity-config-")))
  const desk = path.join(base, "desk")
  const code = path.join(base, "code")
  fs.mkdirSync(desk)
  fs.mkdirSync(code)
  for (const name of ["copilot", "claude", "codex", "agency", "sh", "node"]) {
    fs.writeFileSync(path.join(base, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  }
  const settings = path.join(base, "settings.json")
  fs.writeFileSync(settings, "{}\n", { mode: 0o600 })
  return {
    base, desk, code,
    document: {
      schemaVersion: 1,
      roots: [{
        id: "desk", path: desk, namespace: "track/task", receiptBase: ".continuity/receipts",
        launchRoots: [desk], worktreeRoots: [code],
      }],
      profiles: [{
        id: "worker", runner: "copilot", launcher: "direct", executable: path.join(base, "copilot"),
        argv: ["--allow-all"], rootIds: ["desk"], settingsPath: settings, version: "1.0.97",
      }],
    },
  }
}

describe("continuity registry authority", () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => { f = fixture() })
  afterEach(() => { vi.restoreAllMocks() })

  it("preserves distinct launch and code roots and derives filesystem identity", () => {
    const parsed = parseContinuityConfig(f.document)
    expect(parsed.roots[0]).toMatchObject({
      path: f.desk, launchRoots: [f.desk], worktreeRoots: [f.code],
      identity: { dev: fs.statSync(f.desk).dev, ino: fs.statSync(f.desk).ino },
    })
    expect(parsed.profiles[0].fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(fs.existsSync(path.join(f.desk, ".continuity"))).toBe(false)
  })

  it("reads an absent registry as a no-op, but refuses a malformed present registry", () => {
    expect(readContinuityConfig({})).toBeNull()
    expect(readContinuityConfig({ shepherd: {} })).toBeNull()
    expect(readContinuityConfig({ shepherd: { continuity: f.document }, token: "not-read" }))
      .toMatchObject({ schemaVersion: 1 })
    for (const runtime of [{ shepherd: null }, { shepherd: [] }, { shepherd: { continuity: null } }]) {
      expect(() => readContinuityConfig(runtime)).toThrow()
    }
  })

  it("fingerprints all approved policy, independently of object-key insertion order", () => {
    const first = parseContinuityConfig(f.document)
    const reordered = { profiles: f.document.profiles, roots: f.document.roots, schemaVersion: 1 }
    expect(continuityConfigFingerprint(parseContinuityConfig(reordered))).toBe(continuityConfigFingerprint(first))
    f.document.profiles[0].argv.push("--model", "test-model")
    const changed = parseContinuityConfig(f.document)
    expect(changed.profiles[0].fingerprint).not.toBe(first.profiles[0].fingerprint)
    expect(continuityConfigFingerprint(changed)).not.toBe(continuityConfigFingerprint(first))
  })

  it.each([
    undefined, null, [], 1, { schemaVersion: 2, roots: [], profiles: [] },
    { schemaVersion: 1, roots: {}, profiles: [] },
    { schemaVersion: 1, roots: [], profiles: {}, token: "credential" },
  ])("rejects malformed documents: %j", (value) => {
    expect(() => parseContinuityConfig(value)).toThrow()
  })

  it("accepts empty end-only registries and exactly 32 unique entries", () => {
    expect(parseContinuityConfig({ schemaVersion: 1, roots: [], profiles: [] }).roots).toEqual([])
    f.document.roots = Array.from({ length: 32 }, (_, i) => ({ ...f.document.roots[0], id: `desk${i}` }))
    f.document.profiles = Array.from({ length: 32 }, (_, i) => ({
      ...f.document.profiles[0], id: `worker${i}`, rootIds: [`desk${i}`],
    }))
    expect(parseContinuityConfig(f.document).profiles).toHaveLength(32)
    f.document.profiles.push({ ...f.document.profiles[0], id: "tooMany" })
    expect(() => parseContinuityConfig(f.document)).toThrow()
    f.document.profiles.pop()
    f.document.roots.push({ ...f.document.roots[0], id: "tooMany" })
    expect(() => parseContinuityConfig(f.document)).toThrow()
  })

  it("rejects duplicate IDs, root references and unconfigured root references", () => {
    f.document.roots.push({ ...f.document.roots[0] })
    expect(() => parseContinuityConfig(f.document)).toThrow()
    f.document.roots.pop()
    f.document.profiles.push({ ...f.document.profiles[0] })
    expect(() => parseContinuityConfig(f.document)).toThrow()
    f.document.profiles.pop()
    for (const refs of [[], ["missing"], ["desk", "desk"]]) {
      f.document.profiles[0].rootIds = refs
      expect(() => parseContinuityConfig(f.document)).toThrow()
    }
  })

  it.each(["../desk", "0desk", "desk/name", "é", "a".repeat(65)])("rejects unsafe IDs: %s", (id) => {
    f.document.roots[0].id = id
    expect(() => parseContinuityConfig(f.document)).toThrow()
  })

  it.each(["../outside", "/absolute", "a/../b", "a//b", "./a", "a\\b", "a\nb", "", "x".repeat(1025)])(
    "rejects escaping or unbounded receipt slots: %s", (receiptBase) => {
      f.document.roots[0].receiptBase = receiptBase
      expect(() => parseContinuityConfig(f.document)).toThrow()
    },
  )

  it("rejects unknown authority and copied credential/environment fields at every level", () => {
    for (const object of [f.document, f.document.roots[0], f.document.profiles[0]]) {
      for (const key of ["env", "token", "identity", "fingerprint", "unexpected"]) {
        expect(() => parseContinuityConfig({
          ...f.document,
          ...(object === f.document ? { [key]: "secret" } : {}),
          roots: object === f.document.roots[0] ? [{ ...object, [key]: "secret" }] : f.document.roots,
          profiles: object === f.document.profiles[0] ? [{ ...object, [key]: "secret" }] : f.document.profiles,
        })).toThrow()
      }
    }
  })

  it("does not repair missing roots, accept files as roots, or accept final symlink authority", () => {
    const original = f.document.roots[0].path
    for (const candidate of ["relative", path.join(f.base, "missing"), f.document.profiles[0].settingsPath, "x".repeat(4097)]) {
      f.document.roots[0].path = candidate
      expect(() => parseContinuityConfig(f.document)).toThrow()
    }
    const alias = path.join(f.base, "alias")
    fs.symlinkSync(original, alias)
    f.document.roots[0].path = alias
    expect(() => parseContinuityConfig(f.document)).toThrow()
    expect(fs.existsSync(path.join(f.base, "missing"))).toBe(false)
  })

  it("rejects unsafe policy paths, namespace strings and inaccessible launch roots", () => {
    f.document.roots[0].launchRoots = [path.join(f.base, "missing")]
    expect(() => parseContinuityConfig(f.document)).toThrow()
    f.document.roots[0].launchRoots = [f.desk]
    for (const namespace of ["../task", "task\nunsafe", "https://u:password@host", "x".repeat(1025)]) {
      f.document.roots[0].namespace = namespace
      expect(() => parseContinuityConfig(f.document)).toThrow()
    }
  })

  it.each([
    ["copilot", "direct", "sh", ["--allow-all"]],
    ["copilot", "direct", "claude", ["--allow-all"]],
    ["codex", "agency", "agency", ["codex"]],
    ["claude", "agency", "agency", ["copilot"]],
    ["copilot", "agency", "agency", ["copilot"]],
    ["copilot", "direct", "node", ["arbitrary.js", "--allow-all"]],
  ])("rejects unsupported launcher pairing %s/%s/%s", (runner, launcher, executable, argv) => {
    Object.assign(f.document.profiles[0], { runner, launcher, executable: path.join(f.base, executable), argv })
    expect(() => parseContinuityConfig(f.document)).toThrow()
  })

  it.each([
    "--resume", "--resume=old", "-r", "-rold", "--continue", "--session-id=old",
    "--session-id", "--interactive", "-i", "-p", "--prompt=unsafe",
    "--bootstrap-nonce=x", "TOKEN=secret", "--token=secret", "https://user:password@example.test",
    "--model\nbad", "",
  ])("rejects unsafe Copilot argv: %s", (arg) => {
    f.document.profiles[0].argv.push(arg)
    expect(() => parseContinuityConfig(f.document)).toThrow()
  })

  it.each(["--continue", "-c", "-cfoo", "--fork-session", "--from-pr=42", "--teleport", "--print", "-pfoo"])(
    "rejects Claude caller-owned reuse or prompt flags: %s", (arg) => {
      Object.assign(f.document.profiles[0], { runner: "claude", executable: path.join(f.base, "claude"), argv: [arg] })
      expect(() => parseContinuityConfig(f.document)).toThrow()
    },
  )

  it("rejects unbounded argv, non-executable authority and writable executable authority", () => {
    f.document.profiles[0].argv = ["--allow-all", "x".repeat(1025)]
    expect(() => parseContinuityConfig(f.document)).toThrow()
    f.document.profiles[0].argv = ["--allow-all", ...Array.from({ length: 64 }, () => "--flag")]
    expect(() => parseContinuityConfig(f.document)).toThrow()
    f.document.profiles[0].argv = ["--allow-all"]
    fs.chmodSync(f.document.profiles[0].executable, 0o600)
    expect(() => parseContinuityConfig(f.document)).toThrow()
    fs.chmodSync(f.document.profiles[0].executable, 0o777)
    expect(() => parseContinuityConfig(f.document)).toThrow()
  })

  it("builds a fresh interactive Copilot launch with shell metacharacters as literal argv", () => {
    const profile = parseContinuityConfig(f.document).profiles[0]
    expect(buildFreshRunnerArgs(profile, "Restore only; $(do-not-run)", "ba952cde-7395-4c63-a845-4a358bc6146c"))
      .toEqual(["--allow-all", "--session-id", "ba952cde-7395-4c63-a845-4a358bc6146c", "--interactive", "Restore only; $(do-not-run)"])
    expect(profile.argv).toEqual(["--allow-all"])
  })

  it("supports Agency Copilot aliases without dropping permission flags", () => {
    for (const alias of ["cp", "copilot"]) {
      Object.assign(f.document.profiles[0], { launcher: "agency", executable: path.join(f.base, "agency"), argv: [alias, "--allow-all"] })
      expect(buildFreshRunnerArgs(parseContinuityConfig(f.document).profiles[0], "restore", "ba952cde-7395-4c63-a845-4a358bc6146c"))
        .toEqual([alias, "--allow-all", "--session-id", "ba952cde-7395-4c63-a845-4a358bc6146c", "--interactive", "restore"])
    }
  })

  it("uses a positional interactive Claude brief, including Agency launch", () => {
    for (const launcher of ["direct", "agency"]) {
      Object.assign(f.document.profiles[0], { runner: "claude", launcher, executable: path.join(f.base, launcher === "agency" ? "agency" : "claude"), argv: launcher === "agency" ? ["claude"] : [] })
      expect(buildFreshRunnerArgs(parseContinuityConfig(f.document).profiles[0], "restore", "ba952cde-7395-4c63-a845-4a358bc6146c"))
        .toEqual([...(launcher === "agency" ? ["claude"] : []), "--session-id", "ba952cde-7395-4c63-a845-4a358bc6146c", "restore"])
    }
  })

  it("allows Codex config -c but rejects resume, fork and noninteractive exec subcommands", () => {
    Object.assign(f.document.profiles[0], { runner: "codex", executable: path.join(f.base, "codex"), argv: ["-c", "model=test"] })
    expect(buildFreshRunnerArgs(parseContinuityConfig(f.document).profiles[0], "restore", "ba952cde-7395-4c63-a845-4a358bc6146c"))
      .toEqual(["-c", "model=test", "restore"])
    for (const arg of ["resume", "fork", "exec", "--resume=old"]) {
      f.document.profiles[0].argv = [arg]
      expect(() => parseContinuityConfig(f.document)).toThrow()
    }
  })

  it("refuses empty/control-bearing restore instructions and non-UUID reserved IDs", () => {
    const profile = parseContinuityConfig(f.document).profiles[0]
    for (const brief of ["", "unsafe\0instruction", "x".repeat(65537)]) {
      expect(() => buildFreshRunnerArgs(profile, brief, "ba952cde-7395-4c63-a845-4a358bc6146c")).toThrow()
    }
    for (const id of ["old", "", "../../old", "ba952cde-7395-4c63-a845-4a358bc6146c\n"]) {
      expect(() => buildFreshRunnerArgs(profile, "restore", id)).toThrow()
    }
  })

  it("rejects missing required fields and unknown runner/launcher variants", () => {
    expect(() => parseContinuityConfig({ schemaVersion: 1, roots: [] })).toThrow()
    for (const change of [{ runner: "other" }, { launcher: "shell" }]) {
      expect(() => parseContinuityConfig({
        ...f.document, profiles: [{ ...f.document.profiles[0], ...change }],
      })).toThrow()
    }
  })

  it("refuses group-writable or differently owned directory authority", () => {
    fs.chmodSync(f.desk, 0o770)
    expect(() => parseContinuityConfig(f.document)).toThrow()
    fs.chmodSync(f.desk, 0o700)
    const actual = fs.lstatSync.bind(fs)
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = actual(...args)
      if (args[0] === f.desk && stat instanceof fs.Stats) stat.uid = process.getuid!() + 100
      return stat
    })
    expect(() => parseContinuityConfig(f.document)).toThrow()
  })

  it("accepts root-owned executable and directory policy but rejects foreign executables", () => {
    const directoryStat = fs.lstatSync.bind(fs)
    const executableStat = fs.statSync.bind(fs)
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = directoryStat(...args)
      if (stat instanceof fs.Stats) stat.uid = 0
      return stat
    })
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      const stat = executableStat(...args)
      if (stat instanceof fs.Stats) stat.uid = 0
      return stat
    })
    expect(parseContinuityConfig(f.document).roots[0].path).toBe(f.desk)
    vi.mocked(fs.statSync).mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      const stat = executableStat(...args)
      if (stat instanceof fs.Stats) stat.uid = process.getuid!() + 100
      return stat
    })
    expect(() => parseContinuityConfig(f.document)).toThrow()
  })

  it("rejects credential switches even when the secret is in the next argv element", () => {
    for (const flag of ["--token", "--api-key", "--password", "--authorization"]) {
      f.document.profiles[0].argv = ["--allow-all", flag, "opaque-credential"]
      expect(() => parseContinuityConfig(f.document)).toThrow()
    }
  })

  it("rejects caller positional prompts and an option terminator", () => {
    for (const args of [
      ["--allow-all", "do work"], ["--allow-all", "--", "do work"],
      ["--allow-all", "FOO=value"], ["--allow-all", "env"],
      ["--allow-all", "--model"], ["--allow-all", "--model", "--unsafe"],
    ]) {
      f.document.profiles[0].argv = args
      expect(() => parseContinuityConfig(f.document)).toThrow()
    }
    f.document.profiles[0].argv = ["--allow-all", "--model=test"]
    expect(parseContinuityConfig(f.document).profiles[0].argv).toEqual(["--allow-all", "--model=test"])
  })

  it("does not accept inline JSON configuration containing nested credentials or environment maps", () => {
    for (const argv of [
      ["--allow-all", '--mcp-config={"mcpServers":{"fixture":{"command":"placeholder","env":{"API_KEY":"synthetic"}}}}'],
      ["--allow-all", "--mcp-config", '{"nested":{"token":"synthetic"}}'],
      ["--allow-all", '--mcp-config={"nested":{"password":"synthetic"}}'],
      ["--allow-all", "--mcp-config", '{"args":["fixture=value"],"env":{"API_KEY":"synthetic"}}'],
      ["--allow-all", "--mcp-config", '["fixture=value",{"token":"synthetic"}]'],
    ]) {
      f.document.profiles[0].argv = argv
      expect(() => parseContinuityConfig(f.document)).toThrow()
    }
  })
})
