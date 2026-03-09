import { emitNervesEvent } from "../../nerves/runtime"

export interface WrapperPublishSyncInput {
  changedFiles: string[]
  localVersion: string
  publishedVersion: string
}

export interface WrapperPublishSyncResult {
  ok: boolean
  message: string
}

function wrapperPackageChanged(changedFiles: string[]): boolean {
  return changedFiles.some((file) => file.startsWith("packages/ouro.bot/"))
}

export function assessWrapperPublishSync(input: WrapperPublishSyncInput): WrapperPublishSyncResult {
  let result: WrapperPublishSyncResult

  if (!wrapperPackageChanged(input.changedFiles)) {
    result = {
      ok: true,
      message: "wrapper package unchanged",
    }
    emitNervesEvent({
      component: "daemon",
      event: "daemon.wrapper_publish_guard_checked",
      message: "evaluated wrapper publish sync",
      meta: { changed: false, localVersion: input.localVersion, publishedVersion: input.publishedVersion, ok: result.ok },
    })
    return result
  }

  if (input.publishedVersion === input.localVersion) {
    result = {
      ok: false,
      message: `ouro.bot wrapper changed but ouro.bot@${input.localVersion} is already published; bump packages/ouro.bot/package.json before merging`,
    }
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.wrapper_publish_guard_checked",
      message: "evaluated wrapper publish sync",
      meta: { changed: true, localVersion: input.localVersion, publishedVersion: input.publishedVersion, ok: result.ok },
    })
    return result
  }

  result = {
    ok: true,
    message: "wrapper package changed and local wrapper version is unpublished",
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.wrapper_publish_guard_checked",
    message: "evaluated wrapper publish sync",
    meta: { changed: true, localVersion: input.localVersion, publishedVersion: input.publishedVersion, ok: result.ok },
  })
  return result
}
