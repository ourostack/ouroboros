import * as fs from "node:fs"
import * as path from "node:path"
import type { FriendRecord, FriendStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { isTrustedDirectory, readTrustedJson } from "./trusted-files"

/**
 * The escalation grant lets one A2A peer (in practice the desk's Claude Code) receive this agent's failure reports and
 * close them with `report/resolve`. It is an operator-set statement kept in the bundle at
 * `state/a2a/escalation-grants.json`, written only by `ouro a2a escalation grant|revoke` run as root, so the file and its
 * directory are root-owned and no one else can write them (the agent's own shell cannot forge a grant). Trust tier never implies it:
 * a peer holds the grant only while it is listed here AND its friend record is active family. A missing, unreadable or
 * malformed file means nobody holds it, so every read fails closed.
 */
export interface EscalationGrant {
  scope: "escalation"
  grantedAt: string
  source: string
}

export function escalationGrantsPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "a2a", "escalation-grants.json")
}

function validGrant(value: unknown): value is EscalationGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const grant = value as Record<string, unknown>
  return Object.keys(grant).sort().join(",") === "grantedAt,scope,source"
    && grant.scope === "escalation"
    && typeof grant.grantedAt === "string" && !Number.isNaN(Date.parse(grant.grantedAt))
    && typeof grant.source === "string" && grant.source.trim().length > 0
}

/** Every well-formed grant in the file, keyed by friend id. Anything else in the file is ignored. */
export function readEscalationGrants(agentRoot: string): Record<string, EscalationGrant> {
  const file = escalationGrantsPath(agentRoot)
  if (!isTrustedDirectory(path.dirname(file))) return {}
  const parsed = readTrustedJson(file)
  const grants = (parsed as { grants?: unknown } | null)?.grants
  if (!grants || typeof grants !== "object" || Array.isArray(grants)) return {}
  return Object.fromEntries(Object.entries(grants).filter((entry): entry is [string, EscalationGrant] => validGrant(entry[1])))
}

/** Writes or removes one grant. The previous file is kept beside it as a timestamped backup before the change. */
export function setEscalationGrant(agentRoot: string, friendId: string, change: { grant: true; source: string } | { grant: false }, now: Date = new Date()): { changed: boolean; backup: string | null } {
  const file = escalationGrantsPath(agentRoot)
  const current = readEscalationGrants(agentRoot)
  const had = current[friendId]
  if (change.grant ? had !== undefined : had === undefined) return { changed: false, backup: null }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  let backup: string | null = null
  if (fs.existsSync(file)) {
    backup = `${file}.bak-${now.toISOString().replace(/[:.]/gu, "-")}`
    fs.copyFileSync(file, backup)
  }
  const next = { ...current }
  if (change.grant) next[friendId] = { scope: "escalation", grantedAt: now.toISOString(), source: change.source }
  else delete next[friendId]
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, grants: next }, null, 2)}\n`, { mode: 0o644 })
  fs.renameSync(tmp, file)
  emitNervesEvent({
    component: "senses",
    event: "senses.a2a_escalation_grant_changed",
    message: change.grant ? "granted escalation to an A2A peer" : "revoked an A2A peer's escalation grant",
    meta: { friendId, granted: change.grant },
  })
  return { changed: true, backup }
}

/** True only for an active family friend that the operator listed in the grants file. */
export function holdsEscalation(agentRoot: string, friend: FriendRecord): boolean {
  return readEscalationGrants(agentRoot)[friend.id] !== undefined
    && friend.trustLevel === "family"
    && friend.admissionState === "active"
}

export async function escalationHolders(agentRoot: string, store: FriendStore): Promise<FriendRecord[]> {
  const friends = await store.listAll?.() ?? []
  return friends.filter((friend) => holdsEscalation(agentRoot, friend))
}
