import type { FriendRecord, FriendStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { isReplayGrantHolder } from "./replay-grant-holders"
import { operatorTrustFile, readGrantFile, withTrustedWriteLock, writeTrustedFile, type GrantFileView } from "./operator-trust"

/**
 * The escalation grant lets one A2A peer (in practice the desk's Claude Code) receive this agent's failure reports and
 * close them with `report/resolve`. It is an operator-set statement kept in the operator trust directory
 * (`escalation-grants.json`, see operator-trust.ts), outside the agent bundle and written only by
 * `ouro a2a escalation grant|revoke` run as root, so the agent's own shell cannot forge a grant. Trust tier never
 * implies it: a peer holds the grant only while it is listed here AND its friend record is active family. A missing,
 * unreadable or malformed file means nobody holds it, so every read fails closed.
 */
export interface EscalationGrant {
  scope: "escalation"
  grantedAt: string
  source: string
  /** The holder's DID, pinned here by the operator at grant time. The friend record is writable by the Butler's own uid, so nothing else may name the key a resolution is checked against. */
  did: string
  /** Set on grants that must end by themselves (the replay gate's peer); an expiry that is not a finite time counts as expired. */
  expiresAt?: string
}

export const ESCALATION_GRANTS_FILE = "escalation-grants.json"

export function escalationGrantsPath(agentRoot: string): string {
  return operatorTrustFile(agentRoot, ESCALATION_GRANTS_FILE)
}

function validGrant(value: unknown): value is EscalationGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const grant = value as Record<string, unknown>
  const keys = Object.keys(grant).sort().join(",")
  return (keys === "did,grantedAt,scope,source" || keys === "did,expiresAt,grantedAt,scope,source")
    && (grant.expiresAt === undefined || typeof grant.expiresAt === "string")
    && typeof grant.did === "string" && grant.did.startsWith("did:") && grant.did.length <= 512
    && grant.scope === "escalation"
    && typeof grant.grantedAt === "string" && !Number.isNaN(Date.parse(grant.grantedAt))
    && typeof grant.source === "string" && grant.source.trim().length > 0
}

/** The file's trust state and every well-formed grant in it, keyed by friend id. */
export function viewEscalationGrants(agentRoot: string): GrantFileView<EscalationGrant> {
  return readGrantFile(agentRoot, ESCALATION_GRANTS_FILE, validGrant)
}

/** Every well-formed grant in the file, keyed by friend id. Anything else in the file is ignored. */
export function readEscalationGrants(agentRoot: string): Record<string, EscalationGrant> {
  return viewEscalationGrants(agentRoot).grants
}

/** Writes or removes one grant. The previous file is kept beside it as a timestamped backup before the change. */
export function setEscalationGrant(agentRoot: string, friendId: string, change: { grant: true; source: string; did: string; expiresAt?: string } | { grant: false }, now: Date = new Date()): { changed: boolean; backup: string | null } {
  return withTrustedWriteLock(agentRoot, () => setEscalationGrantLocked(agentRoot, friendId, change, now))
}

function setEscalationGrantLocked(agentRoot: string, friendId: string, change: { grant: true; source: string; did: string; expiresAt?: string } | { grant: false }, now: Date): { changed: boolean; backup: string | null } {
  const current = readEscalationGrants(agentRoot)
  const had = current[friendId]
  if (change.grant ? had?.did === change.did && had.expiresAt === change.expiresAt : had === undefined) return { changed: false, backup: null }
  const next = { ...current }
  if (change.grant) next[friendId] = { scope: "escalation", grantedAt: now.toISOString(), source: change.source, did: change.did, ...(change.expiresAt ? { expiresAt: change.expiresAt } : {}) }
  else delete next[friendId]
  const { backup } = writeTrustedFile(agentRoot, ESCALATION_GRANTS_FILE, `${JSON.stringify({ schemaVersion: 1, grants: next }, null, 2)}\n`, now)
  emitNervesEvent({
    component: "senses",
    event: "senses.a2a_escalation_grant_changed",
    message: change.grant ? "granted escalation to an A2A peer" : "revoked an A2A peer's escalation grant",
    meta: { friendId, granted: change.grant },
  })
  return { changed: true, backup }
}

/** A grant is in force when its trusted expiry has not passed; a grant with no expiry for a friend on the root-owned replay list is never in force. */
function inForce(agentRoot: string, friendId: string, grant: EscalationGrant | undefined, now: number): grant is EscalationGrant {
  if (!grant) return false
  if (grant.expiresAt === undefined) return !isReplayGrantHolder(agentRoot, friendId)
  const expiresAt = Date.parse(grant.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now
}

/** The DID the operator pinned for this holder, or null when it holds no (complete, unexpired) grant. */
export function pinnedHolderDid(agentRoot: string, friendId: string, now: number = Date.now()): string | null {
  const grant = readEscalationGrants(agentRoot)[friendId]
  return inForce(agentRoot, friendId, grant, now) ? grant.did : null
}

/** True only for an active family friend that the operator listed in the grants file, with a pinned DID. */
export function holdsEscalation(agentRoot: string, friend: FriendRecord, now: number = Date.now()): boolean {
  return inForce(agentRoot, friend.id, readEscalationGrants(agentRoot)[friend.id], now)
    && friend.trustLevel === "family"
    && friend.admissionState === "active"
}

export async function escalationHolders(agentRoot: string, store: FriendStore, now: number = Date.now()): Promise<FriendRecord[]> {
  const friends = await store.listAll?.() ?? []
  return friends.filter((friend) => holdsEscalation(agentRoot, friend, now))
}
