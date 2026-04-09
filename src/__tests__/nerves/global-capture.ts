import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { dirname, join } from "path"
import { afterAll, afterEach, beforeEach } from "vitest"

import { registerGlobalLogSink, type LogEvent } from "../../nerves"
import { __getLiveTmpBundleHandles } from "../test-helpers/tmpdir-bundle"

const REPO_SLUG = "ouroboros-agent-harness"

function readActiveRunDir(): string | null {
  const activePath = join(tmpdir(), "ouroboros-test-runs", REPO_SLUG, ".active-run.json")
  if (!existsSync(activePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(activePath, "utf8")) as { run_dir?: unknown }
    return typeof parsed.run_dir === "string" && parsed.run_dir.length > 0 ? parsed.run_dir : null
  } catch {
    return null
  }
}

// ---------- per-test event tracking ----------

const PER_TEST_KEY = Symbol.for("ouroboros.nerves.per-test-events")

interface PerTestState {
  currentTest: string | null
  events: Map<string, Array<{ component: string; event: string }>>
}

const scope = globalThis as Record<PropertyKey, unknown>

let perTestState = scope[PER_TEST_KEY] as PerTestState | undefined
if (!perTestState) {
  perTestState = { currentTest: null, events: new Map() }
  scope[PER_TEST_KEY] = perTestState
}
const pts = perTestState

function recordEventForCurrentTest(entry: LogEvent): void {
  const testName = pts.currentTest
  if (!testName) return
  let list = pts.events.get(testName)
  if (!list) {
    list = []
    pts.events.set(testName, list)
  }
  list.push({ component: entry.component, event: entry.event })
}

// Register vitest hooks for per-test tracking
beforeEach((ctx) => {
  const suiteName = ctx.task.suite?.name ?? ""
  const testName = suiteName ? `${suiteName} > ${ctx.task.name}` : ctx.task.name
  pts.currentTest = testName
})

// Pairing guard: at the end of each test, walk the recorded per-test events
// and fail loudly on any LIFECYCLE `_start` without a matching `_end`/`_error`.
// This catches future regressions of the `start_end_pairing` nerves-audit rule
// immediately in the failing test, instead of letting them bleed into the
// post-run coverage gate as intermittent audit failures.
//
// Scope: only events that represent a process-scoped lifecycle — daemon
// startup, update checker, apply-pending-updates. These are the three events
// whose missing pairs caused intermittent audit failures in CI and whose
// emitters must now emit a terminating `_end` or `_error` on every path
// (including throws) by construction.
//
// Most nerves `_start` events in the codebase are NOT lifecycle — they mark
// the beginning of a streaming operation that pairs with its own `_end` from
// a code path a narrow unit test may never exercise (e.g.
// `repertoire.task_scan_start`, `mind.step_start`). Guarding those here
// would require every unit test to drive the full operation, which is not
// the point of a unit test. So the guard is intentionally scoped to the
// lifecycle events where the contract IS process-wide pairing.
//
// See also: src/nerves/coverage/audit-rules.ts `checkStartEndPairing` which
// enforces the same rule at the post-run audit level.
const LIFECYCLE_PAIRED_STARTS = new Set<string>([
  "daemon.server_start",
  "daemon.update_checker_start",
  "daemon.apply_pending_updates_start",
])

afterEach((ctx) => {
  const suiteName = ctx.task.suite?.name ?? ""
  const testName = suiteName ? `${suiteName} > ${ctx.task.name}` : ctx.task.name
  const events = pts.events.get(testName) ?? []
  const orphans: string[] = []
  for (const entry of events) {
    if (!LIFECYCLE_PAIRED_STARTS.has(entry.event)) continue
    const prefix = entry.event.slice(0, -"_start".length)
    const endName = `${prefix}_end`
    const errorName = `${prefix}_error`
    const paired = events.some((e) => e.event === endName || e.event === errorName)
    if (!paired) {
      orphans.push(`${entry.component}:${entry.event}`)
    }
  }
  // Drop the per-test event list so it does not leak into a sibling test —
  // do this BEFORE throwing so a single orphaned test does not corrupt
  // subsequent runs.
  pts.events.delete(testName)
  pts.currentTest = null
  if (orphans.length > 0) {
    const uniq = Array.from(new Set(orphans))
    throw new Error(
      `Orphaned lifecycle _start events (no _end or _error) in test "${testName}": ${uniq.join(", ")}. ` +
      `Fix the teardown (e.g. ensure daemon.stop()/stopUpdateChecker() is called) — these lifecycle events ` +
      `must always pair by construction, including when the operation throws.`,
    )
  }
})

// TmpBundle leak guard: any non-shared handle from `createTmpBundle()` that
// wasn't cleaned up by the test's own try/finally gets forcibly cleaned
// here, and a console.warn names the test that leaked it so the human can
// fix the missing finally. This runs AFTER the pairing guard so the pairing
// failure surfaces first if both trip on the same test.
//
// Handles created with `{ shared: true }` are intentionally long-lived for
// the whole describe block (beforeAll → afterAll pattern). The guard skips
// them — they'll be cleaned up by the describe's own afterAll hook, and a
// separate end-of-suite check (see the tmpbundle contract test for shared
// leaks) handles the case where afterAll was forgotten.
//
// Swallows cleanup errors intentionally (best-effort defense-in-depth,
// not strict enforcement). The strict enforcement is the test-isolation
// contract test that blocks real-path writes at the source level.
afterEach((ctx) => {
  const handles = __getLiveTmpBundleHandles()
  if (handles.size === 0) return
  const suiteName = ctx.task.suite?.name ?? ""
  const testName = suiteName ? `${suiteName} > ${ctx.task.name}` : ctx.task.name
  const leaked: string[] = []
  // Snapshot the set before iterating — cleanup() mutates it.
  const snapshot = Array.from(handles)
  for (const handle of snapshot) {
    if (handle.shared) continue // intentionally long-lived across the describe block
    leaked.push(handle.agentName)
    try { handle.cleanup() } catch { /* best effort */ }
  }
  if (leaked.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tmpbundle-leak-guard] test "${testName}" leaked ${leaked.length} TmpBundle handle(s) ` +
      `(${leaked.join(", ")}). Forcibly cleaned. Fix the missing try/finally in the test body.`,
    )
  }
})

// ---------- runtime prod-path leak guard ----------
//
// The text-based test-isolation contract in `test-isolation.contract.test.ts`
// catches source-level writes to `~/AgentBundles`, `~/.ouro-cli`, etc. But
// it cannot catch runtime leaks where production code routes a write to a
// real-fs path via a silent fallback (e.g. the `safeAgentName()` → "default"
// bug in coding/manager.ts that wrote `~/AgentBundles/default.ouro/state/
// coding/sessions.json` on every coverage run until I fixed it in PR #372).
// This runtime guard is the belt to the contract test's suspenders:
//
// 1. At worker boot, snapshot the entries in `~/AgentBundles`.
// 2. At worker teardown (`afterAll` without a describe context — runs once
//    per worker after every test in that worker), re-read the dir and
//    compare.
// 3. Any NEW entry that wasn't in the snapshot is a leak — force-remove it
//    and emit a loud console.error naming the entry.
//
// This intentionally does NOT track modifications to existing entries
// (slugger.ouro, ouroboros.ouro, etc. get legitimate writes from tests
// that mock their paths into a tmpdir but still reference the real ~/AgentBundles
// as a cwd for fs.existsSync probes). Only new top-level entries trigger
// the guard.
//
// False-positive risk: if the developer runs a real `ouro` command in a
// separate terminal during the test run and that command creates a new
// agent bundle, the guard would delete it. Acceptable because (a) that
// would be an unusual timing coincidence and (b) the warning names the
// entry loudly so the human can recreate it.

const AGENT_BUNDLES_ROOT = join(homedir(), "AgentBundles")

function snapshotBundleRoot(): Set<string> {
  try {
    return new Set(readdirSync(AGENT_BUNDLES_ROOT))
  } catch {
    // ~/AgentBundles doesn't exist — snapshot is empty; afterAll will
    // detect ANY entry that appears during the run as a new leak.
    return new Set()
  }
}

const _prodPathSnapshot = snapshotBundleRoot()

afterAll(() => {
  let current: string[]
  try {
    current = readdirSync(AGENT_BUNDLES_ROOT)
  } catch {
    return // dir still doesn't exist — nothing to check
  }
  const leaked: string[] = []
  for (const entry of current) {
    if (_prodPathSnapshot.has(entry)) continue
    leaked.push(entry)
    const full = join(AGENT_BUNDLES_ROOT, entry)
    try { rmSync(full, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  if (leaked.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[prod-path-leak-guard] test run leaked ${leaked.length} new entries under ` +
      `~/AgentBundles/: ${leaked.join(", ")}. Forcibly removed. ` +
      `Find the production code path that routed a write to ~/AgentBundles without ` +
      `a bundlesRoot override or a mocked fs — it's almost always a silent ` +
      `agentName fallback to "default" or an un-mocked singleton (see PR #372 for ` +
      `a prior example in src/repertoire/coding/manager.ts).`,
    )
  }
})

// ---------- global ndjson capture ----------

const CAPTURE_STATE_KEY = Symbol.for("ouroboros.nerves.capture-state")
type CaptureState = {
  runDir: string
  observed: Set<string>
  flushed: boolean
  unregister: () => void
}

const existingState = scope[CAPTURE_STATE_KEY] as CaptureState | undefined

const runDir = readActiveRunDir()
if (runDir && (!existingState || existingState.runDir !== runDir)) {
  existingState?.unregister()

  const eventsPath = join(runDir, "vitest-events.ndjson")
  const perTestPath = join(runDir, "vitest-events-per-test.json")
  mkdirSync(dirname(eventsPath), { recursive: true })

  const observed = new Set<string>()
  const unregister = registerGlobalLogSink((entry: LogEvent) => {
    appendFileSync(eventsPath, `${JSON.stringify(entry)}\n`, "utf8")
    observed.add(`${entry.component}:${entry.event}`)
    recordEventForCurrentTest(entry)
  })

  const state: CaptureState = {
    runDir,
    observed,
    flushed: false,
    unregister,
  }
  scope[CAPTURE_STATE_KEY] = state

  const flush = () => {
    if (state.flushed) return
    state.flushed = true
    state.unregister()

    // Write per-test events JSON
    const perTestData: Record<string, Array<{ component: string; event: string }>> = {}
    for (const [testName, events] of pts.events) {
      perTestData[testName] = events
    }
    writeFileSync(perTestPath, JSON.stringify(perTestData, null, 2), "utf8")
  }

  afterAll(flush)
  process.once("beforeExit", flush)
  process.once("exit", flush)
} else {
  // Even without an active run dir, register the per-test sink so tests can verify tracking
  registerGlobalLogSink((entry: LogEvent) => {
    recordEventForCurrentTest(entry)
  })
}
