import { createHash } from "node:crypto"
import * as path from "node:path"
import type { ShepherdOperation } from "../../heart/shepherd/operations"
import type { ShepherdRetirementProof, ShepherdSenseStoppedProof } from "../../heart/shepherd/custody-types"
import { readShepherdMandates, updateShepherdMandate } from "../../heart/shepherd/mandates"
import { readMailboxSupervision } from "../../heart/mailbox/mailbox-supervision"
import { SHEPHERD_ALPHA_AUTOMATION_WARNING } from "../../heart/shepherd/supervision"
import { readGuidance, setShepherdSessionPause } from "./guidance"
import { checkInStorePath } from "./checkin-store"
import { maintainShepherdCustody, readCheckInSnapshot, readMaintenanceCheckInSnapshot, reconcileShepherdDispatch } from "./recovery"
import { emitNervesEvent } from "../../nerves/runtime"

export interface ShepherdOperationDeps {
  agentRoot(agent: string): string
  resolveOwner(agent: string): Promise<{ actorId: string }>
  host(agent: string): Promise<{ name: string; list(): Promise<Array<{ id: string; cwd?: string | null; instance?: string | null }>>; retirementInventory?(): Promise<string[]> }>
  senseStopped(agent: string): Promise<ShepherdSenseStoppedProof>
}

function fingerprint(command: ShepherdOperation): string {
  return createHash("sha256").update(JSON.stringify(command, Object.keys(command).sort())).digest("hex")
}

/** Same-UID local administration only. No evidence, actor, or lifecycle claims come from argv. */
export async function runShepherdOperation(command: ShepherdOperation, deps: ShepherdOperationDeps): Promise<unknown> {
  try {
    const { actorId } = await deps.resolveOwner(command.agent)
    const actor = { kind: "local_owner_administration" as const, actorId }
    const root = deps.agentRoot(command.agent)
    const file = checkInStorePath(root)
    if (command.kind === "shepherd.status") return {
      boundary: "same_uid_local_owner_administration_not_human_presence",
      automation: { mode: "guarded_native_required", mandatesEnforcedForAllTriggers: true,
        nativeHostQualificationRequired: true, unattendedKeysPossible: false, warning: SHEPHERD_ALPHA_AUTOMATION_WARNING },
      supervision: readMailboxSupervision(command.agent, { agentRoot: root }),
      guidance: readGuidance(root), mandates: readShepherdMandates(root),
      custody: readCheckInSnapshot(file, { limit: 50 }),
    }
    if (command.kind === "shepherd.inspect") return readCheckInSnapshot(file, command)
    if (command.kind === "shepherd.mandate.grant") return await updateShepherdMandate(root, {
      operation: "grant", context: { ...actor, requestId: command.requestId }, expectedRevision: command.expectedRevision,
      target: {
        project: command.project, ...(command.host ? { host: command.host } : {}),
        ...(command.session ? { session: command.session } : {}), ...(command.instance ? { instance: command.instance } : {}),
      },
      task: command.task, expiresAt: command.expiresAt,
    })
    if (command.kind === "shepherd.mandate.revoke") return await updateShepherdMandate(root, {
      operation: "revoke", context: { ...actor, requestId: command.requestId }, expectedRevision: command.expectedRevision,
      mandateId: command.id.startsWith("mandate:") ? command.id : `mandate:${command.id}`,
    })
    if (command.kind === "shepherd.pause" || command.kind === "shepherd.resume") {
      const host = await deps.host(command.agent)
      if (host.name !== command.host) throw new Error("requested host does not match the configured host")
      const matches = (await host.list()).filter(session => session.id === command.session)
      if (matches.length !== 1) throw new Error("a unique verified live terminal is required")
      const target = { host: host.name, session: matches[0]!.id, cwd: matches[0]!.cwd ?? null, task: null }
      return await setShepherdSessionPause(root, {
        actorId, requestId: command.requestId, expectedRevision: command.expectedRevision,
        requestFingerprint: fingerprint(command), target, paused: command.kind === "shepherd.pause",
      }, [target])
    }
    if (command.kind === "shepherd.reconcile") {
      if (command.resolution === "delivered") throw new Error("confirmed delivery is unsupported: no qualified guarded host receipt lookup is available")
      const snapshot = readCheckInSnapshot(file, { limit: 1, id: command.id })
      const entry = snapshot.entries[0]
      if (!entry) throw new Error("dispatch not found")
      const host = await deps.host(command.agent)
      if (host.name !== entry.host) throw new Error("custody host does not match the configured host")
      // Foreground inventories cannot prove that an older process in a surviving terminal exited.
      if (!host.retirementInventory) throw new Error("qualified complete retirement inventory is unavailable")
      if ((await host.retirementInventory()).includes(entry.session)) throw new Error("terminal still exists; foreground inventory cannot prove process retirement")
      const evidence: ShepherdRetirementProof = {
        kind: "host_process_inventory", host: entry.host, session: entry.session, instance: entry.instance,
        checkedAt: new Date().toISOString(), gone: true, wholeSessionRetired: true,
      }
      return await reconcileShepherdDispatch(root, { id: command.id, expectedRevision: command.expectedRevision, requestId: command.requestId, actor, evidence })
    }
    if (command.kind !== "shepherd.maintenance") throw new Error("unsupported Shepherd administration operation")
    const sense = await deps.senseStopped(command.agent)
    const host = await deps.host(command.agent)
    if (!host.retirementInventory) throw new Error("qualified complete retirement inventory is unavailable")
    const sessions = await host.retirementInventory()
    const retiredInstances: ShepherdRetirementProof[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = readMaintenanceCheckInSnapshot(file, { limit: 200, ...(cursor ? { cursor } : {}) }, sense)
      if (page.state !== "ready") throw new Error("custody store is missing")
      for (const entry of page.entries) {
        if (entry.host !== host.name || sessions.includes(entry.session)) continue
        const key = JSON.stringify([entry.host, entry.session, entry.instance])
        if (seen.has(key)) continue
        seen.add(key)
        retiredInstances.push({
          kind: "host_process_inventory", host: entry.host, session: entry.session, instance: entry.instance,
          checkedAt: new Date().toISOString(), gone: true, wholeSessionRetired: true,
        })
        if (retiredInstances.length > 200) throw new Error("maintenance exceeds 200 retired instances; narrower native retirement qualification is required")
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    if (!path.isAbsolute(command.destination)) throw new Error("maintenance destination must be absolute")
    return await maintainShepherdCustody(root, {
      expectedRevision: command.expectedRevision, requestId: command.requestId, actor, sense, retiredInstances,
      destination: command.destination, requestFingerprint: fingerprint(command),
    })
  } catch (error) {
    emitNervesEvent({
      component: "senses", level: "warn", event: "senses.shepherd_administration_failed",
      message: "local-owner Shepherd operation failed; no inferred authority or evidence substituted",
      meta: { operation: command.kind },
    })
    throw error
  }
}
