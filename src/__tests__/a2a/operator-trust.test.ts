import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { overrideOwnerForTests } from "../../a2a/trusted-files"
import {
  agentNameFromRoot, describeGrantFile, ensureTrustDirectory, overrideDirectoryFlushForTests, overrideFchownForTests, overrideLockTimeoutForTests, withTrustedWriteLock, operatorTrustDir, operatorTrustFile, overrideTrustRootForTests, readGrantFile, TrustDirectoryError, writeTrustedFile,
} from "../../a2a/operator-trust"

let tmp: TmpBundleHandle
beforeEach(() => { tmp = createTmpBundle({ agentName: `trust-${Date.now()}` }) })
afterEach(() => { vi.unstubAllEnvs(); overrideOwnerForTests(undefined); tmp.cleanup() })

const NOW = new Date("2026-10-09T00:00:00.000Z")
const anyEntry = (value: unknown): value is { ok: true } => (value as { ok?: unknown } | null)?.ok === true

describe("where the trust directory is", () => {
  it("names the agent from its bundle root", () => {
    expect(agentNameFromRoot("/home/x/AgentBundles/sanctuary.ouro")).toBe("sanctuary")
    expect(agentNameFromRoot("/home/x/plain")).toBe("plain")
  })

  it("defaults to /etc/ouro/trust/<agent>, honours OURO_OPERATOR_TRUST_DIR, and ignores a blank override", () => {
    overrideTrustRootForTests(undefined)
    try {
      const etc = fs.realpathSync("/etc")
      expect(operatorTrustDir("/b/sanctuary.ouro")).toBe(`${etc}/ouro/trust/sanctuary`)
      vi.stubEnv("OURO_OPERATOR_TRUST_DIR", "/mnt/trust/x")
      // The override names the parent: each agent still gets its own subdirectory under it.
      expect(operatorTrustDir("/b/sanctuary.ouro")).toBe("/mnt/trust/x/sanctuary")
      expect(operatorTrustFile("/b/sanctuary.ouro", "g.json")).toBe("/mnt/trust/x/sanctuary/g.json")
      vi.stubEnv("OURO_OPERATOR_TRUST_DIR", "  ")
      expect(operatorTrustDir("/b/sanctuary.ouro")).toBe(`${etc}/ouro/trust/sanctuary`)
    } finally {
      overrideTrustRootForTests(path.join(process.env.OURO_TEST_ISOLATED_ROOT!, "operator-trust"))
    }
  })

  it("resolves a symlinked trust root once (macOS /etc is /private/etc) and keeps a missing tail", () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trust-real-")))
    try {
      fs.mkdirSync(path.join(base, "real", "ouro"), { recursive: true })
      fs.symlinkSync(path.join(base, "real"), path.join(base, "etc"))
      overrideTrustRootForTests(path.join(base, "etc", "ouro", "trust"))
      expect(operatorTrustDir("/b/sanctuary.ouro")).toBe(path.join(base, "real", "ouro", "trust", "sanctuary"))
      vi.stubEnv("OURO_OPERATOR_TRUST_DIR", path.join(base, "etc", "ouro", "elsewhere"))
      expect(operatorTrustDir("/b/sanctuary.ouro")).toBe(path.join(base, "real", "ouro", "elsewhere", "sanctuary"))
      vi.stubEnv("OURO_OPERATOR_TRUST_DIR", path.join(base, "etc", "ouro"))
      expect(operatorTrustFile("/b/sanctuary.ouro", "g.json")).toBe(path.join(base, "real", "ouro", "sanctuary", "g.json"))
    } finally {
      overrideTrustRootForTests(path.join(process.env.OURO_TEST_ISOLATED_ROOT!, "operator-trust"))
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it("accepts a grant file reached through a symlinked configured root once the resolved chain is trusted", () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trust-link-")))
    try {
      fs.mkdirSync(path.join(base, "real", "sanctuary"), { recursive: true, mode: 0o755 })
      fs.writeFileSync(path.join(base, "real", "sanctuary", "g.json"), JSON.stringify({ schemaVersion: 1, grants: { a: { ok: true } } }), { mode: 0o644 })
      fs.symlinkSync(path.join(base, "real"), path.join(base, "etc"))
      overrideTrustRootForTests(path.join(base, "etc"))
      expect(readGrantFile("/b/sanctuary.ouro", "g.json", anyEntry).state).toBe("trusted")
    } finally {
      overrideTrustRootForTests(path.join(process.env.OURO_TEST_ISOLATED_ROOT!, "operator-trust"))
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it("refuses the test-only root outside a test runner", () => {
    vi.stubEnv("VITEST", undefined as unknown as string)
    expect(() => overrideTrustRootForTests("/x")).toThrow("tests only")
  })
})

describe("reading a grant file", () => {
  const put = (body: string, mode = 0o644) => {
    const file = operatorTrustFile(tmp.agentRoot, "g.json")
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
    fs.writeFileSync(file, body)
    fs.chmodSync(file, mode)
  }

  it("reports missing, untrusted and trusted files, and drops entries that fail the shape", () => {
    expect(readGrantFile(tmp.agentRoot, "g.json", anyEntry).state).toBe("missing")
    put("{\"schemaVersion\":1,\"grants\":{\"a\":{\"ok\":true},\"b\":{\"ok\":false}}}")
    expect(readGrantFile(tmp.agentRoot, "g.json", anyEntry)).toEqual({ state: "trusted", grants: { a: { ok: true } }, ignored: ["b"] })
    put("{\"schemaVersion\":1,\"grants\":{}}", 0o666)
    expect(readGrantFile(tmp.agentRoot, "g.json", anyEntry)).toMatchObject({ state: "untrusted", grants: {} })
    put("{\"schemaVersion\":1}")
    expect(readGrantFile(tmp.agentRoot, "g.json", anyEntry)).toMatchObject({ state: "untrusted", reason: expect.stringContaining("schemaVersion") })
    put("null")
    expect(readGrantFile(tmp.agentRoot, "g.json", anyEntry).state).toBe("untrusted")
  })

  it("describes the file for list output", () => {
    const file = "/x/g.json"
    expect(describeGrantFile({ state: "trusted", grants: {}, ignored: [] }, file)).toBe("trusted: /x/g.json")
    expect(describeGrantFile({ state: "missing", grants: {}, ignored: [] }, file)).toBe("not present: /x/g.json")
    expect(describeGrantFile({ state: "untrusted", reason: "why", grants: {}, ignored: [] }, file)).toContain("NOT TRUSTED")
  })
})

describe("creating the trust directory", () => {
  it("creates missing components below a trusted ancestor with mode 0755", () => {
    const dir = path.join(tmp.bundlesRoot, "a", "b", "trust")
    ensureTrustDirectory(dir)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755)
    ensureTrustDirectory(dir)
  })

  it("refuses when an existing ancestor is untrusted, and creates nothing", () => {
    const base = path.join(tmp.bundlesRoot, "agent-owned")
    fs.mkdirSync(base, { mode: 0o755 })
    overrideOwnerForTests((target) => (target === base ? process.getuid!() + 1 : undefined))
    expect(() => ensureTrustDirectory(path.join(base, "trust"))).toThrow(TrustDirectoryError)
    expect(fs.readdirSync(base)).toEqual([])
  })

  it("refuses a symlinked trust directory", () => {
    const real = path.join(tmp.bundlesRoot, "real")
    fs.mkdirSync(real)
    const link = path.join(tmp.bundlesRoot, "link")
    fs.symlinkSync(real, link)
    expect(() => ensureTrustDirectory(link)).toThrow("not trusted")
  })
})

describe("writing a trust file", () => {
  it("writes through an exclusive temporary file, leaves no temporary behind, and backs up what it replaces", () => {
    const first = writeTrustedFile(tmp.agentRoot, "g.json", "one\n", NOW)
    expect(first.backup).toBeNull()
    const second = writeTrustedFile(tmp.agentRoot, "g.json", "two\n", NOW)
    const dir = operatorTrustDir(tmp.agentRoot)
    expect(fs.readFileSync(path.join(dir, "g.json"), "utf8")).toBe("two\n")
    expect(fs.readFileSync(second.backup!, "utf8")).toBe("one\n")
    expect(fs.statSync(second.backup!).mode & 0o777).toBe(0o644)
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("does not follow a symlink planted where the file goes: it replaces the link and leaves the target alone", () => {
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const victim = path.join(tmp.bundlesRoot, "victim.txt")
    fs.writeFileSync(victim, "keep")
    fs.symlinkSync(victim, path.join(dir, "g.json"))
    const written = writeTrustedFile(tmp.agentRoot, "g.json", "new\n", NOW)
    expect(written.backup).toBeNull()
    expect(fs.readFileSync(victim, "utf8")).toBe("keep")
    expect(fs.lstatSync(path.join(dir, "g.json")).isSymbolicLink()).toBe(false)
  })

  it("refuses to overwrite a backup that already exists, and cleans up its temporary file when the rename fails", () => {
    writeTrustedFile(tmp.agentRoot, "g.json", "one\n", NOW)
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.writeFileSync(path.join(dir, `g.json.bak-${NOW.toISOString().replace(/[:.]/gu, "-")}`), "taken")
    expect(() => writeTrustedFile(tmp.agentRoot, "g.json", "two\n", NOW)).toThrow()
    expect(fs.readFileSync(path.join(dir, "g.json"), "utf8")).toBe("one\n")
    fs.mkdirSync(path.join(dir, "blocked.json"))
    expect(() => writeTrustedFile(tmp.agentRoot, "blocked.json", "x", NOW)).toThrow()
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("backs up even a file the agent's uid could have written", () => {
    writeTrustedFile(tmp.agentRoot, "g.json", "one\n", NOW)
    const file = path.join(operatorTrustDir(tmp.agentRoot), "g.json")
    fs.chmodSync(file, 0o666)
    const next = writeTrustedFile(tmp.agentRoot, "g.json", "two\n", new Date(NOW.getTime() + 1))
    expect(fs.readFileSync(next.backup!, "utf8")).toBe("one\n")
  })

  it("refuses to write into an untrusted directory", () => {
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o777)
    expect(() => writeTrustedFile(tmp.agentRoot, "g.json", "x", NOW)).toThrow(TrustDirectoryError)
  })
})

describe("serialising writers and making renames durable (review of #1064, finding 8)", () => {
  it("fsyncs the trust directory after a backup and after the rename", () => {
    writeTrustedFile(tmp.agentRoot, "g.json", "one\n", NOW)
    const flushed: string[] = []
    overrideDirectoryFlushForTests((dir) => flushed.push(dir))
    try {
      writeTrustedFile(tmp.agentRoot, "g.json", "two\n", NOW)
      writeTrustedFile(tmp.agentRoot, "fresh.json", "x\n", NOW)
    } finally { overrideDirectoryFlushForTests(undefined) }
    const dir = operatorTrustDir(tmp.agentRoot)
    // backup + rename for the replaced file, rename only for the new one
    expect(flushed).toEqual([dir, dir, dir])
  })

  it("refuses the test seams outside a test runner", () => {
    vi.stubEnv("VITEST", undefined as unknown as string)
    expect(() => overrideDirectoryFlushForTests(undefined)).toThrow("tests only")
    expect(() => overrideLockTimeoutForTests(1)).toThrow("tests only")
    expect(() => overrideFchownForTests(undefined)).toThrow("tests only")
  })

  it("holds an exclusive lock file while a command writes, and releases it afterwards, also when the write throws", () => {
    const dir = operatorTrustDir(tmp.agentRoot)
    let inside = false
    withTrustedWriteLock(tmp.agentRoot, () => { inside = fs.existsSync(path.join(dir, ".lock")) })
    expect(inside).toBe(true)
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(false)
    expect(() => withTrustedWriteLock(tmp.agentRoot, () => { throw new Error("boom") })).toThrow("boom")
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(false)
  })

  it("refuses to write while another writer holds a fresh lock, and says how to clear a stuck one", () => {
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.writeFileSync(path.join(dir, ".lock"), "pid 1\n")
    overrideLockTimeoutForTests(40)
    try {
      expect(() => withTrustedWriteLock(tmp.agentRoot, () => "never")).toThrow(/another grant command is writing.*\.lock/s)
    } finally { overrideLockTimeoutForTests(undefined) }
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(true)
  })

  it("passes on a lock error that is not 'already exists'", () => {
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.chmodSync(dir, 0o555)
    try {
      expect(() => withTrustedWriteLock(tmp.agentRoot, () => "never")).toThrow(/EACCES/)
    } finally { fs.chmodSync(dir, 0o755) }
  })

  it("takes over a stale lock left by a crashed writer", () => {
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const lock = path.join(dir, ".lock")
    fs.writeFileSync(lock, "pid 1\n")
    const old = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(lock, old, old)
    expect(withTrustedWriteLock(tmp.agentRoot, () => "ran")).toBe("ran")
    expect(fs.existsSync(lock)).toBe(false)
  })

  describe("taking over a stale lock (review of #1064, round 2, finding 6)", () => {
    const staleLock = () => {
      const dir = operatorTrustDir(tmp.agentRoot)
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      const lock = path.join(dir, ".lock")
      fs.writeFileSync(lock, "pid 1\n")
      const old = new Date(Date.now() - 10 * 60_000)
      fs.utimesSync(lock, old, old)
      return { dir, lock, old }
    }

    it("two writers that both judge the lock stale cannot both take it: the second leaves the first one's fresh lock alone", () => {
      const { lock } = staleLock()
      // Writer A finishes its takeover (stale lock gone, its own fresh lock in place) after writer B judged the lock stale and before B reclaims.
      overrideLockTimeoutForTests(60, undefined, () => { fs.rmSync(lock); fs.writeFileSync(lock, "pid A\n") })
      try {
        let ran = false
        expect(() => withTrustedWriteLock(tmp.agentRoot, () => { ran = true })).toThrow(/another grant command is writing/)
        expect(ran).toBe(false)
        expect(fs.readFileSync(lock, "utf8")).toBe("pid A\n")
        expect(fs.existsSync(`${lock}.reclaim`)).toBe(false)
      } finally { overrideLockTimeoutForTests(undefined) }
    })

    it("carries on when the stale lock disappears before it can be reclaimed", () => {
      const { lock } = staleLock()
      overrideLockTimeoutForTests(2000, undefined, () => fs.rmSync(lock))
      try {
        expect(withTrustedWriteLock(tmp.agentRoot, () => "ran")).toBe("ran")
      } finally { overrideLockTimeoutForTests(undefined) }
    })

    it("waits while another writer holds the reclaim file, and clears a reclaim file left by a dead one", () => {
      const { dir, lock, old } = staleLock()
      const guard = path.join(dir, ".lock.reclaim")
      fs.writeFileSync(guard, "pid 2\n")
      overrideLockTimeoutForTests(60)
      try {
        expect(() => withTrustedWriteLock(tmp.agentRoot, () => "never")).toThrow(/another grant command is writing/)
        expect(fs.existsSync(lock)).toBe(true)
        fs.utimesSync(guard, old, old)
        overrideLockTimeoutForTests(2000)
        expect(withTrustedWriteLock(tmp.agentRoot, () => "ran")).toBe("ran")
        expect(fs.existsSync(guard)).toBe(false)
      } finally { overrideLockTimeoutForTests(undefined) }
    })
  })

  it("waits for a lock that is released while it waits", () => {
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const lock = path.join(dir, ".lock")
    fs.writeFileSync(lock, "pid 1\n")
    overrideLockTimeoutForTests(2000, () => fs.rmSync(lock, { force: true }))
    try {
      expect(withTrustedWriteLock(tmp.agentRoot, () => "ran")).toBe("ran")
    } finally { overrideLockTimeoutForTests(undefined) }
  })
})
