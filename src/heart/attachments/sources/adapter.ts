/* v8 ignore file -- type-only attachment adapter contract @preserve */
import type { AttachmentRecord, AttachmentSourceKind, MaterializedAttachment } from "../types"

export interface AttachmentSourceAdapter {
  source: AttachmentSourceKind
  materializeOriginal(args: {
    agentName: string
    attachment: AttachmentRecord
    agentRoot: string
  }): Promise<MaterializedAttachment>
}
