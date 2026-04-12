/**
 * Type definitions for the `ouro doctor` system health check.
 *
 * Describes the structure of health check results: individual checks,
 * grouped categories, and the aggregated result.
 */

/** Result status for a single health check. */
export type DoctorCheckStatus = "pass" | "warn" | "fail"

/** A single health check result. */
export interface DoctorCheck {
  /** Human-readable label for this check (e.g., "daemon socket exists"). */
  label: string
  /** Result status: pass, warn, or fail. */
  status: DoctorCheckStatus
  /** Optional detail message explaining the result. */
  detail?: string
}

/** A named group of related health checks. */
export interface DoctorCategory {
  /** Category name displayed as a section header (e.g., "Daemon"). */
  name: string
  /** Ordered list of checks within this category. */
  checks: DoctorCheck[]
}

/** Summary counts across all categories. */
export interface DoctorSummary {
  passed: number
  warnings: number
  failed: number
}

/** Aggregated result from a full doctor run. */
export interface DoctorResult {
  /** Ordered list of check categories. */
  categories: DoctorCategory[]
  /** Summary counts across all checks. */
  summary: DoctorSummary
}

/** Injectable dependencies for doctor checks. */
export interface DoctorDeps {
  /** Check whether a file/directory exists. */
  existsSync: (p: string) => boolean
  /** Read a file as UTF-8 string. */
  readFileSync: (p: string) => string
  /** Read directory entries. */
  readdirSync: (p: string) => string[]
  /** Get file stats (for permissions, size). */
  statSync: (p: string) => { mode: number; size: number }
  /** Check whether the daemon socket is alive. */
  checkSocketAlive: (socketPath: string) => Promise<boolean>
  /** Optional fetch implementation used for active network diagnostics. */
  fetchImpl?: typeof fetch
  /** Path to the daemon socket. */
  socketPath: string
  /** Root directory containing `<agent>.ouro` bundles (e.g., ~/AgentBundles). */
  bundlesRoot: string
  /** Root directory containing per-agent secrets (e.g., ~/.agentsecrets). */
  secretsRoot: string
  /** Home directory for the current user. */
  homedir: string
  /** Current PATH string used to resolve the `ouro` command. */
  envPath?: string
}
