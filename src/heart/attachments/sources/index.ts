import type { AttachmentSourceKind } from "../types"
import type { AttachmentSourceAdapter } from "./adapter"
import { blueBubblesAttachmentSourceAdapter } from "./bluebubbles"
import { cliLocalFileAttachmentSourceAdapter } from "./cli-local-file"

const ATTACHMENT_SOURCE_ADAPTERS: Record<AttachmentSourceKind, AttachmentSourceAdapter> = {
  bluebubbles: blueBubblesAttachmentSourceAdapter,
  "cli-local-file": cliLocalFileAttachmentSourceAdapter,
}

export { type AttachmentSourceAdapter } from "./adapter"

export function getAttachmentSourceAdapter(source: AttachmentSourceKind): AttachmentSourceAdapter {
  const adapter = ATTACHMENT_SOURCE_ADAPTERS[source]
  if (!adapter) {
    throw new Error(`No attachment source adapter registered for source: ${source}`)
  }
  return adapter
}
