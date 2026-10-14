import * as path from "node:path"
import { FileFriendStore, FriendResolver, machineOwnerUsername, type FriendStore } from "@ouro.bot/friends"
import { getAgentBundlesRoot } from "../../heart/identity"
import { readMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { resolveShepherdConnection } from "../../heart/shepherd-config"
import { shepherdToolsEnabled } from "../../repertoire/tools-shepherd"
import { createShepherdHost, type ShepherdHost } from "./host"
import { emitNervesEvent } from "../../nerves/runtime"

/** A daemon-validated locator, never an authorization grant or a mutable short ref. */
export interface ShepherdSession {
  readonly id: string
  readonly host: "cmux"
  readonly label: string
}

export const SHEPHERD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Resolve the CLI's local identity, but forbid the resolver's first-encounter creation/promotion. */
export async function resolveExistingLocalOwner(store: FriendStore, username: string | null = machineOwnerUsername()): Promise<string> {
  if (!username) throw new Error("local machine owner identity is unavailable")
  let existing = await store.findByExternalId("local", username)
  if (!existing) {
    const matches = (store.listAll ? await store.listAll() : []).filter(friend =>
      friend.externalIds.some(identity => identity.provider === "local" && identity.externalId.startsWith(`${username}@`)))
    if (matches.length > 1) throw new Error("local-family linking is ambiguous; authorized owner setup is required")
    existing = matches[0] ?? null
  }
  if (!existing || existing.trustLevel !== "family" || existing.admissionState === "revoked") {
    throw new Error(`existing local-family linking is missing for OS user ${username}; authorized owner setup is required`)
  }
  // Snapshot lookup prevents FriendResolver from creating on a transient search failure or
  // migrating an identity as a side effect. The same resolver/channel path still produces context.
  const snapshot = existing
  const readonlyLookup = Object.create(store) as FriendStore
  readonlyLookup.findByExternalId = async () => snapshot
  return (await new FriendResolver(readonlyLookup, {
    provider: "local", externalId: username, displayName: username, channel: "cli",
  }).resolve()).friend.id
}

export function localShepherdFriendStore(agent: string): FileFriendStore {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) throw new Error("Shepherd requires a safe agent name")
  return new FileFriendStore(path.join(getAgentBundlesRoot(), `${agent}.ouro`, "friends"))
}

export function machineShepherdHost(agent: string): ShepherdHost {
  const root = path.join(getAgentBundlesRoot(), `${agent}.ouro`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent) || !shepherdToolsEnabled(root)) {
    throw new Error("agent does not have Shepherd enabled")
  }
  const machine = readMachineRuntimeCredentialConfig(agent)
  if (!machine.ok) throw new Error("machine Shepherd connection configuration is unavailable")
  const connection = resolveShepherdConnection(agent, machine.config)
  if (!connection.ok) throw new Error(connection.error)
  if (connection.connection.host !== "cmux") throw new Error("the dedicated composer requires cmux stable surface UUIDs")
  return createShepherdHost(connection.connection, { agentName: agent })
}

export async function listShepherdTargets(host: ShepherdHost, composerTty?: string): Promise<ShepherdSession[]> {
  return (await host.list()).filter(session => session.agent && SHEPHERD_UUID.test(session.id)
    && (!composerTty || (session.tty && session.tty.replace(/^\/dev\//, "") !== composerTty.replace(/^\/dev\//, "")))).map(session => Object.freeze({
    id: session.id,
    host: "cmux" as const,
    label: [session.agent, session.cwd, session.workspaceTitle, session.title]
      .filter(Boolean).map(part => part!.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160)).join(" / "),
  }))
}

export async function validateShepherdTarget(host: ShepherdHost, id: string): Promise<ShepherdSession> {
  if (!SHEPHERD_UUID.test(id)) throw new Error("Shepherd session must be a stable UUID")
  const matches = (await listShepherdTargets(host)).filter(target => target.id.toLowerCase() === id.toLowerCase())
  if (matches.length !== 1) throw new Error(`selected Shepherd terminal is unavailable: ${id}`)
  return matches[0]!
}

export async function authorizedShepherdTargets(agent: string, friendId: string, composerTty?: string): Promise<ShepherdSession[]> {
  const owner = await resolveExistingLocalOwner(localShepherdFriendStore(agent))
  if (owner !== friendId) throw new Error("Shepherd composer requires this OS user's existing local-family identity")
  const targets = await listShepherdTargets(machineShepherdHost(agent), composerTty)
  emitNervesEvent({ component: "senses", event: "senses.shepherd_targets_resolved", message: "resolved authorized independent composer targets", meta: { agent, count: targets.length } })
  return targets
}
