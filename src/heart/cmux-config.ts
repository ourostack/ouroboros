import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * How this machine reaches the cmux control socket. It lives in the agent's machine runtime item
 * (`runtime/machines/<machine-id>/config`, key `cmux`), never in the synced bundle: a capability
 * token or socket password is a credential, and the socket only exists on this Mac.
 *
 * cmux's default `cmuxOnly` socket mode refuses processes cmux did not start. A capability token
 * (cmux exports one into every terminal as CMUX_SOCKET_CAPABILITY) lets the daemon-launched sense in
 * without loosening that mode, so it is preferred. `password` mode is the fallback, and an explicit
 * `socketMode: "automation"` (any same-user process) is the last resort.
 */
export type CmuxSocketAuth =
  | { kind: "capability"; token: string }
  | { kind: "password"; password: string }
  | { kind: "none" }

export interface CmuxConnection {
  socketPath: string
  auth: CmuxSocketAuth
}

export interface CmuxConfigFacts {
  configured: boolean
  detail: string
  /** True when this machine has no cmux attachment at all: the sense is skipped quietly, not reported broken. */
  optional?: boolean
}

export function cmuxRepairHint(agent: string): string {
  return `human-required: in a cmux terminal run 'ouro vault config set --agent ${agent} --scope machine --key cmux.socketCapability --value "$CMUX_SOCKET_CAPABILITY"' (or set cmux.socketPassword when cmux is in password mode), then 'ouro up'.`
}

function text(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function cmuxRecord(machinePayload: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = machinePayload.cmux
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function authFrom(cmux: Record<string, unknown> | undefined): CmuxSocketAuth | null {
  const token = text(cmux, "socketCapability")
  if (token) return { kind: "capability", token }
  const password = text(cmux, "socketPassword")
  if (password) return { kind: "password", password }
  if (text(cmux, "socketMode") === "automation") return { kind: "none" }
  return null
}

export function cmuxConfigFacts(machinePayload: Record<string, unknown>): CmuxConfigFacts {
  const cmux = cmuxRecord(machinePayload)
  const auth = authFrom(cmux)
  if (!auth) return cmux ? { configured: false, detail: "missing cmux.socketCapability" } : { configured: false, optional: true, detail: "not attached on this machine" }
  return { configured: true, detail: `socket auth: ${auth.kind === "none" ? "automation mode" : auth.kind}` }
}

/** The one-word status the prompt and turn context show for the cmux sense, matching the daemon's sense rows. */
export function cmuxSenseStatus(enabled: boolean, machinePayload: Record<string, unknown>): "disabled" | "ready" | "not_attached" | "needs_config" {
  if (!enabled) return "disabled"
  const facts = cmuxConfigFacts(machinePayload)
  if (facts.configured) return "ready"
  return facts.optional ? "not_attached" : "needs_config"
}

/** cmux's own default: `~/.local/state/cmux/cmux-<uid>.sock`, then the older unscoped `cmux.sock`. */
export function defaultCmuxSocketPath(
  homeDir: string = os.homedir(),
  uid: number = process.getuid?.() ?? 0,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const dir = path.join(homeDir, ".local", "state", "cmux")
  const scoped = path.join(dir, `cmux-${uid}.sock`)
  const unscoped = path.join(dir, "cmux.sock")
  return !exists(scoped) && exists(unscoped) ? unscoped : scoped
}

export function resolveCmuxConnection(
  agent: string,
  machinePayload: Record<string, unknown>,
  defaultSocketPath: () => string = defaultCmuxSocketPath,
): { ok: true; connection: CmuxConnection } | { ok: false; error: string } {
  const cmux = cmuxRecord(machinePayload)
  const auth = authFrom(cmux)
  emitNervesEvent({
    component: "senses",
    event: "senses.shepherd_connection_resolved",
    message: "resolved cmux socket connection settings",
    meta: { agent, auth: auth?.kind ?? "missing" },
  })
  if (!auth) return { ok: false, error: `cmux socket auth is not configured on this machine; ${cmuxRepairHint(agent)}` }
  return { ok: true, connection: { socketPath: text(cmux, "socketPath") || defaultSocketPath(), auth } }
}
