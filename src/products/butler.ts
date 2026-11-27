import * as path from "node:path"

import { BUTLER_AGENT_NAMES } from "../heart/butler-agent"
import { getAgentBundlesRoot } from "../heart/identity"
import { readSanctuaryAcceptanceMarker, type SanctuaryAcceptanceMarker } from "../heart/daemon/sanctuary-acceptance-marker"
import { readSanctuaryHealthCursor, recordSanctuarySchedulerLivenessReceipt } from "../heart/daemon/sanctuary-scheduler-liveness"
import {
  prepareSanctuaryPackageManagedBundle,
  requireSanctuaryPackageManagementDecision,
  resolveSanctuaryPackageManagementActivation,
} from "../heart/daemon/sanctuary-package-management"
import { emitNervesEvent } from "../nerves/runtime"
import type { OuroProduct, ProductHabitRunInput } from "../heart/product/types"
import { readOrCreateTelegramIdentityKey } from "../senses/telegram-identity-key"
import type { DaemonResponse } from "../heart/daemon/daemon"


/** The acceptance run that proves a cron fire reaches the health sweep (Unit 16f), when one is running. */
function cronFingerprintScenario(agent: string): SanctuaryAcceptanceMarker | null {
  const marker = readSanctuaryAcceptanceMarker(agent)
  return marker?.label === "unit-16f-cron-fingerprint" ? marker : null
}

/**
 * The house check on its schedule: sweep the house, and file what changed as `sanctuary-health` events, which wake the
 * Butler. During the cron-fingerprint acceptance run it also records the liveness receipt that proves the fire was the
 * scheduler's and did no paid work.
 */
// The Butler's runtime is loaded at its first use, not with the product: it imports Sanctuary's whole tool registry, and every
// process on the image (each CLI command, the scheduler's poke) loads the product.
async function sanctuaryRuntime(): Promise<typeof import("../senses/sanctuary-runtime")> {
  return import("../senses/sanctuary-runtime")
}

async function runSanctuaryHealth(input: ProductHabitRunInput): Promise<DaemonResponse> {
  const schedulerScenario = cronFingerprintScenario(input.agent)
  const agentRoot = path.join(getAgentBundlesRoot(), `${input.agent}.ouro`)
  const before = schedulerScenario ? readSanctuaryHealthCursor(agentRoot) : null
  let providerInvocationCount = 0
  let privateTurnCount = 0
  // Loaded here, not with the product: it imports Sanctuary's tool registry.
  const { runSanctuaryHealthHabit } = await import("../senses/sanctuary-health-runner")
  const result = await runSanctuaryHealthHabit(input.agent, {
    submitEvidence: input.submitExternalEvent,
    ...(schedulerScenario ? {
      acceptanceMetrics: {
        onPrivateTurnStart: () => { privateTurnCount += 1 },
        onProviderInvocation: () => { providerInvocationCount += 1 },
      },
    } : {}),
  })
  if (schedulerScenario) {
    const unavailable = "Sanctuary scheduler liveness supervisor provenance is unavailable"
    if (!before || !input.occurrenceId || !input.schedulerOrigin) throw new Error(unavailable)
    const supervisor = input.schedulerSnapshot()
    if (!supervisor) throw new Error(unavailable)
    recordSanctuarySchedulerLivenessReceipt({
      agentRoot,
      trigger: input.trigger,
      occurrenceId: input.occurrenceId,
      runnerId: input.runnerId,
      scenario: schedulerScenario,
      supervisor,
      before,
      providerInvocationCount,
      privateTurnCount,
      schedulerOrigin: input.schedulerOrigin,
      identityKey: readOrCreateTelegramIdentityKey(agentRoot),
    })
  }
  return result
}

/**
 * The Butler, registered with the harness through the product seam. The Unraid image names this module in
 * /opt/ouro/container-runtime.json, so core loads it at runtime and never imports it. Each of the Butler's jobs gets its
 * slot here as it moves behind the seam (M3).
 */
export const product: OuroProduct = {
  seamVersion: 1,
  id: "butler",
  agents: BUTLER_AGENT_NAMES,
  // J2: the packaged starter bundle is checked and migrated into the live bundle before anything starts.
  startup: (input) => {
    const decision = resolveSanctuaryPackageManagementActivation({ ...input, argv: [...input.argv] })
    return {
      preflight: () => { requireSanctuaryPackageManagementDecision(decision) },
      prepareManagedBundle: () => { prepareSanctuaryPackageManagedBundle(decision) },
    }
  },
  // J5: events from the house check and the Usenet watch wake the Butler only once its machine credentials are complete.
  eventSources: {
    "sanctuary-health": { ready: async (agent) => { await (await sanctuaryRuntime()).ensureSanctuarySourceRuntimeReady(agent, "sanctuary-health") } },
    "sanctuary-usenet": { ready: async (agent) => { await (await sanctuaryRuntime()).ensureSanctuarySourceRuntimeReady(agent, "sanctuary-usenet") } },
  },
  // J4: every turn gets the house runtime its tools read, and the answer gates the Butler opts in to.
  turnContext: async ({ agentName }) => (await sanctuaryRuntime()).createSanctuaryToolContext(agentName),
  // J5: the house check runs in the daemon, and only Supercronic may fire it on its cron schedule.
  habits: {
    "sanctuary-health": {
      run: runSanctuaryHealth,
      requiresSchedulerAttestation: true,
      attestationScenario: (agent) => cronFingerprintScenario(agent)?.scenarioHandleDigest ?? null,
    },
  },
}

emitNervesEvent({ component: "daemon", event: "daemon.butler_product_registered", message: "Butler product registered", meta: { agents: [...product.agents] } })
