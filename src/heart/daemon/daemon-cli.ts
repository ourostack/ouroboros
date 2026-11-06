/**
 * daemon-cli.ts — Re-export shim.
 *
 * The ouro CLI implementation is split across focused modules:
 *
 *   cli-types.ts    — OuroCliCommand union, OuroCliDeps interface, type aliases
 *   cli-parse.ts    — parseOuroCommand() + per-group parsers
 *   cli-render.ts   — formatTable, formatDaemonStatusOutput, etc.
 *   cli-exec.ts     — runOuroCli(), ensureDaemonRunning(), command handlers
 *   cli-defaults.ts — createDefaultOuroCliDeps(), default implementations
 *
 * This file re-exports the public API so existing consumers (tests,
 * ouro-entry.ts, ouro-bot-wrapper.ts) continue to work unchanged.
 */

// ── Types ──
export type {
  OuroCliCommand,
  OuroCliDeps,
  SessionEntry,
  EnsureDaemonResult,
  GithubCopilotModel,
  DiscoveredCredential,
} from "./cli-types"

// ── Parsing ──
export { parseOuroCommand } from "./cli-parse"

// ── Execution ──
export {
  runOuroCli,
  ensureDaemonRunning,
  listGithubCopilotModels,
  summarizeDaemonStartupFailure,
} from "./cli-exec"

export { pingGithubCopilotModel } from "../provider-ping"

// ── Defaults ──
export {
  createDefaultOuroCliDeps,
  readFirstBundleMetaVersion,
} from "./cli-defaults"
