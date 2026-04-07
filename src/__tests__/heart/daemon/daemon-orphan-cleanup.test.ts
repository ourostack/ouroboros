import { describe, it, expect } from "vitest"
import { parseOrphanPidsFromPs } from "../../../heart/daemon/daemon"

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
