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
  if (!wrapperPackageChanged(input.changedFiles)) {
    return {
      ok: true,
      message: "wrapper package unchanged",
    }
  }

  if (input.publishedVersion === input.localVersion) {
    return {
      ok: false,
      message: `ouro.bot wrapper changed but ouro.bot@${input.localVersion} is already published; bump packages/ouro.bot/package.json before merging`,
    }
  }

  return {
    ok: true,
    message: "wrapper package changed and local wrapper version is unpublished",
  }
}
