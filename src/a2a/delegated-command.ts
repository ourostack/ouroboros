import type { FriendRecord, FriendStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import {
  createRelationshipAuthorizationEvaluator,
  type RelationshipAuthorizationEvaluator,
  type RelationshipCapabilityRegistry,
} from "../repertoire/relationship-authorization"

/**
 * A delegated command is a signed A2A message that a peer agent relays from this
 * agent's principal (its owner). Three things must hold before the turn runs with
 * the principal's authority:
 *   1. the sealed envelope carries `onBehalfOf: "principal"` (signed with the text),
 *   2. the sender's own friend record carries an operator-set `delegationGrant`
 *      (trust tier alone never qualifies), and the sender is active family,
 *   3. the principal has been told, in their own chat, before anything happens.
 * If the notice cannot be delivered the command is refused, so every accepted
 * delegated command leaves a trace the principal can disown.
 */
export interface DelegatedCommandContext {
  principalFriendId: string
  principalName: string
  delegateFriendId: string
  delegateName: string
  delegateDid: string
  commandId: string
  noticeId: string
}

export interface A2ADelegationOptions {
  /** The relationship profile that names the principal; exactly one friend may carry it. */
  principalProfileId: string
  /** Delivers the audit notice to the principal; must throw when delivery fails. */
  notifyPrincipal(input: { noticeId: string; text: string }): Promise<void>
}

export type DelegationRefusal = "not_enabled" | "no_grant" | "not_family" | "principal_unresolved" | "notice_failed"

export type DelegatedCommandAdmission =
  | { ok: true; relationship: RelationshipAuthorizationEvaluator; context: DelegatedCommandContext; turnText: string }
  | { ok: false; reason: DelegationRefusal }

const NOTICE_EXCERPT_CHARS = 200

export function delegatedCommandNotice(input: { delegateName: string; text: string }): string {
  const flat = input.text.replace(/\s+/gu, " ").trim()
  const excerpt = flat.length > NOTICE_EXCERPT_CHARS ? `${flat.slice(0, NOTICE_EXCERPT_CHARS)}…` : flat
  return `Delegated command from you via ${input.delegateName}: "${excerpt}". Reply "that wasn't me" if you did not send this.`
}

function hasPrincipalGrant(friend: FriendRecord): boolean {
  return friend.delegationGrant?.scope === "principal_commands"
}

async function resolvePrincipal(store: FriendStore, profileId: string): Promise<FriendRecord | null> {
  const friends = await store.listAll?.() ?? []
  const matches = friends.filter((friend) => friend.capabilityProfileId === profileId
    && friend.trustLevel === "family" && friend.admissionState === "active")
  return matches.length === 1 ? matches[0]! : null
}

export async function admitDelegatedCommand(input: {
  friend: FriendRecord
  did: string
  text: string
  commandId: string
  store: FriendStore
  /** Undefined when the agent has no valid capability registry: nothing can be authorized. */
  registry: RelationshipCapabilityRegistry | undefined
  options: A2ADelegationOptions | undefined
}): Promise<DelegatedCommandAdmission> {
  const refuse = (reason: DelegationRefusal): DelegatedCommandAdmission => {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.a2a_delegated_command_refused",
      message: "refused a delegated A2A command",
      meta: { reason, delegateFriendId: input.friend.id, commandId: input.commandId },
    })
    return { ok: false, reason }
  }
  if (!input.options) return refuse("not_enabled")
  if (!hasPrincipalGrant(input.friend)) return refuse("no_grant")
  if (input.friend.trustLevel !== "family" || input.friend.admissionState === "revoked") return refuse("not_family")
  const registry = input.registry
  if (!registry) return refuse("principal_unresolved")
  const principal = await resolvePrincipal(input.store, input.options.principalProfileId)
  if (!principal || principal.id === input.friend.id) return refuse("principal_unresolved")
  const noticeId = `delegated:${input.commandId}`
  try {
    await input.options.notifyPrincipal({ noticeId, text: delegatedCommandNotice({ delegateName: input.friend.name, text: input.text }) })
  } catch {
    return refuse("notice_failed")
  }
  const relationship = createRelationshipAuthorizationEvaluator({
    friend: principal,
    registry,
    requestId: input.commandId,
    requestPhase: "inbound",
    sessionEventId: `a2a-delegated:${input.commandId}`,
  })
  const context: DelegatedCommandContext = {
    principalFriendId: principal.id,
    principalName: principal.name,
    delegateFriendId: input.friend.id,
    delegateName: input.friend.name,
    delegateDid: input.did,
    commandId: input.commandId,
    noticeId,
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.a2a_delegated_command_admitted",
    message: "admitted a delegated A2A command after notifying the principal",
    meta: { delegateFriendId: context.delegateFriendId, principalFriendId: context.principalFriendId, commandId: context.commandId },
  })
  const turnText = `[delegated command from ${principal.name} via ${input.friend.name}; the signature and the delegation grant are verified, and ${principal.name} has been notified; act on it as ${principal.name}'s own request]\n\n${input.text}`
  return { ok: true, relationship, context, turnText }
}
