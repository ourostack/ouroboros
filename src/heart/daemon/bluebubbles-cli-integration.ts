import { emitNervesEvent } from "../../nerves/runtime"
import {
  reconcileBlueBubblesWebhookRegistration,
  type BlueBubblesWebhookRegistrationInput,
  type BlueBubblesWebhookRegistrationResult,
} from "../../senses/bluebubbles/webhook-registration"
import type { BlueBubblesHostActionResult } from "./bluebubbles-host"

export function blueBubblesListenerReadyAfterApply(daemonApply: string): boolean {
  return daemonApply.startsWith("restarted Ouro;")
}

export function formatBlueBubblesWebhookConnectLine(result: BlueBubblesWebhookRegistrationResult): string {
  return result.ok
    ? `webhook: ${result.detail}`
    : `webhook saved-but-incomplete: ${result.detail}`
}

export function formatBlueBubblesHostActionText(outcome: BlueBubblesHostActionResult): string {
  const httpStatus = outcome.state.http.ok === true
    ? "healthy"
    : outcome.state.http.ok === false
      ? "unhealthy"
      : "not checked"
  return [
    `BlueBubbles host ${outcome.action}`,
    "actor: agent-runnable",
    `app: ${outcome.state.app}`,
    `plist: ${outcome.state.plist} (${outcome.state.plistPath})`,
    `service: ${outcome.state.service}${outcome.state.serviceDetail ? ` (${outcome.state.serviceDetail})` : ""}`,
    `process: ${outcome.state.process}`,
    `HTTP: ${httpStatus} (${outcome.state.http.detail})`,
    "repair: ouro bluebubbles host repair",
  ].join("\n")
}

export async function reconcileBlueBubblesWebhookAfterConnect(
  input: BlueBubblesWebhookRegistrationInput,
  deps: {
    reconcile?: (input: BlueBubblesWebhookRegistrationInput) => Promise<BlueBubblesWebhookRegistrationResult>
    fetchImpl?: typeof fetch
  } = {},
): Promise<BlueBubblesWebhookRegistrationResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bluebubbles_connect_webhook_start",
    message: "verifying BlueBubbles webhook after connect",
    meta: { agent: input.agentName, listenerReady: input.listenerReady },
  })
  try {
    const result = deps.reconcile
      ? await deps.reconcile(input)
      : await reconcileBlueBubblesWebhookRegistration(input, { fetchImpl: deps.fetchImpl ?? fetch })
    emitNervesEvent({
      component: "daemon",
      event: "daemon.bluebubbles_connect_webhook_end",
      level: result.ok ? "info" : "warn",
      message: "verified BlueBubbles webhook after connect",
      meta: { agent: input.agentName, state: result.state, ok: result.ok },
    })
    return result
  } catch {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.bluebubbles_connect_webhook_error",
      level: "error",
      message: "BlueBubbles webhook verification failed before returning diagnostics",
      meta: { agent: input.agentName, listenerReady: input.listenerReady },
    })
    return {
      ok: false,
      state: "api-unreachable",
      changed: false,
      ownedCount: 0,
      exactCount: 0,
      detail: "webhook verification failed before BlueBubbles returned a diagnostic result",
    }
  }
}
