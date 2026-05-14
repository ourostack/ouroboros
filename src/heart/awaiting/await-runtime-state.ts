import * as path from "path"
import { readJsonFile, writeJsonFile } from "../../arc/json-store"
import { capStructuredRecordString } from "../session-events"
import { emitNervesEvent } from "../../nerves/runtime"
import type { AwaitFile } from "./await-parser"

export interface AwaitRuntimeState {
  last_checked: string | null
  last_observation: string | null
  checked_count: number
}

interface AwaitRuntimeStateRecord {
  schemaVersion: 1
  name: string
  last_checked: string | null
  last_observation: string | null
  checked_count: number
  updatedAt: string
}

function awaitRuntimeStateDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "awaits")
}

export function readAwaitRuntimeState(agentRoot: string, name: string): AwaitRuntimeState | null {
  const record = readJsonFile<Partial<AwaitRuntimeStateRecord>>(awaitRuntimeStateDir(agentRoot), name)
  if (!record) return null
  return {
    last_checked: typeof record.last_checked === "string" ? record.last_checked : null,
    last_observation: typeof record.last_observation === "string" ? record.last_observation : null,
    checked_count: typeof record.checked_count === "number" ? record.checked_count : 0,
  }
}

export function applyAwaitRuntimeState(agentRoot: string, awaitFile: AwaitFile): AwaitFile {
  const state = readAwaitRuntimeState(agentRoot, awaitFile.name)
  if (state === null) return awaitFile
  return {
    ...awaitFile,
    // Cast: runtime fields are merged onto the file for prompt/commitments consumers
    ...(state as unknown as Partial<AwaitFile>),
  }
}

export function writeAwaitRuntimeState(
  agentRoot: string,
  name: string,
  partial: Partial<AwaitRuntimeState>,
): void {
  const existing = readAwaitRuntimeState(agentRoot, name)
  const merged: AwaitRuntimeState = {
    last_checked: partial.last_checked ?? existing?.last_checked ?? null,
    last_observation: partial.last_observation != null
      ? capStructuredRecordString(partial.last_observation)
      : existing?.last_observation ?? null,
    checked_count: partial.checked_count ?? existing?.checked_count ?? 0,
  }

  const record: AwaitRuntimeStateRecord = {
    schemaVersion: 1,
    name,
    last_checked: merged.last_checked,
    last_observation: merged.last_observation,
    checked_count: merged.checked_count,
    updatedAt: new Date().toISOString(),
  }
  writeJsonFile(awaitRuntimeStateDir(agentRoot), name, record)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.await_runtime_state_write",
    message: "wrote await runtime state",
    meta: { agentRoot, name, last_checked: merged.last_checked, checked_count: merged.checked_count },
  })
}

export function recordAwaitCheck(
  agentRoot: string,
  name: string,
  observation: string,
  now: string,
): void {
  const existing = readAwaitRuntimeState(agentRoot, name)
  const nextCount = (existing?.checked_count ?? 0) + 1
  writeAwaitRuntimeState(agentRoot, name, {
    last_checked: now,
    last_observation: observation,
    checked_count: nextCount,
  })
}
