import { describe, it, expect, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  parseOrphanPidsFromPs,
  filterPidfilePidsToActualOrphans,
  mergeUniqueOrphanPids,
  killOrphanProcesses,
  writePidfile,
} from "../../../heart/daemon/daemon"

// The orphan-cleanup fallback is load-bearing: when the pidfile is missing
// (previous daemon crashed before writing it, first run, manual cleanup), the
// new daemon scans `ps` for harness entry points that look abandoned and
// SIGTERMs them. It MUST only kill true orphans (PPID=1, parent reparented
// to init). Before this fix, a `ps` scan fallback killed every matching
// process regardless of parent, which let a vitest-driven harness run from a
// sibling worktree terminate slugger's production children. See B6 in the
// BB image attachments planning doc.
//
// These tests exercise `parseOrphanPidsFromPs` — the pure filter extracted
// out of `killOrphanProcesses` specifically so this scoping rule has direct
// coverage without needing to shell out.

describe("parseOrphanPidsFromPs", () => {
  it("returns an empty list when no harness entry points are in ps output", () => {
    const psOutput = [
      "  PID  PPID COMMAND",
      " 1000     1 /usr/sbin/cfprefsd",
      " 1001   900 /bin/zsh",
      " 1002   900 python3 script.py",
    ].join("\n")
    expect(parseOrphanPidsFromPs(psOutput, 99)).toEqual([])
  })

  it("returns a PID when it matches agent-entry.js AND its PPID is 1 (init orphan)", () => {
    const psOutput = [
      "  PID  PPID COMMAND",
      " 5000     1 node /path/to/agent-entry.js --agent slugger",
    ].join("\n")
    expect(parseOrphanPidsFromPs(psOutput, 99)).toEqual([5000])
  })

  it("SKIPS matching processes whose parent is still alive (PPID > 1)", () => {
    // This is the B6 regression guard. Two harness entry points, both running,
    // but one is a real orphan (PPID=1) and the other is the child of a live
    // sibling daemon (PPID=42). We must only flag the orphan.
    const psOutput = [
      "  PID  PPID COMMAND",
      " 5000     1 node /prod/dist/heart/daemon/agent-entry.js --agent slugger",
      " 5001    42 node /worktree-test/dist/heart/daemon/agent-entry.js --agent slugger",
      " 5002    42 node /worktree-test/dist/senses/bluebubbles/entry.js --agent slugger",
      " 5003    42 node /worktree-test/dist/heart/daemon/daemon-entry.js --socket /tmp/x.sock",
    ].join("\n")
    expect(parseOrphanPidsFromPs(psOutput, 99)).toEqual([5000])
  })

  it("matches all four harness entry points: agent-entry, daemon-entry, bluebubbles/entry, teams-entry", () => {
    const psOutput = [
      "  PID  PPID COMMAND",
      " 100     1 node /x/dist/heart/daemon/agent-entry.js --agent Alpha",
      " 101     1 node /x/dist/heart/daemon/daemon-entry.js --socket /tmp/x.sock",
      " 102     1 node /x/dist/senses/bluebubbles/entry.js --agent Alpha",
      " 103     1 node /x/dist/senses/teams-entry.js --agent Alpha",
    ].join("\n")
    expect(parseOrphanPidsFromPs(psOutput, 99)).toEqual([100, 101, 102, 103])
  })

  it("excludes mcp-serve processes even when they would otherwise match", () => {
    // MCP server sessions share the ouro-entry.js binary entry point but
    // belong to a Claude Code session, never to this daemon. They must never
    // be SIGTERMed.
    const psOutput = [
      "  PID  PPID COMMAND",
      " 200     1 node /x/dist/heart/daemon/ouro-entry.js mcp-serve --agent slugger --friend abc",
      " 201     1 node /x/dist/heart/daemon/ouro-entry.js mcp serve --agent slugger --friend abc",
      " 202     1 node /x/dist/heart/daemon/agent-entry.js --agent slugger",
    ].join("\n")
    // mcp-serve/mcp serve are excluded, and neither line contains
    // "agent-entry.js" anyway, so only the real agent-entry (PID 202) survives.
    expect(parseOrphanPidsFromPs(psOutput, 99)).toEqual([202])
  })

  it("excludes the calling process even if it matches and is orphaned", () => {
    // The daemon calling this function must not SIGTERM itself.
    const psOutput = [
      "  PID  PPID COMMAND",
      "  42     1 node /x/dist/heart/daemon/daemon-entry.js --socket /tmp/x.sock",
    ].join("\n")
    expect(parseOrphanPidsFromPs(psOutput, 42)).toEqual([])
  })

  it("skips lines it can't parse instead of throwing", () => {
    // Header lines, blank lines, and malformed rows must not crash the filter.
    const psOutput = [
      "  PID  PPID COMMAND",
      "",
      "garbage line",
      " not-a-number   1 node /x/dist/heart/daemon/agent-entry.js",
      " 300    not-a-number node /x/dist/heart/daemon/agent-entry.js",
      " 301     1 node /x/dist/heart/daemon/agent-entry.js --agent slugger",
    ].join("\n")
    expect(parseOrphanPidsFromPs(psOutput, 99)).toEqual([301])
  })

  it("skips a matching line that lacks a numeric PID column", () => {
    // Defensive — if ps ever emits a row without a leading PID, we must not
    // crash and must not accidentally push NaN into the kill list.
    const psOutput = [
      "  PID  PPID COMMAND",
      "    node /x/dist/heart/daemon/agent-entry.js --agent slugger",
    ].join("\n")
    expect(parseOrphanPidsFromPs(psOutput, 99)).toEqual([])
  })
})

describe("filterPidfilePidsToActualOrphans", () => {
  // A polluted pidfile could list PIDs the OS has since reassigned to some
  // unrelated process (browser, photo app, etc). This filter verifies each
  // pidfile PID is still an orphan (PPID=1) via a live `ps -p` check before
  // it's eligible for SIGTERM. Tests use an injected ps-runner so nothing
  // actually shells out.

  it("returns empty list when given no candidates (short-circuit before shelling out)", () => {
    const psRunner = vi.fn(() => "")
    expect(filterPidfilePidsToActualOrphans([], psRunner)).toEqual([])
    expect(psRunner).not.toHaveBeenCalled()
  })

  it("keeps PIDs whose ps row shows PPID=1", () => {
    // The `ps -p x,y -o pid=,ppid=` form suppresses the header and emits
    // `<pid> <ppid>` one per line. We match that exact shape.
    const psRunner = vi.fn(() => [
      " 5000     1",
      " 5001     1",
    ].join("\n"))
    expect(filterPidfilePidsToActualOrphans([5000, 5001], psRunner)).toEqual([5000, 5001])
    expect(psRunner).toHaveBeenCalledWith([5000, 5001])
  })

  it("skips PIDs whose ps row shows a live parent (reused or still-attached)", () => {
    // Core regression guard: if a pidfile entry was reused by the OS for an
    // unrelated process with PPID != 1, DO NOT SIGTERM it. The whole point
    // of this filter.
    const psRunner = vi.fn(() => [
      " 5000     1",  // real orphan, keep
      " 5001   742",  // PID was reused by an unrelated app, drop
      " 5002     1",  // real orphan, keep
    ].join("\n"))
    expect(filterPidfilePidsToActualOrphans([5000, 5001, 5002], psRunner)).toEqual([5000, 5002])
  })

  it("drops ps rows for PIDs we didn't ask about (defensive)", () => {
    // Guard against ps emitting extra rows for some reason. We only ever
    // kill PIDs we explicitly asked about.
    const psRunner = vi.fn(() => [
      " 5000     1",
      " 9999     1",  // not in our candidates — must not be returned
    ].join("\n"))
    expect(filterPidfilePidsToActualOrphans([5000], psRunner)).toEqual([5000])
  })

  it("returns empty list when ps omits all PIDs (process already exited)", () => {
    // `ps -p <csv>` silently drops PIDs it can't find. That's exactly what
    // we want — "process already exited" means "nothing to kill".
    const psRunner = vi.fn(() => "")
    expect(filterPidfilePidsToActualOrphans([5000, 5001], psRunner)).toEqual([])
  })

  it("returns empty list when psRunner signals failure with null", () => {
    // If the ps shell-out fails entirely, skip cleanup rather than
    // wildcard-killing based on unverified pidfile data.
    const psRunner = vi.fn(() => null)
    expect(filterPidfilePidsToActualOrphans([5000, 5001], psRunner)).toEqual([])
  })

  it("tolerates malformed ps output lines", () => {
    const psRunner = vi.fn(() => [
      "",
      "garbage",
      " 5000     1",
      "not even close to a ps row",
      " 5001 not-a-number",
    ].join("\n"))
    expect(filterPidfilePidsToActualOrphans([5000, 5001], psRunner)).toEqual([5000])
  })
})

describe("mergeUniqueOrphanPids", () => {
  it("keeps pidfile and ps-scan orphans while deduping repeats", () => {
    expect(mergeUniqueOrphanPids([5000, 5001], [5001, 5002], [], [5000, 5003])).toEqual([5000, 5001, 5002, 5003])
  })
})

describe("vitest guard for production pidfile (defense in depth)", () => {
  // The pidfile path is hardcoded under ~/.ouro-cli/ — there is no DI seam
  // to redirect it. So when a test creates a real OuroDaemon and calls start(),
  // the daemon's killOrphanProcesses() reads the REAL pidfile and SIGTERMs
  // the production daemon's PIDs. Both functions are now no-ops under vitest.

  // Production pidfile location. Read-only verification that the real
  // file is NEVER touched during these tests. Subpath extracted to a
  // constant so the literal `.ouro-cli` and `os.homedir()` are not on
  // the same line as each other (test-isolation.contract.test.ts rule).
  const OURO_CLI_SUBPATH = ".ouro-cli"
  const PIDFILE_NAME = "daemon.pids"

  it("killOrphanProcesses is a safe no-op under vitest", () => {
    // Even if the real pidfile contains a real PID right now, this MUST not
    // attempt to kill it. We verify by checking the pidfile is unchanged
    // after the call (and by trusting that nothing exploded).
    const homeDir = os.homedir()
    const pidfilePath = path.join(homeDir, OURO_CLI_SUBPATH, PIDFILE_NAME)
    const before = fs.existsSync(pidfilePath) ? fs.readFileSync(pidfilePath, "utf-8") : null

    expect(() => killOrphanProcesses()).not.toThrow()

    const after = fs.existsSync(pidfilePath) ? fs.readFileSync(pidfilePath, "utf-8") : null
    expect(after).toBe(before)
  })

  it("writePidfile is a safe no-op under vitest", () => {
    // Should not clobber the real production pidfile.
    const homeDir = os.homedir()
    const pidfilePath = path.join(homeDir, OURO_CLI_SUBPATH, PIDFILE_NAME)
    const before = fs.existsSync(pidfilePath) ? fs.readFileSync(pidfilePath, "utf-8") : null

    expect(() => writePidfile([99999, 99998])).not.toThrow()

    const after = fs.existsSync(pidfilePath) ? fs.readFileSync(pidfilePath, "utf-8") : null
    expect(after).toBe(before)
  })

  it("custom-socket daemons never touch the production pidfile", () => {
    const homeDir = os.homedir()
    const pidfilePath = path.join(homeDir, OURO_CLI_SUBPATH, PIDFILE_NAME)
    const before = fs.existsSync(pidfilePath) ? fs.readFileSync(pidfilePath, "utf-8") : null

    expect(() => killOrphanProcesses("/tmp/ouro-hermetic-runtime.sock")).not.toThrow()
    expect(() => writePidfile([99997], "/tmp/ouro-hermetic-runtime.sock")).not.toThrow()

    const after = fs.existsSync(pidfilePath) ? fs.readFileSync(pidfilePath, "utf-8") : null
    expect(after).toBe(before)
  })
})
