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
 * This contract test is a SECONDARY defense — a static check that catches new
 * test files which inherit the dangerous pattern, even before they run.
 *
 * Two rules enforced as RATCHETS — current offenders are grandfathered in
 * the allowlists below, but no NEW files / lines can be added. Follow-up PRs
 * shrink the allowlists toward zero.
 *
 *   1. If a test file uses the literal `name: "testagent"`, it must mock
 *      `socket-client` (or explicitly opt out via the bypass call).
 *   2. No test file may construct a write path under the real ~/AgentBundles
 *      via `os.homedir()` joined with `"AgentBundles"`. (Tests must use
 *      `os.tmpdir()` or fully-mocked fs.)
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

const TESTS_ROOT = join(process.cwd(), "src", "__tests__")

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

function relPath(absolute: string): string {
  return relative(process.cwd(), absolute)
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
    const allTests = walkTestFiles(TESTS_ROOT)
    const newOffenders: Array<{ file: string; line: number; snippet: string }> = []
    const stillFlagged = new Set<string>()

    for (const file of allTests) {
      // Skip this contract test (mentions the pattern in comments).
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
        if (/os\.homedir\(\)/.test(line) && /["']AgentBundles["']/.test(line)) {
          if (fsIsMocked) continue
          const key = `${relPath(file)}:${i + 1}`
          if (REAL_BUNDLES_WRITE_ALLOWLIST.has(key)) {
            stillFlagged.add(key)
            continue
          }
          newOffenders.push({ file: relPath(file), line: i + 1, snippet: line.trim() })
        }
      }
    }

    // Detect entries that no longer need grandfathering
    const cleanedUp: string[] = []
    for (const allowed of REAL_BUNDLES_WRITE_ALLOWLIST) {
      if (!stillFlagged.has(allowed)) {
        cleanedUp.push(allowed)
      }
    }

    expect(newOffenders, [
      "These NEW test file lines construct a path under the real ~/AgentBundles",
      "without mocking fs. Use `os.tmpdir()` for the bundle root, or mock fs at the",
      "top of the file with `vi.mock(\"fs\", () => ({ ... }))`.",
      "",
      ...newOffenders.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`),
    ].join("\n")).toEqual([])

    expect(cleanedUp, [
      "These lines were grandfathered into REAL_BUNDLES_WRITE_ALLOWLIST but no longer",
      "match — either the line was fixed, the line numbers shifted, or the file was",
      "deleted. Update the allowlist in test-isolation.contract.test.ts.",
    ].join("\n")).toEqual([])
  })
})

/* v8 ignore start -- this contract test only runs assertions; no production code paths exercised @preserve */
function _typeAssertExistsSync(): boolean {
  return existsSync(TESTS_ROOT)
}
void _typeAssertExistsSync
/* v8 ignore stop */
