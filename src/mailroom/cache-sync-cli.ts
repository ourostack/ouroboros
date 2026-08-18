import { refreshRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"
import { syncHostedMailSearchCache } from "./hosted-cache-sync"
import { resolveHostedMailAuthority, resolveMailroomReader } from "./reader"

export async function runHostedMailCacheSync(agentName: string): Promise<string> {
  const freshRuntime = await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: false })
  if (!freshRuntime.ok) {
    throw new Error(`mail cache sync for ${agentName} requires fresh ${freshRuntime.itemPath}: ${freshRuntime.error}`)
  }

  const reader = resolveMailroomReader(agentName)
  if (!reader.ok) throw new Error(reader.error)
  if (reader.storeKind !== "azure-blob") {
    throw new Error(`mail cache sync for ${agentName} requires hosted Azure Mailroom; resolved ${reader.storeKind}`)
  }
  const authority = resolveHostedMailAuthority(agentName)
  if (!authority.ok) throw new Error(authority.error)

  const result = await syncHostedMailSearchCache({
    agentId: agentName,
    mode: "full-convergence",
    authority: authority.authority,
    store: reader.store,
    privateKeys: reader.config.privateKeys,
    storeKind: reader.storeKind,
    cacheOptions: reader.store.mailSearchCacheOptions?.(),
  })
  const text = [
    `hosted mail cache converged for ${agentName}.`,
    `visible authoritative messages: ${result.coverage.visibleMessageCount}`,
    `decryptable cached messages: ${result.coverage.decryptableMessageCount}`,
    `fetched this run: ${result.fetched}`,
    `already current: ${result.alreadyCached}`,
    `removed stale local files: ${result.removed}`,
    `skipped unavailable messages: ${result.skipped}`,
    `indexed at: ${result.coverage.indexedAt}`,
  ].join("\n")
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_cache_sync_cli_completed",
    message: "foreground hosted mail cache sync completed",
    meta: {
      agentName,
      visible: result.coverage.visibleMessageCount,
      cached: result.coverage.decryptableMessageCount,
      removed: result.removed,
      skipped: result.skipped,
    },
  })
  return text
}
