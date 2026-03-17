import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { beforeEach, afterAll } from "vitest"

import { registerGlobalLogSink, type LogEvent } from "../../nerves"

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
