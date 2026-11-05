import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { admitSessionActivity, deleteSessionTransaction, withSessionTurnLease } from "../../mind/session-transaction"

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }))
afterEach(() => { vi.restoreAllMocks() })

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const input = { namespace: "synthetic-bot/tenant/conversation/actor", activityId: "activity-1", payloadDigest: digest("request") }
function session(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-admission-"))
  const file = path.join(directory, "session.json")
  fs.writeFileSync(file, JSON.stringify({ version: 2, marker: "untouched" }))
  return file
}

describe("durable session activity admission", () => {
  it("admits an activity once without storing raw identities or payloads", () => {
    const file = session()
    expect(admitSessionActivity(file, input)).toMatchObject({ state: "admitted", receiptId: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(admitSessionActivity(file, input)).toMatchObject({ state: "duplicate" })
    const bytes = fs.readFileSync(`${file}.turn.lock`).toString()
    expect(bytes).not.toContain(input.namespace)
    expect(bytes).not.toContain(input.activityId)
    expect(fs.readFileSync(file, "utf8")).toBe('{"version":2,"marker":"untouched"}')
  })

  it("keeps distinct namespaces and activities separate, and refuses conflicting reuse", () => {
    const file = session()
    admitSessionActivity(file, input)
    expect(admitSessionActivity(file, { ...input, namespace: "other-bot" }).state).toBe("admitted")
    expect(admitSessionActivity(file, { ...input, activityId: "activity-2" }).state).toBe("admitted")
    expect(() => admitSessionActivity(file, { ...input, payloadDigest: digest("changed") })).toThrow(/conflict/i)
    expect(admitSessionActivity(file, input).state).toBe("duplicate")
  })

  it("can admit steering while a full turn owns its lease without changing that owner", async () => {
    const file = session()
    await withSessionTurnLease(file, async lease => {
      expect(admitSessionActivity(file, input).state).toBe("admitted")
      const db = new Database(`${file}.turn.lock`)
      try {
        expect(db.prepare("SELECT owner_token FROM session_turn_lease").get()).toEqual({ owner_token: lease.ownerToken })
      } finally { db.close() }
    })
  })

  it("retains immutable admission through session reset and a fresh module instance", async () => {
    const file = session()
    admitSessionActivity(file, input)
    await withSessionTurnLease(file, async lease => { deleteSessionTransaction(file, lease) })
    expect(fs.existsSync(file)).toBe(false)
    vi.resetModules()
    const fresh = await import("../../mind/session-transaction")
    expect(fresh.admitSessionActivity(file, input).state).toBe("duplicate")
  })

  it.each([
    { ...input, namespace: 1 as never },
    { ...input, namespace: "" },
    { ...input, namespace: "x".repeat(4097) },
    { ...input, activityId: 1 as never },
    { ...input, activityId: "" },
    { ...input, activityId: "x".repeat(1025) },
    { ...input, payloadDigest: 1 as never },
    { ...input, payloadDigest: "not-a-digest" },
  ])("rejects invalid receipt inputs before accepting them", invalid => {
    expect(() => admitSessionActivity(session(), invalid)).toThrow(/invalid/i)
  })

  it("fails closed on corrupt receipt evidence", () => {
    const file = session()
    admitSessionActivity(file, input)
    const db = new Database(`${file}.turn.lock`)
    try { db.prepare("UPDATE session_activity_receipts SET payload_digest = ?").run("corrupt") }
    finally { db.close() }
    expect(() => admitSessionActivity(file, input)).toThrow(/invalid/i)
  })

  it("refuses new admission at capacity without forgetting or replaying an existing receipt", () => {
    const file = session()
    admitSessionActivity(file, input)
    const stat = fs.statSync
    vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) =>
      String(target) === `${file}.turn.lock` ? { size: 64 * 1024 * 1024 } : stat(target)) as typeof fs.statSync)
    expect(admitSessionActivity(file, input).state).toBe("duplicate")
    expect(() => admitSessionActivity(file, { ...input, activityId: "new" })).toThrow(/capacity/i)
  })

  it("does not report admission after a SQLite write-lock failure", () => {
    const file = session()
    admitSessionActivity(file, { ...input, activityId: "seed" })
    const db = new Database(`${file}.turn.lock`)
    db.exec("BEGIN IMMEDIATE")
    try { expect(() => admitSessionActivity(file, input)).toThrow() }
    finally { db.exec("ROLLBACK"); db.close() }
    expect(admitSessionActivity(file, input).state).toBe("admitted")
  })

  it("admits once across concurrent fresh processes", async () => {
    const file = session()
    const script = String.raw`
      const ts = require("typescript");
      require.extensions[".ts"] = (module, filename) => {
        const output = ts.transpileModule(require("fs").readFileSync(filename,"utf8"), {
          compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
        });
        module._compile(output.outputText,filename);
      };
      const {admitSessionActivity}=require(process.argv[1]);
      console.log(JSON.stringify(admitSessionActivity(process.argv[2],JSON.parse(process.argv[3]))));
    `
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script, path.resolve("src/mind/session-transaction.ts"), file, JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe"] })
      let output = "", error = ""
      child.stdout.on("data", chunk => { output += chunk })
      child.stderr.on("data", chunk => { error += chunk })
      child.once("error", reject)
      child.once("close", code => {
        if (code !== 0) reject(new Error(error || output))
        else resolve(JSON.parse(output.trim().split("\n").at(-1)!).state)
      })
    })))
    expect(results.filter(state => state === "admitted")).toHaveLength(1)
    expect(results.filter(state => state === "duplicate")).toHaveLength(3)
  }, 15_000)
})
