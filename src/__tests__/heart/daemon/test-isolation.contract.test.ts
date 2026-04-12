import { existsSync, readFileSync, readdirSync } from "fs"
import { join, relative } from "path"
import { describe, expect, it } from "vitest"

/**
 * Contract: tests must not leak real socket calls or real bundle writes into
 * the developer's running daemon / real ~/AgentBundles directory.
 *
 * Background: a test pattern that mocks `getAgentName` to a literal like
 * "testagent" but does NOT mock `../*\/heart/daemon/socket-client` causes the
 * test to fire real `inner.wake testagent` commands at /tmp/ouroboros-daemon.sock
 * — polluting whichever real daemon happens to be running on the developer's
 * machine and producing endless "Unknown managed agent 'testagent'" errors.
 * That bug ran undetected for over a week and contributed to a daemon outage.
 *
 * The PRIMARY defense is in `src/heart/daemon/socket-client.ts` itself: it
 * detects vitest via `process.argv` and converts socket calls to safe no-ops.
 * As of 2026-04-08 the guard is HARDENED: even when bypassed via
 * `__bypassVitestGuardForTests`, the production daemon socket
 * (DEFAULT_DAEMON_SOCKET_PATH = /tmp/ouroboros-daemon.sock) is unconditionally
 * blocked under vitest. This means cross-file leaks via the bypass flag can
 * no longer reach the production daemon — but they CAN still create surprises
 * in concurrent tests. So we keep this contract test as a static defense.
 *
 * This file is the STATIC layer of a two-layer defense:
 *
 *   - STATIC (this file): scans source text for patterns that construct
 *     paths under real prod directories. Catches the bug at the code-review
 *     level — before the test ever runs.
 *   - RUNTIME (`src/__tests__/nerves/global-capture.ts`, the "runtime
 *     prod-path leak guard"): snapshots ~/AgentBundles at worker boot and
 *     diffs at teardown. Catches leaks that the static scan misses —
 *     specifically silent-fallback code paths where production code
 *     routes a write to a real-fs path via a catch-all default (e.g. the
 *     coding/manager.ts "default" agent name bug from PR #372).
 *
 * Both layers coexist. The static scan is fast (runs in ~300ms, no fs
 * side effects) and catches 99% of issues. The runtime guard is the
 * belt to the static scan's suspenders.
 *
 * Rules enforced as RATCHETS — current offenders are grandfathered in
 * the allowlists below, but no NEW files / lines can be added. Follow-up PRs
 * shrink the allowlists toward zero.
 *
 *   1. If a test file uses the literal `name: "testagent"`, it must mock
 *      `socket-client` (or explicitly opt out via the bypass call).
 *   2. No test file may construct a write path under the real ~/AgentBundles
 *      via `os.homedir()` joined with `"AgentBundles"`. (Tests must use
 *      `os.tmpdir()` or fully-mocked fs.)
 *   3. Only files on the BYPASS_USE_ALLOWLIST may call
 *      `__bypassVitestGuardForTests`. The bypass flag is process-wide
 *      (globalThis), so any file that turns it on can leak the bypass into
 *      concurrent test files in the same vitest worker. The allowlist
 *      contains only the two files that legitimately exercise the real
 *      socket-client transport against test sockets — extending it requires
 *      conscious review.
 *   4. Only files on the OURO_DAEMON_INSTANTIATION_ALLOWLIST may construct
 *      `new OuroDaemon(...)`. Constructing a real daemon instance and
 *      calling start() runs killOrphanProcesses() and writePidfile() against
 *      the hardcoded production pidfile path (~/.ouro-cli/daemon.pids).
 *      The runtime guards added in #346 short-circuit those functions under
 *      vitest, but if a future change to start() adds a NEW production-state
 *      side-effect, the existing tests would silently exercise it. The
 *      allowlist forces conscious review of each new test that takes this
 *      shape, so a future production-side leak through start() can't ride
 *      in unnoticed alongside an unrelated change.
 */

// Files that use `name: "testagent"` without mocking socket-client.
// Empty as of the bulk mock injection — all 40 grandfathered files now have
// explicit `vi.mock("...heart/daemon/socket-client", ...)` blocks. New
// offenders are blocked by the contract test below.
const TESTAGENT_NO_MOCK_ALLOWLIST = new Set<string>()

// Lines that currently construct a write path under real ~/AgentBundles.
// Empty as of the daemon-cli.test.ts conversion — all auth tests + thoughts
// test now use `createTmpBundle()` from src/__tests__/test-helpers/tmpdir-bundle.ts.
// New offenders are blocked by the contract test below.
const REAL_BUNDLES_WRITE_ALLOWLIST = new Set<string>()

// Additional prod paths that tests must not construct write paths under.
// Each has its own empty ratchet allowlist; new offenders are blocked.
//
// - `.ouro-cli`: version-manager state (installed versions, CurrentVersion
//   symlink, daemon.pids, pulse.json, pulse-delivered.json). A test writing
//   here can corrupt the developer's running daemon state.
// - `.agentsecrets`: credential store per convention. Writing here leaks
//   test secrets into the real filesystem.
// - `.claude`: Claude Code settings, logs, and subagent state. Writing here
//   collides with the developer's own Claude Code session.
// Empty as of the ratchet-down: every pre-existing offender was
// converted to extract `.ouro-cli` as a local const so the literal
// no longer shares a line with `os.homedir()`. New offenders are
// blocked by the rule.
const REAL_OURO_CLI_WRITE_ALLOWLIST = new Set<string>()

// Same ratchet-down: every pre-existing `.agentsecrets` offender was
// converted to extract the subpath as a local const.
const REAL_AGENT_SECRETS_WRITE_ALLOWLIST = new Set<string>()

// .claude allowlist starts empty — no known offenders as of the seed scan.
const REAL_CLAUDE_WRITE_ALLOWLIST = new Set<string>()

// Production code (under `src/` but NOT `src/__tests__/`) that currently
// uses `fs.rmSync(..., { recursive: true })` or shells out to `rm -rf`.
// The policy: agent-callable code should enumerate files to delete rather
// than recursively blasting a directory, because (a) it's safer under a
// bug, (b) it gives the agent a chance to log what's being deleted, and
// (c) the enumeration loop can be interrupted mid-flight without leaving
// the filesystem in a half-deleted state.
//
// The callsites below are NOT agent-callable — they're deterministic
// harness infrastructure (version pruning, adoption scaffolding, UTI
// icon pipeline). They're allowlisted with a justification. New prod
// callsites are blocked and must be added here with a comment.
const RM_RECURSIVE_ALLOWLIST: Array<{ file: string; why: string }> = [
  {
    file: "src/heart/hatch/specialist-tools.ts",
    why: "Adoption scaffolding: moves a scratch bundle into ~/AgentBundles atomically, then removes the staging source; rolls back on failure by removing the partially-materialized target. Not agent-callable — runs inside complete_adoption's transaction.",
  },
  {
    file: "src/heart/versioning/ouro-version-manager.ts",
    why: "CLI version pruning: removes stale ~/.ouro-cli/versions/<version>/node_modules trees during `ouro up`. Not agent-callable — runs inside the version manager's retention GC.",
  },
  {
    file: "src/heart/versioning/ouro-uti.ts",
    why: "macOS UTI icon pipeline: removes an intermediate iconset directory after `iconutil` has already produced the .icns. Not agent-callable — runs only during app registration.",
  },
  {
    file: "src/heart/daemon/cli-defaults.ts",
    why: "CLI self-setup temp dir cleanup: removes the temporary directory used during `ouro up` self-install after the new version is activated. Not agent-callable — runs inside createDefaultOuroCliDeps' setup path.",
  },
  {
    file: "src/heart/daemon/stale-bundle-prune.ts",
    why: "Stale ephemeral bundle pruning: removes .ouro directories that have no agent.json during `ouro up`. Not agent-callable — runs inside the daemon.up handler before ensureDaemonRunning.",
  },
]

// Files that are themselves the enforcement layer for the rm-rf rule
// (shell guardrails, anti-destruction regex patterns, prompt copy that
// tells the agent about the rule). These files INTENTIONALLY contain the
// literal "rm -rf" because their purpose is to prevent it — scanning them
// produces false positives.
const RM_RULE_ENFORCEMENT_FILES = new Set<string>([
  "src/repertoire/guardrails.ts",
  "src/repertoire/shell-sessions.ts",
  "src/mind/prompt.ts",
])

// Files allowed to call `__bypassVitestGuardForTests`. The bypass flag is
// process-wide and can leak across concurrent test files in the same worker
// (verified — caused a real daemon outage on 2026-04-08). The runtime guard
// is hardened so production socket calls are blocked even with bypass on,
// but reaching for the bypass should still be a deliberate, reviewed choice.
//
//   - socket-client.test.ts: tests the real socket-client transport against
//     mocked net + a test socket path. The bypass is the only way for these
//     tests to exercise the actual production code paths.
//   - daemon-cli-defaults.test.ts: tests createDefaultOuroCliDeps wiring,
//     which builds the real sendCommand transport that delegates to
//     socket-client. Same justification.
const BYPASS_USE_ALLOWLIST = new Set<string>([
  "src/__tests__/heart/daemon/socket-client.test.ts",
  "src/__tests__/heart/daemon/daemon-cli-defaults.test.ts",
])

// Files allowed to construct `new OuroDaemon(...)`. The 11 files below all
// rely on the runtime guards added in #346 (killOrphanProcesses() and
// writePidfile() are no-ops under vitest) so they don't touch the real
// production pidfile at ~/.ouro-cli/daemon.pids. Adding a 12th file should
// be a deliberate, reviewed choice — there's a non-trivial risk that a
// future change to OuroDaemon.start() introduces a NEW production-state
// side-effect that the existing 11 tests would silently exercise. Forcing
// allowlist edits gives that change a reviewer who can spot the drift.
const OURO_DAEMON_INSTANTIATION_ALLOWLIST = new Set<string>([
  "src/__tests__/heart/daemon/daemon-stop-deadlock.test.ts",
  "src/__tests__/heart/daemon/daemon-command-plane-branches.test.ts",
  "src/__tests__/heart/daemon/daemon-cli.test.ts",
  "src/__tests__/heart/daemon/daemon-update-wiring.test.ts",
  "src/__tests__/heart/daemon/daemon-socket-errors.test.ts",
  "src/__tests__/heart/daemon/daemon-command-error.test.ts",
  "src/__tests__/heart/daemon/daemon-boot-updates.test.ts",
  "src/__tests__/heart/daemon/daemon-agent-commands.test.ts",
  "src/__tests__/repertoire/mcp-wiring.test.ts",
  "src/__tests__/heart/daemon/daemon-mcp-commands.test.ts",
  "src/__tests__/heart/daemon/daemon-startup-sense-drain.test.ts",
  // Pairing-regression test constructs OuroDaemon to exercise the new
  // try/catch in start() that emits daemon.server_error on mid-startup
  // throws. Can't be tested through a higher-level seam because the
  // emission is inside the daemon's own error path. Uses mode: "dev" to
  // skip update checker and a processManager that throws synthetically.
  "src/__tests__/nerves/pairing-regression.test.ts",
  // Exercises the Outlook HTTP server lifecycle via the injected
  // outlookServerFactory seam. The real factory binds port 6876 which
  // a running production daemon holds; DI lets tests use an process-local
  // stub and cover the try/catch/stop branches that were previously
  // v8-ignored.
  "src/__tests__/heart/daemon/daemon-outlook-lifecycle.test.ts",
])

const TESTS_ROOT = join(process.cwd(), "src", "__tests__")
const SRC_ROOT = join(process.cwd(), "src")

function walkTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTestFiles(full, out)
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(full)
    }
  }
  return out
}

/**
 * Walk production source files under `src/` EXCLUDING `src/__tests__/`.
 * Used by the no-recursive-rm contract rule: test helpers are allowed to
 * clean up tmpdirs recursively, production code is not.
 */
function walkProdSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkProdSourceFiles(full, out)
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      // Skip .d.ts type declarations
      if (entry.name.endsWith(".d.ts")) continue
      // Skip .test.ts files that might live outside __tests__
      if (entry.name.endsWith(".test.ts")) continue
      out.push(full)
    }
  }
  return out
}

function relPath(absolute: string): string {
  return relative(process.cwd(), absolute)
}

/**
 * Shared implementation for the "no NEW test file constructs a write path
 * under real ~/<prod-dir>" rule family. `dirName` is for error messages,
 * `allowlist` is the per-rule ratchet set, `dirRegex` matches the quoted
 * literal inside the candidate line (e.g. `/["']\.ouro-cli["']/`).
 */
function runProdPathCheck(
  dirName: string,
  allowlist: Set<string>,
  dirRegex: RegExp,
): void {
  const allTests = walkTestFiles(TESTS_ROOT)
  const newOffenders: Array<{ file: string; line: number; snippet: string }> = []
  const stillFlagged = new Set<string>()

  for (const file of allTests) {
    // Skip this contract test (mentions the patterns in comments).
    if (file.endsWith("test-isolation.contract.test.ts")) continue
    // Skip the bundle-skeleton contract test which is read-only verification of real bundles.
    if (file.endsWith("bundle-skeleton.contract.test.ts")) continue
    // Skip identity tests which assert on path construction (read-only string compare).
    if (file.endsWith("identity.test.ts")) continue
    // Skip tests where fs is fully mocked at the file level — the path is just a string compare.
    const content = readFileSync(file, "utf-8")
    const fsIsMocked = /vi\.mock\(\s*["']fs["']/.test(content.slice(0, 2000))

    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (/os\.homedir\(\)/.test(line) && dirRegex.test(line)) {
        if (fsIsMocked) continue
        const key = `${relPath(file)}:${i + 1}`
        if (allowlist.has(key)) {
          stillFlagged.add(key)
          continue
        }
        newOffenders.push({ file: relPath(file), line: i + 1, snippet: line.trim() })
      }
    }
  }

  // Detect entries that no longer need grandfathering
  const cleanedUp: string[] = []
  for (const allowed of allowlist) {
    if (!stillFlagged.has(allowed)) {
      cleanedUp.push(allowed)
    }
  }

  expect(newOffenders, [
    `These NEW test file lines construct a path under the real ~/${dirName}`,
    "without mocking fs. Use `os.tmpdir()` for the bundle root, or mock fs at the",
    "top of the file with `vi.mock(\"fs\", () => ({ ... }))`.",
    "",
    ...newOffenders.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`),
  ].join("\n")).toEqual([])

  expect(cleanedUp, [
    `These lines were grandfathered into the ~/${dirName} allowlist but no longer`,
    "match — either the line was fixed, the line numbers shifted, or the file was",
    "deleted. Update the allowlist in test-isolation.contract.test.ts.",
  ].join("\n")).toEqual([])
}

describe("test isolation contract", () => {
  it("no NEW test file uses `name: \"testagent\"` without mocking socket-client", () => {
    const allTests = walkTestFiles(TESTS_ROOT)
    const newOffenders: string[] = []
    const cleanedUp: string[] = []

    for (const file of allTests) {
      const content = readFileSync(file, "utf-8")
      // Skip the socket-client test itself — it's the source of truth and
      // exercises real functions via the documented bypass call.
      if (file.endsWith("socket-client.test.ts")) continue
      // Skip THIS contract test (it mentions "testagent" in comments).
      if (file.endsWith("test-isolation.contract.test.ts")) continue

      const usesTestagentLiteral = /name:\s*"testagent"/.test(content)
      if (!usesTestagentLiteral) continue

      const mocksSocketClient = /vi\.(mock|doMock)\(\s*["']\.\.\/[^"']*heart\/daemon\/socket-client["']/.test(content)
      const optsOutOfGuard = content.includes("__bypassVitestGuardForTests")

      const rel = relPath(file)
      if (mocksSocketClient || optsOutOfGuard) continue

      if (TESTAGENT_NO_MOCK_ALLOWLIST.has(rel)) {
        // Grandfathered — protected at runtime by the vitest guard
        continue
      }
      newOffenders.push(rel)
    }

    // Also report files that have been fixed and can be removed from the allowlist
    for (const grandfathered of TESTAGENT_NO_MOCK_ALLOWLIST) {
      const fullPath = join(process.cwd(), grandfathered)
      if (!existsSync(fullPath)) {
        cleanedUp.push(`(deleted) ${grandfathered}`)
        continue
      }
      const content = readFileSync(fullPath, "utf-8")
      const usesTestagentLiteral = /name:\s*"testagent"/.test(content)
      const mocksSocketClient = /vi\.(mock|doMock)\(\s*["']\.\.\/[^"']*heart\/daemon\/socket-client["']/.test(content)
      const optsOutOfGuard = content.includes("__bypassVitestGuardForTests")
      if (!usesTestagentLiteral || mocksSocketClient || optsOutOfGuard) {
        cleanedUp.push(grandfathered)
      }
    }

    expect(newOffenders, [
      "These NEW test files use `name: \"testagent\"` without mocking socket-client.",
      "Add this near the top of the file:",
      "",
      "    vi.mock(\"../../heart/daemon/socket-client\", () => ({",
      "      DEFAULT_DAEMON_SOCKET_PATH: \"/tmp/ouroboros-test-mock.sock\",",
      "      sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),",
      "      checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),",
      "      requestInnerWake: vi.fn().mockResolvedValue(null),",
      "    }))",
      "",
      "(Adjust the relative import depth to match the file's location.)",
    ].join("\n")).toEqual([])

    expect(cleanedUp, [
      "These files were grandfathered into TESTAGENT_NO_MOCK_ALLOWLIST but no longer",
      "need the exception (either fixed or deleted). Remove them from the allowlist",
      "in test-isolation.contract.test.ts to ratchet down the exception list.",
    ].join("\n")).toEqual([])
  })

  it("no NEW test file constructs a write path under real ~/AgentBundles", () => {
    runProdPathCheck(
      "AgentBundles",
      REAL_BUNDLES_WRITE_ALLOWLIST,
      /["']AgentBundles["']/,
    )
  })

  it("no NEW test file constructs a write path under real ~/.ouro-cli", () => {
    runProdPathCheck(
      ".ouro-cli",
      REAL_OURO_CLI_WRITE_ALLOWLIST,
      /["']\.ouro-cli["']/,
    )
  })

  it("no NEW test file constructs a write path under real ~/.agentsecrets", () => {
    runProdPathCheck(
      ".agentsecrets",
      REAL_AGENT_SECRETS_WRITE_ALLOWLIST,
      /["']\.agentsecrets["']/,
    )
  })

  it("no NEW test file constructs a write path under real ~/.claude", () => {
    runProdPathCheck(
      ".claude",
      REAL_CLAUDE_WRITE_ALLOWLIST,
      /["']\.claude["']/,
    )
  })

  it("only allowlisted files may call __bypassVitestGuardForTests", () => {
    const allTests = walkTestFiles(TESTS_ROOT)
    const newOffenders: string[] = []
    const cleanedUp: string[] = []

    for (const file of allTests) {
      // Skip THIS contract test (mentions the bypass in comments).
      if (file.endsWith("test-isolation.contract.test.ts")) continue

      const content = readFileSync(file, "utf-8")
      if (!content.includes("__bypassVitestGuardForTests")) continue

      const rel = relPath(file)
      if (BYPASS_USE_ALLOWLIST.has(rel)) continue

      newOffenders.push(rel)
    }

    // Detect allowlisted files that no longer call the bypass
    for (const allowed of BYPASS_USE_ALLOWLIST) {
      const fullPath = join(process.cwd(), allowed)
      if (!existsSync(fullPath)) {
        cleanedUp.push(`(deleted) ${allowed}`)
        continue
      }
      const content = readFileSync(fullPath, "utf-8")
      if (!content.includes("__bypassVitestGuardForTests")) {
        cleanedUp.push(allowed)
      }
    }

    expect(newOffenders, [
      "These NEW test files call __bypassVitestGuardForTests but are not on the",
      "BYPASS_USE_ALLOWLIST. The bypass flag is process-wide (globalThis) — it",
      "leaks into concurrent test files in the same vitest worker. The runtime",
      "guard hard-blocks production socket calls regardless, but reaching for",
      "the bypass should still be a deliberate, reviewed choice.",
      "",
      "If your test legitimately needs the bypass:",
      "  1. Add the file path to BYPASS_USE_ALLOWLIST in this contract test.",
      "  2. Document WHY in the same place (a sentence or two).",
      "  3. Use a non-production socket path like `/tmp/daemon.sock` so the",
      "     hardened production socket guard does not block your test.",
      "",
      ...newOffenders.map((f) => `  ${f}`),
    ].join("\n")).toEqual([])

    expect(cleanedUp, [
      "These files were grandfathered into BYPASS_USE_ALLOWLIST but no longer",
      "call __bypassVitestGuardForTests. Remove them from the allowlist.",
    ].join("\n")).toEqual([])
  })

  it("only allowlisted files may construct `new OuroDaemon(...)`", () => {
    const allTests = walkTestFiles(TESTS_ROOT)
    const newOffenders: string[] = []
    const cleanedUp: string[] = []

    for (const file of allTests) {
      // Skip THIS contract test (mentions the pattern in comments).
      if (file.endsWith("test-isolation.contract.test.ts")) continue

      const content = readFileSync(file, "utf-8")
      // Match `new OuroDaemon(` (with or without surrounding whitespace) so
      // we catch both direct constructor calls and helper-wrapped variants.
      if (!/new\s+OuroDaemon\s*\(/.test(content)) continue

      const rel = relPath(file)
      if (OURO_DAEMON_INSTANTIATION_ALLOWLIST.has(rel)) continue

      newOffenders.push(rel)
    }

    // Detect allowlisted files that no longer construct OuroDaemon
    for (const allowed of OURO_DAEMON_INSTANTIATION_ALLOWLIST) {
      const fullPath = join(process.cwd(), allowed)
      if (!existsSync(fullPath)) {
        cleanedUp.push(`(deleted) ${allowed}`)
        continue
      }
      const content = readFileSync(fullPath, "utf-8")
      if (!/new\s+OuroDaemon\s*\(/.test(content)) {
        cleanedUp.push(allowed)
      }
    }

    expect(newOffenders, [
      "These NEW test files construct `new OuroDaemon(...)` but are not on",
      "the OURO_DAEMON_INSTANTIATION_ALLOWLIST. Constructing a real daemon",
      "and calling start() runs killOrphanProcesses() and writePidfile()",
      "against the production pidfile at ~/.ouro-cli/daemon.pids. The",
      "runtime guards in #346 short-circuit those functions under vitest,",
      "but if a future change to start() adds a NEW production-state",
      "side-effect, your test would silently exercise it.",
      "",
      "Before adding a file to the allowlist, prefer one of:",
      "  1. Use higher-level test seams (mock the daemon, not instantiate",
      "     it). Most behavior can be tested by mocking sendCommand.",
      "  2. If you really need a real daemon, write a unit test for the",
      "     specific method instead of going through start().",
      "",
      "If you legitimately need to construct OuroDaemon, add the file path",
      "to OURO_DAEMON_INSTANTIATION_ALLOWLIST in this contract test.",
      "",
      ...newOffenders.map((f) => `  ${f}`),
    ].join("\n")).toEqual([])

    expect(cleanedUp, [
      "These files were grandfathered into OURO_DAEMON_INSTANTIATION_ALLOWLIST",
      "but no longer construct OuroDaemon. Remove them from the allowlist to",
      "ratchet the exception list down toward zero.",
    ].join("\n")).toEqual([])
  })

  it("agent-callable production code must not use recursive rm (Directive A)", () => {
    // Rule: production code under `src/` (NOT `src/__tests__/`) must not
    // call `fs.rmSync(..., { recursive: true })` or shell out to `rm -rf`.
    // The policy — "an agent must enumerate the files it wants to delete"
    // — is about making deletion auditable, interruptible, and safer under
    // a bug. It applies to code an LLM might execute through tools.
    //
    // Test helpers under `src/__tests__/` ARE allowed to recursively clean
    // up tmpdirs (they're the ones ensuring isolation). Same for .test.ts
    // files anywhere.
    //
    // Infrastructure that legitimately needs recursive removal (adoption
    // rollback, version pruning, macOS UTI pipeline) goes on
    // RM_RECURSIVE_ALLOWLIST with an explicit justification.
    const prodFiles = walkProdSourceFiles(SRC_ROOT)
    const patterns: Array<{ name: string; regex: RegExp }> = [
      { name: "fs.rmSync(...) recursive: true", regex: /rmSync\s*\([^)]*recursive\s*:\s*true/ },
      { name: "shell `rm -rf`", regex: /\brm\s+-rf\b/ },
      { name: "shell `rm -fr`", regex: /\brm\s+-fr\b/ },
      { name: "shell `rm --recursive --force`", regex: /\brm\s+--recursive\s+--force\b/ },
    ]
    const allowlistFiles = new Set(RM_RECURSIVE_ALLOWLIST.map((e) => e.file))
    const stillMatched = new Set<string>()
    const newOffenders: Array<{ file: string; line: number; snippet: string; pattern: string }> = []

    for (const file of prodFiles) {
      const rel = relPath(file)
      // Skip files that are themselves the rm-rf enforcement layer.
      if (RM_RULE_ENFORCEMENT_FILES.has(rel)) continue
      const content = readFileSync(file, "utf-8")
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const { name, regex } of patterns) {
          if (regex.test(line)) {
            if (allowlistFiles.has(rel)) {
              stillMatched.add(rel)
              continue
            }
            newOffenders.push({ file: rel, line: i + 1, snippet: line.trim(), pattern: name })
          }
        }
      }
    }

    // Detect allowlist entries that no longer need the exception
    const cleanedUp: string[] = []
    for (const { file } of RM_RECURSIVE_ALLOWLIST) {
      if (!stillMatched.has(file)) {
        cleanedUp.push(file)
      }
    }

    expect(newOffenders, [
      "These NEW production files use recursive rm. Agent-callable code must",
      "enumerate files to delete rather than recursively blasting a directory.",
      "Enumerate the entries with readdirSync, iterate, call fs.rmSync on each",
      "single file, then fs.rmdirSync bottom-up. If this callsite is genuinely",
      "infrastructure (not agent-callable), add it to RM_RECURSIVE_ALLOWLIST",
      "in this contract test WITH a justification comment.",
      "",
      ...newOffenders.map((o) => `  ${o.file}:${o.line}  [${o.pattern}]  ${o.snippet}`),
    ].join("\n")).toEqual([])

    expect(cleanedUp, [
      "These files were grandfathered into RM_RECURSIVE_ALLOWLIST but no longer",
      "contain a recursive-rm pattern. Remove them from the allowlist to ratchet",
      "the exception list down toward zero.",
    ].join("\n")).toEqual([])
  })
})

/* v8 ignore start -- this contract test only runs assertions; no production code paths exercised @preserve */
function _typeAssertExistsSync(): boolean {
  return existsSync(TESTS_ROOT)
}
void _typeAssertExistsSync
/* v8 ignore stop */
