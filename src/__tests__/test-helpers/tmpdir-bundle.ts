import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Test helper: create a self-contained tmpdir-rooted bundle setup so tests
 * never write to the developer's real `~/AgentBundles`.
 *
 * Usage:
 *   const tmp = createTmpBundle({ agentName: "auth-test", agentJson: {...} })
 *   try {
 *     await runOuroCli(["auth", "--agent", tmp.agentName], {
 *       ...deps,
 *       bundlesRoot: tmp.bundlesRoot,
 *     })
 *   } finally {
 *     tmp.cleanup()
 *   }
 *
 * The helper provides EVERYTHING required to make a test self-contained:
 *   - `bundlesRoot`: the parent dir under tmpdir, structured like ~/AgentBundles
 *   - `agentRoot`: <bundlesRoot>/<agentName>.ouro (created on disk with agent.json)
 *   - `cleanup`: removes the tmpdir (idempotent, safe to call from finally)
 *
 * Use a unique `agentName` per test (the helper does NOT enforce this) so
 * concurrent test runs don't collide.
 */

export interface TmpBundleHandle {
  /** Unique short name like `auth-local-1234567890` */
  agentName: string
  /** Tmpdir that contains `<agentName>.ouro/` */
  bundlesRoot: string
  /** `<bundlesRoot>/<agentName>.ouro` */
  agentRoot: string
  /** `<agentRoot>/agent.json` */
  agentConfigPath: string
  /** Removes the tmpdir. Safe to call multiple times. */
  cleanup: () => void
  /**
   * True if this handle is shared across an entire describe block via
   * `beforeAll`/`afterAll`. The leak guard's per-test `afterEach` skips
   * shared handles — they're cleaned in `afterAll`, not after every test.
   */
  shared: boolean
}

export interface CreateTmpBundleOptions {
  /** Short identifier for the test, used in the tmpdir name. Default: "test". */
  agentName?: string
  /** JSON object to write into `agent.json`. Default: minimal v2 minimax config. */
  agentJson?: Record<string, unknown>
  /**
   * Set to `true` when the handle is created in a `beforeAll` hook and
   * cleaned in `afterAll` — i.e. the bundle is shared by every test in
   * the describe block. The leak guard's per-test `afterEach` will NOT
   * count this handle as leaked; only `afterAll`/end-of-suite cleanup
   * matters. Without this flag, a shared handle would be flagged as a
   * leak after the first test runs (before `afterAll` fires), which is
   * a false positive. Default: `false` (per-test handles, cleaned in
   * the test body's `try/finally`).
   */
  shared?: boolean
}

const DEFAULT_AGENT_JSON: Record<string, unknown> = {
  version: 2,
  enabled: true,
  humanFacing: { provider: "minimax", model: "minimax-text-01" },
  agentFacing: { provider: "minimax", model: "minimax-text-01" },
  phrases: {
    thinking: ["working"],
    tool: ["running tool"],
    followup: ["processing"],
  },
}

let _counter = 0
function uniqueAgentName(prefix: string): string {
  _counter += 1
  return `${prefix}-${process.pid}-${Date.now()}-${_counter}`
}

/**
 * Live-handle registry. Every handle returned by `createTmpBundle` is
 * registered here and deregistered on `cleanup()`. The global afterEach
 * leak guard in `src/__tests__/nerves/global-capture.ts` iterates this
 * set after each test and calls `cleanup()` on anything left behind,
 * giving us a second line of defense against tests that forget their
 * try/finally. Handles leaked this way also surface as a console.warn
 * naming the test that leaked them.
 */
const _liveHandles = new Set<TmpBundleHandle>()

export function __getLiveTmpBundleHandles(): ReadonlySet<TmpBundleHandle> {
  return _liveHandles
}

export function createTmpBundle(options: CreateTmpBundleOptions = {}): TmpBundleHandle {
  const agentName = options.agentName ?? uniqueAgentName("test")
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ouro-tmp-bundles-`))
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const agentConfigPath = path.join(agentRoot, "agent.json")

  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(
    agentConfigPath,
    JSON.stringify(options.agentJson ?? DEFAULT_AGENT_JSON, null, 2) + "\n",
    "utf-8",
  )

  let cleaned = false
  const handle: TmpBundleHandle = {
    agentName,
    bundlesRoot,
    agentRoot,
    agentConfigPath,
    shared: options.shared ?? false,
    cleanup: (): void => {
      if (cleaned) return
      cleaned = true
      try { fs.rmSync(bundlesRoot, { recursive: true, force: true }) } catch { /* best effort */ }
      _liveHandles.delete(handle)
    },
  }

  _liveHandles.add(handle)
  return handle
}
