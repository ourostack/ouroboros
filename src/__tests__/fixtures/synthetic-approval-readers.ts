import * as fs from "node:fs"

import { expect } from "vitest"

import { openApprovalStore, type ApprovalRecord } from "../../heart/approval-store"
import { parseSessionEnvelope, projectProviderMessages } from "../../heart/session-events"
import type { SyntheticApprovalArtifacts } from "./synthetic-approval-harness"

// Shared by the synthetic approval e2e files, which are split so no single file
// holds a coverage shard for minutes.
export const DOCKER_RESTART = "docker restart calibre-web"
const roots: string[] = []

export type TraceEntry = { sequence: number; pid: number; atMs: number; type: string; detail?: string }
export type ProviderEntry = {
  pid: number
  kind: "origin" | "continuation"
  invokedBy: "runAgent" | "resumeApprovalContinuation"
  approvalId: string | null
  messages: any[]
}
export type DeliveryEntry = { pid: number; kind: "provider" | "direct" | "indeterminate"; text: string }

export function remember(artifacts: SyntheticApprovalArtifacts): SyntheticApprovalArtifacts {
  roots.push(artifacts.root)
  return artifacts
}

export function removeRememberedRoots(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
}

export function readNdjson<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return []
  const text = fs.readFileSync(filePath, "utf8").trim()
  return text ? text.split("\n").map((line) => JSON.parse(line) as T) : []
}

export function readJournal(artifacts: SyntheticApprovalArtifacts): ApprovalRecord | null {
  if (!artifacts.approvalId || !fs.existsSync(artifacts.approvalDatabasePath)) return null
  const store = openApprovalStore({ databasePath: artifacts.approvalDatabasePath })
  try { return store.read(artifacts.approvalId) } finally { store.close() }
}

export function readProviderMessages(artifacts: SyntheticApprovalArtifacts) {
  const raw = JSON.parse(fs.readFileSync(artifacts.sessionPath, "utf8"))
  const envelope = parseSessionEnvelope(raw)
  expect(envelope).not.toBeNull()
  return projectProviderMessages(envelope!)
}

export function countTerminalPairs(messages: any[]): number {
  let pairs = 0
  for (let index = 0; index < messages.length - 1; index++) {
    if (messages[index]?.role === "assistant" && messages[index]?.tool_calls?.[0]?.id === "call_restart"
      && messages[index + 1]?.role === "tool" && messages[index + 1]?.tool_call_id === "call_restart") pairs++
  }
  return pairs
}
