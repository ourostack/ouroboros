import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { recordOutboundInSession } from "../../mind/outbound-record"
import { resolveSessionPath } from "../../heart/config"

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-replay-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const record = (deliveryId: string) => recordOutboundInSession({
  agentRoot: root, friendId: "ari", channel: "teams", key: "chat-1", content: "build is out", origin: "proactive", deliveryId, originLabel: "a proactive message",
})
const copies = () => (fs.readFileSync(resolveSessionPath("ari", "teams", "chat-1", { agentRoot: root, confined: true }), "utf-8").match(/\[you sent this via a proactive message\] build is out/g) ?? []).length

describe("a replayed proactive send in the Teams session history", () => {
  it("is recorded once per delivery id over two replays, and once per send when ids are random", () => {
    expect(record("pending:abc")).toBe("recorded")
    expect(record("pending:abc")).toBe("recorded")
    expect(record("pending:abc")).toBe("recorded")
    expect(copies()).toBe(1)
    // The old random ids: each replay becomes one more copy the model reads every turn.
    record("proactive:one")
    record("proactive:two")
    expect(copies()).toBe(3)
  })
})
