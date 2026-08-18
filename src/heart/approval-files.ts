import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import {
  digestApprovalSuspensionCheckpointPayload,
  type ApprovalSuspensionCheckpoint,
  type ApprovalSuspensionCheckpointDraft,
  type ApprovalSuspensionCheckpointStore,
  type ApprovalTokenStore,
} from "./tool-approval"
import { emitNervesEvent } from "../nerves/runtime"

function readObject<T>(filePath: string): Record<string, T> {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state is not an object")
    return value as Record<string, T>
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {}
    throw new Error(`approval state is corrupt: ${path.basename(filePath)}`, { cause: error })
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
  fs.chmodSync(filePath, 0o600)
}

export class FileApprovalCheckpointStore implements ApprovalSuspensionCheckpointStore {
  constructor(private readonly filePath: string) {}

  write(draft: ApprovalSuspensionCheckpointDraft) {
    const checkpoint: ApprovalSuspensionCheckpoint = {
      ...structuredClone(draft),
      checkpointDigest: digestApprovalSuspensionCheckpointPayload(draft),
      suspendedSessionRevision: draft.baseSessionRevision,
    }
    const records = readObject<ApprovalSuspensionCheckpoint>(this.filePath)
    records[checkpoint.approvalId] = checkpoint
    atomicWrite(this.filePath, records)
    emitNervesEvent({ component: "engine", event: "engine.approval_checkpoint_written", message: "approval checkpoint written", meta: { approvalId: checkpoint.approvalId } })
    return { checkpointDigest: checkpoint.checkpointDigest, suspendedSessionRevision: checkpoint.suspendedSessionRevision }
  }

  read(approvalId: string) { return structuredClone(readObject<ApprovalSuspensionCheckpoint>(this.filePath)[approvalId] ?? null) }
  list() { return Object.values(readObject<ApprovalSuspensionCheckpoint>(this.filePath)).map((record) => structuredClone(record)) }
  remove(approvalId: string) {
    const records = readObject<ApprovalSuspensionCheckpoint>(this.filePath)
    delete records[approvalId]
    atomicWrite(this.filePath, records)
  }
}

export class FileApprovalTokenStore implements ApprovalTokenStore {
  constructor(private readonly filePath: string) {}
  put(approvalId: string, token: string) { const records = readObject<string>(this.filePath); records[approvalId] = token; atomicWrite(this.filePath, records) }
  has(approvalId: string) { return approvalId in readObject<string>(this.filePath) }
  get(approvalId: string) { return readObject<string>(this.filePath)[approvalId] ?? null }
  remove(approvalId: string) { const records = readObject<string>(this.filePath); delete records[approvalId]; atomicWrite(this.filePath, records) }
}
