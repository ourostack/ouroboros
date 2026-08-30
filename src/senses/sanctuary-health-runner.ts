import * as path from "node:path"

import { recordExternalEvent, type ExternalEventInput, type ExternalEventRecord } from "../heart/external-events/router"
import { getAgentRoot } from "../heart/identity"
import { loadOrCreateMachineIdentity } from "../heart/machine-identity"
import { readMachineRuntimeCredentialConfig, refreshMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { createSanctuaryHealthSweep, type SanctuaryHealthSweepResult } from "./sanctuary-health"
import { createSanctuaryToolContext } from "./sanctuary-runtime"

export interface SanctuaryHealthHabitResult {
  ok: boolean
  message: string
  data: { incidentCount: number; submitted: number; wakesRequested: number }
}

export interface SanctuaryHealthHabitRunnerOptions {
  createSweep?: (agentName: string) => (() => Promise<SanctuaryHealthSweepResult>)
  submitEvidence?: (input: ExternalEventInput) => Promise<Pick<ExternalEventRecord, "shouldWake">> | Pick<ExternalEventRecord, "shouldWake">
  /** Legacy test seams retained only to prove the health runner never touches delivery or model work. */
  createApi?: (...args: never[]) => unknown
  credentials?: (...args: never[]) => unknown
  runPrivateTurn?: (...args: never[]) => unknown
  acceptanceMetrics?: {
    onPrivateTurnStart(): void
    onProviderInvocation(): void
  }
}

function evidenceInputs(agentName: string, result: SanctuaryHealthSweepResult): ExternalEventInput[] {
  const revision = result.observationRevision
  const current = result.incidents.map((incident) => ({
    agent: agentName,
    source: "sanctuary-health",
    eventType: "health.observed",
    eventId: incident.id,
    observationRevision: incident.observationRevision ?? revision,
    transition: incident.transition ?? result.transition ?? "changed",
    summary: incident.summary,
    evidence: [incident.summary],
    priority: "high",
  } satisfies ExternalEventInput))
  const recovered = (result.recovered ?? []).map((incident) => ({
    agent: agentName,
    source: "sanctuary-health",
    eventType: "health.observed",
    eventId: incident.id,
    observationRevision: incident.observationRevision ?? revision,
    transition: "recovered" as const,
    summary: `recovered: ${incident.summary}`,
    evidence: [`recovered: ${incident.summary}`],
    priority: "high",
  } satisfies ExternalEventInput))
  return [...current, ...recovered]
}

export async function runSanctuaryHealthHabit(agentName: string, options: SanctuaryHealthHabitRunnerOptions = {}): Promise<SanctuaryHealthHabitResult> {
  if (!options.createSweep && !readMachineRuntimeCredentialConfig(agentName).ok) {
    const machine = loadOrCreateMachineIdentity()
    await refreshMachineRuntimeCredentialConfig(agentName, machine.machineId, { preserveCachedOnFailure: true })
  }
  const sweep = options.createSweep?.(agentName) ?? createSanctuaryHealthSweep({
    toolContext: createSanctuaryToolContext(agentName),
    statePath: path.join(getAgentRoot(agentName), "state", "health", "sanctuary-health.json"),
  })
  const result = await sweep()
  const inputs = evidenceInputs(agentName, result)
  if (inputs.length === 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.sanctuary_health_habit",
      message: "Sanctuary health evidence submitted",
      meta: { agentName, incidentCount: 0, submitted: 0, wakesRequested: 0 },
    })
    return { ok: true, message: "health evidence submitted", data: { incidentCount: 0, submitted: 0, wakesRequested: 0 } }
  }
  const submit = options.submitEvidence ?? ((input: ExternalEventInput) => recordExternalEvent(input))
  const receipts = await Promise.all(inputs.map((input) => submit(input)))
  const wakesRequested = receipts.some((receipt) => receipt.shouldWake) ? 1 : 0
  emitNervesEvent({
    component: "senses",
    event: "senses.sanctuary_health_habit",
    message: "Sanctuary health evidence submitted",
    meta: { agentName, incidentCount: result.incidents.length, submitted: inputs.length, wakesRequested },
  })
  return { ok: true, message: "health evidence submitted", data: { incidentCount: result.incidents.length, submitted: inputs.length, wakesRequested } }
}
