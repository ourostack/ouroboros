import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

import { FileApprovalCheckpointStore, FileApprovalTokenStore } from "../../heart/approval-files"

describe("durable approval files", () => {
  it("round-trips checkpoints and tokens without mixing token material into checkpoints", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-files-"))
    const checkpoints = new FileApprovalCheckpointStore(path.join(root, "checkpoints.json"))
    const tokens = new FileApprovalTokenStore(path.join(root, "tokens.json"))
    const draft = {
      approvalId: "approval-1", baseSessionRevision: "a".repeat(64), argumentDigest: "b".repeat(64),
      schemaDigest: "c".repeat(64), toolDigest: "d".repeat(64), policyDigest: "e".repeat(64),
      preCallDigest: "f".repeat(64), preCallMessages: [{ role: "user" as const, content: "restart it" }],
      frozenAssistantMessage: { role: "assistant", content: null },
    }
    const attestation = checkpoints.write(draft)
    tokens.put("approval-1", "decision-secret")

    expect(attestation.suspendedSessionRevision).toBe(draft.baseSessionRevision)
    expect(checkpoints.read("approval-1")).toEqual(expect.objectContaining({ approvalId: "approval-1", checkpointDigest: attestation.checkpointDigest }))
    expect(tokens.get("approval-1")).toBe("decision-secret")
    expect(fs.readFileSync(path.join(root, "checkpoints.json"), "utf8")).not.toContain("decision-secret")
    expect(fs.statSync(path.join(root, "tokens.json")).mode & 0o777).toBe(0o600)
  })

  it("lists and removes checkpoints and tokens while preserving missing-value semantics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-files-lifecycle-"))
    const checkpoints = new FileApprovalCheckpointStore(path.join(root, "checkpoints.json"))
    const tokens = new FileApprovalTokenStore(path.join(root, "tokens.json"))
    const draft = {
      approvalId: "approval-lifecycle", baseSessionRevision: "a".repeat(64), argumentDigest: "b".repeat(64),
      schemaDigest: "c".repeat(64), toolDigest: "d".repeat(64), policyDigest: "e".repeat(64),
      preCallDigest: "f".repeat(64), preCallMessages: [{ role: "user" as const, content: "restart it" }],
      frozenAssistantMessage: { role: "assistant" as const, content: null },
    }

    expect(checkpoints.read("missing")).toBeNull()
    expect(checkpoints.list()).toEqual([])
    expect(tokens.has("missing")).toBe(false)
    expect(tokens.get("missing")).toBeNull()

    checkpoints.write(draft)
    tokens.put(draft.approvalId, "token")
    expect(checkpoints.list()).toEqual([expect.objectContaining({ approvalId: draft.approvalId })])
    expect(tokens.has(draft.approvalId)).toBe(true)

    checkpoints.remove(draft.approvalId)
    tokens.remove(draft.approvalId)
    expect(checkpoints.list()).toEqual([])
    expect(tokens.has(draft.approvalId)).toBe(false)
  })

  it.each([
    ["invalid JSON", "{broken"],
    ["array state", "[]"],
    ["null state", "null"],
  ])("fails closed for corrupt %s", (_label, contents) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-files-corrupt-"))
    const statePath = path.join(root, "tokens.json")
    fs.writeFileSync(statePath, contents, "utf8")
    const tokens = new FileApprovalTokenStore(statePath)

    expect(() => tokens.get("approval-1")).toThrow("approval state is corrupt: tokens.json")
  })
})
