// Unified agent runtime entrypoint.
// Requires --agent before importing runtime modules that rely on identity.
const agentArgIndex = process.argv.indexOf("--agent")
const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
if (!agentName) {
  // eslint-disable-next-line no-console -- pre-boot guard
  console.error("Missing required --agent <name> argument.\nUsage: node dist/heart/agent-entry.js --agent ouroboros")
  process.exit(1)
}

import { configureCliRuntimeLogger } from "../nerves/cli-logging"
import { emitNervesEvent } from "../nerves/runtime"
import type { PrivateRuntimeWorkerController } from "../senses/private-runtime-worker"

configureCliRuntimeLogger("self")

interface AgentEntryIpcState {
  bufferedMessages: unknown[]
  installed: boolean
  workerMessageHandler: ((message: unknown) => void) | null
}

const ipcStateKey = Symbol.for("ouro.agentEntry.ipcState")
const ipcState = ((globalThis as unknown as Record<symbol, AgentEntryIpcState>)[ipcStateKey] ??= {
  bufferedMessages: [],
  installed: false,
  workerMessageHandler: null,
})

ipcState.bufferedMessages = []
ipcState.workerMessageHandler = null

function isRuntimeCredentialBootstrapMessage(message: unknown): boolean {
  return !!message
    && typeof message === "object"
    && !Array.isArray(message)
    && (message as { type?: unknown }).type === "ouro.runtimeCredentialBootstrap"
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
}

function forwardOrBufferRuntimeMessage(message: unknown): void {
  if (isRuntimeCredentialBootstrapMessage(message)) return
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

// Dynamic import: agent-entry is process-start wiring that starts a sense process.
// Using dynamic import avoids a static heart/ -> senses/ dependency.
import("./runtime-credentials")
  .then(async ({
    readMachineRuntimeCredentialConfig,
    readRuntimeCredentialConfig,
    refreshMachineRuntimeCredentialConfig,
    refreshRuntimeCredentialConfig,
    waitForRuntimeCredentialBootstrap,
  }) => {
    await waitForRuntimeCredentialBootstrap(agentName)
    if (!readRuntimeCredentialConfig(agentName).ok) {
      void refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true }).catch(() => undefined)
    }
    /* v8 ignore next 7 -- process-start best-effort machine credential refresh runs in a child entrypoint and is covered operationally by daemon startup tests @preserve */
    if (!readMachineRuntimeCredentialConfig(agentName).ok) {
      void import("./machine-identity")
        .then(({ loadOrCreateMachineIdentity }) => {
          const machine = loadOrCreateMachineIdentity()
          return refreshMachineRuntimeCredentialConfig(agentName, machine.machineId, { preserveCachedOnFailure: true })
        })
        .catch(() => undefined)
    }
    const { startPrivateRuntimeWorker } = await import("../senses/private-runtime-worker")
    const bufferedMessages = ipcState.bufferedMessages.splice(0)
    const worker: PrivateRuntimeWorkerController = await startPrivateRuntimeWorker({
      attachProcessListeners: false,
      bufferedMessages,
    })
    ipcState.workerMessageHandler = (message: unknown) => {
      void worker.handleMessage(message)
    }
    const messagesBufferedDuringStart = ipcState.bufferedMessages.splice(0)
    for (const message of messagesBufferedDuringStart) {
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
