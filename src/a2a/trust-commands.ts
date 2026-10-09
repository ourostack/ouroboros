import type { FriendRecord, FriendStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import {
  checkDelegatedCommandGrant, delegatedCommandGrantsPath, readDelegatedCommandGrants, setDelegatedCommandGrant, viewDelegatedCommandGrants,
  type DelegatedCommandGrant,
} from "./delegated-command-grants"
import { escalationGrantsPath, readEscalationGrants, setEscalationGrant, viewEscalationGrants } from "./escalation-grants"
import { isReplayGrantHolder } from "./replay-grant-holders"
import { operatorTrustDir } from "./operator-trust"
import { friendDid } from "./resolution-proof"

/**
 * The operator commands that write the grants under the trust directory: `ouro a2a delegated-commands ...` and
 * `ouro a2a escalation ...`. Every write needs root (the files must be root-owned to count), a `--did` the operator
 * copied from the sender's own host, and that DID must match the one the friend record already names.
 */
export interface TrustCommandContext {
  agentName: string
  agentRoot: string
  store: FriendStore
  now: Date
  /** True when the process runs as root. Grants and revokes write root-owned files, so they refuse otherwise. */
  isRoot: boolean
  /** This agent's own A2A DID, or null when it cannot be read; a grant may never pin it. */
  ownDid(): Promise<string | null>
  /**
   * The DID the running agent published in its own bundle, or null. Advisory: the agent can write its bundle, so it never replaces the twin
   * check against the friend records and never decides anything by itself; it only adds a warning that names where it came from.
   */
  publishedDid?(): Promise<string | null>
}

export interface DelegatedCommandsCommandInput {
  kind: "a2a.delegatedCommands"
  action: "grant" | "revoke" | "list"
  friendId?: string
  did?: string
  expires?: string
  source?: string
  json?: boolean
}

export interface EscalationCommandInput {
  kind: "a2a.escalation"
  action: "grant" | "revoke" | "list"
  friendId?: string
  did?: string
  source?: string
}

const NEEDS_ROOT = "refusing: this command writes root-owned files the agent cannot forge, so it must run as root on the agent's host (for example docker exec as root, or sudo). Nothing was written."

function requireRoot(ctx: TrustCommandContext): void {
  if (!ctx.isRoot) throw new Error(NEEDS_ROOT)
}

async function requireFriend(ctx: TrustCommandContext, friendId: string | undefined): Promise<FriendRecord> {
  const friend = await ctx.store.get(friendId!)
  if (!friend) throw new Error(`friend not found: ${friendId}`)
  return friend
}

/** The --did rules shared by both grant commands. Returns the DID to pin (equal to the record's). */
function checkedDid(friend: FriendRecord, did: string | undefined): string {
  if (!did || !did.startsWith("did:")) throw new Error(`refusing: --did ${did ?? "(missing)"} is not a DID (it starts with did:). Copy it from the sender's own host with: ouro a2a identity --json. Nothing was written.`)
  const recorded = friendDid(friend)
  if (!recorded) throw new Error(`refusing: ${friend.name} has no DID on record, so there is nothing to check --did against. Onboard it with its DID first (ouro a2a onboard --did <did> --name "${friend.name}"). Nothing was written.`)
  if (recorded !== did) throw new Error(`refusing: --did ${did} does not match the DID on ${friend.name}'s record (${recorded}). If the sender's key really changed, onboard it again; otherwise you copied the wrong DID. Nothing was written.`)
  return did
}

/**
 * The checks both grant commands share before they pin a DID. It may not be this agent's own, and it may not already be pinned by
 * another holder's grant in the same file. When this agent's own DID cannot be read (a one-off root container has no vault) the
 * own-DID check cannot run, so the command instead refuses any DID that a second friend record also carries (a sender's key is on
 * exactly one record), and says so in its output.
 */
async function vetPinnedDid(ctx: TrustCommandContext, friend: FriendRecord, did: string, held: Record<string, { did: string }>): Promise<string[]> {
  const own = await ctx.ownDid()
  if (own === did) throw new Error("refusing: that is this agent's own DID. A grant must pin the sender's key, not this agent's. Nothing was written.")
  const holder = Object.entries(held).find(([id, existing]) => id !== friend.id && existing.did === did)
  if (holder) throw new Error(`refusing: that DID is already pinned by ${holder[0]}'s grant. Revoke it first if the sender really moved to a different friend record. Nothing was written.`)
  if (own !== null) return []
  // The own DID is not available from the machine config here. A DID the agent published in its bundle is only a hint (the agent can write
  // that file), so the friend-record comparison always runs as well, and the published value is reported with its source.
  const published = await ctx.publishedDid?.() ?? null
  const records = await ctx.store.listAll?.() ?? []
  const twin = records.find((record) => record.id !== friend.id && friendDid(record) === did)
  if (twin) throw new Error(`refusing: this agent's own DID could not be read from its machine config here, and another friend record (${twin.name}, ${twin.id}) carries that same DID, so it may be this agent's own key. Check it with: ouro a2a identity --agent ${ctx.agentName} --json. Nothing was written.`)
  const notes = ["note: could not read this agent's own DID from its machine config here, so the own-DID check was skipped; compared --did with every DID in the friend records instead, and no other record carries it"]
  if (published === did) notes.push("warning: --did equals the DID published in the agent's bundle (source: bundle-published, which the agent itself can write, so this is advisory). Granting it would pin the agent's own key; check with ouro a2a identity --agent " + ctx.agentName + " --json before relying on this grant")
  else if (published !== null) notes.push(`note: the DID published in the agent's bundle (source: bundle-published, advisory) is ${published}, which differs from --did`)
  return notes
}

function notActiveFamilyNote(friend: FriendRecord, what: string): string[] {
  return friend.trustLevel === "family" && friend.admissionState === "active"
    ? []
    : [`note: ${friend.name} is ${friend.trustLevel}, ${friend.admissionState}, so the grant stays suspended until it is active family${what}`]
}

function parseExpiry(expires: string | undefined, now: Date): string | undefined {
  if (expires === undefined) return undefined
  const at = Date.parse(expires)
  if (!Number.isFinite(at) || at <= now.getTime()) throw new Error(`refusing: --expires ${expires} is not a time in the future (use an ISO date such as 2027-01-01T00:00:00Z). Nothing was written.`)
  return new Date(at).toISOString()
}

export async function executeDelegatedCommandsCommand(command: DelegatedCommandsCommandInput, ctx: TrustCommandContext): Promise<string> {
  if (command.action === "list") return listDelegatedCommands(ctx, command.json === true)
  requireRoot(ctx)
  if (command.action === "revoke") return revokeDelegatedCommands(command.friendId!, ctx)
  const expiresAt = parseExpiry(command.expires, ctx.now)
  const friend = await requireFriend(ctx, command.friendId)
  if (expiresAt === undefined && isReplayGrantHolder(ctx.agentRoot, friend.id)) throw new Error(`refusing: ${friend.name} is a replay peer (it is on the replay gate's list in ${operatorTrustDir(ctx.agentRoot)}), and a replay peer's grant must expire. Pass --expires <ISO date>. Nothing was written.`)
  const did = checkedDid(friend, command.did)
  const selfNotes = await vetPinnedDid(ctx, friend, did, readDelegatedCommandGrants(ctx.agentRoot))
  const change = setDelegatedCommandGrant(ctx.agentRoot, friend.id, { grant: true, did, source: command.source ?? `ouro a2a delegated-commands grant, ${ctx.now.toISOString()}`, ...(expiresAt ? { expiresAt } : {}) }, ctx.now)
  emitNervesEvent({ component: "senses", event: "senses.a2a_trust_grant_changed", message: "operator changed a trust grant", meta: { action: "grant", scope: "delegated_commands" } })
  return [
    `granted delegated commands: ${friend.name} (${friend.id})${change.changed ? "" : " (no change)"}`,
    `pinned DID: ${did}`,
    `expires: ${expiresAt ?? "never"}`,
    `trust directory: ${operatorTrustDir(ctx.agentRoot)}`,
    ...(change.backup ? [`backup: ${change.backup}`] : []),
    ...selfNotes,
    ...(readDelegatedCommandGrants(ctx.agentRoot)[friend.id] === undefined ? [`WARNING: the grant is written but will not be honoured: ${delegatedCommandGrantsPath(ctx.agentRoot)} and every directory above it must be owned by root and writable by no one else. Run \`ouro a2a delegated-commands list\` for what the harness sees.`] : []),
    ...notActiveFamilyNote(friend, ""),
  ].join("\n")
}

/** The follow-up that clears the legacy record field as the resident user: the record is the Butler's own file, and this command runs as root, so it never writes it. */
function clearLegacyGrantCommand(agentRoot: string, friendId: string): string {
  const file = `${agentRoot}/friends/${friendId}.json`
  const script = `const fs=require("fs");const f=${JSON.stringify(file)};const r=JSON.parse(fs.readFileSync(f,"utf8"));delete r.delegationGrant;fs.writeFileSync(f,JSON.stringify(r,null,2)+"\\n")`
  return [
    "REQUIRED FOLLOW-UP: the trusted grant is removed, but the legacy delegationGrant on the friend record is still there (friend records are never written as root). An older harness would honour it after a rollback. Clear it as the resident user:",
    `  docker exec -u 10001 ouro-butler node -e '${script}'`,
  ].join("\n")
}

async function revokeDelegatedCommands(friendId: string, ctx: TrustCommandContext): Promise<string> {
  const friend = await ctx.store.get(friendId)
  const change = setDelegatedCommandGrant(ctx.agentRoot, friendId, { grant: false }, ctx.now)
  // A rollback to an older harness reads the legacy record grant. This command runs as root and must not write the Butler's friend record, so it prints the resident-user follow-up instead.
  const legacyFollowUp = friend?.delegationGrant !== undefined ? clearLegacyGrantCommand(ctx.agentRoot, friend.id) : null
  emitNervesEvent({ component: "senses", event: "senses.a2a_trust_grant_changed", message: "operator changed a trust grant", meta: { action: "revoke", scope: "delegated_commands" } })
  return [
    `revoked delegated commands: ${friend ? `${friend.name} (${friend.id})` : `${friendId} (no friend record)`}${change.changed || legacyFollowUp ? "" : " (no change)"}`,
    ...(legacyFollowUp ? [legacyFollowUp] : []),
    ...(change.backup ? [`backup: ${change.backup}`] : []),
  ].join("\n")
}

type GrantStatus = { status: "honoured" } | { status: "suspended"; reason: string; text: string } | { status: "not_honoured"; reason: string; text: string }

function statusOf(friendId: string, grant: DelegatedCommandGrant, friend: FriendRecord | null, ctx: TrustCommandContext): GrantStatus {
  if (!friend) return { status: "not_honoured", reason: "no_friend_record", text: `no friend record for ${friendId}` }
  const check = checkDelegatedCommandGrant(ctx.agentRoot, friend, friendDid(friend), ctx.now.getTime())
  if (check.ok) return { status: "honoured" }
  switch (check.reason) {
    case "not_family":
      return { status: "suspended", reason: check.reason, text: `${friend.name} is trust ${friend.trustLevel}, admission ${friend.admissionState}; the grant is kept and applies again once it is family and active` }
    case "grant_did_mismatch":
      return { status: "not_honoured", reason: check.reason, text: `the friend record names ${friendDid(friend) ?? "no DID"}, but the grant pins ${grant.did}` }
    default:
      return { status: "not_honoured", reason: check.reason, text: "the grant is not in force: it expired, this is a replay identity outside its window, or the grant file stopped being trusted" }
  }
}

async function listDelegatedCommands(ctx: TrustCommandContext, json: boolean): Promise<string> {
  const file = delegatedCommandGrantsPath(ctx.agentRoot)
  const view = viewDelegatedCommandGrants(ctx.agentRoot)
  const friends = await ctx.store.listAll?.() ?? []
  const byId = new Map(friends.map((friend) => [friend.id, friend]))
  const entries = Object.entries(view.grants).map(([friendId, grant]) => {
    const friend = byId.get(friendId) ?? null
    return { friendId, name: friend?.name ?? null, grant, ...statusOf(friendId, grant, friend, ctx) }
  })
  const legacy = friends.filter((friend) => friend.delegationGrant !== undefined)
  if (json) {
    return JSON.stringify({
      agent: ctx.agentName,
      file: { path: file, state: view.state, ...(view.state === "untrusted" ? { reason: view.reason } : {}) },
      grants: entries.map(({ friendId, name, grant, ...status }) => ({ friendId, name, did: grant.did, grantedAt: grant.grantedAt, source: grant.source, expiresAt: grant.expiresAt ?? null, ...status })),
      ignoredEntries: view.ignored,
      legacyRecordGrants: legacy.map((friend) => ({ friendId: friend.id, name: friend.name })),
    }, null, 2)
  }
  const header = view.state === "trusted" ? `trusted: ${file}` : view.state === "missing" ? `not present: ${file}` : `NOT TRUSTED: ${file} (${view.reason}); no grant in it is honoured`
  const lines = [`delegated-command grants for ${ctx.agentName}`, header]
  if (entries.length === 0) lines.push("no delegated-command grants")
  for (const entry of entries) {
    lines.push(
      `${entry.friendId}  ${entry.name ?? "(no friend record)"}`,
      `  DID ${entry.grant.did}; granted ${entry.grant.grantedAt} (${entry.grant.source}); expires ${entry.grant.expiresAt ?? "never"}`,
      entry.status === "honoured" ? "  HONOURED" : entry.status === "suspended" ? `  SUSPENDED: ${(entry as { text: string }).text}` : `  NOT HONOURED: ${(entry as { text: string }).text}`,
    )
  }
  if (view.ignored.length > 0) lines.push(`ignored (malformed) entries: ${view.ignored.join(", ")}`)
  if (legacy.length > 0) lines.push(`legacy friend-record grants (not honoured): ${legacy.map((friend) => `${friend.name} (${friend.id})`).join(", ")}`)
  return lines.join("\n")
}

export async function executeEscalationCommand(command: EscalationCommandInput, ctx: TrustCommandContext): Promise<string> {
  if (command.action === "list") {
    const grants = Object.entries(readEscalationGrants(ctx.agentRoot))
    const view = viewEscalationGrants(ctx.agentRoot)
    const note = view.state === "untrusted" ? `\nNOT TRUSTED: ${escalationGrantsPath(ctx.agentRoot)} (${view.reason}); no grant in it is honoured` : ""
    return (grants.length === 0 ? "no escalation grants" : grants.map(([id, grant]) => `${id}  granted ${grant.grantedAt}  ${grant.did}  ${grant.source}`).join("\n")) + note
  }
  requireRoot(ctx)
  if (command.action === "revoke") return revokeEscalation(command.friendId!, ctx)
  const friend = await requireFriend(ctx, command.friendId)
  if (isReplayGrantHolder(ctx.agentRoot, friend.id)) throw new Error(`refusing: ${friend.name} is a replay peer (it is on the replay gate's list in ${operatorTrustDir(ctx.agentRoot)}). Only the replay gate grants it escalation, and only while a run is open. Nothing was written.`)
  const did = checkedDid(friend, command.did)
  const selfNotes = await vetPinnedDid(ctx, friend, did, readEscalationGrants(ctx.agentRoot))
  const change = setEscalationGrant(ctx.agentRoot, friend.id, { grant: true, source: command.source ?? `ouro a2a escalation grant, ${ctx.now.toISOString()}`, did }, ctx.now)
  emitNervesEvent({ component: "senses", event: "senses.a2a_trust_grant_changed", message: "operator changed a trust grant", meta: { action: "grant", scope: "escalation" } })
  return [
    `granted escalation: ${friend.name} (${friend.id})${change.changed ? "" : " (no change)"}`,
    `pinned DID: ${did}`,
    ...(change.backup ? [`backup: ${change.backup}`] : []),
    ...selfNotes,
    ...(readEscalationGrants(ctx.agentRoot)[friend.id] === undefined ? [`WARNING: the grant is written but will not be honoured: ${escalationGrantsPath(ctx.agentRoot)} and every directory above it must be owned by root and writable by no one else.`] : []),
    ...(friend.trustLevel !== "family" || friend.admissionState !== "active" ? [`note: ${friend.name} only holds the grant while it is active family (now ${friend.trustLevel}, ${friend.admissionState})`] : []),
  ].join("\n")
}

/** Revoke needs no friend record: a grant for a friend that was deleted must still be removable by its id. */
async function revokeEscalation(friendId: string, ctx: TrustCommandContext): Promise<string> {
  const friend = await ctx.store.get(friendId)
  const change = setEscalationGrant(ctx.agentRoot, friendId, { grant: false }, ctx.now)
  emitNervesEvent({ component: "senses", event: "senses.a2a_trust_grant_changed", message: "operator changed a trust grant", meta: { action: "revoke", scope: "escalation" } })
  return [
    `revoked escalation: ${friend ? `${friend.name} (${friend.id})` : `${friendId} (no friend record)`}${change.changed ? "" : " (no change)"}`,
    ...(change.backup ? [`backup: ${change.backup}`] : []),
  ].join("\n")
}
