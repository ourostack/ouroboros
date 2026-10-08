import * as fs from "node:fs"
import * as path from "node:path"
import type { ConfirmDeps } from "../heart/failure-reports"

/**
 * The version of the harness that is running, read from its own package.json once when this module loads. A fix is
 * "live" only when this process carries it, so the value must not follow whatever an upgrade later writes to disk.
 */
export const RUNNING_HARNESS_VERSION: string = (JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { version: string }).version

/**
 * What every A2A server entry point passes as `escalation`: confirm-when-live notices go to the owner through the same
 * owner-notice path as delegated commands. Only the Butler files and confirms failure reports.
 */
export function escalationOptionsFor(agentName: string, sendOwnerNotice: (input: { noticeId: string; text: string }) => Promise<void>): { escalation?: ConfirmDeps } {
  if (agentName !== "sanctuary") return {}
  return { escalation: { runningVersion: RUNNING_HARNESS_VERSION, notifyOwner: sendOwnerNotice } }
}

export async function sendOwnerNoticeViaTelegram(agentName: string, notice: { noticeId: string; text: string }): Promise<void> {
  const { sendTelegramOwnerNotice } = await import("../senses/telegram")
  await sendTelegramOwnerNotice(agentName, { ...notice, signal: AbortSignal.timeout(30_000) })
}
