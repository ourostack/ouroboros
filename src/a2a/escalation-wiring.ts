import * as fs from "node:fs"
import * as path from "node:path"
import type { ConfirmDeps } from "../heart/failure-reports"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentRoot } from "../heart/identity"
import { productDelegationNotifier, productFor } from "../heart/product/active"
import { A2A_PRINCIPAL_PROFILE_ID, type A2ADelegationOptions } from "./delegated-command"

/**
 * The version of the harness that is running, read from its own package.json once when this module loads. A fix is
 * "live" only when this process carries it, so the value must not follow whatever an upgrade later writes to disk.
 */
export const RUNNING_HARNESS_VERSION: string = (JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { version: string }).version

/**
 * What every A2A server entry point passes as `escalation`: confirm-when-live notices go to the owner through the same
 * owner-notice path as delegated commands. Only an agent whose product files and confirms failure reports gets it.
 */
export function escalationOptionsFor(agentName: string, sendOwnerNotice: (input: { noticeId: string; text: string }) => Promise<void>): { escalation?: ConfirmDeps } {
  if (productFor(agentName)?.a2a?.escalation !== true) return {}
  emitNervesEvent({ component: "senses", event: "senses.a2a_escalation_wired", message: "A2A server will confirm resolved failure reports to the owner", meta: { agentName, runningVersion: RUNNING_HARNESS_VERSION } })
  return { escalation: { runningVersion: RUNNING_HARNESS_VERSION, notifyOwner: sendOwnerNotice } }
}

/**
 * What the A2A server entry passes as `delegation`: an agent whose product accepts delegated commands takes them from
 * granted peers on its owner's menu, and the product announces each one before it runs.
 */
export function delegationOptionsFor(agentName: string): { delegation?: A2ADelegationOptions } {
  const notifyPrincipal = productDelegationNotifier(agentName)
  if (!notifyPrincipal) return {}
  emitNervesEvent({ component: "senses", event: "senses.a2a_delegation_wired", message: "A2A server will accept delegated commands from granted peers", meta: { agentName } })
  return {
    delegation: {
      principalProfileId: A2A_PRINCIPAL_PROFILE_ID,
      agentRoot: getAgentRoot(agentName),
      notifyPrincipal,
    },
  }
}

export async function sendOwnerNoticeViaTelegram(agentName: string, notice: { noticeId: string; text: string }): Promise<void> {
  const { sendTelegramOwnerNotice } = await import("../senses/telegram")
  await sendTelegramOwnerNotice(agentName, { ...notice, signal: AbortSignal.timeout(30_000) })
}
