import * as path from "node:path"

import { BUTLER_AGENT_NAMES } from "../heart/butler-agent"
import { getAgentBundlesRoot, getAgentRoot } from "../heart/identity"
import { readSanctuaryAcceptanceMarker, type SanctuaryAcceptanceMarker } from "../heart/daemon/sanctuary-acceptance-marker"
import { readSanctuaryHealthCursor, recordSanctuarySchedulerLivenessReceipt } from "../heart/daemon/sanctuary-scheduler-liveness"
import {
  prepareSanctuaryPackageManagedBundle,
  requireSanctuaryPackageManagementDecision,
  resolveSanctuaryPackageManagementActivation,
} from "../heart/daemon/sanctuary-package-management"
import { emitNervesEvent } from "../nerves/runtime"
import type { OuroProduct, ProductHabitRunInput, ProductToolSelectionInput } from "../heart/product/types"
import type { ToolDefinition } from "../repertoire/tools-base"
import type { ButlerVisibilitySection } from "../repertoire/butler-status"
import { rootHostToolDefinition, selectRootHostTool } from "../repertoire/tools-sanctuary-host"
import { readOrCreateTelegramIdentityKey } from "../senses/telegram-identity-key"
import { DEFAULT_SANCTUARY_HOUSE, readSanctuaryHouse } from "../senses/sanctuary-house"
import { presentSanctuaryDownloadCreditReply } from "../senses/sanctuary-download-credit-presentation"
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
 * The house-care tools the Butler's own scheduled turns get (tools-house-care.ts). Named, not imported: their module loads
 * core's whole tool registry, and every process on the image loads the product. Core registers them, so a turn gets core's own.
 */
export const BUTLER_HOUSE_CARE_TOOL_NAMES = ["house_sweep", "house_digest_send"] as const

/** The tools the Butler adds to a turn's menu: the root-host tool in the owner's Telegram chat, and house care on its own private turns. */
export function selectButlerTools(input: ProductToolSelectionInput): readonly ToolDefinition[] {
  if (input.channel === "telegram") {
    // Offered only when this turn carries the owner's current, verified request; selectRootHostTool says so.
    const hostTool = selectRootHostTool(input.context, input.providerCapabilities)
    return hostTool ? [hostTool] : []
  }
  // The Butler's own scheduled turns (the daily house-care await) carry no relationship, so they cannot take the owner profile's menu.
  if (input.channel !== "inner" || input.relationshipScoped) return []
  return BUTLER_HOUSE_CARE_TOOL_NAMES.map((name) => {
    const definition = input.registered(name)
    if (!definition) throw new Error(`the Butler's house-care tool ${name} is not registered`)
    return definition
  })
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
  // J3: remote and relationship turns get only the relationship menu; the root-host tool is the Butler's own.
  tools: {
    definitions: [rootHostToolDefinition],
    relationshipScoped: true,
    select: selectButlerTools,
  },
  // J7: query_active_work adds the Butler's operational status. Loaded at the call: it reads Telegram's and the house's stores.
  status: {
    activeWorkSections: async ({ agentName, section, offset, limit }) => {
      const { formatButlerOperationalVisibility, readButlerOperationalVisibility } = await import("../repertoire/butler-status")
      return formatButlerOperationalVisibility(readButlerOperationalVisibility(getAgentRoot(), agentName), {
        section: section as ButlerVisibilitySection | undefined, offset, limit,
      })
    },
  },
  // J6: the Butler's Telegram holds no bot token. The root authority gateway holds it, so a token in the Butler's own config
  // is the misconfiguration, and both configs must be readable for the gateway to be validated at startup.
  senses: {
    telegram: {
      needsMachineConfig: true,
      readiness: ({ runtime, machine }) => runtime.ok && machine.ok
        && !Object.hasOwn(runtime.config, "telegramBotToken") && !Object.hasOwn(machine.config, "telegramBotToken")
        ? { configured: true, detail: "root authority transport; gateway validated at process startup" }
        : { configured: false, detail: "root authority migration requires available tokenless credential inventories" },
      repairHint: () => "Agent-runnable: complete or recover the root authority migration; do not restore a resident Telegram token.",
      // The owner's name is the household's own (house/house.json); a household that hasn't named one gets "Owner".
      ownerName: (agentName) => {
        const { ownerName } = readSanctuaryHouse(getAgentRoot(agentName))
        return ownerName === DEFAULT_SANCTUARY_HOUSE.ownerName ? "Owner" : ownerName
      },
      // "Why aren't my shows downloading?" gets the household's credit top-up reply, never the downloaders' internals.
      presentOwnerReply: (agentName, { request, text }) =>
        presentSanctuaryDownloadCreditReply(agentName, request === "why aren't my shows downloading?", text),
    },
  },
  // J8: the Butler takes delegated commands from peers the operator granted, each announced in the owner's own Telegram
  // chat before it runs (never through the owner route, never held), and files and confirms failure reports.
  a2a: {
    delegation: {
      notifyPrincipal: async (agentName, notice) => {
        const { sendTelegramDelegatedAuditNotice } = await import("../senses/telegram")
        await sendTelegramDelegatedAuditNotice(agentName, { ...notice, signal: AbortSignal.timeout(30_000) })
      },
    },
    escalation: true,
  },
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
