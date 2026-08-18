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
})
