// Unified agent runtime entrypoint.
// Requires --agent before importing runtime modules that rely on identity.
const agentArgIndex = process.argv.indexOf("--agent")
const parsedAgentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!parsedAgentName) {
  // eslint-disable-next-line no-console -- pre-boot guard
  console.error("Missing required --agent <name> argument.\nUsage: node dist/heart/agent-entry.js --agent ouroboros")
  process.exit(1)
}
const agentName = parsedAgentName

import { configureCliRuntimeLogger } from "../nerves/cli-logging"
import { emitNervesEvent } from "../nerves/runtime"
import type { PrivateRuntimeWorkerController } from "../senses/private-runtime-worker"
import type { AgentProvider } from "./identity"

configureCliRuntimeLogger("self")

interface AgentEntryIpcState {
  bufferedRuntimeCredentialMessages: unknown[]
  bufferedMessages: unknown[]
  installed: boolean
  workerMessageHandler: ((message: unknown) => void) | null
}

const ipcStateKey = Symbol.for("ouro.agentEntry.ipcState")
const ipcState = ((globalThis as unknown as Record<symbol, AgentEntryIpcState>)[ipcStateKey] ??= {
  bufferedRuntimeCredentialMessages: [],
  bufferedMessages: [],
  installed: false,
  workerMessageHandler: null,
})

ipcState.bufferedRuntimeCredentialMessages = []
ipcState.bufferedMessages = []
ipcState.workerMessageHandler = null

function isRuntimeCredentialBootstrapMessage(message: unknown): boolean {
  return !!message
    && typeof message === "object"
    && !Array.isArray(message)
    && (message as { type?: unknown }).type === "ouro.runtimeCredentialBootstrap"
}

function isRuntimeCredentialBootstrapForAgent(message: unknown, expectedAgentName: string): boolean {
  return isRuntimeCredentialBootstrapMessage(message)
    && (message as { agentName?: unknown }).agentName === expectedAgentName
}

function drainBufferedRuntimeCredentialBootstrap(
  applyRuntimeCredentialBootstrapMessage: (message: unknown) => boolean,
): boolean {
  let bootstrapped = false
  const remainingMessages: unknown[] = []
  for (const message of ipcState.bufferedRuntimeCredentialMessages.splice(0)) {
    if (isRuntimeCredentialBootstrapForAgent(message, agentName)) {
      bootstrapped = applyRuntimeCredentialBootstrapMessage(message) || bootstrapped
    } else {
      remainingMessages.push(message)
    }
  }
  ipcState.bufferedRuntimeCredentialMessages.push(...remainingMessages)
  return bootstrapped
}

function isPrivateRuntimeWorkMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false
  const type = (message as { type?: unknown }).type
  return type === "heartbeat"
    || type === "habit"
    || type === "await"
    || type === "shutdown"
    || type === "poke"
    || type === "chat"
    || type === "message"
    || type === "ouro.privateRuntimeDispatchCancel"
}

function safeDispatchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith("[agent-runnable]")) return "[agent-runnable] Private-runtime work failed; inspect the agent's redacted runtime diagnostics and run the indicated repair."
  if (message.startsWith("[human-required]")) return "[human-required] Private-runtime work needs human repair; inspect the agent's redacted runtime diagnostics."
  if (message.startsWith("[human-choice]")) return "[human-choice] Private-runtime work needs an explicit human decision; inspect the agent's redacted runtime diagnostics."
  return "private-runtime worker failed; inspect the worker's redacted runtime diagnostics"
}

function forwardOrBufferRuntimeMessage(message: unknown): void {
  if (isRuntimeCredentialBootstrapMessage(message)) {
    ipcState.bufferedRuntimeCredentialMessages.push(message)
    return
  }
  if (!isPrivateRuntimeWorkMessage(message)) return
  if (ipcState.workerMessageHandler) {
    ipcState.workerMessageHandler(message)
    return
  }
  ipcState.bufferedMessages.push(message)
}

if (!ipcState.installed) {
  process.on("message", forwardOrBufferRuntimeMessage)
  /* v8 ignore next 3 -- child-process disconnect exits the live worker; default worker listener covers this behavior in process-listener tests @preserve */
  process.on("disconnect", () => {
    process.exit(0)
  })
  ipcState.installed = true
}

emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "starting private-runtime process entrypoint",
  meta: { entry: "private-runtime", agentName },
})

async function selectedProviderTargets(agentName: string): Promise<AgentProvider[]> {
  try {
    const [{ readAgentConfigForAgent }, { getAgentBundlesRoot }] = await Promise.all([
      import("./auth/auth-flow"),
      import("./identity"),
    ])
    const { config } = readAgentConfigForAgent(agentName, getAgentBundlesRoot())
    return [...new Set([config.humanFacing.provider, config.agentFacing.provider])]
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.provider_refresh_skipped",
      message: "skipping private-runtime provider credential refresh because agent config could not be read",
      meta: {
        entry: "private-runtime",
        agentName,
        error: error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error agent-config failures @preserve */ String(error),
      },
    })
    return []
  }
}

function providerPoolMissingTargets(
  providerPool: ReturnType<typeof import("./provider-credentials")["readProviderCredentialPool"]>,
  providers: AgentProvider[],
): boolean {
  if (!providerPool.ok) return true
  return providers.some((provider) => !providerPool.pool.providers[provider])
}

// Dynamic import: agent-entry is process-start wiring that starts a sense process.
// Using dynamic import avoids a static heart/ -> senses/ dependency.
import("./runtime-credentials")
  .then(async ({
    readMachineRuntimeCredentialConfig,
    readRuntimeCredentialConfig,
    refreshMachineRuntimeCredentialConfig,
    refreshRuntimeCredentialConfig,
    applyRuntimeCredentialBootstrapMessage,
    waitForRuntimeCredentialBootstrap,
  }) => {
    const { readProviderCredentialPool, refreshProviderCredentialPool } = await import("./provider-credentials")
    const bootstrappedBeforeWait = drainBufferedRuntimeCredentialBootstrap(applyRuntimeCredentialBootstrapMessage)
    const bootstrappedDuringWait = bootstrappedBeforeWait ? true : await waitForRuntimeCredentialBootstrap(agentName)
    if (bootstrappedDuringWait) {
      ipcState.bufferedRuntimeCredentialMessages = ipcState.bufferedRuntimeCredentialMessages.filter(
        (message) => !isRuntimeCredentialBootstrapForAgent(message, agentName),
      )
    } else {
      drainBufferedRuntimeCredentialBootstrap(applyRuntimeCredentialBootstrapMessage)
    }
    if (!readRuntimeCredentialConfig(agentName).ok) {
      await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
    }
    const providerPool = readProviderCredentialPool(agentName)
    const providerTargets = await selectedProviderTargets(agentName)
    if (providerTargets.length > 0 && providerPoolMissingTargets(providerPool, providerTargets)) {
      await refreshProviderCredentialPool(agentName, { preserveCachedOnFailure: true, providers: providerTargets }).catch(() => undefined)
    }
    if (!readMachineRuntimeCredentialConfig(agentName).ok) {
      await import("./machine-identity")
        .then(({ loadOrCreateMachineIdentity }) => {
          const machine = loadOrCreateMachineIdentity()
          return refreshMachineRuntimeCredentialConfig(agentName, machine.machineId, { preserveCachedOnFailure: true })
        })
        .catch(() => undefined)
    }
    const { startPrivateRuntimeWorker } = await import("../senses/private-runtime-worker")
    const worker: PrivateRuntimeWorkerController = await startPrivateRuntimeWorker({
      attachProcessListeners: false,
      bufferedMessages: [],
    })
    const { ensureSanctuarySourceRuntimeReady } = await import("../senses/sanctuary-runtime")
    const readinessPendingDispatchIds = new Set<string>()
    const cancelledReadinessDispatchIds = new Set<string>()
    const handleWorkerMessage = async (message: unknown): Promise<void> => {
      /* v8 ignore next -- sole caller is gated by isPrivateRuntimeWorkMessage, which rejects falsy payloads @preserve */
      const envelope = message && typeof message === "object" ? message as {
        type?: unknown
        dispatchId?: unknown
        externalEvent?: { source?: unknown }
      } : null
      if (envelope?.type === "ouro.privateRuntimeDispatchCancel" && typeof envelope.dispatchId === "string") {
        if (readinessPendingDispatchIds.has(envelope.dispatchId)) cancelledReadinessDispatchIds.add(envelope.dispatchId)
        else worker.cancelMessage(envelope.dispatchId)
        return
      }
      const dispatchId = typeof envelope?.dispatchId === "string" ? envelope.dispatchId : null
      try {
        if (typeof envelope?.externalEvent?.source === "string") {
          if (dispatchId) readinessPendingDispatchIds.add(dispatchId)
          await ensureSanctuarySourceRuntimeReady(agentName, envelope.externalEvent.source)
          if (dispatchId) readinessPendingDispatchIds.delete(dispatchId)
          if (dispatchId && cancelledReadinessDispatchIds.delete(dispatchId)) return
        }
        await worker.handleMessage(message)
        if (dispatchId) process.send?.({ type: "ouro.privateRuntimeDispatchResult", dispatchId, ok: true })
      } catch (error) {
        if (dispatchId) {
          process.send?.({
            type: "ouro.privateRuntimeDispatchResult",
            dispatchId,
            ok: false,
            error: safeDispatchError(error),
          })
          return
        }
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.private_runtime_dispatch_error",
          message: "private-runtime work message failed",
          meta: { agentName, error: error instanceof Error ? error.message : String(error) },
        })
      } finally {
        if (dispatchId) {
          readinessPendingDispatchIds.delete(dispatchId)
          cancelledReadinessDispatchIds.delete(dispatchId)
        }
      }
    }
    ipcState.workerMessageHandler = (message: unknown) => {
      void handleWorkerMessage(message)
    }
    const bufferedMessages = ipcState.bufferedMessages.splice(0)
    for (const message of bufferedMessages) {
      ipcState.workerMessageHandler(message)
    }
  })
  .catch((error) => {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.entry_error",
      message: "private-runtime entrypoint failed",
      meta: { entry: "private-runtime", agentName, error: error instanceof Error ? error.message : String(error) },
    })
    // eslint-disable-next-line no-console -- fatal startup guard for worker process
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
