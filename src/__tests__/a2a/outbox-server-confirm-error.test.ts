import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"

const confirm = vi.hoisted(() => ({ calls: 0 }))
vi.mock("../../heart/failure-reports", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/failure-reports")>(),
  confirmResolvedReports: async () => { confirm.calls += 1; throw new Error("reports unreadable") },
}))

let tmp: TmpBundleHandle | null = null
let server: A2AServerHandle | null = null
afterEach(async () => { if (server) await server.close(); server = null; tmp?.cleanup(); tmp = null })

describe("the fix-confirmation pass", () => {
  it("logs a failing pass and keeps the server serving", async () => {
    tmp = createTmpBundle({ agentName: `confirm-error-${Date.now()}` })
    server = await startA2AServer({
      agentName: tmp.agentName, agentRoot: path.join(tmp.agentRoot), port: 0,
      escalation: { runningVersion: "0.1.0-alpha.1", confirmIntervalMs: 10, notifyOwner: async () => undefined },
      turnRunner: async () => ({ response: "ok" }),
    })
    await vi.waitFor(() => expect(confirm.calls).toBeGreaterThanOrEqual(2), { timeout: 2000 })
    expect((await fetch(new URL("/.well-known/agent-card.json", server.url))).status).toBe(200)
  })
})
