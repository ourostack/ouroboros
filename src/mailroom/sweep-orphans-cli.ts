import { refreshRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import type { EncryptedRawSweepResult } from "./blob-store"
import { resolveMailroomReader } from "./reader"

export async function runHostedRawSweep(agentName: string, live: boolean): Promise<string> {
  const freshRuntime = await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: false })
  if (!freshRuntime.ok) {
    throw new Error(`mail raw sweep for ${agentName} requires fresh ${freshRuntime.itemPath}: ${freshRuntime.error}`)
  }
  const reader = resolveMailroomReader(agentName)
  if (!reader.ok) throw new Error(reader.error)
  const store = reader.store as { sweepOrphanedEncryptedRaw?: (options: { dryRun: boolean }) => Promise<EncryptedRawSweepResult> }
  if (reader.storeKind !== "azure-blob" || typeof store.sweepOrphanedEncryptedRaw !== "function") {
    throw new Error(`mail raw sweep for ${agentName} requires hosted Azure Mailroom; resolved ${reader.storeKind}`)
  }
  const result = await store.sweepOrphanedEncryptedRaw({ dryRun: !live })
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_raw_sweep_cli_completed",
    message: "hosted mail raw orphan sweep completed",
    meta: { agentName, ...result },
  })
  return [
    `${live ? "swept" : "dry run (nothing deleted; rerun with --live to delete)"}: encrypted raw mail for ${agentName}`,
    `encrypted raw objects scanned: ${result.scanned}`,
    `kept, still referenced: ${result.referenced}`,
    `orphans found: ${result.orphaned}`,
    `kept, younger than the 24h grace: ${result.skippedYoung}`,
    `${live ? "deleted" : "would delete"}: ${live ? result.deleted : result.deletable}`,
  ].join("\n")
}
