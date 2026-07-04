import * as fs from "node:fs"
import * as crypto from "node:crypto"
import * as path from "node:path"
import { getAgentBundlesRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { PrivateTurnDecision, PrivateTurnPolicyDeps } from "./types"

const DEFAULT_LEDGER_DIR = "private-runtime"
const DEFAULT_LEDGER_FILE = "decisions.jsonl"

function emitDecisionRecorded(
  deps: PrivateTurnPolicyDeps | undefined,
  input: { level: "info" | "warn"; decision: PrivateTurnDecision },
): void {
  const payload = {
    level: input.level,
    component: "private-runtime",
    event: "private_runtime.decision_recorded",
    message: "private-runtime decision recorded",
    meta: {
      agent: input.decision.agent,
      origin: input.decision.origin,
      result: input.decision.result,
      idempotencyKey: input.decision.idempotencyKey,
      requestFingerprint: input.decision.requestFingerprint,
    },
  } as const
  if (deps?.emitNervesEvent) {
    deps.emitNervesEvent(payload)
    return
  }
  emitNervesEvent({
    level: input.level,
    component: "private-runtime",
    event: "private_runtime.decision_recorded",
    message: "private-runtime decision recorded",
    meta: payload.meta,
  })
}

function emitDecisionRecordFailed(
  deps: PrivateTurnPolicyDeps | undefined,
  input: { decision: PrivateTurnDecision },
): void {
  const payload = {
    level: "error",
    component: "private-runtime",
    event: "private_runtime.decision_record_failed",
    message: "private-runtime decision ledger write failed",
    meta: {
      agent: input.decision.agent,
      origin: input.decision.origin,
      idempotencyKey: input.decision.idempotencyKey,
      requestFingerprint: input.decision.requestFingerprint,
      error: input.decision.error,
    },
  } as const
  if (deps?.emitNervesEvent) {
    deps.emitNervesEvent(payload)
    return
  }
  emitNervesEvent({
    level: "error",
    component: "private-runtime",
    event: "private_runtime.decision_record_failed",
    message: "private-runtime decision ledger write failed",
    meta: payload.meta,
  })
}

export function privateTurnLedgerPath(agent: string, deps: PrivateTurnPolicyDeps = {}): string {
  if (deps.ledgerPath) return deps.ledgerPath
  return path.join(deps.bundlesRoot ?? getAgentBundlesRoot(), `${agent}.ouro`, "state", DEFAULT_LEDGER_DIR, DEFAULT_LEDGER_FILE)
}

function readRows(ledgerPath: string): PrivateTurnDecision[] {
  if (!fs.existsSync(ledgerPath)) return []
  const raw = fs.readFileSync(ledgerPath, "utf-8").trim()
  if (!raw) return []
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as PrivateTurnDecision)
}

function writeRow(ledgerPath: string, row: PrivateTurnDecision): PrivateTurnDecision {
  const rowWithLocator = {
    ...row,
    ledgerLocator: {
      path: ledgerPath,
      line: readRows(ledgerPath).length + 1,
    },
  }
  fs.appendFileSync(ledgerPath, `${JSON.stringify(rowWithLocator)}\n`, "utf-8")
  return rowWithLocator
}

function receiptIdFor(input: { idempotencyKey: string; requestFingerprint: string; result: string }): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${input.idempotencyKey}\n${input.requestFingerprint}\n${input.result}`)
    .digest("hex")
  return `ptrr_${hash}`
}

function mismatchDecision(candidate: PrivateTurnDecision, existing: PrivateTurnDecision): PrivateTurnDecision {
  return {
    ...candidate,
    receiptId: receiptIdFor({
      idempotencyKey: candidate.idempotencyKey,
      requestFingerprint: candidate.requestFingerprint,
      result: "mismatch",
    }),
    result: "deny",
    executable: false,
    deniedReason: "idempotency-key fingerprint mismatch",
    duplicateOf: existing.receiptId,
  }
}

function duplicateDecision(existing: PrivateTurnDecision): PrivateTurnDecision {
  return {
    ...existing,
    executable: false,
    deniedReason: "duplicate private-turn decision already recorded",
    duplicateOf: existing.receiptId,
  }
}

function ledgerWriteFailedDecision(
  candidate: PrivateTurnDecision,
  ledgerPath: string,
  error: unknown,
): PrivateTurnDecision {
  return {
    ...candidate,
    receiptId: receiptIdFor({
      idempotencyKey: candidate.idempotencyKey,
      requestFingerprint: candidate.requestFingerprint,
      result: "ledger-write-failed",
    }),
    result: "deny",
    executable: false,
    deniedReason: "ledger write failed",
    ledgerLocator: { path: ledgerPath },
    error: String(error),
  }
}

export function readPrivateTurnLedger(ledgerPath: string): PrivateTurnDecision[] {
  return readRows(ledgerPath)
}

export function recordPrivateTurnDecision(
  decision: PrivateTurnDecision,
  deps: PrivateTurnPolicyDeps = {},
): PrivateTurnDecision {
  const ledgerPath = privateTurnLedgerPath(decision.agent, deps)
  if (!deps.ledgerPath) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
  }
  const candidate: PrivateTurnDecision = {
    ...decision,
    receiptId: decision.receiptId || receiptIdFor(decision),
    ledgerLocator: { path: ledgerPath },
  }

  try {
    const matchingRows = readRows(ledgerPath).filter((row) => row.idempotencyKey === candidate.idempotencyKey)
    const anchor = matchingRows[0]
    if (anchor) {
      if (anchor.requestFingerprint !== candidate.requestFingerprint) {
        const mismatch = mismatchDecision(candidate, anchor)
        const writtenMismatch = writeRow(ledgerPath, mismatch)
        emitDecisionRecorded(deps, { level: "warn", decision: writtenMismatch })
        return writtenMismatch
      }

      const priorExecutable = matchingRows.find((row) => row.requestFingerprint === candidate.requestFingerprint && row.executable)
      if (priorExecutable && candidate.executable) {
        return duplicateDecision(priorExecutable)
      }

      const latestSameFingerprint = [...matchingRows].reverse().find((row) => row.requestFingerprint === candidate.requestFingerprint)
      if (
        latestSameFingerprint
        && latestSameFingerprint.result === candidate.result
        && latestSameFingerprint.executable === candidate.executable
        && latestSameFingerprint.deniedReason === candidate.deniedReason
      ) {
        return latestSameFingerprint
      }

      if (priorExecutable && !candidate.executable) {
        const written = writeRow(ledgerPath, candidate)
        emitDecisionRecorded(deps, { level: written.result === "allow" ? "info" : "warn", decision: written })
        return written
      }

      const written = writeRow(ledgerPath, candidate)
      emitDecisionRecorded(deps, { level: written.result === "allow" ? "info" : "warn", decision: written })
      return written
    }

    const written = writeRow(ledgerPath, candidate)
    emitDecisionRecorded(deps, { level: written.result === "allow" ? "info" : "warn", decision: written })
    return written
  } catch (error) {
    const failed = ledgerWriteFailedDecision(candidate, ledgerPath, error)
    emitDecisionRecordFailed(deps, { decision: failed })
    return failed
  }
}
