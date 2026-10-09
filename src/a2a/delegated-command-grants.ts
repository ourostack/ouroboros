import type { FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { operatorTrustFile, readGrantFile, withTrustedWriteLock, writeTrustedFile, type GrantFileView } from "./operator-trust"
import { isReplayGrantHolder } from "./replay-grant-holders"
import { isReplayIdentity, isReplayWindowOpen } from "./replay-harness"

/**
 * A delegated-command grant says: this friend's A2A key may relay the principal's commands to this agent. It is an
 * operator-set statement kept in the operator trust directory (`delegated-command-grants.json`), written only by
 * `ouro a2a delegated-commands grant|revoke` run as root. The friend record (`delegationGrant`) lives in the agent's
 * own bundle, so it is never authority; the grant pins the DID the operator copied from the sender's own host, so a
 * record edited to carry a different key gains nothing.
 */
export interface DelegatedCommandGrant {
  scope: "principal_commands"
  did: string
  grantedAt: string
  source: string
  expiresAt?: string
}

export const DELEGATED_COMMAND_GRANTS_FILE = "delegated-command-grants.json"

export function delegatedCommandGrantsPath(agentRoot: string): string {
  return operatorTrustFile(agentRoot, DELEGATED_COMMAND_GRANTS_FILE)
}

function validGrant(value: unknown): value is DelegatedCommandGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const grant = value as Record<string, unknown>
  const keys = Object.keys(grant).sort().join(",")
  return (keys === "did,grantedAt,scope,source" || keys === "did,expiresAt,grantedAt,scope,source")
    && grant.scope === "principal_commands"
    && typeof grant.did === "string" && grant.did.startsWith("did:") && grant.did.length <= 512
    && typeof grant.grantedAt === "string" && !Number.isNaN(Date.parse(grant.grantedAt))
    && typeof grant.source === "string" && grant.source.trim().length > 0
    && (grant.expiresAt === undefined || typeof grant.expiresAt === "string")
}

/** The file's trust state, every well-formed grant in it keyed by friend id, and the friend ids whose entries were dropped. */
export function viewDelegatedCommandGrants(agentRoot: string): GrantFileView<DelegatedCommandGrant> {
  return readGrantFile(agentRoot, DELEGATED_COMMAND_GRANTS_FILE, validGrant)
}

export function readDelegatedCommandGrants(agentRoot: string): Record<string, DelegatedCommandGrant> {
  return viewDelegatedCommandGrants(agentRoot).grants
}

export type DelegatedCommandGrantRefusal = "grants_untrusted" | "no_grant" | "grant_did_mismatch" | "grant_expired" | "not_family"

export type DelegatedCommandGrantCheck = { ok: true } | { ok: false; reason: DelegatedCommandGrantRefusal }

/**
 * The one answer to "may this friend relay the principal's commands right now?". Admission, the follow-up path and
 * `list` all ask it, so they cannot disagree. `signerDid` is the DID the message was verified as: it must equal the
 * DID the operator pinned. Order: file trusted, grant exists, DID matches, not expired (an expiry that is not a finite
 * time counts as expired, and so does a replay identity whose root-owned window is closed), then family and active.
 */
export function checkDelegatedCommandGrant(agentRoot: string, friend: FriendRecord, signerDid: string | null, now: number = Date.now()): DelegatedCommandGrantCheck {
  const view = viewDelegatedCommandGrants(agentRoot)
  if (view.state === "untrusted") return { ok: false, reason: "grants_untrusted" }
  const grant = view.grants[friend.id]
  if (!grant) return { ok: false, reason: "no_grant" }
  if (grant.did !== signerDid) return { ok: false, reason: "grant_did_mismatch" }
  if (grant.expiresAt !== undefined) {
    const expiresAt = Date.parse(grant.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ok: false, reason: "grant_expired" }
  }
  // A grant for a friend on the root-owned replay list must be time-bounded by the trusted file itself. The bundle's replay registry is the agent's to move aside, so it only ever adds the window check below.
  if (grant.expiresAt === undefined && isReplayGrantHolder(agentRoot, friend.id)) return { ok: false, reason: "grant_expired" }
  // A replay identity is a test peer of the host's replay gate: its grant means something only while the root-owned window is open.
  if (isReplayIdentity(agentRoot, friend.id) && !isReplayWindowOpen(agentRoot, friend.id, now)) return { ok: false, reason: "grant_expired" }
  if (friend.trustLevel !== "family" || friend.admissionState !== "active") return { ok: false, reason: "not_family" }
  return { ok: true }
}

export interface DelegatedCommandGrantChange {
  grant: true
  did: string
  source: string
  expiresAt?: string
}

/** Writes or removes one grant. The previous file is kept beside it as a timestamped backup before the change. */
export function setDelegatedCommandGrant(agentRoot: string, friendId: string, change: DelegatedCommandGrantChange | { grant: false }, now: Date = new Date()): { changed: boolean; backup: string | null } {
  return withTrustedWriteLock(agentRoot, () => setDelegatedCommandGrantLocked(agentRoot, friendId, change, now))
}

function setDelegatedCommandGrantLocked(agentRoot: string, friendId: string, change: DelegatedCommandGrantChange | { grant: false }, now: Date): { changed: boolean; backup: string | null } {
  const current = readDelegatedCommandGrants(agentRoot)
  const had = current[friendId]
  const next = { ...current }
  if (change.grant) {
    const entry: DelegatedCommandGrant = { scope: "principal_commands", did: change.did, grantedAt: now.toISOString(), source: change.source, ...(change.expiresAt ? { expiresAt: change.expiresAt } : {}) }
    if (had && had.did === entry.did && had.source === entry.source && had.expiresAt === entry.expiresAt) return { changed: false, backup: null }
    next[friendId] = entry
  } else {
    if (had === undefined) return { changed: false, backup: null }
    delete next[friendId]
  }
  const { backup } = writeTrustedFile(agentRoot, DELEGATED_COMMAND_GRANTS_FILE, `${JSON.stringify({ schemaVersion: 1, grants: next }, null, 2)}\n`, now)
  emitNervesEvent({
    component: "senses",
    event: "senses.a2a_delegated_command_grant_changed",
    message: change.grant ? "granted delegated commands to an A2A peer" : "revoked an A2A peer's delegated-command grant",
    meta: { friendId, granted: change.grant },
  })
  return { changed: true, backup }
}
